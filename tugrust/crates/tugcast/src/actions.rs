use std::collections::HashMap;

use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};
use tugcast_core::{ControlAction as A, FeedId, Frame};

use crate::control::send_control;
use crate::pages::{AddressedFrame, PageRegistry, PageTarget, parse_target};
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
    //
    // `loggedIn` is three-valued on the wire, and the third value is the point:
    // `null` with reason "probe_failed" says the probe did not answer, which no
    // boolean could say. A `false` there would put a sign-in modal in front of
    // a user who may well be signed in, over a question nobody asked.
    let (logged_in, email, subscription_type, auth_method, reason) = match state {
        AuthState::LoggedIn(info) => (
            serde_json::Value::Bool(true),
            info.email,
            info.subscription_type,
            info.auth_method,
            None,
        ),
        AuthState::ClaudeMissing => (
            serde_json::Value::Bool(false),
            None,
            None,
            None,
            Some("claude_missing"),
        ),
        AuthState::LoggedOut => (
            serde_json::Value::Bool(false),
            None,
            None,
            None,
            Some("logged_out"),
        ),
        AuthState::Unknown => (
            serde_json::Value::Null,
            None,
            None,
            None,
            Some("probe_failed"),
        ),
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
    send_control(&cat, body);
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
    send_control(&cat, body);
}

/// Send one CONTROL frame, or drop it if nothing is listening.
fn send_if_listening(cat: &Option<broadcast::Sender<Frame>>, body: serde_json::Value) {
    if let Some(cat) = cat {
        send_control(cat, body);
    }
}

/// Run a Claude Code install or update the way [B08] has it: Tug fetches the
/// release itself and reports the bytes, and the official script is what
/// answers when the release channel does not.
///
/// `result_action` is the frame the wizard's row is waiting on —
/// `claude_install_result` for a first install, `claude_update_result` for an
/// update. The two differ in nothing but what the row says while it runs.
///
/// A resume is the same call: the partial file on disk is what makes it one,
/// so nothing here has to know whether it is starting or continuing. What the
/// deck reads off the first `claude_install_progress` frame is `received` — a
/// resume that answers 0 started over (a newer version, or a server that
/// ignored the range), which is the one thing the row has to say differently.
async fn run_claude_install(cat: Option<broadcast::Sender<Frame>>, result_action: &'static str) {
    use crate::feeds::claude_download::{self, FetchOutcome, StopReason};

    let token = claude_download::take_control();
    let dir = claude_download::download_dir();
    let platform = claude_download::platform();
    // The last thing the fetch reported, so a stop can say where it stopped
    // without the fetch having to hand its bookkeeping back.
    let last = std::sync::Arc::new(parking_lot::Mutex::new((0u64, 0u64, String::new())));

    let progress_cat = cat.clone();
    let progress_last = std::sync::Arc::clone(&last);
    let outcome = claude_download::fetch_binary(
        claude_download::DOWNLOAD_BASE_URL,
        &dir,
        &platform,
        &token,
        move |received, expected, version| {
            *progress_last.lock() = (received, expected, version.to_string());
            send_if_listening(
                &progress_cat,
                serde_json::json!({
                    "action": "claude_install_progress",
                    "received": received,
                    "expected": expected,
                    "version": version,
                }),
            );
        },
    )
    .await;
    claude_download::release_control(&token);

    let (ok, error) = match outcome {
        FetchOutcome::Ready { path, version } => {
            info!(%version, "claude install: verified, running the installer");
            claude_download::run_installer(&path).await
        }
        FetchOutcome::Stopped(reason) => {
            let (received, expected, version) = last.lock().clone();
            send_if_listening(
                &cat,
                serde_json::json!({
                    "action": "claude_download_stopped",
                    "reason": match reason {
                        StopReason::Paused => "paused",
                        StopReason::Cancelled => "cancelled",
                    },
                    "received": received,
                    "expected": expected,
                    "version": version,
                }),
            );
            // A stop is not a result: the row is paused or back at its offer,
            // and a `claude_install_result` would end the install it is still
            // holding. Nothing else is sent.
            return;
        }
        FetchOutcome::Failed(message) => (false, Some(message)),
        FetchOutcome::Unresolved => {
            // The release channel did not answer in a shape this can use. The
            // official script is unchanged and still knows how ([B08]); the
            // row runs its barber pole because there are no bytes to count.
            info!("claude install: falling back to the official script");
            send_if_listening(
                &cat,
                serde_json::json!({ "action": "claude_install_fallback" }),
            );
            crate::feeds::claude_auth::install().await
        }
    };

    send_if_listening(
        &cat,
        serde_json::json!({ "action": result_action, "ok": ok, "error": error }),
    );
    // Re-probe regardless — on success `claude` is now reachable.
    let state = crate::feeds::claude_auth::probe().await;
    broadcast_auth_result(cat.clone(), state, None);
    // …and report what version that install landed, so the row names it
    // rather than staying blank until the next launch.
    broadcast_version_result(cat).await;
}

/// The card and the flag of a `body_dormant` tell, or `None` when either is
/// missing or the card id is empty.
fn parse_body_dormant(raw_payload: &[u8]) -> Option<(String, bool)> {
    let payload = serde_json::from_slice::<serde_json::Value>(raw_payload).ok()?;
    let card = payload.get("card_id")?.as_str().filter(|c| !c.is_empty())?;
    let dormant = payload.get("dormant")?.as_bool()?;
    Some((card.to_owned(), dormant))
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
    send_control(&cat, body);
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
    /// The page lane every tell the catch-all forwards is published on.
    pub page_lane: &'a broadcast::Sender<AddressedFrame>,
    /// The live pages a tell's target is resolved against.
    pub pages: &'a PageRegistry,
    /// Where a tell with no `to` goes: the shell for the host and HTTP
    /// ingresses, every connection for one client reaching the others.
    pub default_to: PageTarget,
}

/// Dispatch an action received from any ingress path (HTTP tell, WebSocket control frame, UDS tell).
///
/// Classifies the action and routes it to the appropriate channel(s).
/// `raw_payload` is the full JSON body bytes, used to construct the Control frame for broadcasting.
///
/// NOTE: session-lifecycle actions (`spawn_session`, `close_session`,
/// `reset_session`) are handled upstream by `AgentSupervisor::handle_control`
/// in `feeds/agent_supervisor/` and never reach this function — per [D09]
/// the supervisor owns the per-session state machine, not the router.
pub async fn dispatch_action(action: &str, raw_payload: &[u8], ctx: &ActionContext<'_>) {
    let ActionContext {
        shutdown_tx,
        stream_outputs,
        dev_state: shared_dev_state,
        pending_evals,
        pending_asks,
        shared_agent,
        page_lane,
        pages,
        default_to: _,
    } = *ctx;
    match action.parse::<A>() {
        Ok(A::Relaunch) => {
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
        Ok(A::EvalResponse) => {
            // Complete a pending eval request
            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(raw_payload) {
                if let Some(request_id) = payload.get("requestId").and_then(|r| r.as_str()) {
                    let mut pending = pending_evals.lock();
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
        Ok(A::AskResponse) => {
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
                    let mut pending = pending_asks.lock();
                    if let Some(tx) = pending.remove(request_id) {
                        let _ = tx.send(choice);
                        info!("dispatch_action: ask-response completed for {}", request_id);
                    }
                }
            }
        }
        Ok(A::CheckAuth) => {
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
        Ok(A::CheckHostTools) => {
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
        Ok(A::BodyDormant) => {
            // The host's word on a hidden body ([B05]): its own clock, which
            // WebKit cannot freeze, has run the dormant delay since the hide,
            // or the body is shown again. tugcast takes it as the fact the
            // router reads, so a dormant body hears nothing of any session and
            // its quiet socket is not cut as a dead wire.
            match parse_body_dormant(raw_payload) {
                Some((card, dormant)) => {
                    if pages.set_card_dormant(&card, dormant) {
                        info!(card = %card, dormant, "dispatch_action: body dormancy declared");
                    }
                }
                None => warn!("dispatch_action: body_dormant without a card_id and a dormant flag"),
            }
        }
        Ok(A::OfferHostTools) => {
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
                    send_control(cat, body);
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
        Ok(A::InstallClaude | A::ClaudeDownloadResume) => {
            // Tug-managed install: fetch the release ourselves so the row can
            // draw a real bar, verify it, and hand the binary its own
            // `install` subcommand; the official script is the fallback when
            // the channel cannot be read ([B08]). A resume is the same call —
            // the partial file on disk is what makes it one ([B09]). Spawned
            // so dispatch returns while the download runs.
            info!(action, "dispatch_action: claude install requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            // Which row a resume belongs to is the deck's to say: the partial
            // file knows its bytes and its version, not whether the user
            // pressed Install or Update, and the two rows wait on different
            // result frames.
            let updating = serde_json::from_slice::<serde_json::Value>(raw_payload)
                .ok()
                .and_then(|v| v.get("update").and_then(serde_json::Value::as_bool))
                .unwrap_or(false);
            let result_action = if updating {
                "claude_update_result"
            } else {
                "claude_install_result"
            };
            tokio::spawn(run_claude_install(cat, result_action));
        }
        Ok(A::ClaudeDownloadPause) => {
            // Drop the in-flight request and keep the partial file ([B09]).
            // A press that lands after the last byte finds nothing running,
            // which is a no-op rather than an error.
            info!("dispatch_action: claude download pause requested");
            crate::feeds::claude_download::stop(crate::feeds::claude_download::StopReason::Paused);
        }
        Ok(A::ClaudeDownloadCancel) => {
            // Cancel is pause plus forgetting the bytes. The sweep runs
            // whether or not anything was in flight: cancelling an *already*
            // paused download is the case where nothing is, and the partial
            // is the only thing left to remove.
            info!("dispatch_action: claude download cancel requested");
            crate::feeds::claude_download::stop(
                crate::feeds::claude_download::StopReason::Cancelled,
            );
            let dir = crate::feeds::claude_download::download_dir();
            tokio::task::spawn_blocking(move || {
                crate::feeds::claude_download::discard_partials(&dir)
            });
        }
        Ok(A::CheckClaudeVersion) => {
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
        Ok(A::UpdateClaude) => {
            // Update in place: the official installer always lands the stable
            // channel's newest build, so an update is the same operation as a
            // first install — only the reporting differs, so the wizard can say
            // "Updating…" rather than "Installing…". Re-probes the version pair
            // afterward so the row settles on what is now installed.
            info!("dispatch_action: claude update requested");
            let cat = stream_outputs
                .get(&FeedId::CONTROL)
                .map(|(tx, _)| tx.clone());
            tokio::spawn(run_claude_install(cat, "claude_update_result"));
        }
        Ok(A::ClaudeSignIn) => {
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
        Ok(A::ClaudeLogout) => {
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
                    send_control(cat, body);
                }
                let state = crate::feeds::claude_auth::probe().await;
                broadcast_auth_result(cat, state, None);
            });
        }
        Ok(A::SharedAgentClassify) => {
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
        // Everything else goes out on the page lane unchanged, addressed: an
        // action the supervisor or router owns that reached here without
        // them, and an action string tugcast does not know at all — the
        // second is how one client reaches another, so it is logged by name
        // rather than refused. The payload's own `to` names the target; a
        // tell without one goes to the ingress's default. A target no live
        // page answers is dropped and logged, never broadcast to nobody.
        parsed => {
            if parsed.is_err() {
                info!(
                    action,
                    "dispatch_action: unmatched action string, forwarding"
                );
            } else {
                info!("dispatch_action: forwarding client action: {}", action);
            }
            let to = serde_json::from_slice::<serde_json::Value>(raw_payload)
                .ok()
                .and_then(|v| v.get("to").cloned());
            let target = match to {
                None | Some(serde_json::Value::Null) => Some(ctx.default_to.clone()),
                Some(to) => parse_target(&to),
            };
            let Some(target) = target else {
                info!(action, "dispatch_action: unreadable `to`; dropped");
                return;
            };
            match pages.resolve(&target) {
                Some(delivery) => {
                    let frame = Frame::new(FeedId::CONTROL, raw_payload.to_vec());
                    let _ = page_lane.send(AddressedFrame {
                        to: delivery,
                        frame,
                    });
                }
                None => info!(action, "dispatch_action: no page answers {target}; dropped"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::Delivery;

    /// Dispatch `payload` through the catch-all with `pages` and `default_to`,
    /// and return what reached the page lane and what reached CONTROL.
    async fn catch_all(
        payload: &[u8],
        pages: &PageRegistry,
        default_to: PageTarget,
    ) -> (Vec<AddressedFrame>, usize) {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut control_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();
        let (page_lane, mut lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));
        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));

        dispatch_action(
            "show-card",
            payload,
            &ActionContext {
                shutdown_tx: &shutdown_tx,
                stream_outputs: &stream_outputs,
                dev_state: &dev_state,
                pending_evals: &pending_evals,
                pending_asks: &pending_asks,
                shared_agent: &None,
                page_lane: &page_lane,
                pages,
                default_to,
            },
        )
        .await;

        let mut lane = Vec::new();
        while let Ok(frame) = lane_rx.try_recv() {
            lane.push(frame);
        }
        let mut control = 0;
        while control_rx.try_recv().is_ok() {
            control += 1;
        }
        (lane, control)
    }

    fn registry_with_shell_and_body() -> PageRegistry {
        let pages = PageRegistry::new();
        pages.register(
            4,
            &tugcast_core::PageIdentity {
                role: tugcast_core::PageRole::Shell,
                page_id: Some("s".into()),
                card_id: None,
            },
        );
        pages.register(
            6,
            &tugcast_core::PageIdentity {
                role: tugcast_core::PageRole::Body,
                page_id: Some("b".into()),
                card_id: Some("c1".into()),
            },
        );
        pages
    }

    /// A host tell with no `to` reaches the shell alone, on the page lane,
    /// with its payload untouched; nothing goes out on CONTROL.
    #[tokio::test]
    async fn an_unknown_tell_goes_to_the_shell_on_the_page_lane() {
        let pages = registry_with_shell_and_body();
        let (lane, control) =
            catch_all(br#"{"action":"show-card"}"#, &pages, PageTarget::Shell).await;
        assert_eq!(lane.len(), 1);
        assert_eq!(lane[0].to, Delivery::Client(4));
        assert_eq!(lane[0].frame.feed_id, FeedId::CONTROL);
        assert_eq!(lane[0].frame.payload, br#"{"action":"show-card"}"#);
        assert_eq!(control, 0);
    }

    /// A payload's own `to` outranks the ingress default.
    #[tokio::test]
    async fn a_tell_names_its_own_target() {
        let pages = registry_with_shell_and_body();
        let (lane, _) = catch_all(
            br#"{"action":"show-card","to":"all"}"#,
            &pages,
            PageTarget::Shell,
        )
        .await;
        assert_eq!(lane[0].to, Delivery::All);
        let (lane, _) = catch_all(
            br#"{"action":"show-card","to":{"card":"c1"}}"#,
            &pages,
            PageTarget::Shell,
        )
        .await;
        assert_eq!(lane[0].to, Delivery::Client(6));
    }

    /// A target no live page answers is dropped, not broadcast to nobody.
    #[tokio::test]
    async fn a_tell_with_no_shell_is_dropped() {
        let (lane, control) = catch_all(
            br#"{"action":"show-card"}"#,
            &PageRegistry::new(),
            PageTarget::Shell,
        )
        .await;
        assert!(lane.is_empty());
        assert_eq!(control, 0);
    }

    /// An unmatched action still reaches the other clients: the WebSocket
    /// ingress's default is every connection.
    #[tokio::test]
    async fn a_client_action_still_reaches_every_client() {
        let pages = registry_with_shell_and_body();
        let (lane, _) = catch_all(br#"{"action":"show-card"}"#, &pages, PageTarget::All).await;
        assert_eq!(lane.len(), 1);
        assert_eq!(lane[0].to, Delivery::All);
        assert!(lane[0].to.admits(4) && lane[0].to.admits(6) && lane[0].to.admits(99));
    }

    /// The deck's answer reaches the waiting requester.
    #[tokio::test]
    async fn test_dispatch_ask_response_resolves_pending() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, _rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();
        let (page_lane, _lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let pages = PageRegistry::new();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks: crate::router::PendingAsks =
            std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));

        let (tx, rx) = tokio::sync::oneshot::channel();
        pending_asks.lock().insert("req-1".to_owned(), tx);

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
                page_lane: &page_lane,
                pages: &pages,
                default_to: PageTarget::Shell,
            },
        )
        .await;

        assert_eq!(rx.await.unwrap(), "run-background-only");
        assert!(pending_asks.lock().is_empty());
    }

    /// The observability verbs answer in the shape the local-model verbs did
    /// ([P07]) — same action names but for the prefix, same fields — so the
    /// eval harness reads a verdict the same way it always has.
    #[tokio::test]
    async fn shared_agent_classify_broadcasts_a_parsed_verdict() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, mut client_action_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();
        let (page_lane, _lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let pages = PageRegistry::new();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
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
                page_lane: &page_lane,
                pages: &pages,
                default_to: PageTarget::Shell,
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
        let (page_lane, _lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let pages = PageRegistry::new();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));

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
                page_lane: &page_lane,
                pages: &pages,
                default_to: PageTarget::Shell,
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
        let (page_lane, _lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let pages = PageRegistry::new();

        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));

        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks: crate::router::PendingAsks =
            std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));

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
                page_lane: &page_lane,
                pages: &pages,
                default_to: PageTarget::Shell,
            },
        )
        .await;

        assert!(pending_asks.lock().is_empty());
    }

    /// The host's `body_dormant` tell reaches the registry the router reads
    /// ([B05]), and a malformed one changes nothing.
    #[tokio::test]
    async fn a_body_dormant_tell_marks_the_card_in_the_registry() {
        let pages = PageRegistry::new();
        let (shutdown_tx, _) = mpsc::channel(1);
        let (client_action_tx, _control_rx) = broadcast::channel(16);
        let dev_state = crate::dev::new_shared_dev_state();
        let (page_lane, _lane_rx) = broadcast::channel::<AddressedFrame>(16);
        let mut stream_outputs = HashMap::new();
        stream_outputs.insert(FeedId::CONTROL, (client_action_tx, LagPolicy::Warn));
        let pending_evals = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let pending_asks = std::sync::Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let ctx = ActionContext {
            shutdown_tx: &shutdown_tx,
            stream_outputs: &stream_outputs,
            dev_state: &dev_state,
            pending_evals: &pending_evals,
            pending_asks: &pending_asks,
            shared_agent: &None,
            page_lane: &page_lane,
            pages: &pages,
            default_to: PageTarget::Shell,
        };
        let tell = |payload: &'static [u8]| dispatch_action("body_dormant", payload, &ctx);

        tell(br#"{"action":"body_dormant","card_id":"c1","dormant":true}"#).await;
        assert!(pages.dormant_cards().borrow().contains("c1"));

        tell(br#"{"action":"body_dormant","card_id":"","dormant":false}"#).await;
        tell(br#"{"action":"body_dormant","card_id":"c1"}"#).await;
        assert!(pages.dormant_cards().borrow().contains("c1"), "a malformed tell is ignored");

        tell(br#"{"action":"body_dormant","card_id":"c1","dormant":false}"#).await;
        assert!(!pages.dormant_cards().borrow().contains("c1"));
    }
}
