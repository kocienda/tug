//! Agent bridge module
//!
//! Per-session relay between the supervisor and a tugcode subprocess. Each
//! live Claude Code session runs an instance of [`run_session_bridge`], which
//! spawns the configured subprocess, performs the protocol handshake, and
//! relays CODE_INPUT frames to stdin and splice-stamped stdout lines to the
//! supervisor's merger channel.
//!
//! Subprocess spawning is abstracted behind [`ChildSpawner`] so unit tests
//! can simulate crash loops, handshake failures, and `session_init` emissions
//! without actually executing a binary.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use tugcast_core::protocol::{FeedId, Frame, TugSessionId};

use super::agent_supervisor::{
    LedgerEntry, SessionRecord, SessionsRecorder, SpawnState, build_session_state_frame,
};
use super::attribution::{
    CMD_ORIGIN, DeclaredPromotions, InspectedReplayBatch, InspectedToolResult, InspectedToolUse,
    OpenBracket, PendingCalls, PendingCmd, PendingCmds, RECEIPT_MARKER, bash_command_for_tool,
    canonicalize_declared, declared_ops_for_command, exact_op_for_tool, file_path_for_tool,
    file_repo_root, hunk_spans, op_for_declared_kind, op_for_receipt, parse_receipt_line,
    repo_root_for, snapshot_worktree, spans_for_tool_input, top_level_type,
};
use super::code::{parse_code_input, splice_tug_session_id};
use crate::path_resolver::CanonicalPath;
use tugchanges_core::shell_ops::DeclaredKind;
use tugdash_core::arc::{ArcStage, append_arc_stage};

// ---------------------------------------------------------------------------
// CrashBudget
// ---------------------------------------------------------------------------

/// Crash budget tracking
#[derive(Debug)]
pub struct CrashBudget {
    timestamps: VecDeque<Instant>,
    max_crashes: usize,
    window: Duration,
}

impl CrashBudget {
    /// Create a new crash budget
    pub fn new(max_crashes: usize, window: Duration) -> Self {
        Self {
            timestamps: VecDeque::new(),
            max_crashes,
            window,
        }
    }

    /// Record a crash and return true if budget is exhausted
    pub fn record_crash(&mut self) -> bool {
        let now = Instant::now();
        self.timestamps.push_back(now);

        // Remove crashes outside the window
        while let Some(&first) = self.timestamps.front() {
            if now.duration_since(first) > self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }

        self.is_exhausted()
    }

    /// Check if crash budget is exhausted
    pub fn is_exhausted(&self) -> bool {
        self.timestamps.len() >= self.max_crashes
    }
}

// ---------------------------------------------------------------------------
// resolve_tugcode_path
// ---------------------------------------------------------------------------

/// Resolve tugcode binary path
///
/// Priority order:
/// 1. CLI override if provided
/// 2. Sibling binary (next to current executable)
/// 3. PATH lookup
/// 4. `.ts` fallback via `bun run` (debug-only)
pub fn resolve_tugcode_path(cli_override: Option<&Path>) -> PathBuf {
    // CLI override has highest priority
    if let Some(path) = cli_override {
        return path.to_path_buf();
    }

    // Try sibling binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("tugcode");
            if sibling.exists() {
                info!("Found tugcode sibling binary at {}", sibling.display());
                return sibling;
            }
        }
    }

    // Try PATH lookup
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("tugcode");
            if candidate.exists() {
                info!("Found tugcode in PATH at {}", candidate.display());
                return candidate;
            }
        }
    }

    // Fallback: bun-run the `.ts` source directly. Dev-only — a shipped
    // Tug.app bundles a compiled tugcode at Contents/MacOS/tugcode and
    // the sibling lookup above resolves it. Release tugcast that reaches
    // this point without finding a sibling or PATH binary is a bug.
    #[cfg(debug_assertions)]
    {
        info!("tugcode binary not found, falling back to bun run");
        crate::resources::source_tree().join("tugcode/src/main.ts")
    }
    #[cfg(not(debug_assertions))]
    panic!(
        "tugcode binary not found via sibling (Contents/MacOS/tugcode) or PATH; \
         required in release builds"
    );
}

// ---------------------------------------------------------------------------
// SessionMode
// ---------------------------------------------------------------------------

/// User's choice of session mode on spawn. Threaded from the tugdeck
/// `spawn_session` CONTROL payload through the supervisor into
/// `ChildSpawner::spawn_child`, which surfaces it as a `--session-mode`
/// CLI flag on the tugcode subprocess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionMode {
    /// Fresh Claude session: tugcode passes `--session-id <id>` so
    /// claude claims the tugdeck-generated UUID as its own session id.
    New,
    /// Resume an existing session: tugcode passes `--resume <id>` so
    /// claude reopens the prior conversation under that same id.
    Resume,
}

impl SessionMode {
    /// CLI flag value for `--session-mode`.
    pub fn as_flag_value(&self) -> &'static str {
        match self {
            SessionMode::New => "new",
            SessionMode::Resume => "resume",
        }
    }

    /// JSON/wire identifier. Matches `as_flag_value` today; kept as a
    /// separate method so the two callers (tugcode CLI vs JSON ack)
    /// stay independently evolvable.
    pub fn as_wire_str(&self) -> &'static str {
        self.as_flag_value()
    }

    /// Decode a wire string (`"new"` / `"resume"`) into a `SessionMode`.
    /// Unknown / absent values default to `New`.
    pub fn from_wire_str(raw: Option<&str>) -> SessionMode {
        match raw {
            Some("resume") => SessionMode::Resume,
            _ => SessionMode::New,
        }
    }
}

// ---------------------------------------------------------------------------
// ChildSpawner abstraction
// ---------------------------------------------------------------------------

/// Pinned-boxed future produced by [`ChildSpawner::spawn_child`].
pub type SpawnFuture = Pin<Box<dyn std::future::Future<Output = io::Result<SessionChild>> + Send>>;

/// Number of trailing stderr lines retained per spawn for diagnostics.
/// On crash-budget exhaustion the bridge folds these into the errored
/// `SESSION_STATE` detail so the card surfaces *why* the subprocess died
/// (claude API failure, auth error, missing config) instead of an opaque
/// `crash_budget_exhausted`.
const STDERR_TAIL_CAP: usize = 40;

/// Grace period after a relay crash before snapshotting the subprocess
/// stderr tail. The dying child may flush a final error line (panic,
/// claude API failure) onto stderr *after* its stdout closes — the signal
/// the relay uses to detect the crash. This lets the stderr-forwarding
/// task drain those last lines so they make it into the errored detail.
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(50);

/// Thin boxed wrapper around an active subprocess' stdin/stdout. The
/// `_keepalive` field owns whatever handle is needed to keep the child alive
/// and cleaned up on drop (e.g., `tokio::process::Child` with
/// `kill_on_drop(true)`).
pub struct SessionChild {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    /// OS pid of the spawned tugcode child, captured at spawn for the
    /// activity sampler's subtree root ([P08], [P20]). `None` for mock
    /// spawners that don't back a real process.
    pub pid: Option<u32>,
    pub _keepalive: Box<dyn std::any::Any + Send>,
    /// Ring of the last [`STDERR_TAIL_CAP`] stderr lines this subprocess
    /// emitted, populated by the stderr-forwarding task. Read by
    /// `run_session_bridge` after a crash to attach the real failure
    /// reason to the errored frame. Mock spawners leave it empty.
    pub stderr_tail: Arc<std::sync::Mutex<VecDeque<String>>>,
}

/// Abstraction over subprocess spawning so the supervisor can inject a
/// mock in unit tests without a real binary on disk. Production uses
/// [`TugcodeSpawner`].
///
/// W2: `spawn_child` takes the target `project_dir` per call rather than
/// capturing it at spawner construction. This lets a single spawner
/// instance service multiple sessions, each with its own workspace, and
/// removes the need for the supervisor to rebuild a spawner every time a
/// new session starts. Implementations must clone the path into owned
/// storage before `await`-ing, since the returned `SpawnFuture` outlives
/// the call frame.
pub trait ChildSpawner: Send + Sync + 'static {
    /// `project_dir` is the user-typed path tugdeck sent in the
    /// `spawn_session` CONTROL payload; tugcode uses it as the
    /// subprocess cwd.
    ///
    /// `session_id` is the single identifier for this session: the same
    /// UUID that tugdeck pre-generated for fresh spawns (or picked from
    /// the sessions record for resume), that tugcast uses as the feed
    /// routing key, and that claude adopts as its own session id (via
    /// `--session-id` for new, `--resume` for resume).
    ///
    /// `session_mode` is the user's new-vs-resume choice from the Dev
    /// picker. Forwarded to tugcode as `--session-mode new|resume`.
    ///
    /// `resume_claude_session_id` is the persisted claude session id for
    /// resume spawns whose claude id has diverged from `session_id` (e.g.,
    /// after a fork). When `Some`, tugcode forwards it to claude as
    /// `--resume <id>` instead of falling back to `session_id`. `None`
    /// for fresh spawns and for resume spawns whose claude id was never
    /// captured (in which case tugcode still uses `session_id` for
    /// `--resume` — the legacy fallback that works for un-forked
    /// sessions because their tug and claude ids match).
    ///
    /// `permission_mode` is the deck-wide / per-card default permission mode
    /// tugdeck resolved at spawn time. Forwarded to tugcode as
    /// `--permission-mode <mode>` so the spawned claude process starts in the
    /// right mode. `None` when tugdeck sent no mode (older client, or a card
    /// with no configured default).
    fn spawn_child(
        &self,
        project_dir: &Path,
        session_id: &str,
        session_mode: SessionMode,
        resume_claude_session_id: Option<&str>,
        permission_mode: Option<&str>,
    ) -> SpawnFuture;
}

/// Production spawner: launches `tugcode --dir <project_dir>` (or the bun
/// fallback when the resolved path ends in `.ts`).
///
/// Stateless with respect to `project_dir` — the supervisor
/// passes the target workspace to each `spawn_child` call. The only
/// captured state is the path to the tugcode binary.
pub struct TugcodeSpawner {
    pub tugcode_path: PathBuf,
}

impl TugcodeSpawner {
    pub fn new(tugcode_path: PathBuf) -> Self {
        Self { tugcode_path }
    }
}

/// Resolve the `(program, args)` pair for invoking tugcode at `tugcode_path`
/// against `project_dir`. Pure helper extracted so unit tests can assert the
/// exact argv without spawning a real subprocess.
///
/// - Paths ending in `.ts` are run via `bun run <path>` (dev fallback).
/// - Anything else is invoked directly.
///
/// The returned args vector always carries
/// `["--dir", <project_dir>, "--session-id", <uuid>, "--session-mode", <new|resume>]`,
/// and additionally `["--resume-session", <claude_session_id>]` when
/// `resume_claude_session_id` is `Some` (only emitted for resume spawns
/// whose claude session id has diverged from `session_id`).
pub(crate) fn build_tugcode_command(
    tugcode_path: &Path,
    project_dir: &Path,
    session_id: &str,
    session_mode: SessionMode,
    resume_claude_session_id: Option<&str>,
    permission_mode: Option<&str>,
) -> (String, Vec<String>) {
    let (program, mut args): (String, Vec<String>) =
        if tugcode_path.extension().and_then(|s| s.to_str()) == Some("ts") {
            (
                "bun".to_string(),
                vec!["run".to_string(), tugcode_path.display().to_string()],
            )
        } else {
            (
                tugcode_path
                    .to_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "tugcode".to_string()),
                Vec::new(),
            )
        };
    args.push("--dir".to_string());
    args.push(project_dir.display().to_string());
    args.push("--session-id".to_string());
    args.push(session_id.to_string());
    args.push("--session-mode".to_string());
    args.push(session_mode.as_flag_value().to_string());
    if let Some(id) = resume_claude_session_id {
        args.push("--resume-session".to_string());
        args.push(id.to_string());
    }
    // The deck-wide / per-card default permission mode tugdeck resolved at
    // spawn time, forwarded so the spawned claude process starts in the
    // right mode rather than tugcode's hardcoded fallback (`--permission-mode`
    // is fixed at spawn; a post-spawn `permission_mode` frame can only change
    // it at runtime, racing the first turn). `None` when tugdeck sent no
    // mode (older client, or a card with neither a per-card mode nor a
    // configured default) — tugcode then keeps its own default.
    if let Some(mode) = permission_mode {
        args.push("--permission-mode".to_string());
        args.push(mode.to_string());
    }
    (program, args)
}

impl ChildSpawner for TugcodeSpawner {
    fn spawn_child(
        &self,
        project_dir: &Path,
        session_id: &str,
        session_mode: SessionMode,
        resume_claude_session_id: Option<&str>,
        permission_mode: Option<&str>,
    ) -> SpawnFuture {
        let tugcode_path = self.tugcode_path.clone();
        let project_dir = project_dir.to_path_buf();
        let session_id = session_id.to_string();
        let resume_claude_session_id = resume_claude_session_id.map(|s| s.to_string());
        let permission_mode = permission_mode.map(|s| s.to_string());
        Box::pin(async move {
            let (cmd, args) = build_tugcode_command(
                &tugcode_path,
                &project_dir,
                &session_id,
                session_mode,
                resume_claude_session_id.as_deref(),
                permission_mode.as_deref(),
            );
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "bridge.tugcode_spawn",
                tug_session_id = %session_id,
                session_mode = session_mode.as_wire_str(),
                resume_claude_session_id = resume_claude_session_id.as_deref().unwrap_or(""),
                cmd = %cmd,
                args = ?args,
                cwd = %project_dir.display(),
            );
            // Scrub Anthropic auth env vars so the downstream claude CLI
            // authenticates via `~/.claude.json` (the user's Max/Pro
            // subscription) rather than per-token API billing. If the
            // developer has any of these variables exported for other
            // work (e.g. direct API scripts), we do NOT want it to leak
            // into tugcode → claude.
            //
            // Keep this list in sync with `AUTH_ENV_VARS` in
            // `tugrust/crates/tugcast/tests/common/catalog.rs` and the
            // destructure in `tugcode/src/session.ts::spawnClaude`.
            let mut child = Command::new(&cmd)
                .args(&args)
                .env_remove("ANTHROPIC_API_KEY")
                .env_remove("ANTHROPIC_AUTH_TOKEN")
                .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
                // Self-identification for the session subprocess chain:
                // tugcode's `scrubbedEnv` passes this through unmodified
                // (it strips only the three auth keys above), and claude
                // forwards its environment to Bash tool calls — so a
                // skill or CLI run inside this session can read
                // `$TUG_SESSION_ID` to know which session it is. This is
                // load-bearing for `tugutil changes`, which keys the
                // file-event query on it. The value is the tug session id
                // (also passed as claude's `--session-id`, so the two
                // coincide).
                .env("TUG_SESSION_ID", &session_id)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| io::Error::other("tugcode stdin not available"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("tugcode stdout not available"))?;
            // Forward tugcode's stderr (which also carries Claude's
            // stderr via the `stderr: "inherit"` chain in
            // `tugcode/src/session.ts::spawnClaude`) into tugcast's
            // tracing log. Without this the subprocess stderr pipe
            // is lost to `launchd` when Tug.app is launched via
            // `open` (`just app`), and real errors (Claude API
            // failures, auth problems, missing configs) never reach
            // the operator. Each line is forwarded verbatim under
            // the `tugcast::tugcode_stderr` target so consumers can
            // grep by that tag.
            let stderr_tail: Arc<std::sync::Mutex<VecDeque<String>>> =
                Arc::new(std::sync::Mutex::new(VecDeque::new()));
            if let Some(stderr) = child.stderr.take() {
                let tail = Arc::clone(&stderr_tail);
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    loop {
                        match lines.next_line().await {
                            Ok(Some(line)) => {
                                tracing::warn!(
                                    target: "tugcast::tugcode_stderr",
                                    "{line}",
                                );
                                if let Ok(mut buf) = tail.lock() {
                                    buf.push_back(line);
                                    while buf.len() > STDERR_TAIL_CAP {
                                        buf.pop_front();
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(err) => {
                                tracing::warn!(
                                    target: "tugcast::tugcode_stderr",
                                    "stderr read error: {err}",
                                );
                                break;
                            }
                        }
                    }
                });
            }
            let pid = child.id();
            Ok(SessionChild {
                stdin: Box::new(stdin),
                stdout: Box::new(stdout),
                pid,
                _keepalive: Box::new(child),
                stderr_tail,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// run_session_bridge — outer loop (spawn, handshake, relay, crash budget)
// ---------------------------------------------------------------------------

/// Outcome of a single relay iteration, consumed by [`run_session_bridge`]
/// to decide whether to re-spawn the subprocess or exit the session.
///
/// There is no `ClosedNormally` variant: stdout EOF on a tugcode subprocess
/// is indistinguishable from a crash at this layer (we have no way to read
/// the exit status without losing the ability to drain remaining stdout
/// lines), so orderly shutdowns come through the cancel path.
#[derive(Debug, PartialEq, Eq)]
pub enum RelayOutcome {
    /// Cancellation token fired or the merger receiver closed — bridge exits.
    Cancelled,
    /// Subprocess died abnormally (or closed stdout) — bridge records a
    /// crash and may retry up to the per-session crash budget.
    Crashed,
    /// Subprocess emitted `resume_failed` and then exited. The outer loop
    /// must NOT retry — re-spawning would just hit the same stale
    /// `--resume` id and loop until crash-budget exhausted. The bridge
    /// publishes `SESSION_STATE = errored { detail: "resume_failed" }`
    /// and tears down.
    ResumeFailed {
        stale_session_id: String,
        reason: String,
    },
}

/// Default retry backoff between crash-loop iterations.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Per-session bridge task. Spawns and supervises the tugcode subprocess
/// for a single `TugSessionId`. On crash, re-spawns until the per-session
/// `CrashBudget` (lives inside the ledger entry) is exhausted, at which point
/// publishes `SESSION_STATE = errored{detail: "crash_budget_exhausted"}` and
/// drops the dispatcher sender so the dispatcher stops forwarding input.
///
/// `retry_delay` is the backoff between crash-loop iterations. Production
/// uses [`DEFAULT_RETRY_DELAY`]; tests pass a sub-millisecond value so the
/// crash-loop completes synchronously.
/// The two durable ink ledgers, as the fork arc needs them.
///
/// A rewind-fork is the conversation continued, so the receipts and search
/// history of that conversation move to the fork alongside its callsign
/// ([D154]). The two are separate sqlite files with no shared transaction, so
/// the transfer is best-effort here and the open-time sweep in `ink_adoption`
/// is what makes it eventually true.
#[derive(Clone, Default)]
pub struct InkLedgers {
    pub shell: Option<Arc<crate::shell_ledger::ShellLedger>>,
    pub refs: Option<Arc<crate::refs_ledger::RefsLedger>>,
}

impl InkLedgers {
    /// Move every durable ink row keyed to `from` onto `to`. Each ledger
    /// warns on failure rather than propagating: a bookkeeping write must
    /// never fail a spawn, and the boot sweep re-runs the same idempotent
    /// re-key.
    pub fn transfer(&self, from: &str, to: &str) {
        if let Some(shell) = self.shell.as_ref() {
            match shell.rekey_session(from, to) {
                Ok(0) => {}
                Ok(moved) => info!(from, to, moved, "shell ink transferred to the fork"),
                Err(err) => warn!(from, to, error = %err, "shell ink transfer failed"),
            }
        }
        if let Some(refs) = self.refs.as_ref() {
            match refs.rekey_session(from, to) {
                Ok(0) => {}
                Ok(moved) => info!(from, to, moved, "refs ink transferred to the fork"),
                Err(err) => warn!(from, to, error = %err, "refs ink transfer failed"),
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run_session_bridge(
    tug_session_id: TugSessionId,
    ledger_entry: Arc<Mutex<LedgerEntry>>,
    mut input_rx: mpsc::Receiver<Frame>,
    merger_tx: mpsc::Sender<Frame>,
    state_tx: broadcast::Sender<Frame>,
    // The CONTROL feed, so a fork that takes its parent's name can push the
    // parent's cleared row. A client un-learns a name only through a
    // `session_updated` carrying `name_user_set: false`; the list-level
    // refresh seeds names non-clobberingly and returns early on a blank.
    // `None` in harnesses with no control feed wired.
    control_tx: Option<broadcast::Sender<Frame>>,
    spawner: Arc<dyn ChildSpawner>,
    project_dir: PathBuf,
    session_mode: SessionMode,
    // Deck-wide / per-card default permission mode resolved by tugdeck at
    // spawn time, forwarded to tugcode as `--permission-mode`. `None` when
    // tugdeck sent no mode. Stable for the life of the session (read once
    // off the ledger entry), so crash-loop respawns re-apply the same mode.
    permission_mode: Option<String>,
    sessions_recorder: Arc<dyn SessionsRecorder>,
    // Optional handle to the sqlite session ledger. When present, the
    // relay loop loads per-turn telemetry on `replay_started` and
    // inlines it onto each replayed `turn_complete` frame before
    // forwarding to the wire. When `None` (test harnesses that don't
    // wire a ledger), replayed `turn_complete` frames pass through
    // unchanged and the client reducer's merge falls back to its
    // zero-telemetry derived block — correct behavior, no crash.
    session_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    // The durable ink ledgers, so a rewind-fork can carry its line of work's
    // receipts and search history across with its callsign.
    ink_ledgers: InkLedgers,
    // Recompute signal for the workspace's ChangesetFeed, fired after
    // each file-event write so the changeset card updates without
    // waiting for the poll.
    changeset_bumper: crate::feeds::changeset::ChangesetBumper,
    cancel: CancellationToken,
    retry_delay: Duration,
) {
    // `tug_session_id` is also the session id we pass to tugcode via
    // `--session-id` — the single identifier for this session.
    let session_id_str = tug_session_id.as_str().to_string();
    let project_dir_str = project_dir.display().to_string();
    // The attribution bucket key is canonical: two spellings of one project
    // (firmlink / synthetic symlink) must land in one `file_events` bucket, and
    // the compose query keys on the canonical form. Resolved once per session
    // (the gateway memoizes); logging keeps the raw typed path.
    let canonical_project_dir_str = crate::path_resolver::CanonicalPath::from_raw(&project_dir)
        .as_str()
        .to_string();
    // Trailing stderr (or spawn error) from the most recent failed spawn,
    // carried across crash-loop iterations so the top-of-loop budget-
    // exhaustion publish can fold the real failure reason into the errored
    // detail instead of an opaque `crash_budget_exhausted`.
    let mut last_failure_reason: Option<String> = None;
    // False only for the loop's first iteration. The auth gate below runs on
    // RESPAWN iterations only: that is where an instant claude exit needs to
    // be told apart from a crash. The first spawn skips the probe — `claude
    // auth status --json` costs ~200ms of CLI startup, and paying it on the
    // happy path delays tugcode spawn (and therefore replay's first frames)
    // by that much on every session open. A logged-out first open just fails
    // fast once and the second iteration's probe surfaces the auth state.
    let mut is_respawn = false;
    loop {
        // Auth gate. A logged-out (or entirely missing) `claude` exits the
        // instant it's spawned, which the relay can't distinguish from a crash
        // — so without this it would crash-loop to a useless
        // `crash_budget_exhausted`. Probe on respawn and surface an actionable
        // auth state instead; a mid-session logout is caught on the next
        // respawn, exactly as before.
        let probe_auth = is_respawn;
        is_respawn = true;
        let auth_detail = if probe_auth {
            match crate::feeds::claude_auth::probe().await {
                crate::feeds::claude_auth::AuthState::LoggedIn(_) => None,
                crate::feeds::claude_auth::AuthState::ClaudeMissing => Some("claude_missing"),
                crate::feeds::claude_auth::AuthState::LoggedOut => Some("auth_required"),
            }
        } else {
            None
        };
        if let Some(detail) = auth_detail {
            let mut entry = ledger_entry.lock().await;
            let already_closed = entry.spawn_state == SpawnState::Closed;
            if !already_closed {
                entry.spawn_state = SpawnState::Errored;
            }
            entry.input_tx = None;
            drop(entry);
            if !already_closed {
                info!(session = %tug_session_id, detail, "claude auth gate: not logged in");
                let _ = state_tx.send(build_session_state_frame(
                    &tug_session_id,
                    "errored",
                    Some(detail),
                ));
            }
            return;
        }

        // Crash-budget check: if exhausted, flip state + drop dispatcher
        // sender under a single lock acquisition so a racing `close_session`
        // can't have its `Closed` flip clobbered by our `Errored` assignment.
        // If close beat us here, skip the `errored` publish entirely —
        // close_session has already published `closed` and the client
        // observing both would see a conflicting lifecycle.
        {
            let mut entry = ledger_entry.lock().await;
            if entry.crash_budget.is_exhausted() {
                let already_closed = entry.spawn_state == SpawnState::Closed;
                if !already_closed {
                    entry.spawn_state = SpawnState::Errored;
                }
                entry.input_tx = None;
                // `card_id` is preserved across the errored transition;
                // liveness is encoded in `spawn_state`.
                let claude_id = entry.claude_session_id.clone();
                drop(entry);
                // Crash exhaustion is a `failed` lifecycle ending: the
                // session row stays in the ledger as a diagnostic crumb so
                // the picker can show what happened. Sessions that never
                // reached `session_init` have no row yet — nothing to mark.
                if let Some(id) = claude_id {
                    sessions_recorder.mark_failed(&id);
                }
                if !already_closed {
                    error!(session = %tug_session_id, "crash budget exhausted");
                    // Fold the last spawn's stderr (or spawn error) into the
                    // detail so the card shows *why* the subprocess died. The
                    // first line stays `crash_budget_exhausted` (the strip
                    // summary + the token existing consumers match on); any
                    // captured diagnostic follows on subsequent lines and the
                    // client routes it to the error detail panel.
                    let detail = match &last_failure_reason {
                        Some(reason) if !reason.is_empty() => {
                            format!("crash_budget_exhausted\n{reason}")
                        }
                        _ => "crash_budget_exhausted".to_string(),
                    };
                    let _ = state_tx.send(build_session_state_frame(
                        &tug_session_id,
                        "errored",
                        Some(detail.as_str()),
                    ));
                }
                return;
            }
        }

        // Read the persisted claude_session_id off the ledger entry
        // before each spawn iteration. On the first iteration after
        // rebind, this carries the value that `rebind_from_tugbank` read
        // from tugbank. On a crash-loop retry mid-life, it carries the
        // value the previous `relay_session_io` captured at session_init.
        // For fresh `do_spawn_session(mode=new)` flows the entry's id is
        // `None`, so the spawner falls back to the legacy `--resume
        // <session_id>` path that works because tug and claude ids are
        // equal for un-forked sessions.
        let resume_claude_session_id = {
            let entry = ledger_entry.lock().await;
            entry.claude_session_id.clone()
        };

        // Spawn subprocess — interruptible by cancel so
        // `close_session` can tear down a stalled spawner.
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "spawn.child_invoke",
            tug_session_id = %tug_session_id,
            session_mode = session_mode.as_wire_str(),
            resume_claude_session_id = resume_claude_session_id.as_deref().unwrap_or(""),
            project_dir = %project_dir_str,
        );
        let spawn_result = tokio::select! {
            result = spawner.spawn_child(
                project_dir.as_path(),
                session_id_str.as_str(),
                session_mode,
                resume_claude_session_id.as_deref(),
                permission_mode.as_deref(),
            ) => result,
            _ = cancel.cancelled() => return,
        };
        let child = match spawn_result {
            Ok(c) => c,
            Err(e) => {
                error!(session = %tug_session_id, error = %e, "failed to spawn tugcode");
                last_failure_reason = Some(format!("spawn failed: {e}"));
                ledger_entry.lock().await.crash_budget.record_crash();
                tokio::select! {
                    _ = sleep(retry_delay) => continue,
                    _ = cancel.cancelled() => return,
                }
            }
        };

        // Retain the child's (pid, start_time) on the ledger entry for the
        // activity sampler ([P08], [P20]). Captured now, at spawn, so a pid
        // recycled after this session exits is rejected by the start-time
        // guard rather than misattributed. Cleared when the relay ends below.
        if let Some(pid) = child.pid {
            let start_time = crate::feeds::activity::resource::process_start_time(pid);
            let mut entry = ledger_entry.lock().await;
            entry.child_pid = Some(pid);
            entry.child_start_time = start_time;
        }

        // Run one relay iteration.
        let lines = BufReader::new(child.stdout).lines();
        let outcome = relay_session_io(
            &tug_session_id,
            &ledger_entry,
            &mut input_rx,
            &merger_tx,
            &state_tx,
            control_tx.as_ref(),
            child.stdin,
            lines,
            &canonical_project_dir_str,
            sessions_recorder.as_ref(),
            session_ledger.as_deref(),
            &ink_ledgers,
            &changeset_bumper,
            &cancel,
        )
        .await;

        // Hold a handle to this spawn's captured stderr before the child
        // drops, so the crash arm below can snapshot the tail as the
        // failure reason.
        let stderr_tail = Arc::clone(&child.stderr_tail);

        // `child._keepalive` (holding tokio::process::Child) drops here at end
        // of iteration if we fall through. `kill_on_drop(true)` cleans up.
        drop(child._keepalive);

        // The child is gone — clear its (pid, start_time) so the sampler stops
        // attributing a subtree to a dead process, and drop any in-flight
        // turn flag (a crash mid-turn never sends `turn_complete`). A retry
        // re-captures on the next spawn above.
        {
            let mut entry = ledger_entry.lock().await;
            entry.child_pid = None;
            entry.child_start_time = None;
            entry.turn_active = false;
        }

        match outcome {
            RelayOutcome::Cancelled => {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "bridge.relay_outcome",
                    tug_session_id = %tug_session_id,
                    outcome = "cancelled",
                );
                return;
            }
            RelayOutcome::Crashed => {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "bridge.relay_outcome",
                    tug_session_id = %tug_session_id,
                    outcome = "crashed",
                );
                // Let the stderr reader drain any final line the dying child
                // flushed after stdout closed, then snapshot the tail as the
                // failure reason for a possible budget exhaustion next round.
                sleep(STDERR_DRAIN_GRACE).await;
                if let Ok(buf) = stderr_tail.lock() {
                    if !buf.is_empty() {
                        last_failure_reason =
                            Some(buf.iter().cloned().collect::<Vec<_>>().join("\n"));
                    }
                }
                ledger_entry.lock().await.crash_budget.record_crash();
                info!(session = %tug_session_id, "tugcode crashed; retrying");
                tokio::select! {
                    _ = sleep(retry_delay) => continue,
                    _ = cancel.cancelled() => return,
                }
            }
            RelayOutcome::ResumeFailed {
                stale_session_id,
                reason,
            } => {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "bridge.relay_outcome",
                    tug_session_id = %tug_session_id,
                    outcome = "resume_failed",
                    stale_session_id = stale_session_id.as_str(),
                    reason = reason.as_str(),
                );
                // tugcode emitted `resume_failed` and exited.
                // Re-spawning would just hit the same stale id again,
                // so mark the session errored and return without
                // retrying. The bridge has already forwarded the
                // `resume_failed` CODE_OUTPUT frame to the card, and
                // `relay_session_io` already called `mark_failed` on the
                // stale session id (so its ledger row is retained as a
                // `failed` diagnostic crumb).
                let mut entry = ledger_entry.lock().await;
                let already_closed = entry.spawn_state == SpawnState::Closed;
                if !already_closed {
                    entry.spawn_state = SpawnState::Errored;
                }
                entry.input_tx = None;
                // `card_id` is preserved across the errored transition;
                // liveness is encoded in `spawn_state`.
                drop(entry);
                if !already_closed {
                    info!(
                        session = %tug_session_id,
                        stale_session_id,
                        reason,
                        "resume failed terminally; not retrying"
                    );
                    let _ = state_tx.send(build_session_state_frame(
                        &tug_session_id,
                        "errored",
                        Some("resume_failed"),
                    ));
                }
                return;
            }
        }
    }
}

/// Resolve (and cache) the canonical repo root for the canonical
/// `project_dir`. Sticky once found; while `None`, re-probes each call so a
/// repo that appears mid-session (a `git init` inside a Bash tool call, or an
/// external one) starts being projected — matching the per-Bash-call probe
/// behaviour this replaces. `project_dir` is already canonical, so the returned
/// root is canonical too.
async fn ensure_repo_root(
    cache: &mut Option<CanonicalPath>,
    project_dir: &str,
) -> Option<CanonicalPath> {
    if let Some(root) = cache {
        return Some(root.clone());
    }
    let root = repo_root_for(Path::new(project_dir)).await?;
    let cp = CanonicalPath::from_raw(&root);
    *cache = Some(cp.clone());
    Some(cp)
}

// MARK: - Facts library recorders

/// How many Bash calls may be in flight for the facts library before the
/// oldest is dropped. The same order of magnitude as [`PENDING_CALLS_CAP`],
/// and for the same reason: a relay that never saw a result must not grow a
/// map forever.
const PENDING_SHELL_FACTS_CAP: usize = 512;

/// One Bash `tool_use` waiting for its result, so the command text and its
/// outcome can be recorded together — the only moment both are in hand.
#[derive(Debug, Clone)]
struct PendingShellFact {
    command: String,
    at_ms: i64,
}

/// Every Bash call the relay has seen, unfiltered, keyed by `tool_use_id`.
///
/// **This is deliberately not `pending_cmds` or `open_bash`** ([P06]). Both of
/// those are filtered in ways that exclude exactly the commands the facts
/// library exists to capture: `pending_cmds` admits a call only when
/// `declared_ops_for_command` parses it as a file operation (`cargo build`
/// returns `None`), and `open_bash` opens only for a live, in-repo call. Every
/// build, every test run, and every replayed command is absent from both — so
/// hooking either would leave `test_run` facts essentially never firing, since
/// a test run is never a file-operation command.
///
/// Never cleared on `turn_complete`, for the same reason `pending_calls` is
/// not: a subagent's pair can straddle a turn boundary.
#[derive(Debug)]
struct PendingShellFacts {
    map: HashMap<String, PendingShellFact>,
    /// Insertion order of live keys, for oldest-first eviction. A taken key
    /// stays as a tombstone; eviction skips ids already gone from `map`.
    order: VecDeque<String>,
}

impl PendingShellFacts {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn insert(&mut self, tool_use_id: String, pending: PendingShellFact) {
        if self.map.insert(tool_use_id.clone(), pending).is_none() {
            self.order.push_back(tool_use_id);
            while self.map.len() > PENDING_SHELL_FACTS_CAP {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.map.remove(&oldest);
                    }
                    None => break,
                }
            }
            // Tombstones are only ever drained by an eviction, and a relay
            // whose calls all settle promptly never evicts — so a long-lived
            // session would grow one dead id per Bash call forever. Drop them
            // whenever they come to outnumber the live entries this map is
            // sized for; a live key can be reached this way too, which is the
            // eviction the cap already sanctions.
            while self.order.len() > PENDING_SHELL_FACTS_CAP * 2 {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.map.remove(&oldest);
                    }
                    None => break,
                }
            }
        }
    }

    fn take(&mut self, tool_use_id: &str) -> Option<PendingShellFact> {
        self.map.remove(tool_use_id)
    }
}

/// Write one fact, best-effort. A failed write warns and is forgotten — a
/// recorder rides someone else's hot path and must never gate the forward.
fn record_fact_best_effort(
    ledger: &crate::session_ledger::SessionLedger,
    tug_session_id: &TugSessionId,
    fact: &crate::session_ledger::NewFact,
) {
    if let Err(err) = ledger.record_fact(fact) {
        warn!(
            session = %tug_session_id,
            kind = %fact.kind,
            error = %err,
            "record_fact failed; the frame is unaffected"
        );
    }
}

/// Settle one Bash call into its `shell` fact, and into a `test_run` fact when
/// the output says it was a test run.
///
/// `ok` comes from the tool call, and reaches the `shell` fact only. The
/// `test_run` verdict is read from the runner's own summary ([P07]): a red
/// suite is a perfectly successful Bash invocation, so a verdict taken from
/// `is_error` would call every failing run a pass.
fn record_shell_facts(
    ledger: &crate::session_ledger::SessionLedger,
    tug_session_id: &TugSessionId,
    pending: PendingShellFact,
    tool_use_id: &str,
    output: &str,
    is_error: bool,
) {
    use crate::feeds::facts_library;
    let session = tug_session_id.as_str();
    let key = facts_library::shell_key(session, tool_use_id);
    record_fact_best_effort(
        ledger,
        tug_session_id,
        &facts_library::shell_fact(
            pending.at_ms,
            Some(session),
            &facts_library::ShellFact {
                command: &pending.command,
                route: facts_library::ShellRoute::Claude,
                ok: !is_error,
                exit_code: None,
                cwd: None,
            },
            Some(key.clone()),
        ),
    );
    if let Some(run) = facts_library::classify_test_run(&pending.command, output) {
        record_fact_best_effort(
            ledger,
            tug_session_id,
            &facts_library::test_run_fact(
                pending.at_ms,
                Some(session),
                &run,
                Some(facts_library::test_run_key(&key)),
            ),
        );
    }
}

/// A compaction boundary as the wire carries it. Every field is optional:
/// claude reports `compact_metadata` when it has it, and often reports a
/// pre-compaction count with no post-compaction one.
fn record_compact_fact(
    ledger: &crate::session_ledger::SessionLedger,
    tug_session_id: &TugSessionId,
    frame: &serde_json::Value,
    at_ms: i64,
) {
    let int = |name: &str| frame.get(name).and_then(serde_json::Value::as_i64);
    record_fact_best_effort(
        ledger,
        tug_session_id,
        &crate::feeds::facts_library::compact_fact(
            at_ms,
            tug_session_id.as_str(),
            frame.get("trigger").and_then(|v| v.as_str()),
            int("pre_tokens"),
            int("post_tokens"),
        ),
    );
}

/// Resolve and record one exact-tool row from a consumed [`PendingCall`]
/// ([P03]/[P04]) — the single write path shared by the live `tool_result`
/// intercept and the `replay_batch` unwrap, so the per-file repo-root rule
/// and the replay timestamp rule live in exactly one place. `replayed`
/// selects `at`: a replayed row keeps its historical frame time (so the
/// upsert PK collapses re-streams at a stable value), a live row stamps now.
/// Returns the recorded repo-relative path on success; a ledger error is
/// warned and yields `None` — best-effort, never gates wire delivery.
#[allow(clippy::too_many_arguments)]
async fn record_exact_pending(
    pending: crate::feeds::attribution::PendingCall,
    tool_use_id: &str,
    result_timestamp: Option<i64>,
    origin: &'static str,
    replayed: bool,
    tug_session_id: &TugSessionId,
    canonical_project_dir: &CanonicalPath,
    repo_root_cache: &mut Option<CanonicalPath>,
    project_dir: &str,
    ledger: &crate::session_ledger::SessionLedger,
) -> Option<String> {
    let at = if replayed {
        pending
            .timestamp
            .or(result_timestamp)
            .unwrap_or_else(crate::session_ledger::now_millis)
    } else {
        crate::session_ledger::now_millis()
    };
    // Repo membership is a per-file fact: the row's project_dir is the
    // file's OWN repo root (a nested worktree's root for a worktree file),
    // never the session's. A file in no repo at all is measured against the
    // session's repo, and falls outside it — such a call records nothing.
    let file_root = file_repo_root(&pending.file_path).await;
    let (row_project_dir, row_repo_root) = match file_root {
        Some(root) => (root.clone(), Some(root)),
        None => (
            canonical_project_dir.clone(),
            ensure_repo_root(repo_root_cache, project_dir).await,
        ),
    };
    let named_path = pending.file_path.clone();
    let spans = pending.spans.clone();
    let Some(row) = pending.into_row(
        tug_session_id.as_str(),
        tool_use_id,
        &row_project_dir,
        row_repo_root.as_ref(),
        origin,
        at,
    ) else {
        debug!(
            session = %tug_session_id,
            path = %named_path,
            "file event outside the project repo; not recorded"
        );
        return None;
    };
    match ledger.record_file_event_with_spans(&row, &spans) {
        Ok(()) => Some(row.file_path),
        Err(err) => {
            crate::ledger_integrity::health::note_error("changes", &err);
            warn!(
                session = %tug_session_id,
                error = %err,
                "record_file_event failed; frame forwarded unchanged"
            );
            None
        }
    }
}

/// Record one proof-class `cmd` row for an absolute path a Bash command named —
/// a parsed operand the delta confirmed, a rename's old name, a replayed
/// command's declared operation, or a verb receipt's op. Shares
/// [`record_exact_pending`]'s per-file repo resolution: the row's `project_dir`
/// is the *file's* own repo root, so a path in a nested worktree keys to that
/// worktree (the Where axiom).
#[allow(clippy::too_many_arguments)]
async fn record_cmd_event(
    file_path: &Path,
    op: &str,
    tool_use_id: &str,
    parent_tool_use_id: Option<String>,
    spans: &[crate::session_ledger::FileEventSpan],
    at: i64,
    tug_session_id: &TugSessionId,
    canonical_project_dir: &CanonicalPath,
    repo_root_cache: &mut Option<CanonicalPath>,
    project_dir: &str,
    ledger: &crate::session_ledger::SessionLedger,
) -> Option<String> {
    let absolute = file_path.to_string_lossy().into_owned();
    let file_root = file_repo_root(&absolute).await;
    let (row_project_dir, row_repo_root) = match file_root {
        Some(root) => (root.clone(), Some(root)),
        None => (
            canonical_project_dir.clone(),
            ensure_repo_root(repo_root_cache, project_dir).await,
        ),
    };
    // A deleted or moved-away path cannot canonicalize itself — resolve through
    // its nearest surviving ancestor so the row's key lands in the same space
    // git's status output does.
    let canonical = canonicalize_declared(file_path);
    let Some(projected) = crate::feeds::attribution::repo_relative_key(
        row_repo_root.as_ref().map(|root| root.as_path()),
        &canonical,
    ) else {
        debug!(
            session = %tug_session_id,
            path = %canonical.display(),
            "cmd file event outside the project repo; not recorded"
        );
        return None;
    };
    let row = crate::session_ledger::FileEventRow {
        tug_session_id: tug_session_id.as_str().to_owned(),
        tool_use_id: tool_use_id.to_owned(),
        file_path: projected,
        tool_name: "Bash".to_owned(),
        op: op.to_owned(),
        origin: CMD_ORIGIN.to_owned(),
        ambiguous: false,
        parent_tool_use_id,
        project_dir: row_project_dir.as_str().to_owned(),
        at,
    };
    match ledger.record_file_event_with_spans(&row, spans) {
        Ok(()) => Some(row.file_path),
        Err(err) => {
            crate::ledger_integrity::health::note_error("changes", &err);
            warn!(
                session = %tug_session_id,
                error = %err,
                "record_file_event (cmd) failed; frame forwarded unchanged"
            );
            None
        }
    }
}

/// The evidence a bracket row promoted to proof records ([P05]).
///
/// The bracket itself knows only fingerprints — a status letter and an mtime,
/// never content — so an edit-precise anchor is out of reach here. What is in
/// reach is the path's working diff at the moment the command finished, which
/// is exactly the content state the promotion asserts authorship over, and
/// whose hunk ids are the identity the whole contention system is keyed on.
/// Recording them is what makes a promotion falsifiable: revert the content
/// and the ids drift, the evidence stops placing, and the claim narrows or
/// retires instead of asserting the file forever.
///
/// Best-effort by construction. A diff that will not read, or a path with no
/// hunks to read (an untracked file's tracked diff is empty), yields no spans
/// and the row records in today's span-less shape — never a blocked frame.
async fn promoted_row_spans(
    repo_root: &Path,
    file_path: &str,
) -> Vec<crate::session_ledger::FileEventSpan> {
    let Some(diff) = super::git::fetch_git_diff(repo_root, &[file_path.to_owned()]).await else {
        return Vec::new();
    };
    let ids: Vec<String> = tugchanges_core::parse_hunks(&diff)
        .into_iter()
        .map(|hunk| hunk.id)
        .collect();
    if ids.is_empty() {
        return Vec::new();
    }
    hunk_spans(&ids)
}

/// Mint `cmd` rows straight from a replayed command's declared operations —
/// the replay half of the rule, where no fingerprint survives to intersect
/// with. The command text replays even though the pre-command tree state is
/// gone (G1), so what the command *named* is still proof; the paired
/// successful result supplies the outcome half. Rows carry the frames'
/// historical times, and the PK collapses re-streamed batches.
#[allow(clippy::too_many_arguments)]
async fn mint_replayed_cmd_rows(
    cmd: crate::feeds::attribution::PendingCmd,
    tool_use_id: &str,
    result_timestamp: Option<i64>,
    tug_session_id: &TugSessionId,
    canonical_project_dir: &CanonicalPath,
    repo_root_cache: &mut Option<CanonicalPath>,
    project_dir: &str,
    ledger: &crate::session_ledger::SessionLedger,
) -> bool {
    let at = cmd
        .timestamp
        .or(result_timestamp)
        .unwrap_or_else(crate::session_ledger::now_millis);
    let mut recorded = false;
    for op in &cmd.ops {
        // A restore writes the repository's recorded bytes; the session
        // authored none of them, so it mints no proof row.
        if matches!(op.kind, DeclaredKind::Restore) {
            continue;
        }
        // A rename records both names under one tool_use_id: the destination,
        // and the takeoff point the file left.
        let mut targets: Vec<(&Path, &str)> =
            vec![(op.path.as_path(), op_for_declared_kind(&op.kind))];
        if let DeclaredKind::Move { orig } = &op.kind {
            targets.push((orig.as_path(), "renamed"));
        }
        for (path, row_op) in targets {
            if record_cmd_event(
                path,
                row_op,
                tool_use_id,
                cmd.parent_tool_use_id.clone(),
                // A parsed command names files, not regions ([Q03]).
                &[],
                at,
                tug_session_id,
                canonical_project_dir,
                repo_root_cache,
                project_dir,
                ledger,
            )
            .await
            .is_some()
            {
                recorded = true;
            }
        }
    }
    recorded
}

/// Mint `cmd` rows from any `tugutil file` receipt a successful Bash result
/// carries. Every Bash result is scanned rather than only parsed `tugutil file`
/// invocations, so the receipt still counts when the verb runs through a
/// wrapper the grammar can't read. Forgery is not a risk: rows are relay-local,
/// so a session echoing the marker can only attribute files to itself.
#[allow(clippy::too_many_arguments)]
async fn mint_receipt_rows(
    output: &str,
    tool_use_id: &str,
    at: i64,
    tug_session_id: &TugSessionId,
    canonical_project_dir: &CanonicalPath,
    repo_root_cache: &mut Option<CanonicalPath>,
    project_dir: &str,
    ledger: &crate::session_ledger::SessionLedger,
) -> Vec<String> {
    let scan = parse_receipt_line(output);
    if scan.malformed {
        warn!(
            session = %tug_session_id,
            "a tugutil file receipt failed to parse; its operations are unattributed"
        );
    }
    let mut recorded = Vec::new();
    for receipt_op in &scan.ops {
        let Some(op) = op_for_receipt(&receipt_op.op) else {
            warn!(
                session = %tug_session_id,
                op = %receipt_op.op,
                "unknown receipt op; skipped"
            );
            continue;
        };
        // The verb's own testimony of which hunks it applied is the
        // strongest anchor there is — the id is already what the current
        // diff's hunks are keyed by (Spec S05). It belongs to the path the
        // bytes landed on; a rename's takeoff point carries none.
        let hunk_spans = crate::feeds::attribution::hunk_spans(&receipt_op.hunks);
        // A rename names both ends, same as a parsed one.
        let mut targets: Vec<(&str, &[crate::session_ledger::FileEventSpan])> =
            vec![(receipt_op.path.as_str(), &hunk_spans)];
        if let Some(orig) = receipt_op.orig_path.as_deref() {
            targets.push((orig, &[]));
        }
        for (target, spans) in targets {
            if let Some(path) = record_cmd_event(
                Path::new(target),
                op,
                tool_use_id,
                None,
                spans,
                at,
                tug_session_id,
                canonical_project_dir,
                repo_root_cache,
                project_dir,
                ledger,
            )
            .await
            {
                recorded.push(path);
            }
        }
    }
    recorded
}

// ---------------------------------------------------------------------------
// relay_session_io — generic, testable inner relay
// ---------------------------------------------------------------------------

/// Single relay iteration: handshake with the child, pump CODE_INPUT into
/// stdin, splice-stamp stdout lines into the merger channel, populate
/// `claude_session_id` on `session_init`, and publish `SESSION_STATE = live`
/// once a `session_init` arrives.
///
/// Generic over the stdin/stdout concrete types so tests can drive this
/// directly with [`tokio::io::duplex`] streams instead of a real subprocess.
#[allow(clippy::too_many_arguments)]
pub async fn relay_session_io(
    tug_session_id: &TugSessionId,
    ledger_entry: &Arc<Mutex<LedgerEntry>>,
    input_rx: &mut mpsc::Receiver<Frame>,
    merger_tx: &mpsc::Sender<Frame>,
    state_tx: &broadcast::Sender<Frame>,
    // The CONTROL feed — see [`run_session_bridge`]. `None` in harnesses with
    // no control feed wired.
    control_tx: Option<&broadcast::Sender<Frame>>,
    mut stdin: Box<dyn AsyncWrite + Send + Unpin>,
    mut lines: Lines<BufReader<Box<dyn AsyncRead + Send + Unpin>>>,
    project_dir: &str,
    sessions_recorder: &dyn SessionsRecorder,
    // Optional `SessionLedger` handle for per-turn telemetry reads
    // during the replay window. `None` in tests that don't wire a
    // ledger — replayed `turn_complete` frames pass through unchanged.
    session_ledger: Option<&crate::session_ledger::SessionLedger>,
    // The durable ink ledgers — see `InkLedgers::transfer`, called when a
    // fork's provenance lands.
    ink_ledgers: &InkLedgers,
    // Fired after each file-event write so the workspace's ChangesetFeed
    // recomputes immediately. Disconnected in harnesses without a
    // workspace registry.
    changeset_bumper: &crate::feeds::changeset::ChangesetBumper,
    cancel: &CancellationToken,
) -> RelayOutcome {
    // Captured when tugcode emits `resume_failed`. tugcode then
    // exits cleanly (no silent fresh-spawn fallback); we promote the
    // subsequent EOF from `Crashed` (would retry) to `ResumeFailed`
    // (terminal).
    let mut resume_failed: Option<(String, String)> = None;

    // How long a replay bracket may stay open before the relay declares it
    // wedged and forces live capture back on (see the watchdog below).
    const REPLAY_BRACKET_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

    // Replay-window flag. Set when tugcode emits `replay_started`,
    // cleared on `replay_complete`. Gates `record_turn` so replayed
    // `turn_complete` frames (one per persisted turn from JSONL) do
    // NOT re-bump the ledger row's `turn_count` — only LIVE turns
    // count. Without this gate every reconnect / restore inflates
    // the picker's "N turns" subtitle by the full transcript length.
    let mut in_replay = false;

    // Per-replay-window telemetry index. Built once on `replay_started`
    // (when we have the claude session id from a prior `session_init`)
    // and consulted on every replayed `turn_complete` for the inline
    // attach. `None` between replay windows; `Some(empty)` when no
    // telemetry rows exist for the session (still a valid lookup, the
    // get just misses and the frame passes through unchanged).
    //
    // Built up-front rather than per-row to amortize the sqlite query
    // — one `list_turn_telemetry` call per replay window, then O(1)
    // HashMap lookups per turn.
    let mut replay_telemetry: Option<
        std::collections::HashMap<String, crate::session_ledger::TurnTelemetryRow>,
    > = None;

    // Replay-window forward instrumentation: wall-clock anchor + count
    // of frames forwarded to the merger inside the window. Emitted as
    // a `perf.replay_forward` session-lifecycle trace on the bracket
    // close so the per-resume waterfall has the tugcast leg. The mpsc
    // send to the merger is awaited (backpressure, never dropped);
    // the lossy hop is the per-client broadcast downstream, counted
    // separately at the router's lag-recovery branch.
    let mut replay_forward_started: Option<std::time::Instant> = None;
    let mut replay_frames_forwarded: u64 = 0;
    // Turns whose persisted multi-clock timing was overlaid onto the
    // replayed `turn_complete` inside this window. Reported alongside
    // the forwarded-frame count: the overlay is a silent best-effort
    // path, and `injected=0` against a non-empty row index is exactly
    // the shape of a lost-timings regression (every replayed turn's
    // TIME then reads `—`).
    let mut replay_telemetry_injected: u64 = 0;

    // Attribution pending map ([P04]). Populated on each exact-tool
    // `tool_use`, consumed on its successful `tool_result`. Relay-local
    // (one per session's relay), size-capped with oldest eviction, and
    // never cleared on `turn_complete` — a background agent's child
    // `tool_use`/`tool_result` pair can straddle a turn boundary
    // (subagent-tail re-emission), and clearing at the boundary would
    // orphan exactly the edits attribution exists to catch.
    let mut pending_calls = PendingCalls::new();

    // `project_dir` arrives already canonical (the caller ran it through the
    // gateway). Adopt it as the bucket key and cache the session's canonical
    // repo root: sticky once found, re-probed while `None` so a repo that
    // appears mid-session (a `git init`) starts being projected.
    let canonical_project_dir = CanonicalPath::from_canonical(project_dir);
    let mut repo_root_cache: Option<CanonicalPath> = None;

    // Fingerprint brackets ([P05]), both relay-local — capture is a private,
    // per-session affair that never observes (or marks) another session; the
    // cross-session question ("is this file contended?") is answered at read
    // time from ledger rows, per-file ([D112]).
    //
    // - `open_bash`: per-call Bash brackets keyed by `tool_use_id`, opened on
    //   the Bash `tool_use`, closed by its `tool_result`.
    // - `open_turn`: the turn-scoped fallback bracket, opened when a
    //   `user_message` is forwarded to tugcode stdin, closed on that turn's
    //   non-replayed `turn_complete`. It mints `origin='turn'` rows only for
    //   working-tree deltas no exact/Bash row already recorded this turn (G2
    //   pre-snapshot race, G3 relay crash mid-Bash within a live turn),
    //   deduped via `turn_recorded_paths`.
    //
    // Relay-local means no cleanup ceremony: a crashed relay just drops its
    // brackets, and the read side's bucket surfacing covers the residual gap.
    let mut open_bash: HashMap<String, OpenBracket> = HashMap::new();
    let mut open_turn: Option<OpenBracket> = None;
    // The command-text half of the parse∩delta rule: what each in-flight Bash
    // call literally declared, keyed by `tool_use_id`. Populated on the
    // `tool_use` frame (live and replayed alike), consumed at its result.
    let mut pending_cmds = PendingCmds::new();
    // The facts library's own Bash map ([P06]) — unfiltered, so a `cargo
    // nextest run` (which names no file and so enters neither map above) still
    // becomes a `shell` fact and a `test_run` fact.
    let mut pending_shell_facts = PendingShellFacts::new();
    let mut turn_recorded_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // Handshake: write protocol_init, then wait up to 5s for protocol_ack.
    let protocol_init = b"{\"type\":\"protocol_init\",\"version\":1}\n";
    if let Err(e) = stdin.write_all(protocol_init).await {
        error!(session = %tug_session_id, error = %e, "failed to write protocol_init");
        return RelayOutcome::Crashed;
    }

    let ack = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await;
    match ack {
        Ok(Ok(Some(line))) if line.contains("\"type\":\"protocol_ack\"") => {
            info!(session = %tug_session_id, "protocol handshake successful");
        }
        Ok(Ok(Some(line))) => {
            error!(session = %tug_session_id, line, "invalid protocol_ack");
            return RelayOutcome::Crashed;
        }
        Ok(Ok(None)) => {
            error!(session = %tug_session_id, "tugcode stdout closed before protocol_ack");
            return RelayOutcome::Crashed;
        }
        Ok(Err(e)) => {
            error!(session = %tug_session_id, error = %e, "read error during protocol_ack");
            return RelayOutcome::Crashed;
        }
        Err(_) => {
            error!(session = %tug_session_id, "protocol_ack timed out");
            return RelayOutcome::Crashed;
        }
    }

    // Relay loop.
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                info!(session = %tug_session_id, "relay cancelled");
                return RelayOutcome::Cancelled;
            }
            line_result = lines.next_line() => {
                match line_result {
                    Ok(Some(line)) => {
                        // A rewind-fork announcement ([P11]). It arrives
                        // immediately BEFORE the fork's synthetic
                        // `session_init`, so the parent's callsign is
                        // transferred and staged here and consumed there —
                        // the fork inherits the name verbatim; a callsign is
                        // stable for the life of its line of work ([D132]).
                        // Best-effort: a parent with no callsign to hand down
                        // (a legacy tagless row, or a sibling fork whose
                        // parent's name already moved on), or a transfer
                        // error, leaves the fork to spawn as an ordinary root
                        // session minting a fresh pair. Provenance is staged
                        // in either case.
                        if line.contains("\"type\":\"session_fork\"") {
                            if let (Some(ledger), Some(fork)) =
                                (session_ledger, parse_session_fork(line.as_bytes()))
                            {
                                let now = crate::session_ledger::now_millis();
                                match ledger.inherit_fork_identity(
                                    &fork.parent_session_id,
                                    &fork.new_session_id,
                                    now,
                                ) {
                                    Ok(inherited) => {
                                        match inherited.tag.as_deref() {
                                            Some(tag) => info!(
                                                session = %tug_session_id,
                                                parent = %fork.parent_session_id,
                                                tag = %tag,
                                                "fork inherited its parent's callsign"
                                            ),
                                            None => info!(
                                                session = %tug_session_id,
                                                parent = %fork.parent_session_id,
                                                "fork parent has no callsign to hand \
                                                 down; the fork spawns as a root"
                                            ),
                                        }
                                        let mut entry = ledger_entry.lock().await;
                                        entry.pending_fork = Some((
                                            fork.new_session_id.clone(),
                                            crate::feeds::agent_supervisor::PendingFork {
                                                tag: inherited.tag,
                                                user_name: inherited.user_name,
                                                parent_session_id: fork
                                                    .parent_session_id
                                                    .clone(),
                                                fork_point: Some(fork.fork_point.clone()),
                                                // A rewind-fork seats nothing:
                                                // it continues a conversation
                                                // rather than opening one.
                                                stage_label: None,
                                                stage_model: None,
                                            },
                                        ));
                                    }
                                    Err(err) => warn!(
                                        session = %tug_session_id,
                                        error = %err,
                                        "fork identity transfer failed"
                                    ),
                                }
                            }
                        }

                        // A stage rotation is not a fork. It copies nothing,
                        // and the session it rotates goes on being used, so
                        // nothing transfers: the stage mints its own callsign,
                        // keeps its parent's name and ink where they are, and
                        // records where it came from with no branch point —
                        // `fork_point: None` is what tells a rotation edge
                        // from a rewind edge ([P03]).
                        if line.contains("\"type\":\"session_stage\"") {
                            // The `arc-stage` line is written here rather than
                            // by the runner that dispatched the rotation,
                            // because the record names the stage's **claude**
                            // session id and nobody knows that id until claude
                            // announces it. What the runner asked for and what
                            // actually started are then the same fact, which
                            // is what the lineage restore reads back ([P10]).
                            let announcement = parse_session_stage(line.as_bytes());
                            if let Some(stage) = announcement.as_ref() {
                                if let (Some(arc_name), Some(kind)) =
                                    (stage.arc.as_deref(), ArcStage::parse(&stage.stage))
                                {
                                    if let Err(err) = append_arc_stage(
                                        Path::new(project_dir),
                                        arc_name,
                                        kind,
                                        &stage.new_session_id,
                                        stage.model.as_deref(),
                                    ) {
                                        warn!(
                                            session = %tug_session_id,
                                            arc = %arc_name,
                                            error = %err,
                                            "arc stage line write failed"
                                        );
                                    }
                                }
                            }
                            if let (Some(_), Some(stage)) = (session_ledger, announcement) {
                                let now = crate::session_ledger::now_millis();
                                let tag = crate::session_ledger::roll_fresh_tag(
                                    &stage.new_session_id,
                                    now,
                                );
                                info!(
                                    session = %tug_session_id,
                                    parent = %stage.parent_session_id,
                                    stage = %stage.stage,
                                    tag = %tag,
                                    "stage spawns with its own callsign"
                                );
                                let mut entry = ledger_entry.lock().await;
                                entry.pending_fork = Some((
                                    stage.new_session_id.clone(),
                                    crate::feeds::agent_supervisor::PendingFork {
                                        tag: Some(tag),
                                        user_name: None,
                                        parent_session_id: stage.parent_session_id.clone(),
                                        fork_point: None,
                                        // Recorded from the announcement so
                                        // the restore can redraw this divider
                                        // without an arc record to consult
                                        // ([P10]).
                                        stage_label: Some(stage.stage.clone()),
                                        stage_model: stage.model.clone(),
                                    },
                                ));
                            }
                        }

                        // `session_init` path: atomic promote. Lock the
                        // ledger entry once and perform all four side
                        // effects — populate `claude_session_id`, flip
                        // `spawn_state` to `Live`, drain the per-session
                        // queue into `input_tx`, and publish the wire
                        // `SESSION_STATE = live` frame — so there is no
                        // intermediate state visible to other tasks where
                        // `spawn_state == Live` but the queue still holds
                        // frames that must precede any dispatcher-forwarded
                        // frame on input_tx.
                        //
                        // This is the sole point in the supervisor where
                        // ledger `Live` and wire `live` are established;
                        // the two are now semantically identical
                        // ("handshake done and session_init received").
                        //
                        // Guard: only promote if we're still in `Spawning`.
                        // A racing `close_session` that has already flipped
                        // us to `Closed`, or a previous iteration that
                        // already promoted, both short-circuit cleanly.
                        if line.contains("\"type\":\"session_init\"") {
                            let claude_id = parse_claude_session_id(line.as_bytes());
                            tracing::info!(
                                target: "dev::session-lifecycle",
                                event = "session_init.parse",
                                tug_session_id = %tug_session_id,
                                claude_session_id = claude_id.as_deref().unwrap_or(""),
                            );
                            // Snapshot the per-session bookkeeping fields the
                            // ledger needs (workspace key + bound card id) under
                            // the same lock that promotes Spawning→Live. These
                            // are populated by `do_spawn_session` before the
                            // bridge starts, so they're guaranteed present.
                            //
                            // Persistence of the (card_id → session) binding
                            // flows through the `sessions_recorder.record(...)`
                            // call below, which writes into the sqlite-backed
                            // `SessionLedger` keyed by claude's session id. The
                            // ledger row's `card_id` column is the source of
                            // truth for the client-side restore (consumed via
                            // the `list_card_bindings` CONTROL verb).
                            let (workspace_key, card_id, tag, pending_fork) = {
                                let mut entry = ledger_entry.lock().await;
                                if let Some(id) = &claude_id {
                                    if entry.claude_session_id.as_deref() != Some(id.as_str()) {
                                        entry.turns_ended = 0;
                                        entry.turn_api_error = false;
                                        // Without this the cancel latches
                                        // across a rotation and the next
                                        // stage stops the moment it ends its
                                        // first turn.
                                        entry.turn_cancelled = false;
                                    }
                                    entry.claude_session_id = Some(id.clone());
                                }
                                // A staged fork identity ([P11]) is consumed
                                // by the one `session_init` that follows its
                                // announcement, and names the spawn: the
                                // inherited callsign outranks the tag the
                                // entry is still carrying (that spelling was
                                // just transferred off the parent's row).
                                let pending_fork = match &entry.pending_fork {
                                    Some((fork_id, _))
                                        if claude_id.as_deref() == Some(fork_id.as_str()) =>
                                    {
                                        entry.pending_fork.take().map(|(_, fork)| fork)
                                    }
                                    _ => None,
                                };
                                if entry.spawn_state == SpawnState::Spawning {
                                    entry.spawn_state.try_transition(SpawnState::Live).ok();
                                    if let Some(tx) = entry.input_tx.clone() {
                                        while let Some(queued) = entry.queue.pop() {
                                            if tx.try_send(queued).is_err() {
                                                break;
                                            }
                                        }
                                    }
                                    // broadcast::Sender::send is synchronous,
                                    // so we can publish the wire frame while
                                    // the ledger lock is still held.
                                    let _ = state_tx.send(build_session_state_frame(
                                        tug_session_id,
                                        "live",
                                        None,
                                    ));
                                }
                                (
                                    entry.workspace_key.as_ref().to_owned(),
                                    entry.card_id.clone(),
                                    entry.tag.clone(),
                                    pending_fork,
                                )
                            };
                            // A fork's inherited callsign outranks the tag
                            // the entry still carries; an inheritance that
                            // came back empty (sibling / legacy parent)
                            // falls through so `record_spawn` mints fresh.
                            let tag = match &pending_fork {
                                Some(fork) => fork.tag.clone().or(tag),
                                None => tag,
                            };

                            // Record under claude's own session id — that
                            // is the on-disk file name, the only thing
                            // `--resume` accepts, and the unforgeable
                            // identity of the conversation. Tugdeck's
                            // prompt history follows the same id (read
                            // from `CodeSessionStore.claudeSessionId`,
                            // which is captured from this same
                            // `session_init`), so picker → sessions
                            // record → prompt history all key on the
                            // string claude told us, never on a value
                            // we assumed and forced.
                            //
                            // If claude failed to emit one we still need
                            // SOMETHING to key by; fall back to the
                            // tug session id and log loudly. In practice
                            // this only happens on malformed payloads.
                            let record_id = match claude_id.as_deref() {
                                Some(id) => id,
                                None => {
                                    warn!(
                                        tug_session_id = %tug_session_id,
                                        "session_init payload missing session_id; \
                                         recording under tug_session_id as a fallback"
                                    );
                                    tug_session_id.as_str()
                                }
                            };
                            // `card_id` is `None` only if `do_spawn_session`
                            // didn't populate it (which only happens for ledger
                            // entries rebound from tugbank at startup). The
                            // ledger column tolerates that — the row tracks
                            // "live, no current card" and a later real bind
                            // overwrites it.
                            let card_id_for_ledger = card_id.as_deref().unwrap_or("");
                            sessions_recorder.record(SessionRecord {
                                session_id: record_id,
                                workspace_key: &workspace_key,
                                project_dir,
                                card_id: card_id_for_ledger,
                                tag: tag.as_deref(),
                            });
                            // The row now exists under the inherited (or
                            // freshly minted) callsign; write the fork's
                            // provenance beside it, and the `/rename` it
                            // inherited with the callsign ([P11], [D154]).
                            if let (Some(ledger), Some(fork)) = (session_ledger, &pending_fork) {
                                if let Err(err) = ledger.set_fork_provenance(
                                    record_id,
                                    &fork.parent_session_id,
                                    fork.fork_point.as_deref(),
                                ) {
                                    warn!(
                                        session = %tug_session_id,
                                        error = %err,
                                        "set_fork_provenance failed; the fork keeps its callsign but loses its parentage record"
                                    );
                                }
                                // What the rotation seated it as, beside where
                                // it came from: the fork edge and these two
                                // columns are the whole of what a restore needs
                                // to redraw the transcript's divider ([P10]).
                                if let Some(label) = fork.stage_label.as_deref() {
                                    if let Err(err) = ledger.set_stage_provenance(
                                        record_id,
                                        label,
                                        fork.stage_model.as_deref(),
                                    ) {
                                        warn!(
                                            session = %tug_session_id,
                                            error = %err,
                                            "set_stage_provenance failed; the rotation lands but its divider will not survive a relaunch"
                                        );
                                    }
                                }
                                // The receipts and search history of this
                                // conversation belong with the line of work,
                                // exactly as its callsign does. Done here
                                // rather than at the fork announcement so the
                                // provenance edge already exists: a write
                                // racing this transfer resolves through the
                                // edge and lands on the fork anyway. Only a
                                // rewind-fork continues the conversation; a
                                // rotation has no branch point and leaves the
                                // parent's ink where the parent wrote it.
                                if fork.fork_point.is_some() {
                                    ink_ledgers.transfer(&fork.parent_session_id, record_id);
                                }
                                if let Some(name) = fork.user_name.as_deref() {
                                    if let Err(err) = ledger.rename(record_id, Some(name)) {
                                        warn!(
                                            session = %tug_session_id,
                                            error = %err,
                                            "fork rename transfer failed; the fork keeps its callsign but loses the inherited name"
                                        );
                                    } else if let Some(tx) = control_tx {
                                        // The parent's name was cleared by
                                        // `inherit_fork_identity`, and a bare
                                        // `notify_sessions_changed` cannot
                                        // un-teach it: the list seed path
                                        // ignores a blank by design, so
                                        // without this push every client keeps
                                        // the ghost and the two sessions go on
                                        // sharing one name on screen.
                                        if let Ok(Some(row)) =
                                            ledger.get(&fork.parent_session_id)
                                        {
                                            let metrics = ledger
                                                .scan_metrics_for(&fork.parent_session_id)
                                                .unwrap_or(None);
                                            let _ = tx.send(
                                                crate::feeds::agent_supervisor::build_session_updated_frame(
                                                    &row, metrics,
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                            // After each successful spawn record, cap the
                            // workspace to the configured non-live row max.
                            // Eviction targets the oldest closed/failed row,
                            // never the just-spawned (live) row.
                            sessions_recorder.evict_for_workspace(
                                &workspace_key,
                                crate::session_ledger::DEV_LEDGER_MAX_PER_WORKSPACE,
                            );
                        }

                        // Track replay window so the LIVE-turn check
                        // below skips replayed `turn_complete` frames.
                        // Tugcode brackets every replay run with
                        // `replay_started` ... `replay_complete`; turn
                        // events between those markers are persisted
                        // history, not new turns, and must not re-bump
                        // the ledger's `turn_count`.
                        // Replay-bracket watchdog. tugcode now guarantees a
                        // `replay_complete` for every `replay_started` (the
                        // bracket close is exception-proofed), but a latched
                        // bracket is too expensive to leave to one process's
                        // good behavior: while `in_replay` is stuck true the
                        // relay opens no Bash brackets, never closes the turn
                        // bracket, and mislabels exact rows — a standing
                        // attribution outage (the 2026-07-25 blackout class).
                        // A real replay completes in milliseconds-to-seconds;
                        // one open this long is wedged. Force live mode and
                        // say so.
                        if in_replay {
                            if let Some(t0) = replay_forward_started {
                                if t0.elapsed() > REPLAY_BRACKET_DEADLINE {
                                    warn!(
                                        session = %tug_session_id,
                                        open_secs = t0.elapsed().as_secs(),
                                        "replay bracket open past deadline; forcing live capture (bash/turn attribution was suppressed while open)"
                                    );
                                    in_replay = false;
                                    replay_telemetry = None;
                                    replay_forward_started = None;
                                }
                            }
                        }

                        if line.contains("\"type\":\"replay_started\"") {
                            in_replay = true;
                            replay_forward_started = Some(std::time::Instant::now());
                            replay_frames_forwarded = 0;
                            // Lazily populate the per-replay-window
                            // telemetry index. The claude session id is
                            // set by a prior `session_init` (cold-boot
                            // path resumes only run after handshake);
                            // if it's absent we skip the load and
                            // replayed `turn_complete` frames pass
                            // through unchanged — the client reducer's
                            // zero-derived block applies.
                            if let Some(ledger) = session_ledger {
                                let claude_id = {
                                    let entry = ledger_entry.lock().await;
                                    entry.claude_session_id.clone()
                                };
                                if let Some(id) = claude_id {
                                    match ledger.list_turn_telemetry(&id) {
                                        Ok(rows) => {
                                            let map = rows
                                                .into_iter()
                                                .map(|r| (r.msg_id.clone(), r))
                                                .collect();
                                            replay_telemetry = Some(map);
                                        }
                                        Err(e) => {
                                            warn!(
                                                session = %tug_session_id,
                                                error = %e,
                                                "list_turn_telemetry failed; replay will carry zero-derived telemetry"
                                            );
                                        }
                                    }
                                    // Bind-time inline of the persisted
                                    // `/context`-style breakdown. Synthesize
                                    // a `context_breakdown` wire frame from
                                    // the stored payload and emit it ahead
                                    // of the replayed transcript so the
                                    // popover renders pre-populated instead
                                    // of falling through to the 20.4.7.C
                                    // `cost_update`-derived view.
                                    //
                                    // `from_supervisor_attach: true` tells
                                    // the tugdeck reducer to project this
                                    // frame onto its snapshot but NOT
                                    // dispatch a `record_context_breakdown`
                                    // effect — the row already exists, the
                                    // round-trip would be a no-op UPSERT.
                                    //
                                    // Parse-and-rebuild rather than
                                    // byte-splice: the parse cost is
                                    // microseconds for a payload of this
                                    // size, and the resulting JSON is
                                    // robust to any whitespace / key-order
                                    // shifts in how the payload was
                                    // originally serialized.
                                    match ledger.get_context_breakdown(&id) {
                                        Ok(Some(row)) => {
                                            match serde_json::from_slice::<serde_json::Value>(
                                                &row.payload,
                                            ) {
                                                Ok(payload_value) => {
                                                    let mut wire = serde_json::json!({
                                                        "type": "context_breakdown",
                                                        "ipc_version": 2,
                                                        "from_supervisor_attach": true,
                                                    });
                                                    if let (
                                                        Some(payload_obj),
                                                        Some(wire_obj),
                                                    ) = (
                                                        payload_value.as_object(),
                                                        wire.as_object_mut(),
                                                    ) {
                                                        for (k, v) in payload_obj {
                                                            wire_obj
                                                                .insert(k.clone(), v.clone());
                                                        }
                                                        match serde_json::to_vec(&wire) {
                                                            Ok(bytes) => {
                                                                let spliced =
                                                                    splice_tug_session_id(
                                                                        &bytes,
                                                                        tug_session_id.as_str(),
                                                                    );
                                                                let frame = Frame::new(
                                                                    FeedId::CODE_OUTPUT,
                                                                    spliced,
                                                                );
                                                                if merger_tx
                                                                    .send(frame)
                                                                    .await
                                                                    .is_err()
                                                                {
                                                                    warn!(
                                                                        session = %tug_session_id,
                                                                        "merger receiver closed during context_breakdown bind-attach"
                                                                    );
                                                                    return RelayOutcome::Cancelled;
                                                                }
                                                            }
                                                            Err(e) => {
                                                                warn!(
                                                                    session = %tug_session_id,
                                                                    error = %e,
                                                                    "context_breakdown bind-attach serialize failed; falling through"
                                                                );
                                                            }
                                                        }
                                                    } else {
                                                        warn!(
                                                            session = %tug_session_id,
                                                            "persisted context_breakdown payload not a JSON object; skipping bind-attach"
                                                        );
                                                    }
                                                }
                                                Err(e) => {
                                                    warn!(
                                                        session = %tug_session_id,
                                                        error = %e,
                                                        "persisted context_breakdown payload not valid JSON; falling through"
                                                    );
                                                }
                                            }
                                        }
                                        Ok(None) => {
                                            // No persisted breakdown for this
                                            // session yet — popover hits the
                                            // 20.4.7.C fallback view until
                                            // the first live `context_breakdown`
                                            // frame lands.
                                        }
                                        Err(e) => {
                                            warn!(
                                                session = %tug_session_id,
                                                error = %e,
                                                "get_context_breakdown failed during bind-attach; falling through"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        // Set when a replay_complete frame is stamped with the
                        // engine count; consumed by the emit step below.
                        let mut replay_complete_emit: Option<Vec<u8>> = None;
                        if line.contains("\"type\":\"replay_complete\"") {
                            in_replay = false;
                            replay_telemetry = None;
                            if let Some(t0) = replay_forward_started.take() {
                                tracing::info!(
                                    target: "dev::session-lifecycle",
                                    event = "perf.replay_forward",
                                    tug_session_id = %tug_session_id,
                                    frames = replay_frames_forwarded,
                                    telemetry_injected = replay_telemetry_injected,
                                    ms = t0.elapsed().as_millis() as u64,
                                );
                            }
                            replay_telemetry_injected = 0;
                            // Reconcile + validate-and-stamp to the single count
                            // authority `engine(file)` ([P08], [Q01]). The ledger
                            // count is `engine(file)` — read it (the
                            // fingerprint-validated cached value, or the engine on
                            // the resolved path) and SET the row. Then compare
                            // tugcode's wire `totalTurns` to the engine: on a
                            // mismatch, log a contract breach and let the engine
                            // win; stamp the engine value onto the outgoing frame
                            // so the window indices can never silently diverge
                            // from the count. An error frame carries no
                            // `totalTurns`, so the stamp/compare is skipped and the
                            // engine lookup (file missing) returns `None` —
                            // nothing is zeroed.
                            let claude_id = {
                                let entry = ledger_entry.lock().await;
                                entry.claude_session_id.clone()
                            };
                            if let Some(id) = claude_id {
                                if let Some(engine_total) =
                                    sessions_recorder.engine_turn_count(&id, project_dir)
                                {
                                    if let Some(wire_total) =
                                        parse_replay_complete_total_turns(&line)
                                    {
                                        if wire_total != engine_total {
                                            warn!(
                                                target: "dev::turn-metric",
                                                event = "contract_breach.replay_total_turns",
                                                tug_session_id = %tug_session_id,
                                                session_id = id.as_str(),
                                                wire_total,
                                                engine_total,
                                                "tugcode replay totalTurns != engine(file); engine wins",
                                            );
                                        }
                                        replay_complete_emit = Some(
                                            stamp_replay_complete_total_turns(&line, engine_total),
                                        );
                                    }
                                    sessions_recorder.set_turn_count(&id, engine_total);
                                }
                            }
                        }

                        // `turn_complete` events mark the end of an
                        // assistant turn. Each LIVE one touches the ledger
                        // row's `last_used_at` only — the turn COUNT is
                        // `engine(file)` ([P08]), refreshed by the
                        // scan-on-`list_sessions` path, never incremented
                        // here. Tugcode emits this once per turn — substring
                        // match is sufficient given the surrounding
                        // stream-json shape; a more careful parser would be
                        // `serde_json::from_str` over the whole line, but
                        // that pays the deserialize cost on every output
                        // line for negligible benefit.
                        //
                        // Replay-bracketed `turn_complete` frames are
                        // skipped from the LIVE turn-count bump (they
                        // re-emit persisted history on every reconnect /
                        // restore, and counting them would inflate the
                        // picker subtitle by the full transcript length)
                        // BUT they are the surface where we INJECT the
                        // persisted per-turn telemetry — the client
                        // reducer's merge function adopts the inline
                        // payload on the replay path. See plan
                        // `#step-20-3-4`.
                        let line_to_emit: Vec<u8> = if let Some(stamped) = replay_complete_emit {
                            // The replay_complete frame, its `totalTurns`
                            // re-stamped from `engine(file)` (the authority).
                            stamped
                        } else if line.contains("\"type\":\"turn_complete\"") {
                            if in_replay {
                                // A live turn ending inside a replay bracket
                                // is the incident signature ([G8]): its turn
                                // bracket cannot close here, so its delta
                                // goes unattributed. Loud, never silent —
                                // the watchdog above bounds how long this
                                // state can persist.
                                if open_turn.is_some() {
                                    warn!(
                                        session = %tug_session_id,
                                        "turn_complete during replay with an open turn bracket; this turn's delta is not attributed"
                                    );
                                }
                                if let Some(ref map) = replay_telemetry {
                                    let (bytes, injected) =
                                        inject_replay_telemetry(line.as_bytes(), map);
                                    replay_telemetry_injected += injected as u64;
                                    bytes
                                } else {
                                    line.as_bytes().to_vec()
                                }
                            } else {
                                let claude_id = {
                                    let entry = ledger_entry.lock().await;
                                    entry.claude_session_id.clone()
                                };
                                if let Some(id) = claude_id {
                                    sessions_recorder.record_turn(&id);
                                }
                                // Close the turn-scoped fallback bracket ([P05]):
                                // attribute any working-tree delta this live turn
                                // that no exact/Bash row already covered, as
                                // `origin='turn'` rows. Best-effort — a snapshot
                                // or ledger error is logged, never gates the
                                // frame. The set is cleared for the next turn.
                                if let (Some(bracket), Some(ledger)) =
                                    (open_turn.take(), session_ledger)
                                {
                                    let post = snapshot_worktree(&bracket.repo_root).await;
                                    let at = crate::session_ledger::now_millis();
                                    let mut recorded = false;
                                    for row in bracket.into_delta_rows(
                                        &post,
                                        &canonical_project_dir,
                                        "Turn",
                                        "turn",
                                        // A turn spans arbitrarily many commands;
                                        // no single command's operands can speak
                                        // for its delta.
                                        &DeclaredPromotions::default(),
                                        at,
                                    ) {
                                        if turn_recorded_paths.contains(&row.file_path) {
                                            continue;
                                        }
                                        if let Err(err) = ledger.record_file_event(&row) {
                                            crate::ledger_integrity::health::note_error(
                                                "changes", &err,
                                            );
                                            warn!(
                                                session = %tug_session_id,
                                                error = %err,
                                                "record_file_event (turn) failed; frame forwarded unchanged"
                                            );
                                        } else {
                                            recorded = true;
                                        }
                                    }
                                    if recorded {
                                        changeset_bumper.bump(Path::new(project_dir));
                                    }
                                    turn_recorded_paths.clear();
                                }
                                line.as_bytes().to_vec()
                            }
                        } else if line.contains("\"type\":\"system_metadata\"") {
                            // Bridge intercept for LIVE-ONLY session
                            // metadata. The live path delivers a rich
                            // payload (model with `[1m]` suffix, cwd,
                            // permissionMode, tools, …); the replay
                            // path (`tugcode/src/replay.ts:984`)
                            // synthesizes a bare-model payload with
                            // every other field empty. Without this
                            // merge the replay would clobber the live
                            // values on every resume.
                            //
                            // Key the ledger by `claude_session_id`
                            // (captured by the session_init interceptor
                            // above), NOT by the line's own
                            // `session_id` field — the live path's
                            // payload can have an empty session_id
                            // when the SDK omits it. See plan
                            // `#step-20-3-6` "Intercept-key sourcing".
                            //
                            // If the merge cannot proceed (ledger
                            // absent, claude_session_id absent, parse
                            // error, ledger write error), the line
                            // passes through unchanged. The wire
                            // delivery must not depend on persistence
                            // success.
                            let claude_id = {
                                let entry = ledger_entry.lock().await;
                                entry.claude_session_id.clone()
                            };
                            match (session_ledger, claude_id) {
                                (Some(ledger), Some(id)) => merge_and_persist_system_metadata(
                                    line.as_bytes(),
                                    ledger,
                                    &id,
                                    tug_session_id,
                                ),
                                _ => line.as_bytes().to_vec(),
                            }
                        } else {
                            line.as_bytes().to_vec()
                        };

                        // `session_title` peek: claude's auto-generated
                        // `ai-title`, forwarded live by tugcode instead of
                        // waiting for the next external scan to read it out
                        // of the JSONL. The write never clobbers a `/rename`
                        // (`record_auto_title` gates on `name_user_set`), and
                        // it is best-effort — a ledger error is logged and the
                        // frame still forwards.
                        //
                        // Keyed by claude's session id, NOT the tug session id
                        // — ledger rows are recorded under claude's own id
                        // (see the `record_id` choice at `session_init`), and
                        // the two diverge the moment claude rotates its id or
                        // a rewind fork respawns inside this same relay. Keyed
                        // by the tug id, a fork's title would land on the
                        // PARENT's row, whose `name_user_set` is typically 0
                        // and so would not refuse it. The tug id remains the
                        // fallback for the malformed-payload case that
                        // `record_id` also falls back on.
                        if line.contains("\"type\":\"session_title\"") {
                            if let (Some(ledger), Some(title)) =
                                (session_ledger, parse_session_title(line.as_bytes()))
                            {
                                let row_id = {
                                    let entry = ledger_entry.lock().await;
                                    entry.claude_session_id.clone()
                                }
                                .unwrap_or_else(|| tug_session_id.as_str().to_owned());
                                match ledger.record_auto_title(&row_id, &title) {
                                    Ok(true) => info!(
                                        session = %tug_session_id,
                                        row = %row_id,
                                        "recorded auto session title"
                                    ),
                                    Ok(false) => {}
                                    Err(err) => warn!(
                                        session = %tug_session_id,
                                        error = %err,
                                        "record_auto_title failed"
                                    ),
                                }
                            }
                        }

                        // `resume_failed` peek: tugcode emits this when
                        // a `--resume` attempt aborts before `session_init`.
                        // The stale id is no longer usable; the ledger row
                        // for it transitions to `failed` as a diagnostic
                        // crumb the picker can show. The frame still gets
                        // forwarded to the card so `lastError` surfaces a
                        // notice.
                        if line.contains("\"type\":\"resume_failed\"") {
                            let reason = parse_resume_failed_reason(line.as_bytes())
                                .unwrap_or_else(|| "resume failed".to_string());
                            if let Some(stale) = parse_resume_failed_id(line.as_bytes()) {
                                tracing::info!(
                                    target: "dev::session-lifecycle",
                                    event = "bridge.resume_failed_recv",
                                    tug_session_id = %tug_session_id,
                                    stale_session_id = stale.as_str(),
                                    reason = reason.as_str(),
                                );
                                sessions_recorder.mark_failed(&stale);
                                resume_failed = Some((stale, reason));
                            }
                        }

                        // Attribution intercept ([P03]–[P06]). Exact file
                        // events for Write/Edit/MultiEdit/NotebookEdit are
                        // captured as a pure side effect: `tool_use`
                        // populates the pending map; a successful
                        // `tool_result` resolves it to a `file_events`
                        // upsert. Result-gated so denied/errored calls
                        // don't pollute the record; `origin='replay'` and
                        // the tool_use timestamp are used on the replay
                        // path so a resumed session backfills historical
                        // rows idempotently (the PK collapses re-streams).
                        // Every branch is best-effort — a parse or ledger
                        // error is logged and the frame still forwards
                        // unchanged; attribution must never gate wire
                        // delivery. (Bash bracketing is layered on in the
                        // next step.)
                        // A compaction boundary, on the same line-inspection
                        // fast path attribution uses. Inside a `replay_batch`
                        // it arrives as an inner frame, so both shapes are
                        // walked; the [P03] key is built from the frame's own
                        // timestamp, which is what makes a resume's re-stream
                        // land on the row it already wrote.
                        if let Some(ledger) = session_ledger
                            && line.contains("\"type\":\"compact_boundary\"")
                            && let Ok(value) =
                                serde_json::from_str::<serde_json::Value>(&line)
                        {
                            let frame_at = |frame: &serde_json::Value| {
                                frame
                                    .get("timestamp")
                                    .and_then(serde_json::Value::as_i64)
                                    .unwrap_or_else(crate::session_ledger::now_millis)
                            };
                            match value.get("frames").and_then(|f| f.as_array()) {
                                Some(frames) => {
                                    for frame in frames {
                                        if frame.get("type").and_then(|t| t.as_str())
                                            == Some("compact_boundary")
                                        {
                                            record_compact_fact(
                                                ledger,
                                                tug_session_id,
                                                frame,
                                                frame_at(frame),
                                            );
                                        }
                                    }
                                }
                                None => {
                                    if value.get("type").and_then(|t| t.as_str())
                                        == Some("compact_boundary")
                                    {
                                        record_compact_fact(
                                            ledger,
                                            tug_session_id,
                                            &value,
                                            frame_at(&value),
                                        );
                                    }
                                }
                            }
                        }
                        if let Some(ledger) = session_ledger {
                            if line.contains("\"type\":\"replay_batch\"") {
                                // Batched replay frames. tugcode's replay
                                // path flushes committed-turn content as one
                                // `replay_batch` line of up to 256 inner
                                // frames — including every historical
                                // `tool_use`/`tool_result` pair the replay
                                // backfill exists to re-record, and any live
                                // frames a mid-turn replay swallowed into
                                // its bracket. Unwrap and run the same
                                // exact-tool intercept per inner frame
                                // (origin='replay', historical `at`, PK
                                // collapses re-streams). Bash is never
                                // bracketed here: a batched frame is
                                // replayed history and the pre-command
                                // fingerprint is gone (G1).
                                match InspectedReplayBatch::from_slice(line.as_bytes()) {
                                    Some(batch) => {
                                        let mut recorded_any = false;
                                        for inner in &batch.frames {
                                            let bytes = inner.get().as_bytes();
                                            if let Some(tu) = InspectedToolUse::from_slice(bytes) {
                                                // Every Bash call, before any
                                                // attribution filter sees it
                                                // ([P06]). Replayed history
                                                // becomes facts too — that is
                                                // the desirable back-fill the
                                                // dedupe key makes safe.
                                                if let Some(command) =
                                                    bash_command_for_tool(&tu.tool_name, &tu.input)
                                                {
                                                    pending_shell_facts.insert(
                                                        tu.tool_use_id.clone(),
                                                        PendingShellFact {
                                                            command,
                                                            at_ms: tu.timestamp.unwrap_or_else(
                                                                crate::session_ledger::now_millis,
                                                            ),
                                                        },
                                                    );
                                                }
                                                if let (Some(op), Some(path)) = (
                                                    exact_op_for_tool(&tu.tool_name),
                                                    file_path_for_tool(&tu.tool_name, &tu.input),
                                                ) {
                                                    // The anchors come from the
                                                    // tool input, which replays
                                                    // — so a backfilled row
                                                    // carries the same evidence
                                                    // a live one does.
                                                    let spans = spans_for_tool_input(
                                                        &tu.tool_name,
                                                        &tu.input,
                                                    );
                                                    pending_calls.insert(
                                                        tu.tool_use_id.clone(),
                                                        crate::feeds::attribution::PendingCall {
                                                            tool_name: tu.tool_name,
                                                            file_path: path,
                                                            op,
                                                            parent_tool_use_id: tu.parent_tool_use_id,
                                                            timestamp: tu.timestamp,
                                                            spans,
                                                        },
                                                    );
                                                } else if let Some(command) =
                                                    bash_command_for_tool(&tu.tool_name, &tu.input)
                                                {
                                                    // No bracket replays (G1),
                                                    // but the command text does
                                                    // — and what it named is
                                                    // proof on its own.
                                                    if let Some(ops) = declared_ops_for_command(
                                                        &command,
                                                        Path::new(project_dir),
                                                    ) {
                                                        pending_cmds.insert(
                                                            tu.tool_use_id.clone(),
                                                            PendingCmd {
                                                                ops,
                                                                parent_tool_use_id: tu
                                                                    .parent_tool_use_id,
                                                                timestamp: tu.timestamp,
                                                            },
                                                        );
                                                    }
                                                }
                                            } else if let Some(tr) =
                                                InspectedToolResult::from_slice(bytes)
                                            {
                                                if let Some(pending) =
                                                    pending_shell_facts.take(&tr.tool_use_id)
                                                {
                                                    record_shell_facts(
                                                        ledger,
                                                        tug_session_id,
                                                        pending,
                                                        &tr.tool_use_id,
                                                        &tr.output,
                                                        tr.is_error,
                                                    );
                                                }
                                                if let Some(cmd) =
                                                    pending_cmds.take(&tr.tool_use_id)
                                                {
                                                    if !tr.is_error
                                                        && mint_replayed_cmd_rows(
                                                            cmd,
                                                            &tr.tool_use_id,
                                                            tr.timestamp,
                                                            tug_session_id,
                                                            &canonical_project_dir,
                                                            &mut repo_root_cache,
                                                            project_dir,
                                                            ledger,
                                                        )
                                                        .await
                                                    {
                                                        recorded_any = true;
                                                    }
                                                }
                                                if !tr.is_error
                                                    && tr.output.contains(RECEIPT_MARKER)
                                                    && !mint_receipt_rows(
                                                        &tr.output,
                                                        &tr.tool_use_id,
                                                        tr.timestamp.unwrap_or_else(
                                                            crate::session_ledger::now_millis,
                                                        ),
                                                        tug_session_id,
                                                        &canonical_project_dir,
                                                        &mut repo_root_cache,
                                                        project_dir,
                                                        ledger,
                                                    )
                                                    .await
                                                    .is_empty()
                                                {
                                                    recorded_any = true;
                                                }
                                                if let Some(pending) =
                                                    pending_calls.take(&tr.tool_use_id)
                                                {
                                                    if !tr.is_error
                                                        && record_exact_pending(
                                                            pending,
                                                            &tr.tool_use_id,
                                                            tr.timestamp,
                                                            "replay",
                                                            true,
                                                            tug_session_id,
                                                            &canonical_project_dir,
                                                            &mut repo_root_cache,
                                                            project_dir,
                                                            ledger,
                                                        )
                                                        .await
                                                        .is_some()
                                                    {
                                                        recorded_any = true;
                                                    }
                                                }
                                            }
                                        }
                                        if recorded_any {
                                            changeset_bumper.bump(Path::new(project_dir));
                                        }
                                    }
                                    None => {
                                        warn!(
                                            session = %tug_session_id,
                                            "replay_batch line failed to parse; its frames are invisible to attribution"
                                        );
                                    }
                                }
                            } else if line.contains("\"type\":\"tool_use\"")
                                || line.contains("\"type\":\"tool_result\"")
                            {
                                // The parse decides, not the substring: a
                                // `tool_result` whose output embeds the
                                // `tool_use` literal (any edit to this very
                                // codebase does it) must still resolve as a
                                // result, and a frame that IS a tool frame
                                // but fails both parses is shape drift that
                                // must be loud, not silent.
                                if let Some(tu) = InspectedToolUse::from_slice(line.as_bytes()) {
                                    // Every Bash call, ahead of every filter
                                    // ([P06]) — the attribution maps below
                                    // admit only file-operation commands in a
                                    // live repo, which is precisely not what a
                                    // build or a test run looks like.
                                    if let Some(command) =
                                        bash_command_for_tool(&tu.tool_name, &tu.input)
                                    {
                                        pending_shell_facts.insert(
                                            tu.tool_use_id.clone(),
                                            PendingShellFact {
                                                command,
                                                at_ms: tu.timestamp.unwrap_or_else(
                                                    crate::session_ledger::now_millis,
                                                ),
                                            },
                                        );
                                    }
                                    if let (Some(op), Some(path)) = (
                                        exact_op_for_tool(&tu.tool_name),
                                        file_path_for_tool(&tu.tool_name, &tu.input),
                                    ) {
                                        let spans =
                                            spans_for_tool_input(&tu.tool_name, &tu.input);
                                        pending_calls.insert(
                                            tu.tool_use_id.clone(),
                                            crate::feeds::attribution::PendingCall {
                                                tool_name: tu.tool_name,
                                                file_path: path,
                                                op,
                                                parent_tool_use_id: tu.parent_tool_use_id,
                                                timestamp: tu.timestamp,
                                                spans,
                                            },
                                        );
                                    } else if tu.tool_name == "Bash" {
                                        // The command text is evidence in its
                                        // own right: the operands it literally
                                        // names are proof, the same way an
                                        // exact tool's `file_path` is. Read it
                                        // on every Bash call, replayed or live
                                        // — the live path intersects it with
                                        // the bracket delta, the replay path
                                        // (which has no fingerprint) mints from
                                        // it directly. Operands resolve against
                                        // the session's project dir: that is
                                        // the command's working directory.
                                        if let Some(command) =
                                            bash_command_for_tool(&tu.tool_name, &tu.input)
                                        {
                                            if let Some(ops) = declared_ops_for_command(
                                                &command,
                                                Path::new(project_dir),
                                            ) {
                                                pending_cmds.insert(
                                                    tu.tool_use_id.clone(),
                                                    PendingCmd {
                                                        ops,
                                                        parent_tool_use_id: tu
                                                            .parent_tool_use_id
                                                            .clone(),
                                                        timestamp: tu.timestamp,
                                                    },
                                                );
                                            }
                                        }
                                        // Open a working-tree bracket now
                                        // (before the command runs — the
                                        // tool_use frame precedes execution,
                                        // [R01]). Never in replay ([P06]: no
                                        // fingerprint is reconstructable after
                                        // the fact). Non-repo dirs open no
                                        // bracket.
                                        if let Some(repo_root) = if in_replay {
                                            None
                                        } else {
                                            ensure_repo_root(&mut repo_root_cache, project_dir).await
                                        } {
                                            let root = repo_root.as_path().to_path_buf();
                                            let pre = snapshot_worktree(&root).await;
                                            open_bash.insert(
                                                tu.tool_use_id.clone(),
                                                OpenBracket {
                                                    tug_session_id: tug_session_id
                                                        .as_str()
                                                        .to_owned(),
                                                    tool_use_id: tu.tool_use_id,
                                                    parent_tool_use_id: tu.parent_tool_use_id,
                                                    opened_at: crate::session_ledger::now_millis(),
                                                    repo_root: root,
                                                    pre,
                                                },
                                            );
                                        }
                                    }
                                } else if let Some(tr) =
                                    InspectedToolResult::from_slice(line.as_bytes())
                                {
                                    if let Some(pending) =
                                        pending_shell_facts.take(&tr.tool_use_id)
                                    {
                                        record_shell_facts(
                                            ledger,
                                            tug_session_id,
                                            pending,
                                            &tr.tool_use_id,
                                            &tr.output,
                                            tr.is_error,
                                        );
                                    }
                                    if let Some(pending) = pending_calls.take(&tr.tool_use_id) {
                                        // Exact call. is_error → dropped
                                        // (already taken from the map): a
                                        // refused or failed exact call records
                                        // nothing.
                                        if !tr.is_error {
                                            let origin = if in_replay { "replay" } else { "exact" };
                                            if let Some(recorded_path) = record_exact_pending(
                                                pending,
                                                &tr.tool_use_id,
                                                tr.timestamp,
                                                origin,
                                                in_replay,
                                                tug_session_id,
                                                &canonical_project_dir,
                                                &mut repo_root_cache,
                                                project_dir,
                                                ledger,
                                            )
                                            .await
                                            {
                                                if open_turn.is_some() {
                                                    turn_recorded_paths.insert(recorded_path);
                                                }
                                                changeset_bumper.bump(Path::new(project_dir));
                                            }
                                        }
                                    } else {
                                        // A Bash result. Three things can
                                        // attribute here: the bracket delta
                                        // (live), the declared operations
                                        // (replay, where no fingerprint
                                        // exists), and any `tugutil file`
                                        // receipt the output carries.
                                        let mut recorded = false;
                                        // A verb receipt is proof (`cmd`), and
                                        // it is read FIRST — before the bracket
                                        // delta below writes its weak `bash`
                                        // hint for the same file. The insert is
                                        // ON CONFLICT (session, tool_use_id,
                                        // file_path) DO NOTHING, so whichever
                                        // origin lands first wins the row; proof
                                        // must, or a `tugutil file`/`tugrev`
                                        // edit to an in-tree file loses its
                                        // receipt to the hint and reads as
                                        // UNATTRIBUTED. Read from any successful
                                        // Bash result, whatever ran it — the
                                        // verb says exactly which files it
                                        // touched.
                                        if !tr.is_error && tr.output.contains(RECEIPT_MARKER) {
                                            let at = if in_replay {
                                                tr.timestamp.unwrap_or_else(
                                                    crate::session_ledger::now_millis,
                                                )
                                            } else {
                                                crate::session_ledger::now_millis()
                                            };
                                            for path in mint_receipt_rows(
                                                &tr.output,
                                                &tr.tool_use_id,
                                                at,
                                                tug_session_id,
                                                &canonical_project_dir,
                                                &mut repo_root_cache,
                                                project_dir,
                                                ledger,
                                            )
                                            .await
                                            {
                                                if open_turn.is_some() {
                                                    turn_recorded_paths.insert(path);
                                                }
                                                recorded = true;
                                            }
                                        }
                                        if let Some(bracket) = open_bash.remove(&tr.tool_use_id) {
                                        // Bash call: close the bracket and
                                        // attribute the delta — regardless of
                                        // is_error, since a failing command
                                        // can have mutated files before it
                                        // failed. The session's own
                                        // project_dir owns the rows (so Bash
                                        // and exact events share a bucket).
                                        let post = snapshot_worktree(&bracket.repo_root).await;
                                        let at = crate::session_ledger::now_millis();
                                        // parse ∩ delta: a path the command
                                        // named AND the tree observed change is
                                        // proof, and its row is minted `cmd`
                                        // instead of `bash`. How far the naming
                                        // reaches depends on the verb, so the
                                        // ops are partitioned into exact and
                                        // subtree promotions ([P02]).
                                        let declared_cmd = pending_cmds.take(&tr.tool_use_id);
                                        let declared = declared_cmd
                                            .as_ref()
                                            .map(|cmd| DeclaredPromotions::from_ops(cmd.ops.iter()))
                                            .unwrap_or_default();
                                        let bracket_root = bracket.repo_root.clone();
                                        for row in bracket.into_delta_rows(
                                            &post,
                                            &canonical_project_dir,
                                            "Bash",
                                            "bash",
                                            &declared,
                                            at,
                                        ) {
                                            // A promotion asserts authorship;
                                            // it records what it is asserting
                                            // over so the diff can later
                                            // contradict it ([P05]). A hint
                                            // asserts nothing and carries no
                                            // spans.
                                            let spans = if row.origin == CMD_ORIGIN {
                                                promoted_row_spans(&bracket_root, &row.file_path)
                                                    .await
                                            } else {
                                                Vec::new()
                                            };
                                            let recording = if spans.is_empty() {
                                                ledger.record_file_event(&row)
                                            } else {
                                                ledger.record_file_event_with_spans(&row, &spans)
                                            };
                                            if let Err(err) = recording {
                                                crate::ledger_integrity::health::note_error(
                                                    "changes", &err,
                                                );
                                                warn!(
                                                    session = %tug_session_id,
                                                    error = %err,
                                                    "record_file_event (bash) failed; frame forwarded unchanged"
                                                );
                                            } else {
                                                if open_turn.is_some() {
                                                    turn_recorded_paths.insert(row.file_path.clone());
                                                }
                                                recorded = true;
                                            }
                                        }
                                        // A rename's old name never shows in the
                                        // post-delta — the file left the dirty
                                        // set under it — so the takeoff row is
                                        // synthesized from the parse, paired
                                        // with the new-path row under one
                                        // tool_use_id.
                                        if let Some(cmd) = declared_cmd.as_ref() {
                                            for op in &cmd.ops {
                                                let DeclaredKind::Move { orig } = &op.kind else {
                                                    continue;
                                                };
                                                let landed = CanonicalPath::from_raw(&op.path);
                                                if !post.contains_key(landed.as_path()) {
                                                    continue;
                                                }
                                                if let Some(path) = record_cmd_event(
                                                    orig,
                                                    "renamed",
                                                    &tr.tool_use_id,
                                                    cmd.parent_tool_use_id.clone(),
                                                    &[],
                                                    at,
                                                    tug_session_id,
                                                    &canonical_project_dir,
                                                    &mut repo_root_cache,
                                                    project_dir,
                                                    ledger,
                                                )
                                                .await
                                                {
                                                    if open_turn.is_some() {
                                                        turn_recorded_paths.insert(path);
                                                    }
                                                    recorded = true;
                                                }
                                            }
                                        }
                                        } else if let Some(cmd) =
                                            pending_cmds.take(&tr.tool_use_id)
                                        {
                                            // A parsed Bash call that closed no
                                            // bracket: replayed history (no
                                            // fingerprint exists to intersect
                                            // with), where the declared
                                            // operations mint directly. Outside
                                            // replay this means the project dir
                                            // is in no repo, and the take is
                                            // only cleanup.
                                            if in_replay
                                                && !tr.is_error
                                                && mint_replayed_cmd_rows(
                                                    cmd,
                                                    &tr.tool_use_id,
                                                    tr.timestamp,
                                                    tug_session_id,
                                                    &canonical_project_dir,
                                                    &mut repo_root_cache,
                                                    project_dir,
                                                    ledger,
                                                )
                                                .await
                                            {
                                                recorded = true;
                                            }
                                        }

                                        if recorded {
                                            changeset_bumper.bump(Path::new(project_dir));
                                        }
                                    }
                                } else if matches!(
                                    top_level_type(line.as_bytes()).as_deref(),
                                    Some("tool_use" | "tool_result")
                                ) {
                                    // A genuine tool frame that neither
                                    // inspected parse accepts is wire-shape
                                    // drift — the exact silent-miss class the
                                    // 2026-07-25 capture blackout hid. Lines
                                    // of another type that merely embed the
                                    // substring (streamed text quoting this
                                    // codebase) stay silent by design.
                                    warn!(
                                        session = %tug_session_id,
                                        preview = %line.chars().take(200).collect::<String>(),
                                        "tool frame failed the attribution parse; exact capture missed this call (shape drift?)"
                                    );
                                }
                            }
                        }

                        let spliced = splice_tug_session_id(&line_to_emit, tug_session_id.as_str());
                        let frame = Frame::new(FeedId::CODE_OUTPUT, spliced);
                        if in_replay {
                            replay_frames_forwarded += 1;
                        }
                        if merger_tx.send(frame).await.is_err() {
                            warn!(session = %tug_session_id, "merger receiver closed; ending relay");
                            return RelayOutcome::Cancelled;
                        }
                    }
                    Ok(None) => {
                        if let Some((stale, reason)) = resume_failed.take() {
                            info!(
                                session = %tug_session_id,
                                stale_session_id = stale,
                                "tugcode exited after resume_failed; not retrying"
                            );
                            return RelayOutcome::ResumeFailed {
                                stale_session_id: stale,
                                reason,
                            };
                        }
                        warn!(session = %tug_session_id, "tugcode stdout closed");
                        return RelayOutcome::Crashed;
                    }
                    Err(e) => {
                        if let Some((stale, reason)) = resume_failed.take() {
                            info!(
                                session = %tug_session_id,
                                stale_session_id = stale,
                                error = %e,
                                "tugcode stdout error after resume_failed; not retrying"
                            );
                            return RelayOutcome::ResumeFailed {
                                stale_session_id: stale,
                                reason,
                            };
                        }
                        error!(session = %tug_session_id, error = %e, "stdout read error");
                        return RelayOutcome::Crashed;
                    }
                }
            }
            maybe_frame = input_rx.recv() => {
                let Some(frame) = maybe_frame else {
                    // Dispatcher sender dropped — we're being torn down.
                    return RelayOutcome::Cancelled;
                };
                if let Some(json) = parse_code_input(&frame) {
                    // Capture the most-recent user-message text before
                    // forwarding it to claude. Claude does not echo user
                    // inputs back through stream-json (the assistant turn
                    // arrives alone), so this branch is the only place
                    // the picker's prompt snippet can be recorded. The
                    // ledger's `record_user_prompt` overwrites on every
                    // call — the picker shows the latest prompt so the
                    // user recognizes the most-recent thread.
                    let is_user_message = parse_user_message_text(json.as_bytes());
                    if let Some(text) = &is_user_message {
                        let claude_id = {
                            let entry = ledger_entry.lock().await;
                            entry.claude_session_id.clone()
                        };
                        if let Some(id) = claude_id {
                            let truncated = crate::session_ledger::truncate_user_prompt(text);
                            sessions_recorder.record_user_prompt(&id, &truncated);
                        }
                        // The same prompt, kept whole and kept forever. The
                        // snippet above is one overwritten 256-char field the
                        // picker reads; this is what the Operator answers
                        // "what did I ask earlier" from. Keyed by the tug
                        // session id, which is the id every other fact and
                        // every verb uses.
                        if let Some(ledger) = session_ledger
                            && !crate::feeds::facts_library::is_local_command_bookkeeping(text)
                        {
                            record_fact_best_effort(
                                ledger,
                                tug_session_id,
                                &crate::feeds::facts_library::prompt_fact(
                                    crate::session_ledger::now_millis(),
                                    tug_session_id.as_str(),
                                    text,
                                ),
                            );
                        }
                    }

                    let mut line = json;
                    line.push('\n');
                    if let Err(e) = stdin.write_all(line.as_bytes()).await {
                        error!(session = %tug_session_id, error = %e, "stdin write error");
                        return RelayOutcome::Crashed;
                    }

                    // Open the turn-scoped fallback bracket ([P05]) on the first
                    // user_message of a turn, right after the stdin forward: the
                    // pre-snapshot happens seconds before the model can emit a
                    // command, so a fast Bash whose per-call bracket loses the
                    // race (G2) or is dropped by a mid-Bash crash (G3) is still
                    // caught by this turn-wide window. A second queued
                    // user_message before turn_complete does not reopen — the
                    // wider window already brackets everything. Best-effort:
                    // never gates the forward; skipped in a non-repo dir or
                    // without a ledger to record into.
                    if is_user_message.is_some()
                        && open_turn.is_none()
                        && session_ledger.is_some()
                    {
                        if let Some(repo_root) =
                            ensure_repo_root(&mut repo_root_cache, project_dir).await
                        {
                            let root = repo_root.as_path().to_path_buf();
                            let pre = snapshot_worktree(&root).await;
                            let opened_at = crate::session_ledger::now_millis();
                            open_turn = Some(OpenBracket {
                                tug_session_id: tug_session_id.as_str().to_owned(),
                                tool_use_id: format!("turn:{opened_at}"),
                                parent_tool_use_id: None,
                                opened_at,
                                repo_root: root,
                                pre,
                            });
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract Claude Code's internal `session_id` field from a `session_init`
/// stream-json line. Used to populate `LedgerEntry::claude_session_id`.
fn parse_claude_session_id(line: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Read tugcode's wire `totalTurns` off a `replay_complete` line — for the
/// **validate-and-stamp** comparison only ([Q01]), NOT as a count source.
/// The count authority is `engine(file)` ([P08]); this value is compared to
/// it (a mismatch is a logged contract breach, engine wins). Returns `Some`
/// for a SUCCESS frame carrying window metadata, `None` for an error/legacy
/// frame with no `totalTurns`. Reads `totalTurns`, never the sibling `count`
/// (the windowed `turnsCommitted`, which undercounts a windowed restore).
fn parse_replay_complete_total_turns(line: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()
        .as_ref()
        .and_then(|v| v.get("totalTurns"))
        .and_then(|t| t.as_i64())
}

/// Re-stamp a `replay_complete` line's `totalTurns` with the engine count
/// (the single authority, [P08]/[Q01]). Parses the frame, overwrites the
/// `totalTurns` field, and re-serializes. In the healthy case the wire value
/// already equals the engine, so this is a faithful round-trip; on a
/// mismatch (a logged contract breach) it makes the engine value win on the
/// wire so the window indices stay coherent with the count. Falls back to the
/// original bytes if the line does not parse as a JSON object.
fn stamp_replay_complete_total_turns(line: &str, engine_total: i64) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return line.as_bytes().to_vec();
    };
    let Some(obj) = value.as_object_mut() else {
        return line.as_bytes().to_vec();
    };
    obj.insert(
        "totalTurns".to_string(),
        serde_json::Value::from(engine_total),
    );
    match serde_json::to_vec(&value) {
        Ok(bytes) => bytes,
        Err(_) => line.as_bytes().to_vec(),
    }
}

/// Extract the `stale_session_id` field from a `resume_failed` IPC line.
/// Used by the bridge to remove the stale sessions record after a
/// failed `--resume` attempt.
fn parse_resume_failed_id(line: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    value
        .get("stale_session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract the `reason` field from a `resume_failed` IPC line.
/// Used by the bridge to thread the human-readable reason into the
/// `SESSION_STATE = errored { detail }` frame so the card surfaces it.
fn parse_resume_failed_reason(line: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    value
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// A parsed `session_fork` IPC line — tugcode's announcement that a rewind
/// fork was taken, and from where ([P11]).
struct SessionForkAnnouncement {
    parent_session_id: String,
    new_session_id: String,
    fork_point: String,
}

/// Parse a `session_fork` IPC line. All three fields are required: a fork with
/// no parent, no id, or no branch point has no lineage to allocate.
fn parse_session_fork(line: &[u8]) -> Option<SessionForkAnnouncement> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let field = |key: &str| -> Option<String> {
        let s = value.get(key)?.as_str()?.trim();
        (!s.is_empty()).then(|| s.to_owned())
    };
    Some(SessionForkAnnouncement {
        parent_session_id: field("parentSessionId")?,
        new_session_id: field("newSessionId")?,
        fork_point: field("forkPoint")?,
    })
}

/// A parsed `session_stage` IPC line — tugcode's announcement that the
/// server-driven arc rotated a stage onto a fresh session ([P03]).
struct SessionStageAnnouncement {
    parent_session_id: String,
    new_session_id: String,
    stage: String,
    /// The dash the arc is keyed by. Present on every rotation the runner
    /// originates; absent only on a hand-crafted line.
    arc: Option<String>,
    /// The model the stage was rotated with, or `None` for the account
    /// default — which the log spells `-`.
    model: Option<String>,
}

/// Parse a `session_stage` IPC line. Parent, id, and stage are required; a
/// rotation missing any of the three names no lineage edge to stage.
///
/// There is deliberately no fork point to read. A stage copies no history, so
/// it has no branch point, and inventing one would make a rotation look like a
/// rewind to every reader of the provenance columns.
fn parse_session_stage(line: &[u8]) -> Option<SessionStageAnnouncement> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let field = |key: &str| -> Option<String> {
        let s = value.get(key)?.as_str()?.trim();
        (!s.is_empty()).then(|| s.to_owned())
    };
    Some(SessionStageAnnouncement {
        parent_session_id: field("parentSessionId")?,
        new_session_id: field("newSessionId")?,
        stage: field("stage")?,
        arc: field("arc"),
        model: field("model"),
    })
}

/// Extract the `title` field from a `session_title` IPC line — claude's
/// auto-generated `ai-title`, forwarded live by tugcode. Blank titles are
/// treated as absent; there is nothing to record.
fn parse_session_title(line: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let title = value.get("title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// Inline the per-turn telemetry payload onto a replayed
/// `turn_complete` stream-json line. Looks up the frame's `msg_id`
/// against the per-replay-window `HashMap<msg_id, TurnTelemetryRow>`
/// built at `replay_started`; on hit, **overlays only the multi-clock
/// timing fields** from the row onto the frame's existing `telemetry`
/// object, re-serializes. On miss (no persisted row for this turn —
/// pre-persistence-feature historical turns, see plan `#step-20-3-4`
/// "no retroactive backfill" caveat) or on a parse error, returns the
/// line bytes unchanged. The second return value is how many turns
/// were overlaid, which the relay sums per replay window into the
/// `perf.replay_forward` trace.
///
/// Handles BOTH wire shapes a replayed `turn_complete` arrives in: a
/// raw one-frame line, and a `replay_batch` envelope of up to 256
/// inner frames — the shape cold replay actually emits for all but the
/// smallest transcripts. A batch line matches the relay's
/// `"type":"turn_complete"` substring gate (the string is right there
/// in a nested frame) but carries no top-level `msg_id`, so treating
/// it as a single frame silently overlays nothing: every batched turn
/// reaches the client with the zero-timing block and its TIME reads
/// `—`. Same `replay_batch` opacity the attribution intercept unwraps.
///
/// **The JSONL is authoritative for cost and model.** tugcode's replay
/// translator reconstructs each turn's `cost` (and `sessionInitTokens`)
/// from the file's own `message.usage` and attaches it to the
/// `turn_complete.telemetry` before this point. The `turn_telemetry`
/// side-table is the authoritative source only for the timing the JSONL
/// cannot carry (wall/active/ttft). So this overlay writes **only** the
/// timing keys (`wallClockMs … maxStreamGapMs`) and never touches `cost`
/// or `sessionInitTokens` — the JSONL cost survives even when a (possibly
/// stale) side-table row exists. See plan `[P03]` / Risk R02.
///
/// If the line carries no `telemetry` object yet (a legacy turn_complete
/// from a tugcode that predates the cost-on-replay emit), a fresh
/// timing-only object is attached — no cost is invented.
///
/// Field names are camelCase to mirror tugdeck's `TurnTelemetry` (what
/// the reducer's merge reads); the schema rows are snake_case and the
/// conversion happens here at the wire boundary.
fn inject_replay_telemetry(
    line: &[u8],
    telemetry_by_msg_id: &std::collections::HashMap<
        String,
        crate::session_ledger::TurnTelemetryRow,
    >,
) -> (Vec<u8>, usize) {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(line) else {
        return (line.to_vec(), 0);
    };
    let is_batch = value.get("type").and_then(|v| v.as_str()) == Some("replay_batch");
    let injected = if is_batch {
        match value.get_mut("frames") {
            Some(serde_json::Value::Array(frames)) => frames
                .iter_mut()
                .map(|frame| usize::from(inject_turn_timing(frame, telemetry_by_msg_id)))
                .sum(),
            _ => 0,
        }
    } else {
        usize::from(inject_turn_timing(&mut value, telemetry_by_msg_id))
    };
    if injected == 0 {
        return (line.to_vec(), 0);
    }
    (
        serde_json::to_vec(&value).unwrap_or_else(|_| line.to_vec()),
        injected,
    )
}

/// Overlay one `turn_complete` frame's persisted timing keys in place.
/// Returns whether anything was written — the caller re-serializes only
/// on a hit, so a miss forwards the original bytes untouched.
///
/// Non-`turn_complete` frames (a batch carries assistant text, tool
/// calls, everything) are skipped by type, so a frame that merely
/// happens to carry a `msg_id` is never rewritten.
fn inject_turn_timing(
    frame: &mut serde_json::Value,
    telemetry_by_msg_id: &std::collections::HashMap<
        String,
        crate::session_ledger::TurnTelemetryRow,
    >,
) -> bool {
    if frame.get("type").and_then(|v| v.as_str()) != Some("turn_complete") {
        return false;
    }
    let Some(msg_id) = frame.get("msg_id").and_then(|v| v.as_str()) else {
        return false;
    };
    let Some(row) = telemetry_by_msg_id.get(msg_id) else {
        return false;
    };

    // The timing keys this overlay owns — and ONLY these. `cost` /
    // `sessionInitTokens` / `turnEndReason` on the existing object are
    // left untouched (JSONL-authoritative — [P03]).
    let timing = [
        ("wallClockMs", serde_json::json!(row.wall_clock_ms)),
        (
            "awaitingApprovalMs",
            serde_json::json!(row.awaiting_approval_ms),
        ),
        (
            "transportDowntimeMs",
            serde_json::json!(row.transport_downtime_ms),
        ),
        ("activeMs", serde_json::json!(row.active_ms)),
        ("ttftMs", serde_json::json!(row.ttft_ms)),
        ("ttftcMs", serde_json::json!(row.ttftc_ms)),
        ("reconnectCount", serde_json::json!(row.reconnect_count)),
        ("maxStreamGapMs", serde_json::json!(row.max_stream_gap_ms)),
    ];

    let serde_json::Value::Object(obj) = frame else {
        return false;
    };
    // Overlay onto the existing telemetry object (tugcode attached it
    // with the JSONL-authoritative cost); create a timing-only object
    // if the frame is a legacy telemetry-free turn_complete.
    let telemetry = obj
        .entry("telemetry")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !telemetry.is_object() {
        *telemetry = serde_json::Value::Object(serde_json::Map::new());
    }
    if let serde_json::Value::Object(tel) = telemetry {
        for (key, val) in timing {
            tel.insert(key.to_string(), val);
        }
    }
    true
}

/// Merge a `system_metadata` line against the persisted
/// `session_metadata` row, write the merged payload back, and return
/// the merged line for forwarding. Pure pass-through fallback on any
/// failure mode so the wire delivery never depends on persistence
/// success.
///
/// Wall-clock millisecond `captured_at` uses
/// `SystemTime::now()` — purely diagnostic / staleness audits; the
/// merge rule itself does not consult timestamps.
fn merge_and_persist_system_metadata(
    line: &[u8],
    ledger: &crate::session_ledger::SessionLedger,
    claude_session_id: &str,
    tug_session_id: &TugSessionId,
) -> Vec<u8> {
    let Ok(incoming) = serde_json::from_slice::<serde_json::Value>(line) else {
        return line.to_vec();
    };

    let current_payload_bytes = match ledger.get_session_metadata(claude_session_id) {
        Ok(Some(row)) => Some(row.payload),
        Ok(None) => None,
        Err(e) => {
            warn!(
                session = %tug_session_id,
                error = %e,
                "get_session_metadata failed; forwarding system_metadata unmerged",
            );
            return line.to_vec();
        }
    };
    let current_value: Option<serde_json::Value> = current_payload_bytes
        .as_deref()
        .and_then(|bytes| serde_json::from_slice(bytes).ok());

    let merged_map =
        crate::session_metadata_merge::merge_session_metadata(current_value.as_ref(), &incoming);
    if merged_map.is_empty() {
        // The merge refused (malformed incoming non-object). Pass
        // through and let downstream consumers handle the malformed
        // payload — we don't have a better answer.
        return line.to_vec();
    }
    let merged_value = serde_json::Value::Object(merged_map);
    let Ok(merged_bytes) = serde_json::to_vec(&merged_value) else {
        return line.to_vec();
    };

    let captured_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = ledger.record_session_metadata(claude_session_id, &merged_bytes, captured_at) {
        crate::ledger_integrity::health::note_error("sessions", &e);
        warn!(
            session = %tug_session_id,
            error = %e,
            "record_session_metadata failed; forwarding merged payload without persistence",
        );
    }

    merged_bytes
}

/// Extract the user's text from a CODE_INPUT frame's JSON payload, when
/// it is a `user_message`. Returns `None` for any other inbound message
/// shape (interrupt, tool_approval, etc.) so the ledger only sees actual
/// user prompts. The picker uses this snippet to label resume rows.
///
/// Post-Step-5c, `user_message` carries an Anthropic-API `content` array
/// of blocks; the text is the concatenation of every `text` block's
/// `text` field (image blocks contribute nothing). A legacy top-level
/// `text` field is honored as a fallback so pre-5c payloads still
/// produce a snippet during transitional builds.
fn parse_user_message_text(json: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("user_message") {
        return None;
    }
    if let Some(blocks) = value.get("content").and_then(|v| v.as_array()) {
        let (text, _atts) = crate::feeds::payload_inspector::derive_legacy_journal_view(blocks);
        if !text.is_empty() {
            return Some(text);
        }
    }
    value
        .get("text")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell route builds its row inline rather than through `into_row`,
    /// so it is an independent producer and needs its own proof: a declared
    /// path outside the repo records nothing, an in-repo one records
    /// repo-relative. Drives the real `record_cmd_event` against a real
    /// ledger and reads the rows back.
    #[cfg(unix)]
    fn init_git_repo(root: &Path) {
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@t"][..],
            &["config", "user.name", "t"][..],
        ] {
            std::process::Command::new("git")
                .current_dir(root)
                .args(args)
                .status()
                .expect("git");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn record_cmd_event_skips_paths_outside_the_repo() {
        let repo_dir = tempfile::tempdir().expect("tempdir");
        let root = repo_dir.path().canonicalize().expect("canonicalize");
        init_git_repo(&root);
        std::fs::write(root.join("a.rs"), "x").expect("write");

        let away = tempfile::tempdir().expect("tempdir");
        let away_file = away
            .path()
            .canonicalize()
            .expect("canonicalize")
            .join("note.md");
        std::fs::write(&away_file, "x").expect("write");

        let ledger = crate::session_ledger::SessionLedger::open_in_memory().expect("ledger");
        let session = TugSessionId::new("sess");
        let canonical_project_dir = CanonicalPath::from_raw(&root);
        let project_dir = root.to_string_lossy().into_owned();
        let mut cache: Option<CanonicalPath> = None;

        let inside = record_cmd_event(
            &root.join("a.rs"),
            "modified",
            "tu-1",
            None,
            &[],
            1,
            &session,
            &canonical_project_dir,
            &mut cache,
            &project_dir,
            &ledger,
        )
        .await;
        assert_eq!(inside.as_deref(), Some("a.rs"), "in-repo, repo-relative");

        let outside = record_cmd_event(
            &away_file,
            "modified",
            "tu-2",
            None,
            &[],
            2,
            &session,
            &canonical_project_dir,
            &mut cache,
            &project_dir,
            &ledger,
        )
        .await;
        assert!(outside.is_none(), "outside the repo records nothing");

        let rows = ledger
            .file_events_for_project(canonical_project_dir.as_str())
            .expect("read back");
        assert_eq!(rows.len(), 1, "only the in-repo row landed: {rows:?}");
    }

    /// The skip measures a file against its OWN repo, so work in a second
    /// checkout is recorded there — repo-relative, keyed to that root — rather
    /// than discarded for not being under the session's repo.
    #[cfg(unix)]
    #[tokio::test]
    async fn record_exact_pending_homes_a_file_in_another_repo() {
        let session_dir = tempfile::tempdir().expect("tempdir");
        let session_root = session_dir.path().canonicalize().expect("canonicalize");
        init_git_repo(&session_root);

        let other_dir = tempfile::tempdir().expect("tempdir");
        let other_root = other_dir.path().canonicalize().expect("canonicalize");
        init_git_repo(&other_root);
        std::fs::create_dir(other_root.join("src")).expect("mkdir");
        std::fs::write(other_root.join("src/b.rs"), "x").expect("write");

        let ledger = crate::session_ledger::SessionLedger::open_in_memory().expect("ledger");
        let session = TugSessionId::new("sess");
        let canonical_project_dir = CanonicalPath::from_raw(&session_root);
        let project_dir = session_root.to_string_lossy().into_owned();
        let mut cache: Option<CanonicalPath> = None;

        let pending = crate::feeds::attribution::PendingCall {
            tool_name: "Write".to_owned(),
            file_path: other_root.join("src/b.rs").to_string_lossy().into_owned(),
            op: "write",
            parent_tool_use_id: None,
            timestamp: None,
            spans: Vec::new(),
        };
        let recorded = record_exact_pending(
            pending,
            "tu-1",
            None,
            "exact",
            false,
            &session,
            &canonical_project_dir,
            &mut cache,
            &project_dir,
            &ledger,
        )
        .await;
        assert_eq!(recorded.as_deref(), Some("src/b.rs"));

        let other_canonical = CanonicalPath::from_raw(&other_root);
        assert_eq!(
            ledger
                .file_events_for_project(other_canonical.as_str())
                .expect("read back")
                .len(),
            1,
            "the row is keyed to the other repo's root"
        );
        assert!(
            ledger
                .file_events_for_project(canonical_project_dir.as_str())
                .expect("read back")
                .is_empty(),
            "and not to the session's"
        );
    }

    /// Spans ride the row they belong to, through the same write — an Edit's
    /// anchors are in the ledger the moment its row is, keyed to that row.
    #[tokio::test]
    async fn record_exact_pending_writes_the_calls_spans_with_its_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        init_git_repo(&root);
        std::fs::write(root.join("a.rs"), "x").expect("write");

        let ledger = crate::session_ledger::SessionLedger::open_in_memory().expect("ledger");
        let session = TugSessionId::new("sess");
        let canonical_project_dir = CanonicalPath::from_raw(&root);
        let project_dir = root.to_string_lossy().into_owned();
        let mut cache: Option<CanonicalPath> = None;

        let input = serde_json::json!({
            "file_path": root.join("a.rs").to_string_lossy(),
            "old_string": "x",
            "new_string": "y",
        });
        let pending = crate::feeds::attribution::PendingCall {
            tool_name: "Edit".to_owned(),
            file_path: root.join("a.rs").to_string_lossy().into_owned(),
            op: "edit",
            parent_tool_use_id: None,
            timestamp: None,
            spans: spans_for_tool_input("Edit", &input),
        };
        let recorded = record_exact_pending(
            pending,
            "tu-1",
            None,
            "exact",
            false,
            &session,
            &canonical_project_dir,
            &mut cache,
            &project_dir,
            &ledger,
        )
        .await;
        assert_eq!(recorded.as_deref(), Some("a.rs"));

        let spans = ledger
            .file_event_spans_for_paths(canonical_project_dir.as_str(), &["a.rs".to_owned()])
            .expect("read back spans");
        assert_eq!(spans.len(), 1, "the Edit's anchor landed: {spans:?}");
        assert_eq!(spans[0].tug_session_id, "sess");
        assert_eq!(spans[0].span.kind, "replace");
    }

    /// A session opened on a non-repo dir caches `None` and re-probes; once a
    /// repo appears (a mid-session `git init`), the next probe finds it and
    /// the cache goes sticky — the projection self-heals for the "Initialize
    /// git" flow.
    #[cfg(unix)]
    #[tokio::test]
    async fn repo_root_reprobes_after_git_init() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().canonicalize().expect("canonicalize");
        let mut cache: Option<CanonicalPath> = None;

        assert!(
            ensure_repo_root(&mut cache, dir.to_str().unwrap())
                .await
                .is_none(),
            "non-repo dir resolves no root"
        );
        assert!(
            cache.is_none(),
            "cache stays None so the next event re-probes"
        );

        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-q"])
            .output()
            .expect("git init");

        let root = ensure_repo_root(&mut cache, dir.to_str().unwrap()).await;
        assert!(
            root.is_some(),
            "re-probe finds the repo that appeared mid-session"
        );
        assert!(cache.is_some(), "cache is now sticky");
    }

    // ---- relay attribution intercept harness ([P03]–[P06]) -----------

    /// Forwarded frame captured off the merger channel.
    struct ForwardedFrame {
        payload: Vec<u8>,
    }

    /// Drive the real [`relay_session_io`] over a scripted tugcode stdout:
    /// a `protocol_ack`, then each line in `frames`, then EOF. Returns the
    /// frames forwarded to the merger (post-splice, exactly what the card
    /// would see). Attribution is a pure side effect against `ledger`, so
    /// the returned frames also prove the intercept never mutates delivery.
    async fn drive_relay(
        ledger: Arc<crate::session_ledger::SessionLedger>,
        tug_id: &str,
        project_dir: &str,
        frames: &[&str],
    ) -> Vec<ForwardedFrame> {
        drive_relay_with_ink(ledger, InkLedgers::default(), tug_id, project_dir, frames).await
    }

    /// `drive_relay`, with the durable ink ledgers wired in — what the fork
    /// arc's transfer needs to be observable.
    async fn drive_relay_with_ink(
        ledger: Arc<crate::session_ledger::SessionLedger>,
        ink: InkLedgers,
        tug_id: &str,
        project_dir: &str,
        frames: &[&str],
    ) -> Vec<ForwardedFrame> {
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;

        let tug_session_id = TugSessionId::new(tug_id.to_string());
        let ledger_entry = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_session_id.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));

        let (_input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        let (merger_tx, mut merger_rx) = mpsc::channel::<Frame>(256);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();

        // tugcode stdin: the relay writes `protocol_init` here; we hold the
        // read end only so the small write never blocks (never read).
        let (relay_stdin_w, _tugcode_stdin_r) = tokio::io::duplex(64 * 1024);
        // tugcode stdout: the relay reads; we script the bytes.
        let (relay_stdout_r, mut feed_w) = tokio::io::duplex(256 * 1024);
        let reader: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r);
        let lines = BufReader::new(reader).lines();

        let project_dir_owned = project_dir.to_string();
        let ledger_for_relay = ledger.clone();
        let relay = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_session_id,
                &ledger_entry,
                &mut input_rx,
                &merger_tx,
                &state_tx,
                None,
                Box::new(relay_stdin_w),
                lines,
                &project_dir_owned,
                &recorder,
                Some(ledger_for_relay.as_ref()),
                &ink,
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel,
            )
            .await
        });

        // Script the stdout: handshake ack, the frames, then EOF (drop).
        feed_w
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .expect("write ack");
        for f in frames {
            feed_w.write_all(f.as_bytes()).await.expect("write frame");
            feed_w.write_all(b"\n").await.expect("write newline");
        }
        drop(feed_w);

        // Relay ends on EOF; then drain everything it forwarded.
        let _ = relay.await.expect("relay task");
        let mut out = Vec::new();
        while let Ok(frame) = merger_rx.try_recv() {
            out.push(ForwardedFrame {
                payload: frame.payload,
            });
        }
        out
    }

    // ---- the fork carries its line of work's durable ink ([D154]) ----------

    /// Drive a rewind-fork through the real relay: tugcode announces the fork,
    /// then the forked session's `session_init` consumes the staged identity.
    /// Returns the two ink ledgers so the caller can read where the rows sat
    /// afterwards.
    async fn drive_fork(
        parent: &str,
        fork: &str,
        seed_ink: impl Fn(&crate::shell_ledger::ShellLedger, &crate::refs_ledger::RefsLedger),
    ) -> InkLedgers {
        let sessions =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("sessions"));
        for id in [parent, fork] {
            sessions
                .record_spawn(id, "ws-test", "/proj", "card-1", 1, None)
                .expect("spawn");
        }
        let shell =
            Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
        let refs = Arc::new(crate::refs_ledger::RefsLedger::open_in_memory().expect("refs ledger"));
        seed_ink(&shell, &refs);
        let ink = InkLedgers {
            shell: Some(Arc::clone(&shell)),
            refs: Some(Arc::clone(&refs)),
        };

        let announcement = format!(
            r#"{{"type":"session_fork","parentSessionId":"{parent}","newSessionId":"{fork}","forkPoint":"prompt-uuid"}}"#
        );
        let init = format!(r#"{{"type":"session_init","session_id":"{fork}"}}"#);
        drive_relay_with_ink(
            Arc::clone(&sessions),
            ink.clone(),
            parent,
            "/proj",
            &[&announcement, &init],
        )
        .await;
        ink
    }

    /// Drive an arc stage rotation through the real relay: tugcode announces
    /// the stage, then the stage session's `session_init` consumes the staged
    /// identity. The mirror of [`drive_fork`], built from the same parts so the
    /// two can be compared: a stage records a provenance edge with no branch
    /// point and takes nothing from its parent.
    async fn drive_stage(
        parent: &str,
        stage_session: &str,
        stage: &str,
        seed_ink: impl Fn(&crate::shell_ledger::ShellLedger, &crate::refs_ledger::RefsLedger),
    ) -> (Arc<crate::session_ledger::SessionLedger>, InkLedgers) {
        let sessions =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("sessions"));
        for id in [parent, stage_session] {
            sessions
                .record_spawn(id, "ws-test", "/proj", "card-1", 1, None)
                .expect("spawn");
        }
        let shell =
            Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
        let refs = Arc::new(crate::refs_ledger::RefsLedger::open_in_memory().expect("refs ledger"));
        seed_ink(&shell, &refs);
        let ink = InkLedgers {
            shell: Some(Arc::clone(&shell)),
            refs: Some(Arc::clone(&refs)),
        };

        let announcement = format!(
            r#"{{"type":"session_stage","parentSessionId":"{parent}","newSessionId":"{stage_session}","stage":"{stage}","model":"","document":"dash/brief.md","arc":"some-dash","ipc_version":2}}"#
        );
        let init = format!(r#"{{"type":"session_init","session_id":"{stage_session}"}}"#);
        drive_relay_with_ink(
            Arc::clone(&sessions),
            ink.clone(),
            parent,
            "/proj",
            &[&announcement, &init],
        )
        .await;
        (sessions, ink)
    }

    #[tokio::test]
    async fn a_stage_leaves_the_conversation_as_its_own_head() {
        // A rotation is not a fork: the conversation goes on being used
        // after the arc, so its id must keep resolving to itself, and the
        // stage descends from it with no branch point.
        let (sessions, _) = drive_stage("conversation", "stage-1", "devise", |_, _| {}).await;
        assert_eq!(
            sessions.resolve_to_lineage_head("conversation"),
            "conversation",
            "the conversation is not superseded by the stage it rotated into"
        );
        assert_eq!(
            sessions.rotation_children().unwrap().len(),
            1,
            "the rotation edge is recorded, with no fork point"
        );
    }

    #[tokio::test]
    async fn a_stage_leaves_the_conversations_durable_ink_where_it_was() {
        // Receipts written before the rotation belong to the session that
        // wrote them, which is the session the user returns to.
        let (_sessions, ink) =
            drive_stage("p-ink-stage", "s-ink-stage", "implement", |shell, _| {
                shell
                    .record_exchange(&shell_row("p-ink-stage", "/commit"))
                    .expect("record");
            })
            .await;

        assert_eq!(
            ink.shell
                .expect("shell ledger")
                .session_ids_with_rows()
                .unwrap(),
            std::collections::HashSet::from(["p-ink-stage".to_string()]),
            "the conversation's receipts stay with the conversation"
        );
    }

    #[tokio::test]
    async fn a_stage_line_missing_a_required_field_stages_nothing() {
        assert!(
            parse_session_stage(br#"{"type":"session_stage","newSessionId":"n","stage":"devise"}"#)
                .is_none()
        );
        assert!(parse_session_stage(
            br#"{"type":"session_stage","parentSessionId":"p","newSessionId":"","stage":"devise"}"#
        )
        .is_none());
        assert!(
            parse_session_stage(
                br#"{"type":"session_stage","parentSessionId":"p","newSessionId":"n"}"#
            )
            .is_none()
        );
        let parsed = parse_session_stage(
            br#"{"type":"session_stage","parentSessionId":"p","newSessionId":"n","stage":"review"}"#,
        )
        .expect("parses");
        assert_eq!(parsed.parent_session_id, "p");
        assert_eq!(parsed.new_session_id, "n");
        assert_eq!(parsed.stage, "review");
        // A rotation with no score behind it names no arc and no document,
        // and that absence is what keeps `arc-stage` unwritten: the write is
        // guarded on an arc name *and* a parsable stage, so a `None` here
        // cannot reach the dash-log at all.
        assert!(parsed.arc.is_none());
        assert!(
            ArcStage::parse(&parsed.stage).is_some(),
            "the label still parses; it is the missing arc that stops the write"
        );
    }

    fn shell_row(session: &str, command: &str) -> crate::shell_ledger::NewShellExchange {
        crate::shell_ledger::NewShellExchange {
            tug_session_id: session.to_string(),
            command: command.to_string(),
            output: "out\n".to_string(),
            exit_code: Some(0),
            cwd: "/proj".to_string(),
            cwd_after: None,
            started_at_ms: 1,
            settled_at_ms: 2,
            anchor_msg_id: None,
        }
    }

    #[tokio::test]
    async fn a_fork_carries_the_parents_durable_ink_across() {
        let ink = drive_fork("parent-ink", "fork-ink", |shell, refs| {
            for command in ["ls", "/commit"] {
                shell
                    .record_exchange(&shell_row("parent-ink", command))
                    .expect("record");
            }
            refs.record_run(&crate::refs_ledger::NewRefsRun {
                tug_session_id: "parent-ink".to_string(),
                run_id: "run-1".to_string(),
                op_kind: "match".to_string(),
                command: "/match foo".to_string(),
                refs: Vec::new(),
                settled_at_ms: 10,
                anchor_msg_id: None,
            })
            .expect("record run");
        })
        .await;

        let shell = ink.shell.expect("shell ledger");
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            std::collections::HashSet::from(["fork-ink".to_string()]),
            "the parent's receipts moved to the line's head"
        );
        assert_eq!(
            shell.list_exchanges_since("fork-ink", None).unwrap().len(),
            2
        );
        let refs = ink.refs.expect("refs ledger");
        assert_eq!(refs.list_refs("parent-ink").unwrap(), None);
        assert_eq!(refs.list_refs("fork-ink").unwrap().unwrap().run_id, "run-1");
    }

    #[tokio::test]
    async fn a_fork_of_an_inkless_parent_transfers_nothing() {
        let ink = drive_fork("parent-bare", "fork-bare", |_, _| {}).await;
        assert!(
            ink.shell
                .expect("shell ledger")
                .session_ids_with_rows()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            ink.refs
                .expect("refs ledger")
                .list_refs("fork-bare")
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_fork_transfers_each_ledger_independently() {
        // The two ink stores are separate sqlite files with no shared
        // transaction, so a relay wired with only one of them must still move
        // what it has.
        let sessions =
            Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("sessions"));
        for id in ["parent-solo", "fork-solo"] {
            sessions
                .record_spawn(id, "ws-test", "/proj", "card-1", 1, None)
                .expect("spawn");
        }
        let shell =
            Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
        shell
            .record_exchange(&shell_row("parent-solo", "/dash-join"))
            .expect("record");
        let ink = InkLedgers {
            shell: Some(Arc::clone(&shell)),
            refs: None,
        };

        drive_relay_with_ink(
            sessions,
            ink,
            "parent-solo",
            "/proj",
            &[
                r#"{"type":"session_fork","parentSessionId":"parent-solo","newSessionId":"fork-solo","forkPoint":"prompt-uuid"}"#,
                r#"{"type":"session_init","session_id":"fork-solo"}"#,
            ],
        )
        .await;

        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            std::collections::HashSet::from(["fork-solo".to_string()]),
        );
    }

    // ---- the facts library, driven through the real relay ([P06], [P07]) ----

    /// The map holds calls awaiting a result, and a settled call leaves a dead
    /// id behind. Nothing evicts in a relay whose pairs all close, so without
    /// compaction a day-long session would carry one dead id per Bash command
    /// for as long as tugcast runs.
    #[test]
    fn the_shell_fact_map_forgets_settled_calls_rather_than_growing_forever() {
        let mut pending = PendingShellFacts::new();
        for i in 0..(PENDING_SHELL_FACTS_CAP * 4) {
            let id = format!("tu-{i}");
            pending.insert(
                id.clone(),
                PendingShellFact {
                    command: "cargo nextest run".to_string(),
                    at_ms: 1_700_000_000_000,
                },
            );
            assert!(pending.take(&id).is_some(), "the pair settled");
        }
        assert!(pending.map.is_empty(), "nothing is still in flight");
        assert!(
            pending.order.len() <= PENDING_SHELL_FACTS_CAP * 2,
            "dead ids are dropped: {}",
            pending.order.len()
        );
    }

    /// Every fact the relay recorded, as `(kind, subject, text)` in id order.
    fn relay_facts(ledger: &crate::session_ledger::SessionLedger) -> Vec<(String, String, String)> {
        ledger.facts_for_test()
    }

    /// The regression pin for [P06]. `cargo nextest run` names no file, so
    /// `declared_ops_for_command` refuses it and it never enters `pending_cmds`
    /// — and it opens no bracket outside a repo. A shell-fact recorder hooked
    /// to either of those maps produces nothing here, which is exactly the
    /// silent hole this test exists to catch: the entire `test_run` source is
    /// commands of this shape.
    #[tokio::test]
    async fn a_test_run_command_no_attribution_map_admits_still_records_both_facts() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-1","input":{"command":"cd tugrust && cargo nextest run"},"timestamp":1700000000000}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"     Summary [  12.5s] 1539 tests run: 1539 passed, 5 skipped","is_error":false}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let facts = relay_facts(&ledger);
        assert_eq!(facts.len(), 2, "a shell fact and its test_run: {facts:?}");
        assert_eq!(facts[0].0, "shell");
        assert_eq!(facts[0].2, "$ cd tugrust && cargo nextest run → ok");
        assert_eq!(facts[1].0, "test_run");
        assert_eq!(
            facts[1].2,
            "tests: cargo nextest — passed (1539 passed, 0 failed)"
        );
        // No file event: the command names no file, which is the whole point.
        assert!(ledger.file_events_for_session("tug-1").unwrap().is_empty());
    }

    /// The verdict is read from the runner's summary, never from the tool
    /// call's success — a red suite is a perfectly successful Bash call.
    #[tokio::test]
    async fn a_failing_suite_records_a_failed_verdict_beside_a_successful_call() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-1","input":{"command":"cargo nextest run"},"timestamp":1700000000000}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"     Summary [ 0.3s] 10 tests run: 8 passed, 2 failed, 0 skipped","is_error":false}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let facts = relay_facts(&ledger);
        assert!(facts[0].2.ends_with("→ ok"), "the call itself succeeded");
        assert_eq!(
            facts[1].2,
            "tests: cargo nextest — failed (8 passed, 2 failed)"
        );
    }

    /// A recognized runner is a second fact; anything else is a shell fact
    /// and nothing more.
    #[tokio::test]
    async fn a_build_records_a_shell_fact_and_no_test_run() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-1","input":{"command":"cargo build"},"timestamp":1700000000000}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"    Finished in 3s","is_error":true}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let facts = relay_facts(&ledger);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].0, "shell");
        assert_eq!(facts[0].2, "$ cargo build → err", "is_error reached `ok`");
    }

    /// A `just app-test` run is read off the recipe's `VERDICT:` line.
    #[tokio::test]
    async fn an_app_test_verdict_line_records_a_test_run() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-1","input":{"command":"just app-test at0287.test.ts"},"timestamp":1700000000000}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"VERDICT: PASS  (1/1 files green; 7/7 tests passed)","is_error":false}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let facts = relay_facts(&ledger);
        assert_eq!(facts[1].0, "test_run");
        assert_eq!(
            facts[1].2,
            "tests: just app-test — passed (7 passed, 0 failed)"
        );
    }

    /// The relay re-streams replayed frames on every resume. Back-fill is
    /// desirable — a resumed session's pre-tugcast history becomes facts —
    /// and the dedupe key is what makes it safe to do twice.
    #[tokio::test]
    async fn a_replayed_bash_batch_driven_twice_records_one_shell_fact() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-r1","input":{"command":"cargo nextest run"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-r1","output":"     Summary [ 1.0s] 3 tests run: 3 passed, 0 skipped","is_error":false}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[batch]).await;
        assert_eq!(relay_facts(&ledger).len(), 2, "shell + test_run");

        drive_relay(ledger.clone(), "tug-1", "/proj", &[batch]).await;
        let facts = relay_facts(&ledger);
        assert_eq!(facts.len(), 2, "the resume added nothing: {facts:?}");
    }

    /// A compaction boundary, live and inside a replay batch, and idempotent
    /// across the resume that re-streams it.
    #[tokio::test]
    async fn a_compaction_boundary_records_once_however_often_it_is_replayed() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"compact_boundary","trigger":"auto","pre_tokens":140000,"timestamp":1753460000000}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[batch]).await;
        drive_relay(ledger.clone(), "tug-1", "/proj", &[batch]).await;

        let facts = relay_facts(&ledger);
        assert_eq!(facts.len(), 1, "one row across two replays: {facts:?}");
        assert_eq!(facts[0].0, "session.compacted");
        // No `post_tokens` on the wire, so the rendering says what it has.
        assert_eq!(facts[0].2, "context compacted (auto): from 140000 tokens");
    }

    #[tokio::test]
    async fn attribution_records_one_row_for_write_and_forwards_frames_unchanged() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Write","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs","content":"x"}}"#;
        let tool_result =
            r#"{"type":"tool_result","tool_use_id":"tu-1","output":"ok","is_error":false}"#;

        let forwarded =
            drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let rows = ledger.file_events_for_session("tug-1").unwrap();
        assert_eq!(rows.len(), 1, "one exact event recorded");
        assert_eq!(rows[0].file_path, "/proj/a.rs");
        assert_eq!(rows[0].tool_name, "Write");
        assert_eq!(rows[0].op, "write");
        assert_eq!(rows[0].origin, "exact");
        assert_eq!(rows[0].project_dir, "/proj");

        // The intercept is side-effect only: each frame is forwarded exactly
        // as the splice path would emit it without attribution.
        assert_eq!(forwarded.len(), 2);
        assert_eq!(
            forwarded[0].payload,
            splice_tug_session_id(tool_use.as_bytes(), "tug-1")
        );
        assert_eq!(
            forwarded[1].payload,
            splice_tug_session_id(tool_result.as_bytes(), "tug-1")
        );
    }

    /// Regression pin for the 2026-07-25 capture blackout, half one:
    /// tugcode's replay path flushes committed-turn content as ONE
    /// `replay_batch` wire line of up to 256 inner frames. The line-oriented
    /// intercept used to match the `tool_use` substring, fail the flat
    /// parse, and silently skip — so the replay backfill (the doctrine's
    /// healing layer for missed live capture) recorded nothing, ever. The
    /// relay must unwrap the envelope and record each inner exact pair with
    /// `origin='replay'` at its historical timestamp.
    #[tokio::test]
    async fn attribution_unwraps_replay_batch_and_backfills_exact_rows() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"assistant_text","text":"editing now"},{"type":"tool_use","tool_name":"Edit","tool_use_id":"tu-b1","input":{"file_path":"/proj/b.rs"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-b1","output":"ok","is_error":false,"timestamp":1753460000500}],"ipc_version":2}"#;

        let forwarded = drive_relay(ledger.clone(), "tug-2", "/proj", &[batch]).await;

        let rows = ledger.file_events_for_session("tug-2").unwrap();
        assert_eq!(rows.len(), 1, "batched exact pair backfills one row");
        assert_eq!(rows[0].file_path, "/proj/b.rs");
        assert_eq!(rows[0].op, "edit");
        assert_eq!(rows[0].origin, "replay");
        assert_eq!(
            rows[0].at, 1753460000000,
            "backfilled row keeps the historical frame time"
        );

        // The envelope forwards unchanged — unwrapping is capture-only.
        assert_eq!(forwarded.len(), 1);
        assert_eq!(
            forwarded[0].payload,
            splice_tug_session_id(batch.as_bytes(), "tug-2")
        );
    }

    #[tokio::test]
    async fn replayed_bash_commands_backfill_cmd_rows_at_historical_times() {
        // The fingerprint is gone (G1) but the command text replays, and what
        // it literally named is proof on its own.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-rm","input":{"command":"rm a.rs"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-rm","output":"","is_error":false,"timestamp":1753460000500}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-replay-rm", "/proj", &[batch]).await;

        let rows = ledger.file_events_for_session("tug-replay-rm").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, "/proj/a.rs");
        assert_eq!(rows[0].op, "deleted");
        assert_eq!(rows[0].origin, "cmd");
        assert_eq!(rows[0].tool_name, "Bash");
        assert_eq!(
            rows[0].at, 1753460000000,
            "a backfilled row keeps its historical frame time"
        );

        // Re-streaming the same batch converges under the PK.
        drive_relay(ledger.clone(), "tug-replay-rm", "/proj", &[batch]).await;
        assert_eq!(
            ledger
                .file_events_for_session("tug-replay-rm")
                .unwrap()
                .len(),
            1,
            "a re-streamed batch does not duplicate"
        );
    }

    #[tokio::test]
    async fn a_replayed_rename_backfills_both_names() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-mv","input":{"command":"git mv old.rs new.rs"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-mv","output":"","is_error":false,"timestamp":1753460000500}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-replay-mv", "/proj", &[batch]).await;

        let rows = ledger.file_events_for_session("tug-replay-mv").unwrap();
        let paths: std::collections::HashSet<&str> =
            rows.iter().map(|r| r.file_path.as_str()).collect();
        assert!(paths.contains("/proj/new.rs"));
        assert!(paths.contains("/proj/old.rs"));
        for r in &rows {
            assert_eq!(r.op, "renamed");
            assert_eq!(r.origin, "cmd");
            assert_eq!(r.tool_use_id, "tu-mv", "both names are one operation");
        }
    }

    #[tokio::test]
    async fn a_replayed_restore_backfills_nothing_but_its_siblings_still_mint() {
        // `git checkout <rev> -- <path>` writes the repository's recorded
        // bytes; the session authored none of them. The `git mv` on the same
        // line still names files this session did author.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-mix","input":{"command":"git mv old.rs new.rs && git checkout 69ed16c -- restored.rs"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-mix","output":"","is_error":false,"timestamp":1753460000500}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-replay-restore", "/proj", &[batch]).await;

        let rows = ledger
            .file_events_for_session("tug-replay-restore")
            .unwrap();
        let paths: std::collections::HashSet<&str> =
            rows.iter().map(|r| r.file_path.as_str()).collect();
        assert_eq!(
            paths,
            ["/proj/new.rs", "/proj/old.rs"].into_iter().collect(),
            "the move's two names mint; the restored path does not"
        );
    }

    #[tokio::test]
    async fn a_failed_replayed_command_backfills_nothing() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-bad","input":{"command":"rm a.rs"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-bad","output":"No such file","is_error":true,"timestamp":1753460000500}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-replay-bad", "/proj", &[batch]).await;

        assert!(
            ledger
                .file_events_for_session("tug-replay-bad")
                .unwrap()
                .is_empty(),
            "intent without a successful outcome is not proof"
        );
    }

    #[tokio::test]
    async fn an_unreadable_replayed_command_backfills_nothing() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let batch = r#"{"type":"replay_batch","frames":[{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-glob","input":{"command":"rm -rf apptest-*"},"timestamp":1753460000000},{"type":"tool_result","tool_use_id":"tu-glob","output":"","is_error":false,"timestamp":1753460000500}],"ipc_version":2}"#;

        drive_relay(ledger.clone(), "tug-replay-glob", "/proj", &[batch]).await;

        assert!(
            ledger
                .file_events_for_session("tug-replay-glob")
                .unwrap()
                .is_empty(),
            "a glob operand names nothing the grammar can prove"
        );
    }

    /// Regression pin, half two: a `tool_result` whose structured `output`
    /// OBJECT embeds a raw `"type":"tool_use"` member (string payloads
    /// escape their quotes; nested objects do not) used to be routed down
    /// the substring-matched `tool_use` arm, fail the flat parse, and never
    /// resolve — the pending call leaked and the edit went unrecorded. The
    /// parse, not the substring, must decide which arm handles the line.
    #[tokio::test]
    async fn attribution_resolves_tool_result_that_embeds_tool_use_literal() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Edit","tool_use_id":"tu-e1","input":{"file_path":"/proj/agent_bridge.rs"}}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-e1","output":{"type":"tool_use","note":"structured echo"},"is_error":false}"#;
        assert!(
            tool_result.contains("\"type\":\"tool_use\""),
            "fixture embeds the raw literal the pre-filter matches on"
        );

        drive_relay(ledger.clone(), "tug-3", "/proj", &[tool_use, tool_result]).await;

        let rows = ledger.file_events_for_session("tug-3").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "embedded literal does not derail the resolve"
        );
        assert_eq!(rows[0].file_path, "/proj/agent_bridge.rs");
        assert_eq!(rows[0].origin, "exact");
    }

    #[tokio::test]
    async fn attribution_drops_errored_tool_result() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Edit","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs"}}"#;
        let errored = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"old_string not found","is_error":true}"#;

        let forwarded = drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, errored]).await;

        assert!(
            ledger.file_events_for_session("tug-1").unwrap().is_empty(),
            "an errored exact call records nothing"
        );
        // Still forwarded byte-for-byte (post-splice).
        assert_eq!(forwarded.len(), 2);
        assert_eq!(
            forwarded[1].payload,
            splice_tug_session_id(errored.as_bytes(), "tug-1")
        );
    }

    #[tokio::test]
    async fn attribution_ignores_bash_in_this_step() {
        // Bash is bracketed in the next step; the exact intercept must not
        // record anything for it (no file_path on the input, no exact op).
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-1","input":{"command":"sed -i s/a/b/ x"}}"#;
        let tool_result =
            r#"{"type":"tool_result","tool_use_id":"tu-1","output":"","is_error":false}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        assert!(ledger.file_events_for_session("tug-1").unwrap().is_empty());
    }

    #[tokio::test]
    async fn attribution_replay_backfills_historical_time_idempotently() {
        // Replay-bracketed frames (between replay_started / replay_complete)
        // carry `timestamp` and backfill rows with `origin='replay'` at that
        // historical `at`. Replaying the same history twice leaves the row
        // count and the row unchanged (PK upsert, #replay-idempotency).
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let replay_started = r#"{"type":"replay_started"}"#;
        let tool_use = r#"{"type":"tool_use","tool_name":"Write","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs"},"timestamp":1700000000123}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-1","output":"ok","is_error":false,"timestamp":1700000000456}"#;
        let replay_complete = r#"{"type":"replay_complete"}"#;
        let script = &[replay_started, tool_use, tool_result, replay_complete];

        drive_relay(ledger.clone(), "tug-1", "/proj", script).await;
        let after_first = ledger.file_events_for_session("tug-1").unwrap();
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].origin, "replay");
        assert_eq!(
            after_first[0].at, 1_700_000_000_123,
            "replay row keeps the tool_use timestamp as `at`"
        );

        // Resume again: same history re-streamed, no new/changed rows.
        drive_relay(ledger.clone(), "tug-1", "/proj", script).await;
        let after_second = ledger.file_events_for_session("tug-1").unwrap();
        assert_eq!(after_second, after_first, "replay is idempotent");
    }

    #[tokio::test]
    async fn a_receipt_in_the_output_mints_rows_without_any_delta() {
        // The glob path: the verb expanded what the grammar refused and says
        // which files it touched. No bracket, no fingerprint — the receipt is
        // the evidence.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let receipt = r#"TUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"deleted\",\"path\":\"/proj/gone.rs\"},{\"op\":\"renamed\",\"path\":\"/proj/new.rs\",\"orig_path\":\"/proj/old.rs\"}]}"#;
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-verb","input":{"command":"tugutil file rm 'x*'"}}"#;
        let tool_result = format!(
            r#"{{"type":"tool_result","tool_use_id":"tu-verb","output":"{receipt}","is_error":false}}"#
        );

        drive_relay(
            ledger.clone(),
            "tug-receipt",
            "/proj",
            &[tool_use, &tool_result],
        )
        .await;

        let rows = ledger.file_events_for_session("tug-receipt").unwrap();
        let by_path: std::collections::HashMap<&str, (&str, &str)> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), (r.op.as_str(), r.origin.as_str())))
            .collect();
        assert_eq!(by_path.get("/proj/gone.rs"), Some(&("deleted", "cmd")));
        assert_eq!(by_path.get("/proj/new.rs"), Some(&("renamed", "cmd")));
        assert_eq!(
            by_path.get("/proj/old.rs"),
            Some(&("renamed", "cmd")),
            "a receipt rename names both ends"
        );
        assert!(rows.iter().all(|r| r.tool_use_id == "tu-verb"));
    }

    #[tokio::test]
    async fn a_receipt_on_a_failed_result_mints_nothing() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let receipt =
            r#"TUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"deleted\",\"path\":\"/proj/gone.rs\"}]}"#;
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-fail","input":{"command":"tugutil file rm 'x*'"}}"#;
        let tool_result = format!(
            r#"{{"type":"tool_result","tool_use_id":"tu-fail","output":"{receipt}","is_error":true}}"#
        );

        drive_relay(
            ledger.clone(),
            "tug-receipt-fail",
            "/proj",
            &[tool_use, &tool_result],
        )
        .await;

        assert!(
            ledger
                .file_events_for_session("tug-receipt-fail")
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_malformed_receipt_mints_nothing() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-bad","input":{"command":"tugutil file rm 'x*'"}}"#;
        let tool_result = r#"{"type":"tool_result","tool_use_id":"tu-bad","output":"TUG-FILE-RECEIPT: {not json","is_error":false}"#;

        drive_relay(
            ledger.clone(),
            "tug-receipt-bad",
            "/proj",
            &[tool_use, tool_result],
        )
        .await;

        assert!(
            ledger
                .file_events_for_session("tug-receipt-bad")
                .unwrap()
                .is_empty(),
            "a receipt that cannot be read attributes nothing (and warns)"
        );
    }

    #[tokio::test]
    async fn a_flat_replayed_bash_frame_backfills_a_cmd_row() {
        // The same backfill on the unbatched replay path: frames arriving one
        // per line inside a replay bracket, where no Bash bracket ever opens.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let script = &[
            r#"{"type":"replay_started"}"#,
            r#"{"type":"tool_use","tool_name":"Bash","tool_use_id":"tu-rm","input":{"command":"rm doomed.rs"},"timestamp":1700000000123}"#,
            r#"{"type":"tool_result","tool_use_id":"tu-rm","output":"","is_error":false,"timestamp":1700000000456}"#,
            r#"{"type":"replay_complete"}"#,
        ];

        drive_relay(ledger.clone(), "tug-flat", "/proj", script).await;

        let rows = ledger.file_events_for_session("tug-flat").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, "/proj/doomed.rs");
        assert_eq!(rows[0].origin, "cmd");
        assert_eq!(rows[0].op, "deleted");
        assert_eq!(rows[0].at, 1_700_000_000_123);
    }

    #[tokio::test]
    async fn attribution_records_subagent_parent_id() {
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Write","tool_use_id":"tu-child","input":{"file_path":"/proj/sub.rs"},"parent_tool_use_id":"agent-1"}"#;
        let tool_result =
            r#"{"type":"tool_result","tool_use_id":"tu-child","output":"ok","is_error":false}"#;

        drive_relay(ledger.clone(), "tug-1", "/proj", &[tool_use, tool_result]).await;

        let rows = ledger.file_events_for_session("tug-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].parent_tool_use_id.as_deref(), Some("agent-1"));
    }

    #[tokio::test]
    async fn attribution_pending_map_survives_turn_boundary() {
        // A background agent's child tool_use can arrive before a
        // turn_complete with its tool_result after (subagent-tail
        // re-emission). The pending map is NOT cleared on turn_complete, so
        // the straddling pair still records.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tool_use = r#"{"type":"tool_use","tool_name":"Write","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs"},"parent_tool_use_id":"agent-1"}"#;
        let turn_complete = r#"{"type":"turn_complete","msg_id":"m1"}"#;
        let tool_result =
            r#"{"type":"tool_result","tool_use_id":"tu-1","output":"ok","is_error":false}"#;

        drive_relay(
            ledger.clone(),
            "tug-1",
            "/proj",
            &[tool_use, turn_complete, tool_result],
        )
        .await;

        assert_eq!(
            ledger.file_events_for_session("tug-1").unwrap().len(),
            1,
            "the tool_use/tool_result pair straddling turn_complete still records"
        );
    }

    /// A real git repo with one committed file, so a bracket's pre-snapshot
    /// starts from a clean tree.
    fn init_bracket_repo() -> tempfile::TempDir {
        let repo = tempfile::tempdir().expect("tempdir");
        let root = repo.path().to_path_buf();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);
        repo
    }

    /// Drive one real Bash bracket through the relay: the `tool_use` frame
    /// opens it, `mutate` performs what the command would have done to the real
    /// repo, and the `tool_result` frame closes it. Returns every row the
    /// session recorded.
    async fn bash_bracket_rows(
        root: &Path,
        session: &str,
        command: &str,
        mutate: impl FnOnce(),
    ) -> Vec<crate::session_ledger::FileEventRow> {
        let ledger = bash_bracket_ledger(root, session, command, mutate).await;
        ledger.file_events_for_session(session).unwrap()
    }

    /// The same bracket, handing back the whole ledger — for the cases that
    /// need to read a row's spans, not just the row.
    async fn bash_bracket_ledger(
        root: &Path,
        session: &str,
        command: &str,
        mutate: impl FnOnce(),
    ) -> Arc<crate::session_ledger::SessionLedger> {
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;
        use tokio::io::AsyncWriteExt;

        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let project_dir = root.to_str().unwrap().to_string();
        let tug_session_id = TugSessionId::new(session.to_string());
        let ledger_entry = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_session_id.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (_input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        let (merger_tx, mut _merger_rx) = mpsc::channel::<Frame>(256);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let (relay_stdin_w, _tugcode_stdin_r) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r, mut feed_w) = tokio::io::duplex(256 * 1024);
        let reader: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r);
        let lines = BufReader::new(reader).lines();

        let ledger_for_relay = ledger.clone();
        let relay = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_session_id,
                &ledger_entry,
                &mut input_rx,
                &merger_tx,
                &state_tx,
                None,
                Box::new(relay_stdin_w),
                lines,
                &project_dir,
                &recorder,
                Some(ledger_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel,
            )
            .await
        });

        feed_w
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();
        let use_frame = serde_json::json!({
            "type": "tool_use",
            "tool_name": "Bash",
            "tool_use_id": "tu-b",
            "input": { "command": command },
        });
        feed_w
            .write_all(format!("{use_frame}\n").as_bytes())
            .await
            .unwrap();
        // Let the pre-snapshot land before the command's effect.
        tokio::time::sleep(Duration::from_millis(300)).await;
        mutate();
        feed_w
            .write_all(
                b"{\"type\":\"tool_result\",\"tool_use_id\":\"tu-b\",\"output\":\"\",\"is_error\":false}\n",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(feed_w);
        let _ = relay.await.expect("relay task");
        ledger
    }

    #[tokio::test]
    async fn a_literal_rm_is_proof_and_a_glob_rm_is_only_a_hint() {
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        std::fs::write(root.join("doomed.txt"), "bye\n").unwrap();

        let target = root.join("doomed.txt");
        let rows = bash_bracket_rows(&root, "tug-rm", "rm doomed.txt", move || {
            std::fs::remove_file(&target).unwrap();
        })
        .await;
        let row = rows
            .iter()
            .find(|r| r.file_path == "doomed.txt")
            .expect("the removed path is recorded");
        assert_eq!(row.origin, "cmd", "the command named the file: proof");
        assert_eq!(row.op, "deleted");
        assert_eq!(row.tool_name, "Bash");

        // The same deletion through a glob is unreadable, so it stays a hint.
        std::fs::write(root.join("doomed.txt"), "bye again\n").unwrap();
        let target = root.join("doomed.txt");
        let rows = bash_bracket_rows(&root, "tug-glob", "rm doomed.*", move || {
            std::fs::remove_file(&target).unwrap();
        })
        .await;
        let row = rows
            .iter()
            .find(|r| r.file_path == "doomed.txt")
            .expect("the removed path is still recorded");
        assert_eq!(row.origin, "bash", "a glob operand proves nothing");
    }

    /// Spans a session recorded for one repo-relative path, as `(kind,
    /// anchor)` pairs.
    fn spans_for(
        ledger: &crate::session_ledger::SessionLedger,
        root: &Path,
        path: &str,
    ) -> Vec<(String, String)> {
        ledger
            .file_event_spans_for_paths(root.to_str().unwrap(), &[path.to_owned()])
            .unwrap()
            .into_iter()
            .map(|row| (row.span.kind, row.span.anchor))
            .collect()
    }

    #[tokio::test]
    async fn a_promoted_row_records_the_hunks_it_claims_authorship_over() {
        // A promotion asserts this session wrote what is in the file. What it
        // is asserting over is the path's working diff at close, and its hunk
        // ids are what a later read can find gone.
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let named = root.join("a.txt");
        let unnamed = root.join("b.txt");
        let ledger = bash_bracket_ledger(
            &root,
            "tug-spans",
            "sed -i '' 's/one/two/' a.txt",
            move || {
                std::fs::write(&named, "two\n").unwrap();
                std::fs::write(&unnamed, "hand-saved\n").unwrap();
            },
        )
        .await;

        let rows = ledger.file_events_for_session("tug-spans").unwrap();
        let promoted = rows
            .iter()
            .find(|r| r.file_path == "a.txt")
            .expect("the named path is recorded");
        assert_eq!(promoted.origin, "cmd");

        let spans = spans_for(&ledger, &root, "a.txt");
        assert!(!spans.is_empty(), "a promoted row carries evidence");
        // The ids name the file's real hunks — the same identity the readers
        // key contention on.
        let live_ids: std::collections::HashSet<String> =
            tugchanges_core::file_hunks(&root, "a.txt")
                .unwrap()
                .into_iter()
                .map(|h| h.id)
                .collect();
        for (kind, anchor) in &spans {
            assert_eq!(kind, "hunk");
            let tugchanges_core::Anchor::Hunk { id } =
                tugchanges_core::Anchor::from_span(kind, anchor)
            else {
                panic!("a promoted row's evidence is hunk-kind");
            };
            assert!(
                live_ids.contains(&id),
                "{id} is not a hunk the file actually has: {live_ids:?}"
            );
        }

        // A bracket hint asserts nothing, so it records nothing to falsify.
        assert!(spans_for(&ledger, &root, "b.txt").is_empty());
    }

    #[tokio::test]
    async fn a_promoted_row_on_a_created_file_records_no_evidence() {
        // An untracked file has no tracked diff to read ids from, and ids
        // minted from a synthesized one would be unreproducible by either
        // read side. It records span-less, the unfalsifiable floor.
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let fresh = root.join("fresh.txt");
        let ledger = bash_bracket_ledger(&root, "tug-fresh", "echo hi > fresh.txt", move || {
            std::fs::write(&fresh, "hi\n").unwrap();
        })
        .await;

        let rows = ledger.file_events_for_session("tug-fresh").unwrap();
        let row = rows
            .iter()
            .find(|r| r.file_path == "fresh.txt")
            .expect("the created path is recorded");
        assert_eq!(row.origin, "cmd");
        assert!(spans_for(&ledger, &root, "fresh.txt").is_empty());
    }

    #[tokio::test]
    async fn promoted_ids_place_against_the_sync_engines_spelling() {
        // The whole payoff rests on this: the writer mints ids through the
        // async diff spelling (`fetch_git_diff` + `parse_hunks`) while the
        // sync engine reads them through `file_hunks`
        // (`std::process::Command`). Both carry HUNK_DIFF_FLAGS by contract,
        // but this is the first writer to depend on it, so pin it.
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let named = root.join("a.txt");
        let ledger = bash_bracket_ledger(
            &root,
            "tug-agree",
            "sed -i '' 's/one/rewritten/' a.txt",
            move || {
                std::fs::write(&named, "rewritten\n").unwrap();
            },
        )
        .await;

        let written: Vec<tugchanges_core::Anchor> = spans_for(&ledger, &root, "a.txt")
            .iter()
            .map(|(kind, anchor)| tugchanges_core::Anchor::from_span(kind, anchor))
            .collect();
        assert!(!written.is_empty());
        let hunks = tugchanges_core::file_hunks(&root, "a.txt").unwrap();
        let verdict = tugchanges_core::classify_contention(
            &hunks,
            &[tugchanges_core::OwnerAnchors {
                session: "tug-agree".to_owned(),
                anchors: written,
                live: true,
            }],
            None,
        );
        assert_eq!(
            verdict.hunks_of("tug-agree", &hunks),
            hunks.iter().map(|h| h.id.clone()).collect::<Vec<_>>(),
            "evidence written by one spelling places under the other"
        );
    }

    #[tokio::test]
    async fn a_hand_save_the_command_never_named_stays_correlation() {
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let named = root.join("named.txt");
        let unnamed = root.join("a.txt");
        let rows = bash_bracket_rows(&root, "tug-mixed", "echo hi > named.txt", move || {
            std::fs::write(&named, "hi\n").unwrap();
            // The user saves their own file while the command runs.
            std::fs::write(&unnamed, "one\nhand-edited\n").unwrap();
        })
        .await;
        let by_path: std::collections::HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.origin.as_str()))
            .collect();
        assert_eq!(by_path.get("named.txt"), Some(&"cmd"));
        assert_eq!(
            by_path.get("a.txt"),
            Some(&"bash"),
            "a file the command never named can never be proved by the delta"
        );
    }

    #[tokio::test]
    async fn a_recursive_rm_proves_every_file_beneath_the_named_directory() {
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        std::fs::create_dir_all(root.join("out/nested")).unwrap();
        std::fs::write(root.join("out/one.txt"), "1\n").unwrap();
        std::fs::write(root.join("out/nested/two.txt"), "2\n").unwrap();

        let dir = root.join("out");
        let rows = bash_bracket_rows(&root, "tug-rmr", "rm -rf out", move || {
            std::fs::remove_dir_all(&dir).unwrap();
        })
        .await;
        let by_path: std::collections::HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.origin.as_str()))
            .collect();
        assert_eq!(by_path.get("out/one.txt"), Some(&"cmd"));
        assert_eq!(by_path.get("out/nested/two.txt"), Some(&"cmd"));
    }

    #[tokio::test]
    async fn a_git_mv_records_both_names_under_one_tool_use_id() {
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let moved_root = root.clone();
        let rows = bash_bracket_rows(&root, "tug-mv", "git mv a.txt b.txt", move || {
            assert!(
                std::process::Command::new("git")
                    .args(["mv", "a.txt", "b.txt"])
                    .current_dir(&moved_root)
                    .output()
                    .expect("git mv")
                    .status
                    .success()
            );
        })
        .await;
        let by_path: std::collections::HashMap<&str, (&str, &str)> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), (r.op.as_str(), r.origin.as_str())))
            .collect();
        assert_eq!(
            by_path.get("b.txt"),
            Some(&("renamed", "cmd")),
            "the destination is proved by the parse and the delta"
        );
        assert_eq!(
            by_path.get("a.txt"),
            Some(&("renamed", "cmd")),
            "the takeoff row is synthesized from the parse — the old name left the dirty set"
        );
        assert!(
            rows.iter().all(|r| r.tool_use_id == "tu-b"),
            "both names are one operation"
        );
    }

    #[tokio::test]
    async fn a_declared_path_spelled_through_an_alt_root_still_joins() {
        // The bracket's delta keys are canonical while the command's operands are
        // spelled through an alias — exactly the drift the canonical join at the
        // intersection exists to absorb.
        //
        // The alias is built here rather than inherited from the platform. On
        // macOS the tempdir root (`/var/...`) is already a symlink to
        // `/private/var/...` and supplies the drift for free, but on Linux
        // `/tmp` is a real directory, so leaning on the tempdir made this test
        // abort on its own precondition off-macOS.
        let repo = init_bracket_repo();
        let real_root = std::fs::canonicalize(repo.path()).unwrap();
        let alias_home = tempfile::tempdir().expect("tempdir");
        let root = alias_home.path().join("alias");
        std::os::unix::fs::symlink(&real_root, &root).unwrap();
        assert_ne!(
            std::fs::canonicalize(&root).unwrap(),
            root,
            "the aliased spelling must differ from the canonical one"
        );
        std::fs::write(root.join("aliased.txt"), "x\n").unwrap();
        let absolute = root.join("aliased.txt");
        let command = format!("rm {}", absolute.display());
        let target = absolute.clone();
        let rows = bash_bracket_rows(&root, "tug-alt", &command, move || {
            std::fs::remove_file(&target).unwrap();
        })
        .await;
        let row = rows
            .iter()
            .find(|r| r.file_path == "aliased.txt")
            .expect("the removed path is recorded");
        assert_eq!(row.origin, "cmd");
    }

    #[tokio::test]
    async fn git_rm_cached_records_one_sane_row() {
        // `--cached` leaves the file on disk but drops the index entry, so
        // porcelain reports the path twice (`1 D.` and `? path`) — last wins.
        let repo = init_bracket_repo();
        let root = repo.path().to_path_buf();
        let cached_root = root.clone();
        let rows = bash_bracket_rows(&root, "tug-cached", "git rm --cached a.txt", move || {
            assert!(
                std::process::Command::new("git")
                    .args(["rm", "-q", "--cached", "a.txt"])
                    .current_dir(&cached_root)
                    .output()
                    .expect("git rm")
                    .status
                    .success()
            );
        })
        .await;
        let for_path: Vec<_> = rows.iter().filter(|r| r.file_path == "a.txt").collect();
        assert_eq!(for_path.len(), 1, "one row per path per call");
        assert_eq!(for_path[0].origin, "cmd");
    }

    #[tokio::test]
    async fn attribution_brackets_a_real_bash_edit_end_to_end() {
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;
        use tokio::io::AsyncWriteExt;

        // Real git repo with a committed file (clean pre-snapshot).
        let repo = tempfile::tempdir().expect("tempdir");
        let root = repo.path().to_path_buf();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);

        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let project_dir = root.to_str().unwrap().to_string();

        // Hand-driven relay so the file can be mutated *between* the Bash
        // tool_use (pre-snapshot) and its tool_result (post-snapshot) — the
        // real bracket window.
        let tug_session_id = TugSessionId::new("tug-bash".to_string());
        let ledger_entry = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_session_id.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (_input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        let (merger_tx, mut _merger_rx) = mpsc::channel::<Frame>(256);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let (relay_stdin_w, _tugcode_stdin_r) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r, mut feed_w) = tokio::io::duplex(256 * 1024);
        let reader: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r);
        let lines = BufReader::new(reader).lines();

        let ledger_for_relay = ledger.clone();
        let relay = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_session_id,
                &ledger_entry,
                &mut input_rx,
                &merger_tx,
                &state_tx,
                None,
                Box::new(relay_stdin_w),
                lines,
                &project_dir,
                &recorder,
                Some(ledger_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel,
            )
            .await
        });

        // Handshake + Bash tool_use → relay takes the (clean) pre-snapshot.
        feed_w
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();
        feed_w
            .write_all(b"{\"type\":\"tool_use\",\"tool_name\":\"Bash\",\"tool_use_id\":\"tu-b\",\"input\":{\"command\":\"echo two >> a.txt\"}}\n")
            .await
            .unwrap();
        // Let the pre-snapshot land before the "command" mutates the tree.
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("c.txt"), "created\n").unwrap();
        // tool_result closes the bracket → post-snapshot + delta rows.
        feed_w
            .write_all(b"{\"type\":\"tool_result\",\"tool_use_id\":\"tu-b\",\"output\":\"\",\"is_error\":false}\n")
            .await
            .unwrap();
        // Give the close path time to record before EOF ends the relay.
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(feed_w);
        let _ = relay.await.expect("relay task");

        let rows = ledger.file_events_for_session("tug-bash").unwrap();
        let by_path: std::collections::HashMap<String, String> = rows
            .iter()
            .map(|r| (r.file_path.clone(), r.op.clone()))
            .collect();
        // file_path is stored repo-relative at capture time.
        assert_eq!(
            by_path.get("a.txt"),
            Some(&"modified".to_owned()),
            "the Bash-edited tracked file is attributed"
        );
        assert_eq!(
            by_path.get("c.txt"),
            Some(&"created".to_owned()),
            "the Bash-created file is attributed"
        );
        let by_origin: std::collections::HashMap<String, String> = rows
            .iter()
            .map(|r| (r.file_path.clone(), r.origin.clone()))
            .collect();
        // The command's redirect names a.txt, and the delta confirms it moved:
        // named AND observed is proof.
        assert_eq!(by_origin.get("a.txt"), Some(&"cmd".to_owned()));
        // c.txt only moved during the window — correlation, a hint at most.
        assert_eq!(by_origin.get("c.txt"), Some(&"bash".to_owned()));
        for r in &rows {
            assert_eq!(r.tool_name, "Bash");
            assert!(!r.ambiguous);
        }
    }

    /// The regression: a `tugutil file`/`tugrev` edit to a file in the
    /// session's own live tree. The command is opaque to the grammar, so the
    /// bracket delta sees the file move and would attribute it a weak `bash`
    /// hint — but the result carries a receipt naming that same file. Both
    /// name the same `(session, tool_use_id, file_path)` key, and the insert
    /// is `ON CONFLICT DO NOTHING`, so the row belongs to whichever origin is
    /// written first. Proof must win: the receipt is read before the bracket,
    /// so the row is `cmd`, not `bash`. Before the fix it was `bash`, and the
    /// file read as UNATTRIBUTED with the receipt silently discarded.
    #[tokio::test]
    async fn a_receipt_beats_the_bracket_hint_for_the_same_file() {
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;
        use tokio::io::AsyncWriteExt;

        let repo = tempfile::tempdir().expect("tempdir");
        let root = repo.path().to_path_buf();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);

        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let project_dir = root.to_str().unwrap().to_string();
        let abs_a = root.join("a.txt");
        let abs_a = abs_a.to_str().unwrap().to_string();

        let tug_session_id = TugSessionId::new("tug-receipt".to_string());
        let ledger_entry = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_session_id.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (_input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        let (merger_tx, mut _merger_rx) = mpsc::channel::<Frame>(256);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let (relay_stdin_w, _tugcode_stdin_r) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r, mut feed_w) = tokio::io::duplex(256 * 1024);
        let reader: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r);
        let lines = BufReader::new(reader).lines();

        let ledger_for_relay = ledger.clone();
        let relay = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_session_id,
                &ledger_entry,
                &mut input_rx,
                &merger_tx,
                &state_tx,
                None,
                Box::new(relay_stdin_w),
                lines,
                &project_dir,
                &recorder,
                Some(ledger_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel,
            )
            .await
        });

        feed_w
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();
        // An opaque command: the grammar names no file, so the bracket can
        // only offer a `bash` hint for whatever the window observed move.
        feed_w
            .write_all(b"{\"type\":\"tool_use\",\"tool_name\":\"Bash\",\"tool_use_id\":\"tu-r\",\"input\":{\"command\":\"tugrev edit.rev\"}}\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        // The result carries the receipt a rev prints, naming the absolute
        // path — exactly what `tugutil file rev` emits.
        let receipt = format!(
            "TUG-FILE-RECEIPT: {{\\\"ops\\\":[{{\\\"op\\\":\\\"modified\\\",\\\"path\\\":\\\"{abs_a}\\\"}}]}}"
        );
        let result = format!(
            "{{\"type\":\"tool_result\",\"tool_use_id\":\"tu-r\",\"output\":\"{receipt}\",\"is_error\":false}}\n"
        );
        feed_w.write_all(result.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(feed_w);
        let _ = relay.await.expect("relay task");

        let rows = ledger.file_events_for_session("tug-receipt").unwrap();
        let a_rows: Vec<_> = rows.iter().filter(|r| r.file_path == "a.txt").collect();
        assert_eq!(
            a_rows.len(),
            1,
            "one row per (session, tool_use, file); got {a_rows:?}"
        );
        assert_eq!(
            a_rows[0].origin, "cmd",
            "the receipt is proof and must beat the bracket's `bash` hint"
        );
        assert_eq!(a_rows[0].op, "modified");
    }

    #[tokio::test]
    async fn turn_bracket_attributes_unbracketed_delta_and_dedups_exact_rows() {
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;
        use tokio::io::AsyncWriteExt;

        // Real git repo with a committed file (clean pre-snapshot).
        let repo = tempfile::tempdir().expect("tempdir");
        let root = repo.path().to_path_buf();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);

        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let project_dir = root.to_str().unwrap().to_string();
        let tug_session_id = TugSessionId::new("tug-turn".to_string());
        let ledger_entry = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_session_id.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        let (merger_tx, mut _merger_rx) = mpsc::channel::<Frame>(256);
        let (state_tx, _state_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let (relay_stdin_w, _tugcode_stdin_r) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r, mut feed_w) = tokio::io::duplex(256 * 1024);
        let reader: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r);
        let lines = BufReader::new(reader).lines();

        let ledger_for_relay = ledger.clone();
        let relay = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_session_id,
                &ledger_entry,
                &mut input_rx,
                &merger_tx,
                &state_tx,
                None,
                Box::new(relay_stdin_w),
                lines,
                &project_dir,
                &recorder,
                Some(ledger_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel,
            )
            .await
        });

        // Handshake.
        feed_w
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();

        // A user_message forwarded to stdin opens the (relay-local) turn
        // bracket; let the relay process the input frame and take the clean
        // pre-snapshot before mutating the tree.
        input_tx
            .send(Frame::new(
                FeedId::CODE_INPUT,
                br#"{"type":"user_message","text":"go"}"#.to_vec(),
            ))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        // An exact Write records `exact.rs` (also created on disk so it is
        // dirty at the post-snapshot) — its path must NOT be re-recorded by the
        // turn close.
        std::fs::write(root.join("exact.rs"), "e\n").unwrap();
        let exact_use = format!(
            r#"{{"type":"tool_use","tool_name":"Write","tool_use_id":"tu-e","input":{{"file_path":"{}"}}}}"#,
            root.join("exact.rs").to_str().unwrap()
        );
        feed_w.write_all(exact_use.as_bytes()).await.unwrap();
        feed_w.write_all(b"\n").await.unwrap();
        feed_w
            .write_all(
                br#"{"type":"tool_result","tool_use_id":"tu-e","output":"ok","is_error":false}"#,
            )
            .await
            .unwrap();
        feed_w.write_all(b"\n").await.unwrap();

        // A file mutated with NO surrounding Bash bracket — the G2 race the
        // turn bracket exists to catch.
        std::fs::write(root.join("new.rs"), "n\n").unwrap();

        // turn_complete closes the turn bracket → post-snapshot + delta.
        feed_w
            .write_all(b"{\"type\":\"turn_complete\",\"msg_id\":\"m1\"}\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(feed_w);
        let _ = relay.await.expect("relay task");

        let rows = ledger.file_events_for_session("tug-turn").unwrap();
        let by_path: std::collections::HashMap<String, (String, String)> = rows
            .iter()
            .map(|r| (r.file_path.clone(), (r.origin.clone(), r.tool_name.clone())))
            .collect();
        // The exact edit stays an exact row.
        assert_eq!(
            by_path.get("exact.rs"),
            Some(&("exact".to_owned(), "Write".to_owned())),
            "exact.rs is the exact row"
        );
        // The unbracketed edit is caught by the turn fallback.
        assert_eq!(
            by_path.get("new.rs"),
            Some(&("turn".to_owned(), "Turn".to_owned())),
            "new.rs is the origin='turn' fallback row"
        );
        // A path already covered by an exact row this turn gets no turn row.
        assert_eq!(
            rows.iter().filter(|r| r.file_path == "exact.rs").count(),
            1,
            "exact.rs is not re-recorded by the turn bracket"
        );
        assert_eq!(rows.len(), 2, "exactly two rows: one exact, one turn");
        // Capture records provenance only — no row carries a cross-session
        // judgment.
        assert!(
            rows.iter().all(|r| !r.ambiguous),
            "no capture row is ever marked ambiguous"
        );
    }

    #[tokio::test]
    async fn concurrent_sessions_never_mark_each_others_rows_ambiguous() {
        // The pinned regression: session A sits mid-turn (turn bracket open)
        // while session B runs a Bash edit on the same checkout. Wall-clock
        // overlap between sessions is not evidence of contention — all
        // brackets are relay-local and capture records provenance only, so
        // B's rows come out clean. (Genuine same-file contention surfaces at
        // read time, when both sessions hold rows for the same path.)
        use crate::feeds::agent_supervisor::NoopSessionsRecorder;
        use crate::feeds::workspace_registry::WorkspaceKey;
        use tokio::io::AsyncWriteExt;

        // Real git repo, clean.
        let repo = tempfile::tempdir().expect("tempdir");
        let root = repo.path().to_path_buf();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "init"]);

        let project_dir = root.to_str().unwrap().to_string();

        // --- Session A: hold a turn bracket open for the whole test window ---
        let ledger_a = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tug_a = TugSessionId::new("tug-A".to_string());
        let ledger_entry_a = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_a.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (input_tx_a, mut input_rx_a) = mpsc::channel::<Frame>(16);
        let (merger_tx_a, mut _merger_rx_a) = mpsc::channel::<Frame>(256);
        let (state_tx_a, _state_rx_a) = broadcast::channel::<Frame>(64);
        let cancel_a = CancellationToken::new();
        let (relay_stdin_w_a, _stdin_r_a) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r_a, mut feed_w_a) = tokio::io::duplex(256 * 1024);
        let reader_a: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r_a);
        let lines_a = BufReader::new(reader_a).lines();
        let project_a = project_dir.clone();
        let ledger_a_for_relay = ledger_a.clone();
        let relay_a = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_a,
                &ledger_entry_a,
                &mut input_rx_a,
                &merger_tx_a,
                &state_tx_a,
                None,
                Box::new(relay_stdin_w_a),
                lines_a,
                &project_a,
                &recorder,
                Some(ledger_a_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel_a,
            )
            .await
        });
        feed_w_a
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();
        // A's user_message opens A's (relay-local) turn bracket; it stays open
        // for the rest of the test (no turn_complete sent to A).
        input_tx_a
            .send(Frame::new(
                FeedId::CODE_INPUT,
                br#"{"type":"user_message","text":"go"}"#.to_vec(),
            ))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        // --- Session B: a Bash edit on the same checkout while A is mid-turn ---
        let ledger_b = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let tug_b = TugSessionId::new("tug-B".to_string());
        let ledger_entry_b = Arc::new(Mutex::new(
            crate::feeds::agent_supervisor::LedgerEntry::new(
                tug_b.clone(),
                WorkspaceKey::from_test_str("ws-test"),
                PathBuf::from(&project_dir),
                SessionMode::New,
                CrashBudget::new(3, Duration::from_secs(60)),
            ),
        ));
        let (_input_tx_b, mut input_rx_b) = mpsc::channel::<Frame>(16);
        let (merger_tx_b, mut _merger_rx_b) = mpsc::channel::<Frame>(256);
        let (state_tx_b, _state_rx_b) = broadcast::channel::<Frame>(64);
        let cancel_b = CancellationToken::new();
        let (relay_stdin_w_b, _stdin_r_b) = tokio::io::duplex(64 * 1024);
        let (relay_stdout_r_b, mut feed_w_b) = tokio::io::duplex(256 * 1024);
        let reader_b: Box<dyn AsyncRead + Send + Unpin> = Box::new(relay_stdout_r_b);
        let lines_b = BufReader::new(reader_b).lines();
        let project_b = project_dir.clone();
        let ledger_b_for_relay = ledger_b.clone();
        let relay_b = tokio::spawn(async move {
            let recorder = NoopSessionsRecorder;
            relay_session_io(
                &tug_b,
                &ledger_entry_b,
                &mut input_rx_b,
                &merger_tx_b,
                &state_tx_b,
                None,
                Box::new(relay_stdin_w_b),
                lines_b,
                &project_b,
                &recorder,
                Some(ledger_b_for_relay.as_ref()),
                &InkLedgers::default(),
                &crate::feeds::changeset::ChangesetBumper::disconnected(),
                &cancel_b,
            )
            .await
        });
        feed_w_b
            .write_all(b"{\"type\":\"protocol_ack\"}\n")
            .await
            .unwrap();
        // B's Bash tool_use opens B's relay-local Bash bracket → pre-snapshot.
        feed_w_b
            .write_all(b"{\"type\":\"tool_use\",\"tool_name\":\"Bash\",\"tool_use_id\":\"tu-b\",\"input\":{\"command\":\"echo x >> a.txt\"}}\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        feed_w_b
            .write_all(b"{\"type\":\"tool_result\",\"tool_use_id\":\"tu-b\",\"output\":\"\",\"is_error\":false}\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(feed_w_b);
        let _ = relay_b.await.expect("relay B");

        // B's Bash edit is attributed and, crucially, NOT ambiguous — A's
        // mid-turn window is invisible to B's capture.
        let rows_b = ledger_b.file_events_for_session("tug-B").unwrap();
        assert!(!rows_b.is_empty(), "B's Bash edit is attributed");
        assert!(
            rows_b.iter().all(|r| !r.ambiguous),
            "A's mid-turn window must not mark B's Bash rows ambiguous"
        );

        // Tear down A: EOF on its stdout ends the relay.
        drop(feed_w_a);
        drop(input_tx_a);
        let _ = relay_a.await;
    }

    #[tokio::test]
    async fn replayed_turn_complete_records_no_turn_rows() {
        // A replayed turn_complete (inside replay_started/replay_complete)
        // opens no bracket (user messages don't replay through input_rx) and
        // its close is gated off by `in_replay` — no origin='turn' rows appear.
        let ledger = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let replay_started = r#"{"type":"replay_started"}"#;
        let turn_complete = r#"{"type":"turn_complete","msg_id":"m1"}"#;
        let replay_complete = r#"{"type":"replay_complete"}"#;

        drive_relay(
            ledger.clone(),
            "tug-r",
            "/proj",
            &[replay_started, turn_complete, replay_complete],
        )
        .await;

        assert!(
            ledger.file_events_for_session("tug-r").unwrap().is_empty(),
            "a replayed turn_complete records nothing"
        );
    }

    #[test]
    fn test_crash_budget_within_window() {
        let mut budget = CrashBudget::new(3, Duration::from_secs(60));
        assert!(!budget.record_crash());
        assert!(!budget.record_crash());
        assert!(budget.record_crash());
        assert!(budget.is_exhausted());
    }

    #[test]
    fn test_crash_budget_outside_window() {
        let mut budget = CrashBudget::new(3, Duration::from_millis(1));
        // Exhaust the budget
        budget.record_crash();
        budget.record_crash();
        assert!(budget.record_crash());
        assert!(budget.is_exhausted());

        // Wait for the window to expire
        std::thread::sleep(Duration::from_millis(10));

        // Budget should reset — old crashes fall outside the window
        assert!(!budget.record_crash());
        assert!(!budget.is_exhausted());
    }

    #[test]
    fn test_resolve_cli_override_returns_exact_path() {
        let override_path = Path::new("/custom/path/tugcode");
        let result = resolve_tugcode_path(Some(override_path));
        assert_eq!(result, override_path);
    }

    #[test]
    fn test_resolve_without_override_finds_sibling_or_falls_back() {
        let result = resolve_tugcode_path(None);
        let s = result.to_str().unwrap();
        // In test builds, the tugcode binary sits next to the test binary in target/debug/,
        // so the sibling check succeeds. In environments without a sibling, it falls back
        // to the bun-run path (tugcode/src/main.ts).
        assert!(
            s.ends_with("/tugcode") || s.contains("tugcode/src/main.ts"),
            "Expected sibling binary or bun fallback, got: {s}"
        );
    }

    // ---- build_tugcode_command + TugcodeSpawner argv composition ----

    #[test]
    fn test_build_tugcode_command_binary_passes_all_args() {
        let (program, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/alpha"),
            "sess-alpha-uuid",
            SessionMode::New,
            None,
            None,
        );
        assert_eq!(program, "/opt/tugtool/tugcode");
        assert_eq!(
            args,
            vec![
                "--dir".to_string(),
                "/work/alpha".to_string(),
                "--session-id".to_string(),
                "sess-alpha-uuid".to_string(),
                "--session-mode".to_string(),
                "new".to_string(),
            ]
        );
    }

    #[test]
    fn test_build_tugcode_command_ts_uses_bun_run_and_passes_all_args() {
        let (program, args) = build_tugcode_command(
            Path::new("/u/src/tugtool/tugcode/src/main.ts"),
            Path::new("/work/beta"),
            "sess-beta-uuid",
            SessionMode::New,
            None,
            None,
        );
        assert_eq!(program, "bun");
        assert_eq!(
            args,
            vec![
                "run".to_string(),
                "/u/src/tugtool/tugcode/src/main.ts".to_string(),
                "--dir".to_string(),
                "/work/beta".to_string(),
                "--session-id".to_string(),
                "sess-beta-uuid".to_string(),
                "--session-mode".to_string(),
                "new".to_string(),
            ]
        );
    }

    #[test]
    fn test_tugcode_spawner_uses_per_call_project_dir_and_session_id() {
        // Belt-and-suspenders: the same TugcodeSpawner instance must
        // produce commands with per-call `project_dir` + `session_id`
        // arguments, not captured construction-time state.
        let spawner = TugcodeSpawner::new(PathBuf::from("/opt/tugtool/tugcode"));
        let (_p1, args1) = build_tugcode_command(
            &spawner.tugcode_path,
            Path::new("/work/a"),
            "sess-a",
            SessionMode::New,
            None,
            None,
        );
        let (_p2, args2) = build_tugcode_command(
            &spawner.tugcode_path,
            Path::new("/work/b"),
            "sess-b",
            SessionMode::New,
            None,
            None,
        );
        assert!(args1.iter().any(|a| a == "/work/a"));
        assert!(args1.iter().any(|a| a == "sess-a"));
        assert!(!args1.iter().any(|a| a == "/work/b"));
        assert!(!args1.iter().any(|a| a == "sess-b"));
        assert!(args2.iter().any(|a| a == "/work/b"));
        assert!(args2.iter().any(|a| a == "sess-b"));
    }

    #[test]
    fn test_build_tugcode_command_emits_session_mode_resume() {
        let (_, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/x"),
            "sess-x",
            SessionMode::Resume,
            None,
            None,
        );
        let i = args
            .iter()
            .position(|a| a == "--session-mode")
            .expect("--session-mode flag must be present");
        assert_eq!(args.get(i + 1).map(String::as_str), Some("resume"));
    }

    /// When `resume_claude_session_id` is `Some`, the helper
    /// appends `--resume-session <id>` after `--session-mode`. When
    /// `None`, the flag is omitted entirely (legacy fallback path —
    /// tugcode then uses `--session-id` for its `--resume <id>` claude
    /// invocation, which works for un-forked sessions whose tug and
    /// claude ids are equal).
    #[test]
    fn test_build_tugcode_command_emits_resume_session_when_id_is_some() {
        let (_, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/y"),
            "sess-y-tug-uuid",
            SessionMode::Resume,
            Some("claude-internal-id-7"),
            None,
        );
        let i = args
            .iter()
            .position(|a| a == "--resume-session")
            .expect("--resume-session must be present when id is Some");
        assert_eq!(
            args.get(i + 1).map(String::as_str),
            Some("claude-internal-id-7")
        );
        // `--session-id` still carries the tug id; `--resume-session`
        // carries the claude id. They're distinct fields by design.
        let j = args
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id still emitted alongside --resume-session");
        assert_eq!(args.get(j + 1).map(String::as_str), Some("sess-y-tug-uuid"));
    }

    #[test]
    fn test_build_tugcode_command_omits_resume_session_when_id_is_none() {
        let (_, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/z"),
            "sess-z",
            SessionMode::Resume,
            None,
            None,
        );
        assert!(
            !args.iter().any(|a| a == "--resume-session"),
            "--resume-session must be absent when id is None"
        );
    }

    /// When `permission_mode` is `Some`, the helper appends
    /// `--permission-mode <mode>` so the spawned claude starts in tugdeck's
    /// resolved default. When `None`, the flag is omitted and tugcode keeps
    /// its own default.
    #[test]
    fn test_build_tugcode_command_emits_permission_mode_when_some() {
        let (_, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/p"),
            "sess-p",
            SessionMode::New,
            None,
            Some("plan"),
        );
        let i = args
            .iter()
            .position(|a| a == "--permission-mode")
            .expect("--permission-mode must be present when mode is Some");
        assert_eq!(args.get(i + 1).map(String::as_str), Some("plan"));
    }

    #[test]
    fn test_build_tugcode_command_omits_permission_mode_when_none() {
        let (_, args) = build_tugcode_command(
            Path::new("/opt/tugtool/tugcode"),
            Path::new("/work/q"),
            "sess-q",
            SessionMode::New,
            None,
            None,
        );
        assert!(
            !args.iter().any(|a| a == "--permission-mode"),
            "--permission-mode must be absent when mode is None"
        );
    }

    #[test]
    fn test_session_mode_wire_roundtrip() {
        assert_eq!(SessionMode::from_wire_str(Some("new")), SessionMode::New);
        assert_eq!(
            SessionMode::from_wire_str(Some("resume")),
            SessionMode::Resume
        );
        // Absent / unknown values default to New.
        assert_eq!(SessionMode::from_wire_str(None), SessionMode::New);
        assert_eq!(SessionMode::from_wire_str(Some("bogus")), SessionMode::New);
        assert_eq!(SessionMode::New.as_wire_str(), "new");
        assert_eq!(SessionMode::Resume.as_wire_str(), "resume");
    }

    #[test]
    fn test_parse_claude_session_id_present() {
        let line = br#"{"type":"session_init","session_id":"claude-abc"}"#;
        assert_eq!(parse_claude_session_id(line), Some("claude-abc".into()));
    }

    #[test]
    fn test_parse_claude_session_id_absent() {
        let line = br#"{"type":"session_init"}"#;
        assert_eq!(parse_claude_session_id(line), None);
        assert_eq!(parse_claude_session_id(b"not json"), None);
    }

    // ── reconcile decision (parse_replay_complete_total_turns) ───────────────

    #[test]
    fn reconcile_reads_total_turns_not_count_on_success() {
        // A SUCCESS replay_complete carries window metadata. The windowed
        // `count` (5) undercounts a windowed restore; reconcile must read
        // `totalTurns` (22) — the authority.
        let line = r#"{"type":"replay_complete","count":5,"firstLoadedTurnIndex":17,"totalTurns":22,"hasOlder":true,"ipc_version":2}"#;
        assert_eq!(parse_replay_complete_total_turns(line), Some(22));
    }

    #[test]
    fn reconcile_skips_error_frame_with_no_metadata() {
        // An error frame (missing/unreadable JSONL) carries count:0 and NO
        // totalTurns — reconcile must skip it, or it would zero a real count.
        let err = r#"{"type":"replay_complete","count":0,"error":{"kind":"jsonl_missing","message":"gone"},"ipc_version":2}"#;
        assert_eq!(parse_replay_complete_total_turns(err), None);
        // A legacy full replay (no window) also has no totalTurns: skip too.
        let legacy = r#"{"type":"replay_complete","count":3,"ipc_version":2}"#;
        assert_eq!(parse_replay_complete_total_turns(legacy), None);
        // A trailing newline (stream framing) does not defeat parsing.
        let with_nl = "{\"type\":\"replay_complete\",\"count\":2,\"totalTurns\":2}\n";
        assert_eq!(parse_replay_complete_total_turns(with_nl), Some(2));
    }

    #[test]
    fn stamp_overrides_wire_total_turns_with_engine_value() {
        // Validate-and-stamp ([Q01]): when tugcode's wire totalTurns
        // disagrees with engine(file), the engine value is stamped onto the
        // outgoing frame so the window indices stay coherent with the count.
        let line = r#"{"type":"replay_complete","count":5,"firstLoadedTurnIndex":17,"totalTurns":59,"hasOlder":true,"ipc_version":2}"#;
        let stamped = stamp_replay_complete_total_turns(line, 81);
        let v: serde_json::Value = serde_json::from_slice(&stamped).unwrap();
        assert_eq!(v["totalTurns"], 81, "engine value wins on the wire");
        // Other fields are preserved through the round-trip.
        assert_eq!(v["firstLoadedTurnIndex"], 17);
        assert_eq!(v["count"], 5);
        assert_eq!(v["hasOlder"], true);
        // Re-reading the stamped frame yields the engine value.
        assert_eq!(
            parse_replay_complete_total_turns(std::str::from_utf8(&stamped).unwrap()),
            Some(81)
        );
    }

    #[test]
    fn stamp_preserves_session_created_field() {
        // tugcast only re-stamps `totalTurns`; every other field tugcode put
        // on the frame must ride through untouched. `sessionCreatedAtMs`
        // (the dev transcript's "Session created" anchor) is a passthrough —
        // lock it so a future stamp refactor can't silently drop it.
        let line = r#"{"type":"replay_complete","count":5,"firstLoadedTurnIndex":17,"totalTurns":59,"hasOlder":true,"sessionCreatedAtMs":1750166400000,"ipc_version":2}"#;
        let stamped = stamp_replay_complete_total_turns(line, 81);
        let v: serde_json::Value = serde_json::from_slice(&stamped).unwrap();
        assert_eq!(v["totalTurns"], 81, "engine value still wins");
        assert_eq!(
            v["sessionCreatedAtMs"], 1750166400000_i64,
            "session-created anchor survives the re-stamp"
        );
    }

    #[test]
    fn stamp_passes_through_unparseable_line() {
        let garbage = "not json at all";
        assert_eq!(
            stamp_replay_complete_total_turns(garbage, 81),
            garbage.as_bytes().to_vec()
        );
    }

    #[tokio::test]
    async fn test_session_child_drop_kills_subprocess() {
        // Verify `kill_on_drop(true)` on the tokio `Child` wrapped
        // inside `SessionChild` actually fires when
        // the `SessionChild` is dropped. This is the mechanism the
        // supervisor relies on to reap tugcode subprocesses when a session
        // closes or its bridge task exits. Using `/bin/sleep` (POSIX,
        // always present) avoids needing a built tugcode binary.
        use tokio::process::Command;

        let mut child = Command::new("/bin/sleep")
            .arg("300")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn /bin/sleep");
        let pid = child.id().expect("sleep should have a PID") as i32;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let session_child = SessionChild {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            pid: Some(pid as u32),
            _keepalive: Box::new(child),
            stderr_tail: Arc::new(std::sync::Mutex::new(VecDeque::new())),
        };

        // Confirm the process is alive before the drop.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "sleep subprocess should be alive before drop"
        );

        drop(session_child);

        // Subprocess teardown is asynchronous in the kernel: `kill_on_drop`
        // queues SIGKILL on drop, the kernel schedules the death, tokio's
        // driver reaps the zombie via SIGCHLD. We have no handle to block
        // on (the `Child` was consumed by the drop above), so a poll is
        // unavoidable here. Deterministic alternatives — `pidfd_open`,
        // `signal-hook`-backed SIGCHLD channel — are heavier than a single
        // kill_on_drop regression warrants.
        //
        // Constants chosen to make the test cheap on the happy path and
        // slow-to-false-fail on the pathological one:
        //   * `MAX_WAIT`: long enough that a real bug is the only way we
        //     time out, even on a contended CI host.
        //   * `POLL_INTERVAL`: short enough that the happy path returns
        //     in essentially one scheduler tick.
        const MAX_WAIT: Duration = Duration::from_secs(10);
        const POLL_INTERVAL: Duration = Duration::from_millis(5);
        let deadline = Instant::now() + MAX_WAIT;
        let mut reaped = false;
        while Instant::now() < deadline {
            // `kill(pid, 0)` returns ESRCH once the kernel has reaped
            // the process. Until then — including the zombie window —
            // it returns 0.
            if unsafe { libc::kill(pid, 0) } != 0 {
                reaped = true;
                break;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }

        assert!(
            reaped,
            "SessionChild drop must terminate the underlying subprocess within {MAX_WAIT:?} \
             (kill_on_drop(true) is load-bearing for tugcode cleanup)"
        );
    }

    #[tokio::test]
    async fn tugcode_spawn_exports_tug_session_id_to_the_child_env() {
        // The env chain that lets a skill / CLI inside the session self-
        // identify (and `tugutil changes` scope its query) starts here:
        // tugcast must set TUG_SESSION_ID on the tugcode spawn. Drive the
        // real `TugcodeSpawner::spawn_child` against a stand-in "tugcode"
        // that ignores its argv and echoes the variable, then read it back
        // off the child's stdout.
        use tokio::io::AsyncReadExt;

        let dir = tempfile::tempdir().expect("tempdir");
        // Named `tugcode` so `build_tugcode_command` runs it directly as a
        // binary (the `.ts` path would route through `bun run`).
        let script = dir.path().join("tugcode");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s' \"$TUG_SESSION_ID\"\n")
            .expect("write stand-in tugcode");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod +x");
        }

        let spawner = TugcodeSpawner::new(script);
        let mut child = spawner
            .spawn_child(dir.path(), "tug-sess-xyz", SessionMode::New, None, None)
            .await
            .expect("spawn stand-in tugcode");

        let mut out = String::new();
        child
            .stdout
            .read_to_string(&mut out)
            .await
            .expect("read child stdout");
        assert_eq!(
            out, "tug-sess-xyz",
            "tugcode child must inherit TUG_SESSION_ID set on the spawn"
        );
    }

    // ── parse_user_message_text ──────────────────────────────────────────────

    #[test]
    fn parse_user_message_text_extracts_legacy_text_field() {
        let json =
            br#"{"tug_session_id":"abc","type":"user_message","text":"hello","attachments":[]}"#;
        assert_eq!(parse_user_message_text(json), Some("hello".to_owned()));
    }

    #[test]
    fn parse_user_message_text_concatenates_content_text_blocks() {
        let json = br#"{
            "tug_session_id":"abc",
            "type":"user_message",
            "content":[
                {"type":"text","text":"hello "},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"PNG"}},
                {"type":"text","text":"world"}
            ]
        }"#;
        assert_eq!(
            parse_user_message_text(json),
            Some("hello world".to_owned())
        );
    }

    #[test]
    fn parse_user_message_text_returns_none_for_image_only_content() {
        let json = br#"{
            "tug_session_id":"abc",
            "type":"user_message",
            "content":[
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"PNG"}}
            ]
        }"#;
        assert_eq!(parse_user_message_text(json), None);
    }

    #[test]
    fn parse_user_message_text_returns_none_for_other_types() {
        let json = br#"{"tug_session_id":"abc","type":"interrupt"}"#;
        assert_eq!(parse_user_message_text(json), None);
        let json = br#"{"tug_session_id":"abc","type":"tool_approval","request_id":"r","decision":"allow"}"#;
        assert_eq!(parse_user_message_text(json), None);
    }

    #[test]
    fn parse_user_message_text_returns_none_for_empty_text() {
        let json = br#"{"tug_session_id":"abc","type":"user_message","text":"","attachments":[]}"#;
        assert_eq!(parse_user_message_text(json), None);
    }

    #[test]
    fn parse_user_message_text_returns_none_for_malformed_json() {
        assert_eq!(parse_user_message_text(b"not json"), None);
    }

    // ---- inject_replay_telemetry --------------------------------------

    fn sample_telemetry_row(msg_id: &str) -> crate::session_ledger::TurnTelemetryRow {
        crate::session_ledger::TurnTelemetryRow {
            session_id: "s1".to_string(),
            msg_id: msg_id.to_string(),
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            total_cost_usd: 0.0123,
            wall_clock_ms: 4_000,
            awaiting_approval_ms: 200,
            transport_downtime_ms: 100,
            active_ms: 3_700,
            ttft_ms: Some(150),
            ttftc_ms: Some(300),
            reconnect_count: 0,
            max_stream_gap_ms: 90,
            ended_at: 1_000,
            session_init_tokens: Some(18_575),
        }
    }

    /// A `turn_complete` carrying tugcode's JSONL-authoritative
    /// telemetry (cost + sessionInitTokens + turnEndReason + zero
    /// timing) — the line shape the overlay augments.
    fn turn_complete_with_jsonl_telemetry() -> Vec<u8> {
        serde_json::json!({
            "type": "turn_complete",
            "msg_id": "msg-A",
            "seq": 1,
            "result": "success",
            "telemetry": {
                "cost": {
                    "inputTokens": 7,
                    "outputTokens": 8,
                    "cacheCreationInputTokens": 9,
                    "cacheReadInputTokens": 11,
                    "totalCostUsd": 0,
                },
                "wallClockMs": 0,
                "awaitingApprovalMs": 0,
                "transportDowntimeMs": 0,
                "activeMs": 0,
                "ttftMs": serde_json::Value::Null,
                "ttftcMs": serde_json::Value::Null,
                "reconnectCount": 0,
                "maxStreamGapMs": 0,
                "sessionInitTokens": 4_130,
                "turnEndReason": "complete",
            },
            "ipc_version": 2,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn inject_replay_telemetry_overlays_timing_and_preserves_jsonl_cost() {
        // Row-present overlay onto a line that ALREADY carries the
        // JSONL-authoritative cost: the cost must survive byte-for-byte
        // (Risk R02, refute direction) AND every timing key must equal
        // the row's value (the add direction — guards a TIME-popover
        // regression for row-present sessions).
        let line = turn_complete_with_jsonl_telemetry();
        let before: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), sample_telemetry_row("msg-A"));
        let (out, injected) = inject_replay_telemetry(&line, &map);
        assert_eq!(injected, 1);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        let telemetry = parsed.get("telemetry").expect("telemetry present");

        // Cost UNCHANGED — the JSONL value, NOT the row's (100/50/10/20).
        assert_eq!(telemetry["cost"], before["telemetry"]["cost"]);
        assert_eq!(telemetry["cost"]["inputTokens"], 7);
        // sessionInitTokens UNCHANGED — JSONL value, not the row's 18_575.
        assert_eq!(telemetry["sessionInitTokens"], 4_130);
        // turnEndReason UNTOUCHED.
        assert_eq!(telemetry["turnEndReason"], "complete");

        // Timing OVERLAID from the row.
        assert_eq!(telemetry["wallClockMs"], 4_000);
        assert_eq!(telemetry["awaitingApprovalMs"], 200);
        assert_eq!(telemetry["transportDowntimeMs"], 100);
        assert_eq!(telemetry["activeMs"], 3_700);
        assert_eq!(telemetry["ttftMs"], 150);
        assert_eq!(telemetry["ttftcMs"], 300);
        assert_eq!(telemetry["reconnectCount"], 0);
        assert_eq!(telemetry["maxStreamGapMs"], 90);

        // Original top-level fields preserved.
        assert_eq!(parsed["type"], "turn_complete");
        assert_eq!(parsed["msg_id"], "msg-A");
        assert_eq!(parsed["result"], "success");
    }

    #[test]
    fn inject_replay_telemetry_legacy_no_telemetry_attaches_timing_only() {
        // A legacy turn_complete with NO telemetry object (a tugcode
        // predating the cost-on-replay emit): timing is attached, but
        // no cost is invented — the JSONL is the only cost source.
        let line = br#"{"type":"turn_complete","msg_id":"msg-A","seq":1,"result":"success","ipc_version":2}"#;
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), sample_telemetry_row("msg-A"));
        let (out, injected) = inject_replay_telemetry(line, &map);
        assert_eq!(injected, 1);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        let telemetry = parsed
            .get("telemetry")
            .expect("timing-only telemetry attached");
        assert_eq!(telemetry["wallClockMs"], 4_000);
        assert_eq!(telemetry["activeMs"], 3_700);
        // No cost invented from the row.
        assert!(telemetry.get("cost").is_none());
        assert!(telemetry.get("sessionInitTokens").is_none());
    }

    #[test]
    fn inject_replay_telemetry_serializes_null_ttft_fields() {
        let line = turn_complete_with_jsonl_telemetry();
        let mut row = sample_telemetry_row("msg-A");
        row.ttft_ms = None;
        row.ttftc_ms = None;
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), row);
        let (out, _) = inject_replay_telemetry(&line, &map);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert!(parsed["telemetry"]["ttftMs"].is_null());
        assert!(parsed["telemetry"]["ttftcMs"].is_null());
    }

    #[test]
    fn inject_replay_telemetry_passes_through_on_miss() {
        // No row for this msg_id — line returns unchanged (the
        // client reducer's zero-derived block applies, per the
        // "no retroactive backfill" caveat in #step-20-3-4).
        let line = br#"{"type":"turn_complete","msg_id":"unknown","seq":1,"result":"success","ipc_version":2}"#;
        let map: std::collections::HashMap<String, crate::session_ledger::TurnTelemetryRow> =
            std::collections::HashMap::new();
        let (out, injected) = inject_replay_telemetry(line, &map);
        assert_eq!(out, line.to_vec());
        assert_eq!(injected, 0);
    }

    #[test]
    fn inject_replay_telemetry_passes_through_on_no_msg_id() {
        // A turn_complete without msg_id has nothing to look up;
        // pass through unchanged.
        let line = br#"{"type":"turn_complete","seq":1,"result":"success","ipc_version":2}"#;
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), sample_telemetry_row("msg-A"));
        let (out, injected) = inject_replay_telemetry(line, &map);
        assert_eq!(out, line.to_vec());
        assert_eq!(injected, 0);
    }

    #[test]
    fn inject_replay_telemetry_overlays_every_turn_in_a_replay_batch() {
        // The shape cold replay actually emits: committed-turn frames
        // flushed as one `replay_batch` wire line. Each inner
        // `turn_complete` with a persisted row gets its timing; the
        // non-turn frames ride along untouched.
        let batch = serde_json::json!({
            "type": "replay_batch",
            "frames": [
                { "type": "assistant_text", "msg_id": "msg-A", "text": "hello" },
                { "type": "turn_complete", "msg_id": "msg-A", "seq": 1, "result": "success" },
                { "type": "turn_complete", "msg_id": "msg-B", "seq": 2, "result": "success" },
                { "type": "turn_complete", "msg_id": "msg-none", "seq": 3, "result": "success" },
            ],
            "ipc_version": 2,
        })
        .to_string()
        .into_bytes();
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), sample_telemetry_row("msg-A"));
        let mut row_b = sample_telemetry_row("msg-B");
        row_b.active_ms = 11_000;
        map.insert("msg-B".to_string(), row_b);

        let (out, injected) = inject_replay_telemetry(&batch, &map);
        assert_eq!(injected, 2);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        let frames = parsed["frames"].as_array().expect("frames array");

        // The `assistant_text` frame shares msg-A's id but is not a
        // turn boundary — no telemetry is attached to it.
        assert!(frames[0].get("telemetry").is_none());
        assert_eq!(frames[1]["telemetry"]["activeMs"], 3_700);
        assert_eq!(frames[1]["telemetry"]["wallClockMs"], 4_000);
        assert_eq!(frames[2]["telemetry"]["activeMs"], 11_000);
        // No row for msg-none — that frame is left as it arrived.
        assert!(frames[3].get("telemetry").is_none());
        assert_eq!(parsed["ipc_version"], 2);
    }

    #[test]
    fn inject_replay_telemetry_passes_through_a_batch_with_no_matching_turn() {
        // Nothing to overlay — the original bytes forward untouched
        // rather than round-tripping through serde.
        let batch = br#"{"type":"replay_batch","frames":[{"type":"turn_complete","msg_id":"msg-unknown","seq":1}],"ipc_version":2}"#;
        let mut map = std::collections::HashMap::new();
        map.insert("msg-A".to_string(), sample_telemetry_row("msg-A"));
        let (out, injected) = inject_replay_telemetry(batch, &map);
        assert_eq!(out, batch.to_vec());
        assert_eq!(injected, 0);
    }

    #[test]
    fn inject_replay_telemetry_passes_through_on_malformed_json() {
        let line = b"not json at all";
        let map: std::collections::HashMap<String, crate::session_ledger::TurnTelemetryRow> =
            std::collections::HashMap::new();
        let (out, injected) = inject_replay_telemetry(line, &map);
        assert_eq!(out, line.to_vec());
        assert_eq!(injected, 0);
    }

    // ---- parse_session_fork -------------------------------------------

    #[test]
    fn session_fork_needs_all_three_fields() {
        let full =
            br#"{"type":"session_fork","parentSessionId":"p","newSessionId":"n","forkPoint":"u"}"#;
        let parsed = parse_session_fork(full).expect("parses");
        assert_eq!(parsed.parent_session_id, "p");
        assert_eq!(parsed.new_session_id, "n");
        assert_eq!(parsed.fork_point, "u");

        // A fork with no parent, no id, or no branch point has no lineage to
        // allocate — better to spawn it as a root than to guess.
        assert!(
            parse_session_fork(br#"{"type":"session_fork","newSessionId":"n","forkPoint":"u"}"#)
                .is_none()
        );
        assert!(parse_session_fork(
            br#"{"type":"session_fork","parentSessionId":"p","newSessionId":"","forkPoint":"u"}"#
        )
        .is_none());
        assert!(parse_session_fork(b"not json").is_none());
    }

    // ---- parse_session_title ------------------------------------------

    #[test]
    fn session_title_parses_and_rejects_the_empty_cases() {
        assert_eq!(
            parse_session_title(br#"{"type":"session_title","title":"Parser bug"}"#),
            Some("Parser bug".to_owned())
        );
        assert_eq!(
            parse_session_title(br#"{"type":"session_title","title":"  padded  "}"#),
            Some("padded".to_owned())
        );
        assert_eq!(
            parse_session_title(br#"{"type":"session_title","title":"   "}"#),
            None
        );
        assert_eq!(parse_session_title(br#"{"type":"session_title"}"#), None);
        assert_eq!(parse_session_title(b"not json"), None);
    }

    // ---- merge_and_persist_system_metadata ----------------------------

    fn live_system_metadata_line(model: &str) -> Vec<u8> {
        // Mirror what `tugcode/src/session.ts:511-528` emits — rich
        // payload, suffixed model.
        serde_json::json!({
            "type": "system_metadata",
            "session_id": "sess-1",
            "cwd": "/home/user/project",
            "tools": ["Read", "Bash"],
            "model": model,
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
        })
        .to_string()
        .into_bytes()
    }

    fn replay_system_metadata_line(model: &str) -> Vec<u8> {
        // Mirror what `tugcode/src/replay.ts:989-1006` synthesizes —
        // bare model, every other field empty / empty-array.
        serde_json::json!({
            "type": "system_metadata",
            "session_id": "sess-1",
            "cwd": "",
            "tools": [],
            "model": model,
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
        })
        .to_string()
        .into_bytes()
    }

    fn test_tug_session_id() -> TugSessionId {
        TugSessionId::new("test-tug-session")
    }

    #[test]
    fn merge_and_persist_writes_first_observation_verbatim() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();
        let line = live_system_metadata_line("claude-opus-4-7[1m]");
        let out = merge_and_persist_system_metadata(&line, &ledger, "sess-1", &tug_id);
        // Output line carries the full payload.
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["model"], "claude-opus-4-7[1m]");
        assert_eq!(parsed["cwd"], "/home/user/project");
        // Ledger holds the same payload.
        let row = ledger.get_session_metadata("sess-1").unwrap().unwrap();
        let persisted: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
        assert_eq!(persisted["model"], "claude-opus-4-7[1m]");
    }

    #[test]
    fn merge_and_persist_preserves_suffix_on_replay_after_live() {
        // The canary case. Live arrives first, then a bare-model
        // replay-synthesized payload. Without the merge, the wire
        // delivered to the client would carry the bare name and the
        // window-utilization gauge would regress 1M → 200k.
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();

        let live = live_system_metadata_line("claude-opus-4-7[1m]");
        let _ = merge_and_persist_system_metadata(&live, &ledger, "sess-1", &tug_id);

        let replay = replay_system_metadata_line("claude-opus-4-7");
        let out = merge_and_persist_system_metadata(&replay, &ledger, "sess-1", &tug_id);

        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            parsed["model"], "claude-opus-4-7[1m]",
            "bridge intercept must preserve the [1m] suffix across resume",
        );
        // And the persisted payload retains the suffix.
        let row = ledger.get_session_metadata("sess-1").unwrap().unwrap();
        let persisted: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
        assert_eq!(persisted["model"], "claude-opus-4-7[1m]");
    }

    #[test]
    fn merge_and_persist_preserves_non_empty_fields_on_replay() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();

        let _ = merge_and_persist_system_metadata(
            &live_system_metadata_line("claude-opus-4-7[1m]"),
            &ledger,
            "sess-1",
            &tug_id,
        );

        let replay = replay_system_metadata_line("claude-opus-4-7");
        let out = merge_and_persist_system_metadata(&replay, &ledger, "sess-1", &tug_id);

        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["cwd"], "/home/user/project");
        assert_eq!(parsed["permissionMode"], "default");
        assert_eq!(parsed["version"], "2.1.105");
        assert_eq!(parsed["apiKeySource"], "anthropic");
        // Array fields too.
        assert_eq!(parsed["tools"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["slash_commands"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["skills"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn merge_and_persist_passes_through_on_malformed_incoming() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();
        let line = b"not valid json";
        let out = merge_and_persist_system_metadata(line, &ledger, "sess-1", &tug_id);
        assert_eq!(
            out,
            line.to_vec(),
            "malformed incoming returns the line unchanged"
        );
        // And nothing was written to the ledger.
        assert!(ledger.get_session_metadata("sess-1").unwrap().is_none());
    }

    #[test]
    fn merge_and_persist_passes_through_when_incoming_is_not_an_object() {
        // The merge returns an empty map for a non-object incoming;
        // the helper detects that and forwards unchanged rather than
        // emitting `{}` on the wire.
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();
        let line = br#""just a string""#;
        let out = merge_and_persist_system_metadata(line, &ledger, "sess-1", &tug_id);
        assert_eq!(out, line.to_vec());
        assert!(ledger.get_session_metadata("sess-1").unwrap().is_none());
    }

    #[test]
    fn merge_and_persist_idempotent_on_repeat_writes() {
        // Steady-state operation: the same payload is forwarded
        // multiple times (e.g., reconnect → live session_init → live
        // session_init again). The merged output is byte-stable and
        // the ledger row is overwritten with the same bytes.
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();
        let line = live_system_metadata_line("claude-opus-4-7[1m]");
        let out1 = merge_and_persist_system_metadata(&line, &ledger, "sess-1", &tug_id);
        let out2 = merge_and_persist_system_metadata(&line, &ledger, "sess-1", &tug_id);
        let parsed1: serde_json::Value = serde_json::from_slice(&out1).unwrap();
        let parsed2: serde_json::Value = serde_json::from_slice(&out2).unwrap();
        assert_eq!(parsed1, parsed2);
    }

    #[test]
    fn merge_and_persist_upgrades_when_suffix_arrives_second() {
        // Symmetric edge: bare arrives first, suffix arrives second.
        // The wire must surface the upgrade so the client window-
        // utilization gauge picks up 1M.
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let tug_id = test_tug_session_id();
        let _ = merge_and_persist_system_metadata(
            &replay_system_metadata_line("claude-opus-4-7"),
            &ledger,
            "sess-1",
            &tug_id,
        );
        let out = merge_and_persist_system_metadata(
            &live_system_metadata_line("claude-opus-4-7[1m]"),
            &ledger,
            "sess-1",
            &tug_id,
        );
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["model"], "claude-opus-4-7[1m]");
    }
}
