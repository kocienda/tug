use std::collections::HashMap;

use tokio::sync::{broadcast, mpsc};
use tracing::info;
use tugcast_core::{FeedId, Frame};

use crate::router::LagPolicy;

/// Broadcast a `claude_auth_result` CONTROL frame from a resolved auth state.
/// Shared by the `check_auth` (probe) and `claude_sign_in` (login) actions so
/// both report login state to the deck in one shape. `tug_session_id` is echoed
/// when present so a per-card sign-in can resume the originating card.
fn broadcast_auth_result(
    cat: Option<broadcast::Sender<Frame>>,
    state: crate::feeds::claude_auth::AuthState,
    tug_session_id: Option<String>,
) {
    use crate::feeds::claude_auth::AuthState;
    // `reason` distinguishes the two signed-out cases so the gate can show
    // install guidance vs. a sign-in prompt: "claude_missing" (no CLI) vs
    // "logged_out" (CLI present, not signed in). `null` when logged in.
    let (logged_in, email, subscription_type, auth_method, reason) = match state {
        AuthState::LoggedIn(info) => (
            true,
            info.email,
            info.subscription_type,
            info.auth_method,
            None,
        ),
        AuthState::ClaudeMissing => (false, None, None, None, Some("claude_missing")),
        AuthState::LoggedOut => (false, None, None, None, Some("logged_out")),
    };
    let Some(cat) = cat else { return };
    let body = serde_json::json!({
        "action": "claude_auth_result",
        "loggedIn": logged_in,
        "reason": reason,
        "tug_session_id": tug_session_id,
        "email": email,
        "subscriptionType": subscription_type,
        "authMethod": auth_method,
    });
    if let Ok(bytes) = serde_json::to_vec(&body) {
        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
    }
}

/// Probe the installed and newest-available Claude Code versions and broadcast
/// them as a `claude_version_result` CONTROL frame. The two lookups are
/// independent (one local process, one network fetch), so they run together and
/// each reports `null` on its own failure — a missing CLI still lets the row
/// name the newest release, and an offline machine still names what is
/// installed.
async fn broadcast_version_result(cat: Option<broadcast::Sender<Frame>>) {
    let (installed, latest) = tokio::join!(
        crate::feeds::claude_auth::installed_version(),
        crate::feeds::claude_auth::latest_version(),
    );
    let Some(cat) = cat else { return };
    let body = serde_json::json!({
        "action": "claude_version_result",
        "installed": installed,
        "latest": latest,
    });
    if let Ok(bytes) = serde_json::to_vec(&body) {
        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
    }
}

/// Broadcast a `host_tools_result` CONTROL frame from a probed host.
///
/// The floor rides along rather than being restated in the deck, so the one
/// place that decides whether a git is old enough is `host_tools::meets_floor`
/// and the row only renders the answer.
fn broadcast_host_tools_result(
    cat: Option<broadcast::Sender<Frame>>,
    tools: crate::feeds::host_tools::HostTools,
) {
    let Some(cat) = cat else { return };
    let body = serde_json::json!({
        "action": "host_tools_result",
        "gitVersion": tools.git_version,
        "gitPath": tools.git_path,
        "developerDir": tools.developer_dir,
        "gitFloor": crate::feeds::host_tools::GIT_VERSION_FLOOR,
        "usable": tools.is_usable(),
    });
    if let Ok(bytes) = serde_json::to_vec(&body) {
        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
    }
}

/// The router-owned state every ingress path hands to [`dispatch_action`].
///
/// Borrowed as a group so the three call sites (HTTP tell, WebSocket control
/// frame, UDS tell) pass one context instead of a widening argument list.
pub struct ActionContext<'a> {
    pub shutdown_tx: &'a mpsc::Sender<u8>,
    /// Used to look up the CONTROL broadcast sender.
    pub stream_outputs: &'a HashMap<FeedId, (broadcast::Sender<Frame>, LagPolicy)>,
    pub dev_state: &'a crate::dev::SharedDevState,
    pub pending_evals: &'a crate::router::PendingEvals,
    pub pending_asks: &'a crate::router::PendingAsks,
    pub shared_agent: &'a crate::shared_agent::SharedAgentHandle,
}

/// Dispatch an action received from any ingress path (HTTP tell, WebSocket control frame, UDS tell).
///
/// Classifies the action and routes it to the appropriate channel(s).
/// `raw_payload` is the full JSON body bytes, used to construct the Control frame for broadcasting.
///
/// NOTE: session-lifecycle actions (`spawn_session`, `close_session`,
/// `reset_session`) are handled upstream by `AgentSupervisor::handle_control`
/// in `feeds/agent_supervisor.rs` and never reach this function — per [D09]
/// the supervisor owns the per-session state machine, not the router.
pub async fn dispatch_action(action: &str, raw_payload: &[u8], ctx: &ActionContext<'_>) {
    let ActionContext {
        shutdown_tx,
        stream_outputs,
        dev_state: shared_dev_state,
        pending_evals,
        pending_asks,
        shared_agent,
    } = *ctx;
    match action {
        "relaunch" => {
            info!("dispatch_action: relaunch requested");
            let shared = shared_dev_state.clone();
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            let stx = shutdown_tx.clone();
            tokio::spawn(async move {
                if let Some(cat) = cat {
                    crate::control::handle_relaunch(shared, cat, stx).await;
                }
            });
        }
        "eval-response" => {
            // Complete a pending eval request
            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(raw_payload) {
                if let Some(request_id) = payload.get("requestId").and_then(|r| r.as_str()) {
                    let mut pending = pending_evals.lock().unwrap();
                    if let Some(tx) = pending.remove(request_id) {
                        let result = payload
                            .get("result")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let _ = tx.send(result);
                        info!(
                            "dispatch_action: eval-response completed for {}",
                            request_id
                        );
                    }
                }
            }
        }
        "ask-response" => {
            // Complete a pending ask request. Unlike eval-response, a missing
            // entry is unremarkable: the requester may have already timed out
            // and gone away, and the deck has no way to know that.
            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(raw_payload) {
                if let Some(request_id) = payload.get("requestId").and_then(|r| r.as_str()) {
                    let choice = payload
                        .get("choice")
                        .and_then(|c| c.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    let mut pending = pending_asks.lock().unwrap();
                    if let Some(tx) = pending.remove(request_id) {
                        let _ = tx.send(choice);
                        info!("dispatch_action: ask-response completed for {}", request_id);
                    }
                }
            }
        }
        "check_auth" => {
            // App-level auth probe (no login): runs `claude auth status` and
            // broadcasts the result so the deck can gate at launch and before
            // the session picker without spawning a session.
            info!("dispatch_action: claude auth check requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let state = crate::feeds::claude_auth::probe().await;
                broadcast_auth_result(cat, state, None);
            });
        }
        "check_host_tools" => {
            // The host-tools probe: does this machine carry a git Tug can use?
            // Silent by construction — see `host_tools`'s module docs for why
            // the order matters — so it is safe to fire at launch, before the
            // wizard has said anything.
            info!("dispatch_action: host tools check requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let tools = crate::feeds::host_tools::probe().await;
                broadcast_host_tools_result(cat, tools);
            });
        }
        "offer_host_tools" => {
            // Ask macOS to install the Command Line Tools. `xcode-select
            // --install` returns as soon as Apple's panel is up, so its success
            // means the offer was made rather than that git has arrived — the
            // re-probe right after is what says whether it had already been
            // there all along (the "already installed" case), and the watch is
            // what settles the row when the user actually goes through with the
            // ~3 GB download. No timer asks "is git here yet?".
            info!("dispatch_action: host tools offer requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let (ok, error) = crate::feeds::host_tools::offer_developer_tools().await;
                if let Some(cat) = &cat {
                    let body = serde_json::json!({
                        "action": "host_tools_offer_result",
                        "ok": ok,
                        "error": error,
                    });
                    if let Ok(bytes) = serde_json::to_vec(&body) {
                        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
                    }
                }
                let tools = crate::feeds::host_tools::probe().await;
                let settled = tools.is_usable();
                broadcast_host_tools_result(cat.clone(), tools);
                if ok && !settled {
                    // The install is running in Apple's own UI. Wait on the
                    // tools appearing, then say so once; a horizon that runs
                    // out simply drops the watch, and the row's Recheck covers
                    // the user who took longer or installed by hand.
                    if crate::feeds::host_tools::await_command_line_tools().await {
                        let tools = crate::feeds::host_tools::probe().await;
                        broadcast_host_tools_result(cat, tools);
                    }
                }
            });
        }
        "install_claude" => {
            // Tug-managed install: run the official installer, report the
            // outcome, then re-probe (the installer drops `claude` in
            // ~/.local/bin, which claude_executable() finds without a PATH
            // edit). Spawned so dispatch returns while the install runs.
            info!("dispatch_action: claude install requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let (ok, error) = crate::feeds::claude_auth::install().await;
                if let Some(cat) = &cat {
                    let body = serde_json::json!({
                        "action": "claude_install_result",
                        "ok": ok,
                        "error": error,
                    });
                    if let Ok(bytes) = serde_json::to_vec(&body) {
                        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
                    }
                }
                // Re-probe regardless — on success `claude` is now reachable.
                let state = crate::feeds::claude_auth::probe().await;
                broadcast_auth_result(cat.clone(), state, None);
                // …and report what version that install landed, so the row
                // names it rather than staying blank until the next launch.
                broadcast_version_result(cat).await;
            });
        }
        "check_claude_version" => {
            // Version probe for the wizard's install row: what is installed here
            // and what the stable channel is offering. Both are optional — a
            // missing CLI or an unreachable network answers `null` and the row
            // simply says less. Spawned so the network lookup never blocks
            // dispatch.
            info!("dispatch_action: claude version check requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                broadcast_version_result(cat).await;
            });
        }
        "update_claude" => {
            // Update in place: the official installer always lands the stable
            // channel's newest build, so an update is the same operation as a
            // first install — only the reporting differs, so the wizard can say
            // "Updating…" rather than "Installing…". Re-probes the version pair
            // afterward so the row settles on what is now installed.
            info!("dispatch_action: claude update requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let (ok, error) = crate::feeds::claude_auth::install().await;
                if let Some(cat) = &cat {
                    let body = serde_json::json!({
                        "action": "claude_update_result",
                        "ok": ok,
                        "error": error,
                    });
                    if let Ok(bytes) = serde_json::to_vec(&body) {
                        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
                    }
                }
                broadcast_version_result(cat).await;
            });
        }
        "claude_sign_in" => {
            // Drive `claude auth login` and report the result back so the
            // app-wide sheet (and the card that asked) can resume. login()
            // awaits the CLI's exit — the CLI blocks on its own browser OAuth
            // callback, so there's no polling. Spawned as a task so dispatch
            // returns promptly while the user completes sign-in in the browser.
            info!("dispatch_action: claude sign-in requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            let tug_session_id = serde_json::from_slice::<serde_json::Value>(raw_payload)
                .ok()
                .and_then(|v| {
                    v.get("tug_session_id")
                        .and_then(|s| s.as_str())
                        .map(str::to_owned)
                });
            tokio::spawn(async move {
                let state = crate::feeds::claude_auth::login().await;
                broadcast_auth_result(cat, state, tug_session_id);
            });
        }
        "claude_logout" => {
            // Drive `claude auth logout`. Report the command's own success as a
            // `claude_logout_result` (so a failed logout surfaces an error
            // rather than a silent no-op), then re-probe and broadcast the
            // resulting auth state — logged out on success — which reopens
            // ConfigureTug for the user to log back in.
            info!("dispatch_action: claude logout requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(async move {
                let (ok, error) = crate::feeds::claude_auth::logout().await;
                if let Some(cat) = &cat {
                    let body = serde_json::json!({
                        "action": "claude_logout_result",
                        "ok": ok,
                        "error": error,
                    });
                    if let Ok(bytes) = serde_json::to_vec(&body) {
                        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
                    }
                }
                let state = crate::feeds::claude_auth::probe().await;
                broadcast_auth_result(cat, state, None);
            });
        }
        "shared_agent_classify" => {
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            let payload = serde_json::from_slice::<serde_json::Value>(raw_payload).ok();
            let text = payload
                .as_ref()
                .and_then(|v| v.get("text")?.as_str().map(str::to_owned));
            // The program's documentation, when the caller is driving the
            // grammar-bearing variant. Absent means the base classify wording.
            let grammar = payload
                .as_ref()
                .and_then(|v| v.get("grammar")?.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            match text {
                Some(text) => crate::shared_agent::request_classification(
                    shared_agent.clone(),
                    cat,
                    text,
                    grammar,
                ),
                None => info!("dispatch_action: shared_agent_classify missing text"),
            }
        }
        // A tripwire fired by hand. The engine is what mints the row ([P08]),
        // so this is the firing itself rather than a nudge — and the tripwire
        // row has to be read first, because the scope is what a hand-fired
        // trip stands in and a tripwire without one is refused at the door.
        "tripwire_trip" => {
            let name = serde_json::from_slice::<serde_json::Value>(raw_payload)
                .ok()
                .and_then(|p| {
                    p.get("tripwire")
                        .and_then(|w| w.as_str())
                        .map(str::to_owned)
                });
            match name {
                Some(name) => {
                    let served = tugtool_core::tripwire_ledger::open()
                        .ok()
                        .and_then(|conn| tugtool_core::tripwire_ledger::get(&conn, &name).ok())
                        .flatten()
                        .map(|tripwire| crate::feeds::tripwire::kick(&tripwire));
                    info!(tripwire = %name, served = ?served, "dispatch_action: tripwire_trip");
                }
                None => info!("dispatch_action: tripwire_trip names no tripwire"),
            }
        }
        // The tripwire ledger moved in some other process — a `lay`, an
        // `edit`, an `rm`, a `pause`, a settle. It carries no payload on
        // purpose: it says the roster moved, not which tripwire moved. Pure
        // latency, as every nudge to this feed is; the feed's own
        // `data_version` probe would see the same commit within its interval.
        "tripwire_bump" => {
            let heard = crate::feeds::tripwires::bump();
            info!(heard, "dispatch_action: tripwire_bump");
        }
        other => {
            info!("dispatch_action: broadcasting client action: {}", other);
            if let Some((tx, _)) = stream_outputs.get(&FeedId::CONTROL) {
                let frame = Frame::new(FeedId::CONTROL, raw_payload.to_vec());
                let _ = tx.send(frame);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_dispatch_action_unknown() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut client_action_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));

        dispatch_action(
            "show-card",
            br#"{"action":"show-card"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
            },
        )
        .await;

        let frame = client_action_rx.recv().await.unwrap();
        assert_eq!(frame.feed_id, FeedId::CONTROL);
        assert_eq!(frame.payload, br#"{"action":"show-card"}"#);
    }

    /// `tripwire_bump` takes no payload, so the thing that could go wrong is
    /// it falling through to the catch-all and being broadcast at every deck
    /// as a client action. Nothing on CONTROL is what says the arm was taken.
    #[tokio::test]
    async fn test_dispatch_tripwire_bump_is_handled_not_broadcast() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut client_action_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));

        dispatch_action(
            "tripwire_bump",
            br#"{"action":"tripwire_bump"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
            },
        )
        .await;

        assert!(
            client_action_rx.try_recv().is_err(),
            "the bump is handled here, never broadcast to the decks"
        );
    }

    /// The deck's answer reaches the waiting requester.
    #[tokio::test]
    async fn test_dispatch_ask_response_resolves_pending() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, _rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks: crate::router::PendingAsks =
            std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));

        let (tx, rx) = tokio::sync::oneshot::channel();
        pending_asks.lock().unwrap().insert("req-1".to_owned(), tx);

        dispatch_action(
            "ask-response",
            br#"{"action":"ask-response","requestId":"req-1","choice":"run-background-only"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
            },
        )
        .await;

        assert_eq!(rx.await.unwrap(), "run-background-only");
        assert!(pending_asks.lock().unwrap().is_empty());
    }

    /// The observability verbs answer in the shape the local-model verbs did
    /// ([P07]) — same action names but for the prefix, same fields — so the
    /// eval harness reads a verdict the same way it always has.
    #[tokio::test]
    async fn shared_agent_classify_broadcasts_a_parsed_verdict() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut client_action_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let agent = Some(crate::shared_agent::test_support::scripted_haiku_pool(Ok(
            "SHELL".to_string(),
        )));

        dispatch_action(
            "shared_agent_classify",
            br#"{"action":"shared_agent_classify","text":"ls -la"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &agent,
            },
        )
        .await;

        // The verb answers on a spawned task, so the frame arrives after
        // dispatch returns.
        let frame =
            tokio::time::timeout(std::time::Duration::from_secs(5), client_action_rx.recv())
                .await
                .expect("a verdict frame arrives")
                .expect("broadcast alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["action"], "shared_agent_classify_result");
        assert_eq!(body["ok"], true);
        // Lowercased tugcast-side, so the deck only ever sees the two labels.
        assert_eq!(body["verdict"], "shell");
        assert!(body["error"].is_null());
    }

    /// With no agent built, the verb still answers — in the degraded shape
    /// every caller already handles ([P06]).
    #[tokio::test]
    async fn shared_agent_classify_without_an_agent_reports_unavailable() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut client_action_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));

        dispatch_action(
            "shared_agent_classify",
            br#"{"action":"shared_agent_classify","text":"ls -la"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
            },
        )
        .await;

        let frame =
            tokio::time::timeout(std::time::Duration::from_secs(5), client_action_rx.recv())
                .await
                .expect("a frame arrives")
                .expect("broadcast alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["action"], "shared_agent_classify_result");
        assert_eq!(body["ok"], false);
        assert!(body["verdict"].is_null());
        assert!(body["error"].is_string());
    }

    /// An answer for a request that already timed out is dropped, not a panic.
    #[tokio::test]
    async fn test_dispatch_ask_response_unknown_request_is_ignored() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, _rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_asks: crate::router::PendingAsks =
            std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));

        dispatch_action(
            "ask-response",
            br#"{"action":"ask-response","requestId":"gone","choice":"run-all"}"#,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
            },
        )
        .await;

        assert!(pending_asks.lock().unwrap().is_empty());
    }
}
