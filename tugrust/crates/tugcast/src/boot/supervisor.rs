//! `boot::supervisor` — the agent supervisor, the model pools, the bridges
//! and dispatchers that hang off it, the feed router, and the engines that
//! run beside it. Produces the [`Runtime`] the serve stage runs.
//!
//! The router is built here rather than in the feeds stage because it is
//! built from the supervisor: it registers the bridges the supervisor's
//! resolver and digester feed, and it holds the supervisor itself.
//!
//! The process-wide `OnceLock`s startup fills are filled in this stage, each
//! marked where it happens: `agent_supervisor::LEDGER_HANDLE` (inside
//! `AgentSupervisor::new_with_ledger`), `join_pilot::RUNNER`, the base-motion
//! `BOARD` (inside `run_base_motion_engine`), and the supervisor's four
//! late-bound channels. The crate's other `OnceLock` statics initialise
//! lazily on first use and belong to no startup stage.

use std::sync::Arc;

use tokio::sync::mpsc;
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame};

use crate::boot::{Bound, Feeds, InkLedgers, Ledgers, Runtime, Streams};
use crate::cli;
use crate::feeds;
use crate::feeds::agent_supervisor::{
    AgentSupervisor, AgentSupervisorConfig, LedgerSessionsRecorder, SessionsRecorder,
    SpawnerFactory, default_spawner_factory,
};
use crate::jots;
use crate::router::{FeedRouter, LagPolicy};
use crate::scribe;
use crate::shared_agent;
use crate::wheel;

/// Build the supervisor and everything wired to it, rebind the ledger's
/// rows, spawn the dispatchers and engines, build and fill the router, and
/// hand the serve stage what it runs.
pub(crate) async fn supervisor(
    cli: &cli::Cli,
    bound: Bound,
    ledgers: Ledgers,
    ink: InkLedgers,
    feeds: Feeds,
) -> Runtime {
    let Bound {
        listener,
        actual_port,
        auth,
        auth_url,
        ..
    } = bound;
    let Ledgers {
        bank_client,
        notify_socket_path,
        ledger,
        prompt_ledger,
    } = ledgers;
    let InkLedgers {
        shell_ledger,
        refs_ledger,
    } = ink;
    let Feeds {
        streams,
        defaults_rx,
        cancel,
        ft_response_tx,
        fs_event_tx,
        file_watch_tx,
        file_watch_input_tx,
        gd_response_tx,
        gl_response_tx,
        gh_response_tx,
        gcf_response_tx,
        usage_response_tx,
        changeset_all_bump,
        registry,
        bootstrap,
        ft_input_tx,
        gd_input_tx,
        gl_input_tx,
        gcf_input_tx,
        usage_input_tx,
        shutdown_tx,
        shutdown_rx,
        ctl_shutdown_tx,
        client_action_tx,
        shared_dev_state,
        control_writer,
        control_reader,
        tugcode_path,
        session_state_feed,
        session_sideband_feed,
        activity_feed,
    } = feeds;
    let Streams {
        code_output_feed,
        code_input_tx,
        code_input_rx,
        code_submission_tx,
        code_input_relay_tx,
        shell_output_feed,
        shell_input_tx,
        shell_input_rx,
        refs_output_feed,
        refs_input_tx,
        refs_input_rx,
        terminal_feed,
        terminal_input_tx,
        watch_dir: _,
    } = streams;

    let ledger_recorder = Arc::new(
        LedgerSessionsRecorder::with_broadcast(Arc::clone(&ledger), client_action_tx.clone())
            .with_changeset_bump(registry.changeset_all_bump()),
    );

    // Trash sweep: walk every workspace's `.tug-trash/<deletedAt>/`
    // under `~/.claude/projects/` and remove any deletedAt subdir older
    // than 7 days. This is the only sweep at startup: a `sessions` row is
    // never removed on its own, so the only JSONLs here are ones the user
    // trashed by hand.
    let trash_max_age_ms = crate::session_ledger::DEV_TRASH_SWEEP_AGE_DAYS * 86_400_000;
    let trash_swept = ledger.sweep_trash(trash_max_age_ms, crate::session_ledger::now_millis());
    if trash_swept > 0 {
        info!(
            count = trash_swept,
            "swept stale trash directories on startup"
        );
    }

    // Background warm scan: pre-populate the external-session scan cache
    // for every project dir that already has ledger rows, so the picker's
    // first open after launch finds terminal-created sessions already
    // cached (a warm, stat-only scan) instead of paying the multi-second
    // cold JSONL parse on the user's timeline. Detached and best-effort:
    // it never blocks startup, and an empty/failed scan is harmless. The
    // scan itself fans out across cores (rayon), and `scan_*_cached` is
    // idempotent, so a concurrent picker scan during warm-up only
    // duplicates work, never corrupts.
    {
        let ledger = Arc::clone(&ledger);
        tokio::task::spawn_blocking(move || {
            let dirs = match ledger.distinct_workspaces() {
                Ok(dirs) => dirs,
                Err(err) => {
                    warn!(error = %err, "warm scan: distinct_workspaces failed");
                    return;
                }
            };
            for dir in dirs {
                let outcome =
                    crate::external_sessions::scan_external_sessions_cached(&ledger, &dir);
                if outcome.parsed > 0 {
                    info!(
                        project_dir = %dir,
                        parsed = outcome.parsed,
                        cache_hits = outcome.cache_hits,
                        "warm scan populated external-session cache",
                    );
                }
            }
        });
    }

    let sessions_recorder: Arc<dyn SessionsRecorder> = ledger_recorder;

    let supervisor_config = AgentSupervisorConfig {
        tugcode_path: tugcode_path.clone(),
        ..Default::default()
    };
    let spawner_factory: SpawnerFactory = default_spawner_factory(&supervisor_config);

    // Initialises `agent_supervisor::LEDGER_HANDLE` — owned by this stage.
    let (mut supervisor, merger_register_rx) = AgentSupervisor::new_with_ledger(
        session_state_feed.clone(),
        session_sideband_feed.clone(),
        code_output_feed.clone(),
        activity_feed.clone(),
        client_action_tx.clone(),
        sessions_recorder,
        Some(Arc::clone(&ledger)),
        spawner_factory,
        supervisor_config,
        Arc::clone(&registry),
        cancel.clone(),
    );
    // Give the supervisor the shell ledger so `list_shell_exchanges` can read
    // the tail the shell dispatcher writes.
    if let Some(sl) = shell_ledger.as_ref() {
        supervisor.set_shell_ledger(Arc::clone(sl));
    }
    // Same for the refs ledger, which backs the `list_refs` restore read.
    if let Some(rl) = refs_ledger.as_ref() {
        supervisor.set_refs_ledger(Arc::clone(rl));
    }
    // And the prompt ledger, which a directory change writes the moved
    // session's prompt lineage into before acknowledging the move.
    if let Some(pl) = prompt_ledger.as_ref() {
        supervisor.set_prompt_ledger(Arc::clone(pl));
    }

    // The changeset scribe ([P11]/[P22]): the maintained-draft engine runs a
    // headless `claude -p` with the model from
    // the tugbank default `dev.tugapp.changeset`/`scribe_model` (resolved per
    // request, so a settings change applies immediately), falling back to
    // `sonnet` — the fingerprint gate ([P22]) bounds how often it runs, so the
    // model choice is a quality call, not a cost one.
    let scribe_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| b.get("dev.tugapp.changeset", "scribe_model").ok().flatten())
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| "sonnet".to_string())
        })
    };
    supervisor.set_scribe(feeds::agent_supervisor::ScribeContext {
        spawner: Arc::new(scribe::ClaudeScribeSpawner),
        model: scribe_model,
    });

    // The Haiku SharedAgent ([P02]): one app-scoped pool serving the jobs that
    // used to run on the on-device pack. Building it spawns nothing — the first
    // job of a class is what spawns that class's worker, so a machine that never
    // types a shell candidate never pays for a classify worker.
    let shared_agent_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| {
                    b.get(shared_agent::SHARED_AGENT_DOMAIN, shared_agent::MODEL_KEY)
                        .ok()
                        .flatten()
                })
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                // A full id, never a bare alias ([P03]) — aliases drift, and a
                // drifting aux model is a silent behavior change.
                .unwrap_or_else(|| shared_agent::HAIKU_MODEL.to_string())
        })
    };
    let max_workers = bank_client
        .as_ref()
        .and_then(|b| {
            b.get(
                shared_agent::SHARED_AGENT_DOMAIN,
                shared_agent::MAX_WORKERS_KEY,
            )
            .ok()
            .flatten()
        })
        .and_then(|v| match v {
            tugbank_core::Value::I64(n) if n > 0 => Some(n as usize),
            _ => None,
        })
        .unwrap_or(shared_agent::DEFAULT_MAX_WORKERS);
    let haiku_agent = shared_agent::SharedAgentPool::new(
        shared_agent::AgentSpec {
            name: "haiku",
            model: shared_agent_model,
            jobs: shared_agent::HAIKU_AGENT_JOBS,
            max_workers,
        },
        Arc::new(shared_agent::ClaudeAgentWorkerSpawner),
    );

    // The Overview's Sonnet agent: a second `AgentSpec` on the same pool
    // machinery, carrying the Observer's digests and both halves of the
    // Operator. Like the Haiku pool, building it spawns nothing — the first
    // job of a class spawns that class's worker, so an instance where nobody
    // opens the Overview never pays for one.
    //
    // Model and worker cap are read per spawn from the `dev.tugapp.overview`
    // defaults, so both apply without a restart.
    let overview_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| {
                    b.get(
                        feeds::overview_agent::OVERVIEW_DOMAIN,
                        feeds::overview_agent::MODEL_KEY,
                    )
                    .ok()
                    .flatten()
                })
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| feeds::overview_agent::DEFAULT_MODEL.to_string())
        })
    };
    let overview_max_workers = bank_client
        .as_ref()
        .and_then(|b| {
            b.get(
                feeds::overview_agent::OVERVIEW_DOMAIN,
                feeds::overview_agent::MAX_WORKERS_KEY,
            )
            .ok()
            .flatten()
        })
        .and_then(|v| match v {
            tugbank_core::Value::I64(n) if n > 0 => Some(n as usize),
            _ => None,
        })
        .unwrap_or(feeds::overview_agent::DEFAULT_MAX_WORKERS);
    let overview_agent = feeds::overview_agent::build_pool(overview_model, overview_max_workers);

    // OVERVIEW — the Observer's live bridge. It taps the same CODE_OUTPUT
    // frames the digester narrates from plus the submission wire and
    // SESSION_STATE, buffers them per session, and wakes the Sonnet pool at
    // structural moments. What a wake *means* lives in `observer_wake`, the
    // pure core the offline replay harness drives too — which is what makes
    // the cadence tuned against real transcripts the cadence that ships.
    //
    // Every knob is a closure read at the moment it is used, so turning one
    // in tugbank reaches the next wake with no restart.
    let overview_knob = {
        let bank = bank_client.clone();
        move |key: &'static str, fallback: i64| -> Arc<dyn Fn() -> i64 + Send + Sync> {
            let bank = bank.clone();
            Arc::new(move || {
                bank.as_ref()
                    .and_then(|b| {
                        b.get(feeds::overview_agent::OVERVIEW_DOMAIN, key)
                            .ok()
                            .flatten()
                    })
                    .and_then(|v| match v {
                        tugbank_core::Value::I64(n) if n >= 0 => Some(n),
                        _ => None,
                    })
                    .unwrap_or(fallback)
            })
        }
    };
    let overview_sitrep = overview_knob(
        feeds::overview_agent::SITREP_SECS_KEY,
        feeds::overview_agent::DEFAULT_SITREP_SECS,
    );
    let overview_submission_arm = overview_knob(
        feeds::overview_agent::SUBMISSION_ARM_SECS_KEY,
        feeds::overview_agent::DEFAULT_SUBMISSION_ARM_SECS,
    );
    let overview_token_wake = overview_knob(
        feeds::overview_agent::TOKEN_WAKE_TOKENS_KEY,
        feeds::overview_agent::DEFAULT_TOKEN_WAKE_TOKENS,
    );
    let overview_last_k = overview_knob(
        feeds::overview_agent::LAST_K_POSTS_KEY,
        feeds::overview_agent::DEFAULT_LAST_K_POSTS as i64,
    );
    let overview_buffer_frames = overview_knob(
        feeds::overview_agent::BUFFER_MAX_FRAMES_KEY,
        feeds::overview_agent::DEFAULT_BUFFER_MAX_FRAMES as i64,
    );
    // The subsystem's one switch ([P10]). A bool rather than an i64, so it
    // gets its own closure instead of riding `overview_knob` — same posture:
    // read at the wake, so a flip is live with no restart. Absent, wrongly
    // typed and unreadable all read as ENABLED, the repo's kill-switch
    // convention.
    let overview_enabled: Arc<dyn Fn() -> bool + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            let Some(bank) = bank.as_ref() else {
                return true;
            };
            match bank.get(
                feeds::overview_agent::OVERVIEW_DOMAIN,
                feeds::overview_agent::OVERVIEW_ENABLED_KEY,
            ) {
                Ok(Some(tugbank_core::Value::Bool(enabled))) => enabled,
                _ => true,
            }
        })
    };
    let observer_bridge =
        feeds::observer::ObserverBridge::new(feeds::observer::ObserverBridgeConfig {
            code_tx: code_output_feed.sender(),
            submission_tx: code_submission_tx.clone(),
            session_state_tx: session_state_feed.sender(),
            ledger: Some(Arc::clone(&ledger)),
            // The wake writes the session's standing sentence as well as its
            // post, so it needs the CONTROL push and the row the sentence
            // belongs to ([P07]).
            control_tx: Some(client_action_tx.clone()),
            resolver: supervisor.session_resolver(),
            agent: Some(Arc::clone(&overview_agent)),
            enabled: overview_enabled,
            sitrep_secs: overview_sitrep,
            submission_arm_secs: overview_submission_arm,
            token_wake_tokens: overview_token_wake,
            last_k_posts: Arc::new(move || overview_last_k().max(0) as usize),
            buffer_max_frames: Arc::new(move || overview_buffer_frames().max(1) as usize),
        });

    // DIGEST — the instant beat. One bridge per process, and no subprocess: it
    // taps CODE_OUTPUT for the allowlisted frame subset, the submission wire
    // for what the human asked, and SHELL_OUTPUT for exchanges, runs all three
    // through the in-process digester, and broadcasts the lines it emits on
    // DIGEST. It has no switch of its own ([P10]): the beat is deterministic
    // and free, and the one knob in this subsystem gates the Observer's wakes,
    // which are the only model cost.
    // A StreamFeed: its channel, lag policy, and task come from
    // `register_stream_feed` below.
    // The one digester. The bridge is its only writer — it holds the single
    // CODE_OUTPUT / CODE_INPUT / SHELL_OUTPUT tap ([P01]) — and the standing
    // sentence reads the deque it fills rather than taking a tap of its own.
    let digester: feeds::session_digest::SharedDigester = Default::default();
    let digest_bridge =
        feeds::digest_bridge::DigestBridge::new(feeds::digest_bridge::DigestBridgeConfig {
            code_tx: code_output_feed.sender(),
            submission_tx: code_submission_tx.clone(),
            shell_tx: shell_output_feed.sender(),
            digester: digester.clone(),
        });
    // The read side of the deck's mount-time tail: `list_digest_lines` answers
    // from this deque, so the supervisor holds the same handle the bridge fills.
    supervisor.set_digester(digester.clone());

    let supervisor = Arc::new(supervisor);

    // Rebind persisted ledger rows. Per [F15] this only populates the
    // in-memory ledger — `client_sessions` is left untouched and real
    // clients connecting after startup send their own `spawn_session`
    // CONTROL frames.
    // The join pilot reaches the supervisor through a process-global handle,
    // registered once the supervisor is in its Arc ([P01]).
    // Initialises `join_pilot::RUNNER` — owned by this stage.
    supervisor.register_pilot_runner();

    match supervisor.rebind_from_ledger().await {
        Ok(count) if count > 0 => info!(count, "rebound ledger rows on startup"),
        Ok(_) => {}
        Err(e) => warn!(error = %e, "rebind_from_ledger failed (non-fatal)"),
    }

    // Spawn the supervisor's dispatcher task (consumes CODE_INPUT, routes
    // to per-session workers) and merger task (fans in per-session stdout
    // streams and publishes system_metadata to SESSION_SIDEBAND).
    let dispatcher_supervisor = Arc::clone(&supervisor);
    tokio::spawn(async move {
        dispatcher_supervisor.dispatcher_task(code_input_rx).await;
    });
    // Shell dispatcher: routes SHELL_INPUT to per-session pipe-mode shell
    // children, publishes exchange frames on SHELL_OUTPUT, and records each
    // settled exchange to the shell ledger for restore.
    let shell_dispatch_feed = shell_output_feed.clone();
    let shell_dispatch_ledger = shell_ledger.clone();
    // The `$` route's handle on the facts library ([P06]) — the settle site
    // records a `shell` fact, and a `test_run` fact when the command was one.
    let shell_dispatch_sessions = Some(Arc::clone(&ledger));
    let shell_dispatch_agent = Some(Arc::clone(&haiku_agent));
    let shell_dispatch_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::shell::shell_dispatcher_task(
            shell_input_rx,
            shell_dispatch_feed,
            shell_dispatch_ledger,
            shell_dispatch_sessions,
            shell_dispatch_agent,
            shell_dispatch_cancel,
        )
        .await;
    });
    // Refs dispatcher: routes REFS_INPUT to the match/search ops and streams
    // their numbered result rows back on REFS_OUTPUT.
    let refs_dispatch_feed = refs_output_feed.clone();
    let refs_dispatch_ledger = refs_ledger.clone();
    let refs_dispatch_sessions = Some(Arc::clone(&ledger));
    let refs_dispatch_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::refs::refs_dispatcher_task(
            refs_input_rx,
            refs_dispatch_feed,
            refs_dispatch_ledger,
            refs_dispatch_sessions,
            refs_dispatch_cancel,
        )
        .await;
    });
    let merger_cancel = cancel.clone();
    let merger_supervisor = Arc::clone(&supervisor);
    tokio::spawn(async move {
        merger_supervisor
            .merger_task(merger_register_rx, merger_cancel)
            .await;
    });

    // Spawn the OS resource sampler: at 1 Hz (gated to live sessions) it
    // walks each session's tugcode subtree and publishes CPU/memory gauge
    // samples onto the ACTIVITY feed ([P08]-[P10], [P20]).
    let sampler_supervisor = Arc::clone(&supervisor);
    let sampler_activity = activity_feed.clone();
    let sampler_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::activity::resource::run_resource_sampler(
            sampler_supervisor,
            sampler_activity,
            sampler_cancel,
        )
        .await;
    });

    // Build feed router with dynamic registration
    let mut feed_router = FeedRouter::new(
        cli.session.clone(),
        auth.clone(),
        shutdown_tx,
        shared_dev_state.clone(),
    );
    feed_router.shared_agent = Some(Arc::clone(&haiku_agent));

    // Register stream feeds through the trait-mediated path — each feed
    // self-describes its id, lag policy, and channel capacity, and the
    // router creates the channel and spawns the task.
    feed_router.register_stream_feed(Box::new(terminal_feed), cancel.clone());
    // DIGEST lines fan out to every connected deck; the tail
    // a reconnecting deck needs comes from the `list_digest_lines`
    // CONTROL read, not feed replay ([P09]).
    feed_router.register_stream_feed(Box::new(digest_bridge), cancel.clone());
    // OVERVIEW posts fan out to every connected deck; the tail a reconnecting
    // deck needs comes from the `list_overview_posts` CONTROL read. This call's
    // return value is the only source of the OVERVIEW sender, so the Operator
    // adapter — which publishes user questions and answers on the same feed —
    // is constructed after it.
    let overview_tx = feed_router.register_stream_feed(Box::new(observer_bridge), cancel.clone());

    // Adapter: router sends raw Frames on OVERVIEW_INPUT. Parse `{body,
    // requestId}` and run the Operator pipeline — user post persisted and
    // broadcast first ([P08]), then retrieve → verbs → answer, then the
    // answer post with the request id echoed so the card's pending row can
    // clear. Each question runs in its own task, the USAGE_QUERY shape: two
    // people asking at once are two pipelines, not a queue, and the pool's
    // worker cap is what actually bounds the concurrency.
    let (gz_input_tx, mut gz_input_rx) = mpsc::channel::<Frame>(16);
    let operator_pipeline = Arc::new(feeds::operator::OperatorPipeline {
        ctx: Arc::new(feeds::operator::OperatorContext {
            ledger: Arc::clone(&ledger),
            // The same handle the shell dispatcher records exchanges through;
            // `shell.history` reads them back.
            shell_ledger: shell_ledger.clone(),
            bootstrap_project_dir: bootstrap.project_dir.clone(),
            // Beside the ledger the posts live in, so an instance's history
            // and the pictures in it are one thing to keep or to throw away.
            attachments_dir: tugcore::instance::data_dir().join("overview-attachments"),
            // The search ladder's last rung ([P09]). The same pool the shell
            // classifier and the session headlines use — warm workers, one
            // reviewed job table, and nothing spawned until a search actually
            // comes back empty twice.
            haiku: Some(Arc::clone(&haiku_agent)),
        }),
        pool: Arc::clone(&overview_agent),
        overview_tx: overview_tx.clone(),
    });
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawOverviewInput {
            body: Option<String>,
            #[serde(rename = "requestId", alias = "request_id")]
            request_id: Option<String>,
            /// Images composed with the question — the deck's already
            /// downsampled bytes. Absent on every question typed without one.
            #[serde(default)]
            attachments: Vec<feeds::operator::QuestionAttachment>,
            /// The files the asker pointed at with an `@` atom. Absent on
            /// every question typed without one, and on an older deck's
            /// payload — which is what `default` keeps working.
            #[serde(default)]
            refs: Vec<feeds::operator::QuestionRef>,
        }
        while let Some(frame) = gz_input_rx.recv().await {
            let raw = match serde_json::from_slice::<RawOverviewInput>(&frame.payload) {
                Ok(raw) => raw,
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "OVERVIEW_INPUT: malformed JSON payload"
                    );
                    continue;
                }
            };
            // A question can be a picture and nothing else — "what is this?"
            // is what the screenshot is for — so a missing body is only
            // malformed when nothing was attached either.
            let body = raw.body.unwrap_or_default();
            if body.trim().is_empty() && raw.attachments.is_empty() {
                warn!("OVERVIEW_INPUT: payload carried no body");
                continue;
            }
            let pipeline = Arc::clone(&operator_pipeline);
            tokio::spawn(async move {
                pipeline
                    .handle(body, raw.request_id, raw.attachments, raw.refs)
                    .await;
            });
        }
    });

    feed_router.register_session_feed(&code_output_feed);
    // SHELL_OUTPUT — session-scoped exchange frames; the reconnect tail comes
    // from the ledger CONTROL read, not feed replay (like DIGEST).
    feed_router.register_session_feed(&shell_output_feed);
    // REFS_OUTPUT — session-scoped result frames; like SHELL_OUTPUT, the
    // reconnect state comes from the ledger CONTROL read, not feed replay.
    feed_router.register_session_feed(&refs_output_feed);
    // CONTROL stays a channel-registered stream: router-internal,
    // bidirectional, and the sink for router-emitted error frames — one
    // of the two named exemptions from the feed abstraction.
    feed_router.register_stream(FeedId::CONTROL, client_action_tx.clone(), LagPolicy::Warn);
    // SESSION_STATE / SESSION_SIDEBAND are broadcast streams (not snapshot
    // watches) per [D14]: a single watch slot would clobber concurrent
    // per-session updates. Per-session replay on reconnect is handled
    // event-driven inside `AgentSupervisor::handle_control("spawn_session")`
    // — there is no snapshot-watch registration for either feed.
    feed_router.register_session_feed(&session_state_feed);
    feed_router.register_session_feed(&session_sideband_feed);
    // ACTIVITY ([P16]) — a native SessionScopedFeed client. The merger
    // publishes diverted `activity_delta` samples through the handle; the
    // router wires the same broadcast channel into client delivery.
    feed_router.register_session_feed(&activity_feed);

    // Register input sinks (client → server backends). CODE_INPUT points
    // at the supervisor's dispatcher (spawned above); the dispatcher
    // parses `tug_session_id`, consults the ledger, and routes to the
    // per-session worker.
    feed_router.register_input(FeedId::TERMINAL_INPUT, terminal_input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, terminal_input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_relay_tx);
    feed_router.register_input(FeedId::SHELL_INPUT, shell_input_tx);
    feed_router.register_input(FeedId::REFS_INPUT, refs_input_tx);
    feed_router.register_input(FeedId::FILETREE_QUERY, ft_input_tx);
    feed_router.register_input(FeedId::FILE_WATCH_QUERY, file_watch_input_tx);
    feed_router.register_input(FeedId::GIT_DIFF_QUERY, gd_input_tx);
    feed_router.register_input(FeedId::GIT_LOG_QUERY, gl_input_tx);
    feed_router.register_input(FeedId::GIT_COMMIT_FILES_QUERY, gcf_input_tx);
    feed_router.register_input(FeedId::USAGE_QUERY, usage_input_tx);
    feed_router.register_input(FeedId::OVERVIEW_INPUT, gz_input_tx);

    // Attach the supervisor to the router so `handle_client` can intercept
    // session-lifecycle CONTROL frames and cross-check CODE_INPUT P5
    // ownership claims against `client_sessions`.
    feed_router.set_supervisor(Arc::clone(&supervisor));

    // Register snapshot watches.
    //
    // `bootstrap.ft_watch_rx` is INCLUDED here even though FILETREE
    // responses now flow primarily through the shared broadcast
    // channel: the watch carries the bootstrap's initial empty
    // `FileTreeSnapshot`, and the router's "deliver latest value on
    // connect" pass for snapshot_watches is what causes the session card
    // to see *any* FILETREE frame before a query has been sent. The
    // session card gates rendering on `feedData.size > 0` across
    // `[CODE_INPUT, CODE_OUTPUT, SESSION_SIDEBAND, FILETREE]`; without
    // this initial empty frame, a brand-new card with no session
    // bound hangs at "Loading..." indefinitely. The broadcast does
    // not solve this on its own — broadcast carries no retained
    // history, so clients connecting after the initial publish miss
    // the empty snapshot.
    //
    // Bootstrap's *subsequent* responses (when a card is bound to the
    // tugtool repo) are written to BOTH the watch and the broadcast,
    // so JS receives them twice. Idempotent — the second parse
    // produces the same snapshot. Per-card workspaces write only to
    // the broadcast (their watches are never registered with the
    // router), so they don't double-publish.
    // Account-global aggregate changeset feed (CHANGESET_ALL, 0x24). One
    // process-level feed composing every open project into a single frame,
    // delivered like the other snapshot feeds (registered once, retained
    // latest value delivered on connect). Replaces the per-workspace
    // CHANGESET delivery, which only ever reached the bootstrap workspace.
    let (changeset_all_tx, changeset_all_rx) =
        tokio::sync::watch::channel(Frame::new(FeedId::CHANGESET_ALL, vec![]));
    let changeset_all_feed = feeds::changeset_all::ChangesetAllFeed::new(
        Arc::clone(&registry),
        Some(Arc::clone(&ledger)),
        Arc::clone(&changeset_all_bump),
    );
    tugcast_core::spawn_snapshot_feed(
        Box::new(changeset_all_feed),
        changeset_all_tx,
        cancel.clone(),
    );

    // The maintained-draft engine ([P21], #draft-engine) taps a CLONE of the
    // aggregate watch receiver — never the bump `Notify` (single waiter) — so
    // it sees every recompute the router does.
    supervisor.start_draft_engine(changeset_all_rx.clone(), cancel.clone());

    // The base-motion engine: replay an arc onto its base the moment the base
    // moves and it is safe to. It subscribes to the same GIT_HEAD broadcast the
    // router fans out, so no new watcher exists; the other two wakes are a
    // workspace opening (the registry) and a turn ending (the supervisor),
    // because a HEAD signal is an edge and the gate refuses to act mid-turn.
    let (workspace_open_tx, workspace_open_rx) = mpsc::channel::<String>(16);
    let (turn_complete_tx, turn_complete_rx) = mpsc::channel::<String>(64);
    registry.set_workspace_open_signal(workspace_open_tx);
    // Late-binds `supervisor.turn_complete_tx` — owned by this stage.
    let _ = supervisor.turn_complete_tx.set(turn_complete_tx);
    // The engine initialises `base_motion::BOARD` — owned by this stage.
    tokio::spawn(feeds::base_motion::run_base_motion_engine(
        feeds::base_motion::BaseMotionContext {
            registry: Arc::clone(&registry),
            supervisor_ledger: Arc::clone(&supervisor.ledger),
            session_ledger: Some(Arc::clone(&ledger)),
            bump: Arc::clone(&changeset_all_bump),
            // A conflicted replay becomes an ordinary turn: the submission goes
            // down the same CODE_INPUT queue the router feeds, and the opener
            // that makes it visible goes out on CODE_OUTPUT.
            code_input_tx: Some(code_input_tx.clone()),
            code_output: Some(supervisor.code_output.clone()),
            cancel: cancel.clone(),
        },
        gh_response_tx.subscribe(),
        workspace_open_rx,
        turn_complete_rx,
    ));

    // The arc runner: rotate a server-driven arc's next stage onto the
    // card it is bound to. Its primary wake is the same idle transition
    // base-motion takes, on a sibling channel because an mpsc has one consumer
    // ([P05]); the aggregate changeset watch is the slower floor, for a stage
    // that died without ever ending a turn.
    // The wheel: perform the rotations `POST /api/session` parked, on the
    // same idle transition, on a third sibling channel ([P04]). A request is
    // always parked and never performed at request time — a rotation mid-turn
    // kills the claude that asked for it.
    //
    // Built before the arc engine because the engine holds it: every stopper
    // goes through one path, and an ending arms a hand-back on these
    // registries rather than sending one.
    let wheel_state = Arc::new(wheel::WheelState::default());
    // The armed hand-backs a previous process left owed. A card pinned on a
    // stage model has nothing but the restore to un-pin it, and the debt
    // outlives the turn it was taken on — so it is read back here, before the
    // first turn of this process can end, and settled the ordinary way.
    wheel_state.attach_ledger(Arc::clone(&ledger));
    feed_router.wheel = Some(Arc::clone(&wheel_state));
    // The supervisor holds it too: the stoppers reachable from a CONTROL
    // frame live there, and `stop_arc_for_session` takes the state ([P03]).
    // Late-binds `supervisor.wheel` — owned by this stage.
    let _ = supervisor.wheel.set(Arc::clone(&wheel_state));

    let (arc_tick_tx, arc_tick_rx) = mpsc::channel::<String>(64);
    // Late-binds `supervisor.arc_tick_tx` — owned by this stage.
    let _ = supervisor.arc_tick_tx.set(arc_tick_tx);
    tokio::spawn(feeds::arc_runner::run_arc_engine(
        feeds::arc_runner::ArcContext {
            supervisor: Arc::clone(&supervisor),
            session_ledger: Arc::clone(&ledger),
            wheel: Arc::clone(&wheel_state),
            cancel: cancel.clone(),
            live_owner: tugcore::instance::instance_tmux_live,
            // Filled by `run_arc_engine` itself, which owns the channel's
            // other end.
            settle: None,
        },
        arc_tick_rx,
        changeset_all_rx.clone(),
    ));

    let (wheel_tick_tx, wheel_tick_rx) = mpsc::channel::<String>(64);
    // Late-binds `supervisor.wheel_tick_tx` — owned by this stage.
    let _ = supervisor.wheel_tick_tx.set(wheel_tick_tx);
    tokio::spawn(wheel::run_wheel(
        wheel::WheelContext {
            supervisor: Arc::clone(&supervisor),
            state: wheel_state,
            cancel: cancel.clone(),
        },
        wheel_tick_rx,
    ));

    // The run's quiet lines. A derived view of the arc log rather than an act
    // any caller performs, so the announcement is skippable only by not
    // writing the record — at which point the mutation did not happen (W8).
    tokio::spawn(feeds::arc_notes::run_arc_notes(
        feeds::arc_notes::ArcNotesContext {
            registry: Arc::clone(&registry),
            supervisor: Arc::clone(&supervisor),
            sessions: Arc::clone(&ledger),
            cancel: cancel.clone(),
        },
    ));

    // The machine-wide session index is written by every instance on this
    // machine, so a reference that answered `absent` here can become
    // answerable with nothing happening in this process. One watch, one
    // CONTROL frame, and the deck re-asks — never a timer.
    tokio::spawn(feeds::session_index_watch::run_session_index_watch(
        client_action_tx.clone(),
        cancel.clone(),
    ));

    // JOTS feed — watches the machine-global `jots.json` and pushes the whole
    // document to every client. The nudge lets `PUT /api/jots` force an
    // immediate rebuild. The migration runs first so a user arriving from a
    // pre-rename build sees their phrasebook in the very first frame.
    let jots_file_path = tugcore::instance::jots_path();
    jots::migrate_from_snippets(&jots_file_path);
    let (jots_rx, jots_nudge) = feeds::jots::jots_feed(jots_file_path.clone());
    let jots_state = Some(jots::JotsState::new(jots_file_path, jots_nudge));

    let mut snapshot_watches = vec![bootstrap.ft_watch_rx.clone(), changeset_all_rx];
    if let Some(rx) = defaults_rx {
        snapshot_watches.push(rx);
    }
    snapshot_watches.push(jots_rx);
    // SESSION_SIDEBAND and session_init snapshots moved to supervisor (Step 8).
    feed_router.add_snapshot_watches(snapshot_watches);
    // Multi-workspace FILETREE response stream — registered once. Every
    // connected client subscribes its own broadcast receiver in
    // `ClientState::Live` and forwards every frame to the socket. JS
    // filters by `workspace_key` to dispatch responses to the right
    // card. Per `arc/dev-atoms.md#step-pre-4`.
    feed_router.add_broadcast_senders(vec![
        ft_response_tx,
        gd_response_tx,
        gl_response_tx,
        gh_response_tx,
        gcf_response_tx,
        usage_response_tx,
    ]);
    // The two streams whose consumers must KNOW when they missed frames.
    // An empty `workspace_key` means every workspace: a client that lagged
    // cannot tell which project's events it lost, so it re-asks for all.
    feed_router.add_broadcast_sender_with_lag_frame(
        fs_event_tx,
        Frame::new(
            FeedId::FILESYSTEM,
            br#"{"workspace_key":"","resync":true,"events":[]}"#.to_vec(),
        ),
    );
    feed_router.add_broadcast_sender_with_lag_frame(
        file_watch_tx,
        Frame::new(FeedId::FILE_WATCH, br#"{"type":"resync"}"#.to_vec()),
    );

    // Filesystem, filetree, and git feed tasks are owned by the
    // WorkspaceRegistry's bootstrap entry — spawned inside
    // `WorkspaceEntry::new` in the feeds stage; their tasks all run through
    // the feed abstraction's spawn paths.

    Runtime {
        listener,
        actual_port,
        tmux_session: cli.session.clone(),
        auth,
        auth_url,
        control_writer,
        control_reader,
        ctl_shutdown_tx,
        shutdown_rx,
        feed_router,
        shared_dev_state,
        bank_client,
        jots_state,
        prompt_ledger,
        ledger,
        notify_socket_path,
        cancel,
    }
}
