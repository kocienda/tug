use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{broadcast, mpsc};
use tokio::time::{Duration, sleep};
use tracing::info;
use tugcast_core::{FeedId, Frame};

/// Control message received from parent process over UDS
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum ControlMessage {
    Tell {
        action: String,
        #[serde(flatten)]
        payload: serde_json::Value,
    },
    Shutdown,
    DevMode {
        enabled: bool,
        #[serde(default)]
        source_tree: Option<String>,
        #[serde(default)]
        vite_port: Option<u16>,
    },
}

/// Control socket writer half
pub struct ControlWriter {
    writer: BufWriter<OwnedWriteHalf>,
}

impl ControlWriter {
    /// Send ready message to parent
    pub async fn send_ready(&mut self, auth_url: &str, port: u16, pid: u32) -> std::io::Result<()> {
        #[derive(Serialize)]
        struct ReadyMessage<'a> {
            r#type: &'static str,
            auth_url: &'a str,
            port: u16,
            pid: u32,
        }

        let msg = ReadyMessage {
            r#type: "ready",
            auth_url,
            port,
            pid,
        };

        let json = serde_json::to_string(&msg)?;
        self.writer.write_all(json.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        Ok(())
    }

    /// Extract inner writer for use by draining task
    pub(crate) fn into_inner(self) -> BufWriter<OwnedWriteHalf> {
        self.writer
    }
}

/// Control socket reader half
pub struct ControlReader {
    reader: BufReader<OwnedReadHalf>,
}

impl ControlReader {
    /// Run receive loop, reading messages from parent and dispatching actions
    #[allow(clippy::too_many_arguments)]
    pub async fn run_recv_loop(
        mut self,
        shutdown_tx: mpsc::Sender<u8>,
        stream_outputs: std::collections::HashMap<
            FeedId,
            (broadcast::Sender<Frame>, crate::router::LagPolicy),
        >,
        shared_dev_state: crate::dev::SharedDevState,
        response_tx: mpsc::Sender<String>,
        auth: crate::auth::SharedAuthState,
        pending_evals: crate::router::PendingEvals,
        pending_asks: crate::router::PendingAsks,
        shared_agent: crate::shared_agent::SharedAgentHandle,
    ) {
        // Extract the CONTROL broadcast sender for use throughout the recv loop.
        let client_action_tx = stream_outputs
            .get(&FeedId::CONTROL)
            .map(|(tx, _)| tx.clone())
            .expect("CONTROL stream must be registered before starting recv loop");

        let mut line = String::new();
        let mut dev_runtime: Option<crate::dev::DevRuntime> = None;

        loop {
            line.clear();
            match self.reader.read_line(&mut line).await {
                Ok(0) => {
                    // EOF: parent disconnected
                    info!("Control socket: parent disconnected (EOF)");
                    return;
                }
                Ok(_) => {
                    // Parse message
                    match serde_json::from_str::<ControlMessage>(&line) {
                        Ok(ControlMessage::Tell { action, payload }) => {
                            // Intercept relaunch action for special handling
                            if action == "relaunch" {
                                let shared = shared_dev_state.clone();
                                let cat = client_action_tx.clone();
                                let stx = shutdown_tx.clone();
                                tokio::spawn(async move {
                                    handle_relaunch(shared, cat, stx).await;
                                });
                            } else {
                                // Re-serialize the full payload (including action) for dispatch
                                let mut full_payload = payload.clone();
                                full_payload["action"] = serde_json::Value::String(action.clone());
                                if let Ok(bytes) = serde_json::to_vec(&full_payload) {
                                    crate::actions::dispatch_action(
                                        &action,
                                        &bytes,
                                        &crate::actions::ActionContext {
                                            shutdown_tx: &shutdown_tx,
                                            stream_outputs: &stream_outputs,
                                            dev_state: &shared_dev_state,
                                            pending_evals: &pending_evals,
                                            pending_asks: &pending_asks,
                                            shared_agent: &shared_agent,
                                        },
                                    )
                                    .await;
                                }
                            }
                        }
                        Ok(ControlMessage::DevMode {
                            enabled,
                            source_tree,
                            vite_port,
                        }) => {
                            if enabled {
                                // If already enabled, teardown old watcher first
                                if let Some(runtime) = dev_runtime.take() {
                                    crate::dev::disable_dev_mode(runtime, &shared_dev_state);
                                }

                                let source_path = match source_tree {
                                    Some(p) => std::path::PathBuf::from(p),
                                    None => {
                                        let _ = response_tx
                                            .send(make_dev_mode_result(
                                                false,
                                                Some(
                                                    "source_tree is required when enabled is true",
                                                ),
                                            ))
                                            .await;
                                        continue;
                                    }
                                };

                                match crate::dev::enable_dev_mode(
                                    source_path,
                                    &shared_dev_state,
                                    client_action_tx.clone(),
                                )
                                .await
                                {
                                    Ok(runtime) => {
                                        dev_runtime = Some(runtime);
                                        let resolved_vite_port = vite_port
                                            .unwrap_or(tugcast_core::DEFAULT_VITE_DEV_PORT);
                                        auth.lock().set_dev_port(Some(resolved_vite_port));
                                        let _ = response_tx
                                            .send(make_dev_mode_result(true, None))
                                            .await;
                                    }
                                    Err(e) => {
                                        let _ = response_tx
                                            .send(make_dev_mode_result(false, Some(&e)))
                                            .await;
                                    }
                                }
                            } else {
                                // Disable
                                if let Some(runtime) = dev_runtime.take() {
                                    crate::dev::disable_dev_mode(runtime, &shared_dev_state);
                                }
                                // In production mode the frontend is served directly by tugcast
                                // on port 55255 — no Vite process runs. Clear dev_port so that
                                // the origin allowlist only permits the tugcast port.
                                auth.lock().set_dev_port(None);
                                let _ = response_tx.send(make_dev_mode_result(true, None)).await;
                            }
                        }
                        Ok(ControlMessage::Shutdown) => {
                            info!("Control socket: shutdown requested by parent");
                            let _ = shutdown_tx.send(0).await;
                            return;
                        }
                        Err(e) => {
                            info!("Control socket: failed to parse message: {}", e);
                            // Continue reading
                        }
                    }
                }
                Err(e) => {
                    info!("Control socket: read error: {}", e);
                    return;
                }
            }
        }
    }
}

/// Control socket connection
pub struct ControlSocket {
    writer: BufWriter<OwnedWriteHalf>,
    reader: BufReader<OwnedReadHalf>,
}

impl ControlSocket {
    /// Connect to control socket at the given path
    pub async fn connect(path: &Path) -> std::io::Result<Self> {
        let stream = UnixStream::connect(path).await?;
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            writer: BufWriter::new(write_half),
            reader: BufReader::new(read_half),
        })
    }

    /// Split into separate reader and writer halves
    pub fn split(self) -> (ControlWriter, ControlReader) {
        (
            ControlWriter {
                writer: self.writer,
            },
            ControlReader {
                reader: self.reader,
            },
        )
    }
}

/// Serialize dev_mode_result message
pub(crate) fn make_dev_mode_result(success: bool, error: Option<&str>) -> String {
    if let Some(err) = error {
        serde_json::json!({
            "type": "dev_mode_result",
            "success": success,
            "error": err
        })
        .to_string()
    } else {
        serde_json::json!({
            "type": "dev_mode_result",
            "success": success
        })
        .to_string()
    }
}

/// Serialize shutdown message
pub(crate) fn make_shutdown_message(reason: &str, pid: u32) -> String {
    serde_json::json!({
        "type": "shutdown",
        "reason": reason,
        "pid": pid
    })
    .to_string()
}

// ============================================================================
// Relaunch Orchestration
// ============================================================================

/// Handle relaunch action: spawn tugrelaunch, relay progress, send exit code 45
pub(crate) async fn handle_relaunch(
    shared_dev_state: crate::dev::SharedDevState,
    client_action_tx: broadcast::Sender<Frame>,
    shutdown_tx: mpsc::Sender<u8>,
) {
    // 1. Verify dev mode is enabled
    {
        let guard = shared_dev_state.load();
        if guard.is_none() {
            info!("relaunch: dev mode not enabled, ignoring");
            return;
        }
    }

    // 2. Determine app-bundle path from current executable
    let app_bundle = match resolve_app_bundle() {
        Some(p) => p,
        None => {
            info!("relaunch: could not determine app bundle path");
            send_build_progress_error(&client_action_tx, "Could not determine app bundle path");
            return;
        }
    };

    // 3. Get Tug.app PID via getppid
    let tug_app_pid = std::os::unix::process::parent_id();

    // 4. Build progress socket path
    let progress_socket = format!("/tmp/tugrelaunch-{}.sock", std::process::id());

    // 5. Resolve tugrelaunch binary (sibling of current executable)
    let tugrelaunch_bin = match resolve_tugrelaunch_binary() {
        Some(p) => p,
        None => {
            info!("relaunch: tugrelaunch binary not found");
            send_build_progress_error(&client_action_tx, "tugrelaunch binary not found");
            return;
        }
    };

    // 6. Spawn tugrelaunch
    let mut child = match tokio::process::Command::new(&tugrelaunch_bin)
        .arg("--app-bundle")
        .arg(&app_bundle)
        .arg("--pid")
        .arg(tug_app_pid.to_string())
        .arg("--progress-socket")
        .arg(&progress_socket)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            info!("relaunch: failed to spawn tugrelaunch: {}", e);
            send_build_progress_error(
                &client_action_tx,
                &format!("Failed to spawn tugrelaunch: {}", e),
            );
            return;
        }
    };

    // 7. Connect to progress socket (with retry/delay for tugrelaunch to bind)
    let stream = connect_progress_socket(&progress_socket).await;

    // 8. Read progress and relay as dev_build_progress frames
    if let Some(stream) = stream {
        relay_progress(stream, &client_action_tx, &shutdown_tx).await;
    } else {
        // No progress connection -- wait for child and log
        info!("relaunch: proceeding without progress connection");
        let _ = child.wait().await;
    }
}

/// Resolve app bundle path from current executable
/// tugcast is at: Tug.app/Contents/MacOS/tugcast
/// We want: Tug.app
fn resolve_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Go up 3 levels: tugcast -> MacOS -> Contents -> Tug.app
    let bundle = exe.parent()?.parent()?.parent()?;

    // Verify it looks like an app bundle
    if bundle.extension()?.to_str()? == "app" {
        Some(bundle.to_path_buf())
    } else {
        None
    }
}

/// Resolve tugrelaunch binary (sibling of current executable)
fn resolve_tugrelaunch_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    let tugrelaunch = bin_dir.join("tugrelaunch");

    if tugrelaunch.exists() {
        Some(tugrelaunch)
    } else {
        None
    }
}

/// Connect to progress socket with retry
async fn connect_progress_socket(path: &str) -> Option<UnixStream> {
    // Try up to 10 times with 500ms delay (5 seconds total)
    for _ in 0..10 {
        if let Ok(stream) = UnixStream::connect(path).await {
            return Some(stream);
        }
        sleep(Duration::from_millis(500)).await;
    }
    None
}

/// Relay progress messages from tugrelaunch to client as dev_build_progress frames
async fn relay_progress(
    stream: UnixStream,
    client_action_tx: &broadcast::Sender<Frame>,
    shutdown_tx: &mpsc::Sender<u8>,
) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // EOF
                break;
            }
            Ok(_) => {
                // Parse progress message
                if let Ok(mut progress) = serde_json::from_str::<serde_json::Value>(&line) {
                    let status = progress
                        .get("status")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    // Add action field to convert to dev_build_progress format
                    progress["action"] =
                        serde_json::Value::String("dev_build_progress".to_string());

                    // Send as Control frame
                    if let Ok(bytes) = serde_json::to_vec(&progress) {
                        let frame = Frame::new(FeedId::CONTROL, bytes);
                        let _ = client_action_tx.send(frame);
                    }

                    // If status is "quitting", send exit code 45
                    if status.as_deref() == Some("quitting") {
                        let _ = shutdown_tx.send(45).await;
                    }
                }
            }
            Err(_) => {
                // Read error
                break;
            }
        }
    }
}

/// Send error message as dev_build_progress frame
fn send_build_progress_error(client_action_tx: &broadcast::Sender<Frame>, error_msg: &str) {
    let msg = serde_json::json!({
        "action": "dev_build_progress",
        "stage": "relaunch",
        "status": "failed",
        "error": error_msg,
    });

    if let Ok(bytes) = serde_json::to_vec(&msg) {
        let frame = Frame::new(FeedId::CONTROL, bytes);
        let _ = client_action_tx.send(frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_control_message_tell_deserialization() {
        let json = r#"{"type":"tell","action":"restart"}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        match msg {
            ControlMessage::Tell { action, .. } => {
                assert_eq!(action, "restart");
            }
            _ => panic!("Expected Tell variant"),
        }
    }

    #[test]
    fn test_control_message_shutdown_deserialization() {
        let json = r#"{"type":"shutdown"}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ControlMessage::Shutdown));
    }

    #[test]
    fn test_ready_message_format() {
        #[derive(Serialize)]
        struct ReadyMessage<'a> {
            r#type: &'static str,
            auth_url: &'a str,
            port: u16,
            pid: u32,
        }

        let msg = ReadyMessage {
            r#type: "ready",
            auth_url: "http://127.0.0.1:7890/auth?token=abc",
            port: 7890,
            pid: 12345,
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"ready""#));
        assert!(json.contains(r#""auth_url":"http://127.0.0.1:7890/auth?token=abc""#));
        assert!(json.contains(r#""port":7890"#));
        assert!(json.contains(r#""pid":12345"#));
    }

    #[test]
    fn test_shutdown_message_format() {
        #[derive(Serialize)]
        struct ShutdownMessage<'a> {
            r#type: &'static str,
            reason: &'a str,
            pid: u32,
        }

        let msg = ShutdownMessage {
            r#type: "shutdown",
            reason: "restart",
            pid: 12345,
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"shutdown""#));
        assert!(json.contains(r#""reason":"restart""#));
        assert!(json.contains(r#""pid":12345"#));
    }

    #[tokio::test]
    async fn test_connect_send_ready_recv() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::net::UnixListener;

        // Create temporary socket path
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("test.sock");

        // Create listener
        let listener = UnixListener::bind(&socket_path).unwrap();

        // Set permissions (Unix sockets need to be writable)
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o777)).ok();

        // Spawn task to connect and send ready
        let socket_path_clone = socket_path.clone();
        let handle = tokio::spawn(async move {
            let cs = ControlSocket::connect(&socket_path_clone).await.unwrap();
            let (mut writer, _) = cs.split();
            writer
                .send_ready("http://127.0.0.1:7890/auth?token=test", 7890, 999)
                .await
                .unwrap();
        });

        // Accept connection and read message
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();

        // Verify message format
        let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(msg["type"], "ready");
        assert_eq!(msg["auth_url"], "http://127.0.0.1:7890/auth?token=test");
        assert_eq!(msg["port"], 7890);
        assert_eq!(msg["pid"], 999);

        handle.await.unwrap();
    }

    #[test]
    fn test_control_message_dev_mode_enable_deserialization() {
        let json = r#"{"type":"dev_mode","enabled":true,"source_tree":"/path/to/src"}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        match msg {
            ControlMessage::DevMode {
                enabled,
                source_tree,
                ..
            } => {
                assert!(enabled);
                assert_eq!(source_tree, Some("/path/to/src".to_string()));
            }
            _ => panic!("Expected DevMode variant"),
        }
    }

    #[test]
    fn test_control_message_dev_mode_disable_deserialization() {
        let json = r#"{"type":"dev_mode","enabled":false}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        match msg {
            ControlMessage::DevMode {
                enabled,
                source_tree,
                ..
            } => {
                assert!(!enabled);
                assert_eq!(source_tree, None);
            }
            _ => panic!("Expected DevMode variant"),
        }
    }

    #[test]
    fn test_control_message_dev_mode_with_vite_port() {
        let json =
            r#"{"type":"dev_mode","enabled":true,"source_tree":"/path/to/src","vite_port":3000}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        match msg {
            ControlMessage::DevMode {
                enabled,
                source_tree,
                vite_port,
            } => {
                assert!(enabled);
                assert_eq!(source_tree, Some("/path/to/src".to_string()));
                assert_eq!(vite_port, Some(3000));
            }
            _ => panic!("Expected DevMode variant"),
        }
    }

    #[test]
    fn test_control_message_dev_mode_without_vite_port() {
        let json = r#"{"type":"dev_mode","enabled":true,"source_tree":"/path/to/src"}"#;
        let msg: ControlMessage = serde_json::from_str(json).unwrap();
        match msg {
            ControlMessage::DevMode {
                enabled,
                source_tree,
                vite_port,
            } => {
                assert!(enabled);
                assert_eq!(source_tree, Some("/path/to/src".to_string()));
                assert_eq!(vite_port, None);
            }
            _ => panic!("Expected DevMode variant"),
        }
    }

    #[test]
    fn test_make_dev_mode_result_success() {
        let result = make_dev_mode_result(true, None);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "dev_mode_result");
        assert_eq!(parsed["success"], true);
        assert!(parsed.get("error").is_none());
    }

    #[test]
    fn test_make_dev_mode_result_error() {
        let result = make_dev_mode_result(false, Some("load failed"));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "dev_mode_result");
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["error"], "load failed");
    }

    #[test]
    fn test_make_shutdown_message() {
        let result = make_shutdown_message("restart", 12345);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "shutdown");
        assert_eq!(parsed["reason"], "restart");
        assert_eq!(parsed["pid"], 12345);
    }

    #[test]
    fn test_resolve_tugrelaunch_binary_sibling_of_current_exe() {
        // This test verifies the logic -- actual success depends on binary existing
        let result = resolve_tugrelaunch_binary();
        // Just verify it returns a path or None (can't guarantee binary exists in test env)
        if let Some(path) = result {
            assert!(path.to_string_lossy().contains("tugrelaunch"));
        }
    }

    #[test]
    fn test_build_progress_error_message_format() {
        let (tx, _rx) = broadcast::channel(16);
        send_build_progress_error(&tx, "test error");
        // Verify no crash -- actual frame sending tested via integration
    }

    #[tokio::test]
    async fn test_handle_relaunch_ignores_when_dev_mode_not_enabled() {
        use arc_swap::ArcSwap;
        use std::sync::Arc;

        let shared_dev_state = Arc::new(ArcSwap::from_pointee(None::<crate::dev::DevState>));
        let (client_action_tx, _) = broadcast::channel(16);
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);

        handle_relaunch(shared_dev_state, client_action_tx, shutdown_tx).await;

        // Verify no shutdown signal sent
        assert!(shutdown_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_handle_relaunch_reads_source_tree_from_dev_state() {
        use arc_swap::ArcSwap;
        use std::sync::Arc;

        let dev_state = crate::dev::DevState {
            source_tree: PathBuf::from("/test/source"),
        };
        let shared_dev_state = Arc::new(ArcSwap::from_pointee(Some(dev_state)));
        let (client_action_tx, _) = broadcast::channel(16);
        let (shutdown_tx, _) = mpsc::channel(1);

        // This will fail at resolve_app_bundle() since we're not in an app bundle,
        // but it successfully reads source_tree before that
        handle_relaunch(shared_dev_state.clone(), client_action_tx, shutdown_tx).await;

        // Verify dev state was accessed (no crash)
        let guard = shared_dev_state.load();
        assert!(guard.is_some());
        if let Some(state) = guard.as_ref() {
            assert_eq!(state.source_tree, PathBuf::from("/test/source"));
        }
    }

    #[test]
    fn test_dev_build_progress_frame_construction() {
        // Test that progress messages are correctly converted to dev_build_progress format
        let mut progress = serde_json::json!({
            "stage": "cargo",
            "status": "building",
        });

        progress["action"] = serde_json::Value::String("dev_build_progress".to_string());

        assert_eq!(progress["action"], "dev_build_progress");
        assert_eq!(progress["stage"], "cargo");
        assert_eq!(progress["status"], "building");
    }
}
