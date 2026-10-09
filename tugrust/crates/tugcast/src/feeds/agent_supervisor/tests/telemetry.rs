//! Tests for the telemetry and listings family (`control/telemetry.rs`).

use super::*;

/// A supervisor wired with a forked sessions ledger and a shell ledger
/// whose ink already sits on the head, plus the CONTROL receiver the
/// restore answer arrives on.
fn supervisor_over_forked_ink() -> (
    AgentSupervisor,
    broadcast::Receiver<Frame>,
    Arc<crate::shell_ledger::ShellLedger>,
) {
    let (state_tx, _state_rx) = broadcast::channel(512);
    let (meta_tx, _meta_rx) = broadcast::channel(32);
    let (code_tx, _code_rx) = broadcast::channel(32);
    let (control_tx, control_rx) = broadcast::channel(512);
    let sessions = forked_pair();
    let recorder: Arc<dyn SessionsRecorder> =
        Arc::new(LedgerSessionsRecorder::new(Arc::clone(&sessions)));
    let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&sessions)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    sup.set_shell_ledger(Arc::clone(&shell));
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });
    (sup, control_rx, shell)
}

#[tokio::test]
async fn a_restore_read_under_any_segment_returns_the_lines_ink() {
    let (sup, mut control_rx, shell) = supervisor_over_forked_ink();
    for command in ["ls", "/commit"] {
        shell
            .record_exchange(&crate::shell_ledger::NewShellExchange {
                tug_session_id: "fork".to_string(),
                line_id: "line-1".to_string(),
                command: command.to_string(),
                output: "out\n".to_string(),
                exit_code: Some(0),
                cwd: "/proj".to_string(),
                cwd_after: None,
                started_at_ms: 1,
                settled_at_ms: 2,
                anchor_msg_id: None,
            })
            .expect("record");
    }

    // The still-parent-bound deck asks under the other segment's id.
    sup.do_list_shell_exchanges("parent", None).await;

    let frame = control_rx.recv().await.expect("a control frame");
    let body: serde_json::Value =
        serde_json::from_slice(&frame.payload).expect("control body is JSON");
    assert_eq!(body["action"], "list_shell_exchanges_ok");
    assert_eq!(
        body["tug_session_id"], "parent",
        "the response echoes the requested id — the deck routes on it"
    );
    assert_eq!(body["answered"], true);
    assert_eq!(
        body["exchanges"].as_array().unwrap().len(),
        2,
        "the line's ink, whichever of its segments was asked about"
    );
    assert_eq!(
        body["total"], 2,
        "the census counts the same set the rows came from"
    );
}

#[tokio::test]
async fn a_restore_read_for_the_newest_segment_is_the_same_answer() {
    let (sup, mut control_rx, shell) = supervisor_over_forked_ink();
    shell
        .record_exchange(&crate::shell_ledger::NewShellExchange {
            tug_session_id: "fork".to_string(),
            line_id: "line-1".to_string(),
            command: "ls".to_string(),
            output: "out\n".to_string(),
            exit_code: Some(0),
            cwd: "/proj".to_string(),
            cwd_after: None,
            started_at_ms: 1,
            settled_at_ms: 2,
            anchor_msg_id: None,
        })
        .expect("record");

    sup.do_list_shell_exchanges("fork", None).await;

    let frame = control_rx.recv().await.expect("a control frame");
    let body: serde_json::Value =
        serde_json::from_slice(&frame.payload).expect("control body is JSON");
    assert_eq!(body["tug_session_id"], "fork");
    assert_eq!(body["exchanges"].as_array().unwrap().len(), 1);
    assert_eq!(body["total"], 1);
}

/// `list_shell_exchanges { tug_session_id }` broadcasts
/// `list_shell_exchanges_ok { tug_session_id, exchanges: [...] }` with the
/// session's rows oldest-first — the deck's shell-restore tail read.
#[tokio::test]
async fn list_shell_exchanges_returns_the_session_tail() {
    // Build a supervisor with a shell ledger holding two exchanges.
    let shell_ledger = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().unwrap());
    for (cmd, code) in [("echo a", Some(0)), ("false", Some(1))] {
        shell_ledger
            .record_exchange(&crate::shell_ledger::NewShellExchange {
                tug_session_id: "s1".to_string(),
                line_id: "s1".to_string(),
                command: cmd.to_string(),
                output: format!("out:{cmd}\n"),
                exit_code: code,
                cwd: "/proj".to_string(),
                cwd_after: Some("/proj".to_string()),
                started_at_ms: 1,
                settled_at_ms: 2,
                anchor_msg_id: None,
            })
            .unwrap();
    }

    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let (state_tx, _s) = broadcast::channel(64);
    let (meta_tx, _m) = broadcast::channel(8);
    let (code_tx, _c) = broadcast::channel(8);
    let (control_tx, mut rx) = broadcast::channel(128);
    let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        control_tx.clone(),
    ));
    let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&ledger)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    sup.set_shell_ledger(Arc::clone(&shell_ledger));
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_shell_exchanges",
        "tug_session_id": "s1",
    }))
    .unwrap();
    sup.handle_control("list_shell_exchanges", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_shell_exchanges_ok");
    assert_eq!(response["tug_session_id"], "s1");
    let exchanges = response["exchanges"].as_array().expect("exchanges array");
    assert_eq!(exchanges.len(), 2);
    // Oldest-first.
    assert_eq!(exchanges[0]["command"], "echo a");
    assert_eq!(exchanges[0]["exit_code"], 0);
    assert_eq!(exchanges[1]["command"], "false");
    assert_eq!(exchanges[1]["exit_code"], 1);
    assert_eq!(exchanges[1]["seq"], 2);
}

/// `list_refs { tug_session_id }` broadcasts `list_refs_ok
/// { tug_session_id, run }` carrying the session's latest completed run —
/// the deck's refs-restore read. A session that has never searched gets a
/// null run rather than an error.
#[tokio::test]
async fn list_refs_returns_the_sessions_latest_run() {
    let refs_ledger = Arc::new(crate::refs_ledger::RefsLedger::open_in_memory().unwrap());
    refs_ledger
        .record_run(&crate::refs_ledger::NewRefsRun {
            tug_session_id: "s1".to_string(),
            line_id: "s1".to_string(),
            run_id: "run-1".to_string(),
            op_kind: "search".to_string(),
            command: "/search needle".to_string(),
            refs: vec![crate::feeds::text_ref::TextRef::content(
                1,
                "src/a.ts",
                12,
                vec![(4, 10)],
                crate::feeds::text_ref::LinePreview::whole("    needle"),
            )],
            settled_at_ms: 7,
            anchor_msg_id: None,
        })
        .unwrap();

    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let (state_tx, _s) = broadcast::channel(64);
    let (meta_tx, _m) = broadcast::channel(8);
    let (code_tx, _c) = broadcast::channel(8);
    let (control_tx, mut rx) = broadcast::channel(128);
    let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        control_tx.clone(),
    ));
    let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&ledger)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    sup.set_refs_ledger(Arc::clone(&refs_ledger));
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let ask = |session: &str| {
        serde_json::to_vec(&serde_json::json!({
            "action": "list_refs",
            "tug_session_id": session,
        }))
        .unwrap()
    };

    sup.handle_control("list_refs", &ask("s1"), 10)
        .await
        .expect_handled();
    let response = drain_until_action(&mut rx, "list_refs_ok");
    assert_eq!(response["tug_session_id"], "s1");
    assert_eq!(response["run"]["run_id"], "run-1");
    assert_eq!(response["run"]["op_kind"], "search");
    assert_eq!(response["run"]["refs"][0]["path"], "src/a.ts");
    assert_eq!(response["run"]["refs"][0]["line"], 12);
    assert_eq!(
        response["run"]["refs"][0]["columns"],
        serde_json::json!([[4, 10]]),
    );

    sup.handle_control("list_refs", &ask("s-never"), 10)
        .await
        .expect_handled();
    let empty = drain_until_action(&mut rx, "list_refs_ok");
    assert!(empty["run"].is_null());
}

/// `list_overview_posts` broadcasts `list_overview_posts_ok { posts: [...] }`
/// oldest-first — the Overview card's mount-time tail, after which it stays
/// live off the OVERVIEW feed. App-scoped: the channel belongs to the app,
/// not to a session, so the request carries no session id.
#[tokio::test]
async fn list_overview_posts_returns_the_channel_tail() {
    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    for body in ["the older post", "the newer post"] {
        ledger
            .record_overview_post(&tugcast_core::OverviewPost {
                id: None,
                at_ms: 1,
                author: tugcast_core::OverviewAuthor::Observer,
                session_id: Some("s1".to_string()),
                wake_reason: Some("turn-end".to_string()),
                body: body.to_string(),
                refs: Vec::new(),
                elapsed_ms: None,
                project_dir: None,
                attachments: Vec::new(),
                request_id: None,
                transient: false,
            })
            .unwrap();
    }

    let (state_tx, _s) = broadcast::channel(64);
    let (meta_tx, _m) = broadcast::channel(8);
    let (code_tx, _c) = broadcast::channel(8);
    let (control_tx, mut rx) = broadcast::channel(128);
    let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        control_tx.clone(),
    ));
    let (sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&ledger)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_overview_posts",
    }))
    .unwrap();
    sup.handle_control("list_overview_posts", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_overview_posts_ok");
    let posts = response["posts"].as_array().expect("posts array");
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0]["body"], "the older post");
    assert_eq!(posts[1]["body"], "the newer post");
    assert_eq!(posts[1]["author"], "observer");
    assert_eq!(posts[1]["wake_reason"], "turn-end");
    assert!(
        posts[1]["id"].is_i64(),
        "a persisted post carries its rowid onto the wire",
    );
}

/// The deck's mount-time tail is answered from the digester's deque, not
/// from disk: `pulse_lines` is dropped, and a beat describes work that is
/// running rather than history worth keeping.
#[tokio::test]
async fn list_digest_lines_answers_a_per_session_tail_from_memory() {
    use crate::feeds::session_digest::{SharedDigester, lock_digester};

    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let digester: SharedDigester = Default::default();
    // Two sessions, one chatty and one quiet — the case a flat app-wide
    // tail loses, and the reason the read is per-scope.
    {
        let mut guard = lock_digester(&digester);
        guard.on_code_frame(
            "quiet",
            &serde_json::json!({
                "type": "assistant_text",
                "tug_session_id": "quiet",
                "msg_id": "q1",
                "block_index": 0,
                "is_partial": false,
                "text": "The one thing the quiet session said.",
            }),
            1_000,
        );
        for i in 0..40 {
            guard.on_code_frame(
                "chatty",
                &serde_json::json!({
                    "type": "assistant_text",
                    "tug_session_id": "chatty",
                    "msg_id": format!("c{i}"),
                    "block_index": 0,
                    "is_partial": false,
                    // A settled sentence: the digester takes the last
                    // terminated one, so a bare fragment is not a line.
                    "text": format!("Chatty line {i}."),
                }),
                2_000 + i,
            );
        }
    }

    let (state_tx, _s) = broadcast::channel(64);
    let (meta_tx, _m) = broadcast::channel(8);
    let (code_tx, _c) = broadcast::channel(8);
    let (control_tx, mut rx) = broadcast::channel(128);
    let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        control_tx.clone(),
    ));
    let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&ledger)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    sup.set_digester(digester);
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let payload =
        serde_json::to_vec(&serde_json::json!({ "action": "list_digest_lines" })).unwrap();
    sup.handle_control("list_digest_lines", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_digest_lines_ok");
    let lines = response["lines"].as_array().expect("lines array");

    // The quiet session's one line is in the answer. A flat tail of the
    // newest N across the process would have buried it under `chatty`.
    assert!(
        lines
            .iter()
            .any(|l| l["text"] == "The one thing the quiet session said."
                && l["scopes"] == serde_json::json!(["quiet"])),
        "the quiet session's line is what a per-scope read exists to keep",
    );
    // The chatty session is capped at the tail length rather than handing
    // over its whole deque.
    let chatty: Vec<&serde_json::Value> = lines
        .iter()
        .filter(|l| l["scopes"] == serde_json::json!(["chatty"]))
        .collect();
    assert_eq!(chatty.len(), crate::feeds::digest_bridge::DIGEST_TAIL_LEN);
    assert_eq!(chatty.last().unwrap()["text"], "Chatty line 39.");

    // Oldest-first across every scope, which is the order the deck appends
    // in — and the beat is the identity the retired rowid was standing for.
    let beats: Vec<i64> = lines.iter().map(|l| l["beat"].as_i64().unwrap()).collect();
    let mut sorted = beats.clone();
    sorted.sort_unstable();
    assert_eq!(beats, sorted);
    assert!(lines.iter().all(|l| l["id"] == l["beat"]));

    // Every row carries its kind. The deck's ladders switch on it, and a
    // card mounting mid-turn reads this door rather than the feed — so a
    // tail that dropped the field would make every restored line read as a
    // turn still running ([D187]).
    assert!(
        lines.iter().all(|l| l["kind"].is_string()),
        "the tail carries `kind` on every row, as the live frame does",
    );
    assert_eq!(
        lines
            .iter()
            .find(|l| l["text"] == "The one thing the quiet session said.")
            .unwrap()["kind"],
        "said",
    );
}

/// No digester wired is the "no history yet" state, never an error — the
/// same conduct every other restore read has.
#[tokio::test]
async fn list_digest_lines_answers_empty_with_no_digester() {
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();

    let payload =
        serde_json::to_vec(&serde_json::json!({ "action": "list_digest_lines" })).unwrap();
    sup.handle_control("list_digest_lines", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_digest_lines_ok");
    assert_eq!(response["lines"].as_array().expect("lines array").len(), 0);
}

/// An unknown session (or one with no exchanges) yields an empty array,
/// never an error — the "no shell history yet" restore state.
#[tokio::test]
async fn list_shell_exchanges_empty_for_unknown_session() {
    let shell_ledger = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().unwrap());
    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let (state_tx, _s) = broadcast::channel(64);
    let (meta_tx, _m) = broadcast::channel(8);
    let (code_tx, _c) = broadcast::channel(8);
    let (control_tx, mut rx) = broadcast::channel(128);
    let recorder: Arc<dyn SessionsRecorder> = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        control_tx.clone(),
    ));
    let (mut sup, mut register_rx) = AgentSupervisor::new_with_ledger(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        Some(Arc::clone(&ledger)),
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        Arc::new(WorkspaceRegistry::new_for_test()),
        CancellationToken::new(),
    );
    sup.set_shell_ledger(shell_ledger);
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_shell_exchanges",
        "tug_session_id": "nope",
    }))
    .unwrap();
    sup.handle_control("list_shell_exchanges", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_shell_exchanges_ok");
    assert_eq!(response["exchanges"].as_array().unwrap().len(), 0);
}

// -------------------------------------------------------------------
// record_turn_telemetry — CONTROL action → SessionLedger round-trip
// -------------------------------------------------------------------

fn record_turn_telemetry_payload(
    tug_session_id: &str,
    msg_id: &str,
    total_cost_usd: f64,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "action": "record_turn_telemetry",
        "tug_session_id": tug_session_id,
        "msg_id": msg_id,
        "telemetry": {
            "cost": {
                "inputTokens": 100,
                "outputTokens": 50,
                "cacheCreationInputTokens": 10,
                "cacheReadInputTokens": 20,
                "totalCostUsd": total_cost_usd,
            },
            "wallClockMs": 4_000,
            "awaitingApprovalMs": 200,
            "transportDowntimeMs": 100,
            "activeMs": 3_700,
            "ttftMs": 150,
            "ttftcMs": 300,
            "reconnectCount": 0,
            "maxStreamGapMs": 90,
        },
        "ended_at": 1_000,
    }))
    .unwrap()
}

#[tokio::test]
async fn record_turn_telemetry_writes_row_to_ledger() {
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-tel-1");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;

    // Bind a claude session id; the ledger writes need this since
    // it's the row PK on the sqlite side. Also seed the sessions
    // row so the cascade trigger has something to anchor.
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-A".to_string());
    }
    ledger
        .record_spawn(
            "claude-A", "ws-1", "/proj/x", "card-1", 1_000, "claude-A", None,
        )
        .unwrap();

    let outcome = sup
        .handle_control(
            "record_turn_telemetry",
            &record_turn_telemetry_payload("sess-tel-1", "msg-A", 0.0123),
            10,
        )
        .await;
    assert!(matches!(outcome, ControlOutcome::Handled));

    let rows = ledger.list_turn_telemetry("claude-A").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].msg_id, "msg-A");
    assert_eq!(rows[0].total_cost_usd, 0.0123);
    assert_eq!(rows[0].input_tokens, 100);
    assert_eq!(rows[0].wall_clock_ms, 4_000);
    assert_eq!(rows[0].active_ms, 3_700);
    assert_eq!(rows[0].ttft_ms, Some(150));
}

#[tokio::test]
async fn record_turn_telemetry_pushes_the_row_with_the_usage_it_just_wrote() {
    // The one ledger write that used to push nothing. The receipt's stage
    // row reads the sum, and the deck records telemetry a round trip after
    // the turn commits — so without this push the stage that just finished
    // would carry a total missing its last turn.
    let (sup, ledger, mut control_rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-tel-push");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-P".to_string());
    }
    ledger
        .record_spawn(
            "claude-P", "ws-1", "/proj/x", "card-1", 1_000, "claude-P", None,
        )
        .unwrap();
    while control_rx.try_recv().is_ok() {}

    sup.handle_control(
        "record_turn_telemetry",
        &record_turn_telemetry_payload("sess-tel-push", "msg-A", 0.0123),
        10,
    )
    .await;

    let body = next_action(&mut control_rx, "session_updated").await;
    assert_eq!(body["session_id"], "claude-P");
    // Post-write, not pre-write: the turn just recorded is in the sum.
    assert_eq!(body["usage"]["turns"], 1);
    assert_eq!(body["usage"]["tokens"], 180);
    assert_eq!(body["usage"]["active_ms"], 3_700);
}

#[tokio::test]
async fn resolve_sessions_ok_carries_each_segments_usage() {
    // The restore path: a receipt mounting on relaunch asks for the ids it
    // parsed, and the numbers come back with the rows rather than needing a
    // second verb ([D132]'s batch, one fact further).
    let (sup, ledger, mut control_rx) = make_supervisor_with_ledger();
    // Full uuids: the resolver answers a uuid, an 8-hex short id or a
    // callsign, and a stage line in an arc receipt carries the first.
    let with_turns = "557d7058-8076-4c1d-9f7e-2b3a4c5d6e7f";
    let without = "0431f0dd-cb36-4a2b-8c1d-9e0f1a2b3c4d";
    ledger
        .record_spawn(
            with_turns, "ws-1", "/proj/x", "card-1", 1_000, with_turns, None,
        )
        .unwrap();
    ledger
        .record_spawn(without, "ws-1", "/proj/x", "card-2", 1_000, without, None)
        .unwrap();
    ledger
        .record_turn_telemetry(&crate::session_ledger::TurnTelemetryRow {
            session_id: with_turns.to_owned(),
            msg_id: "msg-A".to_owned(),
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            total_cost_usd: 0.0,
            wall_clock_ms: 4_000,
            awaiting_approval_ms: 0,
            transport_downtime_ms: 0,
            active_ms: 3_700,
            ttft_ms: None,
            ttftc_ms: None,
            reconnect_count: 0,
            max_stream_gap_ms: 0,
            ended_at: 1_000,
            session_init_tokens: None,
        })
        .unwrap();
    while control_rx.try_recv().is_ok() {}

    sup.do_resolve_sessions(&[with_turns.to_owned(), without.to_owned()])
        .await;

    let body = next_action(&mut control_rx, "resolve_sessions_ok").await;
    let entries = body["sessions"].as_array().expect("sessions array");
    let answer = |id: &str| {
        entries
            .iter()
            .find(|e| e["queried"] == id)
            .expect("an answer for the id")
            .clone()
    };
    assert_eq!(answer(with_turns)["usage"]["turns"], 1);
    assert_eq!(answer(with_turns)["usage"]["tokens"], 180);
    assert_eq!(answer(with_turns)["usage"]["active_ms"], 3_700);
    // A segment that recorded nothing answers with no usage at all, which
    // is what leaves the receipt's right-hand cell standing empty rather
    // than printing a zero.
    assert!(answer(without)["usage"].is_null());
}

#[tokio::test]
async fn record_turn_telemetry_overwrites_existing_row_for_same_pk() {
    // A reconnecting client may re-emit the same `record_turn_telemetry`
    // for an already-persisted (session_id, msg_id). The ledger's
    // `INSERT OR REPLACE` makes the repeat a no-op write — same
    // values overwriting same values, not a duplicate-key error.
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-tel-2");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-B".to_string());
    }
    ledger
        .record_spawn(
            "claude-B", "ws-1", "/proj/x", "card-2", 1_000, "claude-B", None,
        )
        .unwrap();

    sup.handle_control(
        "record_turn_telemetry",
        &record_turn_telemetry_payload("sess-tel-2", "msg-A", 0.0123),
        10,
    )
    .await;
    sup.handle_control(
        "record_turn_telemetry",
        &record_turn_telemetry_payload("sess-tel-2", "msg-A", 9.99),
        10,
    )
    .await;

    let rows = ledger.list_turn_telemetry("claude-B").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].total_cost_usd, 9.99);
}

#[tokio::test]
async fn record_turn_telemetry_silently_skips_when_session_not_found() {
    // The session was already evicted, never spawned through this
    // supervisor, or never had `session_init` complete. The handler
    // logs and drops — no write, no error frame, no panic.
    let (sup, ledger, _rx) = make_supervisor_with_ledger();

    let outcome = sup
        .handle_control(
            "record_turn_telemetry",
            &record_turn_telemetry_payload("sess-unknown", "msg-A", 0.0123),
            10,
        )
        .await;
    assert!(matches!(outcome, ControlOutcome::Handled));

    // No row should exist for any session.
    let rows = ledger.list_turn_telemetry("claude-anything").unwrap();
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn record_turn_telemetry_rejects_malformed_payload() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();

    let outcome = sup
        .handle_control("record_turn_telemetry", b"not json", 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

#[tokio::test]
async fn record_turn_telemetry_rejects_missing_msg_id() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "record_turn_telemetry",
        "tug_session_id": "sess-x",
        "telemetry": { "cost": {} },
        "ended_at": 1_000,
    }))
    .unwrap();

    let outcome = sup
        .handle_control("record_turn_telemetry", &payload, 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

// -------------------------------------------------------------------
// record_context_breakdown — CONTROL action → SessionLedger round-trip
// -------------------------------------------------------------------

fn record_context_breakdown_payload(
    tug_session_id: &str,
    messages_tokens: i64,
    autocompact_enabled: bool,
) -> Vec<u8> {
    let mut categories = vec![
        serde_json::json!({ "id": "system_prompt", "label": "System prompt", "tokens": 3_500 }),
        serde_json::json!({ "id": "messages",      "label": "Messages",      "tokens": messages_tokens }),
    ];
    if autocompact_enabled {
        categories.push(serde_json::json!({
            "id": "autocompact_buffer",
            "label": "Autocompact buffer",
            "tokens": 33_000,
        }));
    }
    serde_json::to_vec(&serde_json::json!({
        "action": "record_context_breakdown",
        "tug_session_id": tug_session_id,
        "payload": {
            "context_max": 200_000,
            "categories": categories,
        },
        "captured_at": 5_000,
    }))
    .unwrap()
}

#[tokio::test]
async fn record_context_breakdown_writes_row_to_ledger() {
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-ctx-1");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-ctx-A".to_string());
    }
    ledger
        .record_spawn(
            "claude-ctx-A",
            "ws-1",
            "/proj/x",
            "card-1",
            1_000,
            "claude-ctx-A",
            None,
        )
        .unwrap();

    let outcome = sup
        .handle_control(
            "record_context_breakdown",
            &record_context_breakdown_payload("sess-ctx-1", 12_000, false),
            10,
        )
        .await;
    assert!(matches!(outcome, ControlOutcome::Handled));

    let row = ledger.get_context_breakdown("claude-ctx-A").unwrap();
    assert!(row.is_some(), "ledger row should be present after persist");
    let row = row.unwrap();
    assert_eq!(row.captured_at, 5_000);
    // The persisted payload is the wire-frame body (context_max +
    // categories). Re-parse and check structure.
    let parsed: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
    assert_eq!(parsed["context_max"], 200_000);
    assert!(parsed["categories"].is_array());
    let cats = parsed["categories"].as_array().unwrap();
    assert_eq!(cats.len(), 2);
    assert_eq!(cats[1]["id"], "messages");
    assert_eq!(cats[1]["tokens"], 12_000);
}

#[tokio::test]
async fn record_context_breakdown_upserts_on_repeat() {
    // Repeat writes for the same session must overwrite, not pile
    // on. The popover always reads the most recent row; an older
    // row hanging around would mean stale data on a fresh bind.
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-ctx-2");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-ctx-B".to_string());
    }
    ledger
        .record_spawn(
            "claude-ctx-B",
            "ws-1",
            "/proj/x",
            "card-2",
            1_000,
            "claude-ctx-B",
            None,
        )
        .unwrap();

    sup.handle_control(
        "record_context_breakdown",
        &record_context_breakdown_payload("sess-ctx-2", 1_000, false),
        10,
    )
    .await;
    sup.handle_control(
        "record_context_breakdown",
        &record_context_breakdown_payload("sess-ctx-2", 99_000, true),
        10,
    )
    .await;

    let row = ledger
        .get_context_breakdown("claude-ctx-B")
        .unwrap()
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
    let cats = parsed["categories"].as_array().unwrap();
    // Second write wins.
    let messages = cats
        .iter()
        .find(|c| c["id"] == "messages")
        .expect("messages category present");
    assert_eq!(messages["tokens"], 99_000);
    assert!(
        cats.iter().any(|c| c["id"] == "autocompact_buffer"),
        "autocompact_buffer present in second write",
    );
}

#[tokio::test]
async fn record_context_breakdown_silently_skips_when_session_not_found() {
    let (sup, ledger, _rx) = make_supervisor_with_ledger();

    let outcome = sup
        .handle_control(
            "record_context_breakdown",
            &record_context_breakdown_payload("sess-unknown", 1_000, false),
            10,
        )
        .await;
    assert!(matches!(outcome, ControlOutcome::Handled));

    // No row was written.
    assert!(
        ledger
            .get_context_breakdown("claude-anything")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn record_context_breakdown_rejects_malformed_payload() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();

    let outcome = sup
        .handle_control("record_context_breakdown", b"not json", 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

#[tokio::test]
async fn record_context_breakdown_rejects_missing_payload_field() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let body = serde_json::to_vec(&serde_json::json!({
        "action": "record_context_breakdown",
        "tug_session_id": "sess-x",
        "captured_at": 1_000,
    }))
    .unwrap();
    let outcome = sup
        .handle_control("record_context_breakdown", &body, 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

#[tokio::test]
async fn record_context_breakdown_rejects_payload_that_is_not_an_object() {
    // The CONTROL frame's `payload` sub-field must be a JSON
    // object — the supervisor stores it verbatim and the bind-
    // attach side expects to be able to splice an outer wrapper
    // by trimming the leading `{`.
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let body = serde_json::to_vec(&serde_json::json!({
        "action": "record_context_breakdown",
        "tug_session_id": "sess-x",
        "payload": "not-an-object",
        "captured_at": 1_000,
    }))
    .unwrap();
    let outcome = sup
        .handle_control("record_context_breakdown", &body, 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

// -------------------------------------------------------------------
// record_session_state_change + list_session_state_changes — CONTROL
// actions → SessionLedger round-trip
// -------------------------------------------------------------------

fn record_state_change_payload(
    tug_session_id: &str,
    at_ms: i64,
    phase: &str,
    transport_state: &str,
    interrupt_in_flight: bool,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "action": "record_session_state_change",
        "tug_session_id": tug_session_id,
        "at_ms": at_ms,
        "phase": phase,
        "transport_state": transport_state,
        "interrupt_in_flight": interrupt_in_flight,
    }))
    .unwrap()
}

fn list_state_changes_payload(tug_session_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "action": "list_session_state_changes",
        "tug_session_id": tug_session_id,
    }))
    .unwrap()
}

#[tokio::test]
async fn record_session_state_change_writes_rows_to_ledger() {
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-ssc-1");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-ssc-A".to_string());
    }
    ledger
        .record_spawn(
            "claude-ssc-A",
            "ws-1",
            "/proj/x",
            "card-1",
            1_000,
            "claude-ssc-A",
            None,
        )
        .unwrap();

    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-ssc-1", 100, "idle", "online", false),
        10,
    )
    .await
    .expect_handled();
    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-ssc-1", 200, "submitting", "online", false),
        10,
    )
    .await
    .expect_handled();
    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-ssc-1", 300, "submitting", "offline", true),
        10,
    )
    .await
    .expect_handled();

    let rows = ledger.list_session_state_changes("claude-ssc-A").unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].phase, "idle");
    assert_eq!(rows[1].phase, "submitting");
    assert_eq!(rows[2].transport_state, "offline");
    assert!(rows[2].interrupt_in_flight);
}

#[tokio::test]
async fn record_session_state_change_dedupes_at_ledger_layer() {
    // Even if the supervisor receives two writes of the same triple
    // (e.g., a racing dispatch beat the client-side compare), the
    // ledger layer dedupes and only one row lands.
    let (sup, ledger, _rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-ssc-2");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-ssc-B".to_string());
    }
    ledger
        .record_spawn(
            "claude-ssc-B",
            "ws-1",
            "/proj/x",
            "card-2",
            1_000,
            "claude-ssc-B",
            None,
        )
        .unwrap();

    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-ssc-2", 100, "idle", "online", false),
        10,
    )
    .await
    .expect_handled();
    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-ssc-2", 200, "idle", "online", false),
        10,
    )
    .await
    .expect_handled();

    let rows = ledger.list_session_state_changes("claude-ssc-B").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].at_ms, 100);
}

#[tokio::test]
async fn record_session_state_change_silently_skips_when_session_not_found() {
    let (sup, ledger, _rx) = make_supervisor_with_ledger();

    sup.handle_control(
        "record_session_state_change",
        &record_state_change_payload("sess-unknown", 100, "idle", "online", false),
        10,
    )
    .await
    .expect_handled();

    assert_eq!(
        ledger
            .list_session_state_changes("claude-anything")
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn record_session_state_change_rejects_malformed_payload() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let outcome = sup
        .handle_control("record_session_state_change", b"not json", 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

#[tokio::test]
async fn record_session_state_change_rejects_missing_axis() {
    // Missing `transport_state` — the parser must reject; the writer
    // can't fall back to a default because the triple is the row's
    // semantic identity.
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let body = serde_json::to_vec(&serde_json::json!({
        "action": "record_session_state_change",
        "tug_session_id": "sess-x",
        "at_ms": 100,
        "phase": "idle",
        "interrupt_in_flight": false,
    }))
    .unwrap();
    let outcome = sup
        .handle_control("record_session_state_change", &body, 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}

#[tokio::test]
async fn list_session_state_changes_returns_rows_oldest_first() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    let tug_id = TugSessionId::new("sess-ssc-list");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-ssc-L".to_string());
    }
    ledger
        .record_spawn(
            "claude-ssc-L",
            "ws-1",
            "/proj/x",
            "card-3",
            1_000,
            "claude-ssc-L",
            None,
        )
        .unwrap();
    ledger
        .record_session_state_change("claude-ssc-L", 100, "idle", "online", false)
        .unwrap();
    ledger
        .record_session_state_change("claude-ssc-L", 200, "submitting", "online", false)
        .unwrap();
    ledger
        .record_session_state_change("claude-ssc-L", 300, "tool_work", "online", false)
        .unwrap();

    while rx.try_recv().is_ok() {}

    sup.handle_control(
        "list_session_state_changes",
        &list_state_changes_payload("sess-ssc-list"),
        10,
    )
    .await
    .expect_handled();

    let response = drain_until_action(&mut rx, "list_session_state_changes_ok");
    assert_eq!(response["tug_session_id"], "sess-ssc-list");
    let rows = response["rows"].as_array().expect("rows array");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["phase"], "idle");
    assert_eq!(rows[0]["at_ms"], 100);
    assert_eq!(rows[1]["phase"], "submitting");
    assert_eq!(rows[2]["phase"], "tool_work");
    assert_eq!(rows[0]["transport_state"], "online");
    assert_eq!(rows[0]["interrupt_in_flight"], false);
}

#[tokio::test]
async fn list_session_state_changes_returns_empty_array_for_unknown_session() {
    // Unknown session id surfaces as an empty array, not an error
    // frame: the client renders the same "no history yet" state for
    // either case.
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();

    sup.handle_control(
        "list_session_state_changes",
        &list_state_changes_payload("sess-never"),
        10,
    )
    .await
    .expect_handled();

    let response = drain_until_action(&mut rx, "list_session_state_changes_ok");
    assert_eq!(response["tug_session_id"], "sess-never");
    let rows = response["rows"].as_array().expect("rows array");
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn list_session_state_changes_falls_back_to_tug_session_id() {
    // Reload race: the popover sends `list_session_state_changes`
    // before the resumed session's `claude_session_id` has landed
    // in the in-memory map. With NO in-memory entry to resolve, the
    // read falls back to `tug_session_id` as the ledger key (equal
    // to the claude id by the post-Phase-B invariant) and recovers
    // the persisted history rather than returning a spurious empty
    // array — the popover's "no state changes recorded" bug.
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn(
            "sess-reload-race",
            "ws-1",
            "/proj/x",
            "card-9",
            1_000,
            "sess-reload-race",
            None,
        )
        .unwrap();
    ledger
        .record_session_state_change("sess-reload-race", 100, "idle", "online", false)
        .unwrap();
    ledger
        .record_session_state_change("sess-reload-race", 200, "submitting", "online", false)
        .unwrap();

    while rx.try_recv().is_ok() {}

    sup.handle_control(
        "list_session_state_changes",
        &list_state_changes_payload("sess-reload-race"),
        10,
    )
    .await
    .expect_handled();

    let response = drain_until_action(&mut rx, "list_session_state_changes_ok");
    assert_eq!(response["tug_session_id"], "sess-reload-race");
    let rows = response["rows"].as_array().expect("rows array");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["phase"], "idle");
    assert_eq!(rows[1]["phase"], "submitting");
}

#[tokio::test]
async fn list_session_state_changes_rejects_malformed_payload() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let outcome = sup
        .handle_control("list_session_state_changes", b"not json", 10)
        .await;
    assert!(matches!(outcome, ControlOutcome::Error(_)));
}
