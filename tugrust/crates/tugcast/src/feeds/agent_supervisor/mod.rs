//! Agent supervisor module
//!
//! Houses the per-session ledger, SESSION_STATE / SESSION_SIDEBAND broadcast
//! senders, the CODE_INPUT dispatcher, and the state machine that owns the
//! spawn/dispatch/merge lifecycle for Claude Code sessions.
//!
//! # Lock-order invariant
//!
//! The supervisor holds three async mutexes: the outer ledger map, the
//! `client_sessions` map, and per-session `Mutex<LedgerEntry>` entries
//! reached through the outer map. To avoid deadlock, all code in this module
//! acquires locks in the following order and never in reverse:
//!
//! 1. **Ledger outer mutex** (`self.ledger`).
//! 2. **`client_sessions` mutex** (`self.client_sessions`) — may be acquired
//!    while the ledger mutex is held, during an atomic get-or-insert +
//!    affinity update.
//! 3. **Per-session `Mutex<LedgerEntry>`** — acquired only after releasing
//!    the outer locks, never while the outer locks are held.
//!
//! The TOCTOU fix for [R06] depends on this ordering: `do_spawn_session` and
//! `do_close_session` take the ledger mutex + `client_sessions` mutex as a
//! single atomic critical section so a concurrent close/spawn cannot
//! interleave between the ledger mutation and the affinity mutation.
//!
use parking_lot::Mutex as SyncMutex;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast, mpsc, watch};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};
use tugcast_core::protocol::{FeedId, Frame, TugSessionId};

use super::agent_bridge::{
    AuthProbe, ChildSpawner, CrashBudget, DEFAULT_RETRY_DELAY, RelocateOrigin, SessionMode,
    TugcodeSpawner, run_session_bridge,
};
use super::code::{parse_tug_session_id, splice_tug_session_id};
use super::session_metadata::{
    is_activity_delta, is_background_tasks_changed, is_rate_limit_event, is_session_capabilities,
    is_stop_all_work_done, is_system_metadata, is_task_edge, is_task_progress, is_tool_result,
    is_tool_use, is_turn_end, is_wake_started,
};
use super::session_scoped::SessionScopedFeed;
use super::workspace_registry::{WorkspaceError, WorkspaceKey, WorkspaceRegistry};
use crate::background_session::background_card_id;
use tugcast_core::ControlAction;
#[cfg(test)]
use tugcast_core::LagPolicy;

/// Capacity of per-session CODE_INPUT buffering queues.
pub const BOUNDED_QUEUE_CAP: usize = 256;

/// WebSocket connection identifier. Matches the router's existing
/// `client_id_counter` type.
pub type ClientId = u64;

mod bounded_queue;
mod control;
#[cfg(test)]
use control::{BindArcPayload, parse_bind_arc_payload};
#[cfg(test)]
use control::{
    ChangesetCommitPayload, changeset_commit_message, parse_changeset_claim_payload,
    parse_changeset_commit_payload, parse_changeset_delete_documents_payload,
    parse_changeset_discard_payload, parse_changeset_disclaim_payload,
    parse_changeset_draft_request_payload, parse_changeset_join_payload,
    parse_changeset_join_question_answer_payload, parse_changeset_join_resolve_payload,
    parse_changeset_replay_payload, parse_landing_receipt_payload,
};
mod ledger_entry;
mod recorder;
mod spawn;
mod spawn_state;

pub use bounded_queue::*;
pub use ledger_entry::*;
pub use recorder::*;
pub use spawn_state::*;

// ---------------------------------------------------------------------------
// Ledger alias
// ---------------------------------------------------------------------------

/// Shared ledger map. Outer mutex guards membership; per-session mutex guards
/// the entry's mutable fields.
pub type Ledger = Arc<Mutex<HashMap<TugSessionId, Arc<Mutex<LedgerEntry>>>>>;

/// The process's one supervisor ledger, published for readers that are not on
/// the supervisor's own call graph.
///
/// Whether a session is finished ([`LedgerEntry::is_quiet`]) lives only in
/// memory — it is derived from frames as they cross the pipe and is deliberately
/// not persisted, so a reader like the changeset recompute cannot go and look it
/// up in `sessions.db`. Rather than mirror the fact into a second home and let
/// the two drift, the ledger itself is published here and read directly. Set
/// once, at supervisor construction; `None` in tests that never build one, where
/// every session then reads as quiet — the honest answer when there is no
/// supervisor to say otherwise.
static LEDGER_HANDLE: std::sync::OnceLock<Ledger> = std::sync::OnceLock::new();

/// Every session that is **not** finished right now — mid-turn, or holding a
/// background job that has not reported.
///
/// One snapshot per caller, so a recompute asking about many arcs locks the
/// ledger once. Empty when no supervisor is running.
pub async fn busy_session_ids() -> HashSet<String> {
    let Some(ledger) = LEDGER_HANDLE.get() else {
        return HashSet::new();
    };
    // The membership lock is released before any entry lock is taken: an entry
    // is held across `await` points elsewhere, and holding the outer map while
    // waiting on one would serialize the whole supervisor behind it.
    let entries: Vec<(String, Arc<Mutex<LedgerEntry>>)> = {
        let map = ledger.lock().await;
        map.iter()
            .map(|(id, entry)| (id.to_string(), Arc::clone(entry)))
            .collect()
    };
    let mut busy = HashSet::new();
    for (id, entry) in entries {
        let mut entry = entry.lock().await;
        // The read point is the reap point: no timer task, just a reader that
        // consults busyness pruning what has gone stale on its way past. This
        // is one of the two — the arc runner's `session_snapshot` takes the
        // same two calls in the same order for the one entry it reads ([B04]).
        entry.reap_stuck_jobs(std::time::Instant::now());
        // And the turn flag, under the same doctrine ([B02]). Ordered after
        // the jobs so one pass can take a session all the way to quiet.
        entry.reap_stuck_turn(std::time::Instant::now());
        if !entry.is_quiet() {
            busy.insert(id);
        }
    }
    busy
}

/// A session with a live tugcode child and its captured `(pid, start_time)` —
/// the activity sampler's per-session subtree root and reuse-guard baseline
/// ([P08], [P10], [P20]). Produced by [`AgentSupervisor::live_session_processes`].
#[derive(Debug, Clone)]
pub struct LiveSessionProcess {
    pub tug_session_id: TugSessionId,
    pub pid: u32,
    pub start_time: u64,
}

// ---------------------------------------------------------------------------
// AgentSupervisor
// ---------------------------------------------------------------------------

/// Runtime configuration for [`AgentSupervisor`].
///
/// Per-session `project_dir` — the supervisor no longer has a global
/// workspace path ([D12]). Per-session paths come from the CONTROL
/// `spawn_session` payload and live on `LedgerEntry.project_dir`.
///
/// P13 added `max_concurrent_sessions` and `max_spawns_per_minute` as safety
/// caps so a buggy client or a user with many open cards cannot run the host
/// out of subprocess slots. See [`AgentSupervisor::do_spawn_session`] for the
/// enforcement path.
///
/// The two move together. A fresh insert spends both budgets, and after a
/// host restart the in-memory ledger is empty, so every session restored
/// from disk is a fresh insert rather than a reconnect. A per-minute bucket
/// below the concurrent cap would therefore make the cap unreachable from a
/// cold start: the restore pass would fill the bucket and the remaining
/// cards would be refused. Keep `max_spawns_per_minute` above
/// `max_concurrent_sessions`.
#[derive(Debug, Clone)]
pub struct AgentSupervisorConfig {
    /// Absolute path to the tugcode binary (or `.ts` entry for bun fallback).
    /// Only consumed by the default [`TugcodeSpawner`] factory.
    pub tugcode_path: PathBuf,
    /// Hard cap on concurrent `Spawning` + `Live` ledger entries. A
    /// `spawn_session` CONTROL frame that would push the count at or above
    /// this bound is rejected with
    /// `ControlError::CapExceeded { reason: "concurrent_session_cap_exceeded" }`
    /// and a `SESSION_STATE = errored` broadcast. Idle and Errored entries
    /// do NOT consume slots — only sessions with a running or starting
    /// subprocess count.
    ///
    /// The bound is a memory budget. A live session is a `tugcode` process
    /// plus the `claude` it supervises, which together cost roughly 240 MB
    /// of private memory — measured as `phys_footprint`, which excludes the
    /// file-backed pages every `claude` maps from the same binary and shares.
    /// Resident-set figures count those shared pages once per process and so
    /// read about three times higher; sizing against RSS undercounts what the
    /// host can carry.
    pub max_concurrent_sessions: usize,
    /// Leaky-bucket rate limit on fresh spawn-session intents. Trailing 60s
    /// window; the N+1th spawn within the window is rejected with
    /// `ControlError::CapExceeded { reason: "spawn_rate_limited" }`.
    /// Reconnects (spawns for an existing ledger entry) do not consume
    /// budget.
    ///
    /// Held above `max_concurrent_sessions` so a cold-start restore of a
    /// full deck cannot exhaust the bucket before it reaches the cap.
    pub max_spawns_per_minute: usize,
    /// Override for the Claude Code terminal-liveness registry root
    /// (`~/.claude/sessions/` in production). `None` resolves the
    /// default at use time; tests inject a tempdir (or a nonexistent
    /// path) so they never read the developer's real registry.
    pub terminal_registry_root: Option<PathBuf>,
}

impl Default for AgentSupervisorConfig {
    fn default() -> Self {
        Self {
            tugcode_path: PathBuf::new(),
            max_concurrent_sessions: 64,
            max_spawns_per_minute: 96,
            terminal_registry_root: None,
        }
    }
}

/// Factory that yields a fresh [`ChildSpawner`] for each session spawn. The
/// default factory returns [`TugcodeSpawner`]; tests pass a closure returning
/// a mock spawner so they can drive the bridge without a real subprocess.
pub type SpawnerFactory = Arc<dyn Fn() -> Arc<dyn ChildSpawner> + Send + Sync>;

/// Build the default production spawner factory from an
/// [`AgentSupervisorConfig`]. Each call to the factory clones the configured
/// `tugcode_path` into a fresh [`TugcodeSpawner`]. `config.project_dir` is
/// **not** captured — the per-session workspace path is passed to
/// `spawn_child` per call (see [`ChildSpawner::spawn_child`]).
pub fn default_spawner_factory(config: &AgentSupervisorConfig) -> SpawnerFactory {
    let tugcode_path = config.tugcode_path.clone();
    Arc::new(move || Arc::new(TugcodeSpawner::new(tugcode_path.clone())) as Arc<dyn ChildSpawner>)
}

/// Result of dispatching a CONTROL frame's `action` to the supervisor.
///
/// A single value covers the three outcomes the router needs to
/// distinguish:
///
/// * [`ControlOutcome::Handled`] — the action belongs to the supervisor
///   and ran cleanly.
/// * [`ControlOutcome::Error`] — the action belongs to the supervisor
///   but the payload was malformed or rejected; the router maps the
///   variant to a wire-side `detail` string and emits a CONTROL error
///   frame on the in-scope socket.
/// * [`ControlOutcome::PassThrough`] — the action does not belong to
///   the supervisor; the router falls through to its legacy
///   `dispatch_action` pipeline (relaunch, dev-mode toggles, etc.).
///
/// Returning the outcome from [`AgentSupervisor::handle_control`] makes
/// the match arms inside `handle_control` the single source of truth
/// for "which CONTROL actions the supervisor owns." The router does not
/// keep a separate allowlist that has to be maintained alongside the
/// dispatch table — drift between the two surfaces is impossible by
/// construction. A new arm in `handle_control` is automatically
/// reachable from the websocket; an action with no arm naturally falls
/// to `PassThrough` via the catch-all.
#[derive(Debug)]
pub enum ControlOutcome {
    /// Action handled successfully.
    Handled,
    /// Action handled, with the reply body it broadcast on CONTROL. The
    /// WebSocket ingress treats this exactly like `Handled` (its clients
    /// already received the broadcast); the `/api/tell` bridge returns the
    /// body to the HTTP caller — which is what lets `tugtool claim` report
    /// what actually happened instead of inferring success from a bare 200.
    HandledWith(serde_json::Value),
    /// Action belongs to the supervisor but failed validation or
    /// payload parsing. The router emits a CONTROL error frame.
    Error(ControlError),
    /// Action does not belong to the supervisor. The router falls
    /// through to `dispatch_action`.
    PassThrough,
}

#[cfg(test)]
impl ControlOutcome {
    /// Test-only: panic unless the outcome is `Handled`. Mirrors the
    /// `Result::unwrap` ergonomics tests had before `handle_control`'s
    /// signature changed.
    pub(crate) fn expect_handled(self) {
        match self {
            ControlOutcome::Handled | ControlOutcome::HandledWith(_) => {}
            other => panic!("expected ControlOutcome::Handled, got {other:?}"),
        }
    }

    /// Test-only: panic with `msg` unless the outcome is `Handled`.
    /// Mirrors `Result::expect`. Used where a test wants to attach
    /// context to the failure ("first spawn admitted", etc.).
    pub(crate) fn expect_handled_with(self, msg: &str) {
        match self {
            ControlOutcome::Handled | ControlOutcome::HandledWith(_) => {}
            other => panic!("{msg}: expected ControlOutcome::Handled, got {other:?}"),
        }
    }

    /// Test-only: extract the `ControlError` from an `Error` outcome.
    /// Panics on any other variant.
    pub(crate) fn expect_error(self) -> ControlError {
        match self {
            ControlOutcome::Error(e) => e,
            other => panic!("expected ControlOutcome::Error, got {other:?}"),
        }
    }

    pub(crate) fn is_handled(&self) -> bool {
        matches!(
            self,
            ControlOutcome::Handled | ControlOutcome::HandledWith(_)
        )
    }
}

/// Errors returned from [`AgentSupervisor::handle_control`]. Consumed by
/// `handle_client` (wired in Step 8) to emit a CONTROL error frame on the
/// in-scope socket.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("control payload missing card_id")]
    MissingCardId,
    #[error("control payload missing tug_session_id")]
    MissingSessionId,
    #[error("control payload is not valid JSON")]
    Malformed,
    /// The payload's `project_dir` field is missing or fails validation.
    /// `reason` is a compile-time string from the set defined in
    /// `"missing_project_dir"`, `"does_not_exist"`, `"permission_denied"`,
    /// `"not_a_directory"`, `"metadata_error"`.
    #[error("invalid project_dir: {reason}")]
    InvalidProjectDir { reason: &'static str },
    /// P13 spawn-budget rejection. `reason` is one of:
    /// `"concurrent_session_cap_exceeded"` (hit
    /// `AgentSupervisorConfig::max_concurrent_sessions`) or
    /// `"spawn_rate_limited"` (hit `max_spawns_per_minute`). Router maps
    /// both to a CONTROL error frame on the in-scope socket; the
    /// supervisor also broadcasts `SESSION_STATE = errored` with the same
    /// `detail` so any other observer of the session sees the failure.
    #[error("spawn budget exceeded: {reason}")]
    CapExceeded { reason: &'static str },
    /// A `mode=new` spawn carried no `line_id` ([P03]). A line is born in
    /// exactly one place and the deck mints its id from the drop, so a fresh
    /// spawn that names none is refused rather than served under a line the
    /// server invented — which the deck's per-line tugbank keys would then
    /// point past, silently.
    #[error("spawn_session is missing line_id")]
    MissingLineId,
}

/// Central owner of all Claude Code sessions for a single tugcast process.
pub struct AgentSupervisor {
    /// Per-session ledger (see [`LedgerEntry`]).
    pub ledger: Ledger,
    /// The SESSION_STATE feed — a session-scoped publishing surface
    /// (splice discipline + lag policy live on the handle).
    pub session_state: SessionScopedFeed,
    /// The SESSION_SIDEBAND feed. Broadcast — not watch — per [D14] so
    /// concurrent per-session metadata updates cannot clobber one another.
    pub session_sideband: SessionScopedFeed,
    /// Per-client session affinity, used by the P5 authorization cross-check.
    pub client_sessions: Arc<Mutex<HashMap<ClientId, HashSet<TugSessionId>>>>,
    /// The shared supervisor-wide CODE_OUTPUT feed. Publishing through
    /// the handle keeps the lag-recovery replay buffer fed ([D06]: the
    /// buffer is cross-session; the deck filter provides isolation [D11]).
    pub code_output: SessionScopedFeed,
    /// The ACTIVITY feed ([P14], `FeedId::ACTIVITY`). The merger diverts
    /// tugcode's `activity_delta` frames onto it (re-tagged, splice
    /// preserved) so a per-session activity sample stream reaches the deck
    /// without riding the high-churn CODE_OUTPUT transcript. Broadcast with
    /// `LagPolicy::Warn` ([P17]): a dropped sample bin is a negligible gap.
    pub activity: SessionScopedFeed,
    /// Outbound CONTROL broadcast sender — used for `session_unknown`,
    /// `session_backpressure`, and other supervisor-emitted error frames.
    pub control_tx: broadcast::Sender<Frame>,
    /// Writer for the per-session ledger. The bridge calls `record` on
    /// `session_init`, `record_turn` on each tugcode `result` event, and
    /// `mark_failed` on `resume_failed` / crash exhaustion. The supervisor
    /// calls `mark_closed` on `do_close_session`. The Trash UX (step 6)
    /// uses `remove`. The live-elsewhere check during spawn reads the
    /// in-memory `LedgerEntry::card_id` and gates on `spawn_state`; the
    /// ledger row's `card_id` mirrors the in-memory value so the
    /// client-side restore can reconstruct the binding after a tugcast
    /// restart.
    pub sessions_recorder: Arc<dyn SessionsRecorder>,
    /// Read handle to the same [`SessionLedger`] the recorder writes to.
    /// Used for the read-side CONTROL ops (`list_sessions`, the picker's
    /// query path) and the batch Trash paths. Named `session_ledger` to
    /// avoid colliding with the in-memory `ledger` field above. Optional
    /// so unit tests that pass a `NoopSessionsRecorder` aren't forced to
    /// wire a ledger they won't read from. `None` makes the new ledger
    /// CONTROL ops short-circuit with an empty / no-op response.
    pub session_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    /// The shell-exchange ledger, read by the `list_shell_exchanges` CONTROL op
    /// (the shell service writes it; the supervisor reads it). `None` in tests
    /// that don't exercise the shell restore path — the read yields an empty
    /// array. Set via [`AgentSupervisor::set_shell_ledger`] in `main.rs`.
    pub shell_ledger: Option<Arc<crate::shell_ledger::ShellLedger>>,
    /// The refs ledger, read by the `list_refs` CONTROL op (the refs
    /// dispatcher writes it; the supervisor reads it). `None` in tests that
    /// don't exercise refs restore — the read yields a null run. Set via
    /// [`AgentSupervisor::set_refs_ledger`] in `main.rs`.
    pub refs_ledger: Option<Arc<crate::refs_ledger::RefsLedger>>,
    /// The prompt-history ledger, written by a directory change: the moved
    /// session's `session_lineage` is recorded before the move is
    /// acknowledged, so the card's first history read under the new id
    /// already reaches the prompts typed before the move. `None` in tests
    /// that don't exercise it, and when the ledger failed to open — the move
    /// still happens, and recall falls back to the fork edge tugcode writes
    /// later. Set via [`AgentSupervisor::set_prompt_ledger`] in `main.rs`.
    pub prompt_ledger: Option<Arc<crate::prompt_ledger::PromptLedger>>,
    /// The one digester, read by the `list_digest_lines` CONTROL op — the
    /// deck's mount-time tail. Shared with the digest bridge, which is its
    /// only writer. `None` in tests that don't exercise the read (and before
    /// `main.rs` wires it), which answers with an empty array — the "no
    /// history yet" state, same conduct as the other restore reads. Set via
    /// [`AgentSupervisor::set_digester`] in `main.rs`.
    pub digester: Option<crate::feeds::session_digest::SharedDigester>,
    /// The changeset scribe ([P11]/[P21]) — spawner + model resolver behind the
    /// maintained-draft engine. `None` (tests, or a boot without wiring) makes
    /// [`AgentSupervisor::start_draft_engine`] a no-op. Set via
    /// [`AgentSupervisor::set_scribe`] in `main.rs`.
    pub scribe: Option<ScribeContext>,
    /// Per-spawn factory for the backing subprocess. Swapped for a mock in
    /// tests so unit tests do not need a real tugcode binary.
    pub spawner_factory: SpawnerFactory,
    /// Register side of the merger task's per-session stream map. Each
    /// `spawn_session_worker` call pushes a `(tug_session_id, output_rx)`
    /// pair through here; `merger_task` inserts it into its internal
    /// `StreamMap` and fans the frames into the shared CODE_OUTPUT
    /// broadcast + SESSION_SIDEBAND broadcast.
    pub merger_register_tx: mpsc::Sender<MergerRegistration>,
    /// Runtime configuration.
    pub config: AgentSupervisorConfig,
    /// Per-workspace feed registry. `do_spawn_session` calls
    /// `registry.get_or_create`; `do_close_session` calls
    /// `registry.release`. Shared across the whole tugcast process.
    pub registry: Arc<WorkspaceRegistry>,
    /// Process-wide cancel token, cloned into `registry.get_or_create`
    /// calls so each new workspace entry derives a child cancel from
    /// the shared root. Firing this (e.g. on process shutdown) tears
    /// down every workspace's tasks.
    pub cancel: CancellationToken,
    /// P13 leaky-bucket state. Holds the timestamps of every successful
    /// fresh spawn intent within the trailing 60s window, in insertion
    /// order. Trimmed + checked + pushed inside `do_spawn_session`'s
    /// Phase 1 critical section so the rate-limit decision is atomic with
    /// the ledger insert. `parking_lot::Mutex` (not tokio's async mutex)
    /// because the critical section is bounded, non-awaiting, and never
    /// crosses an `.await` point.
    pub spawn_timestamps: Arc<SyncMutex<VecDeque<Instant>>>,
    /// Latest CHANGESET_ALL aggregate watch receiver, stored at boot by
    /// [`AgentSupervisor::start_draft_engine`]. `do_changeset_draft_request`
    /// borrows its current frame to resolve an on-demand draft against the
    /// latest snapshot ([P03]). `None` (its unset state) when the draft path
    /// isn't wired (tests, or a boot without the aggregate feed).
    pub changeset_watch: std::sync::OnceLock<watch::Receiver<Frame>>,
    /// In-flight Auto-Message generation tasks, keyed by entry identity. A
    /// `changeset_draft_cancel` (or a superseding request) aborts the live
    /// handle; aborting kills only that draft's headless scribe child, never
    /// the interactive session's turn ([P06]).
    pub draft_tasks: crate::feeds::draft_engine::DraftTaskRegistry,
    /// Optional "this session's turn just ended" signal, carrying the session
    /// id. The base-motion engine listens here: its gate refuses to move a
    /// branch under a session that is mid-turn, and "the base moved during a
    /// turn" is the common shape of the problem — so a turn ending is the wake
    /// that lets a parked arc catch up seconds later rather than at the next
    /// unrelated commit. Unset in tests and in any boot without the engine,
    /// where the send is simply skipped.
    pub turn_complete_tx: std::sync::OnceLock<mpsc::Sender<String>>,
    /// The same idle transition, for the arc runner ([P05]).
    ///
    /// A sibling channel rather than a second receiver on `turn_complete_tx`:
    /// an mpsc has one consumer, and the two engines want the same edge for
    /// unrelated reasons — base-motion to catch a parked arc up, the arc to
    /// rotate its next stage. Both are fed from the one place the supervisor
    /// recognizes the transition, so neither re-derives it.
    pub arc_tick_tx: std::sync::OnceLock<mpsc::Sender<String>>,
    /// The same idle transition again, for the wheel ([P04]).
    ///
    /// A third sibling for the reason there is a second: an mpsc has one
    /// consumer, and a rotation asked for mid-turn must land at *that* turn's
    /// end — the edge computed here and nowhere else.
    pub wheel_tick_tx: std::sync::OnceLock<mpsc::Sender<String>>,
    /// The wheel itself, for the stoppers that live here rather than in the
    /// arc engine ([P03]).
    ///
    /// `stop_arc_for_session` takes the wheel state — a stop either sends the
    /// hand-back or arms it, and both are the wheel's registries — so a
    /// supervisor method that performs a stop needs the state and not just
    /// the tick channel. Set in `main.rs` where `wheel_state` is built;
    /// unset is the one way [`AgentSupervisor::stop_arc_now`] can decline,
    /// and it says so rather than reporting a stop that did not happen.
    pub wheel: std::sync::OnceLock<Arc<crate::wheel::WheelState>>,
}

/// Registration sent through [`AgentSupervisor::merger_register_tx`] so the
/// merger task learns about a newly-spawned session worker's output stream.
pub type MergerRegistration = (TugSessionId, mpsc::Receiver<Frame>);

/// Wire shape of the `terminal_live` annotation on a listed session:
/// present iff a live process outside this supervisor (typically the
/// Claude Code terminal app) currently holds the session, carrying its
/// busy/idle status.
#[derive(Debug, serde::Serialize)]
pub struct TerminalLiveWire {
    pub status: &'static str,
}

/// One row of `list_sessions_ok` — the persisted/synthesized
/// `SessionRow` fields plus provenance (`origin`) and the
/// terminal-liveness annotation. `origin: "tug"` rows come from the
/// sqlite ledger; `origin: "external"` rows were discovered on disk
/// (sessions Tug never spawned, typically terminal-created) and have
/// their `SessionRow` fields synthesized: `state: "closed"`,
/// `card_id: null`, `workspace_key` set to the encoded claude project
/// directory name (no canonical workspace was ever registered for
/// them).
#[derive(Debug, serde::Serialize)]
pub struct ListedSession {
    #[serde(flatten)]
    pub row: crate::session_ledger::SessionRow,
    pub origin: &'static str,
    pub terminal_live: Option<TerminalLiveWire>,
    /// On-disk JSONL size in bytes, from the external scan. `None` when the
    /// session has not been scanned (e.g. a live ledger row in the phase-1
    /// preview, before the scan settles). The picker renders this instead of
    /// a turn count — an orthogonal "how big" signal, not a message proxy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<i64>,
}

/// Build the picker's `list_sessions` row union from a ledger snapshot, a
/// terminal-liveness map, and (optionally) an external-session scan.
///
/// Ledger rows are tagged `origin: "tug"`; external scan rows not already
/// owned by the ledger are tagged `origin: "external"` with their
/// `SessionRow` fields synthesized (`state: closed`, `card_id: null`,
/// `workspace_key`/`project_dir` set to the scan's canonical dir — the form
/// claude's directory name encodes, so trash re-derives the JSONL path).
/// Every row is annotated with `terminal_live` from `live`, and the result
/// is sorted newest-first by `last_used_at`.
///
/// `scan: None` yields the ledger-only preview (phase 1); `Some` yields the
/// settled union (phase 2). Both phases route through this one builder so
/// their annotation, dedupe, and ordering can never drift.
///
/// Content-empty rows ([`is_empty_session`]) are dropped from both phases —
/// they never reach the wire.
///
/// Segments of one line do not list on their own: the picker offers **lines
/// of work**, and every id a card has lived through is one line. See
/// [`fold_lines`].
fn build_listed_union(
    rows: Vec<crate::session_ledger::SessionRow>,
    live: &HashMap<String, crate::terminal_registry::TerminalLiveEntry>,
    scan: Option<crate::external_sessions::ScanOutcome>,
) -> Vec<ListedSession> {
    let annotate = |session_id: &str| {
        live.get(session_id).map(|e| TerminalLiveWire {
            status: e.status.as_wire_str(),
        })
    };
    let mut listed: Vec<ListedSession> = Vec::with_capacity(rows.len());
    for row in rows {
        let terminal_live = annotate(&row.session_id);
        listed.push(ListedSession {
            row,
            origin: "tug",
            terminal_live,
            // Backfilled below from the scan meta when this session is on
            // disk; stays None for live-only ledger rows.
            file_size: None,
        });
    }
    if let Some(scan) = scan {
        // Index the scan metas so ledger rows can absorb fresher on-disk
        // content; whatever remains un-absorbed becomes a synthesized
        // external row.
        let mut metas_by_id: HashMap<String, crate::external_sessions::ExternalSessionMeta> = scan
            .metas
            .into_iter()
            .map(|m| (m.session_id.clone(), m))
            .collect();
        for entry in &mut listed {
            let Some(meta) = metas_by_id.remove(&entry.row.session_id) else {
                continue;
            };
            // Surface the on-disk size for the picker's size readout.
            entry.file_size = Some(meta.file_size);
            // The ledger row owns identity and lifecycle (state, card
            // binding, user-assigned name); the transcript on disk owns
            // content. When the JSONL is newer than the ledger's last
            // write — a session continued in the terminal, or a ledger
            // row that predates the transcript's tail — surface the
            // scan's content fields. Holes (zero turns, missing
            // prompt/name) backfill from the scan regardless of
            // recency: a sparser row never beats a richer one.
            let disk_fresher = meta.file_mtime > entry.row.last_used_at;
            if disk_fresher {
                entry.row.last_used_at = meta.last_used_at;
            }
            if (disk_fresher && meta.last_user_prompt.is_some())
                || entry.row.last_user_prompt.is_none()
            {
                entry.row.last_user_prompt = meta.last_user_prompt;
            }
            entry.row.turn_count = entry.row.turn_count.max(meta.turn_count);
            // A user-set name on the line outranks everything: it is the
            // user's own word, and the scan's `name` is an `aiTitle`. The
            // ledger row usually carries it already (the listing joins
            // `lines`), so this matters for the row the scan owns — but
            // preferring it here too means the two paths cannot disagree.
            if meta.line_name_user_set && meta.line_name.is_some() {
                entry.row.name = meta.line_name;
                entry.row.name_user_set = true;
            } else if entry.row.name.is_none() {
                entry.row.name = meta.name;
            }
            // A ledger row whose line has no callsign yet shows the one the
            // scan minted for it.
            if entry.row.tag.is_none() {
                entry.row.tag = meta.tag;
            }
        }
        let synthetic_workspace_key =
            tugcore::claude_home::encode_project_dir(&scan.canonical_project_dir);
        for (_, meta) in metas_by_id {
            let terminal_live = annotate(&meta.session_id);
            let file_size = Some(meta.file_size);
            listed.push(ListedSession {
                row: crate::session_ledger::SessionRow {
                    session_id: meta.session_id,
                    workspace_key: synthetic_workspace_key.clone(),
                    project_dir: scan.canonical_project_dir.clone(),
                    created_at: meta.created_at,
                    last_used_at: meta.last_used_at,
                    turn_count: meta.turn_count,
                    last_user_prompt: meta.last_user_prompt,
                    state: crate::session_ledger::SessionState::Closed,
                    card_id: None,
                    // The **line's** name when the user typed one, else the
                    // transcript's `aiTitle`. A scanned `aiTitle` is never a
                    // user rename, but the line this session belongs to may
                    // carry one — and it does exactly when the `sessions` row
                    // is gone and the name outlived it. Reading only the
                    // `aiTitle` here is what made such a session list under a
                    // machine's guess instead of the user's own word.
                    name: if meta.line_name_user_set && meta.line_name.is_some() {
                        meta.line_name
                    } else {
                        meta.name
                    },
                    name_user_set: meta.line_name_user_set,
                    // The callsign of the line the scan birthed for this
                    // session ([P07]) — the picker sees a real tag before the
                    // session is ever adopted, and adoption seats that same
                    // line on the card rather than minting a second identity.
                    tag: meta.tag,
                    // A scanned session is a root until it is forked from.
                    // The description is ledger state; a session with no
                    // `sessions` row has none until it is adopted.
                    synopsis: None,
                    // So is the privacy flag, and an absent row reads as
                    // public everywhere the flag is enforced.
                    private: false,
                    // A scanned session has no ledger row, so nothing has
                    // ever bound it to an arc.
                    arc_id: None,
                    arc_name: None,
                    // The card-less line the scan birthed, so a fold groups a
                    // scanned session's segments exactly as it groups a
                    // ledger row's.
                    line_id: meta.line_id.unwrap_or_default(),
                    // Nor a background owner: `card_id` is `None` above, and
                    // a scanned session has no `sessions` row to carry a card
                    // at all.
                    background: false,
                },
                origin: "external",
                terminal_live,
                file_size,
            });
        }
    }
    listed.retain(|entry| !is_empty_session(&entry.row));
    let mut listed = fold_lines(listed);
    listed.sort_by(|a, b| b.row.last_used_at.cmp(&a.row.last_used_at));
    listed
}

/// Collapse each line of work into one row.
///
/// A card accumulates a session id per rotation, per rewind-fork, per
/// respawn, and the user has one conversation. They are all segments of one
/// line ([P01]), so the picker groups by `line_id`:
///
/// - The **row offered** is the line's newest *live* segment, else its newest
///   segment. That is the resume target that keeps the whole scroll: a card
///   replays parent-ward from the session it is seated on, so seating the
///   line's tip replays every stage and the conversation they grew from,
///   while seating the root would show the history and drop the arc.
/// - The **identity shown** needs no choosing: every member already carries
///   the line's callsign and name, because that is what the join reads.
/// - **Size and turns sum** across the line, because that is what the line
///   holds; the segment's own numbers would understate a card the user has
///   been working in all afternoon.
///
/// A row with no line — a synthesized shape no ledger wrote — is its own
/// group of one and passes through untouched.
fn fold_lines(listed: Vec<ListedSession>) -> Vec<ListedSession> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<ListedSession>> = HashMap::new();
    for entry in listed {
        let key = if entry.row.line_id.is_empty() {
            entry.row.session_id.clone()
        } else {
            entry.row.line_id.clone()
        };
        groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Vec::new()
        });
        groups
            .get_mut(&key)
            .expect("group just inserted")
            .push(entry);
    }
    let mut folded = Vec::with_capacity(order.len());
    for key in order {
        let mut members = groups.remove(&key).expect("every ordered key has a group");
        if members.len() == 1 {
            folded.push(members.pop().expect("one member"));
            continue;
        }
        let turn_count: i64 = members.iter().map(|m| m.row.turn_count).sum();
        let file_size: Option<i64> = members
            .iter()
            .filter_map(|m| m.file_size)
            .reduce(|a, b| a + b);
        // Newest live segment, else newest segment.
        members.sort_by(|a, b| {
            let live = |m: &ListedSession| m.row.state == crate::session_ledger::SessionState::Live;
            live(b)
                .cmp(&live(a))
                .then(b.row.last_used_at.cmp(&a.row.last_used_at))
        });
        let mut base = members.swap_remove(0);
        base.row.turn_count = turn_count;
        base.file_size = file_size;
        folded.push(base);
    }
    folded
}

/// A session that holds nothing: no turns, no recorded user prompt, and no
/// title (neither a user rename nor a scanned `aiTitle`). Claude writes a
/// JSONL for every launch, so a session abandoned before its first prompt
/// leaves a transcript with nothing to resume into. The picker rendered these
/// as "No prompts yet" rows; they are dropped from `list_sessions` instead.
fn is_empty_session(row: &crate::session_ledger::SessionRow) -> bool {
    let blank = |s: &Option<String>| s.as_deref().unwrap_or("").trim().is_empty();
    row.turn_count == 0 && blank(&row.last_user_prompt) && blank(&row.name)
}

/// The session mode to stamp on an `Idle` rebound entry when a client spawn
/// request's mode differs from the entry's current mode.
///
/// Normally the request wins — a rebound-but-not-yet-spawned entry adopts the
/// request's intent (a card can legitimately open fresh in place). The one
/// exception: never downgrade to `New` while the entry still has a transcript
/// worth protecting — a persisted `claude_session_id` whose session is not
/// content-empty. A `new`-mode spawn reuses the id via `--session-id`, which
/// collides with the existing on-disk transcript ("Session ID … is already in
/// use") and crash-loops the card to `errored`. The client only requests `New`
/// for such an entry by mis-classifying a session that has a JSONL as
/// turn-count-zero on restore; hold the ledger-derived mode instead. A genuine
/// discard clears `claude_session_id` first (`do_reset`), so this guard never
/// blocks a real fresh-in-place spawn.
fn reconcile_idle_session_mode(
    current: SessionMode,
    requested: SessionMode,
    has_resumable_transcript: bool,
) -> SessionMode {
    if requested == SessionMode::New && has_resumable_transcript {
        current
    } else {
        requested
    }
}

/// Owned form of a parsed CONTROL payload.
struct OwnedControlPayload {
    card_id: String,
    tug_session_id: TugSessionId,
    /// per-session workspace path. `None` for close/reset
    /// payloads (which don't need it); `Some` for spawn payloads and
    /// rejected with `InvalidProjectDir { reason: "missing_project_dir" }`
    /// if absent on the spawn path.
    project_dir: Option<String>,
    /// New-vs-resume choice. Absent values default to
    /// `SessionMode::New` so pre-4.5 payloads keep the step-4k behavior.
    session_mode: SessionMode,
    /// Deck-wide / per-card default permission mode tugdeck resolved at spawn
    /// time, forwarded to tugcode as `--permission-mode`. `None` when the
    /// payload omits it (older client, or a card with no configured default) —
    /// the string is passed through opaquely; tugcode validates it.
    permission_mode: Option<String>,
    /// Provisional mnemonic tag tugdeck minted for a fresh spawn. `None` on
    /// close/reset payloads and on older clients. Stored on the `LedgerEntry`
    /// and claimed authoritatively by `record_spawn`; never forwarded to the
    /// child ([P07]).
    tag: Option<String>,
    /// The line of work a `mode=new` spawn is birthing, minted by the deck
    /// from the drop beside the tag ([P03]). Required on `mode=new`; on a
    /// resume it is the binding's, and absent it is read off the row being
    /// resumed.
    line_id: Option<String>,
    /// The tug session a directory change moves the card away from ([P07]).
    /// Sent with a `mode=new` spawn; tugcast resolves it to the parent's
    /// claude id and directory. `None` on every other payload.
    relocate_from: Option<String>,
}

fn parse_control_payload_owned(payload: &[u8]) -> Result<OwnedControlPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let card_id = value
        .get("card_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingCardId)?
        .to_string();
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let session_mode =
        SessionMode::from_wire_str(value.get("session_mode").and_then(|v| v.as_str()));
    let permission_mode = value
        .get("permission_mode")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let tag = value
        .get("tag")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let line_id = value
        .get("line_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let relocate_from = value
        .get("relocate_from")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(OwnedControlPayload {
        card_id,
        tug_session_id: TugSessionId::new(tug_session_id),
        project_dir,
        session_mode,
        permission_mode,
        tag,
        line_id,
        relocate_from,
    })
}

/// Parse a CONTROL payload that carries `{ project_dir: "..." }`. The
/// picker's `list_sessions` request uses this so the lookup matches the
/// raw user-typed path (the value originally recorded by `record_spawn`).
/// `MissingSessionId`-shaped error semantics: a missing identifier the
/// lookup needs.
fn parse_project_dir_payload(payload: &[u8]) -> Result<String, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let pd = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    Ok(pd)
}

/// The ids a `resolve_sessions` request asks about ([D132]).
///
/// Capped rather than unbounded: the caller is a History card asking about the
/// commits on screen, and a request naming ten thousand ids is a bug on the
/// other side of the wire, not a query. Over the cap the extra ids are dropped
/// with a warning rather than the whole request refused — a truncated answer
/// renders as a few unresolved chips, where a refusal renders as none at all.
/// The half of a session reference the ledger can answer about — a
/// `<project>/<callsign>` spelling without its project half, and anything
/// else unchanged. Split at the **last** `/`, because the project half may
/// be a whole path.
fn session_ref_callsign_half(reference: &str) -> &str {
    match reference.rsplit_once('/') {
        Some((head, tail)) if !head.is_empty() && !tail.is_empty() => tail,
        _ => reference,
    }
}

/// Whether a reference's project half — if it carried one — names the same
/// project as `project_dir`, compared by basename. A reference with no
/// project half agrees with everything, which is the old behavior.
fn session_ref_project_agrees(reference: &str, project_dir: &str) -> bool {
    match reference.rsplit_once('/') {
        Some((head, tail)) if !head.is_empty() && !tail.is_empty() => {
            tugcore::session_index::project_leaf_of(head)
                == tugcore::session_index::project_leaf_of(project_dir)
        }
        _ => true,
    }
}

/// The changeset scribe's runtime wiring ([P11]): the spawner (production:
/// `ClaudeScribeSpawner`; tests: a fake) plus the model resolver (tugbank
/// default `dev.tugapp.changeset`/`scribe_model`, fallback `sonnet` —
/// resolved per request so a settings change applies immediately).
#[derive(Clone)]
pub struct ScribeContext {
    pub spawner: Arc<dyn crate::scribe::ScribeSpawner>,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
}

fn parse_session_id_payload(payload: &[u8]) -> Result<String, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    // Reuse the `MissingSessionId` variant — semantically the same shape:
    // a CONTROL action that needs an id and didn't get one.
    let id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    Ok(id)
}

/// The terms of a stop the blocking half already decided on — everything
/// [`AgentSupervisor::stop_arc_now`] needs beyond *which arc, on which card*.
///
/// One struct rather than four more positional arguments, because the caller
/// already holds them as a group: they are the fields of the
/// `ArcApiOutcome::ArcStopped` the blocking half returned, and a bare `bool`
/// at the end of a long positional list is exactly the argument a reader has
/// to count their way to.
pub(crate) struct StopTerms<'a> {
    /// The stage the arc is stopped *in*.
    pub stage: tugarc_core::ArcStage,
    /// Why, in the closed stop vocabulary.
    pub reason: tugarc_core::arc::ArcStopReason,
    /// The question an `arc_ask` stopped over, written as an `arc-note` before
    /// the stop so the receipt the stop composes can speak it.
    pub question: Option<&'a str>,
    /// Whether a running turn on the bound session is interrupted first. True
    /// for a user's Stop ([B06]), false for a stage's own `arc ask` ([P03]).
    pub halt: bool,
}

/// Build a CODE_INPUT frame from a payload the caller composed.
pub(crate) fn code_input_frame(payload: &serde_json::Value) -> Frame {
    Frame::new(
        FeedId::CODE_INPUT,
        serde_json::to_vec(payload).expect("stage frame payload serializes"),
    )
}

/// The resident context window a `cost_update` reports, in tokens ([P07]).
///
/// `usage` on a `cost_update` is the turn's **last** tool-loop iteration, and
/// tugcode's wire docs state plainly that `input + cache_read +
/// cache_creation + output` on that iteration is the resident window after the
/// turn. `result.usage` would be the sum across every API call of the turn,
/// which over-counts by roughly the number of tool calls — so this reads the
/// frame's own `usage` and never a total.
/// A `turn_complete` whose result was an API error — tugcode marks the frame
/// when claude's result text began `API Error:`.
pub(crate) fn turn_ended_in_api_error(payload: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    value.get("type").and_then(|t| t.as_str()) == Some("turn_complete")
        && value.get("is_api_error").and_then(|v| v.as_bool()) == Some(true)
}

/// A `turn_cancelled` the **user** caused — tugcode leaves the frame unmarked
/// for their cancel and sets `is_recovery` when it force-terminated a wedged
/// claude to recover it. A frame from a build before that marker existed
/// carries no field and reads as a user cancel, which is what it was.
pub(crate) fn turn_ended_in_user_cancel(payload: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    value.get("type").and_then(|t| t.as_str()) == Some("turn_cancelled")
        && value.get("is_recovery").and_then(|v| v.as_bool()) != Some(true)
}

/// One entry in [`LedgerEntry::open_jobs`]: when the job began, and what kind
/// of thing it is.
///
/// The kind is recorded at the **launch** and never re-derived ([P03]). It has
/// to be: the `task_started` that confirms a job names a `task_type`, but the
/// launch that opened the provisional entry is the only frame that names the
/// *tool*, and the wait sentence the user reads — `1 background job open
/// (bash, 23 min)` — is about the tool they typed rather than about claude's
/// internal classification. A provisional entry that had no kind until its
/// confirmation would read as unnamed for exactly the window the latch exists
/// to cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenJob {
    /// The liveness stamp: set at the open, carried across the `task_started`
    /// re-key, refreshed by `task_progress`, and read by
    /// [`LedgerEntry::reap_stuck_jobs`].
    pub since: std::time::Instant,
    pub kind: JobKind,
}

/// What kind of background work an open job is, as its launching `tool_use`
/// named it.
///
/// `Other` carries the tool's own name rather than collapsing to "unknown": a
/// wait sentence naming a tool nothing here anticipated is still a sentence the
/// user can act on, and a new backgroundable tool must not need a change here
/// to be legible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobKind {
    Bash,
    Agent,
    Monitor,
    Other(String),
}

impl JobKind {
    /// The tool name as the launch spelled it, lowercased for the sentence.
    pub fn as_str(&self) -> &str {
        match self {
            JobKind::Bash => "bash",
            JobKind::Agent => "agent",
            JobKind::Monitor => "monitor",
            JobKind::Other(name) => name,
        }
    }
}

impl From<&str> for JobKind {
    fn from(tool_name: &str) -> Self {
        match tool_name {
            "Bash" => JobKind::Bash,
            "Agent" => JobKind::Agent,
            "Monitor" => JobKind::Monitor,
            other => JobKind::Other(other.to_ascii_lowercase()),
        }
    }
}

/// One entry in [`LedgerEntry::open_runs`]: a live Bash call a progress report
/// can attach to.
///
/// It opens at a live (never replayed) Bash `tool_use`. A foreground run
/// closes at its `tool_result`, and every foreground run left is dropped at
/// the turn's end. A background run outlives its `tool_result`, because its
/// command keeps going after the call has answered: it stays a candidate for
/// as long as its job is open in [`LedgerEntry::open_jobs`] — under
/// `launch:<tool_use_id>` and then under the `task_id` it was re-keyed to —
/// and leaves the map the first time a match finds the job gone. The relay's
/// teardown clears the map with the jobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRun {
    /// The command as the call spelled it — what a report's needles match.
    pub command: String,
    /// When the call opened, in epoch ms; the eviction order past the cap.
    pub opened_at_ms: i64,
    pub background: bool,
    /// The job's `task_id`, once its `task_started` confirmed it.
    pub task_id: Option<String>,
}

/// The most open runs one session keeps; the oldest goes first.
pub const OPEN_RUNS_CAP: usize = 64;

/// A progress report a running command posted about itself, as the
/// `/api/session` `run_progress` op received it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunProgressReport {
    /// The call the reporter says it is running under, when it knows.
    pub tool_use_id: Option<String>,
    pub label: Option<String>,
    pub text: String,
    pub done: Option<u64>,
    pub total: Option<u64>,
    pub failures: Option<u64>,
    /// Substrings of the command the reporter expects to be running under.
    pub needles: Vec<String>,
}

/// A live Bash `tool_use`'s `(tool_use_id, OpenRun)`, or `None` for any other
/// frame.
fn parse_bash_run(payload: &[u8], now_ms: i64) -> Option<(String, OpenRun)> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    if value.get("type")?.as_str()? != "tool_use" || value.get("tool_name")?.as_str()? != "Bash" {
        return None;
    }
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    if tool_use_id.is_empty() {
        return None;
    }
    let input = value.get("input");
    let command = input
        .and_then(|i| i.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let background = input
        .and_then(|i| i.get("run_in_background"))
        .and_then(|b| b.as_bool())
        == Some(true);
    Some((
        tool_use_id.to_owned(),
        OpenRun {
            command: command.to_owned(),
            opened_at_ms: now_ms,
            background,
            task_id: None,
        },
    ))
}

/// The `tool_use_id` a `tool_result` answers, errored or not.
fn parse_tool_result_id(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    if value.get("type")?.as_str()? != "tool_result" {
        return None;
    }
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    (!tool_use_id.is_empty()).then(|| tool_use_id.to_owned())
}

/// The Spec S03 `run_progress` CODE_OUTPUT payload for `live`, with
/// `tug_session_id` spliced in as its first key and absent numbers omitted.
fn run_progress_payload(
    live: &str,
    attached: Option<&str>,
    report: &RunProgressReport,
    at_ms: i64,
) -> Vec<u8> {
    let mut body = serde_json::Map::new();
    body.insert("type".into(), "run_progress".into());
    body.insert(
        "tool_use_id".into(),
        attached.map_or(serde_json::Value::Null, |id| id.into()),
    );
    if let Some(label) = &report.label {
        body.insert("label".into(), label.clone().into());
    }
    body.insert("text".into(), report.text.clone().into());
    for (key, value) in [
        ("done", report.done),
        ("total", report.total),
        ("failures", report.failures),
    ] {
        if let Some(n) = value {
            body.insert(key.into(), n.into());
        }
    }
    body.insert("at_ms".into(), at_ms.into());
    let bytes = serde_json::to_vec(&body).expect("a json object of plain values serializes");
    splice_tug_session_id(&bytes, live)
}

/// The prefix that marks a provisional [`LedgerEntry::open_jobs`] key — one
/// opened at a launching `tool_use` and not yet confirmed by a `task_started`.
///
/// A `task_id` from claude is a short opaque token (`bfxxjpakz`), so it cannot
/// collide with this; the prefix is named here rather than spelled inline so
/// the writer, the re-key, and the wake's sweep cannot spell it three ways.
const LAUNCH_KEY_PREFIX: &str = "launch:";

/// The provisional key for a launching call's `tool_use_id`.
fn launch_key(tool_use_id: &str) -> String {
    format!("{LAUNCH_KEY_PREFIX}{tool_use_id}")
}

/// What a `task_started` / `task_updated` / `wake_started` frame does to a
/// session's set of open background jobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JobEdge {
    /// A job began — its `task_id` joins the open set.
    Opened(String),
    /// A job reported a terminal status — its `task_id` leaves the open set.
    Closed(String),
}

/// Read a job edge off a frame, if it carries one.
///
/// The statuses are claude's own: `completed`, `failed`, and the `killed` a
/// stop or a `Monitor` timeout produces. Anything else on a `task_updated` is a
/// mid-life status the wire has not shown us, and leaves the job open — the
/// conservative direction, since the cost of holding a job open too long is a
/// join offered a beat late, while closing it early is the bug this exists to
/// prevent.
///
/// A `wake_started` closes too. tugcode translates claude's
/// `system/task_notification` into `wake_started{wake_trigger:{task_id,
/// tool_use_id, status}}` (`buildWakeStartedMessage` in
/// `tugcode/src/session.ts`), so `task_notification` never reaches this wire
/// under that name and the id lives under `wake_trigger` rather than at the top
/// level. Its status vocabulary is `completed` / `failed` / `stopped`, where a
/// missing status defaults to `stopped` on tugcode's side. The deck reads its
/// close off the same field (`terminalJobStatusFromWire`), which is what keeps
/// the two readers of this wire in agreement.
///
/// A background **agent**'s terminal `task_updated` can land after the wake its
/// completion drives, which is harmless: the wake has already reopened the turn
/// by then, so the session is un-quiet either way and the set closes when the
/// frame arrives.
pub(crate) fn parse_job_edge(payload: &[u8]) -> Option<JobEdge> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    // The task id is read per shape, not once up front: a `wake_started`
    // carries none at the top level, so a single leading read would return
    // `None` for every one of them before the match was ever consulted.
    match value.get("type")?.as_str()? {
        "task_started" => Some(JobEdge::Opened(nonempty_task_id(&value)?)),
        "task_updated" => {
            let task_id = nonempty_task_id(&value)?;
            match value.get("status")?.as_str()? {
                "completed" | "failed" | "killed" => Some(JobEdge::Closed(task_id)),
                _ => None,
            }
        }
        "wake_started" => {
            // Every wake closes. A wake naming a job in a terminal status
            // closes that job by name; every other wake — the scheduler's own
            // re-init carrying no `wake_trigger` or an empty `task_id`, and a
            // named job reporting a status the wire has not shown us — closes
            // with an empty name, which the `Closed` arm reads as "nothing
            // named". That still matters, because a wake is the model
            // speaking again, and the provisional launches the arm sweeps are
            // exactly the entries whose gap the wake has just ended. Leaving
            // a named job open on an unknown status is the same conservative
            // direction the `task_updated` arm takes.
            let named = value.get("wake_trigger").and_then(|trigger| {
                let task_id = nonempty_task_id(trigger)?;
                let status = trigger.get("status")?.as_str()?;
                matches!(status, "completed" | "failed" | "stopped").then_some(task_id)
            });
            Some(JobEdge::Closed(named.unwrap_or_default()))
        }
        _ => None,
    }
}

/// The frame's `task_id`, or `None` when it is absent or empty.
///
/// An empty one is the harness-owned scheduler's re-init shape — a wake with no
/// job behind it, and nothing to track.
fn nonempty_task_id(value: &serde_json::Value) -> Option<String> {
    let task_id = value.get("task_id")?.as_str()?;
    (!task_id.is_empty()).then(|| task_id.to_owned())
}

/// The `tool_use_id` and tool name of a `tool_use` frame whose call launches
/// background work — `run_in_background: true` in the input, or the `Monitor`
/// tool, which is background activity by nature. This is the deck's
/// `isJobLaunch` gate (`select-jobs.ts`), applied at tugcast's fold so the two
/// readers of one wire count the same jobs. Everything else — including a
/// foreground `Agent` call, whose later `task_started` must open nothing —
/// answers `None`.
///
/// The name rides along because the launch is the only frame that carries it,
/// and the job's kind is recorded from it at the open ([P03]).
fn parse_background_launch(payload: &[u8]) -> Option<(String, JobKind)> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    if value.get("type")?.as_str()? != "tool_use" {
        return None;
    }
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    if tool_use_id.is_empty() {
        return None;
    }
    let backgrounded = value
        .get("input")
        .and_then(|i| i.get("run_in_background"))
        .and_then(|b| b.as_bool())
        == Some(true);
    let tool_name = value.get("tool_name").and_then(|n| n.as_str());
    let monitor = tool_name == Some("Monitor");
    (backgrounded || monitor).then(|| {
        (
            tool_use_id.to_owned(),
            JobKind::from(tool_name.unwrap_or("")),
        )
    })
}

/// The `tool_use_id` of an errored `tool_result` — the answer a launch that
/// never ran gets, and the only one.
fn parse_errored_tool_result(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    if value.get("type")?.as_str()? != "tool_result" {
        return None;
    }
    if value.get("is_error").and_then(|b| b.as_bool()) != Some(true) {
        return None;
    }
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    (!tool_use_id.is_empty()).then(|| tool_use_id.to_owned())
}

/// The `tool_use_id` a `task_started` frame names as its launching call, for
/// matching against [`LedgerEntry::background_launches`].
fn parse_task_started_launch_id(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    (!tool_use_id.is_empty()).then(|| tool_use_id.to_owned())
}

/// The frame family a job edge came from, for the edge trace — so a trace
/// reading `job_closed` says whether the close arrived on the status flip or on
/// the wake behind it.
fn frame_family(payload: &[u8]) -> &'static str {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return "unknown";
    };
    match value.get("type").and_then(|t| t.as_str()) {
        Some("task_started") => "task_started",
        Some("task_updated") => "task_updated",
        Some("wake_started") => "wake_started",
        _ => "unknown",
    }
}

/// What one frame says about the session's resident context window.
enum ContextWindowUpdate {
    /// A usage frame's reading, held until the next one replaces it.
    Measured(i64),
    /// A compaction: whatever was being held measures a context that no longer
    /// exists.
    Retired,
}

/// The window reading a frame writes, or `None` for the frames that say
/// nothing about it.
///
/// **A compact turn produces no usage frame of its own**, so before this the
/// pre-compaction figure stood as the session's reading straight through the
/// compaction and into the tick that judged it — and the arc, reading a number
/// still above its threshold, would rotate the stage to a fresh session over a
/// context it had just brought down. Retiring it says the true thing instead:
/// there is no measurement of this context yet. A missing reading is no reason
/// to strand a stage that has steps left, so the arc walks on and the next
/// real turn's first `streaming_usage` writes the size that matters.
///
/// The boundary carries a `post_tokens` of its own, and it is deliberately not
/// read here: it counts the compacted transcript rather than the resident
/// window, and turning one into the other would need an estimate of the
/// session's base — a second measurement of the same thing.
fn context_window_update(payload: &[u8]) -> Option<ContextWindowUpdate> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    // The frame's own `type`, never a substring of its bytes. The merger's
    // other gates are needles because they run in front of a parse nobody
    // else is paying for; this one runs in front of the reading below, which
    // parses every frame anyway — so a needle here buys nothing and costs the
    // false match, and an assistant message quoting a boundary frame (this
    // feature's own documents do) would retire a reading nothing replaced.
    if value.get("type").and_then(|ty| ty.as_str()) == Some("compact_boundary") {
        return Some(ContextWindowUpdate::Retired);
    }
    parse_context_window(&value).map(ContextWindowUpdate::Measured)
}

fn parse_context_window(value: &serde_json::Value) -> Option<i64> {
    match value.get("type")?.as_str()? {
        // Turn-final and main-lane only, so it needs no guard.
        "cost_update" => {}
        // Emitted once per `message_start` / `message_delta`, so the most
        // recent one is the window right now. A background subagent lane gets
        // its own frames, stamped with the tool use that spawned them — that
        // usage is the subagent's small window rather than the session's
        // resident one, and summing it here would misreport both.
        "streaming_usage" => {
            if value
                .get("parent_tool_use_id")
                .is_some_and(|id| !id.is_null())
            {
                return None;
            }
        }
        _ => return None,
    }
    let usage = value.get("usage")?.as_object()?;
    let total: i64 = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|key| usage.get(*key).and_then(serde_json::Value::as_i64))
    .sum();
    (total > 0).then_some(total)
}

/// The `model` field of a `model_change` CODE_INPUT frame ([P15]). A blank
/// selector reads as absent — there is no model named "".
fn parse_model_selector(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let model = value.get("model")?.as_str()?.trim();
    (!model.is_empty()).then(|| model.to_owned())
}

/// The `mode` field of a `permission_mode` CODE_INPUT frame. A blank mode
/// reads as absent — there is no permission mode named "".
fn parse_permission_mode_selector(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let mode = value.get("mode")?.as_str()?.trim();
    (!mode.is_empty()).then(|| mode.to_owned())
}

/// The two spellings of the one door, as a prompt's first token.
const ARC_DOOR_PREFIXES: [&str; 2] = ["/arc", "/tugplug:arc"];

/// `payload` with one `{"type":"text","text":<text>}` block appended to its
/// `content` array, re-serialized; `None` when the payload does not parse or
/// has no `content` array, in which case the caller forwards it untouched.
fn append_text_block(payload: &[u8], text: &str) -> Option<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    value
        .get_mut("content")?
        .as_array_mut()?
        .push(serde_json::json!({ "type": "text", "text": text }));
    serde_json::to_vec(&value).ok()
}

/// The arc a door prompt names, or `None` for every other prompt.
///
/// A prompt whose first token is the door — `/arc`, or its `/tugplug:`
/// spelling — and whose one and only other token is a
/// well-formed arc name (alphanumerics and hyphens, at least two characters,
/// and one `validate_arc_name` would accept, so a reserved word like
/// `status` never binds) names the arc the door is about to open. That is
/// the earliest moment the arc exists anywhere, and it is when the Session
/// card should start reading `ARC` over the session.
///
/// Deliberately narrow: a name is never guessed from prose. `/arc make the
/// ring pulse` opens on an idea whose first word happens to be a legal
/// name, and `/arc` alone opens on nothing yet; both return `None`, and that
/// door settles its name in conversation and binds itself when it writes
/// the brief. The lone-argument form is the one the door itself reads as a
/// name ("a lone argument that names an existing arc is a continuation").
fn arc_door_target(text: &str) -> Option<&str> {
    let mut tokens = text.split_whitespace();
    let door = tokens.next()?;
    if !ARC_DOOR_PREFIXES.contains(&door) {
        return None;
    }
    let name = tokens.next()?;
    if tokens.next().is_some() {
        return None;
    }
    let shaped = name.len() >= 2 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !shaped || tugarc_core::validate_arc_name(name).is_err() {
        return None;
    }
    Some(name)
}

/// Parse a CONTROL payload that carries `{ tug_session_id: "..." }` only.
/// `request_replay` per [D12] uses this shape: a verb that addresses a
/// specific Live session by its tug-side id and carries no other state
/// (no card_id — the verb is dispatch-side bookkeeping; no project_dir —
/// the supervisor already knows the workspace from the ledger entry).
///
/// Returning `MissingSessionId` matches the variant `parse_control_payload_owned`
/// uses when its `tug_session_id` field is absent — same semantics, same
/// wire-side error category.
fn parse_tug_session_id_payload(payload: &[u8]) -> Result<TugSessionId, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    Ok(TugSessionId::new(id))
}

/// Stamp `tug_session_id` onto a persisted SESSION_SIDEBAND replay payload
/// so it passes the client-side session filter ([D06]/[D11]). Parses the
/// JSON and sets the field (overwriting any stale value from a prior
/// binding), preserving every other field. A payload that fails to parse
/// falls back to [`splice_tug_session_id`] — same insert-after-first-brace
/// semantics the live relay path uses, with its pass-through-unchanged
/// behavior for hopeless blobs. Cold path (runs once per bind), so the
/// parse cost is irrelevant.
fn stamp_tug_session_id(payload: Vec<u8>, tug_session_id: &str) -> Vec<u8> {
    match serde_json::from_slice::<serde_json::Value>(&payload) {
        Ok(serde_json::Value::Object(mut obj)) => {
            obj.insert(
                "tug_session_id".to_owned(),
                serde_json::Value::String(tug_session_id.to_owned()),
            );
            serde_json::to_vec(&serde_json::Value::Object(obj)).unwrap_or(payload)
        }
        _ => splice_tug_session_id(&payload, tug_session_id),
    }
}

/// Canonical constructor for `SESSION_STATE` wire frames. Shared between
/// `agent_supervisor` (pending/spawning/closed/errored on control events)
/// and `agent_bridge` (live after session_init, errored on crash-budget
/// exhaustion). A single source of truth prevents wire-level drift between
/// publish sites.
pub(super) fn build_session_state_frame(
    tug_session_id: &TugSessionId,
    state: &str,
    detail: Option<&str>,
) -> Frame {
    let body = serde_json::json!({
        "tug_session_id": tug_session_id.as_str(),
        "state": state,
        "detail": detail,
    });
    let bytes = serde_json::to_vec(&body).expect("SESSION_STATE payload serializes");
    Frame::new(FeedId::SESSION_STATE, bytes)
}

fn build_session_unknown_frame(tug_session_id: &TugSessionId) -> Frame {
    let body = serde_json::json!({
        "type": "error",
        "detail": "session_unknown",
        "tug_session_id": tug_session_id.as_str(),
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_unknown payload serializes"),
    )
}

/// P13 spawn-budget check. Run inside `do_spawn_session`'s Phase 1 critical
/// section under the ledger lock. Returns the `detail` string that should be
/// stamped into both the `SESSION_STATE = errored` broadcast and the
/// returned `ControlError::CapExceeded`, or `None` if the spawn is
/// admissible. On admission the current `Instant` is appended to
/// `spawn_timestamps` so the rate-limit window advances atomically with
/// the cap decision.
///
/// Concurrent cap counts `Spawning` + `Live` entries only — `Idle` (intent
/// without subprocess) and `Errored` (crashed, awaiting reset) do not
/// consume slots. The per-entry `try_lock` is non-blocking; a contended
/// entry is counted conservatively as active so the cap cannot be
/// bypassed by a racing dispatcher.
fn cap_check_reason(
    ledger: &HashMap<TugSessionId, Arc<Mutex<LedgerEntry>>>,
    max_concurrent_sessions: usize,
    spawn_timestamps: &SyncMutex<VecDeque<Instant>>,
    max_spawns_per_minute: usize,
) -> Option<&'static str> {
    let reason = spawn_budget_reason(
        ledger,
        max_concurrent_sessions,
        spawn_timestamps,
        max_spawns_per_minute,
    );
    if reason.is_none() {
        spawn_timestamps.lock().push_back(Instant::now());
    }
    reason
}

/// The same two budgets, read without spending either — the answer to "would
/// a spawn be admitted right now?" for a caller that is not about to perform
/// one.
///
/// Split out of [`cap_check_reason`] so a caller can ask before it commits to
/// a spawn rather than discovering the answer inside a failed one. Reading it
/// must not consume a rate-limit slot, which is the whole of why the append
/// lives in the caller above rather than here.
///
/// Concurrent cap counts `Spawning` + `Live` entries only — `Idle` (intent
/// without subprocess) and `Errored` (crashed, awaiting reset) do not
/// consume slots. The per-entry `try_lock` is non-blocking; a contended
/// entry is counted conservatively as active so the cap cannot be
/// bypassed by a racing dispatcher.
fn spawn_budget_reason(
    ledger: &HashMap<TugSessionId, Arc<Mutex<LedgerEntry>>>,
    max_concurrent_sessions: usize,
    spawn_timestamps: &SyncMutex<VecDeque<Instant>>,
    max_spawns_per_minute: usize,
) -> Option<&'static str> {
    let mut active = 0usize;
    for entry_arc in ledger.values() {
        let counted = match entry_arc.try_lock() {
            Ok(entry) => {
                matches!(entry.spawn_state, SpawnState::Spawning | SpawnState::Live)
            }
            Err(_) => true,
        };
        if counted {
            active += 1;
            if active >= max_concurrent_sessions {
                return Some("concurrent_session_cap_exceeded");
            }
        }
    }
    let mut ts = spawn_timestamps.lock();
    let now = Instant::now();
    let cutoff = now.checked_sub(Duration::from_secs(60)).unwrap_or(now);
    while ts.front().is_some_and(|&t| t < cutoff) {
        ts.pop_front();
    }
    if ts.len() >= max_spawns_per_minute {
        return Some("spawn_rate_limited");
    }
    None
}

fn build_backpressure_frame(tug_session_id: &TugSessionId) -> Frame {
    let body = serde_json::json!({
        "type": "session_backpressure",
        "tug_session_id": tug_session_id.as_str(),
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_backpressure payload serializes"),
    )
}

/// Build the CONTROL error frame the dispatcher emits when the ledger
/// `insert_pending_turn` write fails for an inbound `user_message`.
/// Mirrors the wire shape of [`build_session_unknown_frame`] so tugdeck
/// surfaces it through the same error-frame path. The user-visible
/// behavior is identical to a `session_unknown`: the inbound frame is
/// dropped (not forwarded to tugcode), tugdeck shows an error, and the
/// session state is unchanged.
fn build_ledger_failure_frame(tug_session_id: &TugSessionId) -> Frame {
    let body = serde_json::json!({
        "type": "error",
        "detail": "ledger_insert_failed",
        "tug_session_id": tug_session_id.as_str(),
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("ledger_insert_failed payload serializes"),
    )
}

/// Routing decision produced by the CODE_INPUT dispatcher under the per-session
/// lock and consumed outside the lock so await-heavy sends never race the
/// lock's critical section.
enum Decision {
    Drop,
    Spawn,
    Forward(mpsc::Sender<Frame>, Frame),
    Backpressure,
}

/// Which arcs a repo still has a **record** of — or that it could not be
/// asked, which is a different thing and must stay one.
///
/// `Known` is an answer: these owner-key stems have a record, and a binding
/// naming anything else names an arc that is gone. `Unreadable` is not an
/// answer — `git` could not be run at all, and an empty set there is
/// indistinguishable from a repo with no arcs in it. Collapsed into "no
/// arcs", a moved repo or a stale `project_dir` spelling silently unbinds
/// every card on the machine at once.
///
/// Built by [`AgentSupervisor::live_arc_records`], read by
/// [`AgentSupervisor::reported_binding`].
enum ArcRecords {
    Known(std::collections::HashSet<String>),
    Unreadable,
}

/// Announce a completed session↔arc mating to every connected deck.
///
/// A bind has two doors — the `bind_arc` CONTROL verb a card sends, and
/// `POST /api/arc` the CLI posts (which is what `tugtool arc create`'s
/// auto-bind rides) — and it is the same fact through either one. Both call
/// this, because a deck that learns about one door's binds but not the other's
/// wears a chip that disagrees with the ledger until something else happens to
/// repaint it.
///
/// `line_id` and `card_id` are the deck's **routing** halves, and they are the
/// difference between an announcement that lands and one that is dropped. The
/// deck walks segment → line → card to find the card wearing a session; on the
/// rotation seat the segment named here is seconds old and the deck has never
/// heard of it, so that walk resolves nothing. A caller that knows where the
/// segment sits says so and the routing needs no walk at all. `None` is for
/// the doors where the row is old news and the walk cannot fail.
pub(crate) fn broadcast_bind_arc_ok(
    control_tx: &broadcast::Sender<Frame>,
    tug_session_id: &str,
    arc_id: &str,
    arc_name: &str,
    line_id: Option<&str>,
    card_id: Option<&str>,
) {
    let mut body = serde_json::json!({
        "action": "bind_arc_ok",
        "tug_session_id": tug_session_id,
        "arc_id": arc_id,
        "arc_name": arc_name,
    });
    if let Some(map) = body.as_object_mut() {
        if let Some(line_id) = line_id {
            map.insert("line_id".into(), serde_json::Value::from(line_id));
        }
        if let Some(card_id) = card_id {
            map.insert("card_id".into(), serde_json::Value::from(card_id));
        }
    }
    let _ = control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("bind_arc_ok serializes"),
    ));
}

/// The unmating half of [`broadcast_bind_arc_ok`], with the same two doors.
pub(crate) fn broadcast_unbind_arc_ok(control_tx: &broadcast::Sender<Frame>, tug_session_id: &str) {
    let body = serde_json::json!({
        "action": "unbind_arc_ok",
        "tug_session_id": tug_session_id,
    });
    let _ = control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("unbind_arc_ok serializes"),
    ));
}

/// Log a ledger mutation whose failure the caller does not otherwise act on.
///
/// The callers bump the changeset aggregate next whatever this says: the bump
/// is what makes the deck re-read, and suppressing it on failure would hide a
/// stale row rather than report a failed write. One line per site also keeps
/// these visually apart from the `let _ = …send(…)` on broadcast channels,
/// where no receiver is a fine answer.
fn log_ledger_err<T>(what: &str, key: &str, result: Result<T, crate::session_ledger::LedgerError>) {
    if let Err(e) = result {
        warn!(op = what, key, error = %e, "ledger mutation failed");
    }
}

impl AgentSupervisor {
    /// Construct a supervisor with pre-made broadcast senders, a sessions
    /// recorder, and a spawner factory. Returns `(supervisor,
    /// merger_register_rx)` — the caller is expected to `tokio::spawn`
    /// [`AgentSupervisor::merger_task`] with the returned receiver.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_state: SessionScopedFeed,
        session_sideband: SessionScopedFeed,
        code_output: SessionScopedFeed,
        activity: SessionScopedFeed,
        control_tx: broadcast::Sender<Frame>,
        sessions_recorder: Arc<dyn SessionsRecorder>,
        spawner_factory: SpawnerFactory,
        config: AgentSupervisorConfig,
        registry: Arc<WorkspaceRegistry>,
        cancel: CancellationToken,
    ) -> (Self, mpsc::Receiver<MergerRegistration>) {
        Self::new_with_ledger(
            session_state,
            session_sideband,
            code_output,
            activity,
            control_tx,
            sessions_recorder,
            None,
            spawner_factory,
            config,
            registry,
            cancel,
        )
    }

    /// Construct a supervisor with an explicit `Arc<SessionLedger>` for the
    /// read-side CONTROL ops. Production wires this in `main.rs`; unit tests
    /// that don't exercise the ledger CONTROL paths use [`Self::new`] and
    /// get `None`.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_ledger(
        session_state: SessionScopedFeed,
        session_sideband: SessionScopedFeed,
        code_output: SessionScopedFeed,
        activity: SessionScopedFeed,
        control_tx: broadcast::Sender<Frame>,
        sessions_recorder: Arc<dyn SessionsRecorder>,
        session_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
        spawner_factory: SpawnerFactory,
        config: AgentSupervisorConfig,
        registry: Arc<WorkspaceRegistry>,
        cancel: CancellationToken,
    ) -> (Self, mpsc::Receiver<MergerRegistration>) {
        let (merger_register_tx, merger_register_rx) = mpsc::channel(64);
        let sup = Self {
            ledger: Arc::new(Mutex::new(HashMap::new())),
            session_state,
            session_sideband,
            client_sessions: Arc::new(Mutex::new(HashMap::new())),
            code_output,
            activity,
            control_tx,
            sessions_recorder,
            session_ledger,
            shell_ledger: None,
            refs_ledger: None,
            prompt_ledger: None,
            digester: None,
            scribe: None,
            spawner_factory,
            merger_register_tx,
            config,
            registry,
            cancel,
            spawn_timestamps: Arc::new(SyncMutex::new(VecDeque::new())),
            changeset_watch: std::sync::OnceLock::new(),
            draft_tasks: crate::feeds::draft_engine::DraftTaskRegistry::default(),
            turn_complete_tx: std::sync::OnceLock::new(),
            arc_tick_tx: std::sync::OnceLock::new(),
            wheel_tick_tx: std::sync::OnceLock::new(),
            wheel: std::sync::OnceLock::new(),
        };
        // Published for the readers that need to know whether a session is
        // finished but have no path to the supervisor — the changeset
        // recompute, which will not offer an arc for joining while the session
        // that built it is still working.
        let _ = LEDGER_HANDLE.set(Arc::clone(&sup.ledger));
        (sup, merger_register_rx)
    }

    /// Snapshot every session that currently has a live tugcode child AND a
    /// turn in flight, with its captured `(pid, start_time)` — the input the
    /// activity sampler ([P10]) needs to root each session's subtree walk
    /// and apply the PID-reuse guard ([P20]). Sessions between spawns (no
    /// live child) and sessions idle between turns are omitted: the beat
    /// attributes the session *working*, so an idle session's gauges decay
    /// to zero instead of reporting the claude process's idle heartbeat.
    pub async fn live_session_processes(&self) -> Vec<LiveSessionProcess> {
        let entries: Vec<Arc<Mutex<LedgerEntry>>> = {
            let ledger = self.ledger.lock().await;
            ledger.values().cloned().collect()
        };
        let mut out = Vec::new();
        for entry_arc in entries {
            let entry = entry_arc.lock().await;
            if !entry.turn_active {
                continue;
            }
            if let (Some(pid), Some(start_time)) = (entry.child_pid, entry.child_start_time) {
                out.push(LiveSessionProcess {
                    tug_session_id: entry.tug_session_id.clone(),
                    pid,
                    start_time,
                });
            }
        }
        out
    }

    /// Handle a CONTROL frame's action. `client_id` is the WebSocket
    /// connection id (see [D09]); it is distinct from `card_id` and is
    /// used only for the per-client session affinity map in [D14].
    ///
    /// Actions:
    /// * `spawn_session` — register intent + start the per-session
    ///   subprocess if Idle. Payload: `{card_id, tug_session_id,
    ///   project_dir, session_mode?}`.
    /// * `close_session` — stop the subprocess and drop the ledger
    ///   entry. Payload: `{card_id, tug_session_id}`.
    /// * `reset_session` — invalidate the persisted resume id and
    ///   re-arm the entry for a fresh spawn, preserving the workspace.
    ///   Payload: `{card_id, tug_session_id}`.
    /// * `list_sessions` — picker query. Payload: `{project_dir}`.
    /// * `trash_session` — drop a non-live persisted record.
    ///   Payload: `{session_id}`.
    /// * `trash_project_dir_sessions` — drop every non-live record
    ///   under a workspace. Payload: `{project_dir}`.
    /// * `request_replay` — recovery verb per [D12]. Forward
    ///   `{"type":"request_replay"}` to the live tugcode subprocess so
    ///   a freshly-mounted `CodeSessionStore` rehydrates from JSONL.
    ///   No-op if the entry is not Live. Payload: `{tug_session_id}`.
    ///
    /// The arc verbs (Spec S02), which all carry `{tug_session_id,
    /// project_dir, arc}` and answer with an `_ok` / `_err` pair the
    /// transport control settles a press on:
    /// * `bind_arc` / `unbind_arc` — the mating alone.
    /// * `arc_run` — start: open the arc when it has no record, then bind.
    ///   Carries an optional `kind` the opening records ([B08]).
    /// * `arc_resume` — pick a stopped arc back up on this card.
    /// * `arc_stop` — stop the arc this card runs, interrupting a running
    ///   turn first ([P03]).
    ///
    /// Returns [`ControlOutcome::PassThrough`] for any action not
    /// matched above so the router can fall through to its legacy
    /// `dispatch_action` pipeline. The match arms here are the single
    /// source of truth for "which CONTROL actions the supervisor owns";
    /// the router does not maintain a separate allowlist.
    /// Compose the changeset aggregate fresh, on demand, over the current
    /// registry + ledger — the same call the `CHANGESET_ALL` feed makes on a
    /// bump. Read-only; used by the `/api/changesets` observability endpoint so
    /// a CLI can see exactly what compose produces right now (ground truth
    /// against the deck's "No changes"), independent of emission/diff-suppression.
    pub async fn compose_changeset_aggregate(
        &self,
    ) -> tugcast_core::types::WorkspacesChangesetSnapshot {
        super::changeset_all::compose_aggregate(&self.registry, self.session_ledger.as_deref())
            .await
    }

    pub async fn handle_control(
        &self,
        action: &str,
        payload: &[u8],
        client_id: ClientId,
    ) -> ControlOutcome {
        // Each CONTROL family answers its own actions in its own module
        // (`control/`). Any action not named here is not owned by the
        // supervisor: the caller falls through to `dispatch_action`.
        let Ok(action) = action.parse::<ControlAction>() else {
            return ControlOutcome::PassThrough;
        };
        use ControlAction as A;
        match action {
            A::SpawnSession
            | A::CloseSession
            | A::ResetSession
            | A::ListSessions
            | A::ListCardBindings
            | A::ResolveSessions
            | A::RequestReplay => {
                self.handle_session_control(action, payload, client_id)
                    .await
            }
            A::BindArc | A::ArcResume | A::ArcRun | A::ArcStop | A::UnbindArc => {
                self.handle_arc_control(action, payload).await
            }
            A::ChangesetGitInit
            | A::ChangesetCommit
            | A::ChangesetPush
            | A::ChangesetClaim
            | A::ChangesetDisclaim
            | A::ChangesetRefresh
            | A::ChangesetDraftRequest
            | A::ChangesetDraftCancel
            | A::ChangesetDraftSet
            | A::LandingReceipt
            | A::ChangesetJoin
            | A::ChangesetJoinResolve
            | A::ChangesetJoinResolveBase
            | A::ChangesetJoinResolveBaseUndo
            | A::ChangesetJoinQuestionAnswer
            | A::ChangesetDiscard
            | A::ChangesetDeleteDocuments
            | A::ChangesetReplay => self.handle_changeset_control(action, payload).await,
            A::DeckSeatings | A::DeckLog => {
                self.handle_deck_control(action, payload, client_id).await
            }
            A::TrashSession
            | A::RenameSession
            | A::SetSessionPrivate
            | A::TrashProjectDirSessions => self.handle_rows_control(action, payload).await,
            A::RecordTurnTelemetry
            | A::RecordContextBreakdown
            | A::RecordSessionStateChange
            | A::ListSessionStateChanges
            | A::ListDigestLines
            | A::ListOverviewPosts
            | A::ListShellExchanges
            | A::ListRefs => self.handle_telemetry_control(action, payload).await,
            // The router's own reads and the legacy pipeline's verbs.
            A::FeedStats
            | A::SubscribeFeeds
            | A::EvalResponse
            | A::AskResponse
            | A::Relaunch
            | A::CheckAuth
            | A::CheckHostTools
            | A::OfferHostTools
            | A::InstallClaude
            | A::ClaudeDownloadResume
            | A::ClaudeDownloadPause
            | A::ClaudeDownloadCancel
            | A::CheckClaudeVersion
            | A::UpdateClaude
            | A::ClaudeSignIn
            | A::ClaudeLogout
            | A::SharedAgentClassify => ControlOutcome::PassThrough,
        }
    }

    /// Spawn a session no card owns ([P11]).
    ///
    /// The pipeline is `do_spawn_session`'s minus everything that belongs to a
    /// client: no `client_sessions` affinity row, no `spawn_session_ok` ack,
    /// and none of the resume arbitration — a headless spawn always mints a
    /// fresh id, so there is no other holder to arbitrate against. What
    /// remains is what makes a session a session: the workspace refcount, the
    /// ledger entry, the P13 spawn budget, and the eager subprocess. The
    /// session is therefore ordinary everywhere downstream — it gets a
    /// transcript, a ledger row, a citation identity, and an id a deck client
    /// can later resume.
    ///
    /// The card id is `background:<owner>`. It names the owner that asked
    /// rather than addressing a card, because no card by that id exists.
    /// `background_session` owns both the minting and the recognising, so a
    /// reader downstream can tell a session held by a background owner from
    /// one held by a card a user could be sent to.
    #[cfg_attr(not(test), allow(dead_code))] // no background spawner ships yet
    pub(crate) async fn spawn_headless_session(
        &self,
        owner: &str,
        project_dir: &Path,
        permission_mode: Option<String>,
        tag: Option<String>,
    ) -> Result<TugSessionId, ControlError> {
        let card_id = background_card_id(owner);
        let tug_session_id = TugSessionId::new(uuid::Uuid::new_v4().to_string());
        // A headless session is the only session on its line, and it mints the
        // line itself because no drop preceded it ([P03]).
        let line_id = uuid::Uuid::new_v4().to_string();

        // Phase 0: validate + canonicalize + acquire the workspace refcount,
        // before the ledger is touched, so a bad path costs nothing.
        let workspace_entry = self
            .registry
            .get_or_create(project_dir, self.cancel.clone())
            .map_err(|e| match e {
                WorkspaceError::InvalidProjectDir { reason, .. } => {
                    warn!(
                        card_id,
                        session = %tug_session_id,
                        path = ?project_dir,
                        reason,
                        "spawn_headless_session: invalid project_dir"
                    );
                    ControlError::InvalidProjectDir { reason }
                }
                WorkspaceError::UnknownKey(_) => {
                    unreachable!("get_or_create never returns UnknownKey")
                }
            })?;
        let workspace_key = workspace_entry.workspace_key.clone();
        drop(workspace_entry);

        // Phase 1: the budget check and the insert, atomic under the ledger
        // lock. The id is fresh, so this is always an insert and the
        // reconnect arithmetic `do_spawn_session` carries has nothing to
        // decide here. The budget is not waived: a headless session is a real
        // subprocess and counts like every other.
        let entry_arc = {
            let mut ledger = self.ledger.lock().await;
            if let Some(reason) = cap_check_reason(
                &ledger,
                self.config.max_concurrent_sessions,
                &self.spawn_timestamps,
                self.config.max_spawns_per_minute,
            ) {
                drop(ledger);
                if let Err(e) = self.registry.release(&workspace_key) {
                    warn!(
                        card_id,
                        session = %tug_session_id,
                        error = %e,
                        "spawn_headless_session: cap-reject workspace release failed (ignored)"
                    );
                }
                warn!(
                    card_id,
                    session = %tug_session_id,
                    reason,
                    "spawn_headless_session: rejected by spawn budget"
                );
                return Err(ControlError::CapExceeded { reason });
            }
            let arc = Arc::new(Mutex::new(LedgerEntry::new(
                tug_session_id.clone(),
                workspace_key.clone(),
                project_dir.to_path_buf(),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            )));
            ledger.insert(tug_session_id.clone(), Arc::clone(&arc));
            arc
        };

        // Phase 2: stamp the entry and claim the spawn. The refcount Phase 0
        // acquired is this entry's for its lifetime; `do_close_session`
        // releases it on the strength of this flag.
        {
            let mut entry = entry_arc.lock().await;
            entry.card_id = Some(card_id.clone());
            entry.permission_mode = permission_mode;
            entry.tag = tag;
            entry.line_id = Some(line_id);
            entry.holds_workspace_refcount = true;
            entry
                .spawn_state
                .try_transition(SpawnState::Spawning)
                .expect("a just-minted entry is Idle");
        }

        self.session_state.publish_tagged(build_session_state_frame(
            &tug_session_id,
            "pending",
            None,
        ));
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "supervisor.headless_spawn",
            tug_session_id = %tug_session_id,
            card_id = %card_id,
            project_dir = ?project_dir,
        );

        self.spawn_session_worker(&tug_session_id).await;

        Ok(tug_session_id)
    }

    /// Close a session `spawn_headless_session` opened. The close path is the
    /// card's own — the workspace refcount comes back, the ledger row goes
    /// `closed`, and the session-closed fact is recorded — because a headless
    /// session differs from a card's only in who asked for it.
    ///
    /// Unless the session is no longer the caller's. A deck card that resumes
    /// a background session re-points the entry's `card_id` to its own, and
    /// from that moment the session belongs to a user sitting inside it —
    /// closing it would tear down a conversation mid-sentence. So the entry is
    /// read before anything is torn down, and a `card_id` that is not the one
    /// this caller minted is a refusal.
    ///
    /// The guard is here rather than in `do_close_session` on purpose: the
    /// user's own close of the adopted card goes through that path and must
    /// still work.
    #[cfg_attr(not(test), allow(dead_code))] // no background spawner ships yet
    pub(crate) async fn close_headless_session(&self, owner: &str, tug_session_id: &TugSessionId) {
        let card_id = background_card_id(owner);
        let held_by = {
            let entry_arc = self.ledger.lock().await.get(tug_session_id).cloned();
            match entry_arc {
                Some(entry_arc) => entry_arc.lock().await.card_id.clone(),
                // No entry at all: nothing to hand over and nothing to close.
                // `do_close_session` short-circuits on an unknown id anyway.
                None => None,
            }
        };
        if let Some(held_by) = held_by.filter(|held| held != &card_id) {
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "supervisor.headless_close_refused",
                tug_session_id = %tug_session_id,
                card_id = %card_id,
                held_by = %held_by,
                "a card took the session over; leaving it to its new holder",
            );
            return;
        }
        self.do_close_session(&card_id, tug_session_id).await;
    }

    /// Close a **card** ([B04]): every bridge the card holds, and every live
    /// row on its line.
    ///
    /// A card is a line, so closing one by a single segment id is how a
    /// bridge outlives the card that asked for it — the incident's second
    /// `tugcode` died with the close that named it and the first went on
    /// running, with the card gone from the layout and the ledger still
    /// reporting it live. With [B03] there should be exactly one bridge per
    /// card, and this sweep is what makes that true rather than hoped for: a
    /// bridge cannot survive its card because there is no bridge that is not
    /// the card's.
    ///
    /// **The holder is resolved before the sweep**, from a snapshot taken
    /// before anything is torn down, so the `headless_close_refused` rule
    /// survives it: an entry on the line whose `card_id` is some *other*
    /// card is one a deck card took over, and closing it would tear down a
    /// conversation somebody is sitting inside. Those are left alone; an
    /// entry holding no card yet is the card's own, pre-binding.
    async fn close_card_session(&self, card_id: &str, tug_session_id: &TugSessionId) {
        self.close_card_session_keeping(card_id, tug_session_id, None)
            .await;
    }

    /// [`Self::close_card_session`], sparing `keep` — the session the card
    /// has just been moved onto. A directory change is the one close whose
    /// card is not going away: it leaves the old line for a new one, and the
    /// card-wide sweep would otherwise take the session it moved to along
    /// with the one it left.
    async fn close_card_session_keeping(
        &self,
        card_id: &str,
        tug_session_id: &TugSessionId,
        keep: Option<&TugSessionId>,
    ) {
        // The snapshot. Every decision below reads it rather than the live
        // map, so a close landing halfway through cannot change who is swept.
        let entries: Vec<(TugSessionId, Option<String>, Option<String>)> = {
            let ledger = self.ledger.lock().await;
            let handles: Vec<(TugSessionId, Arc<Mutex<LedgerEntry>>)> = ledger
                .iter()
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect();
            drop(ledger);
            let mut out = Vec::with_capacity(handles.len());
            for (id, entry_arc) in handles {
                let entry = entry_arc.lock().await;
                out.push((id, entry.card_id.clone(), entry.line_id.clone()));
            }
            out
        };
        // The card's line: the named entry's, else the one the sessions
        // ledger files that segment under — the close may name a segment no
        // bridge was ever keyed by.
        let line = entries
            .iter()
            .find(|(id, _, _)| id == tug_session_id)
            .and_then(|(_, _, line)| line.clone())
            .or_else(|| {
                self.session_ledger
                    .as_ref()
                    .and_then(|l| l.get(&tug_session_id.0).ok().flatten())
                    .map(|row| row.line_id)
            })
            .filter(|id| !id.is_empty());

        // The named id always goes, and then every entry the card holds, and
        // then every entry on the line no other card has taken over.
        let mut targets: Vec<TugSessionId> = vec![tug_session_id.clone()];
        for (id, held_by, entry_line) in &entries {
            if id == tug_session_id || targets.contains(id) || Some(id) == keep {
                continue;
            }
            let held_by_this_card = held_by.as_deref() == Some(card_id);
            let on_this_line = line.is_some() && entry_line == &line;
            let taken_over = held_by.as_deref().is_some_and(|held| held != card_id);
            if held_by_this_card || (on_this_line && !taken_over) {
                targets.push(id.clone());
            } else if on_this_line && taken_over {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "supervisor.line_close_refused",
                    tug_session_id = %id,
                    card_id = %card_id,
                    held_by = %held_by.as_deref().unwrap_or(""),
                    "a card took this segment over; leaving it to its new holder",
                );
            }
        }
        if targets.len() > 1 {
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "supervisor.card_close_sweep",
                card_id = %card_id,
                named = %tug_session_id,
                count = targets.len(),
                "closing every bridge this card holds",
            );
        }
        for target in &targets {
            self.do_close_session(card_id, target).await;
        }

        // And the rows. A bridge that was torn down closed the one row its
        // own `claude_session_id` named; a segment the line wore under a
        // bridge that is already gone has nobody left to close it. Each goes
        // through the ordinary close, so each still takes the arc off its
        // card before the binding is cleared.
        let (Some(line), Some(ledger)) = (line, self.session_ledger.as_ref()) else {
            return;
        };
        for segment in ledger.live_segments_of_line(&line) {
            crate::arc_api::stop_an_on_arc_cards_arc_as_closed(ledger, &segment);
            match ledger.mark_closed(&segment) {
                Ok(true) => tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "supervisor.line_segment_closed",
                    line_id = %line,
                    tug_session_id = %segment,
                    "a live row the card's line left behind",
                ),
                Ok(false) => {}
                Err(e) => warn!(
                    line_id = %line,
                    session = %segment,
                    error = %e,
                    "close_session: line segment close failed, continuing"
                ),
            }
        }
    }

    /// Resolved terminal-liveness registry root: the configured
    /// override, else the production default (`~/.claude/sessions/`).
    fn terminal_registry_root(&self) -> Option<PathBuf> {
        self.config
            .terminal_registry_root
            .clone()
            .or_else(crate::terminal_registry::default_registry_root)
    }

    /// Read the terminal-liveness registry. Fail-open: no resolvable
    /// root → empty map (no liveness data, never an error).
    fn read_terminal_live_sessions(
        registry_root: Option<&std::path::Path>,
    ) -> HashMap<String, crate::terminal_registry::TerminalLiveEntry> {
        match registry_root {
            Some(root) => crate::terminal_registry::read_live_sessions(root),
            None => HashMap::new(),
        }
    }

    /// The repo's arc records, keyed by legacy owner key (`tugarc/<name>`).
    ///
    /// **Two** `git` reads per repo, membership-tested in memory — not a
    /// `rev-parse` per arc ([P05]). The callers are the startup restore
    /// round-trip cards wait on behind `RESTORE_PASS_SETTLE_TIMEOUT_MS` and
    /// the per-spawn ack; neither may grow subprocess fan-out proportional to
    /// the arc count.
    ///
    /// **The branch is not the record.** An arc's durable identity is its
    /// `tugid` git-config entry, which `ensure_arc_id` mints at bind time and
    /// which needs no branch — so an arc that bound before its branch existed
    /// is bound by design (`server.rs`, the `arc_run` door) and gating on the
    /// ref alone nulls it deterministically. A teardown takes both: `git branch
    /// -D` deletes the branch's whole config section, `tugid` included, which
    /// is what makes their absence together mean "gone".
    ///
    /// The config read is only trusted once `for-each-ref` has proved the repo
    /// answers at all: `git config --get-regexp` exits 1 on *no matches*, which
    /// would otherwise read the same as a repo that is not there.
    fn live_arc_records(repo: &str) -> ArcRecords {
        let git = |args: &[&str]| {
            tugcore::git_command()
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
        };
        let Ok(refs) = git(&[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/tugarc/",
        ]) else {
            return ArcRecords::Unreadable;
        };
        if !refs.status.success() {
            return ArcRecords::Unreadable;
        }
        let mut records: std::collections::HashSet<String> = String::from_utf8_lossy(&refs.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect();
        if let Ok(config) = git(&["config", "--get-regexp", r"^branch\.tugarc/.*\.tugid$"])
            && config.status.success()
        {
            for line in String::from_utf8_lossy(&config.stdout).lines() {
                // `branch.tugarc/<name>.tugid <value>` — the stem between the
                // `branch.` prefix and the `.tugid` suffix is the legacy key.
                let key = line.split_whitespace().next().unwrap_or_default();
                if let Some(stem) = key
                    .strip_prefix("branch.")
                    .and_then(|k| k.strip_suffix(".tugid"))
                    && !stem.is_empty()
                {
                    records.insert(stem.to_string());
                }
            }
        }
        ArcRecords::Known(records)
    }

    /// A stored binding as it should be *reported*: the pair as written, or
    /// nulls when the arc's record is gone ([P05]).
    ///
    /// The eager clear on a tugcast-side landing covers the card workflow;
    /// this is the lazy half that keeps reads correct when tugcast was never
    /// in the loop — a terminal join, or a crash between teardown and the
    /// CLI's `arc_gone` broadcast.
    ///
    /// A read that cannot see the repo keeps the ledger's answer. Nulling is a
    /// claim — "this arc is gone" — and only evidence may make it; a failed
    /// `git` is the absence of evidence. The wrong direction here blanks the
    /// arc chip on every card at once with nothing saying why, which is the
    /// half of the postmortem that had no instrumentation.
    ///
    /// Every decision traces under `dev::ledger`, because the surface it
    /// governs is a chip going blank and the question asked afterwards is
    /// always "why did it think the arc was gone".
    fn reported_binding(
        records: &ArcRecords,
        arc_id: Option<String>,
        arc_name: Option<String>,
    ) -> (Option<String>, Option<String>) {
        let Some(id) = arc_id else {
            return (None, None);
        };
        match records {
            ArcRecords::Unreadable => {
                tracing::warn!(
                    target: "dev::ledger",
                    event = "ledger.reported_binding.kept_unreadable",
                    arc_id = id.as_str(),
                    "the repo could not be read; keeping the ledger's binding rather than nulling it",
                );
                (Some(id), arc_name)
            }
            ArcRecords::Known(records) => {
                if records.contains(tugarc_core::ops::legacy_owner_key(&id)) {
                    tracing::debug!(
                        target: "dev::ledger",
                        event = "ledger.reported_binding.kept",
                        arc_id = id.as_str(),
                    );
                    (Some(id), arc_name)
                } else {
                    tracing::info!(
                        target: "dev::ledger",
                        event = "ledger.reported_binding.nulled",
                        arc_id = id.as_str(),
                        records = records.len(),
                        "the repo holds no branch and no tugid for this arc",
                    );
                    (None, None)
                }
            }
        }
    }

    /// Post-landing cleanup for an arc's join draft ([P14]): joins and
    /// releases both delete the `arc:<branch>` row, so a reused arc name
    /// never inherits a dead arc's clobber-protected message.
    ///
    /// `project_dir` is whatever spelling the landing verb was called with, so
    /// it passes the [L29] gateway here — one call, at the boundary — to reach
    /// the key the row was written under.
    ///
    /// Delete a landed arc's authored join draft, under every key it could
    /// have been written with: the owner key and its legacy branch-ref form
    /// ([P03]), each across the canonical and as-given project spellings.
    ///
    /// `owner_key` arrives **pre-resolved** and cannot be resolved here.
    /// `git branch -D` takes the branch's whole config section with it,
    /// `tugid` included, so by the time a landing returns, the only key this
    /// function could derive is the legacy one — and the user's authored draft
    /// would survive under a key nothing can name again ([L23], [P05],
    /// Risk R02). The caller captures the key before the teardown.
    pub(crate) fn clear_arc_draft(
        ledger: &crate::session_ledger::SessionLedger,
        project_dir: &str,
        owner_key: &str,
    ) {
        let canonical =
            crate::path_resolver::CanonicalPath::from_raw(std::path::Path::new(project_dir));
        let legacy_key = tugarc_core::ops::legacy_owner_key(owner_key);
        let keys = if legacy_key == owner_key {
            vec![owner_key]
        } else {
            vec![owner_key, legacy_key]
        };
        for key in keys {
            log_ledger_err(
                "delete_changeset_draft",
                &format!("arc:{key} in {}", canonical.as_str()),
                ledger.delete_changeset_draft("arc", key, canonical.as_str()),
            );
            if canonical.as_str() != project_dir {
                log_ledger_err(
                    "delete_changeset_draft",
                    &format!("arc:{key} in {project_dir}"),
                    ledger.delete_changeset_draft("arc", key, project_dir),
                );
            }
        }
    }

    /// Record `model → <selector> in <stage>` when the card is running a live
    /// arc's stage.
    ///
    /// A no-op for every other card: the note is about an arc, and a user
    /// changing models on their own card is not one.
    pub(crate) async fn note_model_switch(&self, session: &str, selector: &str) {
        let Some(ledger) = self.session_ledger.clone() else {
            return;
        };
        let session = session.to_string();
        let selector = selector.to_string();
        let task_session = session.clone();
        let joined = tokio::task::spawn_blocking(move || {
            let session = task_session;
            let Ok(Some(row)) = ledger.get(&session) else {
                return;
            };
            let Some(arc) = row.arc_name.as_deref() else {
                return;
            };
            if ledger.stage_provenance(&session).is_none() {
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
            if let Err(e) = tugarc_core::arc::append_arc_note(
                project,
                arc,
                &format!("model → {selector} in {}", stage.as_str()),
            ) {
                warn!(arc = %arc, error = %e, "could not record a mid-stage model switch");
            }
        })
        .await;
        if let Err(e) = joined {
            warn!(session = %session, error = %e, "the mid-stage model-switch note did not finish");
        }
    }

    /// The model a card returns to when an arc gives it back — the deck's own
    /// selector, which only a WebSocket client's `model_change` ever writes.
    ///
    /// `None` when the card never chose one, which a caller words as the
    /// account default rather than showing a blank.
    pub async fn deck_model_for(&self, session: &str) -> Option<String> {
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(&TugSessionId::new(session.to_string())).cloned()
        }?;
        let entry = entry_arc.lock().await;
        entry.deck_model.clone()
    }

    /// Persist and announce the arc's terminal receipt ([P12]).
    ///
    /// The arc has no initiating client — nobody asked for this and no `_ok`
    /// frame is owed to anybody — so the two halves a landing gets for free
    /// are done explicitly here: the durable row through the same gateway
    /// every landing uses (so a relaunch replays it like any other ink), and
    /// an unsolicited `arc_receipt` CONTROL frame so the card the arc ran on
    /// paints its live copy now rather than at the next restore. Both carry
    /// the ledger row's id, which is what keeps the live row and the replayed
    /// one one transcript turn rather than two receipts for one arc.
    pub fn record_arc_receipt(&self, session: &str, arc: &str, project_dir: &str, summary: &str) {
        let receipt_id = Self::record_landing_receipt(
            self.shell_ledger.as_ref(),
            self.session_ledger.as_ref(),
            Some(session),
            "/arc-run",
            summary,
            project_dir,
        );
        let body = serde_json::json!({
            "action": "arc_receipt",
            "project_dir": project_dir,
            "arc": arc,
            // The card's own session id, deliberately *not* lineage-resolved:
            // the deck is still bound to the id it was given, and this frame
            // has to find that card. The durable row keyed itself to the head.
            "tug_session_id": session,
            "receipt_id": receipt_id,
            "summary": summary,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_receipt serializes"),
        ));
    }

    /// The card's own session id and supervisor entry for a **segment** id,
    /// walked the way [P01]'s identity model requires.
    ///
    /// The map is keyed by the card's own tug session id, which never moves; a
    /// rotation mints a segment and the ledger's answers are in *that*
    /// vocabulary. The direct key first — before any rotation the two are one
    /// string — then `claude_session_id`, which is the entry's own record of
    /// which segment it is currently running. The same walk
    /// `arc_runner::card_session_for_segment` makes, for the same reason.
    ///
    /// `try_lock` on the entries: this holds the map lock, so an entry another
    /// task is mid-write on is skipped rather than inverted on.
    pub async fn card_entry_for_segment(
        &self,
        segment: &str,
    ) -> Option<(TugSessionId, Arc<Mutex<LedgerEntry>>)> {
        let map = self.ledger.lock().await;
        let direct = TugSessionId::new(segment.to_string());
        if let Some(entry) = map.get(&direct) {
            return Some((direct, Arc::clone(entry)));
        }
        for (key, entry) in map.iter() {
            let Ok(guard) = entry.try_lock() else {
                continue;
            };
            if guard.claude_session_id.as_deref() == Some(segment) {
                drop(guard);
                return Some((key.clone(), Arc::clone(entry)));
            }
        }
        None
    }

    /// Record that the turn now in flight on `segment`'s card has closed a
    /// step. Answers whether an entry was found to record it against.
    pub async fn mark_step_closed_this_turn(&self, segment: &str, step: u32) -> bool {
        let Some((_, entry)) = self.card_entry_for_segment(segment).await else {
            return false;
        };
        entry.lock().await.step_closed_this_turn = Some(step);
        true
    }

    /// End every background job `segment`'s card holds open, because the step
    /// they belonged to has just closed ([B01]). Answers the keys that were
    /// open, so the verb that closed the step can name them in its receipt.
    ///
    /// **The step boundary is a work boundary.** A job launched inside a step
    /// belongs to that step, and a step that has closed has nothing left for
    /// it to report to: the next step is a different turn, the wheel is what
    /// opens it, and until the job reports the session reads busy and the
    /// wheel waits. Before this the wait ran to the reaper's thirty-minute
    /// horizon, and the arc read as stalled long before it read as moving.
    ///
    /// The set is dropped wholesale rather than stopped-and-awaited, and the
    /// asymmetry is deliberate: a `stop_task` is best-effort, and a job whose
    /// step is over must not be able to hold the arc open by declining to
    /// answer. So the ledger stops believing the job first and asks tugcode to
    /// end it second — the order
    /// [`AgentSupervisor::apply_stop_all_work_done`] settles the stop path in,
    /// for the same reason.
    ///
    /// A `launch:` key is provisional and carries no `task_id`, so there is
    /// nothing to stop; it is dropped and named by its key in the log line.
    pub async fn end_step_jobs(&self, segment: &str) -> Vec<String> {
        let Some((card, entry)) = self.card_entry_for_segment(segment).await else {
            return Vec::new();
        };
        // The guard is dropped before anything is awaited (Risk R01): the
        // frames dispatched below travel the same routing a release edge does,
        // and holding an entry lock across that await is what wedges it.
        let (keys, quiet) = {
            let mut guard = entry.lock().await;
            let keys: Vec<String> = std::mem::take(&mut guard.open_jobs).into_keys().collect();
            // The transition into quiet, notified from inside the guard that
            // wrote it so a waiter cannot observe a half-applied edge ([P05]).
            let quiet = guard.is_quiet();
            if quiet {
                guard.quiesced.notify_waiters();
            }
            (keys, quiet)
        };
        let confirmed: Vec<&String> = keys
            .iter()
            .filter(|key| !key.starts_with(LAUNCH_KEY_PREFIX))
            .collect();
        // Logged even when nothing was open, because the line says the edge
        // was reached — which is the question asked of it when an arc hangs.
        tracing::info!(
            target: "dev::ledger",
            event = "job_ended_at_step_close",
            session_id = %segment,
            jobs = ?keys,
            stopped = confirmed.len(),
            "a closed step ends its jobs",
        );
        for key in &confirmed {
            self.dispatch_one(code_input_frame(&serde_json::json!({
                "type": "stop_task",
                "tug_session_id": card.as_str(),
                "task_id": key,
            })))
            .await;
        }
        // The last job leaving with the turn already ended is the moment the
        // session goes quiet, and nothing else will speak for it — so the work
        // parked behind it is released on the same channels the job edge uses.
        //
        // **Named by the card, as every other release site names it.** A
        // `segment` is a rotation's row; the wheel's parked-rotation map and
        // the supervisor's own entries are keyed by the card's address, so a
        // segment sent here would be a wake nothing could match.
        if quiet {
            if let Some(tx) = self.turn_complete_tx.get() {
                let _ = tx.try_send(card.as_str().to_string());
            }
            if let Some(tx) = self.arc_tick_tx.get() {
                let _ = tx.try_send(card.as_str().to_string());
            }
            self.registry.changeset_all_bump().notify_one();
        }
        keys
    }

    /// The step this turn has already closed on `segment`'s card, if any — the
    /// PreToolUse gate's one question.
    pub async fn step_closed_this_turn(&self, segment: &str) -> Option<u32> {
        let (_, entry) = self.card_entry_for_segment(segment).await?;
        entry.lock().await.step_closed_this_turn
    }

    /// Announce one arc ledger gesture on `session`'s card as durable ink.
    ///
    /// The same two halves `record_arc_receipt` does, for the same reason: a
    /// gesture made by a short-lived CLI process has no initiating client, so
    /// the durable row (which a relaunch replays like any other ink, keyed to
    /// the **line** so a rotation carries it) and the live `arc_note` frame
    /// are both explicit. `command` is the verb as it was typed and `note` the
    /// one sentence, which is what makes the row read as the `$` ink of
    /// somebody having run it — because that is what happened.
    ///
    /// The user watches a run from the card, and before this the only sign of
    /// progression was a stuck indicator (W8 Task 3).
    ///
    /// `segment` is what the verb resolved and what the ledger answers in; the
    /// frame goes out under the **card's** id, because the card's address never
    /// moves and the deck is bound to it. A rotation would otherwise announce
    /// to an id no card in the deck wears — Part IX item 12's shape, one layer
    /// over.
    pub async fn record_arc_note(
        &self,
        segment: &str,
        project_dir: &str,
        command: &str,
        note: &str,
    ) {
        let session = match self.card_entry_for_segment(segment).await {
            Some((card, _)) => card.as_str().to_string(),
            None => segment.to_string(),
        };
        let receipt_id = Self::record_landing_receipt(
            self.shell_ledger.as_ref(),
            self.session_ledger.as_ref(),
            Some(&session),
            command,
            note,
            project_dir,
        );
        let body = serde_json::json!({
            "action": "arc_note",
            "project_dir": project_dir,
            "tug_session_id": session,
            "command": command,
            "note": note,
            "receipt_id": receipt_id,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_note serializes"),
        ));
    }

    /// Attach the shell-exchange ledger (the read side of the
    /// `list_shell_exchanges` CONTROL op). Called once in `main.rs` before the
    /// supervisor is shared.
    pub fn set_shell_ledger(&mut self, ledger: Arc<crate::shell_ledger::ShellLedger>) {
        self.shell_ledger = Some(ledger);
    }

    /// Attach the refs ledger (the read side of the `list_refs` CONTROL op).
    /// Called once in `main.rs` before the supervisor is shared.
    pub fn set_refs_ledger(&mut self, ledger: Arc<crate::refs_ledger::RefsLedger>) {
        self.refs_ledger = Some(ledger);
    }

    /// Attach the prompt-history ledger (the write side of a directory
    /// change's prompt lineage). Called once in `main.rs` before the
    /// supervisor is shared.
    pub fn set_prompt_ledger(&mut self, ledger: Arc<crate::prompt_ledger::PromptLedger>) {
        self.prompt_ledger = Some(ledger);
    }

    /// Record a moved session's prompt lineage: the chain the session it moved
    /// away from reads through, followed by the new id.
    ///
    /// Runs before `spawn_session_ok`, because the ack is what re-binds the
    /// card and its composer asks for history under the new id at once. The
    /// fork edge that would otherwise carry the read is written by the bridge
    /// when tugcode announces the segment, which is after that first ask, and
    /// the deck never asks twice. Recorded whether or not the parent held a
    /// conversation: the typed history belongs to the card, not to claude's
    /// transcript. Each move records the full chain, so a second move before
    /// any turn still reaches the first move's parent. A failed write is
    /// logged and the move proceeds — recall is degraded, never the move.
    fn record_relocated_prompt_lineage(&self, from: &TugSessionId, to: &TugSessionId) {
        let Some(prompts) = self.prompt_ledger.as_deref() else {
            return;
        };
        let lineage = crate::prompt_lineage::LineageSource::new(self.session_ledger.clone());
        let mut chain = crate::prompt_lineage::chain_for(&lineage, prompts, from.as_str());
        chain.retain(|id| id != to.as_str());
        chain.push(to.as_str().to_owned());
        if let Err(err) = prompts.record_chain(&chain, crate::session_ledger::now_millis()) {
            warn!(
                relocate_from = %from,
                tug_session_id = %to,
                error = %err,
                "spawn_session: cannot record the moved session's prompt lineage"
            );
        }
    }

    /// Re-live any seat a demote closed while its bridge went on running.
    ///
    /// A ledger row is a record of a subprocess, and the supervisor is the one
    /// thing that knows whether that subprocess is running: its entry is
    /// `Live`. So a `Live` entry whose `claude_session_id` names a segment
    /// reading `closed, demoted = 1` is a row disagreeing with the process it
    /// describes, and the disagreement belongs to the demote rather than to
    /// the session.
    ///
    /// This is the revive that does not need a turn to happen. The
    /// turn-boundary revive in `record_turn` and `record_user_prompt` stays
    /// exactly as it is, but a stage sitting between turns has no turn to
    /// wait for, and everything that reads bound-ness reads it off live rows
    /// — `bound_session_by_arc` filters to them, so a demoted seat silently
    /// drops its arc out of the sweep and nothing prompts anybody again.
    ///
    /// Returns how many seats it re-lived. Best-effort throughout: a failed
    /// revive warns, and the next tick asks again.
    pub async fn relive_demoted_seats(&self) -> usize {
        let Some(ledger) = self.session_ledger.as_ref() else {
            return 0;
        };
        // Snapshot the seats before reviving any of them: the revive takes the
        // ledger's own mutex and notifies its watchers, and holding the entries
        // map across that is a lock order this file does not keep.
        let seats: Vec<String> = {
            let map = self.ledger.lock().await;
            map.values()
                .filter_map(|entry| {
                    // `try_lock` for the reason `card_session_for_segment`
                    // gives: an entry another task is mid-write on is skipped
                    // this tick and found on the next.
                    let entry = entry.try_lock().ok()?;
                    if entry.spawn_state != SpawnState::Live {
                        return None;
                    }
                    entry.claude_session_id.clone()
                })
                .collect()
        };
        let now = crate::session_ledger::now_millis();
        let mut relived = 0usize;
        for seat in seats {
            match ledger.revive_on_activity(&seat, now) {
                Ok(true) => {
                    relived += 1;
                    tracing::info!(
                        target: "dev::session-lifecycle",
                        event = "ledger.revive_on_activity",
                        session_id = %seat,
                        reason = "liveness-reconcile",
                    );
                }
                Ok(false) => {}
                Err(err) => {
                    warn!(error = %err, session_id = %seat, "liveness reconcile revive failed");
                }
            }
        }
        relived
    }

    /// Attach the shared digester (the read side of the `list_digest_lines`
    /// CONTROL op). Called once in `main.rs` before the supervisor is shared.
    pub fn set_digester(&mut self, digester: crate::feeds::session_digest::SharedDigester) {
        self.digester = Some(digester);
    }

    /// Attach the changeset scribe (the maintained-draft engine's backend).
    /// Called once in `main.rs` before the supervisor is shared.
    pub fn set_scribe(&mut self, scribe: ScribeContext) {
        self.scribe = Some(scribe);
    }

    /// Store the aggregate CHANGESET_ALL watch receiver for the on-demand draft
    /// path (#draft-engine, [P03]). No background loop is spawned — generation
    /// runs only on an explicit `changeset_draft_request`, off the latest frame
    /// this receiver holds. `do_changeset_draft_request` reads it back and
    /// resolves `tug_session_id → claude_session_id` from this supervisor's
    /// in-memory ledger entries at request time.
    pub fn start_draft_engine(
        self: &Arc<Self>,
        watch_rx: watch::Receiver<Frame>,
        _cancel: CancellationToken,
    ) {
        let _ = self.changeset_watch.set(watch_rx);
    }

    /// The session id durable ink for `tug_session_id` is keyed under: its
    /// lineage head, or the id itself when nothing has forked it (or no
    /// session ledger is configured).
    ///
    /// Durable ink is keyed by **line** ([P09]), so a read issued under any
    /// segment's id — including a superseded one the deck is still bound to —
    /// finds the whole conversation's rows. A session this ledger has never
    /// seen keys under its own id, which is the only key its own writer used.
    fn resolve_ink_line(&self, tug_session_id: &str) -> String {
        match self.session_ledger.as_ref() {
            Some(sessions) => sessions
                .line_of(tug_session_id)
                .unwrap_or_else(|| tug_session_id.to_string()),
            None => tug_session_id.to_string(),
        }
    }

    /// CODE_INPUT dispatcher task. Consumes CODE_INPUT frames from a single
    /// mpsc receiver (fed by the router in Step 8), parses `tug_session_id`,
    /// and routes each frame based on the ledger entry's `SpawnState`.
    pub async fn dispatcher_task(self: Arc<Self>, mut rx: mpsc::Receiver<Frame>) {
        while let Some(frame) = rx.recv().await {
            self.dispatch_one(frame).await;
        }
    }

    /// Dispatch a single CODE_INPUT frame. Extracted from `dispatcher_task` so
    /// tests can exercise the routing logic without spinning up a task + mpsc.
    pub async fn dispatch_one(&self, mut frame: Frame) {
        // Extract `tug_session_id` from the payload.
        let tug_session_id = match parse_tug_session_id(&frame.payload) {
            Some(id) => TugSessionId::new(id),
            None => {
                warn!("dispatcher: CODE_INPUT frame missing tug_session_id, dropping");
                return;
            }
        };

        // Inspect the payload's top-level fields once; the user_message
        // intercept below reads `type`, `text`, and `attachments` from
        // the same parse. A malformed payload yields `None`, which the
        // intercept treats as "skip the user_message branch and fall
        // through to the existing routing" — same as a payload whose
        // `type` is not `user_message`.
        let inspected = super::payload_inspector::InspectedPayload::from_slice(&frame.payload);

        // Look up the ledger entry.
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(&tug_session_id).cloned()
        };

        let Some(entry_arc) = entry_arc else {
            // No intent record — the client must `spawn_session` via CONTROL
            // before sending CODE_INPUT.
            let _ = self
                .control_tx
                .send(build_session_unknown_frame(&tug_session_id));
            return;
        };

        // ── user_message intercept ──────────────────────────────────────────
        //
        // For inbound `user_message` frames: mint an internal `journal_id`
        // and persist a pending row to the submission journal, then
        // forward the frame — **unchanged** unless the line holds landings
        // its model has not been told, in which case exactly one trailing
        // `tug:landings` text block is appended *before* the journal write.
        // The journal text then carries the block too, which is the point:
        // tugcode decides whether a pending row already reached the JSONL by
        // comparing the row's text to the JSONL record's concatenated text
        // blocks, and the two match only if both hold the block. A slash
        // command carries no block — an extra block could change how claude
        // parses it — and the landings wait for the next ordinary message.
        // Order is load-bearing:
        // row-persisted-before-forwarded. A failure before the forward
        // drops the inbound frame (the supervisor emits a CONTROL error);
        // a forwarded frame with no row is structurally impossible because
        // the forward only happens after `Ok` from `insert_pending_turn`.
        // The journal id is internal to tugcast — not surfaced on the
        // wire, never seen by tugcode (the merger reconciles by
        // session-scoped FIFO, not by id). Other CODE_INPUT types —
        // `tool_approval`, `interrupt`, `permission_mode`, `model_change`,
        // `session_command`, `stop_task`, `request_replay` — are forwarded
        // unchanged; `model_change` and `permission_mode` are read on the way
        // past and stamped onto the entry, which alters the entry and never
        // the frame. See [DM08] / [Step 5.3](#step-5-3) in the
        // mid-turn-replay plan.
        //
        // `told` remembers the line and the newest landing row read, so the
        // watermark can advance once the frame is accepted — and only then.
        let mut told: Option<(String, i64)> = None;
        if let Some("user_message") = inspected.as_ref().and_then(|i| i.msg_type()) {
            let inspected = inspected.as_ref().expect("checked Some above");
            let user_text = inspected.text.clone().unwrap_or_default();
            let user_attachments = inspected.attachments.clone().unwrap_or_default();
            let mut journal_text = user_text.clone();
            if let Some(shell) = self.shell_ledger.as_ref()
                && !user_text.trim_start().starts_with('/')
                && inspected.content.is_some()
            {
                let line = self.resolve_ink_line(tug_session_id.as_str());
                let rows = shell.untold_landings(&line).unwrap_or_else(|err| {
                    warn!(%err, line = %line, "dispatcher: could not read untold landings");
                    Vec::new()
                });
                if let Some(block) = super::changeset::build_landings_block(&rows)
                    && let Some(bytes) = append_text_block(&frame.payload, &block)
                {
                    frame = Frame::new(FeedId::CODE_INPUT, bytes);
                    journal_text.push_str(&block);
                }
                // Every row read is told, listed or not, so a row that formats
                // to nothing is not read again forever.
                if let Some(last) = rows.last() {
                    told = Some((line, last.id));
                }
            }
            let journal_id = uuid::Uuid::new_v4().to_string();
            let now = crate::session_ledger::now_millis();
            match self.sessions_recorder.insert_pending_turn(
                tug_session_id.as_str(),
                &journal_id,
                &journal_text,
                &user_attachments,
                now,
            ) {
                Ok(()) => {
                    // A turn is opening: from here until the merger sees the
                    // closing `turn_complete` / `turn_cancelled`, the activity
                    // sampler attributes this session's OS work.
                    //
                    // And it is an *asked* turn ([P02]) — the one kind the arc
                    // runner's quiet-turn horizon may count against a stage.
                    {
                        let mut entry = entry_arc.lock().await;
                        entry.turn_active = true;
                        entry.turn_opener = Some(TurnOpener::Prompt);
                        // The turn's liveness clock starts here ([B02]).
                        entry.touch_turn();
                    }
                    // A door prompt binds with the keystroke, so the card
                    // reads `ARC` before the door's first tool call rather
                    // than after its last one. Anything else is untouched.
                    if let Some(arc) = arc_door_target(&user_text) {
                        self.bind_arc_at_the_door(&tug_session_id, &entry_arc, arc)
                            .await;
                    }
                }
                Err(err) => {
                    warn!(
                        error = %err,
                        tug_session_id = %tug_session_id,
                        "dispatcher: insert_pending_turn failed; dropping user_message",
                    );
                    let _ = self
                        .control_tx
                        .send(build_ledger_failure_frame(&tug_session_id));
                    return;
                }
            }
        }

        // ── the deck's own model selector ───────────────────────────────────
        //
        // Every frame a WebSocket client sends passes through here, and only
        // through here — the arc's runner puts its frames straight on
        // `input_tx`. So this is the one place that can tell the deck's choice
        // of model from the arc's, which is exactly the distinction [P15]'s
        // restore needs: when the arc ends, the card goes back to the last
        // model its user picked, not the one the last stage ran on.
        if let Some("model_change") = inspected.as_ref().and_then(|i| i.msg_type()) {
            if let Some(model) = parse_model_selector(&frame.payload) {
                // A *change*, not a repaint: writing a note when the selector
                // already equals `deck_model` would put a line in the log for
                // a no-op.
                let changed = {
                    let mut entry = entry_arc.lock().await;
                    let changed = entry.deck_model.as_deref() != Some(model.as_str());
                    entry.deck_model = Some(model.clone());
                    changed
                };
                // A switch mid-stage is real and belongs in the record, so it
                // goes where a switch belongs: the arc log, which `tugtool
                // arc record` prints and the Arcs card reads.
                //
                // The transcript's stage divider is deliberately **not**
                // touched, and `stage_model` on the session row is not
                // rewritten. The divider's subject is what the stage was
                // *seated* on, which stays true forever. Live it is one-shot
                // ink minted from the rotation's `session_segment` frame; on restore it is
                // composed from `stage_provenance`. Moving one and not the
                // other would make the live divider and the restored one
                // disagree about the same boundary — a new resting lie in
                // place of the old one — and moving the live one means editing
                // durable ink, which this codebase does not do.
                if changed {
                    self.note_model_switch(tug_session_id.as_str(), &model)
                        .await;
                }
            }
        }

        // ── permission_mode stamp ───────────────────────────────────────────
        //
        // The frame is the path a live mode change takes: it reaches the
        // running tugcode and flips it, and the forward below is unchanged by
        // this. What it also does is move the entry, because
        // `entry.permission_mode` is what every respawn — a wheel rotation, an
        // arc Resume, a crash-loop respawn — hands the next child as
        // `--permission-mode`. An entry stamped only at birth means the
        // respawn silently undoes the switch the user made, which is the one
        // thing a direct action must never do.
        if let Some("permission_mode") = inspected.as_ref().and_then(|i| i.msg_type()) {
            if let Some(mode) = parse_permission_mode_selector(&frame.payload) {
                let mut entry = entry_arc.lock().await;
                entry.permission_mode = Some(mode);
            }
        }

        // Decide the routing action under the per-session lock. We extract
        // the decision and release the lock before doing any await-heavy
        // work (mpsc send, broadcast publish, spawn_session_worker).
        //
        // `accepted` is the honest "the frame will reach claude" signal the
        // landing watermark waits on: `Decision::Drop` means both "queued
        // while spawning" and "dropped in a terminal state", so the decision
        // alone cannot say.
        let mut accepted = false;
        let decision: Decision = {
            let mut entry = entry_arc.lock().await;
            match entry.spawn_state {
                SpawnState::Idle => {
                    // This thread owns the Idle → Spawning transition per
                    // [R02]. Transition, queue the frame for the worker,
                    // and tell the caller to spawn.
                    entry.spawn_state.try_transition(SpawnState::Spawning).ok();
                    // Idle-entry invariant: the queue is freshly minted
                    // empty, so push always succeeds. If this ever fails
                    // we've bungled the invariant and the frame would be
                    // silently dropped — log loudly rather than panic.
                    match entry.queue.push(frame) {
                        QueuePush::Ok => accepted = true,
                        QueuePush::Overflow => {
                            tracing::error!(
                                session = %tug_session_id,
                                "BUG: Idle ledger entry had a non-empty queue on first CODE_INPUT"
                            );
                        }
                    }
                    Decision::Spawn
                }
                SpawnState::Spawning => {
                    // Buffer the frame until the worker drains.
                    match entry.queue.push(frame) {
                        QueuePush::Ok => {
                            accepted = true;
                            Decision::Drop
                        }
                        QueuePush::Overflow => Decision::Backpressure,
                    }
                }
                SpawnState::Live => {
                    if let Some(tx) = entry.input_tx.clone() {
                        Decision::Forward(tx, frame)
                    } else {
                        warn!("dispatcher: Live state but no input_tx set");
                        drop(frame);
                        Decision::Drop
                    }
                }
                SpawnState::Errored | SpawnState::Closed => {
                    warn!(
                        state = ?entry.spawn_state,
                        "dispatcher: dropping frame in terminal state"
                    );
                    drop(frame);
                    Decision::Drop
                }
            }
        };

        let decision_label = match &decision {
            Decision::Drop => "drop",
            Decision::Spawn => "spawn",
            Decision::Forward(_, _) => "forward",
            Decision::Backpressure => "backpressure",
        };
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "supervisor.dispatch_decision",
            tug_session_id = %tug_session_id,
            decision = decision_label,
        );
        match decision {
            Decision::Drop => {}
            Decision::Spawn => self.spawn_session_worker(&tug_session_id).await,
            Decision::Forward(tx, frame) => {
                accepted = tx.send(frame).await.is_ok();
            }
            Decision::Backpressure => {
                let _ = self
                    .control_tx
                    .send(build_backpressure_frame(&tug_session_id));
            }
        }
        if accepted
            && let Some((line, through_id)) = told
            && let Some(shell) = self.shell_ledger.as_ref()
            && let Err(err) =
                shell.mark_landings_told(&line, through_id, crate::session_ledger::now_millis())
        {
            // The cost of a lost write is one landing told twice.
            warn!(%err, line = %line, "dispatcher: could not advance the landing watermark");
        }
    }

    /// Open a **provisional** job at a launching `tool_use` the deck would
    /// count as background work ([P04]).
    ///
    /// The latch arms here rather than at the `task_started` that follows,
    /// because the window `open_jobs` exists to cover starts at the launch.
    /// This used to only *record* the id in a side set, leaving the session
    /// readable as quiet between the launch and its confirmation; the
    /// incident's six background completions each lived in that gap.
    ///
    /// Replay-guarded like the fold itself: a `replay_batch`'s historical
    /// launches describe calls whose jobs died with the session that ran them.
    pub(super) async fn record_job_launch(&self, session_id: &TugSessionId, payload: &[u8]) {
        let Some((tool_use_id, kind)) = parse_background_launch(payload) else {
            return;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return;
        };
        let mut entry = entry_arc.lock().await;
        if entry.replay_brackets_open != 0 {
            return;
        }
        entry.open_jobs.insert(
            launch_key(&tool_use_id),
            OpenJob {
                since: std::time::Instant::now(),
                kind: kind.clone(),
            },
        );
        entry.touch_turn();
        tracing::debug!(
            target: "dev::ledger",
            event = "job_launched",
            session_id = %session_id,
            tool_use_id = %tool_use_id,
            kind = kind.as_str(),
            open_jobs = entry.open_jobs.len(),
        );
    }

    /// Register a live Bash call as an [`OpenRun`], so a progress report its
    /// command posts can find the block it belongs to (Spec S05).
    ///
    /// Replay-guarded like every fold here: a replayed call ran under a
    /// session that is gone, and its command is not reporting.
    pub(super) async fn record_run_open(&self, session_id: &TugSessionId, payload: &[u8]) {
        let Some((tool_use_id, run)) = parse_bash_run(payload, crate::session_ledger::now_millis())
        else {
            return;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return;
        };
        let mut entry = entry_arc.lock().await;
        if entry.replay_brackets_open != 0 {
            return;
        }
        entry.open_runs.insert(tool_use_id, run);
        while entry.open_runs.len() > OPEN_RUNS_CAP {
            let oldest = entry
                .open_runs
                .iter()
                .min_by_key(|(_, run)| run.opened_at_ms)
                .map(|(id, _)| id.clone());
            let Some(oldest) = oldest else { break };
            entry.open_runs.remove(&oldest);
        }
    }

    /// A call answered: a foreground run is over. A background run's call
    /// answers at once while its command keeps going, so it stays, and
    /// leaves when its job does.
    pub(super) async fn close_run(&self, session_id: &TugSessionId, payload: &[u8]) {
        let Some(tool_use_id) = parse_tool_result_id(payload) else {
            return;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return;
        };
        let mut entry = entry_arc.lock().await;
        if entry
            .open_runs
            .get(&tool_use_id)
            .is_some_and(|run| !run.background)
        {
            entry.open_runs.remove(&tool_use_id);
        }
    }

    /// Attach a running command's progress report to its block and publish
    /// it on CODE_OUTPUT as a Spec S03 `run_progress` frame.
    ///
    /// Answers `(attached to a block, the call it attached to)`, or `None`
    /// when `segment` has no ledger entry. A report no rule attaches is still
    /// published, with a `null` id, as the card's line: a guessed block would
    /// be worse than an honest card-level one ([P03]).
    pub async fn publish_run_progress(
        &self,
        segment: &str,
        report: RunProgressReport,
    ) -> Option<(bool, Option<String>)> {
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(&TugSessionId::new(segment)).cloned()
        }?;
        let attached = entry_arc
            .lock()
            .await
            .attach_run(report.tool_use_id.as_deref(), &report.needles);
        let payload = run_progress_payload(
            segment,
            attached.as_deref(),
            &report,
            crate::session_ledger::now_millis(),
        );
        self.code_output
            .publish_tagged(Frame::new(FeedId::CODE_OUTPUT, payload));
        Some((attached.is_some(), attached))
    }

    /// Close the provisional job of a launch whose `tool_result` came back
    /// errored, and answer whether that left the session **quiet**.
    ///
    /// A backgrounded call that is denied — by the PreToolUse gate, by a
    /// permission rule, by a validation error — never runs, so the
    /// `task_started` that would re-key its `launch:` entry never arrives, and
    /// neither does any closing edge. Left alone the entry holds the session
    /// busy until a wake or [`JOB_REAP_HORIZON`], which for an arc between
    /// steps is thirty minutes of a wheel that will not turn (the 2026-09-21
    /// `network-resilience` stalls, twice in one run).
    ///
    /// Only the `launch:` key is touched: a launch that *was* confirmed has
    /// been re-keyed onto its `task_id`, so an errored result behind a running
    /// job closes nothing. Replay-guarded like every other job fold.
    pub(super) async fn close_failed_launch(
        &self,
        session_id: &TugSessionId,
        payload: &[u8],
    ) -> bool {
        let Some(tool_use_id) = parse_errored_tool_result(payload) else {
            return false;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return false;
        };
        let mut entry = entry_arc.lock().await;
        if entry.replay_brackets_open != 0 {
            return false;
        }
        if entry.open_jobs.remove(&launch_key(&tool_use_id)).is_none() {
            return false;
        }
        tracing::debug!(
            target: "dev::ledger",
            event = "job_launch_failed",
            session_id = %session_id,
            tool_use_id = %tool_use_id,
            open_jobs = entry.open_jobs.len(),
        );
        let quiet = entry.is_quiet();
        if quiet {
            entry.quiesced.notify_waiters();
        }
        quiet
    }

    /// Refresh an open job's liveness stamp from a `task_progress` heartbeat,
    /// so the reaper can tell silent-but-running work from a job whose
    /// terminal frame the wire never delivered. A tick for a job that is not
    /// open — a foreground subagent's, or one already closed — changes
    /// nothing.
    async fn refresh_job_stamp(&self, session_id: &TugSessionId, payload: &[u8]) {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
            return;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("task_progress") {
            return;
        }
        let Some(task_id) = nonempty_task_id(&value) else {
            return;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return;
        };
        let mut entry = entry_arc.lock().await;
        if let Some(job) = entry.open_jobs.get_mut(&task_id) {
            job.since = std::time::Instant::now();
        }
        // A job reporting in is the turn behind it reporting in too ([B02]).
        entry.touch_turn();
    }

    /// Fold one `task_started` / `task_updated` / `wake_started` frame into the
    /// session's set of open background jobs, and answer whether that left it
    /// **quiet**.
    ///
    /// Quiet is the whole reason this exists: a turn ends when the model stops
    /// speaking, and the test sweep it backgrounded goes on running. Between
    /// those two moments the session looks idle and is not, and an arc offered
    /// for joining in that window is work nobody has finished checking.
    ///
    /// Guarded on the replay bracket for the same reason the turn edge is: a
    /// `replay_batch` carries historical `task_started` frames whose jobs died
    /// with the session that ran them, and folding those in would open jobs
    /// that can never close.
    ///
    /// Returns `false` for every frame that is not a job edge, for a session
    /// with no ledger entry, and for an edge that leaves work still running —
    /// so the caller's release path fires on exactly the transition into quiet.
    pub(super) async fn apply_job_edge(&self, session_id: &TugSessionId, payload: &[u8]) -> bool {
        let Some(edge) = parse_job_edge(payload) else {
            return false;
        };
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return false;
        };
        let mut entry = entry_arc.lock().await;
        if entry.replay_brackets_open != 0 {
            return false;
        }
        match edge {
            JobEdge::Opened(task) => {
                // Gated on the launching call ([Q01], resolved by the Step 1
                // capture): the frame carries no backgrounded discriminant, so
                // a provisional `launch:` entry is the only honest evidence.
                // An unmatched `task_started` opens nothing — the launch
                // cannot have gone unobserved, because the merger consumes
                // each session's whole stream from registration and a
                // background job cannot outlive the claude process that
                // launched it, so every live `task_started` follows its
                // `tool_use` on the same stream; the replayed kind never
                // reaches this point (the bracket guard above). What an
                // unmatched frame actually is, is the foreground shape this
                // gate exists to refuse.
                //
                // The match is a **re-key**, not an open: the provisional
                // entry's stamp moves onto the `task_id`, so the reaper
                // clocks the job from the launch it actually began at rather
                // than from its confirmation.
                let launch_id = parse_task_started_launch_id(payload);
                let launched = launch_id
                    .as_ref()
                    .and_then(|id| entry.open_jobs.remove(&launch_key(id)));
                let Some(job) = launched else {
                    tracing::debug!(
                        target: "dev::ledger",
                        event = "job_open_rejected",
                        session_id = %session_id,
                        task_id = %task,
                        "task_started with no observed background launch — \
                         foreground work, not a job to track",
                    );
                    return false;
                };
                entry.open_jobs.insert(task.clone(), job);
                // A background Bash run's progress reports stay attachable
                // for as long as this job lives, under its new key.
                if let Some(run) = launch_id.and_then(|id| entry.open_runs.get_mut(&id)) {
                    run.task_id = Some(task.clone());
                }
                tracing::debug!(
                    target: "dev::ledger",
                    event = "job_opened",
                    session_id = %session_id,
                    task_id = %task,
                    frame = frame_family(payload),
                    open_jobs = entry.open_jobs.len(),
                );
            }
            JobEdge::Closed(task) => {
                let was_open = entry.open_jobs.remove(&task).is_some();
                // A wake means the model is speaking again, so the gap every
                // provisional entry was holding open is over — including the
                // scheduler's own re-init wake, which names no job at all.
                // Without this a launch whose `task_started` never arrived
                // would sit until the reaper, and the session would read busy
                // through turns it was plainly working.
                let mut provisional_closed = 0usize;
                if frame_family(payload) == "wake_started" {
                    entry.open_jobs.retain(|key, _| {
                        let provisional = key.starts_with(LAUNCH_KEY_PREFIX);
                        if provisional {
                            provisional_closed += 1;
                        }
                        !provisional
                    });
                }
                tracing::debug!(
                    target: "dev::ledger",
                    event = "job_closed",
                    session_id = %session_id,
                    task_id = %task,
                    frame = frame_family(payload),
                    was_open,
                    provisional_closed,
                    open_jobs = entry.open_jobs.len(),
                );
            }
        }
        // The transition into quiet, notified from inside the guard that
        // wrote it so a waiter cannot observe a half-applied edge ([P05]).
        let quiet = entry.is_quiet();
        if quiet {
            entry.quiesced.notify_waiters();
        }
        quiet
    }

    /// Fold tugcode's answer to a `stop_all_work` ([P12]): the session's jobs
    /// are closed wholesale, its turn flag cleared, and the quiet edge
    /// notified.
    ///
    /// The claude those jobs ran under is gone and the process group they ran
    /// *in* has been swept, so the work is over — and no per-task closing edge
    /// can ever say so, because the process that would have sent one is dead
    /// and the respawn beside it has never heard of those ids. Reading the
    /// jobs as open afterwards would be the ledger disbelieving an act it
    /// asked for.
    ///
    /// This is the one writer for the half of `is_quiet` nothing else could
    /// write on this path. Without it the stop's wait cannot converge over an
    /// open job: [`LedgerEntry::reap_stuck_jobs`]' horizon is thirty minutes,
    /// which is no fallback for a press, so every such stop would run to its
    /// ceiling and report a stop that did happen as one that did not.
    ///
    /// It introduces no new notion of finished — `is_quiet` is untouched — and
    /// it is the only one of the three notify sites that can fire with several
    /// jobs open at once.
    pub(super) async fn apply_stop_all_work_done(&self, session_id: &TugSessionId) {
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else {
            return;
        };
        let mut entry = entry_arc.lock().await;
        let closed = entry.open_jobs.len();
        entry.open_jobs.clear();
        entry.turn_active = false;
        entry.quiesced.notify_waiters();
        drop(entry);
        tracing::info!(
            target: "dev::ledger",
            event = "stop_all_work_done",
            session_id = %session_id,
            jobs_closed = closed,
            "the teardown reaped the group the jobs ran in, so the session is quiet",
        );
    }

    /// Apply the per-frame journal intercept the merger runs on every
    /// outbound CODE_OUTPUT frame, **after** the wire-side broadcast has
    /// fired. Narrowed in [Step 5.3](#step-5-3) to a session-scoped FIFO
    /// mark-seen: every `turn_complete` / `turn_cancelled` frame deletes
    /// the oldest pending row in the session's journal. The frame is
    /// forwarded unchanged — this intercept does not read or write any
    /// payload field except the top-level `type` discriminator.
    ///
    /// Branches on the payload's top-level `type`:
    ///
    /// - `turn_complete` or `turn_cancelled` — call
    ///   [`SessionsRecorder::delete_oldest_pending_for_session`]. On
    ///   `Ok(Some)`, an info trace; on `Ok(None)` a warn
    ///   (`turn_complete_no_pending_journal_row` — claude responded for
    ///   a turn the journal didn't see, e.g. resume-of-an-existing-
    ///   conversation where the new tugcode picks up mid-stream); on
    ///   `Err`, a `warn!` (the frame has already been forwarded; the
    ///   wire is the source of truth, the journal lagging by one update
    ///   is telemetry).
    /// - any other type — no-op.
    ///
    /// `record_turn` (the existing trait method that bumps
    /// `sessions.turn_count`) continues to fire from `agent_bridge.rs`
    /// on the same `turn_complete` event — this intercept is additive
    /// and the two writes hit different tables.
    fn apply_outbound_turn_intercept(&self, session_id: &TugSessionId, frame: &Frame) {
        let Some(inspected) =
            super::payload_inspector::InspectedPayload::from_slice(&frame.payload)
        else {
            return;
        };
        match inspected.msg_type() {
            Some("turn_complete") | Some("turn_cancelled") => {
                let kind = inspected.msg_type().unwrap_or("");
                match self
                    .sessions_recorder
                    .delete_oldest_pending_for_session(session_id.as_str())
                {
                    Ok(Some(row)) => {
                        tracing::debug!(
                            target: "dev::ledger",
                            event = "merger.journal_row_deleted",
                            session_id = %session_id,
                            kind,
                            journal_id = %row.journal_id,
                        );
                    }
                    Ok(None) => {
                        warn!(
                            target: "dev::ledger",
                            event = "turn_complete_no_pending_journal_row",
                            session_id = %session_id,
                            kind,
                            "merger: {kind} for a session whose journal has no pending rows; \
                             frame forwarded unchanged",
                        );
                    }
                    Err(err) => {
                        warn!(
                            error = %err,
                            session_id = %session_id,
                            kind,
                            "merger: delete_oldest_pending_for_session failed (frame already forwarded)",
                        );
                    }
                }
            }
            _ => {}
        }
    }

    /// Per-bridge merger task. Consumes registrations from
    /// `merger_register_rx` and fans in each per-session output mpsc into
    /// the shared CODE_OUTPUT broadcast, the SESSION_SIDEBAND broadcast
    /// ([D14]), and `LedgerEntry::latest_metadata` (per-session). Runs until
    /// `cancel` is fired OR the register channel closes AND every
    /// per-session stream has drained.
    pub async fn merger_task(
        self: Arc<Self>,
        mut register_rx: mpsc::Receiver<MergerRegistration>,
        cancel: CancellationToken,
    ) {
        use tokio_stream::StreamMap;
        let mut streams: StreamMap<TugSessionId, ReceiverStream<Frame>> = StreamMap::new();
        // Once `register_rx` yields `None` (all senders dropped), we disable
        // that select arm so it doesn't spin-return on every iteration. If
        // all per-session streams have also drained by that point the task
        // exits cleanly; otherwise it keeps servicing in-flight streams
        // until they close.
        let mut register_closed = false;
        loop {
            if register_closed && streams.is_empty() {
                return;
            }
            tokio::select! {
                _ = cancel.cancelled() => return,
                maybe_register = register_rx.recv(), if !register_closed => {
                    match maybe_register {
                        Some((id, rx)) => {
                            streams.insert(id, ReceiverStream::new(rx));
                        }
                        None => {
                            // Register side dropped — disable the arm and
                            // fall through. Existing streams continue to
                            // drain; the top-of-loop guard exits once they
                            // are all gone.
                            register_closed = true;
                        }
                    }
                }
                maybe_frame = streams.next(), if !streams.is_empty() => {
                    let Some((id, frame)) = maybe_frame else { continue };
                    // Divert `activity_delta` frames off CODE_OUTPUT onto the
                    // ACTIVITY feed ([P13], [P15]). The payload already carries
                    // its `tug_session_id` (spliced in `relay_session_io`), so
                    // we only re-tag `FeedId::ACTIVITY` — mirroring the
                    // SESSION_SIDEBAND rewrap below, but a DIVERT not a copy:
                    // the sample must never ride the CODE_OUTPUT transcript
                    // stream or its shared ReplayBuffer (a replayed activity
                    // sample would strobe the deck's live meter). Skipping the
                    // journal gate is correct too — activity frames are not
                    // turn-completion markers.
                    if is_activity_delta(&frame.payload) {
                        self.activity
                            .publish_tagged(Frame::new(FeedId::ACTIVITY, frame.payload));
                        continue;
                    }
                    // Forward to shared CODE_OUTPUT broadcast (feeds the
                    // shared router-level replay ring per [D06], unchanged).
                    // The inbound frame is already tagged `CODE_OUTPUT` by
                    // `relay_session_io` so this send passes through
                    // unchanged.
                    self.code_output.publish_tagged(frame.clone());
                    // Turn-boundary tracking for the activity sampler: the
                    // closing `turn_complete` / `turn_cancelled` ends OS-work
                    // attribution; `wake_started` opens a wake turn (which has
                    // no inbound `user_message` to open it). Clearing is gated
                    // on no replay bracket being open — a `replay_batch`'s
                    // embedded historical `turn_complete` text matches the
                    // needle but must not end a live turn (`replay_started`
                    // has already incremented the bracket counter by the time
                    // the batch flows through here).
                    // The session's resident context window, which the arc
                    // reads at a step boundary to decide a compaction or a
                    // rotation. Both frames that carry usage write it: a
                    // `streaming_usage` keeps it current inside the turn, and
                    // the turn-final `cost_update` is the authoritative last
                    // write — and a `compact_boundary` retires it, because a
                    // compaction leaves the held number measuring a context
                    // that is gone.
                    if let Some(update) = context_window_update(&frame.payload) {
                        let entry_arc = {
                            let ledger = self.ledger.lock().await;
                            ledger.get(&id).cloned()
                        };
                        if let Some(entry_arc) = entry_arc {
                            let mut entry = entry_arc.lock().await;
                            match update {
                                ContextWindowUpdate::Measured(window) => {
                                    entry.context_window_tokens = Some(window)
                                }
                                // A replayed boundary is history: it says a
                                // compaction happened once, not that this
                                // session's context just came down. Guarded
                                // for the same reason the turn edge above is.
                                ContextWindowUpdate::Retired => {
                                    if entry.replay_brackets_open == 0 {
                                        entry.context_window_tokens = None;
                                    }
                                }
                            }
                        }
                    }
                    // claude's whole background roster. Logged rather than
                    // folded: the supervisor's `open_jobs` is built from
                    // edges, and this frame is the independent statement of
                    // the same fact — so a session stuck busy, or gone quiet
                    // early, is answerable from one log rather than from a
                    // reproduction.
                    if is_background_tasks_changed(&frame.payload) {
                        tracing::debug!(
                            target: "dev::ledger",
                            event = "background_tasks_changed",
                            session_id = %id,
                            payload_len = frame.payload.len(),
                        );
                    }
                    // A background job opening or closing. Tracked beside the
                    // turn flag because the two together are what "finished"
                    // means: a turn that ends with a test sweep still running
                    // has not finished anything yet. Guarded on the replay
                    // bracket for the same reason the turn edge is — a
                    // `replay_batch` carries historical `task_started` frames
                    // whose jobs died with the session that ran them.
                    if is_task_edge(&frame.payload) {
                        // The last job reporting with no wake behind it — a
                        // `Monitor` timeout ends that way — is the moment the
                        // session goes quiet, and nothing else will speak for
                        // it. So the work parked behind it is released on the
                        // same channels the turn edge uses.
                        if self.apply_job_edge(&id, &frame.payload).await {
                            if let Some(tx) = self.turn_complete_tx.get() {
                                let _ = tx.try_send(id.to_string());
                            }
                            if let Some(tx) = self.arc_tick_tx.get() {
                                let _ = tx.try_send(id.to_string());
                            }
                            self.registry.changeset_all_bump().notify_one();
                        }
                    }
                    // A launching `tool_use` the deck would count as
                    // background work — recorded so the `task_started` it
                    // produces can pass the gate in `apply_job_edge`. Replay
                    // is guarded inside: a historical launch must not arm the
                    // gate for a live frame.
                    if is_tool_use(&frame.payload) {
                        self.record_job_launch(&id, &frame.payload).await;
                        self.record_run_open(&id, &frame.payload).await;
                    }
                    // The launch that never ran. A backgrounded call the
                    // PreToolUse gate denies answers with an errored
                    // `tool_result` and nothing else, so this is the only
                    // frame that can close the provisional job it opened.
                    // Every answered call also closes its foreground run.
                    if is_tool_result(&frame.payload) {
                        self.close_run(&id, &frame.payload).await;
                        if self.close_failed_launch(&id, &frame.payload).await {
                            if let Some(tx) = self.turn_complete_tx.get() {
                                let _ = tx.try_send(id.to_string());
                            }
                            if let Some(tx) = self.arc_tick_tx.get() {
                                let _ = tx.try_send(id.to_string());
                            }
                            self.registry.changeset_all_bump().notify_one();
                        }
                    }
                    // A background agent's heartbeat — not a job edge, but it
                    // proves the job is alive, which is what keeps the reaper
                    // off genuinely long-running work.
                    if is_task_progress(&frame.payload) {
                        self.refresh_job_stamp(&id, &frame.payload).await;
                    }
                    if is_stop_all_work_done(&frame.payload) {
                        self.apply_stop_all_work_done(&id).await;
                    }
                    if is_turn_end(&frame.payload) || is_wake_started(&frame.payload) {
                        let entry_arc = {
                            let ledger = self.ledger.lock().await;
                            ledger.get(&id).cloned()
                        };
                        if let Some(entry_arc) = entry_arc {
                            let mut entry = entry_arc.lock().await;
                            if is_wake_started(&frame.payload) {
                                // Symmetric with the turn-end branch below
                                // ([B01]). A replayed `wake_started` describes
                                // a turn that ended with the session that ran
                                // it, and its own replayed end is discarded by
                                // that branch's guard — so latching here would
                                // leave the entry busy with no turn left to end
                                // it, which is the wedge the incident saw.
                                if entry.replay_brackets_open == 0 {
                                    entry.turn_active = true;
                                    // The harness opened this one, not the
                                    // stage's asker ([P02]).
                                    entry.turn_opener = Some(TurnOpener::Wake);
                                    entry.touch_turn();
                                }
                            } else if entry.replay_brackets_open == 0 {
                                entry.turn_active = false;
                                entry.turns_ended += 1;
                                // A foreground call cannot outlive its turn;
                                // only a background run's command can.
                                entry.open_runs.retain(|_, run| run.background);
                                // Split the count by what opened the turn. An
                                // unrecorded opener — a turn inherited across a
                                // restart — counts as a prompt, which is
                                // today's behaviour and the direction R05
                                // accepts.
                                if entry.turn_opener == Some(TurnOpener::Wake) {
                                    entry.wake_turns_ended += 1;
                                } else {
                                    entry.prompt_turns_ended += 1;
                                }
                                entry.turn_opener = None;
                                entry.turn_api_error = turn_ended_in_api_error(&frame.payload);
                                entry.turn_cancelled = turn_ended_in_user_cancel(&frame.payload);
                                // No turn, no clock ([B02]).
                                entry.turn_last_frame_at = None;
                                // The turn boundary the arc demands has
                                // been reached: whatever this turn closed is
                                // no longer *this* turn's business, and the
                                // gate opens again (W8).
                                entry.step_closed_this_turn = None;
                                // One of the two facts `is_quiet` reads has
                                // just moved, so a stop waiting on the quiet
                                // edge is woken from inside the same guard
                                // that moved it ([P05]). It re-checks the
                                // other fact for itself.
                                entry.quiesced.notify_waiters();
                                drop(entry);
                                // The session went idle: an arc parked behind it
                                // because the gate refuses to move a branch
                                // mid-turn can now be caught up.
                                if let Some(tx) = self.turn_complete_tx.get() {
                                    let _ = tx.try_send(id.to_string());
                                }
                                // The same edge, for the arc runner ([P05]):
                                // a stage finishes by finishing a turn, and
                                // that is the moment its documents have just
                                // changed.
                                if let Some(tx) = self.arc_tick_tx.get() {
                                    let _ = tx.try_send(id.to_string());
                                }
                                // And again for the wheel ([P04]): a
                                // rotation asked for from inside this turn was
                                // parked rather than performed, precisely so
                                // it lands here instead of killing the claude
                                // that asked for it.
                                if let Some(tx) = self.wheel_tick_tx.get() {
                                    let _ = tx.try_send(id.to_string());
                                }
                            }
                        }
                    }
                    // Per-session system_metadata capture + broadcast per
                    // [D14]. CRITICAL: rewrap as `FeedId::SESSION_SIDEBAND`
                    // before publishing / storing. `Frame::encode()`
                    // serializes `Frame.feed_id` as the first wire byte, so
                    // a subscriber registered via
                    // `register_stream(FeedId::SESSION_SIDEBAND, ...)`
                    // would otherwise receive a frame tagged CODE_OUTPUT and
                    // route it to the wrong client-side store. Both the
                    // live publish AND the `latest_metadata` slot used by
                    // event-driven replay in `do_spawn_session` must hold
                    // the SESSION_SIDEBAND-tagged Frame.
                    if is_system_metadata(&frame.payload) {
                        let meta_frame =
                            Frame::new(FeedId::SESSION_SIDEBAND, frame.payload.clone());
                        let entry_arc = {
                            let ledger = self.ledger.lock().await;
                            ledger.get(&id).cloned()
                        };
                        if let Some(entry_arc) = entry_arc {
                            let mut entry = entry_arc.lock().await;
                            entry.latest_metadata = Some(meta_frame.clone());
                        }
                        self.session_sideband.publish_tagged(meta_frame);
                    } else if is_session_capabilities(&frame.payload) {
                        // Turn-free `initialize` capabilities ([#step-2a]).
                        // Rewrap onto SESSION_SIDEBAND (same rationale as
                        // `system_metadata`: the FeedStore keeps only the
                        // latest payload per feed, and the client routes by
                        // wire feed-id) so the session card's metadata store
                        // receives it. Retained in its own per-session slot
                        // (`latest_capabilities`, distinct from the
                        // `latest_metadata` system_metadata slot) so a card
                        // that binds after the one-shot broadcast — reconnect,
                        // HMR remount — gets the model list replayed on bind.
                        let cap_frame =
                            Frame::new(FeedId::SESSION_SIDEBAND, frame.payload.clone());
                        let entry_arc = {
                            let ledger = self.ledger.lock().await;
                            ledger.get(&id).cloned()
                        };
                        if let Some(entry_arc) = entry_arc {
                            let mut entry = entry_arc.lock().await;
                            entry.latest_capabilities = Some(cap_frame.clone());
                        }
                        // Persist alongside the in-memory slot so the
                        // catalog survives a tugcast restart: the slot dies
                        // with the process, and a resumed session's next
                        // handshake is health-gated (~2s after spawn at
                        // best) — the sqlite row bridges that window at
                        // bind time (`persisted_capabilities_replay_frame`).
                        // Best-effort like `record_session_metadata`: a
                        // write failure degrades to the pre-persistence
                        // behavior, never blocks the live broadcast.
                        if let Some(sql) = self.session_ledger.as_ref() {
                            let captured_at = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as i64)
                                .unwrap_or(0);
                            if let Err(e) = sql.record_session_capabilities(
                                id.as_str(),
                                &cap_frame.payload,
                                captured_at,
                            ) {
                                warn!(
                                    session_id = %id,
                                    error = %e,
                                    "record_session_capabilities failed; broadcasting without persistence"
                                );
                            }
                        }
                        self.session_sideband.publish_tagged(cap_frame);
                    } else if is_rate_limit_event(&frame.payload) {
                        // Per-turn subscription-quota broadcast ([#step-3]).
                        // Rewrap onto SESSION_SIDEBAND (same rationale as
                        // `system_metadata` / `session_capabilities`: the
                        // FeedStore keeps only the latest payload per feed and
                        // the client routes by wire feed-id) so the session card's
                        // metadata store — not the high-churn CODE_OUTPUT
                        // transcript store — receives it. Retained in its own
                        // per-session slot (`latest_rate_limit`) so a card that
                        // binds after the last broadcast (reconnect, HMR
                        // remount) replays the quota state on bind, which
                        // matters most when the session is hard rate-limited
                        // and cannot start a turn to refresh it.
                        let rl_frame =
                            Frame::new(FeedId::SESSION_SIDEBAND, frame.payload.clone());
                        let entry_arc = {
                            let ledger = self.ledger.lock().await;
                            ledger.get(&id).cloned()
                        };
                        if let Some(entry_arc) = entry_arc {
                            let mut entry = entry_arc.lock().await;
                            entry.latest_rate_limit = Some(rl_frame.clone());
                        }
                        self.session_sideband.publish_tagged(rl_frame);
                    }
                    // Forward-before-mutate: the wire-side broadcast above
                    // is the user-visible signal and must not be delayed
                    // by a database write. The journal mark-seen here is
                    // best-effort telemetry from the user's perspective;
                    // it becomes load-bearing only on the next runReplay,
                    // by which time the write has long since committed.
                    //
                    // Step 5.10: process_outbound_frame_journal_gate first
                    // updates the per-session replay-bracket counter from
                    // replay_started / replay_complete markers, then gates
                    // apply_outbound_turn_intercept on `replay_brackets_open == 0`
                    // so replay-emitted committed-turn frames don't pop
                    // the user's pending journal row.
                    self.process_outbound_frame_journal_gate(&id, &frame).await;
                }
            }
        }
    }

    /// Bracket-aware wrapper around [`Self::apply_outbound_turn_intercept`].
    /// Tracks per-session `LedgerEntry::replay_brackets_open` based on the
    /// `replay_started` / `replay_complete` frames the merger forwards,
    /// and gates the FIFO journal-pop intercept on the counter being zero.
    ///
    /// Why this gate exists (mid-turn-replay
    /// [Step 5.10](arc/tugplan-dev-mid-turn-replay.md#step-5)):
    /// `runReplay`'s `translateJsonlSession` emits `turn_complete` frames
    /// for every committed turn in the JSONL. Those frames flow through
    /// the merger task on the same path live `turn_complete`s do.
    /// Step 5.3's pure-FIFO intercept (`delete_oldest_pending_for_session`)
    /// can't tell replay-emitted from live, and the FIRST replay
    /// `turn_complete` to arrive on a session with a still-pending journal
    /// row pops that row — destroying the never-drop guarantee for any
    /// inflight submission whose runReplay fires while it's still pending.
    /// The HMR-mid-stream regression in the plan's close-out manual
    /// smoke surfaced this. The gate suppresses the intercept while the
    /// counter is non-zero.
    ///
    /// The gate cannot stick. A bracket whose `replay_complete` tugcode
    /// never sends — it went quiet, it died, the relay reading it died —
    /// used to leave the counter above zero for good, silently dropping
    /// every later live journal-pop, turn-end edge, and context-window
    /// retire for the session. Now the relay closes every such bracket
    /// itself, in band, with a synthetic `replay_complete { error }` that
    /// arrives here like any other and is counted like any other; and
    /// every end of a relay zeroes the counter as well (see
    /// [`LedgerEntry::replay_brackets_open`]). So the frame this function
    /// already understands is the only mechanism, and it always comes.
    ///
    /// Counter (not bool) so that a stray `replay_complete` on a closed
    /// bracket — the relay's close followed by tugcode's late one — is a
    /// no-op (saturating-decrement at 0). tugcode's `runReplay`
    /// re-entrancy guard prevents legitimate overlapping brackets, so in
    /// healthy operation the counter is 0 between brackets and 1 during
    /// a bracket.
    async fn process_outbound_frame_journal_gate(&self, session_id: &TugSessionId, frame: &Frame) {
        let Some(inspected) =
            super::payload_inspector::InspectedPayload::from_slice(&frame.payload)
        else {
            return;
        };
        let msg_type = inspected.msg_type();
        // Match before grabbing the entry — `_` covers most frames and
        // we don't need to touch the ledger map for them.
        match msg_type {
            Some("replay_started")
            | Some("replay_complete")
            | Some("turn_complete")
            | Some("turn_cancelled")
            | Some("session_rewound") => {}
            _ => return,
        }

        let entry_arc = {
            let ledger = self.ledger.lock().await;
            ledger.get(session_id).cloned()
        };
        let Some(entry_arc) = entry_arc else { return };

        match msg_type {
            Some("replay_started") => {
                let mut entry = entry_arc.lock().await;
                entry.replay_brackets_open = entry.replay_brackets_open.saturating_add(1);
                tracing::debug!(
                    target: "dev::ledger",
                    event = "merger.replay_bracket_open",
                    session_id = %session_id,
                    depth = entry.replay_brackets_open,
                );
            }
            Some("replay_complete") => {
                let mut entry = entry_arc.lock().await;
                entry.replay_brackets_open = entry.replay_brackets_open.saturating_sub(1);
                tracing::debug!(
                    target: "dev::ledger",
                    event = "merger.replay_bracket_close",
                    session_id = %session_id,
                    depth = entry.replay_brackets_open,
                );
                // The outermost bracket has closed: everything replay
                // described is history, so the entry owes the invariant it
                // held before the bracket opened — quiet ([B01]).
                if entry.replay_brackets_open == 0 && entry.clear_replay_residue() {
                    // One of the two facts `is_quiet` reads has just moved, so
                    // a stop waiting on the quiet edge is woken from inside
                    // the same guard that moved it ([P05]).
                    entry.quiesced.notify_waiters();
                }
            }
            Some("turn_complete") | Some("turn_cancelled") => {
                let in_replay = {
                    let entry = entry_arc.lock().await;
                    entry.replay_brackets_open > 0
                };
                if in_replay {
                    tracing::debug!(
                        target: "dev::ledger",
                        event = "merger.intercept_skipped_in_replay_bracket",
                        session_id = %session_id,
                        kind = msg_type.unwrap_or(""),
                    );
                } else {
                    self.apply_outbound_turn_intercept(session_id, frame);
                    let claude_id = {
                        let entry = entry_arc.lock().await;
                        entry.claude_session_id.clone()
                    };
                    if let Some(claude_id) = claude_id {
                        self.spawn_session_metrics_refresh(claude_id);
                    }
                }
            }
            // An in-place rewind truncated the live file under the same id,
            // so no `session_init` will push the segment's row again. Re-read
            // it now rather than leaving the rewound-away turn count and
            // prompt on the row until the next turn ends.
            Some("session_rewound") => {
                let claude_id = {
                    let entry = entry_arc.lock().await;
                    entry.claude_session_id.clone()
                };
                if let Some(claude_id) = claude_id {
                    self.spawn_rewound_row_refresh(claude_id);
                }
            }
            _ => unreachable!("filtered above"),
        }
    }

    /// Kick the turn-end scan-metrics refresh for a session, detached ([D132]).
    ///
    /// A turn ending is exactly when a masthead's activity line is read, and it
    /// was exactly when the scan-derived turn count and size were most stale —
    /// the picker scan was their only production writer. This re-derives both
    /// for the one session and pushes them.
    ///
    /// Detached and on a blocking thread: the frame the user is waiting for has
    /// already been forwarded by the time the merger reaches here, and the
    /// refresh is file I/O plus a parse, which must not occupy the merger's
    /// single loop. Every failure is silence — the numbers then stay exactly as
    /// stale as they were before this path existed, which is not a regression.
    ///
    /// Keyed by the **claude** session id, because that is what both the ledger
    /// row and the JSONL filename are keyed by.
    fn spawn_session_metrics_refresh(&self, claude_session_id: String) {
        let Some(ledger) = self.session_ledger.clone() else {
            return;
        };
        let control_tx = self.control_tx.clone();
        tokio::task::spawn_blocking(move || {
            let Ok(Some(row)) = ledger.get(&claude_session_id) else {
                return;
            };
            let Some(metrics) = crate::external_sessions::refresh_session_metrics(
                &ledger,
                &row.project_dir,
                &claude_session_id,
            ) else {
                // Nothing changed on disk, or the file is unreadable. Either
                // way there is no new number to announce.
                return;
            };
            // Re-read: the refresh just moved `turn_count` on this row.
            let Ok(Some(row)) = ledger.get(&claude_session_id) else {
                return;
            };
            let usage = ledger.usage_for(&claude_session_id).unwrap_or(None);
            let _ = control_tx.send(build_session_updated_frame(&row, Some(metrics), usage));
        });
    }

    /// [`Self::spawn_session_metrics_refresh`] for an in-place rewind: the same
    /// detached re-read and push, which also takes the row's last prompt back
    /// to the last one the truncated file still holds.
    fn spawn_rewound_row_refresh(&self, claude_session_id: String) {
        let Some(ledger) = self.session_ledger.clone() else {
            return;
        };
        let control_tx = self.control_tx.clone();
        tokio::task::spawn_blocking(move || {
            let Ok(Some(row)) = ledger.get(&claude_session_id) else {
                return;
            };
            let Some(metrics) = crate::external_sessions::refresh_after_in_place_rewind(
                &ledger,
                &row.project_dir,
                &claude_session_id,
                crate::session_ledger::now_millis(),
            ) else {
                return;
            };
            let Ok(Some(row)) = ledger.get(&claude_session_id) else {
                return;
            };
            let usage = ledger.usage_for(&claude_session_id).unwrap_or(None);
            let _ = control_tx.send(build_session_updated_frame(&row, Some(metrics), usage));
        });
    }

    /// Spawn the per-session agent bridge. Creates per-session stdin/stdout
    /// mpscs, registers the output rx with the merger, installs `input_tx`
    /// in the ledger entry, and launches [`run_session_bridge`] in a
    /// detached tokio task. The bridge task supervises the subprocess
    /// lifecycle (handshake, crash budget, splice stamping) per [D07].
    ///
    /// # Ledger state transitions
    ///
    /// Unlike Step 5's scaffold, this function does **not** promote the
    /// ledger entry to `SpawnState::Live`. The state stays at `Spawning`
    /// until the bridge reads `session_init` from the subprocess — at that
    /// point the bridge itself performs the atomic promote (flip state,
    /// drain the per-session queue into `input_tx`, publish the wire
    /// `SESSION_STATE = live` frame) inside a single ledger-entry lock
    /// acquisition. This keeps ledger `Live` and wire `live` semantically
    /// identical ("handshake succeeded and Claude reported its session_id")
    /// and eliminates the window where the dispatcher could forward frames
    /// to an un-handshaken subprocess through a bridge that had not yet
    /// started pumping stdin.
    ///
    /// While the state is `Spawning`, the dispatcher's `Spawning` branch
    /// buffers CODE_INPUT into `LedgerEntry::queue`. The bridge's
    /// `session_init` promote drains that queue into `input_tx` atomically
    /// with the state flip, so frame order is preserved across the
    /// transition.
    ///
    /// # Ordering invariant
    ///
    /// 1. Lookup the ledger entry.
    /// 2. Register the per-session output receiver with the merger.
    /// 3. *Only then* install `input_tx`.
    ///
    /// Install `input_tx` only after merger registration: if the merger has died and the
    /// register send fails after `input_tx` is installed, the dispatcher
    /// would happily forward frames into a Sender whose Receiver is owned
    /// by nothing. Registering first means a dead merger is detected
    /// before any visible ledger state is mutated.
    pub async fn spawn_session_worker(&self, tug_session_id: &TugSessionId) {
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "supervisor.spawn_worker_start",
            tug_session_id = %tug_session_id,
        );
        let entry_arc = {
            let map = self.ledger.lock().await;
            match map.get(tug_session_id) {
                Some(e) => e.clone(),
                None => return,
            }
        };

        let (input_tx, input_rx) = mpsc::channel::<Frame>(256);
        let (merger_per_session_tx, merger_per_session_rx) = mpsc::channel::<Frame>(256);

        // Register the per-session output receiver with the merger
        // BEFORE touching ledger state. A dead merger is detected here and
        // short-circuits the spawn with no ledger mutation — preventing
        // the B2-class bug where a failed register would leave `input_tx`
        // set against a Receiver that no merger owns.
        if self
            .merger_register_tx
            .send((tug_session_id.clone(), merger_per_session_rx))
            .await
            .is_err()
        {
            warn!(
                session = %tug_session_id,
                "merger register channel closed; flipping session to errored"
            );
            // Transition the entry out of Spawning so subsequent CODE_INPUT
            // drops (via the dispatcher's terminal-state branch) rather
            // than stalls forever in the queue.
            let mut entry = entry_arc.lock().await;
            if entry.spawn_state == SpawnState::Spawning {
                entry.spawn_state = SpawnState::Errored;
                drop(entry);
                self.session_state.publish_tagged(build_session_state_frame(
                    tug_session_id,
                    "errored",
                    Some("merger_unavailable"),
                ));
            }
            return;
        }

        // Install the dispatcher-side sender and clone the
        // cancellation token. Do **not** drain the queue or transition to
        // Live — that's the bridge's job on `session_init` (see above).
        //
        // A fresh bridge starts from a zero bracket count. The teardown of
        // the one before it already left zero — every end of a relay does,
        // and so does a bridge task that unwinds — so this is the second of
        // two hands on the same fact rather than the only one: it costs
        // nothing, and it holds even for an entry that reached here by a
        // path no bridge ever tore down.
        let cancel_for_bridge = {
            let mut entry = entry_arc.lock().await;
            if entry.spawn_state != SpawnState::Spawning {
                // Another task already handled the transition (or the
                // entry was closed out from under us). The stream we just
                // registered is orphaned — when `merger_per_session_tx`
                // drops at end of function, the merger's ReceiverStream
                // will yield None and be auto-removed from the StreamMap.
                return;
            }
            entry.input_tx = Some(input_tx.clone());
            entry.replay_brackets_open = 0;
            entry.cancel.clone()
        };
        // `input_tx` is stashed in the ledger entry; the bridge drains it
        // via the per-session queue on session_init. Drop our local clone
        // so only the dispatcher owns the send side after this point.
        drop(input_tx);

        self.session_state.publish_tagged(build_session_state_frame(
            tug_session_id,
            "spawning",
            None,
        ));

        // Launch the real bridge in a detached task.
        let spawner = (self.spawner_factory)();
        let state_tx = self.session_state.sender();
        let control_tx_for_bridge = Some(self.control_tx.clone());
        let tug_session_id_owned = tug_session_id.clone();
        let entry_arc_bridge = entry_arc.clone();
        // Per-session workspace path. Read from the ledger entry so
        // each session's tugcode subprocess gets its own cwd. Also
        // thread `session_mode` so the tugcode subprocess receives
        // `--session-mode new|resume`. The permission mode is *not* threaded
        // from here: the bridge reads `entry.permission_mode` itself on every
        // spawn it takes, so its crash-loop retries see a live change too.
        // The sessions recorder lets the
        // bridge transition the ledger row when it sees `session_init`,
        // `result`, `resume_failed`, or terminal teardown on the IPC stream.
        let (project_dir, session_mode) = {
            let entry = entry_arc.lock().await;
            (entry.project_dir.clone(), entry.session_mode)
        };
        let sessions_recorder = self.sessions_recorder.clone();
        let session_ledger_for_bridge = self.session_ledger.clone();
        let changeset_bumper_for_bridge =
            crate::feeds::changeset::ChangesetBumper::new(Arc::clone(&self.registry));
        // Kept outside the bridge future so they survive its unwind.
        let panic_session_id = tug_session_id.clone();
        let panic_entry = entry_arc.clone();
        let panic_state_tx = state_tx.clone();
        let panic_recorder = self.sessions_recorder.clone();
        tokio::spawn(async move {
            let bridge = run_session_bridge(
                tug_session_id_owned,
                entry_arc_bridge,
                input_rx,
                merger_per_session_tx,
                state_tx,
                control_tx_for_bridge,
                spawner,
                project_dir,
                session_mode,
                sessions_recorder,
                session_ledger_for_bridge,
                changeset_bumper_for_bridge,
                cancel_for_bridge,
                DEFAULT_RETRY_DELAY,
                AuthProbe::Claude,
            );
            // The handle to this task is dropped, so an unwind out of the
            // bridge would end the session in silence. The relay — where a
            // panic is likeliest, since it parses whatever a transcript
            // holds — contains its own and retries through the crash budget.
            // This is the boundary for everything else in the bridge: there
            // is no loop left to retry in, so the session ends `errored`,
            // out loud.
            if let Err(payload) = std::panic::AssertUnwindSafe(bridge).catch_unwind().await {
                let panic = crate::panic_hook::describe_caught(payload.as_ref());
                end_session_after_bridge_panic(
                    &panic_session_id,
                    &panic_entry,
                    &panic_state_tx,
                    panic_recorder.as_ref(),
                    &panic,
                )
                .await;
            }
        });
    }

    /// A client has connected. Arm the orphan sweep ([B07]).
    ///
    /// Every open card re-announces its session on connect, so once a deck
    /// has had its say, an entry in no client's `client_sessions` set is a
    /// bridge no card is behind. Before this, the only reaper for one was a
    /// tugcast restart — which is what the incident left the user with: a
    /// `tugcode` and its `claude` still running for a card that was gone from
    /// the layout.
    ///
    /// Armed by the connect rather than run on a timer. The thing being
    /// waited for is the deck's re-announcement, so a sweep that fires once
    /// per connect watches exactly that, and a cancelled supervisor drops it.
    pub fn on_client_connect(self: &Arc<Self>, client_id: ClientId) {
        let sup = Arc::clone(self);
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                () = tokio::time::sleep(BRIDGE_ORPHAN_SETTLE) => {
                    sup.reap_orphan_bridges(client_id).await;
                }
            }
        });
    }

    /// Close every bridge no client holds and no card names ([B07]).
    ///
    /// Three exclusions, and each is a session that is *meant* to be held by
    /// nobody:
    ///
    /// - a **headless** session, whose whole point is running with no card in
    ///   front of it until somebody adopts it;
    /// - an entry that has not spawned — `Idle` is what `rebind_from_ledger`
    ///   leaves at startup, waiting for the card that will claim it, and
    ///   `Errored` / `Closed` have no subprocess left to reap;
    /// - anything a client is holding, which is the ordinary case.
    ///
    /// A sweep whose own client is gone by the time the window passes does
    /// nothing. There is then no deck that re-announced, so "no client holds
    /// it" carries no information, and a tugcast running with no deck at all
    /// would otherwise reap its own work.
    async fn reap_orphan_bridges(&self, client_id: ClientId) {
        let held: HashSet<TugSessionId> = {
            let cs = self.client_sessions.lock().await;
            if !cs.contains_key(&client_id) {
                return;
            }
            cs.values().flatten().cloned().collect()
        };
        let entries: Vec<(TugSessionId, Arc<Mutex<LedgerEntry>>)> = {
            let ledger = self.ledger.lock().await;
            ledger
                .iter()
                .filter(|(id, _)| !held.contains(*id))
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect()
        };
        for (id, entry_arc) in entries {
            let (card_id, spawn_state) = {
                let entry = entry_arc.lock().await;
                (entry.card_id.clone(), entry.spawn_state)
            };
            if crate::background_session::is_background_card_id(card_id.as_deref()) {
                continue;
            }
            if !matches!(spawn_state, SpawnState::Spawning | SpawnState::Live) {
                continue;
            }
            warn!(
                target: "dev::session-lifecycle",
                event = "bridge_orphan_reaped",
                tug_session_id = %id,
                card_id = %card_id.as_deref().unwrap_or(""),
                "no client holds this bridge and no card named it after the \
                 settle window — closed rather than left to a restart",
            );
            self.do_close_session(card_id.as_deref().unwrap_or(""), &id)
                .await;
        }
    }

    /// Drop per-client affinity state on WebSocket teardown. Does NOT touch
    /// ledger state or tugbank — a client disconnecting is not a session
    /// close.
    pub async fn on_client_disconnect(&self, client_id: ClientId) {
        {
            let mut cs = self.client_sessions.lock().await;
            cs.remove(&client_id);
        }
        // A departed deck's seatings must not keep counting toward the
        // changeset's liveness — drop them (and recompute) with the socket.
        if super::deck_seatings::drop_deck_seatings(client_id) {
            self.registry.changeset_all_bump().notify_one();
        }
    }

    /// Re-materialize ledger entries from the sqlite-backed
    /// [`SessionLedger`].
    ///
    /// Called once at startup from `main.rs`. Walks every resumable row
    /// (see [`SessionLedger::list_with_card_id`] for the filter) and
    /// inserts a fresh `Idle` [`LedgerEntry`] for each `session_id`
    /// that is not already present in the in-memory ledger map.
    /// Returns the number of entries that were newly inserted.
    ///
    /// Per [F15] this path does **not**:
    ///
    /// - touch `client_sessions` — the rebind has no WebSocket client, so
    ///   any sentinel `ClientId` inserted here would be a permanent ghost
    ///   with no cleanup trigger. Real clients connecting after startup
    ///   send their own `spawn_session` CONTROL frames via [D14]'s normal
    ///   flow, which populate `client_sessions` for the real client_id.
    /// - mutate the sqlite ledger — the helper is strictly read-only.
    /// - publish any `SESSION_STATE` frames — the rebound entries are
    ///   unobservable until a real client subsequently calls `spawn_session`
    ///   for one of them, at which point the existing entry is reused and
    ///   the normal `pending` publish fires.
    pub async fn rebind_from_ledger(&self) -> Result<usize, crate::session_ledger::LedgerError> {
        let Some(ledger_db) = self.session_ledger.as_ref() else {
            return Ok(0);
        };
        let rows = ledger_db.list_with_card_id()?;
        let mut inserted = 0usize;
        // We acquire workspaces via `registry.get_or_create` outside the
        // ledger mutex (it takes its own parking_lot::Mutex internally), so
        // we can't hold the ledger across the loop. Iterate per-record:
        // validate → get_or_create → lock ledger briefly → insert.
        for row in rows {
            let Some(card_id) = row.card_id.clone() else {
                continue;
            };
            let project_dir = PathBuf::from(&row.project_dir);

            // Adopt the canonical workspace key persisted on the ledger row
            // rather than recomputing it from `project_dir`. Recomputing via
            // `registry.canonical_key` runs `std::fs::metadata` + `canonicalize`
            // on the project directory, touching the filesystem for every
            // historical project on boot — enough to trip a macOS TCC consent
            // prompt for any dir under Desktop / Documents / Downloads or
            // reached through a firmlink. The stored key was canonicalized by
            // `get_or_create` when the session first bound and written by
            // `record_spawn`; it is exactly what a recompute would yield, minus
            // the fs touch. The workspace itself is still registered lazily —
            // only when a client actually re-spawns the session
            // (`do_spawn_session` → `get_or_create`), which also re-validates
            // the directory and rejects a since-removed path, so deferring
            // validation here costs nothing beyond a harmless stale in-memory
            // entry until the next spawn.
            if row.workspace_key.is_empty() {
                warn!(
                    card_id,
                    session_id = row.session_id.as_str(),
                    path = ?project_dir,
                    "rebind: dropping ledger row with empty workspace_key"
                );
                continue;
            }
            let workspace_key = WorkspaceKey::from_canonical(&row.workspace_key);

            // The ledger row's `session_id` is claude's id (post
            // session_init). Use it as the tug_session_id for the
            // rebound entry — for un-forked sessions the two ids are
            // identical, and for forked sessions claude's id is what
            // `--resume <id>` accepts so the next spawn will work
            // against the JSONL on disk regardless.
            let tug_session_id = TugSessionId::new(row.session_id.clone());

            // Resume mode is the always-correct restore intent: we have
            // a recorded session, the client wants its history. The
            // defense-in-depth path in `do_spawn_session` upgrades
            // legacy entries to the client's requested mode when
            // `spawn_state == Idle`, so a fresh-mode spawn from the
            // picker against the same id still works.
            let rebound_mode = SessionMode::Resume;

            // Insert the ledger entry — or skip if one already exists (this
            // function is idempotent per [F15]). No workspace to release:
            // `canonical_key` registered nothing.
            let mut ledger = self.ledger.lock().await;
            if ledger.contains_key(&tug_session_id) {
                continue;
            }
            let mut entry = LedgerEntry::new(
                tug_session_id.clone(),
                workspace_key,
                project_dir,
                rebound_mode,
                CrashBudget::new(3, Duration::from_secs(60)),
            );
            // Carry the persisted `claude_session_id` so the first
            // spawn after rebind threads `--resume-session <id>` through
            // the spawner. The ledger's session_id IS claude's id post
            // session_init.
            entry.claude_session_id = Some(row.session_id.clone());
            entry.turns_ended = u32::try_from(row.turn_count).unwrap_or(0);
            // The row records turns, not their openers, so the seed reads them
            // all as asked ([P02], Risk R05) — the same conservative direction
            // an unrecorded opener takes at a turn's end.
            entry.prompt_turns_ended = entry.turns_ended;
            entry.wake_turns_ended = 0;
            entry.turn_opener = None;
            // Carry the card binding so the live-elsewhere check fires
            // correctly on a cross-card resume request after rebind.
            entry.card_id = Some(card_id.clone());
            // The line the rebound entry is on ([P04]) — read off the row, so
            // a session restored from the ledger at boot attaches its next
            // segment to the line it already belongs to.
            entry.line_id = Some(row.line_id.clone());
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "rebind.entry",
                card_id = card_id.as_str(),
                tug_session_id = %tug_session_id,
                rebound_mode = rebound_mode.as_wire_str(),
                mode_source = "ledger",
                claude_session_id = row.session_id.as_str(),
            );
            ledger.insert(tug_session_id, Arc::new(Mutex::new(entry)));
            inserted += 1;
        }
        Ok(inserted)
    }

    /// Install this supervisor as the join pilot's runner ([P01]).
    ///
    /// Called once from startup, after the supervisor is in its `Arc`. The
    /// handle is weak: the pilot is a process-global and must not be what keeps
    /// a supervisor alive.
    pub fn register_pilot_runner(self: &Arc<Self>) {
        crate::feeds::join_pilot::register_runner(Box::new(SupervisorPilotRunner {
            supervisor: Arc::downgrade(self),
        }));
    }
}

/// The join pilot's runner, backed by the supervisor ([P01]).
///
/// The pilot's predicate runs on the changeset recompute, which is a cache with
/// no route back to the supervisor — and the scribe context, the CONTROL
/// sender, and the recompute bump all live on the supervisor. This is the
/// bridge, and it is deliberately thin: it performs no admission and no mark
/// work, both of which the pilot already did under its occupancy guard.
struct SupervisorPilotRunner {
    supervisor: std::sync::Weak<AgentSupervisor>,
}

#[async_trait::async_trait]
impl crate::feeds::join_pilot::PilotRunner for SupervisorPilotRunner {
    async fn reconcile(
        &self,
        project_dir: &str,
        arc: &str,
        occupancy: crate::feeds::join_occupancy::JoinOccupancy,
    ) {
        let Some(supervisor) = self.supervisor.upgrade() else {
            return;
        };
        // The very same ladder a `changeset_join_resolve` press runs — scribe
        // rung and resolver audit, ending at a standing candidate.
        supervisor
            .run_resolve_ladder(project_dir, arc, occupancy)
            .await;
    }
}

// ---------------------------------------------------------------------------
// Crate-visible test helpers — available to other modules' #[cfg(test)] code.
// ---------------------------------------------------------------------------

/// Minimal no-op [`SessionsRecorder`] for tests that don't care about the
/// per-session record. Production uses [`LedgerSessionsRecorder`].
#[cfg(test)]
pub(crate) struct NoopSessionsRecorder;

#[cfg(test)]
impl SessionsRecorder for NoopSessionsRecorder {
    fn record(&self, _record: SessionRecord<'_>) {}
    fn record_turn(&self, _session_id: &str) {}
    fn set_turn_count(&self, _session_id: &str, _count: i64) {}
    fn engine_turn_count(&self, _session_id: &str, _project_dir: &str) -> Option<i64> {
        None
    }
    fn record_user_prompt(&self, _session_id: &str, _prompt: &str) {}
    fn mark_closed(&self, _session_id: &str) {}
    fn mark_failed(&self, _session_id: &str) {}
    fn insert_pending_turn(
        &self,
        _session_id: &str,
        _journal_id: &str,
        _user_text: &str,
        _user_attachments: &[serde_json::Value],
        _now: i64,
    ) -> Result<(), crate::session_ledger::LedgerError> {
        Ok(())
    }
    fn delete_oldest_pending_for_session(
        &self,
        _session_id: &str,
    ) -> Result<Option<crate::session_ledger::JournalRow>, crate::session_ledger::LedgerError> {
        Ok(None)
    }
    fn record_wheel_prompt(&self, _session_id: &str, _text: &str) {}
    fn lineage_chain(&self, session_id: &str) -> Vec<String> {
        vec![session_id.to_owned()]
    }
    fn arc_name_for(&self, _session_id: &str) -> Option<String> {
        None
    }
    fn stage_provenance(&self, _session_id: &str) -> Option<(String, Option<String>)> {
        None
    }
}

/// A [`SessionsRecorder`] that answers `engine_turn_count` from a table and
/// remembers every `set_turn_count`, for the tests that are about which count
/// goes where. Everything else is the no-op's behaviour.
#[cfg(test)]
pub(crate) struct CountingSessionsRecorder {
    /// `engine(file)` per session id. An id absent from the map answers
    /// `None` — the unreadable-JSONL case.
    pub counts: std::collections::HashMap<String, i64>,
    /// Every `(session_id, count)` the code under test wrote, in order.
    pub writes: parking_lot::Mutex<Vec<(String, i64)>>,
}

#[cfg(test)]
impl CountingSessionsRecorder {
    pub(crate) fn new(counts: &[(&str, i64)]) -> Self {
        Self {
            counts: counts
                .iter()
                .map(|(id, n)| ((*id).to_owned(), *n))
                .collect(),
            writes: parking_lot::Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
impl SessionsRecorder for CountingSessionsRecorder {
    fn set_turn_count(&self, session_id: &str, count: i64) {
        self.writes.lock().push((session_id.to_owned(), count));
    }
    fn engine_turn_count(&self, session_id: &str, _project_dir: &str) -> Option<i64> {
        self.counts.get(session_id).copied()
    }
    fn record(&self, _record: SessionRecord<'_>) {}
    fn record_turn(&self, _session_id: &str) {}
    fn record_user_prompt(&self, _session_id: &str, _prompt: &str) {}
    fn mark_closed(&self, _session_id: &str) {}
    fn mark_failed(&self, _session_id: &str) {}
    fn insert_pending_turn(
        &self,
        _session_id: &str,
        _journal_id: &str,
        _user_text: &str,
        _user_attachments: &[serde_json::Value],
        _now: i64,
    ) -> Result<(), crate::session_ledger::LedgerError> {
        Ok(())
    }
    fn delete_oldest_pending_for_session(
        &self,
        _session_id: &str,
    ) -> Result<Option<crate::session_ledger::JournalRow>, crate::session_ledger::LedgerError> {
        Ok(None)
    }
    fn record_wheel_prompt(&self, _session_id: &str, _text: &str) {}
    fn lineage_chain(&self, session_id: &str) -> Vec<String> {
        vec![session_id.to_owned()]
    }
    fn arc_name_for(&self, _session_id: &str) -> Option<String> {
        None
    }
    fn stage_provenance(&self, _session_id: &str) -> Option<(String, Option<String>)> {
        None
    }
}

/// Construct an [`AgentSupervisor`] with stub channels and a stalled
/// spawner factory. Returns the supervisor wrapped in `Arc` plus its
/// merger register receiver (which the caller should either spawn
/// `merger_task` against or drain to keep the register channel alive).
/// Used by router tests that need to exercise CONTROL interception or
/// client-disconnect hooks without constructing a full subprocess
/// pipeline.
#[cfg(test)]
pub(crate) fn test_minimal_supervisor() -> (Arc<AgentSupervisor>, mpsc::Receiver<MergerRegistration>)
{
    test_minimal_supervisor_with_recorder(Arc::new(NoopSessionsRecorder))
}

/// [`test_minimal_supervisor`] with a real sessions ledger behind it, for the
/// paths whose whole point is what they write down. Hands back the ledger so
/// the test can read the rows the code under test wrote.
#[cfg(test)]
pub(crate) fn test_minimal_supervisor_with_ledger() -> (
    Arc<AgentSupervisor>,
    Arc<crate::session_ledger::SessionLedger>,
    mpsc::Receiver<MergerRegistration>,
) {
    let ledger = Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().expect("open in-memory ledger"),
    );
    let (sup, rx) = test_minimal_supervisor_with_recorder(Arc::new(LedgerSessionsRecorder::new(
        Arc::clone(&ledger),
    )));
    (sup, ledger, rx)
}

/// [`test_minimal_supervisor_with_ledger`] with the supervisor *reading* that
/// same ledger — the shape the arc CONTROL handlers need, since every one of
/// them short-circuits on `no_ledger` without the read handle.
#[cfg(test)]
pub(crate) fn test_minimal_supervisor_reading_its_ledger() -> (
    Arc<AgentSupervisor>,
    Arc<crate::session_ledger::SessionLedger>,
    mpsc::Receiver<MergerRegistration>,
) {
    let ledger = Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().expect("open in-memory ledger"),
    );
    let (sup, rx) = test_minimal_supervisor_with_recorder_reading(
        Arc::new(LedgerSessionsRecorder::new(Arc::clone(&ledger))),
        Some(Arc::clone(&ledger)),
    );
    (sup, ledger, rx)
}

/// [`test_minimal_supervisor`] over a recorder the caller chose — for a
/// harness that already holds the ledger the supervisor should write to.
#[cfg(test)]
pub(crate) fn test_minimal_supervisor_with_recorder(
    recorder: Arc<dyn SessionsRecorder>,
) -> (Arc<AgentSupervisor>, mpsc::Receiver<MergerRegistration>) {
    test_minimal_supervisor_with_recorder_reading(recorder, None)
}

/// [`test_minimal_supervisor_with_recorder`] with the read handle wired too,
/// for the CONTROL handlers that read the ledger rather than only writing it.
#[cfg(test)]
pub(crate) fn test_minimal_supervisor_with_recorder_reading(
    recorder: Arc<dyn SessionsRecorder>,
    session_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
) -> (Arc<AgentSupervisor>, mpsc::Receiver<MergerRegistration>) {
    let (state_tx, _) = broadcast::channel(16);
    let (meta_tx, _) = broadcast::channel(16);
    let (code_tx, _) = broadcast::channel(16);
    let (control_tx, _) = broadcast::channel(16);
    // Eager spawn (do_spawn_session) calls the factory whenever a fresh
    // entry is inserted. Hand back a never-resolving stall spawner so
    // `spawn_session_worker` installs the per-session plumbing without
    // the bridge ever emitting a real frame — matches the StallSpawner
    // used by tests in this file.
    struct MinimalStallSpawner;
    impl ChildSpawner for MinimalStallSpawner {
        fn spawn_child(
            &self,
            _project_dir: &std::path::Path,
            _session_id: &str,
            _session_mode: SessionMode,
            _resume_claude_session_id: Option<&str>,
            _permission_mode: Option<&str>,
            _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
        ) -> super::agent_bridge::SpawnFuture {
            Box::pin(async {
                std::future::pending::<std::io::Result<super::agent_bridge::SessionChild>>().await
            })
        }
    }
    let factory: SpawnerFactory =
        Arc::new(|| Arc::new(MinimalStallSpawner) as Arc<dyn ChildSpawner>);
    let registry = Arc::new(WorkspaceRegistry::new_for_test());
    let cancel = CancellationToken::new();
    let (sup, register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        session_ledger,
        factory,
        AgentSupervisorConfig::default(),
        registry,
        cancel,
    );
    (Arc::new(sup), register_rx)
}

/// Terminal handling for a bridge task that unwound: the same `errored`
/// ending a spent crash budget gets, with the panic as its reason. A session
/// `close_session` already closed stays closed and publishes nothing, for the
/// reason the budget path gives — a client seeing both would see a
/// conflicting lifecycle.
pub(crate) async fn end_session_after_bridge_panic(
    tug_session_id: &TugSessionId,
    ledger_entry: &Arc<Mutex<LedgerEntry>>,
    state_tx: &broadcast::Sender<Frame>,
    sessions_recorder: &dyn SessionsRecorder,
    panic: &str,
) {
    let (already_closed, claude_id) = {
        let mut entry = ledger_entry.lock().await;
        let already_closed = entry.spawn_state == SpawnState::Closed;
        if !already_closed {
            entry.spawn_state = SpawnState::Errored;
        }
        entry.input_tx = None;
        entry.child_pid = None;
        entry.child_start_time = None;
        entry.turn_active = false;
        entry.open_jobs.clear();
        // The relay that would have closed an open bracket is gone with the
        // task, and nothing will respawn it.
        entry.replay_brackets_open = 0;
        (already_closed, entry.claude_session_id.clone())
    };
    error!(session = %tug_session_id, "session bridge {panic}; session ended");
    if let Some(id) = claude_id {
        sessions_recorder.mark_failed(&id);
    }
    if !already_closed {
        let detail = format!("bridge_panicked\n{panic}");
        let _ = state_tx.send(build_session_state_frame(
            tug_session_id,
            "errored",
            Some(detail.as_str()),
        ));
    }
}

/// Test helper: insert a bare ledger entry for `tug_session_id` and hand back
/// the entry so the test can set its spawn state and stdin sender.
///
/// The workspace key is synthetic and the project dir is the crate root: these
/// entries exercise per-session bookkeeping, never workspace lifecycle.
#[cfg(test)]
pub(crate) async fn insert_ledger_entry_for_tests(
    sup: &AgentSupervisor,
    tug_session_id: &TugSessionId,
) -> Arc<Mutex<LedgerEntry>> {
    let entry = Arc::new(Mutex::new(LedgerEntry::new(
        tug_session_id.clone(),
        WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR")),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        SessionMode::New,
        CrashBudget::new(3, Duration::from_secs(60)),
    )));
    sup.ledger
        .lock()
        .await
        .insert(tug_session_id.clone(), entry.clone());
    entry
}

/// Test helper: install a Live ledger entry for `tug_session_id` with a
/// freshly-allocated `input_tx`, and return the matching `input_rx` so
/// the test can observe any frames the supervisor's CONTROL handlers
/// forward to that session. Mirrors the Spawning→Live promote path the
/// production bridge runs on `session_init`, minus the actual subprocess.
///
/// Used by router tests that need to exercise the full
/// `intercept_session_control` → `handle_control` path against a live
/// session — i.e., the ingress shape that production code actually rides.
#[cfg(test)]
pub(crate) async fn install_live_session_for_tests(
    sup: &AgentSupervisor,
    tug_session_id: &TugSessionId,
    workspace_key: WorkspaceKey,
    project_dir: std::path::PathBuf,
) -> tokio::sync::mpsc::Receiver<Frame> {
    let entry = Arc::new(Mutex::new(LedgerEntry::new(
        tug_session_id.clone(),
        workspace_key,
        project_dir,
        super::agent_bridge::SessionMode::New,
        CrashBudget::new(3, Duration::from_secs(60)),
    )));
    let (input_tx, input_rx) = mpsc::channel::<Frame>(4);
    {
        let mut e = entry.lock().await;
        e.spawn_state = SpawnState::Live;
        e.input_tx = Some(input_tx.clone());
    }
    // Drop the test-side sender clone so the receiver only sees frames
    // forwarded through the ledger's stored copy.
    drop(input_tx);
    sup.ledger
        .lock()
        .await
        .insert(tug_session_id.clone(), entry);
    input_rx
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    mod arc;
    mod changeset;
    mod rows;
    mod session;
    mod spawn;
    mod telemetry;

    use super::*;
    use std::future::pending;
    use tokio::sync::Notify;

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

    use super::super::agent_bridge::{RelayOutcome, SessionChild, SpawnFuture, relay_session_io};

    // ── session tag on the wire: inbound parse + outbound frame ───────────────

    /// A job opens on `task_started` and closes only on a terminal status.
    #[test]
    fn parse_job_edge_reads_both_ends_and_nothing_between() {
        assert_eq!(
            parse_job_edge(br#"{"type":"task_started","task_id":"t1","task_type":"local_agent"}"#),
            Some(JobEdge::Opened("t1".to_owned()))
        );
        for status in ["completed", "failed", "killed"] {
            let frame = format!(r#"{{"type":"task_updated","task_id":"t1","status":"{status}"}}"#);
            assert_eq!(
                parse_job_edge(frame.as_bytes()),
                Some(JobEdge::Closed("t1".to_owned())),
                "{status} ends a job"
            );
        }
        // A status the wire has not shown us leaves the job open, which is the
        // safe direction: a join offered a beat late beats one offered early.
        assert_eq!(
            parse_job_edge(br#"{"type":"task_updated","task_id":"t1","status":"running"}"#),
            None
        );
        // A progress tick is a job working, not a job ending.
        assert_eq!(
            parse_job_edge(br#"{"type":"task_progress","task_id":"t1"}"#),
            None
        );
        // The scheduled wake's re-init names no job — but it still closes,
        // with an empty name, because a wake is the model speaking again and
        // the `Closed` arm uses that to retire the provisional launches.
        assert_eq!(
            parse_job_edge(br#"{"type":"wake_started","task_id":""}"#),
            Some(JobEdge::Closed(String::new()))
        );
    }

    /// A wake closes the job its notification is about. The bytes are tugcode's
    /// translated `WakeStarted` shape (`tugproto/src/outbound.ts`), not the raw
    /// claude `system/task_notification` the fixture catalog pins — that
    /// capture is the input *to* tugcode, and nothing wearing that shape ever
    /// reaches this wire.
    #[test]
    fn parse_job_edge_closes_on_a_terminal_wake() {
        for status in ["completed", "failed", "stopped"] {
            let frame = format!(
                r#"{{"type":"wake_started","session_id":"c","wake_trigger":{{"task_id":"t1","tool_use_id":"toolu_1","status":"{status}","summary":"done","output_file":""}},"ipc_version":2}}"#
            );
            assert_eq!(
                parse_job_edge(frame.as_bytes()),
                Some(JobEdge::Closed("t1".to_owned())),
                "a wake reporting {status} ends its job"
            );
        }
        // Vocabulary the wire has not shown us leaves the *named* job open,
        // the same conservative direction the `task_updated` arm takes — the
        // wake still closes with an empty name, so the provisional launches
        // it should retire are retired either way.
        assert_eq!(
            parse_job_edge(
                br#"{"type":"wake_started","wake_trigger":{"task_id":"t1","status":"running"}}"#
            ),
            Some(JobEdge::Closed(String::new()))
        );
        // The scheduler's re-init wake carries no job under `wake_trigger`
        // either, and closes the same way.
        assert_eq!(
            parse_job_edge(
                br#"{"type":"wake_started","wake_trigger":{"task_id":"","status":"completed"}}"#
            ),
            Some(JobEdge::Closed(String::new()))
        );
    }

    /// The reading one frame writes, for the tests below — the same answer
    /// [`parse_context_window`] gives, read off the frame's bytes.
    fn measured(payload: &[u8]) -> Option<i64> {
        match context_window_update(payload) {
            Some(ContextWindowUpdate::Measured(tokens)) => Some(tokens),
            _ => None,
        }
    }

    /// Both frames that carry usage write the window, and they sum the same
    /// four fields — a `streaming_usage` keeps the reading current inside the
    /// turn, a `cost_update` is the turn's last word.
    #[test]
    fn parse_context_window_reads_streaming_usage_and_cost_update_alike() {
        let usage = r#""usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}"#;
        let cost = format!(r#"{{"type":"cost_update",{usage}}}"#);
        let streaming = format!(r#"{{"type":"streaming_usage",{usage}}}"#);
        assert_eq!(measured(cost.as_bytes()), Some(1115));
        assert_eq!(measured(streaming.as_bytes()), Some(1115));

        // A background subagent lane carries its own small window, stamped
        // with the tool use that spawned it. That is not the session's
        // resident context, so it writes nothing.
        let subagent =
            format!(r#"{{"type":"streaming_usage","parent_tool_use_id":"toolu_1",{usage}}}"#);
        assert_eq!(measured(subagent.as_bytes()), None);
        let main_lane =
            format!(r#"{{"type":"streaming_usage","parent_tool_use_id":null,{usage}}}"#);
        assert_eq!(measured(main_lane.as_bytes()), Some(1115));

        // Every other frame, and a usage that sums to nothing, is no reading.
        assert_eq!(measured(br#"{"type":"turn_complete"}"#), None);
        assert_eq!(
            measured(br#"{"type":"cost_update","usage":{"input_tokens":0}}"#),
            None
        );
        assert_eq!(measured(b"not json"), None);
    }

    /// The frame a compaction ends on **clears** the reading rather than
    /// setting one.
    ///
    /// A compact turn carries no usage frame, so the figure held across it
    /// measures a context that no longer exists — and the arc, judging the
    /// compaction by it, would rotate the stage it had just compacted. The
    /// boundary's own `post_tokens` is ignored on purpose: it is the compacted
    /// transcript's size, not the resident window's.
    #[test]
    fn a_compact_boundary_retires_the_reading_rather_than_setting_one() {
        let boundary =
            br#"{"type":"compact_boundary","trigger":"manual","pre_tokens":328150,"post_tokens":9000,"ipc_version":1}"#;
        assert!(matches!(
            context_window_update(boundary),
            Some(ContextWindowUpdate::Retired)
        ));

        // Every other frame keeps the meaning it had: a usage frame measures,
        // and the rest say nothing.
        assert!(matches!(
            context_window_update(
                br#"{"type":"cost_update","usage":{"input_tokens":10,"cache_read_input_tokens":90}}"#
            ),
            Some(ContextWindowUpdate::Measured(100))
        ));
        assert!(context_window_update(br#"{"type":"turn_complete"}"#).is_none());

        // And a frame that merely *quotes* a boundary is not one. The
        // documents for this very feature carry the literal, and they cross
        // the pipe as prompt and transcript text.
        assert!(
            context_window_update(
                br#"{"type":"assistant","message":{"content":[{"type":"text","text":"the frame is {\"type\":\"compact_boundary\"}"}]}}"#
            )
            .is_none()
        );
    }

    #[test]
    fn a_turn_complete_marked_as_an_api_error_is_read_as_one() {
        let errored = br#"{"type":"turn_complete","msg_id":"m","seq":1,"result":"success","is_api_error":true}"#;
        let clean = br#"{"type":"turn_complete","msg_id":"m","seq":1,"result":"success"}"#;
        let other = br#"{"type":"assistant_text","is_api_error":true}"#;
        assert!(turn_ended_in_api_error(errored));
        assert!(!turn_ended_in_api_error(clean));
        assert!(!turn_ended_in_api_error(other));
    }

    /// A card on an arc with a live arc record, seated in `review`, and the
    /// ledger that holds it.
    fn on_arc_review_card(root: &std::path::Path) -> Arc<crate::session_ledger::SessionLedger> {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
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
            .set_arc_binding("claude-1", Some(("tugarc/demo#1", "demo")))
            .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", "arc/demo-brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(
            root,
            "demo",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_model_switch_on_an_on_arc_card_lands_in_the_arc_log() {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_review_card(root);

        let (sup, _ledger, _rx) = make_supervisor_for_ledger(Arc::clone(&ledger), None);
        let tug_session_id = TugSessionId::new("claude-1");
        let _entry = insert_ledger_entry(&sup, &tug_session_id).await;

        sup.dispatch_one(model_change_frame("claude-1", "sonnet"))
            .await;

        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo").unwrap().notes,
            vec!["model → sonnet in review".to_string()],
        );

        // Repeating the selector is a repaint, not a switch.
        sup.dispatch_one(model_change_frame("claude-1", "sonnet"))
            .await;
        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo")
                .unwrap()
                .notes
                .len(),
            1,
            "a no-op repaint writes no second note",
        );

        // A real second switch does.
        sup.dispatch_one(model_change_frame("claude-1", "opus"))
            .await;
        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo").unwrap().notes,
            vec![
                "model → sonnet in review".to_string(),
                "model → opus in review".to_string(),
            ],
        );
    }

    /// The bytes the deck sends when the user picks a model.
    fn model_change_frame(session: &str, model: &str) -> Frame {
        Frame::new(
            FeedId::CODE_INPUT,
            serde_json::to_vec(&serde_json::json!({
                "tug_session_id": session,
                "type": "model_change",
                "model": model,
            }))
            .unwrap(),
        )
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_model_switch_on_a_card_off_an_arc_writes_no_note() {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
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

        let (sup, _ledger, _rx) = make_supervisor_for_ledger(Arc::clone(&ledger), None);
        let tug_session_id = TugSessionId::new("claude-1");
        let _entry = insert_ledger_entry(&sup, &tug_session_id).await;

        sup.dispatch_one(model_change_frame("claude-1", "sonnet"))
            .await;

        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo"),
            None,
            "a card running no arc leaves the log alone",
        );

        // Bound to an arc whose arc has already stopped is also not on one.
        let ledger = on_arc_review_card(root);
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            tugarc_core::arc::ArcStage::Review,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();
        let (sup, _ledger, _rx) = make_supervisor_for_ledger(ledger, None);
        let _entry = insert_ledger_entry(&sup, &TugSessionId::new("claude-1")).await;
        sup.dispatch_one(model_change_frame("claude-1", "sonnet"))
            .await;
        assert!(
            tugarc_core::arc::read_arc(root, "demo")
                .unwrap()
                .notes
                .is_empty(),
        );
    }

    /// A card seated by a stage takes its arc out of the sweep when it closes
    /// (`bound_session_by_arc` is live-rows-only), so the close writes the
    /// stop while the binding still names the arc. Without it the record says
    /// `review` forever with nothing running.
    #[tokio::test]
    #[serial_test::serial]
    async fn closing_a_card_seated_by_a_stage_stops_its_arc() {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
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
            .set_arc_binding("claude-1", Some(("tugarc/demo#1", "demo")))
            .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", "arc/demo-brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(
            root,
            "demo",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();

        crate::arc_api::stop_an_on_arc_cards_arc_as_closed(&ledger, "claude-1");

        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo").unwrap().stopped,
            Some((
                tugarc_core::arc::ArcStage::Review,
                "card closed".to_string()
            )),
        );
        // Twice is once: the second read finds the arc already stopped and
        // leaves the log alone, so a close that races anything else does not
        // stack `arc-stop` lines.
        crate::arc_api::stop_an_on_arc_cards_arc_as_closed(&ledger, "claude-1");
        assert_eq!(
            tugarc_core::arc::read_arc(root, "demo").unwrap().stopped,
            Some((
                tugarc_core::arc::ArcStage::Review,
                "card closed".to_string()
            )),
        );
    }

    #[test]
    fn only_an_unmarked_cancel_reads_as_the_user_taking_the_card_back() {
        let user = br#"{"type":"turn_cancelled","msg_id":"m","seq":1,"partial_result":"x"}"#;
        let recovery =
            br#"{"type":"turn_cancelled","msg_id":"m","seq":1,"partial_result":"x","is_recovery":true}"#;
        let complete = br#"{"type":"turn_complete","msg_id":"m","seq":1,"result":"success"}"#;
        assert!(turn_ended_in_user_cancel(user));
        assert!(!turn_ended_in_user_cancel(recovery));
        assert!(!turn_ended_in_user_cancel(complete));
    }

    fn listed(
        session_id: &str,
        line_id: &str,
        tag: Option<&str>,
        name: Option<&str>,
        state: crate::session_ledger::SessionState,
        last_used_at: i64,
        turn_count: i64,
    ) -> ListedSession {
        ListedSession {
            row: crate::session_ledger::SessionRow {
                session_id: session_id.to_string(),
                workspace_key: "ws".to_string(),
                project_dir: "/proj".to_string(),
                created_at: 1,
                last_used_at,
                turn_count,
                last_user_prompt: Some("hi".to_string()),
                state,
                card_id: Some(format!("card-{session_id}")),
                name: name.map(str::to_string),
                name_user_set: name.is_some(),
                tag: tag.map(str::to_string),
                synopsis: None,
                private: false,
                arc_id: None,
                arc_name: None,
                line_id: line_id.to_string(),
                background: false,
            },
            origin: "tug",
            terminal_live: None,
            file_size: Some(10),
        }
    }

    #[test]
    fn an_arcs_stages_fold_into_the_line_they_rotated_from() {
        use crate::session_ledger::SessionState;
        // Every segment arrives wearing the line's callsign already — that is
        // what the `LEFT JOIN lines` reads ([P02]) — so the fold has only to
        // group, never to choose an identity.
        let rows = vec![
            listed(
                "root",
                "line-1",
                Some("primo-pita"),
                Some("tugedit-bringup"),
                SessionState::Closed,
                100,
                11,
            ),
            listed(
                "devise",
                "line-1",
                Some("primo-pita"),
                Some("tugedit-bringup"),
                SessionState::Closed,
                200,
                1,
            ),
            listed(
                "implement",
                "line-1",
                Some("primo-pita"),
                Some("tugedit-bringup"),
                SessionState::Live,
                150,
                6,
            ),
            listed(
                "stranger",
                "line-2",
                Some("lucky-wren"),
                None,
                SessionState::Closed,
                300,
                4,
            ),
        ];

        let folded = fold_lines(rows);
        assert_eq!(
            folded.len(),
            2,
            "one row for the line, one for the stranger"
        );
        let row = &folded
            .iter()
            .find(|e| e.row.tag.as_deref() == Some("primo-pita"))
            .expect("the line lists")
            .row;
        // The live segment is the resume target even though a closed one was
        // used more recently: seating the tip replays the whole scroll.
        assert_eq!(row.session_id, "implement");
        assert_eq!(row.name.as_deref(), Some("tugedit-bringup"));
        assert!(row.name_user_set);
        assert_eq!(row.state, SessionState::Live);
        assert_eq!(row.turn_count, 18, "the line's turns, not the segment's");
        assert_eq!(
            folded
                .iter()
                .find(|e| e.row.session_id == "implement")
                .and_then(|e| e.file_size),
            Some(30)
        );
        // A line of one passes through untouched.
        let stranger = folded
            .iter()
            .find(|e| e.row.session_id == "stranger")
            .expect("the stranger lists");
        assert_eq!(stranger.row.turn_count, 4);
        assert_eq!(stranger.file_size, Some(10));
        // And a row with no line at all is its own group.
        assert_eq!(
            fold_lines(vec![listed(
                "solo",
                "",
                None,
                None,
                SessionState::Closed,
                1,
                1
            )])
            .len(),
            1
        );
    }

    /// A scan meta for a session the ledger has no row for, on a line the
    /// user named.
    fn scanned(
        session_id: &str,
        line_id: &str,
        ai_title: Option<&str>,
        line_name: Option<&str>,
    ) -> crate::external_sessions::ExternalSessionMeta {
        crate::external_sessions::ExternalSessionMeta {
            session_id: session_id.to_string(),
            turn_count: 3,
            last_user_prompt: Some("hi".to_string()),
            name: ai_title.map(str::to_string),
            created_at: 1,
            last_used_at: 100,
            file_size: 10,
            file_mtime: 100,
            tag: Some("ashen-bagel".to_string()),
            line_id: Some(line_id.to_string()),
            line_name: line_name.map(str::to_string),
            line_name_user_set: line_name.is_some(),
        }
    }

    #[test]
    fn a_scanned_session_lists_under_the_name_on_its_line() {
        // The shape a lost name leaves behind: the `sessions` row is gone, so
        // the transcript surfaces through the scan alone — but `minted_tags`
        // still joins it to the line the user named, and the row must wear
        // that name rather than the transcript's machine-written `aiTitle`.
        let scan = crate::external_sessions::ScanOutcome {
            metas: vec![scanned(
                "d361bcf4",
                "line-lens",
                Some("Investigating a layout regression"),
                Some("lens-xp"),
            )],
            canonical_project_dir: "/proj".to_string(),
            ..Default::default()
        };

        let listed = build_listed_union(Vec::new(), &HashMap::new(), Some(scan));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].origin, "external");
        assert_eq!(listed[0].row.name.as_deref(), Some("lens-xp"));
        assert!(
            listed[0].row.name_user_set,
            "the user's own word, not a guess"
        );
    }

    #[test]
    fn a_scanned_session_on_an_unnamed_line_keeps_its_ai_title() {
        // The control: with no rename on the line, the `aiTitle` is the best
        // name there is, and it is not a user-set one.
        let scan = crate::external_sessions::ScanOutcome {
            metas: vec![scanned(
                "abc123",
                "line-anon",
                Some("Some auto title"),
                None,
            )],
            canonical_project_dir: "/proj".to_string(),
            ..Default::default()
        };

        let listed = build_listed_union(Vec::new(), &HashMap::new(), Some(scan));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].row.name.as_deref(), Some("Some auto title"));
        assert!(!listed[0].row.name_user_set);
    }

    #[test]
    fn parse_spawn_payload_extracts_tag() {
        let payload = br#"{"card_id":"c1","tug_session_id":"s1","project_dir":"/p","session_mode":"new","tag":"azure-heron"}"#;
        let parsed = parse_control_payload_owned(payload).expect("parse");
        assert_eq!(parsed.tag.as_deref(), Some("azure-heron"));
    }

    #[test]
    fn parse_spawn_payload_tag_absent_is_none() {
        let payload =
            br#"{"card_id":"c1","tug_session_id":"s1","project_dir":"/p","session_mode":"new"}"#;
        let parsed = parse_control_payload_owned(payload).expect("parse");
        assert_eq!(parsed.tag, None);
    }

    #[test]
    fn session_updated_frame_carries_tag() {
        let row = crate::session_ledger::SessionRow {
            session_id: "s1".to_owned(),
            workspace_key: "ws".to_owned(),
            project_dir: "/p".to_owned(),
            created_at: 0,
            last_used_at: 0,
            turn_count: 0,
            last_user_prompt: None,
            state: crate::session_ledger::SessionState::Live,
            card_id: Some("c1".to_owned()),
            name: None,
            name_user_set: false,
            tag: Some("azure-heron".to_owned()),
            private: false,
            synopsis: Some("Repair ligature fallback in monospace".to_owned()),
            arc_id: None,
            arc_name: None,
            line_id: String::new(),
            background: false,
        };
        let frame = build_session_updated_frame(&row, None, None);
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).expect("json");
        assert_eq!(body["fields"]["tag"], "azure-heron");
        // The description rides the same push as the callsign, so a written
        // synopsis reaches every live surface without a re-listing.
        assert_eq!(
            body["fields"]["synopsis"],
            "Repair ligature fallback in monospace"
        );
    }

    #[test]
    fn session_updated_frame_carries_the_scan_pair_when_it_has_one() {
        let row = crate::session_ledger::SessionRow {
            session_id: "s1".to_owned(),
            workspace_key: "ws".to_owned(),
            project_dir: "/p".to_owned(),
            created_at: 0,
            last_used_at: 0,
            // The sparse `0` a session whose real count only ever came from a
            // scan carries on its `sessions` row.
            turn_count: 0,
            last_user_prompt: None,
            state: crate::session_ledger::SessionState::Live,
            card_id: Some("c1".to_owned()),
            name: None,
            name_user_set: false,
            tag: None,
            synopsis: None,
            private: false,
            arc_id: None,
            arc_name: None,
            line_id: String::new(),
            background: false,
        };

        // No scan-cache row: a null size, and the ledger's own count stands.
        let body: serde_json::Value =
            serde_json::from_slice(&build_session_updated_frame(&row, None, None).payload)
                .expect("json");
        assert!(body["fields"]["file_size"].is_null());
        assert_eq!(body["fields"]["turn_count"], 0);

        // With one, both facts come from the scan — which is what keeps an
        // unrelated push from blanking the size or zeroing the count.
        let metrics = crate::session_ledger::SessionScanMetrics {
            file_size: 48_192,
            turn_count: 7,
        };
        let body: serde_json::Value =
            serde_json::from_slice(&build_session_updated_frame(&row, Some(metrics), None).payload)
                .expect("json");
        assert_eq!(body["fields"]["file_size"], 48_192);
        assert_eq!(body["fields"]["turn_count"], 7);
    }

    #[test]
    fn session_updated_frame_carries_usage_beside_the_row() {
        let row = crate::session_ledger::SessionRow {
            session_id: "s1".to_owned(),
            workspace_key: "ws".to_owned(),
            project_dir: "/p".to_owned(),
            created_at: 0,
            last_used_at: 0,
            turn_count: 0,
            last_user_prompt: None,
            state: crate::session_ledger::SessionState::Live,
            card_id: Some("c1".to_owned()),
            name: None,
            name_user_set: false,
            tag: None,
            synopsis: None,
            private: false,
            arc_id: None,
            arc_name: None,
            line_id: String::new(),
            background: false,
        };

        // A segment with no telemetry says nothing rather than zero — the
        // difference the receipt's empty right-hand state is read off.
        let body: serde_json::Value =
            serde_json::from_slice(&build_session_updated_frame(&row, None, None).payload)
                .expect("json");
        assert!(body["usage"].is_null());

        let usage = crate::session_ledger::SessionUsage {
            turns: 10,
            tokens: 1_885_093,
            active_ms: 1_391_000,
        };
        let body: serde_json::Value =
            serde_json::from_slice(&build_session_updated_frame(&row, None, Some(usage)).payload)
                .expect("json");
        assert_eq!(body["usage"]["turns"], 10);
        assert_eq!(body["usage"]["tokens"], 1_885_093);
        assert_eq!(body["usage"]["active_ms"], 1_391_000);
    }

    // ---- Test-only ChildSpawner fakes ----

    /// Spawner that never resolves. Used as the default in tests so
    /// `spawn_session_worker` installs the per-session plumbing + publishes
    /// `SESSION_STATE = spawning` without the bridge task emitting any
    /// further frames. Any test that needs a specific bridge behavior passes
    /// its own spawner via [`make_supervisor_with_spawner`].
    struct StallSpawner;
    impl ChildSpawner for StallSpawner {
        fn spawn_child(
            &self,
            _project_dir: &std::path::Path,
            _session_id: &str,
            _session_mode: SessionMode,
            _resume_claude_session_id: Option<&str>,
            _permission_mode: Option<&str>,
            _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
        ) -> SpawnFuture {
            Box::pin(async { pending::<std::io::Result<SessionChild>>().await })
        }
    }

    fn stall_spawner_factory() -> SpawnerFactory {
        Arc::new(|| Arc::new(StallSpawner) as Arc<dyn ChildSpawner>)
    }

    // ---- Test helpers ----

    /// A sessions ledger holding two segments of one line — `parent` and the
    /// `fork` a rewind took from it. Neither supersedes the other: they are
    /// the same conversation under two ids, which is what the line says.
    fn forked_pair() -> Arc<crate::session_ledger::SessionLedger> {
        let sessions = Arc::new(
            crate::session_ledger::SessionLedger::open_in_memory().expect("sessions ledger"),
        );
        sessions
            .record_spawn("parent", "ws", "/proj", "card-1", 1_000, "line-1", None)
            .expect("parent spawn");
        sessions
            .record_spawn(
                "fork",
                "ws",
                "/proj",
                "card-1",
                2_000,
                "line-1",
                Some("stocky-pixie"),
            )
            .expect("fork spawn");
        sessions
            .set_fork_provenance("fork", "parent", Some("point-1"))
            .expect("provenance");
        sessions
    }

    /// Read CONTROL frames until one carries `action`, or fail.
    async fn next_action(
        control_rx: &mut broadcast::Receiver<Frame>,
        action: &str,
    ) -> serde_json::Value {
        for _ in 0..40 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), control_rx.recv())
                .await
                .expect("a control frame")
                .expect("sender alive");
            let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if body["action"] == action {
                return body;
            }
        }
        panic!("no {action} frame");
    }

    /// Shared valid directory for tests that need *some* `project_dir`
    /// but don't care which. `env!("CARGO_MANIFEST_DIR")` resolves at
    /// compile time to the crate root (`tugrust/crates/tugcast`), which
    /// always exists on every dev machine and in CI.
    fn test_project_dir() -> &'static str {
        env!("CARGO_MANIFEST_DIR")
    }

    fn make_supervisor_with_store() -> (
        AgentSupervisor,
        broadcast::Receiver<Frame>,
        broadcast::Receiver<Frame>,
        broadcast::Receiver<Frame>,
    ) {
        make_supervisor_with_store_config(AgentSupervisorConfig::default())
    }

    /// Variant that accepts a custom [`AgentSupervisorConfig`] — P13 tests
    /// use this to set tight `max_concurrent_sessions` /
    /// `max_spawns_per_minute` so the cap can be tripped with only a
    /// handful of spawn calls.
    fn make_supervisor_with_store_config(
        config: AgentSupervisorConfig,
    ) -> (
        AgentSupervisor,
        broadcast::Receiver<Frame>,
        broadcast::Receiver<Frame>,
        broadcast::Receiver<Frame>,
    ) {
        let ((sup, state_rx, meta_rx, control_rx), mut register_rx) =
            make_supervisor_with_spawner_config(stall_spawner_factory(), config);
        // Drain the merger register channel so `spawn_session_worker`'s
        // `merger_register_tx.send(...).await` succeeds without an actual
        // merger task attached. Dropping the receiver would short-circuit
        // the bridge wiring and suppress the `SESSION_STATE = spawning`
        // publish that existing tests rely on.
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });
        (sup, state_rx, meta_rx, control_rx)
    }

    /// Variant that also returns the merger register receiver so tests can
    /// spawn `merger_task` against it.
    #[allow(clippy::type_complexity)]
    fn make_supervisor_with_spawner(
        spawner_factory: SpawnerFactory,
    ) -> (
        (
            AgentSupervisor,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
        ),
        mpsc::Receiver<MergerRegistration>,
    ) {
        make_supervisor_with_spawner_config(spawner_factory, AgentSupervisorConfig::default())
    }

    #[allow(clippy::type_complexity)]
    fn make_supervisor_with_spawner_config(
        spawner_factory: SpawnerFactory,
        config: AgentSupervisorConfig,
    ) -> (
        (
            AgentSupervisor,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
        ),
        mpsc::Receiver<MergerRegistration>,
    ) {
        let (state_tx, state_rx) = broadcast::channel(512);
        let (meta_tx, meta_rx) = broadcast::channel(32);
        let (code_tx, _code_rx) = broadcast::channel(32);
        let (control_tx, control_rx) = broadcast::channel(512);
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let cancel = CancellationToken::new();
        let recorder: Arc<dyn SessionsRecorder> = Arc::new(NoopSessionsRecorder);
        // Hermetic terminal-registry default: tests must never read the
        // developer's real ~/.claude/sessions. Tests that exercise the
        // liveness gate inject their own tempdir root.
        let config = AgentSupervisorConfig {
            terminal_registry_root: Some(config.terminal_registry_root.unwrap_or_else(|| {
                std::path::PathBuf::from("/nonexistent/tugcast-test-terminal-registry")
            })),
            ..config
        };
        let (sup, register_rx) = AgentSupervisor::new(
            SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
            SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
            SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
            SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
            control_tx,
            recorder,
            spawner_factory,
            config,
            registry,
            cancel,
        );
        ((sup, state_rx, meta_rx, control_rx), register_rx)
    }

    fn spawn_payload(card_id: &str, tug_session_id: &str) -> Vec<u8> {
        spawn_payload_in(card_id, tug_session_id, test_project_dir())
    }

    fn spawn_payload_in(card_id: &str, tug_session_id: &str, project_dir: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
            "project_dir": project_dir,
            // A `mode=new` spawn births a line and the deck mints its id from
            // the drop ([P03]); one that names none is refused.
            "line_id": format!("line-{tug_session_id}"),
        }))
        .unwrap()
    }

    /// A `mode=new` spawn on a line the caller names — the shape a test
    /// needs when a later resume has to land on the same line.
    fn spawn_payload_on_line(card_id: &str, tug_session_id: &str, line_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
            "project_dir": test_project_dir(),
            "line_id": line_id,
        }))
        .unwrap()
    }

    fn resume_payload(card_id: &str, tug_session_id: &str) -> Vec<u8> {
        resume_payload_in(card_id, tug_session_id, test_project_dir())
    }

    fn resume_payload_in(card_id: &str, tug_session_id: &str, project_dir: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
            "project_dir": project_dir,
            "session_mode": "resume",
        }))
        .unwrap()
    }

    fn close_payload(card_id: &str, tug_session_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "close_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
        }))
        .unwrap()
    }

    fn reset_payload(card_id: &str, tug_session_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "reset_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
        }))
        .unwrap()
    }

    fn request_replay_payload(tug_session_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "request_replay",
            "tug_session_id": tug_session_id,
        }))
        .unwrap()
    }

    fn session_state_of(frame: &Frame) -> (String, String) {
        assert_eq!(frame.feed_id, FeedId::SESSION_STATE);
        let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        (
            v["tug_session_id"].as_str().unwrap().to_string(),
            v["state"].as_str().unwrap().to_string(),
        )
    }

    async fn insert_ledger_entry(
        sup: &AgentSupervisor,
        tug_session_id: &TugSessionId,
    ) -> Arc<Mutex<LedgerEntry>> {
        super::insert_ledger_entry_for_tests(sup, tug_session_id).await
    }

    fn fake_metadata_frame(tug_session_id: &str) -> Frame {
        let body = serde_json::json!({
            "type": "system_metadata",
            "tug_session_id": tug_session_id,
            "model": "claude-opus-4-6",
        });
        Frame::new(FeedId::SESSION_SIDEBAND, serde_json::to_vec(&body).unwrap())
    }

    // ---- dispatch_one / dispatcher_task ----

    fn code_input_frame(tug_session_id: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "user_message",
            "text": "hi",
        });
        Frame::new(FeedId::CODE_INPUT, serde_json::to_vec(&body).unwrap())
    }

    #[tokio::test]
    async fn test_dispatch_missing_tug_session_id_drops_silently() {
        // A CODE_INPUT payload that carries no `tug_session_id` field has
        // nothing to attribute a `session_unknown` CONTROL frame to, so the
        // dispatcher drops it (with a warn! log) rather than fabricate an
        // error frame. This test pins that behavior so a future "emit a
        // control frame on every drop" refactor can't silently add noise
        // on the CONTROL feed.
        let (sup, mut state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        // Payload with no `tug_session_id` field.
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "user_message",
            "text": "hi",
        }))
        .unwrap();
        sup.dispatch_one(Frame::new(FeedId::CODE_INPUT, payload))
            .await;

        assert!(
            control_rx.try_recv().is_err(),
            "missing tug_session_id must not emit a CONTROL frame"
        );
        assert!(
            state_rx.try_recv().is_err(),
            "missing tug_session_id must not emit a SESSION_STATE frame"
        );
        assert!(
            sup.ledger.lock().await.is_empty(),
            "missing tug_session_id must not mutate the ledger"
        );
    }

    #[tokio::test]
    async fn test_orphan_input_rejected() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.dispatch_one(code_input_frame("sess-unknown")).await;

        let ctrl = control_rx
            .try_recv()
            .expect("session_unknown control frame");
        assert_eq!(ctrl.feed_id, FeedId::CONTROL);
        let v: serde_json::Value = serde_json::from_slice(&ctrl.payload).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["detail"], "session_unknown");
        assert_eq!(v["tug_session_id"], "sess-unknown");

        // Ledger untouched — dispatching unknown input must not create an entry.
        assert!(sup.ledger.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_first_input_triggers_spawn() {
        // Under the aligned state model (B3 fix), dispatching the first
        // CODE_INPUT flips the ledger entry Idle → Spawning and calls
        // `spawn_session_worker`, which publishes the wire `spawning`
        // frame and installs `input_tx`. The ledger entry *stays* at
        // `Spawning` — promotion to `Live` is done by the bridge on
        // `session_init`, not eagerly by the worker. The StallSpawner
        // used in this test never produces `session_init`, so the state
        // remains `Spawning` and the queued first frame stays in the
        // queue (the bridge's session_init handler is the drain point).
        let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();
        let (_, pending_state) = session_state_of(&state_rx.try_recv().unwrap());
        assert_eq!(pending_state, "pending");

        sup.dispatch_one(code_input_frame("sess-1")).await;

        let (_, state) = session_state_of(&state_rx.try_recv().unwrap());
        assert_eq!(state, "spawning");
        assert!(
            state_rx.try_recv().is_err(),
            "no further SESSION_STATE frame until the bridge reads session_init"
        );

        let tug_id = TugSessionId::new("sess-1");
        let entry_arc = sup.ledger.lock().await.get(&tug_id).unwrap().clone();
        let entry = entry_arc.lock().await;
        assert_eq!(entry.spawn_state, SpawnState::Spawning);
        assert_eq!(
            entry.queue.len(),
            1,
            "first CODE_INPUT is buffered in the queue until session_init drains it"
        );
        assert!(entry.input_tx.is_some(), "worker installed input_tx");
    }

    #[tokio::test]
    async fn test_concurrent_first_inputs_spawn_once() {
        // Two CODE_INPUT frames back-to-back. The first flips Idle →
        // Spawning and spawns the worker; the second lands in the
        // dispatcher's `Spawning` branch and is buffered in the queue.
        // Under the aligned state model (B3 fix), the ledger state
        // remains `Spawning` until the bridge reads `session_init` —
        // StallSpawner never produces one, so both frames stay queued.
        let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();
        let _ = state_rx.try_recv().unwrap();

        sup.dispatch_one(code_input_frame("sess-1")).await;
        sup.dispatch_one(code_input_frame("sess-1")).await;

        let (_, state) = session_state_of(&state_rx.try_recv().unwrap());
        assert_eq!(state, "spawning");
        assert!(
            state_rx.try_recv().is_err(),
            "only a single `spawning` frame — no double-spawn"
        );

        let tug_id = TugSessionId::new("sess-1");
        let entry_arc = sup.ledger.lock().await.get(&tug_id).unwrap().clone();
        let entry = entry_arc.lock().await;
        assert_eq!(entry.spawn_state, SpawnState::Spawning);
        assert_eq!(
            entry.queue.len(),
            2,
            "both frames are buffered in the queue awaiting session_init"
        );
    }

    #[tokio::test]
    async fn test_queue_overflow_emits_backpressure() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        // Pin the entry to Spawning so the dispatcher buffers into the queue.
        // Insert the ledger entry directly rather than via `spawn_session` —
        // that path launches the real bridge, whose auth gate flips the entry
        // to Errored on a host with no logged-in `claude` (CI), racing the
        // dispatch loop below and starving the queue before it can overflow.
        let tug_id = TugSessionId::new("sess-1");
        let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
        }

        // First 256 frames fit.
        for _ in 0..256 {
            sup.dispatch_one(code_input_frame("sess-1")).await;
        }
        assert!(
            control_rx.try_recv().is_err(),
            "no backpressure within the 256-frame cap"
        );

        // The 257th frame overflows → emit session_backpressure CONTROL.
        sup.dispatch_one(code_input_frame("sess-1")).await;

        let ctrl = control_rx
            .try_recv()
            .expect("session_backpressure control frame");
        assert_eq!(ctrl.feed_id, FeedId::CONTROL);
        let v: serde_json::Value = serde_json::from_slice(&ctrl.payload).unwrap();
        assert_eq!(v["type"], "session_backpressure");
        assert_eq!(v["tug_session_id"], "sess-1");

        let entry_arc = sup.ledger.lock().await.get(&tug_id).unwrap().clone();
        let entry = entry_arc.lock().await;
        assert_eq!(entry.queue.len(), 256);
    }

    // ---- close/spawn race ([R06]) ----

    /// Pin for [R06]: concurrent `close_session` and `spawn_session` for the
    /// same `tug_session_id` from different clients must never leave the
    /// supervisor in a state where `client_sessions` references a
    /// `tug_session_id` that no longer has a ledger entry, nor leave a
    /// ledger entry whose only affinity is from the closing (not the
    /// spawning) client.
    ///
    /// Uses `flavor = "multi_thread"` so the two `tokio::spawn`ed tasks can
    /// actually interleave across threads at Tokio-mutex acquisition points.
    /// A single-threaded runtime would serialize the two tasks to
    /// completion and not exercise the race at all. The scenario is looped
    /// so CI has a chance to surface scheduling-dependent regressions; each
    /// iteration is independent with a fresh supervisor.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_close_spawn_race_does_not_leak_entry() {
        const ITERATIONS: usize = 64;

        for iter in 0..ITERATIONS {
            let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
            let sup = Arc::new(sup);

            // Pre-spawn from client 10 so both racers start from a populated
            // ledger entry; otherwise there's nothing for close to remove.
            sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
                .await
                .expect_handled();

            let sup_close = sup.clone();
            let sup_spawn = sup.clone();
            let close_task = tokio::spawn(async move {
                sup_close
                    .handle_control("close_session", &close_payload("card-1", "sess-1"), 10)
                    .await
            });
            let spawn_task = tokio::spawn(async move {
                sup_spawn
                    .handle_control("spawn_session", &spawn_payload("card-2", "sess-1"), 20)
                    .await
            });

            let close_result = close_task.await.expect("close task panic");
            let spawn_result = spawn_task.await.expect("spawn task panic");
            assert!(
                close_result.is_handled(),
                "close_task failed on iter {iter}"
            );
            assert!(
                spawn_result.is_handled(),
                "spawn_task failed on iter {iter}"
            );

            // Final-state self-consistency: either the ledger has the entry
            // AND only the spawn client has affinity, OR the ledger has no
            // entry AND neither client has affinity. No orphaned
            // client_sessions entries referring to a missing ledger entry.
            let ledger = sup.ledger.lock().await;
            let cs = sup.client_sessions.lock().await;
            let tug_id = TugSessionId::new("sess-1");

            let has_ledger_entry = ledger.contains_key(&tug_id);
            let client_10_has = cs.get(&10).is_some_and(|s| s.contains(&tug_id));
            let client_20_has = cs.get(&20).is_some_and(|s| s.contains(&tug_id));

            if has_ledger_entry {
                assert!(
                    client_20_has,
                    "iter {iter}: ledger has entry but spawn client (20) has no affinity"
                );
                assert!(
                    !client_10_has,
                    "iter {iter}: ledger has entry but close client (10) still has affinity"
                );
            } else {
                assert!(
                    !client_20_has,
                    "iter {iter}: ledger empty but spawn client (20) still has affinity"
                );
                assert!(
                    !client_10_has,
                    "iter {iter}: ledger empty but close client (10) still has affinity"
                );
            }
        }
    }

    // ---- on_client_disconnect ----

    // ---- default_spawner_factory does not close over project_dir ----

    #[test]
    fn test_default_spawner_factory_does_not_close_over_project_dir() {
        // Historically, `default_spawner_factory` captured both
        // `tugcode_path` and `project_dir` from the supervisor config and
        // baked them into each TugcodeSpawner instance. The spawner was
        // then made stateless with respect to `project_dir` — the field
        // was deleted from the spawner, `TugcodeSpawner::new` takes only
        // `tugcode_path`, and `spawn_child` accepts `project_dir` per
        // call. Later, `AgentSupervisorConfig::project_dir` was removed
        // entirely ([D12]). This test now relies on
        // the structural absence — if someone re-introduced a global
        // workspace path on the config, this test would need updating.
        use super::super::agent_bridge::build_tugcode_command;
        let config = AgentSupervisorConfig {
            tugcode_path: PathBuf::from("/opt/tugtool/tugcode"),
            ..Default::default()
        };
        let _factory = default_spawner_factory(&config);

        // The per-call `project_dir` is what flows into the command. Pass a
        // deliberately different workspace and verify the legacy config
        // path does not appear in the resolved argv.
        let (_program, args) = build_tugcode_command(
            &config.tugcode_path,
            std::path::Path::new("/workspace-B-from-per-call"),
            "sess-per-call",
            SessionMode::New,
            None,
            None,
            None,
        );
        assert!(
            args.iter().any(|a| a == "/workspace-B-from-per-call"),
            "per-call project_dir must appear in argv: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "/workspace-A-should-be-ignored"),
            "config.project_dir must NOT appear in argv: {args:?}"
        );
    }

    // ---- rebind tests ----

    /// The window this whole mechanism exists for, driven with the frames the
    /// wire actually carries (the `v2.1.173-jobs-spike` lifecycle): a `Bash`
    /// backgrounded mid-turn, the turn ending, and the job reporting later.
    #[tokio::test]
    async fn a_background_job_outlives_its_turn_and_holds_the_session_unquiet() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-jobs", "sess-jobs"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-jobs");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"just app-test","task_type":"local_bash","ipc_version":2}"#;
        let completed =
            br#"{"type":"task_updated","session_id":"c","task_id":"t1","status":"completed","ipc_version":2}"#;

        // Launched mid-turn.
        entry.lock().await.turn_active = true;
        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"just app-test","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        assert!(!sup.apply_job_edge(&id, started).await);

        // The model stops speaking. The sweep does not.
        entry.lock().await.turn_active = false;
        assert!(
            !entry.lock().await.is_quiet(),
            "the turn ended, so a reader that asked only about the turn would \
             offer this arc for joining right here"
        );

        // The job reports, and only now is the session finished. The `true`
        // is what releases the work parked behind it.
        assert!(sup.apply_job_edge(&id, completed).await);
        assert!(entry.lock().await.is_quiet());
    }

    // ── the arc's turn boundary (W8) ─────────────────────────────────────────

    /// The one fact the PreToolUse hook cannot have: which turn a step was
    /// closed in. The verb reports it, the gate asks, and it lives exactly as
    /// long as the turn does.
    #[tokio::test]
    async fn a_closed_step_is_the_turns_and_is_forgotten_when_the_turn_ends() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-bound", "sess-bound"),
            10,
        )
        .await
        .expect_handled();

        assert_eq!(sup.step_closed_this_turn("sess-bound").await, None);
        assert!(sup.mark_step_closed_this_turn("sess-bound", 1).await);
        assert_eq!(sup.step_closed_this_turn("sess-bound").await, Some(1));

        // The turn boundary the arc demands: whatever this turn closed is
        // no longer this turn's business, and the gate opens again.
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("sess-bound"))
                .unwrap()
                .clone()
        };
        entry.lock().await.step_closed_this_turn = None;
        assert_eq!(sup.step_closed_this_turn("sess-bound").await, None);
    }

    /// The step boundary is a work boundary: the jobs the closing step
    /// launched are ended by the close, named back to the verb that made it,
    /// and each confirmed one gets a `stop_task` on the wire.
    #[tokio::test]
    async fn a_step_close_ends_the_sessions_open_jobs_and_names_them() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-esj", "sess-esj"), 10)
            .await
            .expect_handled();
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&TugSessionId::new("sess-esj")).unwrap().clone()
        };
        {
            let now = std::time::Instant::now();
            let mut guard = entry.lock().await;
            guard.open_jobs.insert("task-a".to_string(), bash_job(now));
            guard.open_jobs.insert("task-b".to_string(), bash_job(now));
            guard
                .open_jobs
                .insert(launch_key("toolu_pending"), bash_job(now));
        }

        let ended = sup.end_step_jobs("sess-esj").await;
        assert_eq!(
            ended,
            vec![
                launch_key("toolu_pending"),
                "task-a".to_string(),
                "task-b".to_string(),
            ],
            "every key that was open is named, provisional ones included",
        );
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "the ledger stops believing the jobs first — a job that declines \
             to answer must not be able to hold the arc open",
        );

        // One `stop_task` per confirmed key, and none for the provisional
        // one, which has no task id to name.
        let mut guard = entry.lock().await;
        let mut stopped: Vec<String> = Vec::new();
        while let Some(frame) = guard.queue.pop() {
            let payload: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            assert_eq!(payload["type"], "stop_task");
            assert_eq!(payload["tug_session_id"], "sess-esj");
            stopped.push(payload["task_id"].as_str().unwrap().to_string());
        }
        stopped.sort();
        assert_eq!(stopped, vec!["task-a".to_string(), "task-b".to_string()]);
    }

    /// The edge is reached on every close, and a close over a card with
    /// nothing open is a no-op that still answers — an empty vec rather than a
    /// silence the verb would have to guess at.
    #[tokio::test]
    async fn a_step_close_on_a_card_with_no_jobs_is_a_no_op_that_still_says_so() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-esj-0", "sess-esj-0"),
            10,
        )
        .await
        .expect_handled();

        assert!(sup.end_step_jobs("sess-esj-0").await.is_empty());
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("sess-esj-0"))
                .unwrap()
                .clone()
        };
        assert!(
            entry.lock().await.queue.is_empty(),
            "nothing was open, so nothing is stopped",
        );
        // And a card this supervisor holds no entry for is simply not found —
        // the same degrade-open direction `mark_step_closed_this_turn` takes.
        assert!(sup.end_step_jobs("nobody").await.is_empty());
    }

    /// The hang this exists to end: the turn is over and one job is still
    /// open, so the session reads busy and the wheel waits on it. The close
    /// makes the session quiet and releases the work parked behind it on the
    /// same channels a job's own terminal edge would have.
    #[tokio::test]
    async fn a_step_close_with_the_turn_ended_releases_the_quiet_edge() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let (arc_tick_tx, mut arc_tick_rx) = mpsc::channel(4);
        let (turn_complete_tx, mut turn_complete_rx) = mpsc::channel(4);
        sup.arc_tick_tx.set(arc_tick_tx).unwrap();
        sup.turn_complete_tx.set(turn_complete_tx).unwrap();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-esj-q", "sess-esj-q"),
            10,
        )
        .await
        .expect_handled();
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("sess-esj-q"))
                .unwrap()
                .clone()
        };
        {
            let mut guard = entry.lock().await;
            guard.turn_active = false;
            guard
                .open_jobs
                .insert("task-slow".to_string(), bash_job(std::time::Instant::now()));
            assert!(
                !guard.is_quiet(),
                "the turn ended and the job did not — this is the wait",
            );
        }

        assert_eq!(sup.end_step_jobs("sess-esj-q").await, vec!["task-slow"]);
        assert!(entry.lock().await.is_quiet());
        assert_eq!(arc_tick_rx.try_recv(), Ok("sess-esj-q".to_string()));
        assert_eq!(turn_complete_rx.try_recv(), Ok("sess-esj-q".to_string()));
    }

    /// The job's kind is recorded at the **launch**, which is the only frame
    /// that names the tool, and the `task_started` re-key carries it across —
    /// so the wait sentence names the tool the user typed for the whole life of
    /// the job, including the provisional window before its confirmation
    /// ([P03]).
    #[tokio::test]
    async fn a_launch_records_the_jobs_kind_and_the_re_key_carries_it() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-kind", "sess-kind"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-kind");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"just app-test","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        assert_eq!(
            entry.lock().await.open_jobs[&launch_key("toolu_1")].kind,
            JobKind::Bash,
            "the provisional entry is named from the launch, not from a \
             confirmation that has not arrived",
        );

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"just app-test","task_type":"local_bash","ipc_version":2}"#;
        sup.apply_job_edge(&id, started).await;
        assert_eq!(entry.lock().await.open_jobs["t1"].kind, JobKind::Bash);
    }

    /// A `Monitor` call is background work by nature and carries no
    /// `run_in_background`; a tool nothing here anticipated keeps its own name
    /// rather than collapsing to "unknown", so a wait sentence about it is
    /// still one the user can act on.
    #[test]
    fn a_launch_names_its_tool_and_an_unknown_one_keeps_its_name() {
        let monitor = br#"{"type":"tool_use","tool_name":"Monitor","tool_use_id":"toolu_m","input":{},"ipc_version":2}"#;
        assert_eq!(
            parse_background_launch(monitor),
            Some(("toolu_m".to_string(), JobKind::Monitor)),
        );
        let agent = br#"{"type":"tool_use","tool_name":"Agent","tool_use_id":"toolu_a","input":{"run_in_background":true},"ipc_version":2}"#;
        assert_eq!(
            parse_background_launch(agent),
            Some(("toolu_a".to_string(), JobKind::Agent)),
        );
        let novel = br#"{"type":"tool_use","tool_name":"Telescope","tool_use_id":"toolu_t","input":{"run_in_background":true},"ipc_version":2}"#;
        assert_eq!(
            parse_background_launch(novel),
            Some((
                "toolu_t".to_string(),
                JobKind::Other("telescope".to_string())
            )),
        );
        assert_eq!(
            JobKind::Other("telescope".to_string()).as_str(),
            "telescope"
        );
        // A foreground call is still no launch at all.
        let foreground = br#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_f","input":{"command":"ls"},"ipc_version":2}"#;
        assert_eq!(parse_background_launch(foreground), None);
    }

    /// A `task_started` whose launch the close already ended opens nothing.
    /// The gate in `apply_job_edge` is keyed to the provisional entry, so
    /// draining the set is what makes a late confirmation harmless rather than
    /// a job reopened past its own step.
    #[tokio::test]
    async fn a_task_started_after_its_launch_was_ended_opens_nothing() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-esj-l", "sess-esj-l"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-esj-l");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };

        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"just app-test","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        assert_eq!(entry.lock().await.open_jobs.len(), 1);

        assert_eq!(
            sup.end_step_jobs("sess-esj-l").await,
            vec![launch_key("toolu_1")],
        );

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"a sweep","task_type":"local_agent","ipc_version":2}"#;
        assert!(!sup.apply_job_edge(&id, started).await);
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "the launch is gone, so its confirmation is the unmatched shape \
             the gate refuses — not a job reopened past its own step",
        );
    }

    /// A rotation mints a segment; the card's address does not move. So a
    /// close reported under the fresh segment has to reach the card's entry —
    /// the walk Part XI item 1 found `bound_arcs` missing, one layer over.
    #[tokio::test]
    async fn a_rotated_segment_still_finds_the_card_it_runs_on() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-rot", "sess-rot"), 10)
            .await
            .expect_handled();
        {
            let ledger = sup.ledger.lock().await;
            let entry = ledger.get(&TugSessionId::new("sess-rot")).unwrap().clone();
            drop(ledger);
            entry.lock().await.claude_session_id = Some("segment-2".to_string());
        }

        assert!(sup.mark_step_closed_this_turn("segment-2", 3).await);
        assert_eq!(
            sup.step_closed_this_turn("sess-rot").await,
            Some(3),
            "the fresh segment and the card's own id are one entry",
        );
        // And a segment nothing here wears is simply not found — which
        // degrades the gate open, the only direction it may fail in.
        assert!(!sup.mark_step_closed_this_turn("nobody", 1).await);
        assert_eq!(sup.step_closed_this_turn("nobody").await, None);
    }

    /// A replayed transcript's historical `task_started` frames describe jobs
    /// that died with the session that ran them. Folding them in would open
    /// jobs nothing can ever close, leaving the arc permanently unjoinable.
    #[tokio::test]
    async fn a_wake_closes_the_job_whose_notification_woke_the_turn() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-wake", "sess-wake"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-wake");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"an Agent","task_type":"local_agent","ipc_version":2}"#;
        let wake = br#"{"type":"wake_started","session_id":"c","wake_trigger":{"task_id":"t1","tool_use_id":"toolu_1","status":"completed","summary":"done","output_file":""},"ipc_version":2}"#;

        entry.lock().await.turn_active = true;
        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Agent","tool_use_id":"toolu_1","input":{"prompt":"sweep","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        assert!(!sup.apply_job_edge(&id, started).await);

        // Both halves of the path, because widening the parse alone leaves the
        // new arm unreachable: the frame loop only reaches `apply_job_edge`
        // through the needle gate.
        assert!(
            is_task_edge(wake),
            "the needle gate is what lets a wake reach the fold at all"
        );
        sup.apply_job_edge(&id, wake).await;
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "the job's only terminal was its notification, and the wake carries it"
        );
    }

    /// The 2026-09-21 stall: a backgrounded Bash call the PreToolUse gate
    /// denied never ran, so no `task_started` followed and its provisional
    /// job held the session busy for the whole reap horizon. Its errored
    /// `tool_result` is the close — and an errored result behind a *confirmed*
    /// job closes nothing, because that job is still running.
    #[tokio::test]
    async fn an_errored_result_closes_the_launch_that_never_ran() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-denied", "sess-denied"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-denied");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };

        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"mv \"$CACHE\" x","run_in_background":true},"ipc_version":2}"#;
        let denied = br#"{"type":"tool_result","tool_use_id":"toolu_1","output":"operand `$CACHE` is not a literal path.","is_error":true,"ipc_version":2}"#;
        let fine = br#"{"type":"tool_result","tool_use_id":"toolu_1","output":"Command running in background","is_error":false,"ipc_version":2}"#;

        sup.record_job_launch(&id, launch).await;
        assert!(!entry.lock().await.is_quiet(), "the launch arms the latch");
        assert!(!sup.close_failed_launch(&id, fine).await);
        assert_eq!(
            entry.lock().await.open_jobs.len(),
            1,
            "a clean result is a launch still awaiting its task_started"
        );
        assert!(is_tool_result(denied), "the needle gate reaches the fold");
        assert!(sup.close_failed_launch(&id, denied).await);
        assert!(entry.lock().await.open_jobs.is_empty());

        // A confirmed job is keyed by task id, and an errored result behind
        // it is not its terminal.
        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"a sweep","task_type":"local_bash","ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        sup.apply_job_edge(&id, started).await;
        assert!(!sup.close_failed_launch(&id, denied).await);
        assert_eq!(entry.lock().await.open_jobs.len(), 1);
    }

    /// A `task_progress` heartbeat proves the job alive: it moves the stamp,
    /// and the moved stamp is what keeps the reaper off work that is
    /// genuinely still running.
    #[tokio::test]
    async fn a_progress_tick_defers_the_reap() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-tick", "sess-tick"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-tick");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };

        // A job whose last sign of life was a second ago.
        let old = std::time::Instant::now() - Duration::from_secs(1);
        entry
            .lock()
            .await
            .open_jobs
            .insert("t1".to_owned(), bash_job(old));

        let tick = br#"{"type":"task_progress","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"working","ipc_version":2}"#;
        sup.refresh_job_stamp(&id, tick).await;
        assert!(
            entry.lock().await.open_jobs.get("t1").unwrap().since > old,
            "the heartbeat moved the stamp"
        );

        // A reap that would have taken the un-ticked job leaves this one.
        let mut guard = entry.lock().await;
        guard.turn_active = false;
        guard.reap_stuck_jobs(old + JOB_REAP_HORIZON + Duration::from_millis(500));
        assert_eq!(guard.open_jobs.len(), 1, "a ticked job is alive, not stuck");
    }

    /// The incident's shape (the capture's foreground-Agent phase): the
    /// launching call carries no `run_in_background`, its `task_started` is
    /// byte-identical to a background one, and no `task_updated` ever
    /// follows. Opening it wedges the session busy forever, so the gate must
    /// refuse it.
    #[tokio::test]
    async fn a_foreground_launch_opens_no_job() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-fg", "sess-fg"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-fg");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        // The foreground Agent call — observed, and rightly not recorded.
        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Agent","tool_use_id":"toolu_fg","input":{"prompt":"review this"},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t9","tool_use_id":"toolu_fg","description":"a subagent","task_type":"local_agent","ipc_version":2}"#;
        assert!(!sup.apply_job_edge(&id, started).await);
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "a foreground subagent's task is the turn's own work, not a background job"
        );

        // The turn ends with no job held open — the session is quiet, not
        // wedged behind an entry nothing will ever close.
        entry.lock().await.turn_active = false;
        assert!(entry.lock().await.is_quiet());
    }

    /// The two launches the deck counts: an explicitly backgrounded call, and
    /// a `Monitor`, which is background activity by nature (no flag involved).
    #[tokio::test]
    async fn backgrounded_and_monitor_launches_both_open() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-bg", "sess-bg"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-bg");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        let bash_launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_b","input":{"command":"cargo nextest run","run_in_background":true},"ipc_version":2}"#;
        let monitor_launch = br#"{"type":"tool_use","msg_id":"m1","seq":2,"tool_name":"Monitor","tool_use_id":"toolu_m","input":{"command":"tail -f build.log"},"ipc_version":2}"#;
        sup.record_job_launch(&id, bash_launch).await;
        sup.record_job_launch(&id, monitor_launch).await;

        let bash_started = br#"{"type":"task_started","session_id":"c","task_id":"tb","tool_use_id":"toolu_b","description":"cargo nextest run","task_type":"local_bash","ipc_version":2}"#;
        let monitor_started = br#"{"type":"task_started","session_id":"c","task_id":"tm","tool_use_id":"toolu_m","description":"tail -f build.log","task_type":"local_bash","ipc_version":2}"#;
        assert!(!sup.apply_job_edge(&id, bash_started).await);
        assert!(!sup.apply_job_edge(&id, monitor_started).await);
        assert_eq!(
            entry.lock().await.open_jobs.len(),
            2,
            "both launches the deck counts open here too"
        );
    }

    /// **[P04], and the incident's own gap.** The window `open_jobs` covers
    /// starts at the launch, not at the `task_started` that confirms it. Six
    /// background completions each lived in that gap: the launching turn had
    /// ended, nothing was confirmed open, and the runner read a session that
    /// was plainly working as idle.
    #[tokio::test]
    async fn a_launch_holds_the_session_busy_until_its_wake() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-l", "sess-l"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-l");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        // The launch alone — no `task_started` at all, which is the shape
        // Risk R02 accepts and this latch is what bounds.
        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"sleep 8 && echo background-done","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;

        // The turn ends. This is the reading the incident got wrong.
        entry.lock().await.turn_active = false;
        assert!(
            !entry.lock().await.is_quiet(),
            "the launching turn ended, but the work it started has not reported",
        );

        // The wake — the model speaking again, which is what ends the gap.
        let wake = br#"{"type":"wake_started","session_id":"c","wake_trigger":{"task_id":"t1","tool_use_id":"toolu_1","status":"completed","summary":"done","output_file":""},"ipc_version":2}"#;
        sup.apply_job_edge(&id, wake).await;
        // The wake reopens the turn on the live path; the test drives the
        // fold directly, so it says so itself and then ends that turn.
        entry.lock().await.turn_active = false;
        assert!(
            entry.lock().await.is_quiet(),
            "the wake retired the latch, so the session is finished",
        );
    }

    /// A `task_started` confirming a launch is a **re-key**, not a second
    /// open: the provisional entry leaves and the `task_id` arrives carrying
    /// the launch's own stamp, so the reaper clocks the job from when it
    /// began rather than from when it was confirmed.
    #[tokio::test]
    async fn a_task_started_rekeys_the_launch_it_confirms() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-r", "sess-r"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-r");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"just app-test","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;
        let launched = entry.lock().await.open_jobs[&launch_key("toolu_1")].clone();

        let started = br#"{"type":"task_started","session_id":"c","task_id":"t1","tool_use_id":"toolu_1","description":"just app-test","task_type":"local_bash","ipc_version":2}"#;
        assert!(!sup.apply_job_edge(&id, started).await);
        {
            let entry = entry.lock().await;
            assert_eq!(
                entry.open_jobs.keys().collect::<Vec<_>>(),
                vec!["t1"],
                "one job, under its task id and no longer under the launch",
            );
            assert_eq!(
                entry.open_jobs["t1"], launched,
                "the launch's stamp and its kind carried across, so the reap \
                 clock did not restart and the wait sentence still names the tool",
            );
        }

        let completed = br#"{"type":"task_updated","session_id":"c","task_id":"t1","status":"completed","ipc_version":2}"#;
        entry.lock().await.turn_active = false;
        assert!(sup.apply_job_edge(&id, completed).await);
        assert!(entry.lock().await.is_quiet());
    }

    /// A wake retires **every** provisional launch, not only one it names.
    /// The model is speaking again, so the gap each latch was holding open is
    /// over — and a launch whose `task_started` never came would otherwise
    /// sit until the reaper, reading busy through turns it was plainly
    /// working.
    #[tokio::test]
    async fn a_wake_closes_every_provisional_launch() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-w", "sess-w"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-w");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        let one = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Bash","tool_use_id":"toolu_a","input":{"command":"a","run_in_background":true},"ipc_version":2}"#;
        let two = br#"{"type":"tool_use","msg_id":"m1","seq":2,"tool_name":"Bash","tool_use_id":"toolu_b","input":{"command":"b","run_in_background":true},"ipc_version":2}"#;
        sup.record_job_launch(&id, one).await;
        sup.record_job_launch(&id, two).await;
        assert_eq!(entry.lock().await.open_jobs.len(), 2);

        // The scheduler's own re-init wake: it names no job at all, and it
        // still ends the gap.
        let wake = br#"{"type":"wake_started","session_id":"c","wake_trigger":{"task_id":"","tool_use_id":"","status":"completed","summary":"scheduled wake","output_file":""},"ipc_version":2}"#;
        sup.apply_job_edge(&id, wake).await;
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "a wake naming neither launch still retires both",
        );
    }

    /// Risk R02's bound. A `Monitor` whose `task_started` never arrives holds
    /// the session busy — that is the point — but the reaper treats its
    /// provisional key like any other, so the hold ends at the horizon rather
    /// than lasting forever. Degrade to *late*, never to *never*.
    #[tokio::test]
    async fn a_launch_whose_task_never_starts_is_reaped() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-p", "sess-p"), 10)
            .await
            .expect_handled();
        let id = TugSessionId::new("sess-p");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.turn_active = true;

        let launch = br#"{"type":"tool_use","msg_id":"m1","seq":1,"tool_name":"Monitor","tool_use_id":"toolu_m","input":{"command":"tail -f build.log"},"ipc_version":2}"#;
        sup.record_job_launch(&id, launch).await;

        let mut entry = entry.lock().await;
        entry.turn_active = false;
        assert!(!entry.is_quiet(), "the hold is real while the horizon runs");

        let now = std::time::Instant::now();
        entry.reap_stuck_jobs(now + JOB_REAP_HORIZON + Duration::from_secs(1));
        assert!(
            entry.open_jobs.is_empty(),
            "a provisional key is reaped like any other — the hold is bounded",
        );
        assert!(entry.is_quiet());
    }

    /// A replayed transcript's historical `task_started` frames describe jobs
    /// that died with the session that ran them. Folding them in would open
    /// jobs nothing can ever close, leaving the arc permanently unjoinable.
    #[tokio::test]
    async fn a_replayed_job_launch_opens_nothing() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-replay", "sess-replay"),
            10,
        )
        .await
        .expect_handled();
        let id = TugSessionId::new("sess-replay");
        let entry = {
            let ledger = sup.ledger.lock().await;
            ledger.get(&id).unwrap().clone()
        };
        entry.lock().await.replay_brackets_open = 1;

        let started = br#"{"type":"task_started","session_id":"c","task_id":"old","tool_use_id":"toolu_9","description":"an old sweep","task_type":"local_bash","ipc_version":2}"#;
        assert!(!sup.apply_job_edge(&id, started).await);
        assert!(
            entry.lock().await.open_jobs.is_empty(),
            "a replayed launch is history, not work in flight"
        );
    }

    /// Defense-in-depth must NOT fire when the entry
    /// is past `Idle` (i.e., the bridge has already spawned tugcode).
    /// Silently switching the mode of a running subprocess would
    /// misrepresent live state — the existing `effective_mode` ack
    /// computation already gates on this, and we mirror the gate here.
    #[tokio::test]
    async fn test_defense_in_depth_does_not_override_running_session() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        // Fresh spawn in `new` mode. After `handle_control`, the entry
        // is `Spawning` (eager-spawn promoted it). A subsequent
        // reconnect with mode=resume must NOT flip the entry's mode.
        sup.handle_control(
            "spawn_session",
            &spawn_payload("card-dev", "sess-running"),
            10,
        )
        .await
        .expect_handled();

        let id = TugSessionId::new("sess-running");
        {
            let ledger = sup.ledger.lock().await;
            let entry = ledger.get(&id).unwrap().clone();
            let entry = entry.lock().await;
            assert_ne!(
                entry.spawn_state,
                SpawnState::Idle,
                "eager-spawn promotes Idle→Spawning before
                 do_spawn_session returns; the defense-in-depth gate \
                 must observe a non-Idle state below"
            );
            assert_eq!(entry.session_mode, SessionMode::New);
        }

        // Reconnect from a different client requesting resume. The
        // defense-in-depth must skip because the entry is no longer
        // Idle.
        sup.handle_control(
            "spawn_session",
            &resume_payload("card-dev", "sess-running"),
            11,
        )
        .await
        .expect_handled();

        let ledger = sup.ledger.lock().await;
        let entry = ledger.get(&id).unwrap().clone();
        drop(ledger);
        let entry = entry.lock().await;
        assert_eq!(
            entry.session_mode,
            SessionMode::New,
            "defense-in-depth must NOT switch the mode of a running \
             session — the bridge has already spawned tugcode with the \
             original mode and the running subprocess is load-bearing. \
             The gate is `spawn_state == Idle`.",
        );
    }

    // ---- merger_task, per-session bridge, metadata routing ----

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn test_merger_fans_in_two_sessions() {
        // Spin up two per-session output mpscs, register both with the
        // merger, push one frame through each, and assert both frames
        // reach the shared CODE_OUTPUT broadcast. This pins the merger's
        // StreamMap-based fan-in.
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let mut code_rx = sup.code_output.subscribe();
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id_a = TugSessionId::new("sess-a");
        let id_b = TugSessionId::new("sess-b");

        let (tx_a, rx_a) = mpsc::channel::<Frame>(4);
        let (tx_b, rx_b) = mpsc::channel::<Frame>(4);
        sup.merger_register_tx
            .send((id_a.clone(), rx_a))
            .await
            .unwrap();
        sup.merger_register_tx
            .send((id_b.clone(), rx_b))
            .await
            .unwrap();

        let frame_a = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-a","type":"x"}"#.to_vec(),
        );
        let frame_b = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-b","type":"y"}"#.to_vec(),
        );
        tx_a.send(frame_a.clone()).await.unwrap();
        tx_b.send(frame_b.clone()).await.unwrap();

        let first = tokio::time::timeout(Duration::from_millis(500), code_rx.recv())
            .await
            .expect("first frame timeout")
            .expect("first frame recv err");
        let second = tokio::time::timeout(Duration::from_millis(500), code_rx.recv())
            .await
            .expect("second frame timeout")
            .expect("second frame recv err");

        let payloads: HashSet<Vec<u8>> = [first.payload, second.payload].into_iter().collect();
        assert!(
            payloads.contains(&frame_a.payload),
            "session A frame missing from CODE_OUTPUT broadcast"
        );
        assert!(
            payloads.contains(&frame_b.payload),
            "session B frame missing from CODE_OUTPUT broadcast"
        );

        cancel.cancel();
        let _ = merger_handle.await;
    }

    #[tokio::test]
    async fn test_merger_diverts_activity_delta_to_activity_feed() {
        // Pins Step 7 ([P13]/[P15]): an `activity_delta` line arriving on a
        // session's stdout is DIVERTED onto the ACTIVITY feed — re-tagged
        // `FeedId::ACTIVITY`, session tag preserved — and never rides the
        // CODE_OUTPUT broadcast. A following ordinary frame proves the
        // stream keeps flowing on CODE_OUTPUT after the divert.
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let mut activity_rx = sup.activity.subscribe();
        let mut code_rx = sup.code_output.subscribe();
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-act");
        let (tx, rx) = mpsc::channel::<Frame>(4);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        // The activity frame arrives already tagged CODE_OUTPUT (relay's
        // splice) with `tug_session_id` as the first field, exactly as the
        // live producer (#step-8) emits it.
        let activity_frame = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-act","type":"activity_delta","channels":{"text":42}}"#
                .to_vec(),
        );
        let ordinary_frame = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-act","type":"assistant_text"}"#.to_vec(),
        );
        tx.send(activity_frame.clone()).await.unwrap();
        tx.send(ordinary_frame.clone()).await.unwrap();

        // The diverted frame lands on ACTIVITY, re-tagged, splice intact.
        let diverted = tokio::time::timeout(Duration::from_millis(500), activity_rx.recv())
            .await
            .expect("activity frame timeout")
            .expect("activity frame recv err");
        assert_eq!(diverted.feed_id, FeedId::ACTIVITY);
        assert_eq!(diverted.payload, activity_frame.payload);

        // CODE_OUTPUT sees ONLY the ordinary frame — the activity_delta was
        // diverted, not copied, so the very first CODE_OUTPUT frame is the
        // ordinary one.
        let on_code = tokio::time::timeout(Duration::from_millis(500), code_rx.recv())
            .await
            .expect("code frame timeout")
            .expect("code frame recv err");
        assert_eq!(
            on_code.payload, ordinary_frame.payload,
            "activity_delta must not ride CODE_OUTPUT"
        );

        cancel.cancel();
        let _ = merger_handle.await;
    }

    #[tokio::test]
    async fn test_turn_active_gates_the_sampler_snapshot() {
        // Pins the beat work-attribution gate: `live_session_processes`
        // reports a session only while a turn is in flight. A closing
        // `turn_complete` through the merger ends attribution (so an idle
        // session's CPU/disk read zero); `wake_started` re-opens it; a
        // replayed historical closer (bracket open) must NOT end a live turn.
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-turn");
        insert_ledger_entry(&sup, &id).await;
        let entry_arc = sup.ledger.lock().await.get(&id).cloned().unwrap();
        {
            let mut entry = entry_arc.lock().await;
            entry.child_pid = Some(4242);
            entry.child_start_time = Some(1_000);
            entry.turn_active = true;
        }
        assert_eq!(sup.live_session_processes().await.len(), 1);

        let (tx, rx) = mpsc::channel::<Frame>(8);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        // The live closer ends attribution.
        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-turn","type":"turn_complete","msg_id":"m","seq":1}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { !entry_arc.lock().await.turn_active }
        })
        .await;
        assert!(sup.live_session_processes().await.is_empty());

        // A wake turn re-opens attribution without an inbound user_message.
        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-turn","type":"wake_started","session_id":"x"}"#.to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turn_active }
        })
        .await;
        assert_eq!(sup.live_session_processes().await.len(), 1);

        // A replayed closer inside an open bracket must not end the turn.
        // Subscribe to CODE_OUTPUT first: receiving the closer back off the
        // broadcast proves the merger has fully processed it (turn frames
        // forward to CODE_OUTPUT; only activity_delta diverts).
        let mut code_rx = sup.code_output.subscribe();
        entry_arc.lock().await.replay_brackets_open = 1;
        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-turn","type":"turn_complete","msg_id":"old","seq":0}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_millis(500), code_rx.recv())
            .await
            .expect("bracketed closer timeout")
            .expect("bracketed closer recv err");
        assert!(
            entry_arc.lock().await.turn_active,
            "a bracketed (replayed) turn_complete must not end a live turn"
        );

        cancel.cancel();
        let _ = merger_handle.await;
    }

    /// **The wedge the incident actually saw ([B01]).** A resumed transcript
    /// that carries a wheel wake replays a `wake_started` whose own replayed
    /// `turn_complete` the turn-end branch discards — so the latch used to go
    /// up during replay with no turn left to bring it down, and the session
    /// read busy for the rest of tugcast's life. The guard makes the two
    /// branches symmetric; the bracket's close asserts the result.
    #[tokio::test]
    async fn a_replayed_wake_turn_leaves_the_entry_quiet_at_the_bracket_close() {
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-replay-wake");
        insert_ledger_entry(&sup, &id).await;
        let entry_arc = sup.ledger.lock().await.get(&id).cloned().unwrap();
        assert!(
            entry_arc.lock().await.is_quiet(),
            "a seated session is quiet"
        );

        let (tx, rx) = mpsc::channel::<Frame>(8);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        let send = |bytes: &'static [u8]| {
            let tx = tx.clone();
            async move {
                tx.send(Frame::new(FeedId::CODE_OUTPUT, bytes.to_vec()))
                    .await
                    .unwrap();
            }
        };

        // The transcript opens. Everything between here and the close
        // describes turns that ended with the session that ran them.
        send(br#"{"tug_session_id":"sess-replay-wake","type":"replay_started","ipc_version":2}"#)
            .await;
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.replay_brackets_open == 1 }
        })
        .await;

        // The wake the wheel sent months ago, and the turn end that answered
        // it. The end is discarded as replayed; so must the opener be.
        send(br#"{"tug_session_id":"sess-replay-wake","type":"wake_started","session_id":"x"}"#)
            .await;
        send(
            br#"{"tug_session_id":"sess-replay-wake","type":"turn_complete","msg_id":"old","seq":0}"#,
        )
        .await;

        // The close. Counting it back to zero is what proves both frames above
        // have been folded, since the merger takes them in order.
        send(br#"{"tug_session_id":"sess-replay-wake","type":"replay_complete","count":2,"ipc_version":2}"#)
            .await;
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.replay_brackets_open == 0 }
        })
        .await;

        let entry = entry_arc.lock().await;
        assert!(
            entry.is_quiet(),
            "a replayed wake turn must leave the entry exactly as quiet as it \
             was before the bracket opened",
        );
        assert_eq!(entry.turn_opener, None, "no turn, no opener");
        drop(entry);

        // And the session is not latched for the live turn that follows: a
        // real `wake_started` outside any bracket still opens one.
        send(br#"{"tug_session_id":"sess-replay-wake","type":"wake_started","session_id":"x"}"#)
            .await;
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turn_active }
        })
        .await;
        assert_eq!(
            entry_arc.lock().await.turn_opener,
            Some(TurnOpener::Wake),
            "a live wake still opens a wake turn",
        );

        cancel.cancel();
        let _ = merger_handle.await;
    }

    /// **[P02]'s rule, at the two edges that write it.** A turn the dispatcher
    /// opened from a `user_message` is an *asked* turn; a turn the merger
    /// opened from a `wake_started` is one the harness opened. Both end turns,
    /// and only the first is an answer — the whole of what the arc runner's
    /// quiet-turn horizon needed and did not have on the night of the
    /// incident.
    #[tokio::test]
    async fn a_wake_opened_turn_counts_as_a_wake_and_a_prompt_opened_one_as_a_prompt() {
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-opener");
        insert_ledger_entry(&sup, &id).await;
        let entry_arc = sup.ledger.lock().await.get(&id).cloned().unwrap();

        // The ask, through the dispatcher's own intercept.
        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            serde_json::to_vec(&serde_json::json!({
                "tug_session_id": "sess-opener",
                "type": "user_message",
                "text": "walk step 4",
                "attachments": [],
            }))
            .unwrap(),
        ))
        .await;
        {
            let entry = entry_arc.lock().await;
            assert!(entry.turn_active, "the ask opened a turn");
            assert_eq!(entry.turn_opener, Some(TurnOpener::Prompt));
        }

        // Registered after the dispatch, because the spawn the dispatch
        // attempts registers a channel of its own for this session and the
        // last registration is the one the merger reads.
        let (tx, rx) = mpsc::channel::<Frame>(8);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        // It ends: one asked turn, no wakes, and the opener cleared.
        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-opener","type":"turn_complete","msg_id":"m","seq":1}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turns_ended == 1 }
        })
        .await;
        {
            let entry = entry_arc.lock().await;
            assert_eq!((entry.prompt_turns_ended, entry.wake_turns_ended), (1, 0));
            assert_eq!(entry.turn_opener, None, "the opener clears with the turn");
        }

        // A background completion wakes the session. Nobody asked for this
        // turn, and the count that reads answers must not move for it.
        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-opener","type":"wake_started","session_id":"x"}"#.to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turn_active }
        })
        .await;
        assert_eq!(
            entry_arc.lock().await.turn_opener,
            Some(TurnOpener::Wake),
            "the harness opened this one",
        );

        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-opener","type":"turn_complete","msg_id":"m","seq":2}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turns_ended == 2 }
        })
        .await;
        {
            let entry = entry_arc.lock().await;
            assert_eq!(
                (entry.prompt_turns_ended, entry.wake_turns_ended),
                (1, 1),
                "two turns ended and exactly one of them was asked for",
            );
        }

        cancel.cancel();
        let _ = merger_handle.await;
    }

    // ── open runs and their progress reports (Spec S05) ───────────────────

    fn bash_use(id: &str, command: &str, background: bool) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "tool_use",
            "msg_id": "m1",
            "seq": 1,
            "tool_name": "Bash",
            "tool_use_id": id,
            "input": {"command": command, "run_in_background": background},
            "ipc_version": 2,
        }))
        .unwrap()
    }

    fn tool_result_for(id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "tool_result",
            "tool_use_id": id,
            "output": "",
            "is_error": false,
        }))
        .unwrap()
    }

    fn report(needles: &[&str]) -> RunProgressReport {
        RunProgressReport {
            label: Some("rust".into()),
            text: "compiling tugcast".into(),
            done: Some(3),
            needles: needles.iter().map(|n| (*n).to_owned()).collect(),
            ..RunProgressReport::default()
        }
    }

    /// The published frame, parsed, after its raw bytes are checked to lead
    /// with the session id as `SessionScopedFeed` frames require.
    fn next_run_progress(rx: &mut broadcast::Receiver<Frame>, live: &str) -> serde_json::Value {
        let frame = rx.try_recv().expect("a run_progress frame was published");
        assert_eq!(frame.feed_id, FeedId::CODE_OUTPUT);
        let lead = format!("{{\"tug_session_id\":\"{live}\"");
        assert!(
            frame.payload.starts_with(lead.as_bytes()),
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    #[tokio::test]
    async fn a_report_attaches_to_the_one_live_bash_call() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let id = TugSessionId::new("sess-run");
        insert_ledger_entry(&sup, &id).await;
        let mut code_rx = sup.code_output.subscribe();

        sup.record_run_open(&id, &bash_use("toolu_X", "just test", false))
            .await;
        let answer = sup.publish_run_progress("sess-run", report(&[])).await;
        assert_eq!(answer, Some((true, Some("toolu_X".to_owned()))));

        let frame = next_run_progress(&mut code_rx, "sess-run");
        assert_eq!(frame["type"], "run_progress");
        assert_eq!(frame["tool_use_id"], "toolu_X");
        assert_eq!(frame["label"], "rust");
        assert_eq!(frame["text"], "compiling tugcast");
        assert_eq!(frame["done"], 3);
        assert!(
            frame.get("total").is_none() && frame.get("failures").is_none(),
            "absent numbers are omitted, not null: {frame}"
        );
        assert!(frame["at_ms"].as_i64().is_some());
    }

    #[tokio::test]
    async fn needles_pick_one_of_two_runs_and_a_miss_goes_to_the_card() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let id = TugSessionId::new("sess-two");
        insert_ledger_entry(&sup, &id).await;
        let mut code_rx = sup.code_output.subscribe();
        sup.record_run_open(&id, &bash_use("toolu_T", "just test", false))
            .await;
        sup.record_run_open(&id, &bash_use("toolu_S", "sleep 30", false))
            .await;

        let answer = sup
            .publish_run_progress("sess-two", report(&["just test"]))
            .await;
        assert_eq!(answer, Some((true, Some("toolu_T".to_owned()))));
        assert_eq!(
            next_run_progress(&mut code_rx, "sess-two")["tool_use_id"],
            "toolu_T"
        );

        let answer = sup
            .publish_run_progress("sess-two", report(&["cargo nextest"]))
            .await;
        assert_eq!(answer, Some((false, None)));
        assert!(
            next_run_progress(&mut code_rx, "sess-two")["tool_use_id"].is_null(),
            "two runs and no needle between them: the card, never a guess"
        );
    }

    #[tokio::test]
    async fn an_exact_id_wins_over_a_needle_match_on_another_run() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let id = TugSessionId::new("sess-exact");
        insert_ledger_entry(&sup, &id).await;
        sup.record_run_open(&id, &bash_use("toolu_T", "just test", false))
            .await;
        sup.record_run_open(&id, &bash_use("toolu_S", "sleep 30", false))
            .await;

        let exact = RunProgressReport {
            tool_use_id: Some("toolu_S".into()),
            ..report(&["just test"])
        };
        let answer = sup.publish_run_progress("sess-exact", exact).await;
        assert_eq!(answer, Some((true, Some("toolu_S".to_owned()))));
    }

    /// A backgrounded call answers at once and its command keeps going, so
    /// its run stays attachable for as long as its job is open — under the
    /// launch key, then under the task id — and goes card-level after.
    #[tokio::test]
    async fn a_background_run_outlives_its_result_until_its_job_ends() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let id = TugSessionId::new("sess-bgrun");
        let entry = insert_ledger_entry(&sup, &id).await;
        let launch = bash_use("toolu_B", "just test", true);
        sup.record_job_launch(&id, &launch).await;
        sup.record_run_open(&id, &launch).await;
        sup.close_run(&id, &tool_result_for("toolu_B")).await;

        let answer = sup.publish_run_progress("sess-bgrun", report(&[])).await;
        assert_eq!(
            answer,
            Some((true, Some("toolu_B".to_owned()))),
            "attachable under `launch:toolu_B`"
        );

        let started = br#"{"type":"task_started","session_id":"c","task_id":"tb","tool_use_id":"toolu_B","description":"just test","task_type":"local_bash","ipc_version":2}"#;
        sup.apply_job_edge(&id, started).await;
        assert_eq!(
            entry.lock().await.open_runs["toolu_B"].task_id.as_deref(),
            Some("tb")
        );
        let answer = sup.publish_run_progress("sess-bgrun", report(&[])).await;
        assert_eq!(
            answer,
            Some((true, Some("toolu_B".to_owned()))),
            "attachable under its task id"
        );

        let completed = br#"{"type":"task_updated","session_id":"c","task_id":"tb","status":"completed","ipc_version":2}"#;
        sup.apply_job_edge(&id, completed).await;
        let answer = sup.publish_run_progress("sess-bgrun", report(&[])).await;
        assert_eq!(answer, Some((false, None)));
        assert!(
            entry.lock().await.open_runs.is_empty(),
            "a run whose job ended is pruned as it is found"
        );
    }

    #[tokio::test]
    async fn a_replayed_bash_call_registers_no_run() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let id = TugSessionId::new("sess-replay-run");
        let entry = insert_ledger_entry(&sup, &id).await;
        entry.lock().await.replay_brackets_open = 1;
        sup.record_run_open(&id, &bash_use("toolu_R", "just test", false))
            .await;
        assert!(entry.lock().await.open_runs.is_empty());
    }

    #[tokio::test]
    async fn a_report_for_a_session_with_no_entry_publishes_nothing() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let mut code_rx = sup.code_output.subscribe();
        assert_eq!(sup.publish_run_progress("nobody", report(&[])).await, None);
        assert!(code_rx.try_recv().is_err());
    }

    /// Through the merger: a call's result closes its foreground run, and the
    /// turn's end drops every foreground run still open — a background run's
    /// command outlives both.
    #[tokio::test]
    async fn the_merger_opens_and_closes_runs_and_the_turn_end_drops_the_foreground() {
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-merge-run");
        let entry_arc = insert_ledger_entry(&sup, &id).await;
        let (tx, rx) = mpsc::channel::<Frame>(8);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();
        let send = |payload: Vec<u8>| {
            let tx = tx.clone();
            async move {
                let tagged = splice_tug_session_id(&payload, "sess-merge-run");
                tx.send(Frame::new(FeedId::CODE_OUTPUT, tagged))
                    .await
                    .unwrap();
            }
        };

        send(bash_use("toolu_A", "just test", false)).await;
        send(bash_use("toolu_F", "sleep 30", false)).await;
        send(bash_use("toolu_B", "just app-test", true)).await;
        send(tool_result_for("toolu_A")).await;
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move {
                let entry = entry_arc.lock().await;
                entry.open_runs.len() == 2 && !entry.open_runs.contains_key("toolu_A")
            }
        })
        .await;

        send(br#"{"type":"turn_complete","msg_id":"m","seq":2}"#.to_vec()).await;
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turns_ended == 1 }
        })
        .await;
        let keys: Vec<String> = entry_arc.lock().await.open_runs.keys().cloned().collect();
        assert_eq!(keys, vec!["toolu_B".to_owned()]);

        cancel.cancel();
        let _ = merger_handle.await;
    }

    /// Risk R05, made a test: a turn tugcast inherited across a restart has no
    /// recorded opener, and an absent opener counts as an ask. That is today's
    /// behaviour and the conservative direction — the horizon may hold one
    /// inherited wake against a stage, never miss an ask it should have held.
    #[tokio::test]
    async fn an_unrecorded_opener_counts_as_a_prompt() {
        let ((sup, _state_rx, _meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-inherited");
        insert_ledger_entry(&sup, &id).await;
        let entry_arc = sup.ledger.lock().await.get(&id).cloned().unwrap();
        {
            let mut entry = entry_arc.lock().await;
            entry.turn_active = true;
            entry.turn_opener = None;
        }
        let (tx, rx) = mpsc::channel::<Frame>(8);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        tx.send(Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-inherited","type":"turn_complete","msg_id":"m","seq":1}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        wait_until(|| {
            let entry_arc = entry_arc.clone();
            async move { entry_arc.lock().await.turns_ended == 1 }
        })
        .await;
        {
            let entry = entry_arc.lock().await;
            assert_eq!((entry.prompt_turns_ended, entry.wake_turns_ended), (1, 0));
        }

        cancel.cancel();
        let _ = merger_handle.await;
    }

    /// Poll `cond` until it yields true (bounded); panics on timeout.
    async fn wait_until<F, Fut>(mut cond: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        for _ in 0..100 {
            if cond().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("wait_until: condition not met within 1s");
    }

    #[tokio::test]
    async fn test_merger_routes_metadata_per_session_no_clobber() {
        // Pins [D14]: two sessions emit distinct `system_metadata` frames
        // in rapid succession. Both frames must land on the SESSION_SIDEBAND
        // broadcast (a single-slot watch would drop one), AND each ledger
        // entry's `latest_metadata` must hold its own payload with no
        // cross-pollination.
        let ((sup, _state_rx, mut meta_rx, _control_rx), register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id_a = TugSessionId::new("sess-a");
        let id_b = TugSessionId::new("sess-b");
        insert_ledger_entry(&sup, &id_a).await;
        insert_ledger_entry(&sup, &id_b).await;

        let (tx_a, rx_a) = mpsc::channel::<Frame>(4);
        let (tx_b, rx_b) = mpsc::channel::<Frame>(4);
        sup.merger_register_tx
            .send((id_a.clone(), rx_a))
            .await
            .unwrap();
        sup.merger_register_tx
            .send((id_b.clone(), rx_b))
            .await
            .unwrap();

        let meta_a = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-a","type":"system_metadata","model":"opus-a"}"#.to_vec(),
        );
        let meta_b = Frame::new(
            FeedId::CODE_OUTPUT,
            br#"{"tug_session_id":"sess-b","type":"system_metadata","model":"opus-b"}"#.to_vec(),
        );
        tx_a.send(meta_a.clone()).await.unwrap();
        tx_b.send(meta_b.clone()).await.unwrap();

        let first = tokio::time::timeout(Duration::from_millis(500), meta_rx.recv())
            .await
            .expect("first metadata timeout")
            .expect("first metadata recv err");
        let second = tokio::time::timeout(Duration::from_millis(500), meta_rx.recv())
            .await
            .expect("second metadata timeout")
            .expect("second metadata recv err");

        // Feed-id correctness pin: the merger rewraps system_metadata
        // payloads with `FeedId::SESSION_SIDEBAND` before publishing onto
        // the session_sideband feed. `Frame::encode` uses `frame.feed_id` as
        // the first wire byte, so any client-side filter keyed on
        // `FeedId::SESSION_SIDEBAND` depends on this. A regression that
        // left the feed_id as CODE_OUTPUT would silently break tugdeck's
        // SESSION_SIDEBAND store without any payload assertion catching
        // it.
        assert_eq!(first.feed_id, FeedId::SESSION_SIDEBAND);
        assert_eq!(second.feed_id, FeedId::SESSION_SIDEBAND);

        let received: HashSet<Vec<u8>> = [first.payload, second.payload].into_iter().collect();
        assert!(
            received.contains(&meta_a.payload),
            "session A metadata missing from SESSION_SIDEBAND broadcast"
        );
        assert!(
            received.contains(&meta_b.payload),
            "session B metadata missing from SESSION_SIDEBAND broadcast"
        );

        // Each ledger entry's latest_metadata must hold its own distinct
        // payload. A single-slot watch would have one session's payload
        // clobber the other. The stored frames are also rewrapped as
        // SESSION_SIDEBAND so event-driven replay in `do_spawn_session`
        // re-emits with the correct feed_id.
        let entry_a = sup.ledger.lock().await.get(&id_a).unwrap().clone();
        let entry_b = sup.ledger.lock().await.get(&id_b).unwrap().clone();
        let stored_a = entry_a
            .lock()
            .await
            .latest_metadata
            .clone()
            .expect("session A stored metadata");
        let stored_b = entry_b
            .lock()
            .await
            .latest_metadata
            .clone()
            .expect("session B stored metadata");
        assert_eq!(stored_a.feed_id, FeedId::SESSION_SIDEBAND);
        assert_eq!(stored_b.feed_id, FeedId::SESSION_SIDEBAND);
        assert_eq!(stored_a.payload, meta_a.payload);
        assert_eq!(stored_b.payload, meta_b.payload);

        cancel.cancel();
        let _ = merger_handle.await;
    }

    #[tokio::test]
    async fn test_session_init_populates_claude_session_id() {
        // Drives `relay_session_io` directly with duplex streams so we can
        // simulate a child emitting `protocol_ack` + `session_init` without
        // spawning a real subprocess. This pins the aligned state model
        // (B3 fix): on session_init the bridge must **atomically**
        //
        //   (a) populate `claude_session_id`,
        //   (b) transition the ledger from `Spawning` → `Live`,
        //   (c) drain the per-session queue into `input_tx`,
        //   (d) publish the wire `SESSION_STATE = live` frame,
        //
        // all under a single ledger-entry lock so no observer can see a
        // state where `spawn_state == Live` while the queue still holds
        // undelivered frames.
        //
        // Also note: no `watch::channel` is constructed anywhere in this
        // test — that pins the deletion of `session_watch_tx` from
        // `agent_bridge.rs`. There is no longer any watch sender that a
        // `session_init` line can be latched onto.
        let ((sup, _state_rx, _meta_rx, _control_rx), _register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());

        let tug_id = TugSessionId::new("sess-1");
        let entry_arc = insert_ledger_entry(&sup, &tug_id).await;

        // Pre-install a queued frame + input_tx + Spawning state so the
        // bridge's session_init promote path has something to drain and
        // something to transition from. This mirrors what the dispatcher
        // + spawn_session_worker would have done in production.
        let (input_tx_for_ledger, mut input_rx_for_assert) = mpsc::channel::<Frame>(16);
        let pre_queued = code_input_frame("sess-1");
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
            entry.input_tx = Some(input_tx_for_ledger.clone());
            assert_eq!(entry.queue.push(pre_queued.clone()), QueuePush::Ok);
        }
        drop(input_tx_for_ledger);

        let (bridge_stdin, mut child_stdin_read) = tokio::io::duplex(4096);
        let (mut child_stdout_write, bridge_stdout) = tokio::io::duplex(4096);

        // Spawn a "child" that reads protocol_init, writes protocol_ack +
        // session_init, then drops its stdout write end to signal EOF.
        let child_task = tokio::spawn(async move {
            let mut reader = BufReader::new(&mut child_stdin_read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains("protocol_init"));

            child_stdout_write
                .write_all(b"{\"type\":\"protocol_ack\",\"version\":1}\n")
                .await
                .unwrap();
            child_stdout_write
                .write_all(b"{\"type\":\"session_init\",\"session_id\":\"claude-xyz\"}\n")
                .await
                .unwrap();
            drop(child_stdout_write);
        });

        let (_input_tx_bridge, mut input_rx_bridge) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(4);
        let state_tx = sup.session_state.sender();
        let mut state_rx = state_tx.subscribe();
        let cancel = CancellationToken::new();

        let stdin_box: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = Box::new(bridge_stdin);
        let stdout_box: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(bridge_stdout);
        let lines = BufReader::new(stdout_box).lines();

        let recorder = NoopSessionsRecorder;
        let outcome = relay_session_io(
            &tug_id,
            &entry_arc,
            &mut input_rx_bridge,
            &merger_tx,
            &state_tx,
            None,
            stdin_box,
            lines,
            "/tmp/test-relay-project",
            &recorder,
            None,
            &crate::feeds::changeset::ChangesetBumper::disconnected(),
            &cancel,
        )
        .await;

        child_task.await.unwrap();

        // EOF after session_init → relay returns Crashed.
        assert_eq!(outcome, RelayOutcome::Crashed);

        // (a) claude_session_id populated, (b) ledger state promoted to
        // Live, (c) queue drained.
        {
            let entry = entry_arc.lock().await;
            assert_eq!(entry.claude_session_id.as_deref(), Some("claude-xyz"));
            assert_eq!(entry.spawn_state, SpawnState::Live);
            assert!(
                entry.queue.is_empty(),
                "session_init must atomically drain the queue into input_tx"
            );
        }

        // The drained queue frame reached `input_tx` (which in this test
        // is wired into `input_rx_for_assert`).
        let drained = input_rx_for_assert
            .try_recv()
            .expect("queued frame drained to input_tx");
        assert_eq!(drained.payload, pre_queued.payload);

        // The session_init frame must have been forwarded to the merger
        // channel with `tug_session_id` spliced in.
        let spliced = merger_rx.try_recv().expect("session_init forwarded");
        assert_eq!(spliced.feed_id, FeedId::CODE_OUTPUT);
        let parsed: serde_json::Value = serde_json::from_slice(&spliced.payload).unwrap();
        assert_eq!(parsed["tug_session_id"], "sess-1");
        assert_eq!(parsed["type"], "session_init");
        assert_eq!(parsed["session_id"], "claude-xyz");

        // (d) SESSION_STATE = live must have been published.
        let live_frame = state_rx.try_recv().expect("live state frame");
        let (id, state) = session_state_of(&live_frame);
        assert_eq!(id, "sess-1");
        assert_eq!(state, "live");
    }

    /// When tugcode emits `resume_failed` and then exits (closes
    /// stdout), `relay_session_io` must promote the EOF
    /// from `Crashed` (would retry) to `ResumeFailed { ... }` so the
    /// outer `run_session_bridge` loop tears down terminally without
    /// re-spawning under the same stale `--resume` id. Pins the
    /// invariant so a future EOF-handling change can't quietly bring
    /// the silent retry back.
    #[tokio::test]
    async fn test_resume_failed_promotes_eof_to_terminal() {
        let ((sup, _state_rx, _meta_rx, _control_rx), _register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());

        let tug_id = TugSessionId::new("sess-resume-fail");
        let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
        }

        let (bridge_stdin, mut child_stdin_read) = tokio::io::duplex(4096);
        let (mut child_stdout_write, bridge_stdout) = tokio::io::duplex(4096);

        // Fake child: handshake, then `resume_failed`, then EOF.
        let stale_id = "stale-claude-id-7";
        let child_task = tokio::spawn(async move {
            let mut reader = BufReader::new(&mut child_stdin_read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains("protocol_init"));

            child_stdout_write
                .write_all(b"{\"type\":\"protocol_ack\",\"version\":1}\n")
                .await
                .unwrap();
            let frame = format!(
                "{{\"type\":\"resume_failed\",\"reason\":\"claude exited\",\"stale_session_id\":\"{stale_id}\"}}\n"
            );
            child_stdout_write
                .write_all(frame.as_bytes())
                .await
                .unwrap();
            drop(child_stdout_write);
        });

        let (_input_tx_bridge, mut input_rx_bridge) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(4);
        let state_tx = sup.session_state.sender();
        let cancel = CancellationToken::new();

        let stdin_box: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = Box::new(bridge_stdin);
        let stdout_box: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(bridge_stdout);
        let lines = BufReader::new(stdout_box).lines();

        let recorder = NoopSessionsRecorder;
        let outcome = relay_session_io(
            &tug_id,
            &entry_arc,
            &mut input_rx_bridge,
            &merger_tx,
            &state_tx,
            None,
            stdin_box,
            lines,
            "/tmp/test-relay-resume-fail",
            &recorder,
            None,
            &crate::feeds::changeset::ChangesetBumper::disconnected(),
            &cancel,
        )
        .await;

        child_task.await.unwrap();

        match outcome {
            RelayOutcome::ResumeFailed {
                stale_session_id,
                reason,
            } => {
                assert_eq!(stale_session_id, stale_id);
                assert_eq!(reason, "claude exited");
            }
            other => panic!("expected ResumeFailed, got {other:?}"),
        }

        // The `resume_failed` frame must have been forwarded to the
        // merger (so the card-side `lastError` populates).
        let forwarded = merger_rx.try_recv().expect("resume_failed forwarded");
        let parsed: serde_json::Value = serde_json::from_slice(&forwarded.payload).unwrap();
        assert_eq!(parsed["type"], "resume_failed");
        assert_eq!(parsed["stale_session_id"], stale_id);
        assert_eq!(parsed["tug_session_id"], "sess-resume-fail");
    }

    /// End-to-end pin for plan `#step-20-3-6`: the bridge intercept
    /// on `system_metadata` lines merges the incoming payload against
    /// the persisted ledger row and rewrites the wire to carry the
    /// most-informationally-rich version before forwarding. Validates
    /// the full capture + merge + inject path:
    ///
    ///   1. Live `system_metadata` arrives with the `[1m]`-suffixed
    ///      model. The bridge has no persisted row yet; the merge
    ///      returns incoming verbatim and persists it.
    ///   2. Replay-synthesized `system_metadata` arrives with the
    ///      bare model name (the JSONL transcript doesn't preserve
    ///      the suffix) and empty `cwd` / `permissionMode` /
    ///      `tools` / `slash_commands` / etc. The bridge merges
    ///      against the persisted live payload and forwards the rich
    ///      merged value.
    ///
    /// Both outbound `system_metadata` frames must carry the suffix;
    /// the ledger row at end-of-stream must hold the suffix.
    #[tokio::test]
    async fn test_system_metadata_bridge_merge_preserves_suffix_e2e() {
        let ((sup, _state_rx, _meta_rx, _control_rx), _register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());

        let tug_id = TugSessionId::new("sess-meta-e2e");
        let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
        }

        // Wire up an in-memory ledger so the bridge can read/write
        // `session_metadata` rows.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());

        let (bridge_stdin, mut child_stdin_read) = tokio::io::duplex(8192);
        let (mut child_stdout_write, bridge_stdout) = tokio::io::duplex(8192);

        let claude_session_id = "claude-meta-e2e";

        // Fake child writes: ack, session_init, live system_metadata,
        // replay_started, bare-model replay system_metadata,
        // replay_complete, EOF.
        let claude_id_for_child = claude_session_id.to_string();
        let child_task = tokio::spawn(async move {
            let mut reader = BufReader::new(&mut child_stdin_read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains("protocol_init"));

            child_stdout_write
                .write_all(b"{\"type\":\"protocol_ack\",\"version\":1}\n")
                .await
                .unwrap();

            child_stdout_write
                .write_all(
                    format!(
                        "{{\"type\":\"session_init\",\"session_id\":\"{claude_id_for_child}\"}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            // Live `system_metadata` — matches what `tugcode/src/session.ts`
            // emits on the `subtype === "init"` branch.
            let live_payload = serde_json::json!({
                "type": "system_metadata",
                "session_id": claude_id_for_child,
                "cwd": "/home/user/project",
                "tools": ["Read", "Bash"],
                "model": "claude-opus-4-7[1m]",
                "permissionMode": "default",
                "slash_commands": ["help"],
                "plugins": [],
                "agents": [],
                "skills": ["tugplug:plan"],
                "mcp_servers": [],
                "version": "2.1.105",
                "output_style": "",
                "fast_mode_state": "",
                "apiKeySource": "anthropic",
                "ipc_version": 2,
            });
            let mut live_line = serde_json::to_vec(&live_payload).unwrap();
            live_line.push(b'\n');
            child_stdout_write.write_all(&live_line).await.unwrap();

            child_stdout_write
                .write_all(b"{\"type\":\"replay_started\"}\n")
                .await
                .unwrap();

            // Replay-synthesized `system_metadata` — matches what
            // `tugcode/src/replay.ts` synthesizes. Bare model, every
            // other field empty / empty-array.
            let replay_payload = serde_json::json!({
                "type": "system_metadata",
                "session_id": claude_id_for_child,
                "cwd": "",
                "tools": [],
                "model": "claude-opus-4-7",
                "permissionMode": "",
                "slash_commands": [],
                "plugins": [],
                "agents": [],
                "skills": [],
                "mcp_servers": [],
                "version": "",
                "output_style": "",
                "fast_mode_state": "",
                "apiKeySource": "",
                "ipc_version": 2,
            });
            let mut replay_line = serde_json::to_vec(&replay_payload).unwrap();
            replay_line.push(b'\n');
            child_stdout_write.write_all(&replay_line).await.unwrap();

            child_stdout_write
                .write_all(b"{\"type\":\"replay_complete\"}\n")
                .await
                .unwrap();
            drop(child_stdout_write);
        });

        let (_input_tx_bridge, mut input_rx_bridge) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(16);
        let state_tx = sup.session_state.sender();
        let cancel = CancellationToken::new();

        let stdin_box: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = Box::new(bridge_stdin);
        let stdout_box: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(bridge_stdout);
        let lines = BufReader::new(stdout_box).lines();

        let recorder = NoopSessionsRecorder;
        let outcome = relay_session_io(
            &tug_id,
            &entry_arc,
            &mut input_rx_bridge,
            &merger_tx,
            &state_tx,
            None,
            stdin_box,
            lines,
            "/tmp/test-meta-e2e",
            &recorder,
            Some(ledger.as_ref()),
            &crate::feeds::changeset::ChangesetBumper::disconnected(),
            &cancel,
        )
        .await;
        child_task.await.unwrap();
        assert_eq!(outcome, RelayOutcome::Crashed); // EOF after the stream

        // Drain every CODE_OUTPUT frame the merger received and collect
        // the two `system_metadata` ones in order.
        let mut metadata_frames: Vec<serde_json::Value> = Vec::new();
        while let Ok(frame) = merger_rx.try_recv() {
            if frame.feed_id != FeedId::CODE_OUTPUT {
                continue;
            }
            let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                continue;
            };
            if parsed.get("type").and_then(|v| v.as_str()) == Some("system_metadata") {
                metadata_frames.push(parsed);
            }
        }
        assert_eq!(
            metadata_frames.len(),
            2,
            "both live and replay system_metadata frames must be forwarded",
        );

        // Both wire payloads carry the suffixed model.
        assert_eq!(
            metadata_frames[0]["model"], "claude-opus-4-7[1m]",
            "live system_metadata forwards verbatim with suffix",
        );
        assert_eq!(
            metadata_frames[1]["model"], "claude-opus-4-7[1m]",
            "replay-synthesized system_metadata is merged against the persisted live payload — \
             suffix preserved on the wire",
        );

        // Both wire payloads also carry the rich live values for cwd /
        // permissionMode / etc. (the replay-synthesized payload's empty
        // values were overridden by the persisted live ones).
        assert_eq!(metadata_frames[1]["cwd"], "/home/user/project");
        assert_eq!(metadata_frames[1]["permissionMode"], "default");
        assert_eq!(metadata_frames[1]["version"], "2.1.105");
        assert_eq!(metadata_frames[1]["apiKeySource"], "anthropic");
        assert_eq!(
            metadata_frames[1]["tools"].as_array().unwrap().len(),
            2,
            "live tools array survives the replay-synthesized empty array",
        );
        assert_eq!(
            metadata_frames[1]["slash_commands"]
                .as_array()
                .unwrap()
                .len(),
            1,
        );
        assert_eq!(metadata_frames[1]["skills"].as_array().unwrap().len(), 1,);

        // The ledger row holds the suffixed model at end-of-stream.
        let row = ledger
            .get_session_metadata(claude_session_id)
            .unwrap()
            .expect("ledger has the merged session_metadata row");
        let persisted: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
        assert_eq!(persisted["model"], "claude-opus-4-7[1m]");
        assert_eq!(persisted["cwd"], "/home/user/project");
    }

    /// A live `ai-title` lands on the row of the session that produced it —
    /// claude's current id — and never on the tug session id ([P07], #step-4).
    ///
    /// The two coincide for a plain fresh spawn (tugcode claims the tug id via
    /// `--session-id`), so a test that lets them coincide proves nothing. They
    /// diverge exactly when a rewind fork respawns inside this same relay or
    /// claude rotates its own id: the relay keeps its original
    /// `tug_session_id` while ledger rows are recorded under claude's. Keyed by
    /// the tug id, a fork's auto title would be written onto the PARENT's row —
    /// whose `name_user_set` is 0, so nothing would refuse it.
    #[tokio::test]
    async fn an_auto_title_lands_on_claudes_row_not_the_tug_session_id() {
        let ((sup, _state_rx, _meta_rx, _control_rx), _register_rx) =
            make_supervisor_with_spawner(stall_spawner_factory());

        // The relay's own id is the PARENT's: this is the post-fork shape.
        let tug_id = TugSessionId::new("sess-title-parent");
        let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
        }

        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let fork_claude_id = "claude-title-fork";
        // Two untitled rows: the parent the relay is named after, and the fork
        // claude is actually running. Neither is user-named, so `name_user_set`
        // cannot mask a misdirected write.
        for id in ["sess-title-parent", fork_claude_id] {
            ledger
                .record_spawn(id, "ws", "/tmp/test-title-fork", "card-1", 1, id, None)
                .unwrap();
        }

        let (bridge_stdin, mut child_stdin_read) = tokio::io::duplex(4096);
        let (mut child_stdout_write, bridge_stdout) = tokio::io::duplex(4096);
        let claude_id_for_child = fork_claude_id.to_string();
        let child_task = tokio::spawn(async move {
            let mut reader = BufReader::new(&mut child_stdin_read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains("protocol_init"));

            child_stdout_write
                .write_all(b"{\"type\":\"protocol_ack\",\"version\":1}\n")
                .await
                .unwrap();
            // The fork's synthetic init: from here on, claude's id is the
            // fork's and the relay's `tug_session_id` is the parent's.
            child_stdout_write
                .write_all(
                    format!(
                        "{{\"type\":\"session_init\",\"session_id\":\"{claude_id_for_child}\"}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            child_stdout_write
                .write_all(b"{\"type\":\"session_title\",\"title\":\"Parser bug hunt\"}\n")
                .await
                .unwrap();
            drop(child_stdout_write);
        });

        let (_input_tx_bridge, mut input_rx_bridge) = mpsc::channel::<Frame>(4);
        let (merger_tx, _merger_rx) = mpsc::channel::<Frame>(16);
        let state_tx = sup.session_state.sender();
        let cancel = CancellationToken::new();

        let stdin_box: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = Box::new(bridge_stdin);
        let stdout_box: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(bridge_stdout);
        let lines = BufReader::new(stdout_box).lines();

        let recorder = NoopSessionsRecorder;
        relay_session_io(
            &tug_id,
            &entry_arc,
            &mut input_rx_bridge,
            &merger_tx,
            &state_tx,
            None,
            stdin_box,
            lines,
            "/tmp/test-title-fork",
            &recorder,
            Some(ledger.as_ref()),
            &crate::feeds::changeset::ChangesetBumper::disconnected(),
            &cancel,
        )
        .await;
        child_task.await.unwrap();

        assert_eq!(
            ledger.get(fork_claude_id).unwrap().unwrap().name.as_deref(),
            Some("Parser bug hunt"),
            "the title belongs to the session claude is running"
        );
        assert_eq!(
            ledger.get("sess-title-parent").unwrap().unwrap().name,
            None,
            "the parent row must not be retitled by its fork's auto title"
        );
    }

    // ---- SessionKeyRecord schema + dual-read migration ----

    // ================================================================
    // supervisor lifecycle hooks against the registry
    // ================================================================

    /// Count the live entries in the supervisor's registry map. Private
    /// inspection helper — real callers never need this.
    fn registry_map_len(sup: &AgentSupervisor) -> usize {
        // Access the crate-visible `inner` field via the test module's
        // privilege (both live under the same crate).
        use super::super::workspace_registry::WorkspaceRegistry;
        fn inspect(r: &WorkspaceRegistry) -> usize {
            // `inner` is pub(crate) — this file is in the same crate.
            r.inner_for_test().len()
        }
        inspect(&sup.registry)
    }

    #[tokio::test]
    async fn test_spawn_session_rejects_missing_project_dir() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        // Payload without `project_dir` — handle_control must reject with
        // `InvalidProjectDir { reason: "missing_project_dir" }` before any
        // ledger mutation.
        let payload = serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": "card-1",
            "tug_session_id": "sess-1",
        }))
        .unwrap();
        let err = sup
            .handle_control("spawn_session", &payload, 10)
            .await
            .expect_error();
        assert_eq!(
            err,
            ControlError::InvalidProjectDir {
                reason: "missing_project_dir"
            }
        );
        assert!(sup.ledger.lock().await.is_empty());
        assert_eq!(registry_map_len(&sup), 0);
    }

    #[tokio::test]
    async fn test_spawn_session_rejects_nonexistent_project_dir() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        let payload = spawn_payload_in(
            "card-1",
            "sess-1",
            "/nonexistent/xyz-workspace-registry-test",
        );
        let err = sup
            .handle_control("spawn_session", &payload, 10)
            .await
            .expect_error();
        assert_eq!(
            err,
            ControlError::InvalidProjectDir {
                reason: "does_not_exist"
            }
        );
        assert!(sup.ledger.lock().await.is_empty());
        assert_eq!(registry_map_len(&sup), 0);
    }

    #[tokio::test]
    async fn test_spawn_session_rejects_file_as_project_dir() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let file_path = tmp.path().join("not-a-dir.txt");
        std::fs::write(&file_path, b"nope").expect("write file");
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        let payload = spawn_payload_in("card-1", "sess-1", file_path.to_str().unwrap());
        let err = sup
            .handle_control("spawn_session", &payload, 10)
            .await
            .expect_error();
        assert_eq!(
            err,
            ControlError::InvalidProjectDir {
                reason: "not_a_directory"
            }
        );
        assert!(sup.ledger.lock().await.is_empty());
        assert_eq!(registry_map_len(&sup), 0);
    }

    #[tokio::test]
    async fn test_spawn_session_success_ack_includes_workspace_key() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();

        // The first frame on the control feed should be the success ack
        // with an echoed `workspace_key`.
        let ack = control_rx.try_recv().expect("spawn_session_ok ack");
        assert_eq!(ack.feed_id, FeedId::CONTROL);
        let v: serde_json::Value = serde_json::from_slice(&ack.payload).unwrap();
        assert_eq!(v["action"], "spawn_session_ok");
        assert_eq!(v["card_id"], "card-1");
        assert_eq!(v["tug_session_id"], "sess-1");
        let wk = v["workspace_key"].as_str().expect("workspace_key string");
        assert!(!wk.is_empty());
        // The ack's workspace_key must equal the canonical form produced
        // by WorkspaceRegistry::get_or_create, which is what tugcast
        // splices into FILETREE/FILESYSTEM/GIT frames. Load the live
        // entry from the ledger and cross-check.
        let tug_id = TugSessionId::new("sess-1");
        let entry_arc = sup.ledger.lock().await.get(&tug_id).unwrap().clone();
        let entry = entry_arc.lock().await;
        assert_eq!(wk, entry.workspace_key.as_ref());
    }

    #[tokio::test]
    async fn test_two_sessions_same_workspace_share_entry() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-a", "sess-a"), 10)
            .await
            .expect_handled();
        sup.handle_control("spawn_session", &spawn_payload("card-b", "sess-b"), 20)
            .await
            .expect_handled();
        // Drain the two ack frames.
        let _ = control_rx.try_recv();
        let _ = control_rx.try_recv();

        // Same project_dir → same workspace entry; the registry map has
        // exactly one entry.
        assert_eq!(registry_map_len(&sup), 1);

        // Both ledger entries bind to the same workspace_key.
        let ledger = sup.ledger.lock().await;
        let entry_a = ledger.get(&TugSessionId::new("sess-a")).unwrap().clone();
        let entry_b = ledger.get(&TugSessionId::new("sess-b")).unwrap().clone();
        drop(ledger);
        let key_a = entry_a.lock().await.workspace_key.as_ref().to_string();
        let key_b = entry_b.lock().await.workspace_key.as_ref().to_string();
        assert_eq!(key_a, key_b);
    }

    #[tokio::test]
    async fn test_close_session_releases_workspace() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();
        let _ = control_rx.try_recv(); // drain ack
        assert_eq!(registry_map_len(&sup), 1);

        sup.handle_control("close_session", &close_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();

        // Refcount should have hit zero; the workspace is removed.
        assert_eq!(registry_map_len(&sup), 0);
        assert!(sup.ledger.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_reset_session_preserves_workspace() {
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();
        let _ = control_rx.try_recv(); // drain ack

        // Capture the `Arc<WorkspaceEntry>` from the registry map BEFORE
        // reset so the post-reset comparison can use `Arc::ptr_eq` — a
        // stricter invariant than comparing workspace_key strings alone
        // (which can't distinguish release-and-reacquire from preserve).
        let tug_id = TugSessionId::new("sess-1");
        let workspace_key = {
            let ledger = sup.ledger.lock().await;
            let entry_arc = ledger.get(&tug_id).unwrap().clone();
            drop(ledger);
            entry_arc.lock().await.workspace_key.clone()
        };
        let workspace_entry_before = sup
            .registry
            .inner_for_test()
            .get(&workspace_key)
            .expect("workspace entry present before reset")
            .clone();

        sup.handle_control("reset_session", &reset_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();

        // [D11]: the workspace entry survives reset. Map still holds 1.
        assert_eq!(registry_map_len(&sup), 1);

        // Strict: the post-reset `Arc<WorkspaceEntry>` must be the SAME
        // Arc, not a replacement with the same key.
        let workspace_entry_after = sup
            .registry
            .inner_for_test()
            .get(&workspace_key)
            .expect("workspace entry present after reset")
            .clone();
        assert!(
            Arc::ptr_eq(&workspace_entry_before, &workspace_entry_after),
            "reset must preserve the exact Arc<WorkspaceEntry>, not just the key"
        );

        // And the ledger entry's workspace_key is unchanged.
        let workspace_key_after = {
            let ledger = sup.ledger.lock().await;
            let entry_arc = ledger.get(&tug_id).unwrap().clone();
            drop(ledger);
            entry_arc.lock().await.workspace_key.clone()
        };
        assert_eq!(workspace_key.as_ref(), workspace_key_after.as_ref());
    }

    #[tokio::test]
    async fn test_two_sessions_two_workspaces_do_not_share() {
        // Two TempDirs → two distinct canonical paths → two distinct
        // `WorkspaceEntry` Arcs. Belt-and-suspenders for the invariant
        // that `get_or_create` really does dedupe by path, and that
        // `test_two_sessions_same_workspace_share_entry` isn't passing
        // because the dedup logic is stuck in a one-workspace rut.
        let tmp_a = tempfile::TempDir::new().expect("tempdir a");
        let tmp_b = tempfile::TempDir::new().expect("tempdir b");
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control(
            "spawn_session",
            &spawn_payload_in("card-a", "sess-a", tmp_a.path().to_str().unwrap()),
            10,
        )
        .await
        .expect_handled();
        sup.handle_control(
            "spawn_session",
            &spawn_payload_in("card-b", "sess-b", tmp_b.path().to_str().unwrap()),
            20,
        )
        .await
        .expect_handled();
        let _ = control_rx.try_recv(); // drain both acks
        let _ = control_rx.try_recv();

        // Two distinct workspaces in the registry.
        assert_eq!(registry_map_len(&sup), 2);

        // Distinct workspace_key strings on the ledger entries.
        let ledger = sup.ledger.lock().await;
        let entry_a = ledger.get(&TugSessionId::new("sess-a")).unwrap().clone();
        let entry_b = ledger.get(&TugSessionId::new("sess-b")).unwrap().clone();
        drop(ledger);
        let key_a = entry_a.lock().await.workspace_key.clone();
        let key_b = entry_b.lock().await.workspace_key.clone();
        assert_ne!(
            key_a.as_ref(),
            key_b.as_ref(),
            "distinct TempDirs must produce distinct workspace_keys"
        );

        // Strict: the two `Arc<WorkspaceEntry>` instances are distinct.
        let map = sup.registry.inner_for_test();
        let ws_a = map.get(&key_a).unwrap().clone();
        let ws_b = map.get(&key_b).unwrap().clone();
        drop(map);
        assert!(
            !Arc::ptr_eq(&ws_a, &ws_b),
            "distinct workspaces must be distinct Arcs"
        );
    }

    #[tokio::test]
    async fn test_spawn_session_reconnect_releases_refcount() {
        // Duplicate spawn on the same `tug_session_id` is a reconnect.
        // The second spawn's `get_or_create` bumps the workspace refcount
        // to 2, but the reconnect path in `do_spawn_session` releases the
        // extra refcount because the existing ledger entry already holds
        // one. Without that release, the refcount would leak one per
        // reconnect and the workspace would never tear down on close.
        //
        // This test nails that release-on-reconnect contract: the
        // registry map must still hold exactly one entry with
        // `ref_count == 1` after the second spawn.
        use std::sync::atomic::Ordering;
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
            .await
            .expect_handled();
        let _ = control_rx.try_recv(); // drain ack

        // Reconnect: same tug_session_id (and same project_dir), new card.
        sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 11)
            .await
            .expect_handled();
        let _ = control_rx.try_recv(); // drain second ack

        assert_eq!(registry_map_len(&sup), 1);

        // Read the single WorkspaceEntry and assert its refcount is 1,
        // not 2. A leak would show up as 2 here.
        let map = sup.registry.inner_for_test();
        assert_eq!(map.len(), 1);
        let (_key, ws) = map.iter().next().expect("one entry");
        assert_eq!(
            ws.ref_count.load(Ordering::Relaxed),
            1,
            "reconnect must release the just-acquired refcount"
        );
    }

    #[tokio::test]
    async fn test_spawn_resume_of_rebound_entry_keeps_workspace() {
        // The restore bug: an entry rebound from the ledger holds NO workspace
        // refcount (rebind registers no workspace, by design). Its first resume
        // spawn hits `inserted == false`; the old code read that as "a refcount
        // is already held" and released the one Phase 0 just acquired — dropping
        // the fresh workspace's ONLY refcount and tearing it down. The resumed
        // project then vanished from the registry (and the changeset aggregate /
        // git-log resolution). With per-entry refcount ownership, the rebound
        // entry ADOPTS the Phase-0 refcount on its first spawn, so it survives.
        use std::sync::atomic::Ordering;
        let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

        // Simulate `rebind_from_ledger`: an Idle, Resume entry present in the
        // in-memory ledger, bound to a card, holding no workspace refcount.
        let sid = TugSessionId::new("reb-sess");
        let mut entry = LedgerEntry::new(
            sid.clone(),
            WorkspaceKey::from_canonical(test_project_dir()),
            PathBuf::from(test_project_dir()),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        entry.card_id = Some("card-r".to_string());
        entry.claude_session_id = Some("reb-sess".to_string());
        assert!(
            !entry.holds_workspace_refcount,
            "a rebound entry starts holding no workspace refcount"
        );
        sup.ledger
            .lock()
            .await
            .insert(sid.clone(), Arc::new(Mutex::new(entry)));

        // Registry is empty until the first real spawn registers the workspace.
        assert_eq!(registry_map_len(&sup), 0);

        // First resume spawn of the rebound entry.
        sup.handle_control("spawn_session", &resume_payload("card-r", "reb-sess"), 10)
            .await
            .expect_handled();
        let _ = control_rx.try_recv();

        // The workspace is registered and SURVIVES (was torn down before the fix).
        assert_eq!(
            registry_map_len(&sup),
            1,
            "the rebound resume must keep its workspace registered"
        );
        let ref_count = {
            let map = sup.registry.inner_for_test();
            let (_key, ws) = map.iter().next().expect("one workspace");
            ws.ref_count.load(Ordering::Relaxed)
        };
        assert_eq!(
            ref_count, 1,
            "the entry adopts exactly one workspace refcount"
        );

        // The entry now records ownership of that refcount.
        let e = sup.ledger.lock().await.get(&sid).unwrap().clone();
        assert!(
            e.lock().await.holds_workspace_refcount,
            "the entry adopted the Phase-0 refcount"
        );
    }

    use crate::session_ledger::{SessionLedger, SessionState as LedgerState};

    // ── reported_binding: what makes a stored binding readable as gone ───────

    /// An arc whose branch is there reads bound, and one nothing knows about
    /// reads unbound. The two ordinary cases.
    #[test]
    fn a_binding_is_reported_when_its_arc_has_a_record() {
        let records = ArcRecords::Known(["tugarc/demo".to_string()].into_iter().collect());
        assert_eq!(
            AgentSupervisor::reported_binding(
                &records,
                Some("tugarc/demo#1755-aabbcc".into()),
                Some("demo".into()),
            ),
            (Some("tugarc/demo#1755-aabbcc".into()), Some("demo".into())),
        );
        assert_eq!(
            AgentSupervisor::reported_binding(
                &records,
                Some("tugarc/joined#1755-ddeeff".into()),
                Some("joined".into()),
            ),
            (None, None),
            "an arc the repo has no record of is gone, and the chip should say so",
        );
    }

    /// A repo that could not be read keeps the ledger's answer.
    ///
    /// Nulling is a claim — "this arc is gone" — and only evidence may make
    /// it. The old gate could not tell a failed `git` from a repo with no
    /// arcs in it, so a moved checkout or a stale `project_dir` spelling
    /// blanked the arc chip on every card at once, with nothing said.
    #[test]
    fn an_unreadable_repo_keeps_the_ledgers_binding_rather_than_nulling_it() {
        assert_eq!(
            AgentSupervisor::reported_binding(
                &ArcRecords::Unreadable,
                Some("tugarc/demo#1755-aabbcc".into()),
                Some("demo".into()),
            ),
            (Some("tugarc/demo#1755-aabbcc".into()), Some("demo".into())),
        );
        assert_eq!(
            AgentSupervisor::reported_binding(&ArcRecords::Unreadable, None, None),
            (None, None),
            "and an unbound row stays unbound; there is nothing to keep",
        );
    }

    /// The pre-branch arc binding, which the branch-only gate nulled every
    /// time.
    ///
    /// `tugtool arc run` binds through `ensure_arc_id`, which mints the
    /// owner key as git config and needs no branch — so between that bind and
    /// the arc's creation the binding is valid and has no `tugarc/<name>`
    /// ref. Gating on the ref alone made the card read unbound for that whole
    /// window, deterministically.
    #[test]
    fn a_pre_branch_arc_binding_is_reported_from_its_tugid_alone() {
        let repo = tempfile::tempdir().unwrap();
        git_init(repo.path());
        run_git(
            repo.path(),
            &["config", "branch.tugarc/arc.tugid", "1755-aabbcc"],
        );

        let records = AgentSupervisor::live_arc_records(repo.path().to_str().unwrap());
        assert!(matches!(records, ArcRecords::Known(_)));
        assert_eq!(
            AgentSupervisor::reported_binding(
                &records,
                Some("tugarc/arc#1755-aabbcc".into()),
                Some("arc".into()),
            ),
            (Some("tugarc/arc#1755-aabbcc".into()), Some("arc".into())),
            "an arc with a tugid and no branch yet is bound by design",
        );
    }

    /// A branch with no tugid — the legacy, pre-id shape — still reads as a
    /// record. Neither half is required; their absence *together* is what
    /// means gone, because a teardown takes both.
    #[test]
    fn a_branch_without_a_tugid_is_still_a_record() {
        let repo = tempfile::tempdir().unwrap();
        git_init(repo.path());
        run_git(repo.path(), &["commit", "--allow-empty", "-m", "root"]);
        run_git(repo.path(), &["branch", "tugarc/legacy"]);

        let records = AgentSupervisor::live_arc_records(repo.path().to_str().unwrap());
        assert_eq!(
            AgentSupervisor::reported_binding(
                &records,
                Some("tugarc/legacy".into()),
                Some("legacy".into()),
            ),
            (Some("tugarc/legacy".into()), Some("legacy".into())),
        );
    }

    /// A readable repo with no arcs in it answers `Known` and empty — a real
    /// answer, and the one that must stay distinct from not having been asked.
    #[test]
    fn a_repo_with_no_arcs_answers_known_and_empty() {
        let repo = tempfile::tempdir().unwrap();
        git_init(repo.path());

        match AgentSupervisor::live_arc_records(repo.path().to_str().unwrap()) {
            ArcRecords::Known(records) => assert!(records.is_empty()),
            ArcRecords::Unreadable => panic!("a readable repo with no arcs is not unreadable"),
        }
    }

    /// A path that is not a repo at all is `Unreadable`. This is the shape a
    /// stale `project_dir` spelling takes, and the one the old gate read as
    /// "every arc is gone".
    #[test]
    fn a_path_that_is_not_a_repo_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            AgentSupervisor::live_arc_records(dir.path().to_str().unwrap()),
            ArcRecords::Unreadable,
        ));
    }

    fn run_git(repo: &std::path::Path, args: &[&str]) {
        let out = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn git_init(repo: &std::path::Path) {
        run_git(repo, &["init", "--quiet", "-b", "main"]);
        run_git(repo, &["config", "user.email", "t@example.com"]);
        run_git(repo, &["config", "user.name", "T"]);
    }

    /// The rotation seat's two frames, in the order the deck needs them.
    ///
    /// `bind_arc_ok` names a segment minted moments ago, and the deck routes
    /// it by walking segment → line → card. Sent first, that walk resolves
    /// nothing and the announcement is dropped on the floor — the card keeps
    /// wearing "unbound" for the rest of its arc. So the row push, which is
    /// how the deck learns the pair at all, goes first; and the push must
    /// still come *after* the seat's write, or it would report a null arc
    /// about a row that is bound.
    #[tokio::test]
    async fn the_rotation_seat_pushes_the_row_before_it_announces_the_mating() {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        let (control_tx, mut rx) = broadcast::channel(64);
        let bump = Arc::new(Notify::new());
        let recorder = LedgerSessionsRecorder::with_broadcast(Arc::clone(&ledger), control_tx)
            .with_changeset_bump(Arc::clone(&bump));

        // The shape a rotation leaves: the line's old segment holds the
        // binding, and the Wheel has just minted a fresh one on the same card.
        ledger
            .record_spawn("seg-old", "ws-1", "/proj/x", "card-1", 1, "line-1", None)
            .unwrap();
        ledger
            .set_arc_binding("seg-old", Some(("tugarc/demo#1", "demo")))
            .unwrap();
        while rx.try_recv().is_ok() {}

        recorder.record(SessionRecord {
            session_id: "seg-new",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: Some("line-1"),
        });

        let actions: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|frame| serde_json::from_slice::<serde_json::Value>(&frame.payload).ok())
            .collect();
        let position = |action: &str| {
            actions
                .iter()
                .position(|v| v.get("action").and_then(|a| a.as_str()) == Some(action))
                .unwrap_or_else(|| panic!("no `{action}` frame among {actions:?}"))
        };
        assert!(
            position("session_updated") < position("bind_arc_ok"),
            "the deck cannot resolve an announcement about a segment it has not met",
        );

        let push = &actions[position("session_updated")];
        assert_eq!(push["session_id"], "seg-new");
        assert_eq!(
            push["fields"]["line_id"], "line-1",
            "the pair the deck's segment → line → card walk is made of",
        );

        let announce = &actions[position("bind_arc_ok")];
        assert_eq!(announce["tug_session_id"], "seg-new");
        assert_eq!(announce["arc_id"], "tugarc/demo#1");
        assert_eq!(announce["arc_name"], "demo");
        assert_eq!(
            announce["line_id"], "line-1",
            "and it carries its own routing, for a deck that missed the push",
        );
        assert_eq!(announce["card_id"], "card-1");

        // The masthead's arc index derives from CHANGESET_ALL, and a seat
        // moves which segment the arc reports as bound.
        tokio::time::timeout(std::time::Duration::from_millis(200), bump.notified())
            .await
            .expect("the seat rings the aggregate bump every other binding writer rings");

        // And the binding moved rather than being copied.
        assert!(ledger.get("seg-old").unwrap().unwrap().arc_id.is_none());
    }

    /// An ordinary spawn — no binding anywhere on the line — announces
    /// nothing and rings nothing. The seat is for the rotation alone.
    #[tokio::test]
    async fn an_unbound_spawn_announces_no_mating() {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        let (control_tx, mut rx) = broadcast::channel(64);
        let bump = Arc::new(Notify::new());
        let recorder = LedgerSessionsRecorder::with_broadcast(Arc::clone(&ledger), control_tx)
            .with_changeset_bump(Arc::clone(&bump));

        recorder.record(SessionRecord {
            session_id: "seg-solo",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: Some("line-1"),
        });

        let actions: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|frame| serde_json::from_slice::<serde_json::Value>(&frame.payload).ok())
            .filter_map(|v| v.get("action").and_then(|a| a.as_str()).map(String::from))
            .collect();
        assert!(actions.iter().any(|a| a == "session_updated"));
        assert!(!actions.iter().any(|a| a == "bind_arc_ok"), "{actions:?}");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), bump.notified())
                .await
                .is_err(),
            "nothing moved, so there is nothing to recompose",
        );
    }

    // ── one card, one bridge; close is by card ([B03], [B04]) ────────────────

    /// **The reload that spawned a rival ([B03]).** The card's bridge is keyed
    /// by the id it first spawned under; a rotation mints fresh segments
    /// *inside* that bridge, and a reload seats the card on the line's tip and
    /// asks to resume it. The lookup used to be the requested id alone, so the
    /// ask missed and a second `tugcode` spawned for a conversation the first
    /// was already hosting. The line answers it.
    #[tokio::test]
    async fn a_reload_naming_a_rotated_segment_re_holds_the_cards_bridge() {
        let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        // The card, spawned once. `spawn_payload` names `line-seat`.
        sup.handle_control(
            "spawn_session",
            &spawn_payload_on_line("card-1", "seat", "line-1"),
            10,
        )
        .await
        .expect_handled();
        assert_eq!(sup.ledger.lock().await.len(), 1);

        // The rotation: a fresh segment on the same line, recorded by the
        // bridge. Nothing in the supervisor's own ledger moves — that is the
        // whole shape, and it is what the reload then asks about.
        ledger
            .record_spawn("tip", "ws", "/proj", "card-1", 2_000, "line-1", None)
            .expect("record the rotation's segment");

        sup.handle_control("spawn_session", &resume_payload("card-1", "tip"), 10)
            .await
            .expect_handled();

        let held = sup.ledger.lock().await;
        assert_eq!(
            held.len(),
            1,
            "the reload re-held the card's bridge rather than spawning a rival",
        );
        assert!(
            held.contains_key(&TugSessionId::new("seat")),
            "and the entry is still keyed by the id the bridge was spawned under",
        );
    }

    /// **And the ack tells the deck where it is sitting ([B01], [B03]).** The
    /// re-hold above is correct and was the whole of the fix; what it left
    /// behind is an ack naming the bridge's key. A rotation moved the arc
    /// binding onto the line's fresh segment and took it off the one it
    /// retired, so reading the pair off the address's row answers "unbound"
    /// for a card that is working an arc — which is what blanked the masthead
    /// marker and the Z2 cell on all four of the reconnects in [F03]. The ack
    /// now carries the seat beside the address and reads the pair off the
    /// seat's row.
    #[tokio::test]
    async fn the_ack_of_a_re_held_bridge_names_the_seat_and_its_arc() {
        let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        sup.handle_control(
            "spawn_session",
            &spawn_payload_on_line("card-1", "seat", "line-1"),
            10,
        )
        .await
        .expect_handled();

        // The line as a rotation leaves it: the segment the bridge is keyed
        // by, closed; a fresher one, live, carrying the arc. `/proj` is not a
        // repo, so `live_arc_records` reads `Unreadable` and the reported
        // pair is the ledger's own — the arc-gone nulling is not what is
        // under test here.
        ledger
            .record_spawn("seat", "ws", "/proj", "card-1", 1_000, "line-1", None)
            .expect("the retired segment");
        ledger.mark_closed("seat").expect("retire it");
        ledger
            .record_spawn("tip", "ws", "/proj", "card-1", 2_000, "line-1", None)
            .expect("the rotation's segment");
        ledger
            .set_arc_binding("tip", Some(("arc-1", "wizard-downloads")))
            .expect("the seat is the segment the binding sits on");

        // Everything the spawn above put on CONTROL is another test's
        // business; the reconnect's ack is the last frame.
        while control_rx.try_recv().is_ok() {}

        sup.handle_control("spawn_session", &resume_payload("card-1", "tip"), 10)
            .await
            .expect_handled();

        let mut ack = None;
        while let Ok(frame) = control_rx.try_recv() {
            let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if v["action"] == "spawn_session_ok" {
                ack = Some(v);
            }
        }
        let ack = ack.expect("spawn_session_ok ack");

        assert_eq!(
            ack["tug_session_id"], "seat",
            "the address stays the bridge's key — every frame is stamped with it \
             and `CardServicesStore` keys on it ([B04])",
        );
        assert_eq!(
            ack["seated_session_id"], "tip",
            "and the seat rides beside it, so the deck holds both vocabularies",
        );
        assert_eq!(
            ack["arc_id"], "arc-1",
            "the pair is read off the seat's row, not the retired address's",
        );
        assert_eq!(ack["arc_name"], "wizard-downloads");
    }

    /// The ordinary resume, where no rotation happened: the seat is the
    /// address, and the field says so rather than going missing.
    #[tokio::test]
    async fn an_unrotated_resume_seats_the_ack_on_its_own_address() {
        let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        sup.handle_control(
            "spawn_session",
            &spawn_payload_on_line("card-1", "seat", "line-1"),
            10,
        )
        .await
        .expect_handled();
        ledger
            .record_spawn("seat", "ws", "/proj", "card-1", 1_000, "line-1", None)
            .expect("the one segment this line has");
        ledger
            .set_arc_binding("seat", Some(("arc-1", "wizard-downloads")))
            .expect("bound where it sits");

        while control_rx.try_recv().is_ok() {}

        sup.handle_control("spawn_session", &resume_payload("card-1", "seat"), 10)
            .await
            .expect_handled();

        let mut ack = None;
        while let Ok(frame) = control_rx.try_recv() {
            let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if v["action"] == "spawn_session_ok" {
                ack = Some(v);
            }
        }
        let ack = ack.expect("spawn_session_ok ack");

        assert_eq!(ack["tug_session_id"], "seat");
        assert_eq!(ack["seated_session_id"], "seat");
        assert_eq!(ack["arc_id"], "arc-1");
    }

    /// The second way in: the card asks under the name *claude* knows the
    /// conversation by, which a bridge records on its entry at `session_init`.
    #[tokio::test]
    async fn a_resume_naming_the_claude_id_re_holds_the_same_bridge() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-1", "seat"), 10)
            .await
            .expect_handled();
        {
            let entry_arc = sup
                .ledger
                .lock()
                .await
                .get(&TugSessionId::new("seat"))
                .cloned()
                .expect("entry");
            entry_arc.lock().await.claude_session_id = Some("claude-xyz".to_owned());
        }

        sup.handle_control("spawn_session", &resume_payload("card-1", "claude-xyz"), 10)
            .await
            .expect_handled();

        assert_eq!(sup.ledger.lock().await.len(), 1, "one card, one bridge");
    }

    /// And the miss still spawns. Another card's line is not this card's
    /// bridge, whatever ids it wears.
    #[tokio::test]
    async fn a_spawn_for_another_card_still_gets_its_own_bridge() {
        let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        sup.handle_control(
            "spawn_session",
            &spawn_payload_on_line("card-1", "seat", "line-1"),
            10,
        )
        .await
        .expect_handled();
        ledger
            .record_spawn("tip", "ws", "/proj", "card-1", 2_000, "line-1", None)
            .expect("segment");

        // Card 2 asks for a segment of card 1's line. It is not card 2's
        // bridge, so card 2 gets one of its own.
        sup.handle_control("spawn_session", &resume_payload("card-2", "tip"), 10)
            .await
            .expect_handled();

        assert_eq!(sup.ledger.lock().await.len(), 2, "two cards, two bridges");
    }

    /// **A bridge cannot survive its card ([B04]).** The close names one
    /// segment; the card is a line, and every bridge on it — and every live
    /// row it left behind — goes with it.
    #[tokio::test]
    async fn a_close_sweeps_every_bridge_and_row_on_the_cards_line() {
        let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        // Two bridges on one card's line — the state [B03] now prevents and
        // this sweep must still be able to clear, because a tugcast that was
        // running before the fix can come up holding it.
        for id in ["seat", "rival"] {
            let entry = insert_ledger_entry(&sup, &TugSessionId::new(id)).await;
            let mut guard = entry.lock().await;
            guard.card_id = Some("card-1".to_owned());
            guard.line_id = Some("line-1".to_owned());
        }
        // A segment the line wore under a bridge that is already gone: no
        // entry names it, so nothing but the line sweep can close its row.
        for (id, at) in [("seat", 1_000), ("rival", 2_000), ("orphan", 3_000)] {
            ledger
                .record_spawn(id, "ws", "/proj", "card-1", at, "line-1", None)
                .expect("row");
        }
        // Step 2's enforcement leaves one live row; revive the others so this
        // test exercises the sweep rather than that invariant.
        for id in ["seat", "rival"] {
            ledger.revive_on_activity(id, 4_000).ok();
        }

        sup.handle_control("close_session", &close_payload("card-1", "seat"), 10)
            .await
            .expect_handled();

        assert!(
            sup.ledger.lock().await.is_empty(),
            "no bridge of this card survived its close",
        );
        for id in ["seat", "rival", "orphan"] {
            assert_eq!(
                ledger.get(id).unwrap().expect("row").state,
                crate::session_ledger::SessionState::Closed,
                "{id} still reads live after its card closed",
            );
        }
    }

    /// Seat a card on a rotated segment with an arc bound to it, and hand
    /// back the ledger both the supervisor and the test read.
    async fn a_card_rotated_onto_a_bound_seat(
        sup: &mut AgentSupervisor,
    ) -> Arc<crate::session_ledger::SessionLedger> {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        sup.session_ledger = Some(Arc::clone(&ledger));

        let entry = insert_ledger_entry(sup, &TugSessionId::new("address")).await;
        {
            let mut guard = entry.lock().await;
            guard.card_id = Some("card-1".to_owned());
            guard.line_id = Some("line-1".to_owned());
            guard.spawn_state = SpawnState::Live;
            // The bridge's own record of which segment it is running now.
            guard.claude_session_id = Some("seat".to_owned());
        }
        for (id, at) in [("address", 1_000), ("seat", 2_000)] {
            ledger
                .record_spawn(id, "ws", "/proj", "card-1", at, "line-1", None)
                .expect("row");
        }
        ledger
            .set_arc_binding("seat", Some(("tugarc/demo#1", "demo")))
            .expect("bind");
        ledger
    }

    /// The two arcs stranded at 11:38:43: a demote closed the seat under a
    /// bridge that never stopped running, `bound_session_by_arc` reads live
    /// rows, and the arc left the sweep with nobody to prompt it back. The
    /// supervisor's own liveness is what re-lives it — with no turn recorded
    /// in between, because a stage sitting at a step boundary has no turn to
    /// offer.
    #[tokio::test]
    async fn the_liveness_reconcile_re_lives_a_demoted_seat() {
        let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let ledger = a_card_rotated_onto_a_bound_seat(&mut sup).await;

        ledger
            .demote_live_to_closed(crate::session_ledger::DemoteScope::EveryLiveRow)
            .expect("something outside closes the row");
        assert!(
            ledger.bound_session_by_arc().unwrap().is_empty(),
            "a demoted seat is unbound, which is how the arc left the sweep",
        );

        assert_eq!(sup.relive_demoted_seats().await, 1);

        assert_eq!(
            ledger.get("seat").unwrap().expect("row").state,
            crate::session_ledger::SessionState::Live,
        );
        assert_eq!(
            ledger
                .bound_session_by_arc()
                .unwrap()
                .get("tugarc/demo#1")
                .map(String::as_str),
            Some("seat"),
            "the arc is back in the sweep, named by its seat",
        );
    }

    /// And it revives on the bridge's liveness alone. An entry that is not
    /// `Live` is not evidence of a running subprocess, so its row stays
    /// exactly as the demote left it.
    #[tokio::test]
    async fn the_liveness_reconcile_leaves_a_seat_with_no_live_bridge_closed() {
        let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let ledger = a_card_rotated_onto_a_bound_seat(&mut sup).await;
        {
            let map = sup.ledger.lock().await;
            let entry = map.get(&TugSessionId::new("address")).expect("entry");
            entry.lock().await.spawn_state = SpawnState::Errored;
        }

        ledger
            .demote_live_to_closed(crate::session_ledger::DemoteScope::EveryLiveRow)
            .expect("demote");

        assert_eq!(sup.relive_demoted_seats().await, 0);
        assert_eq!(
            ledger.get("seat").unwrap().expect("row").state,
            crate::session_ledger::SessionState::Closed,
        );
    }

    /// The `headless_close_refused` rule, kept through the sweep: a segment
    /// on the line that another card has taken over belongs to whoever is
    /// sitting in it, and a close of this card must not tear it down.
    #[tokio::test]
    async fn the_sweep_leaves_a_segment_another_card_took_over() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        for (id, card) in [("seat", "card-1"), ("adopted", "card-2")] {
            let entry = insert_ledger_entry(&sup, &TugSessionId::new(id)).await;
            let mut guard = entry.lock().await;
            guard.card_id = Some(card.to_owned());
            guard.line_id = Some("line-1".to_owned());
        }

        sup.handle_control("close_session", &close_payload("card-1", "seat"), 10)
            .await
            .expect_handled();

        let held = sup.ledger.lock().await;
        assert!(!held.contains_key(&TugSessionId::new("seat")));
        assert!(
            held.contains_key(&TugSessionId::new("adopted")),
            "the segment card-2 took over is left to its new holder",
        );
    }

    // ── the orphan-bridge sweep ([B07]) ──────────────────────────────────────

    /// **The bridge a restart used to be the only reaper for.** After a deck
    /// reconnects, every open card re-announces its session; an entry still
    /// in no client's set once the settle window has passed is a bridge no
    /// card is behind, and it is closed rather than left running.
    #[tokio::test]
    async fn an_orphan_bridge_is_closed_once_the_settle_window_passes() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

        // The card that came back: it announced itself, so a client holds it.
        sup.handle_control("spawn_session", &spawn_payload("card-1", "held"), 10)
            .await
            .expect_handled();
        // And one that did not — a bridge the deck no longer has a card for.
        let orphan = insert_ledger_entry(&sup, &TugSessionId::new("orphan")).await;
        {
            let mut entry = orphan.lock().await;
            entry.card_id = Some("card-gone".to_owned());
            entry.spawn_state = SpawnState::Live;
        }

        sup.reap_orphan_bridges(10).await;

        let held = sup.ledger.lock().await;
        assert!(
            held.contains_key(&TugSessionId::new("held")),
            "a session a client announced is not an orphan",
        );
        assert!(
            !held.contains_key(&TugSessionId::new("orphan")),
            "a bridge no client holds and no card named is closed",
        );
    }

    /// A headless session is held by no client **by design** — that is what
    /// background means — so the sweep may not read its absence as an orphan.
    #[tokio::test]
    async fn the_sweep_leaves_a_headless_session_alone() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-1", "held"), 10)
            .await
            .expect_handled();

        let background = insert_ledger_entry(&sup, &TugSessionId::new("headless")).await;
        {
            let mut entry = background.lock().await;
            entry.card_id = Some(crate::background_session::background_card_id("w"));
            entry.spawn_state = SpawnState::Live;
        }

        sup.reap_orphan_bridges(10).await;

        assert!(
            sup.ledger
                .lock()
                .await
                .contains_key(&TugSessionId::new("headless")),
            "a background session is meant to be held by nobody",
        );
    }

    /// An entry that never spawned is what `rebind_from_ledger` leaves at
    /// startup, waiting for the card that will claim it. There is no bridge
    /// behind it to reap, and reaping it would throw away the restore.
    #[tokio::test]
    async fn the_sweep_leaves_an_unspawned_rebind_entry_alone() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        sup.handle_control("spawn_session", &spawn_payload("card-1", "held"), 10)
            .await
            .expect_handled();

        let rebound = insert_ledger_entry(&sup, &TugSessionId::new("rebound")).await;
        {
            let mut entry = rebound.lock().await;
            entry.card_id = Some("card-2".to_owned());
            entry.spawn_state = SpawnState::Idle;
        }

        sup.reap_orphan_bridges(10).await;

        assert!(
            sup.ledger
                .lock()
                .await
                .contains_key(&TugSessionId::new("rebound")),
            "an entry with no subprocess behind it is not an orphan bridge",
        );
    }

    /// And the sweep says nothing at all when its own client is gone: with no
    /// deck that re-announced, "no client holds it" is not evidence of
    /// anything, and a tugcast running headless would reap its own work.
    #[tokio::test]
    async fn a_sweep_whose_client_never_announced_reaps_nothing() {
        let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
        let orphan = insert_ledger_entry(&sup, &TugSessionId::new("orphan")).await;
        {
            let mut entry = orphan.lock().await;
            entry.card_id = Some("card-gone".to_owned());
            entry.spawn_state = SpawnState::Live;
        }

        sup.reap_orphan_bridges(10).await;

        assert!(
            sup.ledger
                .lock()
                .await
                .contains_key(&TugSessionId::new("orphan")),
            "with no client to have re-announced, the sweep judges nothing",
        );
    }

    // ── CONTROL ledger ops ───────────────────────────────────────────────────
    //
    // These tests exercise the new `list_sessions`, `trash_session`, and
    // `trash_workspace_sessions` actions end-to-end through the supervisor's
    // `handle_control` path. The supervisor is built with a real
    // `SessionLedger` in scope; the tests assert the broadcast frames the
    // CONTROL feed emits and the ledger row state after each action.

    /// Build a supervisor with a real ledger + a recorder that emits push
    /// frames on writes. Returns the supervisor, ledger, and the CONTROL
    /// receiver so tests can read the broadcast traffic.
    fn make_supervisor_with_ledger() -> (
        Arc<AgentSupervisor>,
        Arc<SessionLedger>,
        broadcast::Receiver<Frame>,
    ) {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        make_supervisor_for_ledger(ledger, None)
    }

    /// [`make_supervisor_with_ledger`] with an in-memory shell ledger
    /// attached, the way `main.rs` attaches it — what the landing tests need,
    /// since `set_shell_ledger` cannot reach a supervisor already in an `Arc`.
    fn make_supervisor_with_ledger_and_shell() -> (
        Arc<AgentSupervisor>,
        Arc<SessionLedger>,
        Arc<crate::shell_ledger::ShellLedger>,
        broadcast::Receiver<Frame>,
    ) {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        let shell =
            Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
        let (sup, ledger, rx) =
            make_supervisor_for_ledger_with_prompts(ledger, None, None, Some(Arc::clone(&shell)));
        (sup, ledger, shell, rx)
    }

    /// Harness variant for union/liveness tests: a ledger with a real
    /// tempdir claude-projects root, and an injectable terminal
    /// registry root. The default registry root is a nonexistent path
    /// so tests never read the developer's real `~/.claude/sessions`.
    fn make_supervisor_for_ledger(
        ledger: Arc<SessionLedger>,
        terminal_registry_root: Option<std::path::PathBuf>,
    ) -> (
        Arc<AgentSupervisor>,
        Arc<SessionLedger>,
        broadcast::Receiver<Frame>,
    ) {
        make_supervisor_for_ledger_with_prompts(ledger, terminal_registry_root, None, None)
    }

    /// [`make_supervisor_for_ledger`] with a prompt-history ledger and a shell
    /// ledger attached, the way `main.rs` attaches them.
    fn make_supervisor_for_ledger_with_prompts(
        ledger: Arc<SessionLedger>,
        terminal_registry_root: Option<std::path::PathBuf>,
        prompts: Option<Arc<crate::prompt_ledger::PromptLedger>>,
        shell: Option<Arc<crate::shell_ledger::ShellLedger>>,
    ) -> (
        Arc<AgentSupervisor>,
        Arc<SessionLedger>,
        broadcast::Receiver<Frame>,
    ) {
        let (state_tx, _state_rx) = broadcast::channel(64);
        let (meta_tx, _meta_rx) = broadcast::channel(8);
        let (code_tx, _code_rx) = broadcast::channel(8);
        let (control_tx, control_rx) = broadcast::channel(128);
        let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
            Arc::clone(&ledger),
            control_tx.clone(),
        ));
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let cancel = CancellationToken::new();
        let config = AgentSupervisorConfig {
            terminal_registry_root: Some(terminal_registry_root.unwrap_or_else(|| {
                std::path::PathBuf::from("/nonexistent/tugcast-test-terminal-registry")
            })),
            ..AgentSupervisorConfig::default()
        };
        let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
            SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
            SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
            SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
            SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
            control_tx,
            recorder,
            Some(Arc::clone(&ledger)),
            stall_spawner_factory(),
            config,
            registry,
            cancel,
        );
        if let Some(prompts) = prompts {
            sup.set_prompt_ledger(prompts);
        }
        if let Some(shell) = shell {
            sup.set_shell_ledger(shell);
        }
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });
        (Arc::new(sup), ledger, control_rx)
    }

    /// Drain until the **settled** `list_sessions_ok` — the phase-2 emit
    /// carrying the full union (`scanning: false`). `do_list_sessions`
    /// emits twice: a phase-1 `{ scanning: true }` with ledger rows only,
    /// then this one once the external scan completes. Tests asserting on
    /// external/union rows must wait for the settled frame.
    async fn drain_until_list_sessions_settled(
        rx: &mut broadcast::Receiver<Frame>,
    ) -> serde_json::Value {
        // The settled frame is sent from a detached phase-2 task, so we
        // must `await` (yield to the runtime) rather than `try_recv` — the
        // task only runs while this test awaits. Bounded by a timeout so a
        // never-arriving frame surfaces as a panic, not a hang.
        for _ in 0..256 {
            let frame =
                match tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
                    Ok(Ok(f)) => f,
                    _ => break,
                };
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                let is_ok = v.get("action").and_then(|a| a.as_str()) == Some("list_sessions_ok");
                let settled = v.get("scanning").and_then(|s| s.as_bool()) == Some(false);
                if is_ok && settled {
                    return v;
                }
            }
        }
        panic!("settled `list_sessions_ok` (scanning:false) not observed");
    }

    fn drain_until_action(rx: &mut broadcast::Receiver<Frame>, action: &str) -> serde_json::Value {
        // Pull frames off the broadcast until we find one whose `action`
        // matches; ignore the others. Bounded loop so a missing frame
        // surfaces as a panic on the receiver's empty error rather than a
        // hang.
        for _ in 0..64 {
            let Ok(frame) = rx.try_recv() else { break };
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                if v.get("action").and_then(|a| a.as_str()) == Some(action) {
                    return v;
                }
            }
        }
        panic!("CONTROL frame with action `{action}` not observed");
    }

    /// Seed an external (no ledger row) session JSONL under the
    /// ledger's claude root for `project_dir`. Returns the file path.
    fn seed_external_jsonl(
        claude_root: &std::path::Path,
        project_dir: &str,
        session_id: &str,
        last_prompt: &str,
    ) -> std::path::PathBuf {
        let dir = claude_root.join(tugcore::claude_home::encode_project_dir(project_dir));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{session_id}.jsonl"));
        let content = format!(
            "{{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"{session_id}\"}}\n\
             {{\"type\":\"user\",\"sessionId\":\"{session_id}\",\"cwd\":\"{project_dir}\",\"timestamp\":\"2026-06-01T10:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{last_prompt}\"}}}}\n"
        );
        std::fs::write(&path, content).unwrap();
        path
    }

    const EXTERNAL_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    /// Write a registry entry into `root` for `session_id` with `pid`.
    fn write_registry_entry(root: &std::path::Path, session_id: &str, pid: u32, stem: &str) {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(
            root.join(format!("{stem}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"{session_id}","status":"busy"}}"#),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn recorder_writes_emit_session_updated_pushes() {
        // A `record` followed by a `record_turn` against the supervisor's
        // recorder must each emit a `session_updated` push on the same
        // CONTROL feed the picker subscribes to. Verifies the broadcast
        // pipeline wired up in `LedgerSessionsRecorder::with_broadcast`.
        let (sup, _ledger, mut rx) = make_supervisor_with_ledger();

        sup.sessions_recorder.record(SessionRecord {
            session_id: "s1",
            workspace_key: "ws-1",
            project_dir: "/p",
            card_id: "c1",
            tag: None,
            line_id: None,
        });
        let first = drain_until_action(&mut rx, "session_updated");
        assert_eq!(first["fields"]["turn_count"].as_i64(), Some(0));
        assert_eq!(first["fields"]["state"], "live");

        // record_turn touches recency and still broadcasts a push, but no
        // longer writes the count ([P08]) — so the pushed turn_count holds.
        sup.sessions_recorder.record_turn("s1");
        let second = drain_until_action(&mut rx, "session_updated");
        assert_eq!(second["fields"]["turn_count"].as_i64(), Some(0));
    }

    // ── Step 5.3 — merger intercept narrows to FIFO mark-seen ───────────────
    //
    // The merger calls `apply_outbound_turn_intercept(&session_id, &frame)`
    // on every CODE_OUTPUT frame after the wire-side broadcast. For
    // `turn_complete` / `turn_cancelled` frames, the intercept pops the
    // oldest pending row from the session's submission journal (FIFO
    // match by `created_at`). For other types, it's a no-op. The frame
    // is forwarded unchanged regardless. See [DM08] in the
    // mid-turn-replay plan.

    fn turn_complete_frame() -> Frame {
        // The merger reads only `msg_type` from outbound payloads
        // post-Step-5.3; the other fields are pinned-shape but unread.
        let body = serde_json::json!({
            "type": "turn_complete",
            "msg_id": "msg_01ABC",
            "seq": 3,
            "result": "",
            "ipc_version": 2,
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    fn turn_cancelled_frame() -> Frame {
        let body = serde_json::json!({
            "type": "turn_cancelled",
            "msg_id": "msg_01XYZ",
            "seq": 4,
            "partial_result": "so far the assistant said...",
            "ipc_version": 2,
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    fn seed_session_for_journal_test(ledger: &SessionLedger, id: &str) {
        // Insert a `live` row in `sessions` so the cascade trigger has a
        // parent to cascade from. The merger intercept itself does NOT
        // require a sessions row to be present (it operates on the
        // `turns` journal directly); seeding the parent here is for the
        // "cascade-delete when forgotten" test only.
        ledger
            .record_spawn(
                id,
                "ws-journal",
                "/proj/journal",
                "card-journal",
                crate::session_ledger::now_millis(),
                id,
                None,
            )
            .expect("seed session row");
    }

    fn count_pending_for_session(ledger: &SessionLedger, session_id: &str) -> usize {
        ledger
            .list_pending_turns_for_session(session_id)
            .expect("list pending")
            .len()
    }

    #[tokio::test]
    async fn merger_intercept_pops_journal_in_fifo_order_across_two_turns() {
        // Two pending submissions in flight; two turn_complete frames
        // arrive. The journal rows pop in created_at order (oldest first);
        // after both pops the journal for the session is empty.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-fifo";
        seed_session_for_journal_test(&ledger, session_id);

        // Insert two pending rows directly via the journal API (the
        // dispatcher's user_message intercept is exercised in a separate
        // test); use distinct created_at so FIFO order is unambiguous.
        ledger
            .insert_pending_turn(session_id, "j_oldest", "first", &[], 1_000)
            .unwrap();
        ledger
            .insert_pending_turn(session_id, "j_newer", "second", &[], 2_000)
            .unwrap();
        assert_eq!(count_pending_for_session(&ledger, session_id), 2);

        let frame = turn_complete_frame();
        sup.apply_outbound_turn_intercept(&TugSessionId::new(session_id), &frame);
        assert_eq!(count_pending_for_session(&ledger, session_id), 1);
        let remaining = ledger.list_pending_turns_for_session(session_id).unwrap();
        assert_eq!(
            remaining[0].journal_id, "j_newer",
            "FIFO: the oldest row pops first; the newer row remains",
        );

        let frame2 = turn_complete_frame();
        sup.apply_outbound_turn_intercept(&TugSessionId::new(session_id), &frame2);
        assert_eq!(count_pending_for_session(&ledger, session_id), 0);
    }

    #[tokio::test]
    async fn merger_intercept_handles_turn_cancelled_same_as_turn_complete() {
        // turn_cancelled also pops the oldest pending row — the journal
        // doesn't distinguish "claude finished" from "user cancelled"
        // because both land back at "no longer awaiting response".
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-cancel";
        seed_session_for_journal_test(&ledger, session_id);

        ledger
            .insert_pending_turn(session_id, "j_only", "submission", &[], 1_000)
            .unwrap();
        assert_eq!(count_pending_for_session(&ledger, session_id), 1);

        let frame = turn_cancelled_frame();
        sup.apply_outbound_turn_intercept(&TugSessionId::new(session_id), &frame);
        assert_eq!(count_pending_for_session(&ledger, session_id), 0);
    }

    #[tokio::test]
    async fn merger_intercept_no_op_on_unrelated_frame_type() {
        // assistant_text, tool_use, tool_result etc. don't pop the journal.
        // The journal pops only on the terminal `turn_complete` /
        // `turn_cancelled` frames that mark "claude has acknowledged".
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-unrelated";
        seed_session_for_journal_test(&ledger, session_id);

        ledger
            .insert_pending_turn(session_id, "j_keep", "should survive", &[], 1_000)
            .unwrap();

        let assistant_body = serde_json::json!({
            "type": "assistant_text",
            "msg_id": "msg_x",
            "seq": 1,
            "rev": 0,
            "text": "partial",
            "is_partial": true,
            "status": "partial",
            "ipc_version": 2,
        });
        let frame = Frame::new(
            FeedId::CODE_OUTPUT,
            serde_json::to_vec(&assistant_body).unwrap(),
        );
        sup.apply_outbound_turn_intercept(&TugSessionId::new(session_id), &frame);
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            1,
            "assistant_text must not pop the journal; only turn_complete / turn_cancelled do",
        );
    }

    #[tokio::test]
    async fn merger_intercept_returns_none_when_journal_empty() {
        // Spurious turn_complete: claude responds for a session whose
        // journal has no pending rows (e.g., a resume picking up
        // mid-stream where the dispatcher never saw the user_message).
        // The intercept calls delete_oldest_pending_for_session which
        // returns Ok(None); a warn fires; the frame is forwarded
        // unchanged at the merger task level (this test exercises the
        // intercept directly so we just assert the no-throw + journal
        // stays empty).
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-spurious";
        seed_session_for_journal_test(&ledger, session_id);
        assert_eq!(count_pending_for_session(&ledger, session_id), 0);

        let frame = turn_complete_frame();
        // Should not panic; intercept handles None gracefully.
        sup.apply_outbound_turn_intercept(&TugSessionId::new(session_id), &frame);
        assert_eq!(count_pending_for_session(&ledger, session_id), 0);
    }

    #[tokio::test]
    async fn merger_intercept_isolates_per_session() {
        // Pending row in session A; turn_complete arrives for session B.
        // Session A's row must be untouched.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        seed_session_for_journal_test(&ledger, "sess-a");
        seed_session_for_journal_test(&ledger, "sess-b");

        ledger
            .insert_pending_turn("sess-a", "j_a", "for sess-a", &[], 1_000)
            .unwrap();

        let frame = turn_complete_frame();
        sup.apply_outbound_turn_intercept(&TugSessionId::new("sess-b"), &frame);

        assert_eq!(
            count_pending_for_session(&ledger, "sess-a"),
            1,
            "session A's pending row must survive when session B emits turn_complete",
        );
        assert_eq!(count_pending_for_session(&ledger, "sess-b"), 0);
    }

    #[tokio::test]
    async fn cascade_trigger_purges_journal_when_session_forgotten() {
        // Pending row outlives session: insert journal row, then trash
        // the session. The cascade trigger purges the journal row.
        let (_sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-cascade";
        seed_session_for_journal_test(&ledger, session_id);

        // Mark closed first (trash refuses live rows by design).
        ledger.mark_closed(session_id).unwrap();
        ledger
            .insert_pending_turn(session_id, "j_orphan", "outlives session", &[], 1_000)
            .unwrap();
        assert_eq!(count_pending_for_session(&ledger, session_id), 1);

        ledger.trash(session_id).unwrap();

        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            0,
            "cascade trigger must purge journal rows when the parent session is forgotten",
        );
    }

    #[tokio::test]
    async fn dispatch_one_inserts_journal_row_without_augmenting_frame() {
        // Step 5.3 invariant: the dispatcher's user_message intercept
        // mints a journal id, persists the row, and forwards the frame
        // UNCHANGED (no `tug_turn_id` field stamped onto the wire). The
        // forwarded frame's bytes equal the input frame's bytes.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id_str = "sess-dispatch";
        let tug_session_id = TugSessionId::new(session_id_str);

        // The dispatcher requires an entry in the supervisor's per-session
        // map (the `Some(entry_arc)` branch). The `Idle` state queues the
        // frame rather than spawning a real worker (the test's
        // stall_spawner_factory wouldn't run anyway).
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id_str);

        let body = serde_json::json!({
            "tug_session_id": session_id_str,
            "type": "user_message",
            "text": "hello",
            "attachments": [],
        });
        let original_payload = serde_json::to_vec(&body).unwrap();
        let frame = Frame::new(FeedId::CODE_INPUT, original_payload.clone());

        sup.dispatch_one(frame).await;

        // A journal row landed for this session, sourced from the
        // payload's `text` and `attachments` fields.
        let rows = ledger
            .list_pending_turns_for_session(session_id_str)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user_text, "hello");
        assert!(rows[0].user_attachments.is_empty());

        // Pop the queued frame and assert its payload is byte-identical
        // to the input — the dispatcher does NOT augment the wire.
        let mut entry = entry_arc.lock().await;
        let queued = entry.queue.pop().expect("frame queued");
        assert_eq!(
            queued.payload, original_payload,
            "dispatcher must forward user_message frames unchanged (Step 5.3 wire invariant)",
        );
    }

    // ── landings ride the next user message ──────────────────────────────────

    /// Record a `/commit` receipt on the session's line — the session is its
    /// own line in these tests, so `resolve_ink_line` returns its id.
    fn record_commit_receipt(shell: &crate::shell_ledger::ShellLedger, session: &str) -> i64 {
        shell
            .record_exchange(&crate::shell_ledger::NewShellExchange {
                tug_session_id: session.to_string(),
                line_id: session.to_string(),
                command: "/commit".to_string(),
                output: super::super::changeset::format_commit_summary(
                    "302d43b5d1ffff",
                    "Add the mic",
                    &[],
                ),
                exit_code: Some(0),
                cwd: "/proj".to_string(),
                cwd_after: None,
                started_at_ms: 1,
                settled_at_ms: 2,
                anchor_msg_id: None,
            })
            .expect("record receipt")
    }

    fn content_payload(session: &str, text: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tug_session_id": session,
            "type": "user_message",
            "content": [{"type": "text", "text": text}],
        }))
        .unwrap()
    }

    /// The queued frame's `content` text blocks, in order.
    fn queued_text_blocks(frame: &Frame) -> Vec<String> {
        let value: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        value["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn an_untold_landing_rides_the_next_user_message() {
        let (sup, ledger, shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-landing";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        record_commit_receipt(&shell, session);

        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            content_payload(session, "hello"),
        ))
        .await;

        let queued = entry_arc.lock().await.queue.pop().expect("frame queued");
        let blocks = queued_text_blocks(&queued);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], "hello");
        assert!(
            blocks[1].starts_with("<!-- tug:landings -->\n"),
            "{}",
            blocks[1]
        );
        assert!(
            blocks[1].contains("- committed 302d43b5d1"),
            "{}",
            blocks[1]
        );

        // The journal holds what the JSONL will: every text block, joined
        // with no separator — tugcode's pending-row match depends on it.
        let rows = ledger.list_pending_turns_for_session(session).unwrap();
        assert_eq!(rows[0].user_text, blocks.concat());
        assert!(shell.untold_landings(session).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_message_with_nothing_untold_is_byte_identical() {
        let (sup, ledger, _shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-quiet";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        let payload = content_payload(session, "hello");

        sup.dispatch_one(Frame::new(FeedId::CODE_INPUT, payload.clone()))
            .await;

        let queued = entry_arc.lock().await.queue.pop().expect("frame queued");
        assert_eq!(queued.payload, payload);
    }

    #[tokio::test]
    async fn a_told_landing_is_not_told_twice() {
        let (sup, ledger, shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-twice";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        record_commit_receipt(&shell, session);

        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            content_payload(session, "one"),
        ))
        .await;
        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            content_payload(session, "two"),
        ))
        .await;

        let mut entry = entry_arc.lock().await;
        assert_eq!(queued_text_blocks(&entry.queue.pop().unwrap()).len(), 2);
        assert_eq!(queued_text_blocks(&entry.queue.pop().unwrap()), ["two"]);
    }

    #[tokio::test]
    async fn a_slash_command_carries_no_block_and_leaves_the_landing_untold() {
        let (sup, ledger, shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-slash";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        record_commit_receipt(&shell, session);
        let slash = content_payload(session, "/compact");

        sup.dispatch_one(Frame::new(FeedId::CODE_INPUT, slash.clone()))
            .await;
        assert_eq!(entry_arc.lock().await.queue.pop().unwrap().payload, slash);
        assert_eq!(shell.untold_landings(session).unwrap().len(), 1);

        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            content_payload(session, "hello"),
        ))
        .await;
        let blocks = queued_text_blocks(&entry_arc.lock().await.queue.pop().unwrap());
        assert_eq!(blocks.len(), 2, "the next ordinary message carries it");
    }

    #[tokio::test]
    async fn a_dropped_send_does_not_mark_the_landing_told() {
        let (sup, ledger, shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-dropped";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        record_commit_receipt(&shell, session);
        entry_arc.lock().await.spawn_state = SpawnState::Closed;

        sup.dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            content_payload(session, "hello"),
        ))
        .await;

        assert_eq!(
            shell.untold_landings(session).unwrap().len(),
            1,
            "a frame dropped in a terminal state told nobody"
        );
    }

    #[tokio::test]
    async fn a_legacy_text_payload_is_left_alone() {
        let (sup, ledger, shell, _rx) = make_supervisor_with_ledger_and_shell();
        let session = "sess-legacy";
        let entry_arc = insert_ledger_entry(&sup, &TugSessionId::new(session)).await;
        seed_session_for_journal_test(&ledger, session);
        record_commit_receipt(&shell, session);
        let payload = serde_json::to_vec(&serde_json::json!({
            "tug_session_id": session,
            "type": "user_message",
            "text": "hello",
            "attachments": [],
        }))
        .unwrap();

        sup.dispatch_one(Frame::new(FeedId::CODE_INPUT, payload.clone()))
            .await;

        assert_eq!(entry_arc.lock().await.queue.pop().unwrap().payload, payload);
        assert_eq!(shell.untold_landings(session).unwrap().len(), 1);
    }

    /// A server-injected turn is an ordinary turn on the server side: the same
    /// dispatcher intercept journals it and opens it, with no second path into
    /// a session to keep in step. Driven with the bytes the base-motion engine
    /// actually sends, so the two cannot drift.
    #[tokio::test]
    async fn an_injected_turn_journals_and_opens_like_a_client_submission() {
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id_str = "sess-injected";
        let tug_session_id = TugSessionId::new(session_id_str);
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id_str);
        assert!(!entry_arc.lock().await.turn_active);

        let payload = crate::feeds::base_motion::user_message_payload(
            session_id_str,
            "[base-motion replay] the base moved",
        );
        sup.dispatch_one(Frame::new(FeedId::CODE_INPUT, payload.clone()))
            .await;

        let rows = ledger
            .list_pending_turns_for_session(session_id_str)
            .unwrap();
        assert_eq!(rows.len(), 1, "the injection journals a pending turn");
        assert_eq!(rows[0].user_text, "[base-motion replay] the base moved");
        let mut entry = entry_arc.lock().await;
        assert!(entry.turn_active, "the injection opens a turn");
        assert_eq!(
            entry.queue.pop().expect("frame queued").payload,
            payload,
            "an injected frame forwards unchanged, exactly as a client's does",
        );
    }

    #[tokio::test]
    async fn dispatch_one_derives_journal_row_from_content_blocks() {
        // Step 5c invariant: a `user_message` payload carrying
        // Anthropic-API `content` blocks (post-Step-5c wire shape)
        // produces a journal row whose `user_text` is the concatenation
        // of text-block contents and `user_attachments` is one
        // wire-shape Attachment JSON per image block (filename: "",
        // media_type + content sourced from the block). The frame
        // forwards unchanged.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id_str = "sess-content-blocks";
        let tug_session_id = TugSessionId::new(session_id_str);

        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id_str);

        // Interleaved content blocks (text, image, text) — the shape
        // tugdeck's `buildWirePayload` emits at submit time.
        let body = serde_json::json!({
            "tug_session_id": session_id_str,
            "type": "user_message",
            "content": [
                {"type": "text", "text": "describe "},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "PNG-DATA",
                    },
                },
                {"type": "text", "text": " this"},
            ],
        });
        let original_payload = serde_json::to_vec(&body).unwrap();
        let frame = Frame::new(FeedId::CODE_INPUT, original_payload.clone());

        sup.dispatch_one(frame).await;

        // Journal row landed with the derived legacy view: text-block
        // contents concatenated; image block reshaped to wire-shape
        // Attachment with filename: "".
        let rows = ledger
            .list_pending_turns_for_session(session_id_str)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user_text, "describe  this");
        // user_attachments is decoded by the ledger reader into a
        // Vec<serde_json::Value> — each entry is one wire-shape
        // Attachment object derived from an image content block.
        let atts = &rows[0].user_attachments;
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["filename"], "");
        assert_eq!(atts[0]["media_type"], "image/png");
        assert_eq!(atts[0]["content"], "PNG-DATA");

        // Forwarded frame is byte-identical to the input — the
        // dispatcher reads the derived view for the journal but
        // forwards the raw content-block payload to tugcode unchanged.
        let mut entry = entry_arc.lock().await;
        let queued = entry.queue.pop().expect("frame queued");
        assert_eq!(
            queued.payload, original_payload,
            "dispatcher must forward content-block user_message frames unchanged (Step 5c)",
        );
    }

    // ── Step 5.10 — replay-bracket gate on the journal-pop intercept ─────────
    //
    // The merger's `process_outbound_frame_journal_gate` tracks per-session
    // `replay_brackets_open` from `replay_started` / `replay_complete` markers
    // and skips `apply_outbound_turn_intercept` while the counter is non-zero.
    // Without the gate, replay-emitted committed-turn `turn_complete`s pop
    // the user's still-pending journal row (the HMR-mid-stream regression
    // surfaced in the [Step 5](arc/tugplan-dev-mid-turn-replay.md#step-5)
    // close-out manual smoke).
    //
    // Counter (not bool) is defense-in-depth: a stray `replay_complete` on
    // a closed bracket is a saturating-decrement no-op, not an underflow
    // that re-opens the gate. tugcode's `runReplay` re-entrancy guard
    // prevents legitimate overlapping brackets, so in healthy operation
    // the counter is 0 between brackets and 1 during a bracket. The
    // bridge-respawn reset in `spawn_session_worker` clears the counter
    // back to 0 if a previous bridge died after `replay_started` but
    // before `replay_complete` — a stuck-non-zero counter would otherwise
    // make the new bridge's brackets nest into the stale outer bracket
    // and the gate would skip live `turn_complete`s indefinitely.

    fn replay_started_frame() -> Frame {
        let body = serde_json::json!({
            "type": "replay_started",
            "ipc_version": 2,
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    fn replay_complete_frame() -> Frame {
        let body = serde_json::json!({
            "type": "replay_complete",
            "count": 1,
            "ipc_version": 2,
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    /// An in-place rewind truncates the live file under the same id, so no
    /// `session_init` pushes the row again. tugcode's `session_rewound` is
    /// what makes tugcast re-read it, and the push that follows carries the
    /// conversation that is left rather than waiting for the next turn.
    #[tokio::test]
    async fn an_in_place_rewind_pushes_the_reduced_row() {
        const CLAUDE_ID: &str = "11111111-2222-3333-4444-0000000a0a0a";
        const PROJECT: &str = "/tmp/in-place-rewind-project";
        fn jsonl(prompts: &[&str]) -> String {
            let mut out = format!(
                "{{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"{CLAUDE_ID}\"}}\n"
            );
            for p in prompts {
                out.push_str(&format!(
                    "{{\"type\":\"user\",\"sessionId\":\"{CLAUDE_ID}\",\"cwd\":\"{PROJECT}\",\"timestamp\":\"2026-06-01T10:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{p}\"}}}}\n"
                ));
            }
            out
        }

        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let dir = projects.join(tugcore::claude_home::encode_project_dir(PROJECT));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{CLAUDE_ID}.jsonl"));
        std::fs::write(
            &path,
            jsonl(&["first prompt", "second prompt", "third prompt"]),
        )
        .unwrap();

        let ledger = Arc::new(
            SessionLedger::open_with_claude_home(
                root.path().join("sessions.db"),
                tugcore::claude_home::ClaudeHome::at(root.path()),
            )
            .unwrap(),
        );
        ledger
            .record_spawn(CLAUDE_ID, "ws", PROJECT, "card-1", 1, CLAUDE_ID, None)
            .unwrap();
        ledger
            .record_user_prompt(CLAUDE_ID, "third prompt")
            .unwrap();
        crate::external_sessions::scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(ledger.get(CLAUDE_ID).unwrap().unwrap().turn_count, 3);

        let (sup, _ledger, mut control_rx) = make_supervisor_for_ledger(Arc::clone(&ledger), None);
        let tug_session_id = TugSessionId::new("sess-in-place-rewind");
        let entry = insert_ledger_entry(&sup, &tug_session_id).await;
        entry.lock().await.claude_session_id = Some(CLAUDE_ID.to_owned());

        // tugcode truncated the file to its first two turns, respawned, and
        // announced it.
        std::fs::write(&path, jsonl(&["first prompt", "second prompt"])).unwrap();
        let rewound = Frame::new(
            FeedId::CODE_OUTPUT,
            serde_json::to_vec(&serde_json::json!({
                "type": "session_rewound",
                "sessionId": CLAUDE_ID,
                "ipc_version": 2,
            }))
            .unwrap(),
        );
        sup.process_outbound_frame_journal_gate(&tug_session_id, &rewound)
            .await;

        let pushed = loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
                .await
                .expect("a session_updated push follows the rewind")
                .expect("control feed open");
            let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if v["action"] == "session_updated" && v["session_id"] == CLAUDE_ID {
                break v;
            }
        };
        assert_eq!(pushed["fields"]["turn_count"], 2);
        assert_eq!(pushed["fields"]["last_user_prompt"], "second prompt");
    }

    #[tokio::test]
    async fn journal_gate_increments_bracket_counter_on_replay_started() {
        let (sup, _ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-bracket-open";
        let tug_session_id = TugSessionId::new(session_id);
        insert_ledger_entry(&sup, &tug_session_id).await;

        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_started_frame())
            .await;

        let entry_arc = sup
            .ledger
            .lock()
            .await
            .get(&tug_session_id)
            .cloned()
            .expect("entry exists");
        assert_eq!(
            entry_arc.lock().await.replay_brackets_open,
            1,
            "replay_started must increment the bracket counter to 1",
        );
    }

    #[tokio::test]
    async fn journal_gate_decrements_bracket_counter_on_replay_complete() {
        let (sup, _ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-bracket-close";
        let tug_session_id = TugSessionId::new(session_id);
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        // Seed counter = 1 (as if a replay had opened).
        entry_arc.lock().await.replay_brackets_open = 1;

        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_complete_frame())
            .await;

        assert_eq!(
            entry_arc.lock().await.replay_brackets_open,
            0,
            "replay_complete must decrement the bracket counter to 0",
        );
    }

    #[tokio::test]
    async fn journal_gate_replay_complete_at_zero_saturates_no_underflow() {
        // Defensive: a stray replay_complete on a closed bracket
        // (counter already 0) must NOT underflow into u32::MAX. The
        // saturating_sub keeps it at 0; subsequent live turn_completes
        // continue to pop the journal as normal.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-bracket-saturate";
        let tug_session_id = TugSessionId::new(session_id);
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id);
        ledger
            .insert_pending_turn(session_id, "j-saturate", "stay alive", &[], 1_000)
            .unwrap();

        // Counter starts at 0 (fresh entry).
        assert_eq!(entry_arc.lock().await.replay_brackets_open, 0);

        // Stray replay_complete: counter must clamp at 0.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_complete_frame())
            .await;
        assert_eq!(
            entry_arc.lock().await.replay_brackets_open,
            0,
            "saturating_sub at 0 must clamp; not underflow into u32::MAX",
        );

        // Live turn_complete now arrives. Gate is open (counter == 0);
        // intercept must fire and pop the row.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            0,
            "live turn_complete after a stray replay_complete must still pop the journal row",
        );
    }

    #[tokio::test]
    async fn journal_gate_stuck_nonzero_counter_is_reset_on_bridge_respawn() {
        // Stuck-non-zero scenario: a previous bridge emitted
        // `replay_started` (counter -> 1) but died before emitting
        // `replay_complete` (kill -9, panic, OOM before runReplay's
        // finally block ran). Without a reset on bridge respawn, the
        // counter stays at 1 forever, and every future live
        // `turn_complete` would skip the journal-pop intercept —
        // silently breaking the never-drop guarantee for all subsequent
        // submissions on this session.
        //
        // `spawn_session_worker` resets `replay_brackets_open = 0`
        // whenever a fresh bridge is wired up. This test simulates the
        // crash by manually setting the counter to a stuck value, then
        // observes that a `process_outbound_frame_journal_gate` on a
        // live `turn_complete` post-reset correctly pops the journal.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-stuck-counter";
        let tug_session_id = TugSessionId::new(session_id);
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id);
        ledger
            .insert_pending_turn(session_id, "j-stuck", "should still pop", &[], 1_000)
            .unwrap();

        // Simulate a stuck-non-zero counter from a prior bridge that
        // crashed mid-replay. The exact value doesn't matter — anything
        // > 0 leaves the gate skipping intercepts.
        entry_arc.lock().await.replay_brackets_open = 3;

        // While stuck, a turn_complete is skipped — pin this so the
        // reset is the only way to recover.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            1,
            "stuck-non-zero counter must skip intercept (no reset yet)",
        );

        // Bridge respawn resets the counter. We replicate the field
        // mutation `spawn_session_worker` performs without invoking the
        // full spawn path (which requires an actual subprocess).
        entry_arc.lock().await.replay_brackets_open = 0;

        // Post-reset, a live turn_complete pops the journal as normal.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            0,
            "post-respawn-reset, live turn_complete pops the row",
        );
    }

    #[tokio::test]
    async fn journal_gate_nested_brackets_open_count_correctly() {
        // tugcode's runReplay re-entrancy guard prevents legitimate
        // overlapping brackets in production, but the counter shape
        // tolerates them defensively. Two replay_started markers leave
        // the counter at 2; one replay_complete decrements to 1 (still
        // gating); the second decrements to 0 (gate opens).
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-nested";
        let tug_session_id = TugSessionId::new(session_id);
        let entry_arc = insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id);
        ledger
            .insert_pending_turn(session_id, "j-nested", "nested test", &[], 1_000)
            .unwrap();

        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_started_frame())
            .await;
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_started_frame())
            .await;
        assert_eq!(entry_arc.lock().await.replay_brackets_open, 2);

        // First replay_complete: counter -> 1, still gating.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_complete_frame())
            .await;
        assert_eq!(entry_arc.lock().await.replay_brackets_open, 1);
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            1,
            "turn_complete inside the still-open outer bracket must NOT pop",
        );

        // Second replay_complete: counter -> 0, gate opens.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_complete_frame())
            .await;
        assert_eq!(entry_arc.lock().await.replay_brackets_open, 0);
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            0,
            "turn_complete after both brackets close must pop",
        );
    }

    #[tokio::test]
    async fn journal_gate_skips_intercept_for_turn_complete_inside_replay_bracket() {
        // The HMR-mid-stream regression: replay's committed-turn
        // turn_complete frames must NOT pop the user's pending journal
        // row (which is the user's still-inflight submission claude
        // hasn't yet finished).
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-bracket-skip";
        let tug_session_id = TugSessionId::new(session_id);
        insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id);

        // Insert a pending journal row for the user's still-inflight submission.
        ledger
            .insert_pending_turn(session_id, "j-inflight", "still pending", &[], 1_000)
            .unwrap();
        assert_eq!(count_pending_for_session(&ledger, session_id), 1);

        // Open the replay bracket.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_started_frame())
            .await;

        // Replay emits a committed-turn turn_complete (claude's id, not
        // the user's pending journal id). Without the bracket gate this
        // would pop the user's pending row via FIFO.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;

        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            1,
            "replay-emitted turn_complete inside the bracket must NOT pop the pending journal row",
        );

        // Close the bracket.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &replay_complete_frame())
            .await;

        // Now the live turn_complete (claude's actual ack of the inflight
        // submission) arrives. The bracket is closed, so the intercept
        // fires and pops the row.
        sup.process_outbound_frame_journal_gate(&tug_session_id, &turn_complete_frame())
            .await;

        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            0,
            "live turn_complete after the bracket closes must pop the pending journal row",
        );
    }

    #[tokio::test]
    async fn journal_gate_unrelated_frames_are_pass_through() {
        // Non-bracket / non-terminal frames don't touch the journal or
        // the replay flag. assistant_text, system_metadata, etc. flow
        // through untouched by the gate.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let session_id = "sess-bracket-passthrough";
        let tug_session_id = TugSessionId::new(session_id);
        insert_ledger_entry(&sup, &tug_session_id).await;
        seed_session_for_journal_test(&ledger, session_id);
        ledger
            .insert_pending_turn(session_id, "j-keep", "keep me", &[], 1_000)
            .unwrap();

        let assistant_body = serde_json::json!({
            "type": "assistant_text",
            "msg_id": "msg_x",
            "seq": 1,
            "rev": 0,
            "text": "partial",
            "is_partial": true,
            "status": "partial",
            "ipc_version": 2,
        });
        let frame = Frame::new(
            FeedId::CODE_OUTPUT,
            serde_json::to_vec(&assistant_body).unwrap(),
        );
        sup.process_outbound_frame_journal_gate(&tug_session_id, &frame)
            .await;

        let entry_arc = sup
            .ledger
            .lock()
            .await
            .get(&tug_session_id)
            .cloned()
            .unwrap();
        assert_eq!(
            entry_arc.lock().await.replay_brackets_open,
            0,
            "assistant_text must not touch the bracket counter",
        );
        assert_eq!(
            count_pending_for_session(&ledger, session_id),
            1,
            "assistant_text must not pop the journal",
        );
    }

    #[tokio::test]
    async fn journal_gate_per_session_isolation_for_replay_state() {
        // Replay bracket on session A must not affect session B's
        // intercept. Two independent replays could run concurrently;
        // their per-session flags must be tracked separately.
        let (sup, ledger, _rx) = make_supervisor_with_ledger();
        let tug_a = TugSessionId::new("sess-a");
        let tug_b = TugSessionId::new("sess-b");
        insert_ledger_entry(&sup, &tug_a).await;
        insert_ledger_entry(&sup, &tug_b).await;
        seed_session_for_journal_test(&ledger, "sess-a");
        seed_session_for_journal_test(&ledger, "sess-b");

        ledger
            .insert_pending_turn("sess-a", "j-a", "for sess-a", &[], 1_000)
            .unwrap();
        ledger
            .insert_pending_turn("sess-b", "j-b", "for sess-b", &[], 1_000)
            .unwrap();

        // Open the bracket on session A only.
        sup.process_outbound_frame_journal_gate(&tug_a, &replay_started_frame())
            .await;

        // turn_complete on session B should pop B's row (B is NOT in a replay bracket).
        sup.process_outbound_frame_journal_gate(&tug_b, &turn_complete_frame())
            .await;

        assert_eq!(count_pending_for_session(&ledger, "sess-a"), 1);
        assert_eq!(
            count_pending_for_session(&ledger, "sess-b"),
            0,
            "session B's bracket flag stays false; its turn_complete pops as normal",
        );
    }

    // ── the replay lineage ([P10]) ───────────────────────────────────────────

    /// A real ledger holding a conversation and three stages forked from one
    /// another, bound to `arc`, with the matching `arc-stage` lines on disk.
    fn seed_arc_lineage(root: &Path, arc: &str) -> Arc<crate::session_ledger::SessionLedger> {
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        let ids = ["s-conv", "s-devise", "s-review", "s-implement"];
        for id in ids {
            ledger
                .record_spawn(id, "ws", &root.to_string_lossy(), "card-1", 0, id, None)
                .expect("record_spawn");
        }
        // Only the conversation's row carries the binding: it is the tug
        // session id the deck spawned with and the one `arc run` bound. The
        // stage rows are fresh spawns and carry none, exactly as production
        // leaves them.
        ledger
            .set_arc_binding("s-conv", Some(("arc-id", arc)))
            .expect("arc binding");
        for pair in ids.windows(2) {
            // A stage descends from its parent with no branch point ([P03]).
            ledger
                .set_fork_provenance(pair[1], pair[0], None)
                .expect("provenance");
        }
        tugarc_core::arc::append_arc_start(root, arc, "arc/foo-brief.md").expect("arc-start");
        for (stage, id, model) in [
            (tugarc_core::arc::ArcStage::Devise, "s-devise", "opus"),
            (tugarc_core::arc::ArcStage::Review, "s-review", "fable"),
            (tugarc_core::arc::ArcStage::Implement, "s-implement", "opus"),
        ] {
            tugarc_core::arc::append_arc_stage(root, arc, stage, id, Some(model))
                .expect("arc-stage");
        }
        ledger
    }

    #[test]
    fn the_lineage_for_a_three_stage_arc_reads_conversation_devise_review_implement() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let ledger = seed_arc_lineage(root, "foo");
        let recorder = LedgerSessionsRecorder::new(Arc::clone(&ledger));

        let lineage = replay_lineage(&recorder, "s-implement", root).expect("a lineage");

        let ids: Vec<&str> = lineage
            .iter()
            .map(|e| e["sessionId"].as_str().expect("sessionId"))
            .collect();
        assert_eq!(ids, vec!["s-conv", "s-devise", "s-review", "s-implement"]);

        // The conversation the arc was handed off from ran no stage, so it
        // gets no divider — everything after it does.
        let stages: Vec<Option<&str>> = lineage
            .iter()
            .map(|e| e.get("stage").and_then(|s| s.as_str()))
            .collect();
        assert_eq!(
            stages,
            vec![None, Some("devise"), Some("review"), Some("implement")]
        );
        assert_eq!(lineage[1]["model"], "opus");
        assert_eq!(lineage[2]["model"], "fable");
        assert_eq!(lineage[1]["arc"], "foo");
        assert_eq!(lineage[1]["document"], "arc/foo-brief.md");
    }

    /// The invariant [B05] asks for: a rotation's transcript survives a
    /// relaunch. With no arc behind it there is no arc binding and no arc
    /// record to read, so the lineage has to come off the row or not at all.
    #[test]
    fn a_chain_rotated_with_no_score_behind_it_still_carries_its_lineage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        for id in ["s-first", "s-rotated"] {
            ledger
                .record_spawn(id, "ws", &root.to_string_lossy(), "card-1", 0, id, None)
                .expect("record_spawn");
        }
        ledger
            .set_fork_provenance("s-rotated", "s-first", None)
            .expect("provenance");
        ledger
            .set_stage_provenance("s-rotated", "review", Some("opus"))
            .expect("stage provenance");

        let recorder = LedgerSessionsRecorder::new(ledger);
        let lineage = replay_lineage(&recorder, "s-rotated", root).expect("a lineage");

        assert_eq!(lineage.len(), 2);
        assert!(
            lineage[0].get("stage").is_none(),
            "the session the rotation replaced was seated by nothing"
        );
        assert_eq!(lineage[1]["stage"], "review");
        assert_eq!(lineage[1]["model"], "opus");
        assert!(
            lineage[1].get("arc").is_none() && lineage[1].get("document").is_none(),
            "a rotation with no arc names neither"
        );
    }

    /// The columns are the answer and the arc record is the fallback, so a
    /// chain carrying both must read exactly as the chain carrying only the
    /// record does — otherwise an arc that rotated on an older build would
    /// replay differently from one that rotated today.
    #[test]
    fn a_stage_carrying_both_the_columns_and_the_record_reads_the_same_either_way() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let ledger = seed_arc_lineage(root, "foo");
        let from_record = replay_lineage(
            &LedgerSessionsRecorder::new(Arc::clone(&ledger)),
            "s-implement",
            root,
        )
        .expect("a lineage");

        for (id, label, model) in [
            ("s-devise", "devise", "opus"),
            ("s-review", "review", "fable"),
            ("s-implement", "implement", "opus"),
        ] {
            ledger
                .set_stage_provenance(id, label, Some(model))
                .expect("stage provenance");
        }
        let from_columns =
            replay_lineage(&LedgerSessionsRecorder::new(ledger), "s-implement", root)
                .expect("a lineage");

        assert_eq!(from_columns, from_record);
    }

    #[test]
    fn a_session_with_no_forks_carries_no_lineage() {
        // The overwhelming majority of cards. Their request must stay
        // byte-identical to what it was before lineage existed.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        ledger
            .record_spawn(
                "solo",
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                "solo",
                None,
            )
            .expect("record_spawn");
        let recorder = LedgerSessionsRecorder::new(ledger);
        assert!(replay_lineage(&recorder, "solo", root).is_none());
    }

    // ── the directory edge ([P04], [P05]) ────────────────────────────────────

    /// A ledger holding `ids` spawned in the matching `dirs`, each forked from
    /// the one before with no branch point — the `relocate` edge's shape.
    fn seed_dir_chain(ids: &[&str], dirs: &[&str]) -> Arc<crate::session_ledger::SessionLedger> {
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        for (id, dir) in ids.iter().zip(dirs) {
            ledger
                .record_spawn(id, "ws", dir, "card-1", 0, id, None)
                .expect("record_spawn");
        }
        for pair in ids.windows(2) {
            ledger
                .set_fork_provenance(pair[1], pair[0], None)
                .expect("provenance");
        }
        ledger
    }

    #[test]
    fn relocation_edge_names_the_first_cross_directory_fork_from_the_tip() {
        let (a, b) = ("/nonexistent/relocation-A", "/nonexistent/relocation-B");
        let ledger = seed_dir_chain(&["a", "b", "c"], &[a, b, b]);
        let recorder = LedgerSessionsRecorder::new(ledger);
        assert_eq!(
            relocation_edge(&recorder, "c"),
            Some(("a".to_string(), a.to_string(), b.to_string())),
        );

        let same = seed_dir_chain(&["x", "y", "z"], &[a, a, a]);
        assert_eq!(
            relocation_edge(&LedgerSessionsRecorder::new(same), "z"),
            None
        );
    }

    /// Stages that ran in `A`, then a move to `B`: the moved session's own
    /// JSONL already carries what it inherited, so the lineage is cut at the
    /// edge and `m` stands alone — no lineage to send.
    #[test]
    fn replay_lineage_stops_at_the_directory_edge() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let (a, b) = ("/nonexistent/relocation-A", "/nonexistent/relocation-B");
        let ledger = seed_dir_chain(&["s1", "s2", "m"], &[a, a, b]);
        for id in ["s1", "s2", "m"] {
            ledger
                .set_stage_provenance(id, "implement", Some("opus"))
                .expect("stage provenance");
        }
        let recorder = LedgerSessionsRecorder::new(Arc::clone(&ledger));
        assert!(replay_lineage(&recorder, "m", root).is_none());
        // Without the move the same rows are a lineage of three.
        let unmoved = seed_dir_chain(&["s1", "s2", "m"], &[a, a, a]);
        for id in ["s1", "s2", "m"] {
            unmoved
                .set_stage_provenance(id, "implement", Some("opus"))
                .expect("stage provenance");
        }
        let lineage =
            replay_lineage(&LedgerSessionsRecorder::new(unmoved), "m", root).expect("a lineage");
        assert_eq!(lineage.len(), 3);
    }

    /// A card that moved replays with the move named on the request, so
    /// tugcode draws the divider on every replay, not only the first.
    #[tokio::test]
    async fn request_replay_names_the_relocation_of_a_moved_card() {
        let dir_a = tempfile::tempdir().expect("tempdir");
        let dir_b = tempfile::tempdir().expect("tempdir");
        let a = dir_a.path().to_string_lossy().to_string();
        let b = dir_b.path().to_string_lossy().to_string();
        let (sup, _ledger, _rx) =
            make_supervisor_for_ledger(seed_dir_chain(&["parent", "moved"], &[&a, &b]), None);

        sup.handle_control(
            "spawn_session",
            &resume_payload_in("card-1", "moved", &b),
            10,
        )
        .await
        .expect_handled();
        sup.handle_control("request_replay", &request_replay_payload("moved"), 10)
            .await
            .expect_handled();

        let entry_arc = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("moved"))
                .cloned()
                .expect("the spawn inserted an entry")
        };
        let frame = entry_arc
            .lock()
            .await
            .queue
            .pop()
            .expect("request_replay queued");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["type"], "request_replay");
        assert_eq!(
            body["relocation"],
            serde_json::json!({ "parentSessionId": "parent", "fromDir": a, "toDir": b }),
        );
        assert!(body.get("lineage").is_none(), "the cut leaves no lineage");
    }

    /// The line [F01] describes: a door that ran no stage, then implement,
    /// then audit, each forked from the last. Three segments, and only the
    /// door's row carries the arc binding — the stages are fresh spawns.
    fn seed_resume_sheet_line(root: &Path, arc: &str) -> Arc<crate::session_ledger::SessionLedger> {
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        let ids = ["s-door", "s-implement", "s-audit"];
        for id in ids {
            ledger
                .record_spawn(id, "ws", &root.to_string_lossy(), "card-1", 0, id, None)
                .expect("record_spawn");
        }
        ledger
            .set_arc_binding("s-door", Some(("arc-id", arc)))
            .expect("arc binding");
        for pair in ids.windows(2) {
            ledger
                .set_fork_provenance(pair[1], pair[0], None)
                .expect("provenance");
        }
        tugarc_core::arc::append_arc_start(root, arc, "arc/foo-brief.md").expect("arc-start");
        for (stage, id) in [
            (tugarc_core::arc::ArcStage::Implement, "s-implement"),
            (tugarc_core::arc::ArcStage::Audit, "s-audit"),
        ] {
            tugarc_core::arc::append_arc_stage(root, arc, stage, id, Some("opus"))
                .expect("arc-stage");
        }
        ledger
    }

    /// The resume sheet restores a rotated line onto a card the ledger has
    /// never seen, so the entry it inserts carries no `claude_session_id` — and
    /// the replay is queued during the spawning window, before tugcode's
    /// `session_init` fills it. A lookup reading that field alone finds no
    /// lineage there and the card replays the tip segment by itself, which is
    /// how the arc's durable ink came to stand above a transcript that never
    /// held the turns it names. Seeded from the id the spawn resumes, the whole
    /// line comes back.
    #[tokio::test]
    async fn a_resume_onto_a_card_the_ledger_has_never_seen_replays_the_whole_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let root_str = root.to_string_lossy().to_string();
        let (sup, _ledger, _rx) =
            make_supervisor_for_ledger(seed_resume_sheet_line(root, "foo"), None);

        sup.handle_control(
            "spawn_session",
            &resume_payload_in("card-fresh", "s-audit", &root_str),
            10,
        )
        .await
        .expect_handled();

        let entry_arc = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("s-audit"))
                .cloned()
                .expect("the resume inserted an entry")
        };
        assert!(
            entry_arc.lock().await.claude_session_id.is_none(),
            "precondition: the fresh entry has no claude id when the replay is queued",
        );

        sup.handle_control("request_replay", &request_replay_payload("s-audit"), 10)
            .await
            .expect_handled();

        let frame = {
            let mut entry = entry_arc.lock().await;
            entry.queue.pop().expect("request_replay queued")
        };
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["type"], "request_replay");
        let lineage = body["lineage"].as_array().expect("a lineage");
        let ids: Vec<&str> = lineage
            .iter()
            .map(|e| e["sessionId"].as_str().expect("sessionId"))
            .collect();
        assert_eq!(ids, vec!["s-door", "s-implement", "s-audit"]);
        let stages: Vec<Option<&str>> = lineage
            .iter()
            .map(|e| e.get("stage").and_then(|s| s.as_str()))
            .collect();
        assert_eq!(
            stages,
            vec![None, Some("implement"), Some("audit")],
            "the door ran no stage; the two after it are named in the order they ran",
        );
    }

    /// The seed is a fallback and nothing more. A resume of a card that is one
    /// stage-less session finds no lineage under its own id either, so its
    /// request stays the bare verb it has always been — byte for byte, which is
    /// the whole of what the overwhelming majority of cards send.
    #[tokio::test]
    async fn a_resume_of_a_single_stageless_segment_still_sends_the_bare_verb() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let root_str = root.to_string_lossy().to_string();
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        ledger
            .record_spawn("solo", "ws", &root_str, "card-1", 0, "solo", None)
            .expect("record_spawn");
        let (sup, _ledger, _rx) = make_supervisor_for_ledger(ledger, None);

        sup.handle_control(
            "spawn_session",
            &resume_payload_in("card-fresh", "solo", &root_str),
            10,
        )
        .await
        .expect_handled();
        sup.handle_control("request_replay", &request_replay_payload("solo"), 10)
            .await
            .expect_handled();

        let entry_arc = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("solo"))
                .cloned()
                .expect("the resume inserted an entry")
        };
        let mut entry = entry_arc.lock().await;
        let frame = entry.queue.pop().expect("request_replay queued");
        assert_eq!(
            frame.payload,
            b"{\"type\":\"request_replay\"}".to_vec(),
            "no window and no lineage is the legacy full-replay request, unchanged",
        );
    }

    /// [B02]: what a replay walked is a fact about that request, so the
    /// request writes it down. The `replay_complete` stamp reads this list
    /// back to sum its denominator over exactly the files that produced the
    /// transcript, rather than recomputing a chain that would usually — but
    /// only usually — agree.
    #[tokio::test]
    async fn a_replay_carrying_a_lineage_remembers_the_segments_it_walked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let root_str = root.to_string_lossy().to_string();
        let (sup, _ledger, _rx) =
            make_supervisor_for_ledger(seed_resume_sheet_line(root, "foo"), None);

        sup.handle_control(
            "spawn_session",
            &resume_payload_in("card-fresh", "s-audit", &root_str),
            10,
        )
        .await
        .expect_handled();
        sup.handle_control("request_replay", &request_replay_payload("s-audit"), 10)
            .await
            .expect_handled();

        let entry_arc = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("s-audit"))
                .cloned()
                .expect("the resume inserted an entry")
        };
        let entry = entry_arc.lock().await;
        assert_eq!(
            entry.replayed_lineage.as_deref(),
            Some(
                [
                    "s-door".to_string(),
                    "s-implement".to_string(),
                    "s-audit".to_string()
                ]
                .as_slice()
            ),
            "the three segments the request carried, oldest first",
        );
    }

    /// And the other half of [B02]: a card that is not an arc walks one file,
    /// carries no lineage, and remembers none — so the stamp sums the tip
    /// alone, which is what it did before any of this existed.
    #[tokio::test]
    async fn a_replay_carrying_no_lineage_remembers_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let root_str = root.to_string_lossy().to_string();
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        ledger
            .record_spawn("solo", "ws", &root_str, "card-1", 0, "solo", None)
            .expect("record_spawn");
        let (sup, _ledger, _rx) = make_supervisor_for_ledger(ledger, None);

        sup.handle_control(
            "spawn_session",
            &resume_payload_in("card-fresh", "solo", &root_str),
            10,
        )
        .await
        .expect_handled();
        sup.handle_control("request_replay", &request_replay_payload("solo"), 10)
            .await
            .expect_handled();

        let entry_arc = {
            let ledger = sup.ledger.lock().await;
            ledger
                .get(&TugSessionId::new("solo"))
                .cloned()
                .expect("the resume inserted an entry")
        };
        let entry = entry_arc.lock().await;
        assert!(
            entry.replayed_lineage.is_none(),
            "a single-segment card remembers no lineage",
        );
    }

    #[test]
    fn a_fork_chain_with_no_arc_record_carries_no_lineage() {
        // A rewind-fork lineage: real fork edges, no arc behind them. tugcode
        // already replays these correctly by resuming the tip, and a lineage
        // with nothing to divide would only add work.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let ledger =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"));
        for id in ["root", "fork"] {
            ledger
                .record_spawn(id, "ws", &root.to_string_lossy(), "card-1", 0, id, None)
                .expect("record_spawn");
        }
        ledger
            .set_fork_provenance("fork", "root", Some("prompt-uuid"))
            .expect("provenance");
        let recorder = LedgerSessionsRecorder::new(ledger);
        assert!(replay_lineage(&recorder, "fork", root).is_none());
    }
}

// ---------------------------------------------------------------------------
// A panic in the bridge costs one session, out loud
// ---------------------------------------------------------------------------

#[cfg(test)]
mod bridge_panic_tests {
    use super::super::agent_bridge::{AuthProbe, CrashBudget, SessionChild, SpawnFuture};
    use super::super::claude_auth::{AccountInfo, AuthState};
    use super::*;
    use std::collections::VecDeque;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    /// A scripted tugcode stdout that serves its lines and then panics in
    /// the read — inside the relay's own poll, which is where a panic on a
    /// transcript's contents happens.
    struct PanicsAfterScript {
        script: Vec<u8>,
        served: usize,
    }

    impl AsyncRead for PanicsAfterScript {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.served == self.script.len() {
                panic!("scripted relay panic");
            }
            let n = buf.remaining().min(self.script.len() - self.served);
            let from = self.served;
            buf.put_slice(&self.script[from..from + n]);
            self.served += n;
            Poll::Ready(Ok(()))
        }
    }

    /// Every spawn hands back a child that opens a replay bracket and dies
    /// in the relay before closing it.
    struct PanicMidBracketSpawner;

    impl ChildSpawner for PanicMidBracketSpawner {
        fn spawn_child(
            &self,
            _project_dir: &std::path::Path,
            _session_id: &str,
            _session_mode: SessionMode,
            _resume_claude_session_id: Option<&str>,
            _permission_mode: Option<&str>,
            _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
        ) -> SpawnFuture {
            Box::pin(async {
                let (bridge_stdin, child_stdin_read) = tokio::io::duplex(8192);
                let script = concat!(
                    "{\"type\":\"protocol_ack\",\"version\":1}\n",
                    "{\"type\":\"session_init\",\"session_id\":\"claude-panics\"}\n",
                    "{\"type\":\"replay_started\"}\n",
                );
                Ok(SessionChild {
                    stdin: Box::new(bridge_stdin),
                    stdout: Box::new(PanicsAfterScript {
                        script: script.as_bytes().to_vec(),
                        served: 0,
                    }),
                    pid: None,
                    // The read half stays open so the relay's handshake
                    // write lands somewhere.
                    _keepalive: Box::new(child_stdin_read),
                    stderr_tail: Arc::new(parking_lot::Mutex::new(VecDeque::new())),
                })
            })
        }
    }

    /// Collects what `tracing` wrote, so the test can read the log line.
    #[derive(Clone, Default)]
    struct LogSink(Arc<parking_lot::Mutex<Vec<u8>>>);

    impl std::io::Write for LogSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn entry_with_budget(tug_id: &TugSessionId, max_crashes: usize) -> Arc<Mutex<LedgerEntry>> {
        Arc::new(Mutex::new(LedgerEntry::new(
            tug_id.clone(),
            WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR")),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            CrashBudget::new(max_crashes, Duration::from_secs(60)),
        )))
    }

    #[tokio::test]
    async fn a_relay_panic_mid_bracket_is_a_crash_with_a_closed_bracket_and_a_visible_error() {
        crate::panic_hook::install();
        let sink = LogSink::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer({
                let sink = sink.clone();
                move || sink.clone()
            })
            .with_ansi(false)
            .finish();
        let _log = tracing::subscriber::set_default(subscriber);

        let tug_id = TugSessionId::new("sess-relay-panics");
        // One crash spends the budget, so the bridge ends on its second pass
        // without spawning again.
        let entry = entry_with_budget(&tug_id, 1);
        let (_input_tx, input_rx) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(16);
        let (state_tx, mut state_rx) = broadcast::channel::<Frame>(16);

        run_session_bridge(
            tug_id.clone(),
            entry.clone(),
            input_rx,
            merger_tx,
            state_tx,
            None,
            Arc::new(PanicMidBracketSpawner),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            Arc::new(NoopSessionsRecorder),
            None,
            crate::feeds::changeset::ChangesetBumper::disconnected(),
            CancellationToken::new(),
            Duration::from_millis(1),
            // The host fact this test is not about, stated instead of
            // inherited: the respawn auth gate shells out to the real `claude`,
            // so a machine without one ends the bridge before the retry spawns.
            AuthProbe::Fixed(AuthState::LoggedIn(AccountInfo::default())),
        )
        .await;

        // The bracket the relay opened is closed, with an error, by the frame
        // the deck and the merger already end a bracket on.
        let mut types: Vec<String> = Vec::new();
        let mut close: Option<serde_json::Value> = None;
        while let Ok(frame) = merger_rx.try_recv() {
            let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            let kind = parsed["type"].as_str().unwrap_or("").to_string();
            if kind == "replay_complete" {
                close = Some(parsed);
            }
            types.push(kind);
        }
        let started = types.iter().position(|t| t == "replay_started");
        let completed = types.iter().position(|t| t == "replay_complete");
        assert!(
            started.is_some() && completed > started,
            "replay_started then replay_complete, got {types:?}"
        );
        let close = close.unwrap();
        assert_eq!(close["error"]["kind"], "replay_exception");
        assert_eq!(close["tug_session_id"], tug_id.as_str());

        // The panic went through the crash budget like any relay death.
        assert!(entry.lock().await.crash_budget.is_exhausted());
        assert_eq!(entry.lock().await.spawn_state, SpawnState::Errored);

        // The session-state frame the deck turns into the card's error names
        // the panic as the reason.
        let mut errored_detail: Option<String> = None;
        while let Ok(frame) = state_rx.try_recv() {
            let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if parsed["state"] == "errored" {
                errored_detail = parsed["detail"].as_str().map(str::to_string);
            }
        }
        let detail = errored_detail.expect("an errored SESSION_STATE frame");
        assert!(
            detail.starts_with("crash_budget_exhausted\nbridge panicked at "),
            "detail was {detail:?}"
        );
        assert!(detail.contains("scripted relay panic"));
        assert!(detail.contains(file!()), "location in {detail:?}");

        // And the log says so, at error, with message and location.
        let log = String::from_utf8(sink.0.lock().clone()).unwrap();
        let line = log
            .lines()
            .find(|l| l.contains("session relay panicked at "))
            .unwrap_or_else(|| panic!("no relay panic line in log:\n{log}"));
        assert!(line.contains("ERROR"));
        assert!(line.contains("scripted relay panic"));
        assert!(line.contains(file!()));
        assert!(line.contains("mid_bracket=true"));
    }

    #[tokio::test]
    async fn a_bridge_panic_outside_the_relay_ends_the_session_errored() {
        let tug_id = TugSessionId::new("sess-bridge-panics");
        let entry = entry_with_budget(&tug_id, 3);
        let (state_tx, mut state_rx) = broadcast::channel::<Frame>(4);

        end_session_after_bridge_panic(
            &tug_id,
            &entry,
            &state_tx,
            &NoopSessionsRecorder,
            "panicked at src/x.rs:1:2: boom (thread main)",
        )
        .await;

        let guard = entry.lock().await;
        assert_eq!(guard.spawn_state, SpawnState::Errored);
        assert!(guard.input_tx.is_none());
        drop(guard);
        let frame = state_rx.try_recv().expect("an errored frame");
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["state"], "errored");
        assert_eq!(
            parsed["detail"],
            "bridge_panicked\npanicked at src/x.rs:1:2: boom (thread main)"
        );
    }

    #[tokio::test]
    async fn a_session_already_closed_publishes_nothing_when_its_bridge_panics() {
        let tug_id = TugSessionId::new("sess-closed-then-panics");
        let entry = entry_with_budget(&tug_id, 3);
        entry.lock().await.spawn_state = SpawnState::Closed;
        let (state_tx, mut state_rx) = broadcast::channel::<Frame>(4);

        end_session_after_bridge_panic(&tug_id, &entry, &state_tx, &NoopSessionsRecorder, "boom")
            .await;

        assert_eq!(entry.lock().await.spawn_state, SpawnState::Closed);
        assert!(state_rx.try_recv().is_err());
    }
}

// ---------------------------------------------------------------------------
// A replay bracket always closes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod replay_bracket_close_tests {
    use super::super::agent_bridge::{
        AuthProbe, CrashBudget, REPLAY_BRACKET_DEADLINE, RelayOutcome, SessionChild, SpawnFuture,
        relay_session_io,
    };
    use super::super::claude_auth::{AccountInfo, AuthState};
    use super::*;
    use std::collections::VecDeque;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const OPENING: &[u8] = concat!(
        "{\"type\":\"protocol_ack\",\"version\":1}\n",
        "{\"type\":\"session_init\",\"session_id\":\"claude-bracket\"}\n",
        "{\"type\":\"replay_started\"}\n",
    )
    .as_bytes();

    /// A tugcode that opens a replay bracket and then goes quiet without
    /// closing its stdout: no further line, and no EOF, ever arrives. The
    /// watchdog has only the clock to go on.
    #[tokio::test(start_paused = true)]
    async fn a_bracket_left_open_by_a_quiet_stream_is_closed_by_the_watchdog() {
        let (sup, _register_rx) =
            test_minimal_supervisor_with_recorder(Arc::new(NoopSessionsRecorder));
        let tug_id = TugSessionId::new("sess-quiet-bracket");
        let entry = insert_ledger_entry_for_tests(&sup, &tug_id).await;

        let (bridge_stdin, mut child_stdin_read) = tokio::io::duplex(8192);
        let (mut child_stdout_write, bridge_stdout) = tokio::io::duplex(8192);
        let child = tokio::spawn(async move {
            let mut line = String::new();
            BufReader::new(&mut child_stdin_read)
                .read_line(&mut line)
                .await
                .unwrap();
            child_stdout_write.write_all(OPENING).await.unwrap();
            // Hold both pipes open and say nothing more.
            std::future::pending::<()>().await;
            drop((child_stdout_write, child_stdin_read));
        });

        let (_input_tx, mut input_rx) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(16);
        let state_tx = sup.session_state.sender();
        let cancel = CancellationToken::new();
        let relay = {
            let (tug_id, entry, cancel) = (tug_id.clone(), entry.clone(), cancel.clone());
            tokio::spawn(async move {
                let stdout: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(bridge_stdout);
                relay_session_io(
                    &tug_id,
                    &entry,
                    &mut input_rx,
                    &merger_tx,
                    &state_tx,
                    None,
                    Box::new(bridge_stdin),
                    BufReader::new(stdout).lines(),
                    "/tmp/test-quiet-bracket",
                    &NoopSessionsRecorder,
                    None,
                    &crate::feeds::changeset::ChangesetBumper::disconnected(),
                    &cancel,
                )
                .await
            })
        };

        // Play the merger: count each frame as it would, and stop at the
        // close. Nothing but the relay's own timer can produce one.
        let opened_at = tokio::time::Instant::now();
        let close = loop {
            let frame = merger_rx.recv().await.expect("the relay is still running");
            sup.process_outbound_frame_journal_gate(&tug_id, &frame)
                .await;
            let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            match parsed["type"].as_str() {
                Some("replay_started") => {
                    assert_eq!(entry.lock().await.replay_brackets_open, 1);
                }
                Some("replay_complete") => break parsed,
                _ => {}
            }
        };
        assert!(opened_at.elapsed() >= REPLAY_BRACKET_DEADLINE);
        assert_eq!(close["error"]["kind"], "replay_timeout");
        assert_eq!(close["tug_session_id"], tug_id.as_str());
        assert_eq!(entry.lock().await.replay_brackets_open, 0);

        // The relay outlived its bracket: it is still serving the session.
        assert!(!relay.is_finished());
        cancel.cancel();
        assert_eq!(relay.await.unwrap(), RelayOutcome::Cancelled);
        child.abort();
    }

    /// Opens a bracket and exits: stdout reaches EOF with the bracket open.
    struct DiesMidBracketSpawner;

    impl ChildSpawner for DiesMidBracketSpawner {
        fn spawn_child(
            &self,
            _project_dir: &std::path::Path,
            _session_id: &str,
            _session_mode: SessionMode,
            _resume_claude_session_id: Option<&str>,
            _permission_mode: Option<&str>,
            _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
        ) -> SpawnFuture {
            Box::pin(async {
                let (bridge_stdin, child_stdin_read) = tokio::io::duplex(8192);
                Ok(SessionChild {
                    stdin: Box::new(bridge_stdin),
                    stdout: Box::new(OPENING),
                    pid: None,
                    _keepalive: Box::new(child_stdin_read),
                    stderr_tail: Arc::new(parking_lot::Mutex::new(VecDeque::new())),
                })
            })
        }
    }

    #[tokio::test]
    async fn a_bridge_that_ends_mid_bracket_leaves_the_bracket_closed_and_the_counter_zero() {
        let tug_id = TugSessionId::new("sess-dies-mid-bracket");
        // One crash spends the budget, so the bridge tears down for good.
        let entry = Arc::new(Mutex::new(LedgerEntry::new(
            tug_id.clone(),
            WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR")),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            CrashBudget::new(1, Duration::from_secs(60)),
        )));
        // The merger had already counted the open when the child died.
        entry.lock().await.replay_brackets_open = 1;
        let (_input_tx, input_rx) = mpsc::channel::<Frame>(4);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(16);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(16);

        run_session_bridge(
            tug_id.clone(),
            entry.clone(),
            input_rx,
            merger_tx,
            state_tx,
            None,
            Arc::new(DiesMidBracketSpawner),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            Arc::new(NoopSessionsRecorder),
            None,
            crate::feeds::changeset::ChangesetBumper::disconnected(),
            CancellationToken::new(),
            Duration::from_millis(1),
            AuthProbe::Fixed(AuthState::LoggedIn(AccountInfo::default())),
        )
        .await;

        assert_eq!(entry.lock().await.replay_brackets_open, 0);

        // And the bracket was closed in band, so a merger that had NOT yet
        // counted the open nets to zero too, and the deck leaves `replaying`.
        let mut kinds: Vec<(String, serde_json::Value)> = Vec::new();
        while let Ok(frame) = merger_rx.try_recv() {
            let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            kinds.push((parsed["type"].as_str().unwrap_or("").to_string(), parsed));
        }
        let brackets: Vec<&str> = kinds
            .iter()
            .map(|(t, _)| t.as_str())
            .filter(|t| t.starts_with("replay_"))
            .collect();
        assert_eq!(brackets, ["replay_started", "replay_complete"]);
        let close = &kinds
            .iter()
            .find(|(t, _)| t == "replay_complete")
            .unwrap()
            .1;
        assert_eq!(close["error"]["kind"], "replay_exception");
    }

    /// Records the `--permission-mode` of every spawn and dies immediately, so
    /// the bridge's own retry loop runs. The first spawn also stamps the entry
    /// the way `dispatch_one` does when the user's `permission_mode` frame
    /// arrives while the child is up.
    struct DiesAfterStampingSpawner {
        modes: mpsc::UnboundedSender<Option<String>>,
        entry: Arc<Mutex<LedgerEntry>>,
        stamp: String,
        spawns: std::sync::atomic::AtomicUsize,
    }

    impl ChildSpawner for DiesAfterStampingSpawner {
        fn spawn_child(
            &self,
            _project_dir: &std::path::Path,
            _session_id: &str,
            _session_mode: SessionMode,
            _resume_claude_session_id: Option<&str>,
            permission_mode: Option<&str>,
            _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
        ) -> SpawnFuture {
            let _ = self.modes.send(permission_mode.map(str::to_string));
            let first = self
                .spawns
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                == 0;
            let entry = Arc::clone(&self.entry);
            let stamp = self.stamp.clone();
            Box::pin(async move {
                if first {
                    entry.lock().await.permission_mode = Some(stamp);
                }
                let (bridge_stdin, child_stdin_read) = tokio::io::duplex(8192);
                Ok(SessionChild {
                    stdin: Box::new(bridge_stdin),
                    // Empty stdout: the child is gone the instant it is up, so
                    // the bridge counts a crash and takes its retry.
                    stdout: Box::new(&b""[..]),
                    pid: None,
                    _keepalive: Box::new(child_stdin_read),
                    stderr_tail: Arc::new(parking_lot::Mutex::new(VecDeque::new())),
                })
            })
        }
    }

    /// A crash-loop respawn carries the mode the session is in, like every
    /// other respawn.
    ///
    /// The three respawns are not three copies of one path. A wheel rotation
    /// and an arc Resume each go round `spawn_session_worker`, which reads
    /// `entry.permission_mode` fresh; a crash-loop respawn never leaves
    /// `run_session_bridge`, so it only sees the entry if the loop reads it
    /// again. A mode resolved once, above the loop, would hand every retry the
    /// mode the bridge started on — putting the session back in the mode the
    /// user switched away from, which is the whole defect, surviving on the
    /// one path nothing else covers.
    #[tokio::test]
    async fn a_crash_loop_respawn_carries_the_mode_the_session_is_in() {
        let tug_id = TugSessionId::new("sess-crash-loop-mode");
        // Two crashes: the first spawn dies and is retried, the second spends
        // the budget and ends the bridge.
        let entry = Arc::new(Mutex::new(LedgerEntry::new(
            tug_id.clone(),
            WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR")),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            CrashBudget::new(2, Duration::from_secs(60)),
        )));
        entry.lock().await.permission_mode = Some("auto".to_string());
        let (tx, mut spawned_modes) = mpsc::unbounded_channel::<Option<String>>();
        let (_input_tx, input_rx) = mpsc::channel::<Frame>(4);
        let (merger_tx, _merger_rx) = mpsc::channel::<Frame>(16);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(16);

        run_session_bridge(
            tug_id.clone(),
            entry.clone(),
            input_rx,
            merger_tx,
            state_tx,
            None,
            Arc::new(DiesAfterStampingSpawner {
                modes: tx,
                entry: entry.clone(),
                stamp: "bypassPermissions".to_string(),
                spawns: std::sync::atomic::AtomicUsize::new(0),
            }),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            SessionMode::Resume,
            Arc::new(NoopSessionsRecorder),
            None,
            crate::feeds::changeset::ChangesetBumper::disconnected(),
            CancellationToken::new(),
            Duration::from_millis(1),
            // The gate this test used to fall through by luck. Its budget is 2,
            // so the second pass is a real respawn and the probe really runs —
            // which is why this is the one crash test CI could fail.
            AuthProbe::Fixed(AuthState::LoggedIn(AccountInfo::default())),
        )
        .await;

        let mut modes = Vec::new();
        while let Ok(mode) = spawned_modes.try_recv() {
            modes.push(mode);
        }
        assert_eq!(
            modes
                .iter()
                .map(|m| m.as_deref().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["auto", "bypassPermissions"],
            "the retry spawns in the mode the entry holds, not the one the bridge began on",
        );
    }
}
