//! pulse — the app-scoped PULSE bridge: spawns and supervises the
//! `tugpulse` commentator daemon, taps the CODE_OUTPUT broadcast for
//! the frames it narrates from, and turns its stdout lines into
//! ledger rows + `PULSE` feed broadcasts.
//!
//! Topology (`arc/pulse-2.md`):
//!
//!   CODE_OUTPUT broadcast ──allowlist tap──▶ daemon stdin
//!   daemon stdout ──pulse line──▶ ledger (capped) + PULSE broadcast ─▶ decks
//!
//! The tap consumes the same spliced frames every deck receives —
//! the daemon sees the real game (typed tugcode frames with
//! `tug_session_id` spliced in), not a hand-phrased re-telling. Only
//! allowlisted frame types cross the pipe; everything between a
//! session's `replay_started`/`replay_complete` brackets is muted
//! here, so reconnect floods never re-narrate history; a lagging
//! broadcast receiver drops frames rather than backpressuring
//! anything (commentary never slows work).
//!
//! One bridge per tugcast process; the daemon is spawned LAZILY on the
//! first forwardable frame while the `pulse/enabled` tugbank default
//! reads true — disabled means frames are dropped and no subprocess
//! ever exists. On daemon death the next frame respawns it
//! (rate-limited), re-seeded from the ledger tail so the narrative
//! thread survives.
//!
//! One-way isolation: nothing in this module writes toward any work
//! session — the only outputs are the ledger, the PULSE broadcast, and
//! tracing.

use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame, StreamFeed};

use crate::session_ledger::SessionLedger;

use super::payload_inspector::InspectedPayload;

/// Rolling-log row cap.
pub const PULSE_LEDGER_CAP: usize = 200;
/// Tail length used both for deck reads and daemon re-seeding.
pub const PULSE_TAIL_LEN: usize = 20;
/// Tugbank default for the kill switch: `Value::Bool`; absent
/// or unreadable reads as ENABLED (PULSE is on by default). The deck's
/// settings surface writes the same `(domain, key)` as a `bool`.
pub const PULSE_ENABLED_DOMAIN: &str = "dev.tugtool.pulse";
pub const PULSE_ENABLED_KEY: &str = "enabled";
/// Minimum spacing between daemon (re)spawn attempts.
const RESPAWN_MIN_INTERVAL: Duration = Duration::from_secs(5);

/// The frame types forwarded to the daemon — the narratable subset of
/// tugcode's outbound vocabulary (`tugcode/src/types.ts`,
/// `OutboundMessage`). Streaming deltas other than assistant text,
/// metadata/cost/usage frames, and everything else stay on the deck
/// side of the pipe. `replay_started`/`replay_complete` are consumed
/// here as mute brackets, never forwarded.
const PULSE_FORWARD_ALLOWLIST: &[&str] = &[
    "tool_use",
    "tool_result",
    "tool_input_progress",
    "assistant_text",
    "turn_complete",
    "turn_cancelled",
    "task_started",
    "task_updated",
    "task_progress",
    "api_retry",
    "error",
    "wake_started",
    // Recovery / notice beats the pulse narrates (voice.ts): a model
    // refusal fallback and an output-truncation ceiling hit.
    "model_refusal_fallback",
    "output_truncated",
    // A compaction landed — manual `/compact` or auto at capacity. The
    // stretch it covers streams nothing, so this is the only frame that
    // tells the strip anything about it.
    "compact_boundary",
];

/// Active daemon subprocess handles, mirrored on `SessionChild`'s
/// shape: boxed stdio + an opaque keepalive whose drop kills the child.
pub struct PulseChild {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub keepalive: Box<dyn Send>,
}

/// Spawner abstraction so unit tests drive the bridge without a real
/// tugpulse binary (the `ChildSpawner` pattern, app-scoped flavor).
pub trait PulseSpawner: Send + Sync + 'static {
    /// Spawn the daemon, seeded with the ledger-tail lines (oldest
    /// first) so the commentator keeps its narrative memory.
    fn spawn(&self, seed_lines: &[String]) -> io::Result<PulseChild>;
}

/// Production spawner: runs the compiled `tugpulse` binary.
pub struct TugpulseSpawner {
    pub tugpulse_path: PathBuf,
}

impl PulseSpawner for TugpulseSpawner {
    fn spawn(&self, seed_lines: &[String]) -> io::Result<PulseChild> {
        let seed_json = serde_json::to_string(seed_lines).unwrap_or_else(|_| "[]".to_string());
        let mut child = Command::new(&self.tugpulse_path)
            .arg("--seed")
            .arg(seed_json)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("tugpulse stdin not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("tugpulse stdout not available"))?;
        // Forward daemon stderr into tracing so operator-visible
        // failures (claude auth, spawn errors) aren't lost to launchd.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "tugcast::tugpulse_stderr", "{line}");
                }
            });
        }
        Ok(PulseChild {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            keepalive: Box::new(child),
        })
    }
}

/// Resolve the tugpulse binary the way tugcode resolves: the already-
/// resolved tugcode path's sibling, falling back to a PATH lookup.
pub fn resolve_tugpulse_path(tugcode_path: &std::path::Path) -> PathBuf {
    let sibling = tugcode_path.with_file_name("tugpulse");
    if sibling.exists() {
        return sibling;
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("tugpulse");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // Last resort: the sibling path (spawn will fail loudly and the
    // bridge logs it; PULSE simply stays silent).
    sibling
}

/// Everything the bridge task needs. `enabled` is consulted per
/// spawn-opportunity (a forwardable frame arriving with no live
/// daemon), so a toggle flip takes effect without a tugcast restart.
/// The PULSE broadcast sender is not part of the config — the bridge
/// is a [`StreamFeed`], so the router hands it the channel at `run`.
pub struct PulseBridgeConfig {
    pub spawner: Arc<dyn PulseSpawner>,
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub ledger: Option<Arc<SessionLedger>>,
    /// The shared CODE_OUTPUT broadcast — the bridge subscribes inside
    /// its task (receivers can't be cloned) and taps every frame.
    pub code_tx: broadcast::Sender<Frame>,
}

/// The PULSE feed: a [`StreamFeed`] wrapping the daemon bridge. The
/// router creates the (small) broadcast channel, records the `Warn`
/// lag policy, and spawns the bridge loop — which lives until `cancel`
/// fires (killing any live daemon via keepalive drop).
pub struct PulseBridge {
    config: PulseBridgeConfig,
}

impl PulseBridge {
    pub fn new(config: PulseBridgeConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl StreamFeed for PulseBridge {
    fn feed_id(&self) -> FeedId {
        FeedId::PULSE
    }

    fn name(&self) -> &str {
        "pulse"
    }

    /// Commentary is small and bursty; the tail a reconnecting deck
    /// needs comes from the `list_pulse_lines` CONTROL read, not feed
    /// replay — so the default `Warn` lag policy and a small channel.
    fn channel_capacity(&self) -> usize {
        64
    }

    async fn run(self: Box<Self>, tx: broadcast::Sender<Frame>, cancel: CancellationToken) {
        pulse_bridge_task(self.config, tx, cancel).await;
    }
}

/// Internal: events from the daemon-stdout reader task.
enum DaemonEvent {
    Line(String),
    Died,
}

/// Classify one CODE_OUTPUT frame for the tap. Returns the spliced
/// session id when the frame should cross the pipe; maintains the
/// replay-mute set as brackets pass (even while the daemon is
/// unspawned or PULSE is disabled — mute state must track the wire,
/// not the toggle).
pub(crate) fn forwardable_session(payload: &[u8], muted: &mut HashSet<String>) -> Option<String> {
    let inspected = InspectedPayload::from_slice(payload)?;
    let msg_type = inspected.msg_type.as_deref()?;
    let session = inspected.tug_session_id.clone();
    match msg_type {
        "replay_started" => {
            if let Some(session) = session {
                muted.insert(session);
            }
            None
        }
        "replay_complete" => {
            if let Some(session) = session {
                muted.remove(&session);
            }
            None
        }
        t if PULSE_FORWARD_ALLOWLIST.contains(&t) => {
            let session = session?;
            if muted.contains(&session) {
                None
            } else {
                Some(session)
            }
        }
        _ => None,
    }
}

async fn pulse_bridge_task(
    config: PulseBridgeConfig,
    pulse_tx: broadcast::Sender<Frame>,
    cancel: CancellationToken,
) {
    let mut daemon_stdin: Option<Box<dyn AsyncWrite + Send + Unpin>> = None;
    let mut daemon_keepalive: Option<Box<dyn Send>> = None;
    let (event_tx, mut event_rx) = mpsc::channel::<DaemonEvent>(64);
    let mut last_spawn_attempt: Option<Instant> = None;
    let mut code_rx = config.code_tx.subscribe();
    let mut code_closed = false;
    // Sessions inside a replay bracket — their frames are history
    // being re-emitted, not live work.
    let mut muted: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("pulse bridge: cancelled; killing daemon");
                drop(daemon_stdin.take());
                drop(daemon_keepalive.take());
                return;
            }
            recv = code_rx.recv(), if !code_closed => {
                let frame = match recv {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // Commentary never backpressures: skip and move on.
                        warn!(skipped, "pulse bridge: code broadcast lagged; frames dropped");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        info!("pulse bridge: code broadcast closed");
                        code_closed = true;
                        continue;
                    }
                };
                if forwardable_session(&frame.payload, &mut muted).is_none() {
                    continue;
                }
                if !(config.enabled)() {
                    // Disabled: drop frames, never spawn. A live daemon
                    // from before the flip is torn down here so the
                    // toggle takes effect at the next frame.
                    if daemon_keepalive.is_some() {
                        info!("pulse bridge: disabled; stopping daemon");
                        drop(daemon_stdin.take());
                        drop(daemon_keepalive.take());
                    }
                    continue;
                }
                if daemon_stdin.is_none() {
                    let throttled = last_spawn_attempt
                        .is_some_and(|t| t.elapsed() < RESPAWN_MIN_INTERVAL);
                    if throttled {
                        continue; // drop the frame; the next one may retry
                    }
                    last_spawn_attempt = Some(Instant::now());
                    let seed = config
                        .ledger
                        .as_ref()
                        .and_then(|l| l.list_pulse_lines_tail(PULSE_TAIL_LEN).ok())
                        .map(|rows| rows.into_iter().map(|r| r.text).collect::<Vec<_>>())
                        .unwrap_or_default();
                    match config.spawner.spawn(&seed) {
                        Ok(child) => {
                            info!(seed_lines = seed.len(), "pulse bridge: daemon spawned");
                            daemon_stdin = Some(child.stdin);
                            daemon_keepalive = Some(child.keepalive);
                            spawn_stdout_reader(child.stdout, event_tx.clone());
                        }
                        Err(err) => {
                            warn!(error = %err, "pulse bridge: daemon spawn failed");
                            continue;
                        }
                    }
                }
                if let Some(stdin) = daemon_stdin.as_mut() {
                    let mut line = frame.payload.clone();
                    line.push(b'\n');
                    if let Err(err) = stdin.write_all(&line).await {
                        warn!(error = %err, "pulse bridge: stdin write failed; daemon marked dead");
                        drop(daemon_stdin.take());
                        drop(daemon_keepalive.take());
                    }
                }
            }
            maybe_event = event_rx.recv() => {
                match maybe_event {
                    Some(DaemonEvent::Line(line)) => {
                        handle_pulse_line(&config, &pulse_tx, &line);
                    }
                    Some(DaemonEvent::Died) => {
                        warn!("pulse bridge: daemon stdout closed");
                        drop(daemon_stdin.take());
                        drop(daemon_keepalive.take());
                    }
                    None => {
                        // event_tx is owned by this task + readers; with
                        // readers gone and our clone alive this can't
                        // happen, but exit defensively.
                        return;
                    }
                }
            }
        }
    }
}

fn spawn_stdout_reader(
    stdout: Box<dyn AsyncRead + Send + Unpin>,
    event_tx: mpsc::Sender<DaemonEvent>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if event_tx.send(DaemonEvent::Line(line)).await.is_err() {
                        return;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = event_tx.send(DaemonEvent::Died).await;
                    return;
                }
            }
        }
    });
}

/// Parse one daemon stdout line; persist + broadcast it. Non-`pulse`
/// or malformed lines are logged and dropped — wire delivery and
/// persistence must never panic on daemon output.
fn handle_pulse_line(config: &PulseBridgeConfig, pulse_tx: &broadcast::Sender<Frame>, line: &str) {
    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(err) => {
            warn!(error = %err, "pulse bridge: unparseable daemon line");
            return;
        }
    };
    if parsed.get("type").and_then(|v| v.as_str()) != Some("pulse") {
        return;
    }
    let text = parsed.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if text.is_empty() {
        return;
    }
    let beat = parsed.get("beat").and_then(|v| v.as_i64()).unwrap_or(0);
    let at_ms = parsed.get("at").and_then(|v| v.as_i64()).unwrap_or(0);
    let intent = parsed
        .get("intent")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let scopes: Vec<String> = parsed
        .get("scopes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if let Some(ledger) = config.ledger.as_ref() {
        if let Err(err) =
            ledger.record_pulse_line(at_ms, beat, text, intent, &scopes, PULSE_LEDGER_CAP)
        {
            warn!(error = %err, "pulse bridge: ledger write failed");
        }
    }
    let _ = pulse_tx.send(Frame::new(FeedId::PULSE, line.as_bytes().to_vec()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Fake spawner: counts spawns and hands the bridge duplex pipes
    /// the test holds the far ends of.
    struct FakeSpawner {
        spawns: AtomicUsize,
        // One prepared child per spawn, handed out in order.
        children: std::sync::Mutex<Vec<PulseChild>>,
        seeds_seen: std::sync::Mutex<Vec<Vec<String>>>,
    }

    impl PulseSpawner for FakeSpawner {
        fn spawn(&self, seed_lines: &[String]) -> io::Result<PulseChild> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            self.seeds_seen.lock().unwrap().push(seed_lines.to_vec());
            self.children
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| io::Error::other("no fake child prepared"))
        }
    }

    fn code_frame(json: serde_json::Value) -> Frame {
        Frame::new(FeedId::CODE_OUTPUT, json.to_string().into_bytes())
    }

    fn tool_result_frame(session: &str, output: &str) -> Frame {
        code_frame(serde_json::json!({
            "tug_session_id": session,
            "type": "tool_result",
            "tool_use_id": "t1",
            "output": output,
            "is_error": false,
            "ipc_version": 2,
        }))
    }

    #[tokio::test]
    async fn disabled_toggle_drops_frames_and_never_spawns() {
        let spawner = Arc::new(FakeSpawner {
            spawns: AtomicUsize::new(0),
            children: std::sync::Mutex::new(vec![]),
            seeds_seen: std::sync::Mutex::new(vec![]),
        });
        let (pulse_tx, _keep) = broadcast::channel(8);
        let (code_tx, _keep_code) = broadcast::channel(8);
        let cancel = CancellationToken::new();
        let bridge = PulseBridge::new(PulseBridgeConfig {
            spawner: Arc::clone(&spawner) as Arc<dyn PulseSpawner>,
            enabled: Arc::new(|| false),
            ledger: None,
            code_tx: code_tx.clone(),
        });
        tokio::spawn(Box::new(bridge).run(pulse_tx, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        code_tx.send(tool_result_frame("s1", "hello")).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 0);
        cancel.cancel();
    }

    #[tokio::test]
    async fn allowlisted_frames_reach_daemon_and_lines_broadcast() {
        // Far ends the test drives: read the daemon's stdin, write its
        // stdout.
        let (test_reads_stdin, bridge_stdin) = tokio::io::duplex(4096);
        let (bridge_stdout, mut test_writes_stdout) = tokio::io::duplex(4096);
        let spawner = Arc::new(FakeSpawner {
            spawns: AtomicUsize::new(0),
            children: std::sync::Mutex::new(vec![PulseChild {
                stdin: Box::new(bridge_stdin),
                stdout: Box::new(bridge_stdout),
                keepalive: Box::new(()),
            }]),
            seeds_seen: std::sync::Mutex::new(vec![]),
        });
        let (pulse_tx, mut pulse_rx) = broadcast::channel(8);
        let (code_tx, _keep_code) = broadcast::channel(8);
        let cancel = CancellationToken::new();
        let bridge = PulseBridge::new(PulseBridgeConfig {
            spawner: Arc::clone(&spawner) as Arc<dyn PulseSpawner>,
            enabled: Arc::new(|| true),
            ledger: None,
            code_tx: code_tx.clone(),
        });
        tokio::spawn(Box::new(bridge).run(pulse_tx, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;

        // A non-allowlisted frame type is dropped at the tap…
        code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1",
                "type": "thinking_text",
                "text": "never forwarded",
            })))
            .unwrap();
        // …then an allowlisted frame flows to daemon stdin verbatim.
        code_tx
            .send(tool_result_frame("s1", "tests green"))
            .unwrap();
        let mut stdin_lines = BufReader::new(test_reads_stdin).lines();
        let received = tokio::time::timeout(Duration::from_secs(2), stdin_lines.next_line())
            .await
            .expect("daemon received frame in time")
            .unwrap()
            .expect("a line");
        assert!(received.contains("\"tests green\""));
        assert!(received.contains("\"tug_session_id\":\"s1\""));
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 1);

        // Daemon line flows out as a PULSE frame.
        let line = serde_json::json!({
            "type": "pulse",
            "text": "Tests green — wiring next.",
            "scopes": ["s1"],
            "beat": 1,
            "at": 2,
        })
        .to_string();
        test_writes_stdout
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(2), pulse_rx.recv())
            .await
            .expect("PULSE frame in time")
            .expect("frame");
        assert_eq!(frame.feed_id, FeedId::PULSE);
        let payload: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(payload["text"], "Tests green — wiring next.");

        cancel.cancel();
    }

    #[tokio::test]
    async fn replay_brackets_mute_a_session_without_blocking_others() {
        let (test_reads_stdin, bridge_stdin) = tokio::io::duplex(4096);
        let (bridge_stdout, _test_writes_stdout) = tokio::io::duplex(4096);
        let spawner = Arc::new(FakeSpawner {
            spawns: AtomicUsize::new(0),
            children: std::sync::Mutex::new(vec![PulseChild {
                stdin: Box::new(bridge_stdin),
                stdout: Box::new(bridge_stdout),
                keepalive: Box::new(()),
            }]),
            seeds_seen: std::sync::Mutex::new(vec![]),
        });
        let (pulse_tx, _keep) = broadcast::channel(8);
        let (code_tx, _keep_code) = broadcast::channel(16);
        let cancel = CancellationToken::new();
        let bridge = PulseBridge::new(PulseBridgeConfig {
            spawner: Arc::clone(&spawner) as Arc<dyn PulseSpawner>,
            enabled: Arc::new(|| true),
            ledger: None,
            code_tx: code_tx.clone(),
        });
        tokio::spawn(Box::new(bridge).run(pulse_tx, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;

        // s1 enters replay: its frames are muted; s2 still flows.
        code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1", "type": "replay_started", "ipc_version": 2,
            })))
            .unwrap();
        code_tx
            .send(tool_result_frame("s1", "replayed history"))
            .unwrap();
        code_tx.send(tool_result_frame("s2", "live work")).unwrap();
        let mut stdin_lines = BufReader::new(test_reads_stdin).lines();
        let first = tokio::time::timeout(Duration::from_secs(2), stdin_lines.next_line())
            .await
            .expect("daemon received the live frame")
            .unwrap()
            .expect("a line");
        assert!(first.contains("\"live work\""));
        assert!(!first.contains("replayed history"));

        // The bracket closes: s1 flows again.
        code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1", "type": "replay_complete", "ipc_version": 2,
            })))
            .unwrap();
        code_tx
            .send(tool_result_frame("s1", "post-replay live"))
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(2), stdin_lines.next_line())
            .await
            .expect("daemon received the post-replay frame")
            .unwrap()
            .expect("a line");
        assert!(second.contains("\"post-replay live\""));

        cancel.cancel();
    }

    #[test]
    fn forwardable_session_classification() {
        let mut muted = HashSet::new();
        // Allowlisted + spliced → forwarded with its session.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // Background-agent progress IS forwarded, so the pulse can
        // narrate what a backgrounded agent is doing (not just its
        // start/terminal).
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"task_progress","last_tool_name":"Bash"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // A compaction boundary is the only frame a compacting stretch
        // emits, so it crosses the pipe.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"compact_boundary","trigger":"manual"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // Not allowlisted.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"system_metadata"}"#,
                &mut muted,
            ),
            None
        );
        // Allowlisted but unspliced (defensive — relay lines are
        // always spliced).
        assert_eq!(
            forwardable_session(br#"{"type":"tool_use"}"#, &mut muted),
            None
        );
        // Brackets maintain the mute set and are themselves dropped.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"replay_started"}"#,
                &mut muted,
            ),
            None
        );
        assert!(muted.contains("s1"));
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"tool_result"}"#,
                &mut muted,
            ),
            None
        );
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"replay_complete"}"#,
                &mut muted,
            ),
            None
        );
        assert!(muted.is_empty());
        // Malformed JSON never panics.
        assert_eq!(forwardable_session(b"not json", &mut muted), None);
    }
}
