//! Tests for the spawn path (`spawn.rs`): bind-time replay, the spawn budget,
//! the directory change, and the terminal-liveness gate on a resume.

use super::*;

// ---- handle_control: spawn_session ----

// ---- bind-time persisted-metadata replay (Step 2a.1) ----
//
// claude is silent in stream-json mode until the first user message,
// so a resumed / known session must surface its last-known metadata
// from the persisted sqlite row on bind. These pin
// `persisted_metadata_replay_frame`'s three branches against a real
// in-memory `SessionLedger`: persisted row replays when the in-memory
// slot is empty; brand-new (no row, no slot) replays nothing; the
// in-memory slot wins over the persisted row when both exist.

/// A supervisor wired with a real in-memory `SessionLedger` (the
/// sqlite read/write handle), a stall spawner (eager spawn installs
/// plumbing but never produces claude output), and the metadata
/// broadcast receiver. Mirrors `make_supervisor_with_store` but
/// threads `Some(ledger)` so `persisted_metadata_replay_frame` can
/// read the persisted row.
fn make_supervisor_with_real_ledger() -> (
    AgentSupervisor,
    broadcast::Receiver<Frame>,
    Arc<crate::session_ledger::SessionLedger>,
) {
    let (state_tx, _state_rx) = broadcast::channel(512);
    let (meta_tx, meta_rx) = broadcast::channel(32);
    let (code_tx, _code_rx) = broadcast::channel(32);
    let (control_tx, _control_rx) = broadcast::channel(512);
    let registry = Arc::new(WorkspaceRegistry::new_for_test());
    let cancel = CancellationToken::new();
    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let recorder: Arc<dyn SessionsRecorder> =
        Arc::new(LedgerSessionsRecorder::new(Arc::clone(&ledger)));
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
        registry,
        cancel,
    );
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });
    (sup, meta_rx, ledger)
}

/// A persisted `system_metadata` payload carrying model / version /
/// mode — the shape the bridge merges and writes per turn.
fn persisted_metadata_payload(model: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "type": "system_metadata",
        "model": model,
        "version": "2.1.157",
        "permissionMode": "acceptEdits",
    }))
    .unwrap()
}

#[tokio::test]
async fn test_spawn_session_replays_persisted_metadata_when_slot_empty() {
    let (sup, mut meta_rx, ledger) = make_supervisor_with_real_ledger();

    // Persist a row keyed by the (un-forked) session id, then bind a
    // ledger entry whose in-memory slot is empty — the fresh-process
    // resume case.
    let payload = persisted_metadata_payload("claude-opus-4-8[1m]");
    ledger
        .record_session_metadata("sess-1", &payload, 1_000)
        .unwrap();
    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    assert!(
        entry.lock().await.latest_metadata.is_none(),
        "precondition: in-memory slot is empty",
    );

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx.try_recv().expect("persisted replay frame present");
    assert_eq!(received.feed_id, FeedId::SESSION_SIDEBAND);
    // The replay is the persisted row stamped with the bound session's
    // tug id — the persisted payload itself is untagged (the bridge
    // merges the raw line, pre-splice), and the client drops untagged
    // sideband frames per the [D06]/[D11] session filter.
    let received_json: serde_json::Value = serde_json::from_slice(&received.payload).unwrap();
    assert_eq!(
        received_json.get("tug_session_id").and_then(|v| v.as_str()),
        Some("sess-1"),
        "replay frame is stamped with the bound tug session id",
    );
    let mut expected: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    expected["tug_session_id"] = serde_json::Value::String("sess-1".into());
    assert_eq!(
        received_json, expected,
        "replay frame is the persisted row payload plus the stamp",
    );
    assert!(
        meta_rx.try_recv().is_err(),
        "only a single replay frame is emitted",
    );
}

#[test]
fn stamp_tug_session_id_adds_field_to_untagged_payload() {
    let payload = br#"{"type":"system_metadata","model":"claude-opus-4-8"}"#.to_vec();
    let out = stamp_tug_session_id(payload, "sess-9");
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["tug_session_id"], "sess-9");
    assert_eq!(v["model"], "claude-opus-4-8");
}

#[test]
fn stamp_tug_session_id_overwrites_stale_tag() {
    let payload = br#"{"tug_session_id":"old-sess","type":"system_metadata"}"#.to_vec();
    let out = stamp_tug_session_id(payload, "new-sess");
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["tug_session_id"], "new-sess");
}

#[test]
fn stamp_tug_session_id_splices_unparseable_blob() {
    // Truncated JSON: serde refuses, the splice fallback still lands the
    // tag after the first brace (matching the live relay's behavior).
    let payload = br#"{"type":"system_metadata","model":"clau"#.to_vec();
    let out = stamp_tug_session_id(payload, "sess-9");
    let s = String::from_utf8(out).unwrap();
    assert!(s.starts_with(r#"{"tug_session_id":"sess-9","#));
}

#[tokio::test]
async fn test_spawn_session_no_persisted_row_fires_no_replay() {
    let (sup, mut meta_rx, _ledger) = make_supervisor_with_real_ledger();

    // Ledger handle present but no persisted row and no in-memory slot
    // (a genuinely brand-new session) → no replay.
    insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    assert!(
        meta_rx.try_recv().is_err(),
        "no replay for a session with no persisted row and no in-memory slot",
    );
}

#[tokio::test]
async fn test_spawn_session_clears_errored_state_on_retry() {
    // Regression for the 2026-07-22 commit-xp incident: after a
    // (mis)classified resume_failed left the entry `Errored`, the picker's
    // Retry re-spawned but the entry stayed terminal, so the dispatcher
    // dropped every frame and replay was skipped — the card came back
    // empty even though the JSONL was intact. A spawn request for an
    // `Errored` entry must clear it back so the eager spawn proceeds,
    // WITHOUT wiping the resume identity.
    let (sup, _meta_rx, _ledger) = make_supervisor_with_real_ledger();

    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    {
        let mut e = entry.lock().await;
        e.spawn_state = SpawnState::Errored;
        e.claude_session_id = Some("sess-1".to_string());
        e.session_mode = SessionMode::Resume;
    }

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let e = entry.lock().await;
    assert_ne!(
        e.spawn_state,
        SpawnState::Errored,
        "Retry must clear the errored state so the respawn can proceed",
    );
    assert_eq!(
        e.claude_session_id.as_deref(),
        Some("sess-1"),
        "the resume identity is preserved — recovery resumes the intact JSONL",
    );
    assert_eq!(
        e.session_mode,
        SessionMode::Resume,
        "the session mode is preserved (unlike a New-session discard)",
    );
}

#[tokio::test]
async fn test_spawn_session_replays_persisted_capabilities_when_slot_empty() {
    let (sup, mut meta_rx, ledger) = make_supervisor_with_real_ledger();

    // Persist ONLY a capabilities row (no metadata row, no in-memory
    // slots) — the app-restart resume case: the old process's
    // `latest_capabilities` died with it, and the health-gated resume
    // handshake hasn't answered yet. The persisted payload carries the
    // ORIGINAL spawn's tag; the replay must re-stamp with the bound id.
    let payload = serde_json::to_vec(&serde_json::json!({
        "type": "session_capabilities",
        "tug_session_id": "sess-original",
        "version": "2.1.207",
        "models": [{ "value": "default", "displayName": "Default" }],
        "commands": ["tugplug:implement", "commit"],
    }))
    .unwrap();
    ledger
        .record_session_capabilities("sess-1", &payload, 1_000)
        .unwrap();
    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    assert!(
        entry.lock().await.latest_capabilities.is_none(),
        "precondition: in-memory capabilities slot is empty",
    );

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx
        .try_recv()
        .expect("persisted capabilities replay present");
    assert_eq!(received.feed_id, FeedId::SESSION_SIDEBAND);
    let received_json: serde_json::Value = serde_json::from_slice(&received.payload).unwrap();
    assert_eq!(
        received_json.get("type").and_then(|v| v.as_str()),
        Some("session_capabilities"),
    );
    assert_eq!(
        received_json.get("tug_session_id").and_then(|v| v.as_str()),
        Some("sess-1"),
        "replay is stamped with the BOUND tug id, overwriting the original spawn's tag",
    );
    assert_eq!(
        received_json
            .get("commands")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        Some(2),
        "the persisted command catalog rides the replay intact",
    );
    assert!(
        meta_rx.try_recv().is_err(),
        "only the capabilities frame is replayed (no metadata row exists)",
    );
}

#[tokio::test]
async fn test_spawn_session_in_memory_capabilities_wins_over_persisted() {
    let (sup, mut meta_rx, ledger) = make_supervisor_with_real_ledger();

    // Both a persisted capabilities row AND an in-memory slot exist;
    // the freshest (in-memory, captured this process) wins.
    let persisted = serde_json::to_vec(&serde_json::json!({
        "type": "session_capabilities",
        "version": "2.1.204",
        "commands": ["stale"],
    }))
    .unwrap();
    ledger
        .record_session_capabilities("sess-1", &persisted, 1_000)
        .unwrap();
    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    let in_memory = Frame::new(
        FeedId::SESSION_SIDEBAND,
        serde_json::to_vec(&serde_json::json!({
            "type": "session_capabilities",
            "tug_session_id": "sess-1",
            "version": "2.1.207",
            "commands": ["tugplug:implement", "fresh"],
        }))
        .unwrap(),
    );
    entry.lock().await.latest_capabilities = Some(in_memory.clone());

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx.try_recv().expect("capabilities replay present");
    assert_eq!(
        received.payload, in_memory.payload,
        "the in-memory slot is replayed verbatim; the persisted row is not consulted",
    );
    assert!(meta_rx.try_recv().is_err(), "single replay frame only");
}

#[tokio::test]
async fn test_spawn_session_in_memory_slot_wins_over_persisted() {
    let (sup, mut meta_rx, ledger) = make_supervisor_with_real_ledger();

    // Both a persisted row AND an in-memory slot exist; the freshest
    // (in-memory) wins, and the persisted row is not consulted.
    let persisted = persisted_metadata_payload("claude-opus-4-6");
    ledger
        .record_session_metadata("sess-1", &persisted, 1_000)
        .unwrap();
    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    let in_memory = fake_metadata_frame("sess-1");
    entry.lock().await.latest_metadata = Some(in_memory.clone());

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx.try_recv().expect("replay frame present");
    assert_eq!(
        received, in_memory,
        "in-memory slot wins over the persisted row",
    );
    assert_ne!(
        received.payload, persisted,
        "persisted row is not consulted when the slot is populated",
    );
    assert!(meta_rx.try_recv().is_err(), "single replay frame");
}

/// A `session_capabilities` payload — the turn-free `initialize` model
/// list / command catalog, tagged so the merger and the client route
/// it apart from `system_metadata`.
fn fake_capabilities_frame() -> Frame {
    let body = serde_json::json!({
        "type": "session_capabilities",
        "models": [{ "value": "default", "displayName": "Default (recommended)" }],
        "commands": [],
    });
    Frame::new(FeedId::SESSION_SIDEBAND, serde_json::to_vec(&body).unwrap())
}

#[tokio::test]
async fn test_spawn_session_replays_capabilities_on_bind() {
    // Capabilities are broadcast once per spawn; a reconnect / HMR
    // remount that binds afterward must still get them replayed so the
    // /model picker keeps its data. They replay independently of the
    // metadata slot (here: capabilities present, no metadata) and
    // carry the SESSION_SIDEBAND feed id.
    let (sup, mut meta_rx, _ledger) = make_supervisor_with_real_ledger();

    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    let caps = fake_capabilities_frame();
    entry.lock().await.latest_capabilities = Some(caps.clone());

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx
        .try_recv()
        .expect("capabilities replay frame present");
    assert_eq!(received, caps, "the capabilities slot replays on bind");
    assert_eq!(received.feed_id, FeedId::SESSION_SIDEBAND);
    assert!(meta_rx.try_recv().is_err(), "only the capabilities frame");
}

#[tokio::test]
async fn test_spawn_session_replays_metadata_and_capabilities_together() {
    // When both slots are populated (a reconnect to a session that has
    // run a turn AND handshaken), bind replays BOTH — one
    // system_metadata frame and one session_capabilities frame.
    let (sup, mut meta_rx, _ledger) = make_supervisor_with_real_ledger();

    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    let metadata = fake_metadata_frame("sess-1");
    let caps = fake_capabilities_frame();
    {
        let mut e = entry.lock().await;
        e.latest_metadata = Some(metadata.clone());
        e.latest_capabilities = Some(caps.clone());
    }

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    // Metadata replays first (it is the on-bind chip source), then
    // capabilities. Both ride SESSION_SIDEBAND; the client routes them
    // by payload `type`.
    let first = meta_rx.try_recv().expect("metadata replay frame");
    assert_eq!(first, metadata, "metadata replays first");
    let second = meta_rx.try_recv().expect("capabilities replay frame");
    assert_eq!(second, caps, "capabilities replays second");
    assert!(meta_rx.try_recv().is_err(), "exactly two replay frames");
}

/// A `rate_limit_event` payload — the per-turn subscription-quota
/// broadcast, tagged so the merger and the client route it apart from
/// `system_metadata` / `session_capabilities`.
fn fake_rate_limit_frame() -> Frame {
    let body = serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "warning",
            "resetsAt": 1_700_000_000,
            "rateLimitType": "five_hour",
            "overageStatus": "accepted",
            "isUsingOverage": false,
        },
        "ipc_version": 2,
    });
    Frame::new(FeedId::SESSION_SIDEBAND, serde_json::to_vec(&body).unwrap())
}

#[tokio::test]
async fn test_spawn_session_replays_rate_limit_on_bind() {
    // The per-turn quota broadcast is in-memory only, like capabilities;
    // a reconnect / HMR remount that binds after the last broadcast flew
    // must still get it replayed so the Z4B rate-limit chip keeps its
    // state — which matters most when the session is hard rate-limited
    // and cannot start a turn to refresh it. It replays independently of
    // the metadata / capabilities slots and carries the SESSION_SIDEBAND
    // feed id.
    let (sup, mut meta_rx, _ledger) = make_supervisor_with_real_ledger();

    let entry = insert_ledger_entry(&sup, &TugSessionId::new("sess-1")).await;
    let rate_limit = fake_rate_limit_frame();
    entry.lock().await.latest_rate_limit = Some(rate_limit.clone());

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let received = meta_rx.try_recv().expect("rate-limit replay frame present");
    assert_eq!(received, rate_limit, "the rate-limit slot replays on bind");
    assert_eq!(received.feed_id, FeedId::SESSION_SIDEBAND);
    assert!(meta_rx.try_recv().is_err(), "only the rate-limit frame");
}

// ---- P13: spawn budget (concurrent cap + rate limit) ----

/// Shared helper: insert a synthetic ledger entry and set its
/// `spawn_state` to the given value under the per-entry mutex. Used
/// by the P13 tests to preload the ledger without driving the
/// dispatcher + bridge stack end-to-end.
async fn preload_entry_in_state(
    sup: &AgentSupervisor,
    tug_session_id: &TugSessionId,
    state: SpawnState,
) {
    let entry_arc = insert_ledger_entry(sup, tug_session_id).await;
    let mut entry = entry_arc.lock().await;
    entry.spawn_state = state;
}

#[tokio::test]
async fn test_spawn_session_cap_excludes_idle_and_errored_entries() {
    // Cap = 2. Preload one `Idle` + one `Errored` entry. Neither
    // counts against the budget, so a third fresh spawn succeeds.
    let config = AgentSupervisorConfig {
        max_concurrent_sessions: 2,
        max_spawns_per_minute: 100,
        ..Default::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    preload_entry_in_state(&sup, &TugSessionId::new("sess-idle"), SpawnState::Idle).await;
    preload_entry_in_state(&sup, &TugSessionId::new("sess-err"), SpawnState::Errored).await;

    // Fresh spawn of a third tug_session_id succeeds because active
    // (Spawning+Live) count is 0.
    sup.handle_control("spawn_session", &spawn_payload("card-new", "sess-new"), 10)
        .await
        .expect_handled_with("Idle+Errored do not consume cap slots");
}

#[tokio::test]
async fn test_spawn_session_reconnect_bypasses_cap() {
    // Cap = 1. Preload a single `Live` entry at the cap. A
    // *reconnect* `spawn_session` for the SAME tug_session_id must
    // succeed — the existing entry is reused and no new subprocess
    // is implied.
    let config = AgentSupervisorConfig {
        max_concurrent_sessions: 1,
        max_spawns_per_minute: 100,
        ..Default::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    preload_entry_in_state(&sup, &TugSessionId::new("sess-1"), SpawnState::Live).await;

    // Reconnect: same tug_session_id as the preloaded entry.
    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled_with("reconnect must bypass the concurrent cap");

    // A *fresh* spawn for a different tsid with cap=1 still trips.
    let err = sup
        .handle_control("spawn_session", &spawn_payload("card-2", "sess-2"), 10)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "concurrent_session_cap_exceeded"
        }
    );
}

#[tokio::test]
async fn test_spawn_session_rate_limit_rejects_after_budget_exhausted() {
    // Cap very high, rate = 2. The third fresh spawn within 60s
    // trips the leaky bucket even though the concurrent cap has
    // plenty of room.
    let config = AgentSupervisorConfig {
        max_concurrent_sessions: 100,
        max_spawns_per_minute: 2,
        ..Default::default()
    };
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled_with("first spawn admitted");
    sup.handle_control("spawn_session", &spawn_payload("card-2", "sess-2"), 10)
        .await
        .expect_handled_with("second spawn admitted");

    let err = sup
        .handle_control("spawn_session", &spawn_payload("card-3", "sess-3"), 10)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "spawn_rate_limited"
        }
    );

    // Eager spawn produces `pending` then `spawning` per successful
    // spawn; the third spawn (rejected by rate limit) emits exactly
    // one `errored` frame. Drain everything until we find the
    // rate-limited errored frame (anchored by tsid + detail).
    let mut errored: Option<serde_json::Value> = None;
    while let Ok(f) = state_rx.try_recv() {
        let v: serde_json::Value = serde_json::from_slice(&f.payload).unwrap();
        if v["state"].as_str() == Some("errored") && v["tug_session_id"].as_str() == Some("sess-3")
        {
            errored = Some(v);
            break;
        }
    }
    let v = errored.expect("rate-limited errored frame published");
    assert_eq!(v["detail"].as_str(), Some("spawn_rate_limited"));
}

#[tokio::test]
async fn test_spawn_session_rate_limit_window_ejects_old_timestamps() {
    // cap_check_reason trims timestamps older than 60s from the
    // front of the deque on every call. Seed the deque with two
    // ancient timestamps (simulating spawns from 2 minutes ago),
    // then verify fresh spawns succeed because the trim empties the
    // window before the length check.
    let config = AgentSupervisorConfig {
        max_concurrent_sessions: 100,
        max_spawns_per_minute: 2,
        ..Default::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    {
        let ancient = Instant::now()
            .checked_sub(Duration::from_secs(120))
            .expect("test runs with monotonic clock well past 120s");
        let mut ts = sup.spawn_timestamps.lock();
        ts.push_back(ancient);
        ts.push_back(ancient);
    }

    // Two fresh spawns succeed. The trim at the top of cap_check_reason
    // pops the ancient timestamps before the length check, so the
    // rate budget is effectively empty.
    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled_with("first spawn admitted after trim");
    sup.handle_control("spawn_session", &spawn_payload("card-2", "sess-2"), 10)
        .await
        .expect_handled_with("second spawn admitted after trim");

    // After the two admits, the deque holds exactly two fresh
    // timestamps (the ancient ones were trimmed).
    let ts = sup.spawn_timestamps.lock();
    assert_eq!(ts.len(), 2);
}

#[tokio::test]
async fn test_spawn_session_reconnect_does_not_consume_rate_budget() {
    // Reconnects (existing ledger entry) must not push a timestamp
    // onto the leaky-bucket deque. Set rate=1, preload one entry,
    // reconnect to it → must succeed; then a single fresh spawn of
    // a different tsid must also succeed (budget still has 1 slot).
    let config = AgentSupervisorConfig {
        max_concurrent_sessions: 100,
        max_spawns_per_minute: 1,
        ..Default::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    preload_entry_in_state(&sup, &TugSessionId::new("sess-pre"), SpawnState::Idle).await;

    // Reconnect — must NOT push a timestamp.
    sup.handle_control("spawn_session", &spawn_payload("card-pre", "sess-pre"), 10)
        .await
        .expect_handled_with("reconnect admitted");
    assert_eq!(
        sup.spawn_timestamps.lock().len(),
        0,
        "reconnect must not consume rate budget"
    );

    // Fresh spawn — consumes the one and only budget slot.
    sup.handle_control("spawn_session", &spawn_payload("card-new", "sess-new"), 10)
        .await
        .expect_handled_with("fresh spawn admitted (first of the window)");
    assert_eq!(
        sup.spawn_timestamps.lock().len(),
        1,
        "fresh spawn consumes exactly one budget slot"
    );

    // A second fresh spawn now trips the rate limit.
    let err = sup
        .handle_control("spawn_session", &spawn_payload("card-3", "sess-3"), 10)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "spawn_rate_limited"
        }
    );
}

// ---- directory change ([P01], [P03], [P07]) ----

/// A `mode=new` spawn that moves a card: the new session in `project_dir`,
/// on a fresh line, naming the tug session it moves away from.
fn relocate_payload(
    card_id: &str,
    tug_session_id: &str,
    project_dir: &str,
    relocate_from: &str,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "action": "spawn_session",
        "card_id": card_id,
        "tug_session_id": tug_session_id,
        "project_dir": project_dir,
        "line_id": format!("line-{tug_session_id}"),
        "relocate_from": relocate_from,
    }))
    .unwrap()
}

/// Write `<id>.jsonl` where claude would: under the claude-form folder of
/// `project_dir` in the ledger's claude root.
fn seed_transcript(ledger: &SessionLedger, project_dir: &str, id: &str) {
    let (dir, _) = crate::session_ledger::claude_project_dir(ledger.claude_home(), project_dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
}

fn ledger_in(tmp: &tempfile::TempDir) -> Arc<SessionLedger> {
    Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    )
}

fn two_project_dirs(tmp: &tempfile::TempDir) -> (String, String) {
    let a = tmp.path().join("dir-a");
    let b = tmp.path().join("dir-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    (a.display().to_string(), b.display().to_string())
}

async fn relocate_from_of(sup: &AgentSupervisor, id: &str) -> Option<RelocateOrigin> {
    let live = sup.ledger.lock().await;
    let entry = live
        .get(&TugSessionId::new(id))
        .expect("entry")
        .lock()
        .await;
    entry.relocate_from.clone()
}

#[test]
fn parse_control_payload_owned_reads_relocate_from() {
    let parsed =
        parse_control_payload_owned(&relocate_payload("card-1", "m", "/proj/b", "p")).unwrap();
    assert_eq!(parsed.relocate_from.as_deref(), Some("p"));

    let empty =
        parse_control_payload_owned(&relocate_payload("card-1", "m", "/proj/b", "")).unwrap();
    assert_eq!(
        empty.relocate_from, None,
        "an empty relocate_from is absent"
    );

    let plain = parse_control_payload_owned(&spawn_payload("card-1", "m")).unwrap();
    assert_eq!(plain.relocate_from, None);
}

/// `relocate_from` names the live session the card moves away from; the
/// entry is the authority for its claude id and directory, and a parent
/// with no transcript on disk carries nothing, so the move spawns plain.
#[tokio::test]
async fn spawn_session_relocate_from_resolves_the_live_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger_in(&tmp), None);
    let (a, b) = two_project_dirs(&tmp);

    for parent in ["p-full", "p-empty"] {
        sup.handle_control("spawn_session", &spawn_payload_in("card-1", parent, &a), 10)
            .await
            .expect_handled();
        let live = sup.ledger.lock().await;
        live.get(&TugSessionId::new(parent))
            .expect("parent entry")
            .lock()
            .await
            .claude_session_id = Some(format!("{parent}-claude"));
    }
    seed_transcript(&ledger, &a, "p-full-claude");

    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m-full", &b, "p-full"),
        10,
    )
    .await
    .expect_handled();
    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m-empty", &b, "p-empty"),
        10,
    )
    .await
    .expect_handled();

    assert_eq!(
        relocate_from_of(&sup, "m-full").await,
        Some(RelocateOrigin {
            parent_session_id: "p-full-claude".to_string(),
            parent_project_dir: a.clone(),
        }),
        "the origin is the parent's claude id and its directory"
    );
    assert_eq!(
        relocate_from_of(&sup, "m-empty").await,
        None,
        "a parent with no transcript has no context to carry"
    );
}

/// Two moves before a turn: the first move's fork is unwritten, so the
/// session it made has no transcript of its own, and its whole context is
/// still the original parent's. The second move forks from that parent
/// rather than spawning empty.
#[tokio::test]
async fn a_second_move_before_a_turn_forks_from_the_first_moves_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger_in(&tmp), None);
    let (a, b) = two_project_dirs(&tmp);
    let c = tmp.path().join("dir-c");
    std::fs::create_dir_all(&c).unwrap();
    let c = c.display().to_string();

    sup.handle_control("spawn_session", &spawn_payload_in("card-1", "p", &a), 10)
        .await
        .expect_handled();
    seed_transcript(&ledger, &a, "p");
    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m1", &b, "p"),
        10,
    )
    .await
    .expect_handled();
    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m2", &c, "m1"),
        10,
    )
    .await
    .expect_handled();

    assert_eq!(
        relocate_from_of(&sup, "m2").await,
        Some(RelocateOrigin {
            parent_session_id: "p".to_string(),
            parent_project_dir: a.clone(),
        }),
        "the second move carries the conversation the first one carried"
    );
}

/// A move carries the card's prompt history before tugcode has started:
/// the history page the composer reads under the new id — the moment the
/// ack re-binds it, before any fork edge exists — already holds the
/// prompts typed before the move. The parent here never held a
/// conversation, so nothing is forked, and the history still follows;
/// and a second move before any turn reaches back through the first.
#[tokio::test]
async fn a_move_records_the_prompt_lineage_before_it_is_acknowledged() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts = Arc::new(crate::prompt_ledger::PromptLedger::open_in_memory().unwrap());
    let (sup, ledger, _rx) = make_supervisor_for_ledger_with_prompts(
        ledger_in(&tmp),
        None,
        Some(Arc::clone(&prompts)),
        None,
    );
    let (a, b) = two_project_dirs(&tmp);
    let c = tmp.path().join("dir-c");
    std::fs::create_dir_all(&c).unwrap();
    let c = c.display().to_string();
    let typed = |session: &str, text: &str, at: i64| {
        prompts
            .append(&crate::prompt_ledger::NewPromptEntry {
                session_id: session.to_owned(),
                route: ">".to_owned(),
                text: text.to_owned(),
                atoms_json: "[]".to_owned(),
                project_path: String::new(),
                submitted_at_ms: at,
                client_entry_id: format!("{session}-{at}"),
            })
            .unwrap();
    };
    // What the history route answers: the page under `session`, read
    // through its lineage.
    let page = |session: &str| -> Vec<String> {
        let lineage = crate::prompt_lineage::LineageSource::new(Some(Arc::clone(&ledger)));
        let chain = crate::prompt_lineage::chain_for(&lineage, &prompts, session);
        let (rows, _) = prompts.list_page(&chain, None, 50).unwrap();
        rows.into_iter().map(|row| row.text).collect()
    };

    sup.handle_control("spawn_session", &spawn_payload_in("card-1", "p", &a), 10)
        .await
        .expect_handled();
    typed("p", "first", 1);
    typed("p", "/cd dir-b", 2);

    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m1", &b, "p"),
        10,
    )
    .await
    .expect_handled();
    assert_eq!(
        page("m1"),
        vec!["first", "/cd dir-b"],
        "the moved card's first read already holds the prompts typed before the move"
    );

    typed("m1", "/cd dir-c", 3);
    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "m2", &c, "m1"),
        10,
    )
    .await
    .expect_handled();
    assert_eq!(
        page("m2"),
        vec!["first", "/cd dir-b", "/cd dir-c"],
        "a second move before any turn reaches back through the first"
    );
}

/// The ledger's `relocate` edge answers a pending relocation only while
/// it crosses directories and the fork has not been written.
#[tokio::test]
async fn pending_relocation_from_ledger_needs_a_cross_directory_edge_and_no_fork() {
    let tmp = tempfile::tempdir().unwrap();
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger_in(&tmp), None);
    let (a, b) = two_project_dirs(&tmp);

    ledger
        .record_spawn("parent", "ws-a", &a, "card-1", 1_000, "line-a", None)
        .unwrap();
    ledger
        .record_spawn("moved", "ws-b", &b, "card-1", 2_000, "line-b", None)
        .unwrap();
    ledger.set_fork_provenance("moved", "parent", None).unwrap();
    ledger
        .record_spawn("sibling", "ws-a", &a, "card-2", 3_000, "line-c", None)
        .unwrap();
    ledger
        .set_fork_provenance("sibling", "parent", None)
        .unwrap();

    assert_eq!(
        sup.pending_relocation_from_ledger(&TugSessionId::new("moved"), &b),
        Some(RelocateOrigin {
            parent_session_id: "parent".to_string(),
            parent_project_dir: a.clone(),
        }),
        "a fork in another directory with no transcript of its own is pending"
    );
    assert_eq!(
        sup.pending_relocation_from_ledger(&TugSessionId::new("sibling"), &a),
        None,
        "a fork in the same directory is no move"
    );
    assert_eq!(
        sup.pending_relocation_from_ledger(&TugSessionId::new("parent"), &a),
        None,
        "a root session has no edge"
    );

    seed_transcript(&ledger, &b, "moved");
    assert_eq!(
        sup.pending_relocation_from_ledger(&TugSessionId::new("moved"), &b),
        None,
        "once claude writes the fork the session is an ordinary one"
    );
}

/// A relaunch before the moved session's first turn: the entry comes back
/// `Idle` from the ledger holding a claude id, the deck asks to resume it,
/// and the row's turn count — stamped from the pending replay of the
/// parent — makes it read non-empty. The spawn must still re-fork (`New`
/// with the origin), not `--resume` an id that has no transcript.
#[tokio::test]
async fn relaunch_of_a_pending_relocation_spawns_new_with_its_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger_in(&tmp), None);
    let (a, b) = two_project_dirs(&tmp);

    ledger
        .record_spawn("parent", "ws-a", &a, "card-p", 1_000, "line-a", None)
        .unwrap();
    seed_transcript(&ledger, &a, "parent");
    ledger
        .record_spawn("moved", "ws-b", &b, "card-m", 2_000, "line-b", None)
        .unwrap();
    ledger.set_fork_provenance("moved", "parent", None).unwrap();
    ledger.set_turn_count("moved", 2, 3_000).unwrap();

    // What a relaunch leaves: an `Idle` `Resume` entry with its claude id.
    let sid = TugSessionId::new("moved");
    let mut entry = LedgerEntry::new(
        sid.clone(),
        WorkspaceKey::from_canonical(&b),
        PathBuf::from(&b),
        SessionMode::Resume,
        CrashBudget::new(3, Duration::from_secs(60)),
    );
    entry.card_id = Some("card-m".to_string());
    entry.claude_session_id = Some("moved".to_string());
    sup.ledger
        .lock()
        .await
        .insert(sid.clone(), Arc::new(Mutex::new(entry)));

    sup.handle_control(
        "spawn_session",
        &resume_payload_in("card-m", "moved", &b),
        10,
    )
    .await
    .expect_handled();

    let (mode, origin) = {
        let live = sup.ledger.lock().await;
        let entry = live.get(&sid).expect("entry").lock().await;
        (entry.session_mode, entry.relocate_from.clone())
    };
    assert_eq!(
        mode,
        SessionMode::New,
        "a pending relocation re-forks rather than resuming"
    );
    assert_eq!(
        origin,
        Some(RelocateOrigin {
            parent_session_id: "parent".to_string(),
            parent_project_dir: a.clone(),
        })
    );
}

/// The swap ([P01], [B05]): the move closes the session it left — the
/// deck sends no `close_session`, whose card-wide sweep would take the new
/// session too — so the moved session holds the target's workspace and
/// the source's is released with its last card.
#[tokio::test]
async fn relocation_moves_the_workspace_refcount() {
    use std::sync::atomic::Ordering;
    let tmp = tempfile::tempdir().unwrap();
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger_in(&tmp), None);
    let (a, b) = two_project_dirs(&tmp);

    sup.handle_control("spawn_session", &spawn_payload_in("card-1", "old", &a), 10)
        .await
        .expect_handled();
    seed_transcript(&ledger, &a, "old");
    sup.handle_control(
        "spawn_session",
        &relocate_payload("card-1", "new", &b, "old"),
        10,
    )
    .await
    .expect_handled();
    assert!(relocate_from_of(&sup, "new").await.is_some());

    assert!(
        !sup.ledger
            .lock()
            .await
            .contains_key(&TugSessionId::new("old")),
        "the session the card moved away from is closed"
    );
    let new_key = {
        let live = sup.ledger.lock().await;
        let entry = live
            .get(&TugSessionId::new("new"))
            .expect("entry")
            .lock()
            .await;
        assert_eq!(entry.project_dir, PathBuf::from(&b));
        entry.workspace_key.clone()
    };
    let map = sup.registry.inner_for_test();
    assert_eq!(
        map.len(),
        1,
        "the source workspace is released with its last card"
    );
    let ws = map
        .get(&new_key)
        .expect("the target workspace is the one left");
    assert_eq!(ws.ref_count.load(Ordering::Relaxed), 1);
}

/// A `resume` spawn for a session that holds nothing is spawned fresh
/// under the same id — the card opens instead of failing into the
/// picker's "couldn't resume the previous session" alert. A session with
/// content still resumes.
#[tokio::test]
async fn spawn_session_resume_of_an_empty_session_spawns_fresh() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger, None);

    ledger
        .record_spawn(
            "empty",
            "ws-1",
            test_project_dir(),
            "card-1",
            1_000,
            "empty",
            None,
        )
        .unwrap();
    ledger
        .record_spawn(
            "full",
            "ws-1",
            test_project_dir(),
            "card-2",
            2_000,
            "full",
            None,
        )
        .unwrap();
    ledger.record_user_prompt("full", "hello").unwrap();

    sup.handle_control("spawn_session", &resume_payload("card-1", "empty"), 10)
        .await
        .expect_handled();
    sup.handle_control("spawn_session", &resume_payload("card-2", "full"), 10)
        .await
        .expect_handled();

    let modes = {
        let live = sup.ledger.lock().await;
        let mut modes = Vec::new();
        for id in ["empty", "full"] {
            let entry = live
                .get(&TugSessionId::new(id))
                .expect("entry")
                .lock()
                .await;
            modes.push(entry.session_mode);
        }
        modes
    };
    assert_eq!(
        modes[0],
        SessionMode::New,
        "a session with no content and no transcript is spawned fresh"
    );
    assert_eq!(
        modes[1],
        SessionMode::Resume,
        "a session with recorded content is still resumed"
    );
}

/// The `Idle`-entry spawn-mode reconciliation ([`reconcile_idle_session_mode`]):
/// the client request normally wins, but a `New` request never downgrades an
/// entry that still holds a persisted `claude_session_id` (that spawn would
/// `--session-id`-collide with the existing transcript).
#[test]
fn reconcile_idle_session_mode_holds_resume_against_a_new_collision() {
    use SessionMode::{New, Resume};
    // The bug shape: rebound as Resume, client (mis)requests New while a
    // claude session id is persisted → hold Resume.
    assert_eq!(reconcile_idle_session_mode(Resume, New, true), Resume);
    // No persisted id (a genuine fresh/discarded session) → honor New.
    assert_eq!(reconcile_idle_session_mode(Resume, New, false), New);
    // A resume request is always honored, id present or not.
    assert_eq!(reconcile_idle_session_mode(New, Resume, true), Resume);
    assert_eq!(reconcile_idle_session_mode(New, Resume, false), Resume);
}

#[tokio::test]
async fn resume_of_terminal_live_session_is_rejected_on_fresh_insert() {
    // The primary gate case: no prior in-memory entry for the
    // session (first-ever resume of an external session), so the
    // gate must fire on the fresh-insert path, not just reconnects.
    let tmp = tempfile::tempdir().unwrap();
    let registry_root = tmp.path().join("registry");
    write_registry_entry(&registry_root, "ext-held", std::process::id(), "1");
    let config = AgentSupervisorConfig {
        terminal_registry_root: Some(registry_root),
        ..AgentSupervisorConfig::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    let err = sup
        .handle_control("spawn_session", &resume_payload("card-1", "ext-held"), 10)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "session_live_in_terminal"
        }
    );
    // Bookkeeping fully undone: no in-memory entry, no affinity row.
    assert!(
        !sup.ledger
            .lock()
            .await
            .contains_key(&TugSessionId("ext-held".to_string())),
        "rejected fresh insert must not leave a ledger entry behind"
    );
    let cs = sup.client_sessions.lock().await;
    assert!(
        cs.values()
            .all(|set| !set.contains(&TugSessionId("ext-held".to_string()))),
        "rejected resume must not leave an affinity row behind"
    );
}

#[tokio::test]
async fn resume_with_dead_pid_registry_entry_proceeds() {
    let tmp = tempfile::tempdir().unwrap();
    let registry_root = tmp.path().join("registry");
    // macOS pids cap below 100000; this entry is a crash leftover.
    write_registry_entry(&registry_root, "ext-stale", 999_999, "1");
    let config = AgentSupervisorConfig {
        terminal_registry_root: Some(registry_root),
        ..AgentSupervisorConfig::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    sup.handle_control("spawn_session", &resume_payload("card-1", "ext-stale"), 10)
        .await
        .expect_handled_with("stale registry entry must not block resume");
}

#[tokio::test]
async fn new_mode_spawn_ignores_terminal_liveness() {
    // A `new` spawn mints a fresh id; even a (pathological)
    // registry entry with the same id must not gate it — the gate
    // is resume-only by design.
    let tmp = tempfile::tempdir().unwrap();
    let registry_root = tmp.path().join("registry");
    write_registry_entry(&registry_root, "fresh-id", std::process::id(), "1");
    let config = AgentSupervisorConfig {
        terminal_registry_root: Some(registry_root),
        ..AgentSupervisorConfig::default()
    };
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store_config(config);

    sup.handle_control("spawn_session", &spawn_payload("card-1", "fresh-id"), 10)
        .await
        .expect_handled_with("new-mode spawn is not gated on terminal liveness");
}

/// [`AgentSupervisor::session_is_content_empty`] — the predicate that
/// routes a spawn away from `resume`. It answers `true` only when the
/// ledger row holds nothing AND no transcript exists on disk; either
/// signal of content keeps the session resumable.
#[tokio::test]
async fn session_is_content_empty_needs_both_a_blank_row_and_no_transcript() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, _rx) = make_supervisor_for_ledger(ledger, None);

    // Never prompted, no transcript — the abandoned session.
    ledger
        .record_spawn(
            "blank",
            "ws-1",
            "/proj/blank",
            "card-1",
            1_000,
            "blank",
            None,
        )
        .unwrap();
    // Never prompted per the ledger, but claude wrote a transcript.
    ledger
        .record_spawn(
            "ondisk",
            "ws-1",
            "/proj/ondisk",
            "card-2",
            2_000,
            "ondisk",
            None,
        )
        .unwrap();
    seed_external_jsonl(&claude_root, "/proj/ondisk", "ondisk", "resume me");
    // No transcript yet, but the ledger recorded the user's prompt.
    ledger
        .record_spawn(
            "prompted",
            "ws-1",
            "/proj/prompted",
            "card-3",
            3_000,
            "prompted",
            None,
        )
        .unwrap();
    ledger.record_user_prompt("prompted", "hello").unwrap();

    assert!(
        sup.session_is_content_empty(&TugSessionId("blank".into()), "/proj/blank"),
        "a blank row with no transcript holds nothing to resume"
    );
    assert!(
        !sup.session_is_content_empty(&TugSessionId("ondisk".into()), "/proj/ondisk"),
        "an on-disk transcript keeps the session resumable"
    );
    assert!(
        !sup.session_is_content_empty(&TugSessionId("prompted".into()), "/proj/prompted"),
        "a recorded prompt keeps the session resumable"
    );
    assert!(
        !sup.session_is_content_empty(&TugSessionId("unknown".into()), "/proj/unknown"),
        "a session the ledger has never seen is left to the request's mode"
    );
}
