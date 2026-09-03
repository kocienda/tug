//! Common test helpers for the tugcast multi-session integration tests.
//!
//! # Runtime shape
//!
//! These helpers spawn `tugcast` as a subprocess via
//! `env!("CARGO_BIN_EXE_tugcast")`. Integration tests live in
//! `tugrust/crates/tugcast/tests/*.rs`, outside the crate's library
//! scope, so they cannot import tugcast internals directly — the
//! binary-as-subprocess pattern is the canonical Cargo approach for
//! end-to-end coverage of a bin-only crate.
//!
//! # Env gating
//!
//! The tests that consume these helpers are all gated on
//! `TUG_REAL_CLAUDE=1` via both `#[ignore]` on the test function AND an
//! early-return check on the env var at the top of each test body
//! (belt-and-suspenders). A real `claude` (tugcode) binary must be
//! available at runtime — the helpers themselves compile
//! unconditionally so `cargo build --tests -p tugcast` passes clean in
//! every environment.
//!
//! # Isolation
//!
//! Each invocation of [`TestTugcast::spawn`] binds an ephemeral TCP
//! port (so parallel test runs cannot collide), uses a per-test tugbank
//! path (so persisted session keys cannot leak between tests), and
//! creates a per-test tmux session name derived from the port.
//! `TUGBANK_PATH` is set on the spawned subprocess so the downstream
//! tugcode singleton points at the same per-test file.
//!
//! # Frame-preserving WebSocket wrapper
//!
//! [`TestWs`] wraps a client [`WsStream`] with an internal `Vec` of
//! decoded frames. Every helper (`await_session_state`,
//! `collect_code_output`, ...) scans the buffer first and only pulls
//! new frames from the socket when the buffer cannot satisfy the
//! request. Matching frames are removed from the buffer as they are
//! consumed; non-matching frames stay put. This preserves the
//! invariant that "a drain helper never drops frames you care about",
//! which is what two-session tests rely on — without it, a collector
//! looking for session A's frames would eat session B's frames as
//! collateral damage and leave B's later `collect_code_output` call
//! with nothing to see.

#![allow(dead_code)]

pub mod catalog;
pub mod probes;

use std::collections::HashMap;
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tugcast_core::{FeedId, Frame};

/// Alias for the fully-typed client-side WebSocket stream.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Shared handle to the client-side sink half of a split [`WsStream`].
///
/// Held by both [`TestWs`] (for test-driven sends: `send_code_input`,
/// `send_control_action`, ...) and the background heartbeat task spawned
/// in [`TestWs::connect`]. The async mutex serializes the two writers so
/// a test send never interleaves bytes with a heartbeat send. `tokio`'s
/// async `Mutex` is cheap under low contention — a heartbeat fires every
/// 15 s and test sends are sparse.
type SharedSink = Arc<AsyncMutex<SplitSink<WsStream, Message>>>;

/// Interval between client-side heartbeat sends. Matches tugdeck's
/// `HEARTBEAT_INTERVAL_MS` in `tugdeck/src/connection.ts` so `TestWs`
/// observes the same liveness contract as the browser client. The
/// server-side timeout in `tugcast/src/router.rs::HEARTBEAT_TIMEOUT`
/// is 45 s; sending every 15 s gives a 2-tick grace before the router
/// tears the connection down.
const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Returns `true` if `TUG_REAL_CLAUDE` is set to a truthy value. Tests
/// gate every real-claude scenario on this so `cargo nextest run` in
/// the default suite never tries to spawn a real Claude Code subprocess.
pub fn real_claude_enabled() -> bool {
    match std::env::var("TUG_REAL_CLAUDE") {
        Ok(v) => v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes"),
        Err(_) => false,
    }
}

/// Mint a fresh session id for a real-claude test or capture probe.
///
/// claude 2.1.x validates `--session-id` / `--resume` and rejects any
/// value that is not a UUID (`Error: Invalid session ID. Must be a
/// valid UUID.`). The tug session id is forwarded verbatim to claude,
/// so test session ids must be real UUIDs — human-readable labels like
/// `"sess-foo"` make the spawned claude process exit before emitting a
/// single event. Production is unaffected: tugdeck always generates
/// UUID session ids.
pub fn fresh_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Reserve an ephemeral TCP port by binding-then-releasing. The port
/// may be reclaimed by another process in between, but for integration
/// tests on a mostly-idle loopback this is good enough and simpler than
/// plumbing a pre-bound listener into tugcast.
fn ephemeral_port() -> u16 {
    let listener = StdTcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

/// A running tugcast subprocess for integration tests. Dropping the
/// handle kills the child (`kill_on_drop(true)`) and also issues a
/// `tmux kill-session` for the per-test session name before the child
/// falls — see [`TestTugcast::drop_cleanup`] and the `Drop` impl below
/// for why we need both.
pub struct TestTugcast {
    pub child: Child,
    pub port: u16,
    pub bank_path: PathBuf,
    /// Canonical project dir this tugcast was spawned with. Required field
    /// on every `spawn_session` control frame (commit
    /// b1ba1a97); exposed here so callers don't have to re-derive it.
    pub project_dir: PathBuf,
    /// Owns this spawn's changes DB. Held so the directory — and the
    /// `-wal`/`-shm` siblings SQLite puts beside the file — is removed
    /// when the handle drops, instead of being left in `$TMPDIR`.
    _changes_db_dir: tempfile::TempDir,
}

/// Runs exactly once per test process, on the first [`TestTugcast::spawn`]
/// call. Scans tmux for leftover `tug-test-<port>` sessions whose port
/// is no longer bound — those are orphans from prior test runs that
/// crashed before their `Drop` fired — and kills them. Defense-in-depth
/// alongside the per-test `Drop` cleanup below.
static STARTUP_REAPER: std::sync::OnceLock<()> = std::sync::OnceLock::new();

/// Reap stale `tug-test-*` tmux sessions from prior crashed test runs.
///
/// We only touch sessions whose name starts with `tug-test-` AND whose
/// embedded port number is not currently bound by a listening process.
/// Sessions with a live port are assumed to belong to a concurrent test
/// run and left alone. Everything else (the developer's own `cc0`
/// session, any other tmux workflow) is ignored — the prefix check is
/// the sole authority on what we consider ours to kill.
fn reap_stale_tug_test_sessions() {
    use std::net::TcpStream;

    // `tmux list-sessions -F '#S'` prints one session name per line,
    // or errors out with "no server running" if no tmux server is up.
    // Both are fine — no sessions means nothing to reap.
    let output = std::process::Command::new("tmux")
        .args(["list-sessions", "-F", "#S"])
        .output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Some(port_str) = line.strip_prefix("tug-test-") else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        // A bound port means a live concurrent test owns this session;
        // leave it alone. Unbound means the session is an orphan from
        // a test that died before its `Drop` fired — kill it.
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            continue;
        }
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", line])
            .output();
    }
}

impl TestTugcast {
    /// Spawn tugcast as a subprocess bound to an ephemeral port.
    ///
    /// `--no-auth` disables the session cookie + origin check so the
    /// test WebSocket client can upgrade without minting a token.
    /// `--bank-path` + `TUGBANK_PATH` are per-test so parallel runs
    /// cannot collide on `~/.tugbank.db`. The tmux session name is
    /// derived from the port so each test owns a distinct session.
    pub async fn spawn(project_dir: &Path, bank_path: PathBuf) -> Self {
        // Defense-in-depth (C): on the first spawn in this test process,
        // reap any leftover `tug-test-*` tmux sessions from prior crashed
        // runs. Covers the gap where a test died before Drop could fire
        // (SIGKILL on the test binary itself, kernel panic, user Ctrl-C
        // before the signal handler) and avoids hitting the macOS pty
        // exhaustion point that causes `fork failed: Device not configured`.
        STARTUP_REAPER.get_or_init(reap_stale_tug_test_sessions);

        let port = ephemeral_port();
        let bin = env!("CARGO_BIN_EXE_tugcast");
        // `TUGBANK_PATH` is set explicitly so the spawned tugcast AND
        // the downstream tugcode subprocess both point at the per-test
        // bank file. Without the env var tugcode's tugbank singleton
        // defaults to `~/.tugbank.db` and reads the developer's real
        // persisted session-id map (`dev.tugtool.dev /
        // session-id-by-workspace` post-4i; previously a single global
        // `(dev.tugtool.app, session-id)` key) — which makes tugcode
        // boot with `--resume <stale-uuid>`, which claude rejects,
        // which causes every live-session test to hang.
        // Scrub Anthropic auth env vars so the downstream claude CLI falls
        // back to `~/.claude.json` (the user's Max/Pro subscription login)
        // instead of per-token API billing via `ANTHROPIC_API_KEY`. Without
        // this, whatever key is exported in the developer's shell flows
        // through tugcast → tugcode → claude and every test run bills the
        // API account instead of the subscription. The scrub list lives
        // in `catalog::AUTH_ENV_VARS` so adding a new variable touches
        // exactly one site. See `capture_all_probes`'s and
        // `stream_json_catalog_drift_regression`'s pre-flight refusal.
        let mut command = Command::new(bin);
        command
            .arg("--port")
            .arg(port.to_string())
            .arg("--source-tree")
            .arg(project_dir)
            .arg("--no-auth")
            .arg("--session")
            .arg(format!("tug-test-{port}"))
            .arg("--bank-path")
            .arg(&bank_path)
            .env("TUGBANK_PATH", &bank_path)
            // Point tugcode at the repo's `tugplug/` so the spawned claude
            // loads the project's skills/agents/commands. tugcode's
            // `resolvePluginDir` resolves `--plugin-dir` from
            // `TUG_PLUGIN_DIR` first, else a bundled app-resource path
            // (`../Resources/tugplug` beside the binary) that does NOT
            // exist for the dev `target/debug/tugcode` used here — so
            // without this override the capture runs tugplug-LESS and
            // bakes the developer's ambient `~/.claude` config into the
            // golden (empty `plugins`, no `tugplug:` commands). This is
            // the explicit dev-harness injection that resolver documents;
            // it restores the contract `execute_probe`'s tugplug-prereq
            // comment assumes.
            .env("TUG_PLUGIN_DIR", project_dir.join("tugplug"))
            .stdout(Stdio::null())
            // Pipe stderr (instead of inheriting) and forward it line-by-line
            // to stdout below. Reason: macOS terminals render stderr in red,
            // which paints every diagnostic line from tugcast/tugcode/claude
            // as if it were an error. Rerouting through stdout keeps the
            // content visible without the false-alarm coloring.
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for var in catalog::AUTH_ENV_VARS {
            command.env_remove(var);
        }
        // Scrub the host app's per-instance identity/resource env vars.
        // When the suite runs from inside a Tug Session card terminal, the
        // launching app exports these into the environment; without the
        // scrub the spawned tugcast adopts the *live* instance's identity
        // — refused by the duplicate-launch guard (exit 73, so it never
        // binds and the test times out) and, worse, writing into that
        // instance's data dir, registry, sockets, and tmux. They are
        // unset under CI, so this is a no-op there and makes a local
        // run match CI: `instance_id()` resolves to `None`, giving
        // hermetic legacy paths with resources served from `--source-tree`.
        for var in [
            "TUG_INSTANCE_ID",
            "TUG_BUNDLE_PATH",
            "TUGCAST_RESOURCE_ROOT",
        ] {
            command.env_remove(var);
        }
        // Point the machine-global changes ledger at a per-process temp file
        // so a spawned tugcast never writes attribution rows into the
        // developer's real ~/Library/Application Support/Tug/changes.db.
        let changes_db_dir = tempfile::Builder::new()
            .prefix("tugcast-test-changes-")
            .tempdir()
            .expect("changes db tempdir");
        command.env("TUG_CHANGES_DB", changes_db_dir.path().join("changes.db"));
        let mut child = command.spawn().expect("failed to spawn tugcast");
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    println!("{line}");
                }
            });
        }
        wait_for_port(port, Duration::from_secs(5)).await;
        Self {
            child,
            port,
            bank_path,
            project_dir: project_dir.to_path_buf(),
            _changes_db_dir: changes_db_dir,
        }
    }
}

/// Primary fix (A): when a `TestTugcast` handle is dropped — at the end
/// of every test, on normal exit and on panic — issue a `tmux
/// kill-session -t tug-test-<port>` before the child falls. Without
/// this, `kill_on_drop(true)` sends SIGKILL to the tugcast process but
/// the tmux session it created lives on in the tmux server daemon's
/// process tree, where no child-reaping machinery can reach it. Over
/// dozens of test runs, orphans accumulated into the hundreds until the
/// macOS pty pool was exhausted and new sessions started failing with
/// `fork failed: Device not configured`. Rust runs `impl Drop::drop`
/// *before* dropping struct fields, so the kill-session runs while the
/// child is still alive and the tmux session name is still valid.
impl Drop for TestTugcast {
    fn drop(&mut self) {
        let session_name = format!("tug-test-{}", self.port);
        // Best-effort: swallow errors. If tmux isn't installed, if the
        // session was already killed, or if the tmux server died, we
        // still want the rest of the drop sequence to run.
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &session_name])
            .output();
        // `self.child` is dropped after this method returns, which
        // triggers `kill_on_drop(true)` and SIGKILLs tugcast. By that
        // point the tmux session is already gone.
    }
}

async fn wait_for_port(port: u16, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .is_ok()
        {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("tugcast did not bind port {port} within {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// TestWs — frame-preserving client-side WebSocket wrapper
// ---------------------------------------------------------------------------

/// A decoded WebSocket frame held in [`TestWs`]'s buffer.
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub feed_id: FeedId,
    pub payload: serde_json::Value,
}

/// Client-side WebSocket wrapper with a frame-preserving buffer.
///
/// See the module JSDoc-equivalent comment at the top of this file for
/// the rationale.
///
/// # Heartbeat contract (P19 fix)
///
/// The tugcast router in `src/router.rs` enforces a 45 s application-
/// level heartbeat: it sends a `FeedId::HEARTBEAT` frame every 15 s and
/// expects the client to send one back. If no client heartbeat arrives
/// within `HEARTBEAT_TIMEOUT` (45 s), the router calls
/// `teardown_client` and drops the socket without a close frame —
/// observable to a passive client as `Connection reset without closing
/// handshake` at ~45 055 ms (P19 heartbeat regression).
///
/// `TestWs::connect` spawns a background task that sends a heartbeat
/// frame every [`TEST_HEARTBEAT_INTERVAL`] for the lifetime of the
/// socket. The task shares the split sink with the test-driven
/// send helpers via [`SharedSink`]. The handle is aborted in `Drop`
/// so a TestWs that outlives its TestTugcast doesn't leak tasks.
pub struct TestWs {
    sink: SharedSink,
    stream: SplitStream<WsStream>,
    buffer: Vec<DecodedFrame>,
    heartbeat_task: JoinHandle<()>,
}

impl TestWs {
    /// Open a WebSocket client to `127.0.0.1:port/ws` and perform the
    /// v1 protocol handshake. Also starts the heartbeat background task
    /// so the server's 45 s liveness timer cannot trip during long
    /// capture probes.
    pub async fn connect(port: u16) -> Self {
        let url = format!("ws://127.0.0.1:{port}/ws");
        let (ws, _) = connect_async(url).await.expect("ws connect");
        let (mut sink, stream) = ws.split();
        let hello = r#"{"protocol":"tugcast","version":1}"#;
        sink.send(Message::Text(hello.into()))
            .await
            .expect("send protocol hello");
        let sink: SharedSink = Arc::new(AsyncMutex::new(sink));
        let heartbeat_task = Self::spawn_heartbeat_task(Arc::clone(&sink));
        Self {
            sink,
            stream,
            buffer: Vec::new(),
            heartbeat_task,
        }
    }

    /// Spawn a detached tokio task that sends a `HEARTBEAT` frame every
    /// [`TEST_HEARTBEAT_INTERVAL`] for the lifetime of the returned
    /// handle. The task exits on the first send error (socket closed),
    /// and the handle is aborted in `TestWs::drop` on the normal path.
    fn spawn_heartbeat_task(sink: SharedSink) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(TEST_HEARTBEAT_INTERVAL);
            // `interval.tick()` fires immediately on first poll — eat
            // the zero-delay tick so the first heartbeat goes out one
            // full interval after connect, matching tugdeck's timer.
            interval.tick().await;
            loop {
                interval.tick().await;
                let hb = Frame::heartbeat();
                let mut guard = sink.lock().await;
                if guard
                    .send(Message::Binary(hb.encode().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        })
    }

    /// Pull frames from the socket into the buffer until either the
    /// given `predicate` matches an entry in the buffer OR the deadline
    /// expires. Returns the index of the matched buffer entry (the
    /// caller decides whether to remove it).
    async fn pump_until<F>(&mut self, deadline: Instant, mut predicate: F) -> Result<usize, String>
    where
        F: FnMut(&DecodedFrame) -> bool,
    {
        // Fast path: already buffered.
        if let Some((i, _)) = self.buffer.iter().enumerate().find(|(_, f)| predicate(f)) {
            return Ok(i);
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("pump_until: timed out".into());
            }
            match tokio::time::timeout(remaining, self.stream.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) => {
                    let Ok((frame, _)) = Frame::decode(&bytes) else {
                        continue;
                    };
                    let payload = match serde_json::from_slice::<serde_json::Value>(&frame.payload)
                    {
                        Ok(v) => v,
                        Err(_) => serde_json::Value::Null,
                    };
                    let decoded = DecodedFrame {
                        feed_id: frame.feed_id,
                        payload,
                    };
                    let matched = predicate(&decoded);
                    self.buffer.push(decoded);
                    if matched {
                        return Ok(self.buffer.len() - 1);
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(e))) => return Err(format!("pump_until: ws recv error: {e}")),
                Ok(None) => return Err("pump_until: ws closed".into()),
                Err(_) => return Err("pump_until: timed out".into()),
            }
        }
    }

    /// Send a CONTROL frame carrying `{ action, card_id, tug_session_id }`.
    async fn send_control_action(&mut self, action: &str, card_id: &str, tug_session_id: &str) {
        let payload = serde_json::json!({
            "action": action,
            "card_id": card_id,
            "tug_session_id": tug_session_id,
        });
        let bytes = serde_json::to_vec(&payload).expect("control json");
        let frame = Frame::new(FeedId::CONTROL, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send control frame");
    }

    pub async fn send_spawn_session(
        &mut self,
        card_id: &str,
        tug_session_id: &str,
        project_dir: &Path,
    ) {
        // project_dir is a required field on
        // the spawn_session control payload. Without it, the supervisor
        // rejects with `InvalidProjectDir { reason: "missing_project_dir" }`
        // before emitting the `pending` SESSION_STATE transition — which
        // manifests as a 10s `await_session_state("pending")` timeout
        // downstream.
        //
        // `line_id` is required on the same terms: a `mode=new` spawn that
        // names no line is refused with `MissingLineId` ([P03]) before any
        // state transition, with the same 10s-timeout symptom. The deck mints
        // the id from the drop (`crypto.randomUUID()` in
        // `tugdeck/src/lib/session-lifecycle.ts`); the harness mints its own
        // the same way, one per spawn.
        let payload = serde_json::json!({
            "action": "spawn_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
            "project_dir": project_dir.to_string_lossy(),
            "line_id": uuid::Uuid::new_v4().to_string(),
        });
        let bytes = serde_json::to_vec(&payload).expect("control json");
        let frame = Frame::new(FeedId::CONTROL, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send control frame");
    }

    pub async fn send_close_session(&mut self, card_id: &str, tug_session_id: &str) {
        self.send_control_action("close_session", card_id, tug_session_id)
            .await;
    }

    /// Send a GIT_DIFF_QUERY frame carrying `{ root?, requestId }` — the
    /// `/diff` request ([#step-10a]). `root: None` exercises the bootstrap
    /// fall-back (the `--source-tree` workspace the test spawned tugcast on).
    pub async fn send_git_diff_query(&mut self, root: Option<&Path>, request_id: &str) {
        let mut payload = serde_json::json!({ "requestId": request_id });
        if let Some(root) = root {
            payload["root"] = serde_json::Value::String(root.to_string_lossy().into_owned());
        }
        let bytes = serde_json::to_vec(&payload).expect("git_diff_query json");
        let frame = Frame::new(FeedId::GIT_DIFF_QUERY, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send git_diff_query frame");
    }

    /// Wait for the single-shot GIT_DIFF response whose `request_id` matches,
    /// returning its payload and removing it from the buffer ([#step-10a]).
    pub async fn await_git_diff(
        &mut self,
        request_id: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::GIT_DIFF && f.payload["request_id"] == request_id
            })
            .await?;
        Ok(self.buffer.remove(idx).payload)
    }

    pub async fn send_git_log_query(
        &mut self,
        root: Option<&Path>,
        request_id: &str,
        limit: Option<u32>,
    ) {
        let mut payload = serde_json::json!({ "requestId": request_id });
        if let Some(root) = root {
            payload["root"] = serde_json::Value::String(root.to_string_lossy().into_owned());
        }
        if let Some(limit) = limit {
            payload["limit"] = serde_json::Value::from(limit);
        }
        let bytes = serde_json::to_vec(&payload).expect("git_log_query json");
        let frame = Frame::new(FeedId::GIT_LOG_QUERY, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send git_log_query frame");
    }

    /// Wait for the single-shot GIT_LOG response whose `request_id` matches,
    /// returning its payload and removing it from the buffer.
    pub async fn await_git_log(
        &mut self,
        request_id: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::GIT_LOG && f.payload["request_id"] == request_id
            })
            .await?;
        Ok(self.buffer.remove(idx).payload)
    }

    /// Wait for a GIT_HEAD signal for `workspace_key`, returning its payload and
    /// removing it from the buffer. The signal is server-initiated (no request),
    /// so it correlates by workspace, not request_id.
    pub async fn await_git_head(
        &mut self,
        workspace_key: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::GIT_HEAD && f.payload["workspace_key"] == workspace_key
            })
            .await?;
        Ok(self.buffer.remove(idx).payload)
    }

    pub async fn send_reset_session(&mut self, card_id: &str, tug_session_id: &str) {
        self.send_control_action("reset_session", card_id, tug_session_id)
            .await;
    }

    /// Send a CODE_INPUT frame shaped per tugcode's `UserMessage` type.
    /// `tug_session_id` rides along as an extra field — tugcode ignores
    /// it, tugcast's router parses it via `parse_tug_session_id` to
    /// route to the right per-session worker.
    ///
    /// The payload is shaped per the post-Step-5c content-block wire
    /// (`tugcode/src/types.ts`'s `UserMessage` + `ContentBlock`):
    /// `content: [{type: "text", text: <prompt>}]`. The pre-Step-5c
    /// `{text, attachments}` shape passes `isUserMessage` (which only
    /// gates on `type`) but lands as `msg.content === undefined` in
    /// `handleUserMessage`, which forwards a content-less message to
    /// claude — claude 2.1.154 + `--replay-user-messages` silently
    /// exits on that malformed input and the capture aborts at [D11].
    pub async fn send_code_input(&mut self, tug_session_id: &str, prompt: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "user_message",
            "content": [{"type": "text", "text": prompt}],
        });
        let bytes = serde_json::to_vec(&payload).expect("code_input json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send code_input frame");
    }

    /// Send a `user_message` carrying a text prompt plus one or more
    /// image attachments. Each attachment is a pre-built JSON object
    /// with `filename`, `content` (base64-encoded), and `media_type`
    /// (`ProbeMsg::UserMessageWithAttachments`'s static-data shape).
    ///
    /// Each attachment is projected into a post-Step-5c `image`
    /// content block — `{type: "image", source: {type: "base64",
    /// media_type, data}}` per
    /// `tugcode/src/types.ts:ContentBlockImage`. `filename` is dropped:
    /// the live wire shape no longer carries it (the journal's legacy
    /// `filename` column is reconstructed via
    /// `derive_legacy_journal_view`, which hardcodes empty).
    pub async fn send_user_message_with_attachments(
        &mut self,
        tug_session_id: &str,
        text: &str,
        attachments: Vec<serde_json::Value>,
    ) {
        let mut content: Vec<serde_json::Value> =
            vec![serde_json::json!({"type": "text", "text": text})];
        for att in &attachments {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": att.get("media_type").cloned()
                        .unwrap_or(serde_json::Value::String(String::new())),
                    "data": att.get("content").cloned()
                        .unwrap_or(serde_json::Value::String(String::new())),
                },
            }));
        }
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "user_message",
            "content": content,
        });
        let bytes = serde_json::to_vec(&payload).expect("user_message_with_attachments json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send user_message_with_attachments frame");
    }

    // -----------------------------------------------------------------
    // Control-flow CODE_INPUT helpers
    //
    // Each helper serializes a typed tugcode inbound message into a
    // CODE_INPUT frame. The router's `CODE_INPUT` path is opaque
    // pass-through ([Q01]) — tugcast never inspects the payload beyond
    // the `tug_session_id` field.
    // Tugcode is the authority on message validation.
    // -----------------------------------------------------------------

    /// Send an `interrupt` control message to stop the current turn.
    /// Per transport-exploration.md Test 6, interrupt produces
    /// `turn_complete` with `result: "error"` (not a separate
    /// `turn_cancelled` event).
    pub async fn send_interrupt(&mut self, tug_session_id: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "interrupt",
        });
        let bytes = serde_json::to_vec(&payload).expect("interrupt json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send interrupt frame");
    }

    /// Answer a `control_request_forward` carrying a permission
    /// prompt. Shape per transport-exploration.md Test 11.
    /// `updated_input` and `message` are optional and omitted when
    /// `None`.
    pub async fn send_tool_approval(
        &mut self,
        tug_session_id: &str,
        request_id: &str,
        decision: &str,
        updated_input: Option<serde_json::Value>,
        message: Option<&str>,
    ) {
        let mut payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "tool_approval",
            "request_id": request_id,
            "decision": decision,
        });
        let obj = payload
            .as_object_mut()
            .expect("tool_approval payload is object");
        if let Some(input) = updated_input {
            obj.insert("updatedInput".to_string(), input);
        }
        if let Some(msg) = message {
            obj.insert(
                "message".to_string(),
                serde_json::Value::String(msg.to_string()),
            );
        }
        let bytes = serde_json::to_vec(&payload).expect("tool_approval json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send tool_approval frame");
    }

    /// Answer a `control_request_forward` carrying an
    /// `AskUserQuestion` prompt. Shape per the "Inbound Message Types"
    /// table in transport-exploration.md.
    pub async fn send_question_answer(
        &mut self,
        tug_session_id: &str,
        request_id: &str,
        answers: serde_json::Value,
    ) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "question_answer",
            "request_id": request_id,
            "answers": answers,
        });
        let bytes = serde_json::to_vec(&payload).expect("question_answer json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send question_answer frame");
    }

    /// Send a `session_command` message (`"new"` | `"continue"` |
    /// `"fork"`). Per transport-exploration.md Tests 13, 17, 20, `new`
    /// and `fork` kill and respawn the underlying claude subprocess
    /// (readiness gap); `continue` is in-place with context preserved.
    pub async fn send_session_command(&mut self, tug_session_id: &str, command: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "session_command",
            "command": command,
        });
        let bytes = serde_json::to_vec(&payload).expect("session_command json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send session_command frame");
    }

    /// Send a `model_change` message. Per transport-exploration.md
    /// Test 16, this produces a synthetic `assistant_text` confirming
    /// the change and updates `system_metadata.model` on the next
    /// turn.
    pub async fn send_model_change(&mut self, tug_session_id: &str, model: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "model_change",
            "model": model,
        });
        let bytes = serde_json::to_vec(&payload).expect("model_change json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send model_change frame");
    }

    /// Send a `permission_mode` message. Per the "Inbound Message
    /// Types" catalog in transport-exploration.md, mode ∈
    /// {`"default"`, `"acceptEdits"`, `"bypassPermissions"`, ...}.
    pub async fn send_permission_mode(&mut self, tug_session_id: &str, mode: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "permission_mode",
            "mode": mode,
        });
        let bytes = serde_json::to_vec(&payload).expect("permission_mode json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send permission_mode frame");
    }

    /// Send a `rewind_preview` message — the `/rewind` diff-stat preview
    /// for the turn anchored at `prompt_uuid` ([#step-7-1]). tugcode
    /// issues a `rewind_files{dry_run:true}` control request and relays
    /// the `control_response` as a `rewind_preview_result`.
    pub async fn send_rewind_preview(&mut self, tug_session_id: &str, prompt_uuid: &str) {
        let payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "rewind_preview",
            "promptUuid": prompt_uuid,
        });
        let bytes = serde_json::to_vec(&payload).expect("rewind_preview json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send rewind_preview frame");
    }

    /// Send a `session_rewind` message — apply a `/rewind` to the turn
    /// anchored at `prompt_uuid` ([#step-7-1]/[#step-7-2]). `scope` ∈
    /// {`"code"`, `"conversation"`, `"both"`}; the code dimension reverts the
    /// working tree via `rewind_files{dry_run:false}`, the conversation
    /// dimension truncates the JSONL + silent-respawns. `fork` (conversation/
    /// both only): `None` omits the flag (tugcode's default = fork into a new
    /// session id), `Some(false)` requests the destructive in-place variant.
    pub async fn send_session_rewind(
        &mut self,
        tug_session_id: &str,
        prompt_uuid: &str,
        scope: &str,
        fork: Option<bool>,
    ) {
        let mut payload = serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "session_rewind",
            "promptUuid": prompt_uuid,
            "scope": scope,
        });
        if let Some(fork) = fork {
            payload["fork"] = serde_json::Value::Bool(fork);
        }
        let bytes = serde_json::to_vec(&payload).expect("session_rewind json");
        let frame = Frame::new(FeedId::CODE_INPUT, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send session_rewind frame");
    }

    /// Wait for a `SESSION_STATE` frame whose payload announces
    /// `target_state` for `tug_session_id`. Consumes the matching frame
    /// from the buffer on success.
    pub async fn await_session_state(
        &mut self,
        tug_session_id: &str,
        target_state: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::SESSION_STATE
                    && f.payload["tug_session_id"] == tug_session_id
                    && f.payload["state"] == target_state
            })
            .await?;
        self.buffer.remove(idx);
        Ok(())
    }

    /// Wait for the first `CODE_OUTPUT` event for `tug_session_id`
    /// whose `type` field matches `event_type`. Returns the matching
    /// frame's payload and removes it from the buffer. Non-matching
    /// frames stay buffered for later collectors.
    ///
    /// Useful when a test needs to inspect a mid-stream event (e.g.,
    /// `control_request_forward` to extract a `request_id`, or
    /// `session_init` to capture the underlying `session_id`) without
    /// waiting for the terminal `turn_complete`.
    pub async fn await_code_output_event(
        &mut self,
        tug_session_id: &str,
        event_type: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::CODE_OUTPUT
                    && f.payload["tug_session_id"] == tug_session_id
                    && f.payload["type"] == event_type
            })
            .await?;
        let frame = self.buffer.remove(idx);
        Ok(frame.payload)
    }

    /// Non-consuming variant of [`await_code_output_event`]. Pumps
    /// until a matching CODE_OUTPUT event appears, returns a **clone**
    /// of its payload, and leaves the frame in the buffer so a
    /// subsequent [`collect_code_output`] still picks it up.
    ///
    /// Used by the golden stream-json catalog capture binary: when a
    /// probe script does `WaitForEvent { control_request_forward }` to
    /// extract a `request_id`, the forward itself is part of the shape
    /// the fixture records — it must not be consumed or the
    /// resulting JSONL is missing an event claude actually emitted.
    pub async fn peek_code_output_event(
        &mut self,
        tug_session_id: &str,
        event_type: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::CODE_OUTPUT
                    && f.payload["tug_session_id"] == tug_session_id
                    && f.payload["type"] == event_type
            })
            .await?;
        Ok(self.buffer[idx].payload.clone())
    }

    /// Collect `CODE_OUTPUT` payloads for `tug_session_id` from the
    /// buffer (pulling more from the socket as needed) until one with
    /// `type == "turn_complete"` is consumed. Non-matching frames (for
    /// other sessions or other feed ids) remain in the buffer for
    /// future helpers to consume.
    pub async fn collect_code_output(
        &mut self,
        tug_session_id: &str,
        timeout: Duration,
    ) -> Result<Vec<serde_json::Value>, String> {
        self.collect_code_output_until(tug_session_id, "turn_complete", timeout)
            .await
    }

    /// Like [`collect_code_output`], but the terminator event type is
    /// explicit. Used by probes that continue PAST `turn_complete` — the
    /// `/rewind` round-trip ([#step-7-1]) issues its `rewind_preview` /
    /// `session_rewind` while the session is idle, so its
    /// `rewind_preview_result` / `rewind_result` land after the turn's
    /// own `turn_complete`. Collecting until `rewind_result` captures
    /// the full round-trip into the fixture.
    pub async fn collect_code_output_until(
        &mut self,
        tug_session_id: &str,
        terminator_type: &str,
        timeout: Duration,
    ) -> Result<Vec<serde_json::Value>, String> {
        match self
            .collect_code_output_until_partial(tug_session_id, terminator_type, timeout)
            .await
        {
            (events, None) => Ok(events),
            (_, Some(reason)) => Err(reason),
        }
    }

    /// Like [`collect_code_output_until`], but a timeout or socket error
    /// hands back the frames collected so far alongside the reason instead
    /// of dropping them.
    ///
    /// A turn that never reaches its terminator is only diagnosable from the
    /// tail it did produce. Discarding that tail renders a hung turn
    /// indistinguishable from a session that emitted nothing at all — and
    /// downstream the difference is stark: the catalog differ reads an empty
    /// event list as every event type having vanished from the protocol, and
    /// reports a stalled probe as catastrophic drift.
    ///
    /// `Some(reason)` means the terminator never arrived; the returned events
    /// are a partial prefix and must not be treated as a complete turn.
    pub async fn collect_code_output_until_partial(
        &mut self,
        tug_session_id: &str,
        terminator_type: &str,
        timeout: Duration,
    ) -> (Vec<serde_json::Value>, Option<String>) {
        let deadline = Instant::now() + timeout;
        let mut out = Vec::new();
        loop {
            let idx_opt = self.buffer.iter().position(|f| {
                f.feed_id == FeedId::CODE_OUTPUT && f.payload["tug_session_id"] == tug_session_id
            });
            if let Some(i) = idx_opt {
                let f = self.buffer.remove(i);
                let is_terminator = f.payload["type"].as_str() == Some(terminator_type);
                out.push(f.payload);
                if is_terminator {
                    return (out, None);
                }
                continue;
            }
            // Buffer exhausted for this session — pull one more frame
            // into the buffer via pump_until with a never-matching
            // predicate (we only use pump_until's side effect of
            // growing the buffer by exactly one frame).
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return (out, Some("collect_code_output: timed out".into()));
            }
            match tokio::time::timeout(remaining, self.stream.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) => {
                    let Ok((frame, _)) = Frame::decode(&bytes) else {
                        continue;
                    };
                    let payload = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                        .unwrap_or(serde_json::Value::Null);
                    self.buffer.push(DecodedFrame {
                        feed_id: frame.feed_id,
                        payload,
                    });
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(e))) => {
                    return (
                        out,
                        Some(format!("collect_code_output: ws recv error: {e}")),
                    );
                }
                Ok(None) => return (out, Some("collect_code_output: ws closed".into())),
                Err(_) => return (out, Some("collect_code_output: timed out".into())),
            }
        }
    }

    /// Wait for any frame whose payload `detail` field matches one of
    /// the `accepted` strings. Used by the orphan-input rejection test
    /// to assert that the router emits either `session_not_owned` (P5
    /// authz) or `session_unknown` (dispatcher fallback). Consumes the
    /// matching frame from the buffer.
    pub async fn await_control_reject(
        &mut self,
        accepted: &[&str],
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                let detail = f.payload["detail"].as_str().unwrap_or("");
                accepted.contains(&detail)
            })
            .await?;
        self.buffer.remove(idx);
        Ok(())
    }

    /// Send an arbitrary JSON payload on an arbitrary feed.
    pub async fn send_feed_payload(&mut self, feed_id: FeedId, payload: serde_json::Value) {
        let bytes = serde_json::to_vec(&payload).expect("control json");
        let frame = Frame::new(feed_id, bytes);
        self.sink
            .lock()
            .await
            .send(Message::Binary(frame.encode().into()))
            .await
            .expect("send control frame");
    }

    /// Send an arbitrary JSON payload as a `CONTROL` frame.
    ///
    /// The typed `send_*` helpers cover the session-lifecycle actions; this
    /// is for the router-internal ones that carry no card or session.
    pub async fn send_control_payload(&mut self, payload: serde_json::Value) {
        self.send_feed_payload(FeedId::CONTROL, payload).await;
    }

    /// Drain whatever the socket offers for `window`, then return a per-feed
    /// census of everything this client has buffered since it connected.
    ///
    /// The window is a settling period rather than a deadline: it always runs
    /// to its end, so two clients given the same window are compared over the
    /// same amount of wall clock. Two clients compared against each other want
    /// the same *stretch* of it, so run their two calls concurrently rather
    /// than one after the other.
    pub async fn census_over(&mut self, window: Duration) -> HashMap<u8, usize> {
        let deadline = Instant::now() + window;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, self.stream.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) => {
                    let Ok((frame, _)) = Frame::decode(&bytes) else {
                        continue;
                    };
                    let payload = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                        .unwrap_or(serde_json::Value::Null);
                    self.buffer.push(DecodedFrame {
                        feed_id: frame.feed_id,
                        payload,
                    });
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => break,
            }
        }
        let mut census: HashMap<u8, usize> = HashMap::new();
        for f in &self.buffer {
            *census.entry(f.feed_id.as_byte()).or_insert(0) += 1;
        }
        census
    }

    /// Pump until a `CONTROL` frame whose payload `type` is `ty` arrives.
    ///
    /// Returns that payload together with a per-feed census of every frame
    /// that arrived *before* it. The server writes one socket from one task,
    /// so a frame it had already sent when it built the reply is necessarily
    /// a frame that arrived ahead of the reply — which makes the census an
    /// exact account of what this connection received, not an approximation
    /// racing the wire.
    ///
    /// The matched frame is consumed, so consecutive calls see consecutive
    /// replies rather than re-matching the first one out of the buffer. Only
    /// replies are ever consumed, so the census stays exact for every feed
    /// but `CONTROL`, whose already-answered replies it no longer counts.
    pub async fn await_control_type(
        &mut self,
        ty: &str,
        timeout: Duration,
    ) -> Result<(serde_json::Value, HashMap<u8, usize>), String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id == FeedId::CONTROL && f.payload["type"] == ty
            })
            .await?;
        let mut census: HashMap<u8, usize> = HashMap::new();
        for f in &self.buffer[..idx] {
            *census.entry(f.feed_id.as_byte()).or_insert(0) += 1;
        }
        Ok((self.buffer.remove(idx).payload, census))
    }

    /// Pump until a frame arrives on some feed other than `CONTROL` or
    /// `HEARTBEAT`, and return that feed's id. Which snapshot feed lands
    /// first depends on what the spawned tugcast registered, so a test that
    /// only needs *some* real traffic asks for it this way rather than
    /// naming a feed and hoping.
    pub async fn await_any_data_feed(&mut self, timeout: Duration) -> Result<FeedId, String> {
        let deadline = Instant::now() + timeout;
        let idx = self
            .pump_until(deadline, |f| {
                f.feed_id != FeedId::CONTROL && f.feed_id != FeedId::HEARTBEAT
            })
            .await?;
        Ok(self.buffer[idx].feed_id)
    }

    /// Count `SESSION_SIDEBAND` frames currently in the buffer (or
    /// buffered over a short polling window) whose `tug_session_id`
    /// matches `target`. Used by replay tests to assert "exactly one
    /// metadata frame was replayed" semantics.
    pub async fn count_session_metadata(&mut self, target: &str, timeout: Duration) -> usize {
        let deadline = Instant::now() + timeout;
        // Drain as many frames as possible within the timeout window.
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, self.stream.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) => {
                    let Ok((frame, _)) = Frame::decode(&bytes) else {
                        continue;
                    };
                    let payload = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                        .unwrap_or(serde_json::Value::Null);
                    self.buffer.push(DecodedFrame {
                        feed_id: frame.feed_id,
                        payload,
                    });
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => break,
            }
        }
        self.buffer
            .iter()
            .filter(|f| {
                f.feed_id == FeedId::SESSION_SIDEBAND && f.payload["tug_session_id"] == target
            })
            .count()
    }
}

/// Abort the heartbeat background task on drop so a `TestWs` that
/// outlives its `TestTugcast` (or is dropped before the socket is
/// gracefully closed) does not leak a tokio task that will keep
/// re-trying heartbeat sends on a dead socket.
impl Drop for TestWs {
    fn drop(&mut self) {
        self.heartbeat_task.abort();
    }
}
