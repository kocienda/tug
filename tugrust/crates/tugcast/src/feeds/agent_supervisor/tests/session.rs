//! Tests for the session lifecycle family (`control/session.rs`): close,
//! reset, request_replay, the listings, and the ledger side of a close.

use super::*;

// ---- handle_control: close_session ----

#[tokio::test]
async fn test_close_session_publishes_closed_and_removes_entry() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();
    // Eager spawn publishes both `pending` and `spawning` before
    // close. Drain whatever the spawn produced so the close
    // assertion isolates the close-time `closed` frame.
    while state_rx.try_recv().is_ok() {}

    sup.handle_control("close_session", &close_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let (id, state) = session_state_of(&state_rx.try_recv().unwrap());
    assert_eq!(id, "sess-1");
    assert_eq!(state, "closed");
    assert!(sup.ledger.lock().await.is_empty());
}

#[tokio::test]
async fn test_close_session_removes_from_client_sessions() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();
    sup.handle_control("close_session", &close_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let cs = sup.client_sessions.lock().await;
    let set = cs.get(&10).expect("client 10 still has a set");
    assert!(!set.contains(&TugSessionId::new("sess-1")));
}

// ---- handle_control: reset_session ----

#[tokio::test]
async fn test_reset_session_publishes_closed_then_pending() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();
    // Drain everything the first spawn produced (eager spawn fires
    // both `pending` and `spawning`).
    while state_rx.try_recv().is_ok() {}

    sup.handle_control("reset_session", &reset_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    // Reset publishes `closed` then re-spawns. The re-spawn fires
    // `pending` then (because eager spawn promotes Idle→Spawning)
    // `spawning`. Assert the first two are `closed` then `pending`
    // and tolerate the trailing `spawning` frame.
    let first = session_state_of(&state_rx.try_recv().unwrap());
    let second = session_state_of(&state_rx.try_recv().unwrap());
    assert_eq!(first, ("sess-1".into(), "closed".into()));
    assert_eq!(second, ("sess-1".into(), "pending".into()));
}

// ---- handle_control: request_replay ([D12], Phase A-R1 / Step R1b) ----

/// Live session: request_replay forwards `{"type":"request_replay"}`
/// to the per-session `input_tx`. The bridge's input loop writes
/// payloads from this channel verbatim to tugcode's stdin (with a
/// trailing `\n`); we observe the frame on the receiving end of the
/// installed `input_tx` to verify the supervisor's contribution
/// without spinning a real bridge.
#[tokio::test]
async fn test_request_replay_live_session_forwards_to_input_tx() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let tug_id = TugSessionId::new("sess-live");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;

    // Install a Live state + a captured input_tx so we can observe
    // the frame. Mirrors what `relay_session_io`'s session_init
    // promote path would have done in production.
    let (input_tx_for_ledger, mut input_rx_for_assert) = mpsc::channel::<Frame>(4);
    {
        let mut entry = entry_arc.lock().await;
        entry.spawn_state = SpawnState::Live;
        entry.input_tx = Some(input_tx_for_ledger.clone());
    }
    drop(input_tx_for_ledger);

    sup.handle_control("request_replay", &request_replay_payload("sess-live"), 10)
        .await
        .expect_handled();

    let frame = input_rx_for_assert
        .try_recv()
        .expect("request_replay payload reached input_tx");
    assert_eq!(frame.feed_id, FeedId::CODE_INPUT);
    let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(parsed["type"], "request_replay");
}

/// Idle session: request_replay no-ops. No frame on input_tx (none
/// exists at Idle anyway), no error, and `handle_control` returns
/// Ok. The cold-boot startup-replay path will fire when the
/// dispatcher's first CODE_INPUT promotes Idle→Spawning.
#[tokio::test]
async fn test_request_replay_idle_session_is_noop() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let tug_id = TugSessionId::new("sess-idle");
    insert_ledger_entry(&sup, &tug_id).await;

    let result = sup
        .handle_control("request_replay", &request_replay_payload("sess-idle"), 10)
        .await;
    assert!(result.is_handled());

    // Sanity: state remains Idle, no input_tx installed.
    let entry_arc = {
        let ledger = sup.ledger.lock().await;
        ledger.get(&tug_id).cloned().unwrap()
    };
    let entry = entry_arc.lock().await;
    assert_eq!(entry.spawn_state, SpawnState::Idle);
    assert!(entry.input_tx.is_none());
}

/// Closed session: request_replay no-ops. Mirrors the Idle case;
/// behavior must be uniform across non-Live states so a stale
/// dispatch (e.g. tugdeck reconstructed services for a binding
/// that has since been closed) cannot resurrect a dead session.
#[tokio::test]
async fn test_request_replay_closed_session_is_noop() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let tug_id = TugSessionId::new("sess-closed");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    // An input_tx left over from a prior Live phase MUST NOT receive
    // the request_replay frame once the entry is Closed.
    let (input_tx_for_ledger, mut input_rx_for_assert) = mpsc::channel::<Frame>(4);
    {
        let mut entry = entry_arc.lock().await;
        entry.spawn_state = SpawnState::Closed;
        entry.input_tx = Some(input_tx_for_ledger.clone());
    }
    drop(input_tx_for_ledger);

    sup.handle_control("request_replay", &request_replay_payload("sess-closed"), 10)
        .await
        .expect_handled();

    // input_tx receives nothing — the no-op branch fired.
    assert!(
        input_rx_for_assert.try_recv().is_err(),
        "no request_replay frame for a Closed entry"
    );
}

/// Unknown tug_session_id: no-op, no error. Matches the
/// `close_session` "unknown is noop" contract — the supervisor's
/// surface treats stale dispatches uniformly.
#[tokio::test]
async fn test_request_replay_unknown_session_is_noop() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let result = sup
        .handle_control(
            "request_replay",
            &request_replay_payload("sess-unknown"),
            10,
        )
        .await;
    assert!(result.is_handled());
}

/// Missing tug_session_id: parse_tug_session_id_payload returns
/// `MissingSessionId`. The `?` in handle_control propagates.
#[tokio::test]
async fn test_request_replay_missing_tug_session_id_is_error() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    // Payload missing `tug_session_id`.
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "request_replay",
    }))
    .unwrap();
    let result = sup.handle_control("request_replay", &payload, 10).await;
    assert_eq!(result.expect_error(), ControlError::MissingSessionId);
}

/// Empty tug_session_id: same as missing (the parser filters empty
/// strings). Pins the wire-side validator's contract.
#[tokio::test]
async fn test_request_replay_empty_tug_session_id_is_error() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "request_replay",
        "tug_session_id": "",
    }))
    .unwrap();
    let result = sup.handle_control("request_replay", &payload, 10).await;
    assert_eq!(result.expect_error(), ControlError::MissingSessionId);
}

/// Malformed JSON payload: parser returns `Malformed`.
#[tokio::test]
async fn test_request_replay_malformed_payload_is_error() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let result = sup
        .handle_control("request_replay", b"not-json-at-all", 10)
        .await;
    assert_eq!(result.expect_error(), ControlError::Malformed);
}

// ---- handle_control: request_replay during Spawning (Step R4 / [D12]) ----

/// Spawning: request_replay is enqueued at the front of the
/// per-session queue. The bridge's session_init promote-and-drain
/// (separately tested) forwards queued frames to input_tx in
/// queue order — so a request_replay queued during Spawning lands
/// at tugcode's stdin before any user input that may have been
/// queued behind it.
///
/// This test simulates the production drain by popping from
/// `entry.queue` and asserting the popped frame is the
/// request_replay payload.
#[tokio::test]
async fn test_request_replay_spawning_session_enqueues_at_front_of_queue() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    // Pre-load an entry in the Spawning state. Some other code path
    // (e.g., the dispatcher buffering a CODE_INPUT user_message
    // while claude is still booting) has already pushed a frame
    // onto the queue.
    let tug_id = TugSessionId::new("sess-r4-spawning");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    let user_input_payload = serde_json::to_vec(&serde_json::json!({
        "tug_session_id": "sess-r4-spawning",
        "type": "user_message",
        "text": "hi",
    }))
    .unwrap();
    let user_frame = Frame::new(FeedId::CODE_INPUT, user_input_payload.clone());
    {
        let mut entry = entry_arc.lock().await;
        entry.spawn_state = SpawnState::Spawning;
        assert_eq!(entry.queue.push(user_frame.clone()), QueuePush::Ok);
    }

    // Now the request_replay verb arrives. The Spawning branch
    // front-pushes it — so it precedes the user_message in the
    // queue.
    sup.handle_control(
        "request_replay",
        &request_replay_payload("sess-r4-spawning"),
        10,
    )
    .await
    .expect_handled();

    // Verify the queue contents in drain order: request_replay
    // first, user_message second.
    let mut entry = entry_arc.lock().await;
    let first = entry.queue.pop().expect("first frame queued");
    let second = entry.queue.pop().expect("second frame queued");
    assert!(entry.queue.is_empty(), "exactly two frames in queue");

    let first_body: serde_json::Value = serde_json::from_slice(&first.payload).unwrap();
    assert_eq!(first_body["type"], "request_replay");

    let second_body: serde_json::Value = serde_json::from_slice(&second.payload).unwrap();
    assert_eq!(second_body["type"], "user_message");
}

/// Spawning with an empty queue: request_replay is the only
/// resident; pop returns it; nothing else.
#[tokio::test]
async fn test_request_replay_spawning_empty_queue_just_request_replay() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let tug_id = TugSessionId::new("sess-r4-spawning-empty");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut entry = entry_arc.lock().await;
        entry.spawn_state = SpawnState::Spawning;
    }

    sup.handle_control(
        "request_replay",
        &request_replay_payload("sess-r4-spawning-empty"),
        10,
    )
    .await
    .expect_handled();

    let mut entry = entry_arc.lock().await;
    let frame = entry.queue.pop().expect("request_replay queued");
    assert!(entry.queue.is_empty());
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["type"], "request_replay");
}

/// Live session: request_replay is forwarded immediately to
/// input_tx (no queue interaction). Regression-pin for the
/// pre-existing happy path — R4's branch refactor must not break
/// this.
#[tokio::test]
async fn test_request_replay_live_immediate_forward_unchanged_post_r4() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let tug_id = TugSessionId::new("sess-r4-live");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;

    let (input_tx_for_ledger, mut input_rx_for_assert) = mpsc::channel::<Frame>(4);
    {
        let mut entry = entry_arc.lock().await;
        entry.spawn_state = SpawnState::Live;
        entry.input_tx = Some(input_tx_for_ledger.clone());
    }
    drop(input_tx_for_ledger);

    sup.handle_control(
        "request_replay",
        &request_replay_payload("sess-r4-live"),
        10,
    )
    .await
    .expect_handled();

    let frame = input_rx_for_assert
        .try_recv()
        .expect("Live forwards immediately");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["type"], "request_replay");

    // And nothing landed on the queue (Spawning path didn't fire).
    let entry = entry_arc.lock().await;
    assert!(entry.queue.is_empty());
}

// ── do_close_session ↔ ledger integration ────────────────────────────────

/// `do_close_session` reads `entry.claude_session_id` and dispatches
/// `mark_closed` to the recorder. With a real ledger plugged in, the
/// row's state must transition.
#[tokio::test]
async fn close_session_marks_ledger_row_closed_when_claude_id_present() {
    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    let recorder: Arc<dyn SessionsRecorder> =
        Arc::new(LedgerSessionsRecorder::new(Arc::clone(&ledger)));

    let (state_tx, _state_rx) = broadcast::channel(64);
    let (meta_tx, _meta_rx) = broadcast::channel(8);
    let (code_tx, _code_rx) = broadcast::channel(8);
    let (control_tx, _control_rx) = broadcast::channel(64);
    let registry = Arc::new(WorkspaceRegistry::new_for_test());
    let cancel = CancellationToken::new();
    let (sup, mut register_rx) = AgentSupervisor::new(
        SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::SESSION_SIDEBAND, meta_tx, LagPolicy::Warn),
        SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
        SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
        control_tx,
        recorder,
        stall_spawner_factory(),
        AgentSupervisorConfig::default(),
        registry,
        cancel,
    );
    // Drain merger registrations like make_supervisor_with_store does.
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    // Spawn the session through the normal CONTROL path so the entry is
    // populated correctly. Then manually set `claude_session_id` to
    // simulate that `session_init` was observed (which the bridge would
    // have done in production).
    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();
    // Pre-seed the ledger so `mark_closed` has a row to transition.
    ledger
        .record_spawn(
            "claude-1",
            "/some/workspace",
            "/some/workspace",
            "card-1",
            1_700_000_000_000,
            "claude-1",
            None,
        )
        .unwrap();
    {
        let outer = sup.ledger.lock().await;
        let entry_arc = outer
            .get(&TugSessionId::new("sess-1"))
            .expect("entry")
            .clone();
        drop(outer);
        let mut entry = entry_arc.lock().await;
        entry.claude_session_id = Some("claude-1".to_owned());
    }

    sup.handle_control("close_session", &close_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let row = ledger.get("claude-1").unwrap().expect("row");
    assert_eq!(row.state, LedgerState::Closed);
    assert_eq!(row.card_id.as_deref(), Some("card-1"));
}

/// `list_card_bindings` returns every non-failed row carrying a
/// `card_id`, including rows with `turn_count == 0`. The wire
/// shape includes `turn_count` so the client can branch:
/// `mode=resume` for rows with history (claude has a JSONL),
/// `mode=new` for zero-turn rows (no JSONL but the card→project
/// binding should be preserved across relaunches).
#[tokio::test]
async fn list_card_bindings_returns_all_card_rows_with_turn_count() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    // A card whose user picked Start Fresh and quit before any
    // prompt: spawned (record_spawn fires on session_init) but
    // never had a turn.
    ledger
        .record_spawn(
            "empty",
            "ws-1",
            "/proj/alpha",
            "card-A",
            1_000,
            "empty",
            None,
        )
        .unwrap();
    ledger.mark_closed("empty").unwrap();

    // A card with a real conversation (count from the engine reconcile).
    ledger
        .record_spawn("real", "ws-1", "/proj/beta", "card-B", 2_000, "real", None)
        .unwrap();
    ledger.set_turn_count("real", 1, 3_000).unwrap();
    ledger.mark_closed("real").unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_card_bindings",
    }))
    .unwrap();
    sup.handle_control("list_card_bindings", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_card_bindings_ok");
    let bindings = response["bindings"].as_array().expect("bindings array");
    assert_eq!(
        bindings.len(),
        2,
        "both rows surface — client decides resume vs new on turn_count. \
             response: {response}",
    );
    let by_card: std::collections::HashMap<&str, &serde_json::Value> = bindings
        .iter()
        .map(|b| (b["card_id"].as_str().unwrap(), b))
        .collect();
    let empty = by_card["card-A"];
    assert_eq!(empty["session_id"], "empty");
    assert_eq!(empty["project_dir"], "/proj/alpha");
    assert_eq!(empty["turn_count"], 0);
    let real = by_card["card-B"];
    assert_eq!(real["session_id"], "real");
    assert_eq!(real["project_dir"], "/proj/beta");
    assert_eq!(real["turn_count"], 1);

    // Both rows are mark_closed and never live-registered in the
    // in-memory supervisor map, so neither is "alive". The flag
    // must still appear on the wire (consumers gate on it).
    assert_eq!(empty["is_alive"], false);
    assert_eq!(real["is_alive"], false);
}

/// A card that has lived through several claude ids is **one** binding,
/// seated on the segment a restore should resume ([P06]) and carrying the
/// line's identity and the line's summed turns ([P01]). Eight bindings for
/// one card is the shape this model exists to remove.
#[tokio::test]
async fn list_card_bindings_returns_one_row_per_line_seated_on_the_resume_segment() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    // The line's root: closed, with turns of its own.
    ledger
        .record_spawn("root", "ws-1", "/proj", "card-A", 1_000, "line-A", None)
        .unwrap();
    ledger.set_turn_count("root", 4, 1_500).unwrap();
    ledger.mark_closed("root").unwrap();
    // A stage the card rotated into, still live and used later.
    ledger
        .record_spawn("stage", "ws-1", "/proj", "card-A", 2_000, "line-A", None)
        .unwrap();
    ledger.set_turn_count("stage", 3, 2_500).unwrap();
    ledger.rename("line-A", Some("harbor light")).unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_card_bindings",
    }))
    .unwrap();
    sup.handle_control("list_card_bindings", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_card_bindings_ok");
    let bindings = response["bindings"].as_array().expect("bindings array");
    assert_eq!(bindings.len(), 1, "one line, one binding: {response}");
    let binding = &bindings[0];
    assert_eq!(binding["card_id"], "card-A");
    assert_eq!(binding["line_id"], "line-A");
    assert_eq!(
        binding["session_id"], "stage",
        "the live segment is the resume target"
    );
    assert_eq!(
        binding["turn_count"], 7,
        "the line's turns, not the seated segment's"
    );
    assert_eq!(binding["name"], "harbor light");
    assert_eq!(
        binding["tag"],
        serde_json::json!(
            ledger
                .get_line("line-A")
                .unwrap()
                .expect("the line exists")
                .tag
        )
    );
}

/// `resolve_sessions { ids }` answers both ways in one frame — the found
/// rows keyed by what was asked, and the misses named as misses so the
/// client can cache a negative instead of re-asking on every repaint
/// ([D132]).
#[tokio::test]
async fn resolve_sessions_answers_hits_and_misses_in_one_frame() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    let full = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    ledger
        .record_spawn(
            full,
            "ws-1",
            "/proj/alpha",
            "card-A",
            1_000,
            full,
            Some("stocky-pixie"),
        )
        .unwrap();
    // And one a background owner holds — a live session with no card
    // a user could be raised to.
    let held = "0c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    ledger
        .record_spawn(
            held,
            "ws-1",
            "/proj/alpha",
            &crate::background_session::background_card_id("nightly-audit"),
            1_000,
            held,
            Some("amber-otter"),
        )
        .unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "resolve_sessions",
        // The full uuid a `Tug-Session-Id` carries, the 8-char token a
        // citation carries, and a session written on another machine.
        "ids": [full, "f6e43925", held, "0badf00d"],
    }))
    .unwrap();
    sup.handle_control("resolve_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "resolve_sessions_ok");
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 3, "response: {response}");
    // Keyed by the asked-for spelling; the row carries the whole identity,
    // callsign included, so the chip renders the ledger's own word.
    assert_eq!(sessions[0]["queried"], full);
    assert_eq!(sessions[0]["session"]["session_id"], full);
    assert_eq!(sessions[0]["session"]["tag"], "stocky-pixie");
    assert_eq!(sessions[1]["queried"], "f6e43925");
    assert_eq!(sessions[1]["session"]["session_id"], full);
    // The field the deck's adoption gesture turns on rides the same frame:
    // a card holds the first, a background owner holds the third, and the
    // deck can tell a session it could raise from one it must adopt.
    assert_eq!(sessions[0]["session"]["background"], false);
    assert_eq!(sessions[2]["queried"], held);
    assert_eq!(sessions[2]["session"]["background"], true);
    // The miss is stated rather than merely omitted.
    assert_eq!(
        response["unknown"].as_array().expect("unknown array"),
        &vec![serde_json::json!("0badf00d")],
    );
}

/// A session another instance recorded is **elsewhere**, not unknown
/// ([P05], [Spec S04]). The ledger cannot answer for it — a callsign is
/// unique per ledger and this one was minted in another — so the miss
/// goes to the finder's machine-wide arms, and the frame says where it
/// is rather than that it does not exist.
#[tokio::test]
async fn resolve_sessions_answers_a_foreign_session_as_elsewhere() {
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();
    // A uuid nothing else in the suite uses, so a shared scratch index
    // cannot make this test answer for somebody else's row.
    let foreign = "7e5ea70e-0e11-4a5e-9c0d-5e55e7e1ce01";
    // The index is the machine-wide one, which under cargo resolves
    // into the scratch data root (`TUG_DATA_DIR`), never the user's.
    let index_path = tugcore::instance::session_index_db_path();
    let index = tugcore::session_index::SessionIndex::open(&index_path).expect("open index");
    index
        .upsert(&tugcore::session_index::IndexEntry {
            session_id: foreign.to_owned(),
            line_id: "foreign-line".to_owned(),
            callsign: Some("curly-apple".to_owned()),
            project_dir: "/u/src/eucit".to_owned(),
            project_leaf: String::new(),
            // Not this instance's, so the row is not a stale one of ours.
            instance: "debug-elsewhere".to_owned(),
            title: Some("Somebody else's work".to_owned()),
            created_at_ms: 1,
            updated_at_ms: 2,
        })
        .expect("seed a foreign index row");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "resolve_sessions",
        "ids": [foreign, "eucit/curly-apple", "0badf00d"],
    }))
    .unwrap();
    sup.handle_control("resolve_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "resolve_sessions_ok");
    assert!(
        response["sessions"]
            .as_array()
            .expect("sessions")
            .is_empty(),
        "this ledger holds neither: {response}"
    );
    let elsewhere = response["elsewhere"].as_array().expect("elsewhere array");
    assert_eq!(elsewhere.len(), 2, "response: {response}");
    // Keyed by what was asked, uuid and `project/callsign` alike, and
    // carrying enough for a pill to say where the session is.
    assert_eq!(elsewhere[0]["queried"], foreign);
    assert_eq!(elsewhere[0]["session_id"], foreign);
    assert_eq!(elsewhere[0]["project_dir"], "/u/src/eucit");
    assert_eq!(elsewhere[0]["callsign"], "curly-apple");
    assert_eq!(elsewhere[0]["title"], "Somebody else's work");
    assert_eq!(elsewhere[0]["instance"], "debug-elsewhere");
    assert_eq!(elsewhere[1]["queried"], "eucit/curly-apple");
    assert_eq!(elsewhere[1]["session_id"], foreign);
    // And a spelling nothing on this machine answers to is still stated
    // as a miss rather than quietly dropped.
    assert_eq!(
        response["unknown"].as_array().expect("unknown array"),
        &vec![serde_json::json!("0badf00d")],
    );

    index
        .remove(foreign)
        .expect("leave the scratch index as found");
}

/// A malformed request is refused, and a well-formed one naming nothing is
/// answered — a client sitting on `pending` forever is the one outcome with
/// no rendering at all.
#[tokio::test]
async fn resolve_sessions_refuses_a_malformed_payload_and_answers_an_empty_one() {
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();
    let bad = serde_json::to_vec(&serde_json::json!({
        "action": "resolve_sessions",
    }))
    .unwrap();
    assert!(matches!(
        sup.handle_control("resolve_sessions", &bad, 10).await,
        ControlOutcome::Error(_),
    ));

    let empty = serde_json::to_vec(&serde_json::json!({
        "action": "resolve_sessions",
        "ids": [],
    }))
    .unwrap();
    sup.handle_control("resolve_sessions", &empty, 10)
        .await
        .expect_handled();
    let response = drain_until_action(&mut rx, "resolve_sessions_ok");
    assert!(response["sessions"].as_array().expect("array").is_empty());
    assert!(response["unknown"].as_array().expect("array").is_empty());
}

/// `list_card_bindings` reports `is_alive: true` for a session
/// whose subprocess entry in the in-memory ledger is in the
/// `Spawning` or `Live` state. This is the third signal the client
/// uses to decide `mode=resume` for an **in-flight first turn** —
/// a session that has zero committed turns (`turn_count == 0`) but
/// holds an active claude subprocess with mid-turn state (e.g. a
/// pending `AskUserQuestion`). Without `is_alive`, the client's
/// `turn_count`-only gate would mistake the in-flight case for
/// "Start Fresh + quit" and spawn a fresh session, orphaning the
/// live one.
#[tokio::test]
async fn list_card_bindings_reports_is_alive_for_live_sessions() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    // Two rows in sqlite, both with `turn_count == 0`. The
    // difference between them is whether the in-memory ledger
    // entry exists in a Live state.
    ledger
        .record_spawn(
            "live",
            "ws-1",
            "/proj/alive",
            "card-Live",
            1_000,
            "live",
            None,
        )
        .unwrap();
    ledger
        .record_spawn(
            "dead",
            "ws-1",
            "/proj/dead",
            "card-Dead",
            2_000,
            "dead",
            None,
        )
        .unwrap();

    // Promote "live" into the supervisor's in-memory ledger as
    // `Live`. "dead" stays out of the map — its sqlite row is the
    // only trace.
    {
        let mut map = sup.ledger.lock().await;
        let entry = LedgerEntry {
            spawn_state: SpawnState::Live,
            ..LedgerEntry::new(
                TugSessionId("live".to_string()),
                WorkspaceKey::from_test_str("ws-1"),
                std::path::PathBuf::from("/proj/alive"),
                SessionMode::New,
                CrashBudget::new(3, std::time::Duration::from_secs(60)),
            )
        };
        map.insert(
            TugSessionId("live".to_string()),
            std::sync::Arc::new(tokio::sync::Mutex::new(entry)),
        );
    }

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_card_bindings",
    }))
    .unwrap();
    sup.handle_control("list_card_bindings", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_card_bindings_ok");
    let bindings = response["bindings"].as_array().expect("bindings array");
    let by_card: std::collections::HashMap<&str, &serde_json::Value> = bindings
        .iter()
        .map(|b| (b["card_id"].as_str().unwrap(), b))
        .collect();
    let live = by_card["card-Live"];
    let dead = by_card["card-Dead"];
    assert_eq!(live["turn_count"], 0);
    assert_eq!(live["is_alive"], true);
    assert_eq!(dead["turn_count"], 0);
    assert_eq!(dead["is_alive"], false);
}

/// `list_card_bindings` reports `has_jsonl: true` for a session whose
/// on-disk transcript exists under the Claude home's projects, and `false`
/// for one with no file — the reliable resume signal, independent of the
/// ledger's `turn_count`. The regression it guards: a session with a
/// transcript but `turn_count == 0` (claude wrote the JSONL outside a
/// live `record_turn`) was mis-routed on restore to a `mode=new` spawn
/// whose `--session-id` collided and crash-looped the card to `errored`.
#[tokio::test]
async fn list_card_bindings_reports_has_jsonl_from_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, None);

    // Both rows have `turn_count == 0`; only "withfile" has a transcript
    // on disk.
    ledger
        .record_spawn(
            "withfile",
            "ws-1",
            "/proj/withfile",
            "card-With",
            1_000,
            "withfile",
            None,
        )
        .unwrap();
    ledger
        .record_spawn(
            "nofile",
            "ws-1",
            "/proj/nofile",
            "card-No",
            2_000,
            "nofile",
            None,
        )
        .unwrap();
    seed_external_jsonl(&claude_root, "/proj/withfile", "withfile", "resume me");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_card_bindings",
    }))
    .unwrap();
    sup.handle_control("list_card_bindings", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_card_bindings_ok");
    let bindings = response["bindings"].as_array().expect("bindings array");
    let by_card: std::collections::HashMap<&str, &serde_json::Value> = bindings
        .iter()
        .map(|b| (b["card_id"].as_str().unwrap(), b))
        .collect();
    assert_eq!(by_card["card-With"]["turn_count"], 0);
    assert_eq!(
        by_card["card-With"]["has_jsonl"], true,
        "a session with an on-disk transcript reports has_jsonl"
    );
    assert_eq!(
        by_card["card-No"]["has_jsonl"], false,
        "a session with no transcript reports has_jsonl false"
    );
}

#[tokio::test]
async fn list_sessions_returns_project_dir_rows_newest_first() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    ledger
        .record_spawn("s-old", "ws-1", "/proj/alpha", "c1", 1_000, "s-old", None)
        .unwrap();
    ledger.record_user_prompt("s-old", "old prompt").unwrap();
    ledger.mark_closed("s-old").unwrap();
    ledger
        .record_spawn("s-new", "ws-1", "/proj/alpha", "c2", 5_000, "s-new", None)
        .unwrap();
    ledger.record_user_prompt("s-new", "new prompt").unwrap();
    ledger.mark_closed("s-new").unwrap();
    ledger
        .record_spawn("other", "ws-2", "/proj/beta", "c3", 3_000, "other", None)
        .unwrap();
    ledger.record_user_prompt("other", "other prompt").unwrap();
    ledger.mark_closed("other").unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();

    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "list_sessions_ok");
    assert_eq!(response["project_dir"], "/proj/alpha");
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 2, "/proj/alpha has exactly 2 rows");
    assert_eq!(sessions[0]["session_id"], "s-new");
    assert_eq!(sessions[1]["session_id"], "s-old");
}

#[tokio::test]
async fn list_sessions_unions_external_sessions_with_ledger_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, None);

    ledger
        .record_spawn(
            "tug-row",
            "ws-1",
            "/proj/alpha",
            "c1",
            9_000,
            "tug-row",
            None,
        )
        .unwrap();
    ledger.record_user_prompt("tug-row", "tug prompt").unwrap();
    ledger.mark_closed("tug-row").unwrap();
    seed_external_jsonl(&claude_root, "/proj/alpha", EXTERNAL_ID, "external prompt");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 2, "ledger row + external row: {response}");
    let by_id: std::collections::HashMap<&str, &serde_json::Value> = sessions
        .iter()
        .map(|s| (s["session_id"].as_str().unwrap(), s))
        .collect();
    let tug = by_id["tug-row"];
    assert_eq!(tug["origin"], "tug");
    assert_eq!(tug["terminal_live"], serde_json::Value::Null);
    let ext = by_id[EXTERNAL_ID];
    assert_eq!(ext["origin"], "external");
    assert_eq!(ext["state"], "closed");
    assert_eq!(ext["card_id"], serde_json::Value::Null);
    assert_eq!(ext["turn_count"], 1);
    assert_eq!(ext["last_user_prompt"], "external prompt");
    assert_eq!(ext["terminal_live"], serde_json::Value::Null);
    // Sorted newest-first: the external row's last_used_at is the
    // file's real mtime (now), which postdates the ledger row's
    // synthetic 9000ms-epoch timestamp.
    assert_eq!(sessions[0]["session_id"], EXTERNAL_ID);
    assert_eq!(sessions[1]["session_id"], "tug-row");
}

#[tokio::test]
async fn list_sessions_omits_prompt_free_sessions() {
    // A session abandoned before its first prompt — a ledger row with
    // nothing recorded, and an on-disk transcript carrying no user
    // record — has nothing to resume into and never reaches the wire.
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, None);

    ledger
        .record_spawn(
            "empty-row",
            "ws-1",
            "/proj/alpha",
            "c1",
            9_000,
            "empty-row",
            None,
        )
        .unwrap();
    ledger.mark_closed("empty-row").unwrap();
    ledger
        .record_spawn(
            "used-row",
            "ws-1",
            "/proj/alpha",
            "c2",
            9_500,
            "used-row",
            None,
        )
        .unwrap();
    ledger.record_user_prompt("used-row", "real work").unwrap();
    ledger.mark_closed("used-row").unwrap();

    let dir = claude_root.join(tugcore::claude_home::encode_project_dir("/proj/alpha"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
            dir.join(format!("{EXTERNAL_ID}.jsonl")),
            format!(
                "{{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"{EXTERNAL_ID}\",\"cwd\":\"/proj/alpha\"}}"
            ),
        )
        .unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 1, "only the prompted row: {response}");
    assert_eq!(sessions[0]["session_id"], "used-row");
}

#[tokio::test]
async fn list_sessions_scans_canonical_dir_for_symlinked_project_path() {
    // A project typed through a symlink alias (e.g. `/u/src/tugtool`)
    // must still find sessions: claude names its per-project
    // directory after the CANONICAL cwd, so the scan canonicalizes
    // the typed path before encoding.
    let tmp = tempfile::tempdir().unwrap();
    // Canonicalize the tempdir itself (`/var` → `/private/var` on
    // macOS) so the seeded encoding matches what the supervisor's
    // canonicalize resolves.
    let tmp_real = std::fs::canonicalize(tmp.path()).unwrap();
    let real_project = tmp_real.join("real-project");
    std::fs::create_dir_all(&real_project).unwrap();
    let alias = tmp_real.join("alias-project");
    std::os::unix::fs::symlink(&real_project, &alias).unwrap();

    let claude_root = tmp_real.join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp_real.join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp_real),
        )
        .unwrap(),
    );
    let (sup, _ledger, mut rx) = make_supervisor_for_ledger(ledger, None);
    let real_project_str = real_project.to_str().unwrap();
    seed_external_jsonl(&claude_root, real_project_str, EXTERNAL_ID, "via alias");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": alias.to_str().unwrap(),
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(
        sessions.len(),
        1,
        "alias query finds the canonical-dir session: {response}"
    );
    assert_eq!(sessions[0]["session_id"], EXTERNAL_ID);
    assert_eq!(sessions[0]["origin"], "external");
    // The row carries the canonical dir so downstream consumers
    // (trash) re-derive the JSONL location correctly.
    assert_eq!(sessions[0]["project_dir"], real_project_str);
}

#[tokio::test]
async fn list_sessions_dedupes_by_session_id_ledger_wins() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, None);

    // Same id on disk AND in the ledger — an adopted session.
    ledger
        .record_spawn(
            EXTERNAL_ID,
            "ws-1",
            "/proj/alpha",
            "c1",
            9_000,
            EXTERNAL_ID,
            None,
        )
        .unwrap();
    ledger.mark_closed(EXTERNAL_ID).unwrap();
    seed_external_jsonl(&claude_root, "/proj/alpha", EXTERNAL_ID, "adopted");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 1, "deduped: {response}");
    assert_eq!(sessions[0]["origin"], "tug");
}

#[tokio::test]
async fn list_sessions_merges_disk_content_into_sparse_ledger_row() {
    // A resumed external session leaves a ledger row that knows
    // lifecycle but not content (zero turns, no prompt). The union
    // must surface the transcript's content on that row instead of
    // letting the sparse row shadow it — a zero-turn row is hidden
    // by the picker, so without the merge the session vanishes.
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, None);

    seed_external_jsonl(&claude_root, "/proj/alpha", EXTERNAL_ID, "rich prompt");
    // Spawn with NO scan-cache row (cold ledger): the row is sparse.
    ledger
        .record_spawn(
            EXTERNAL_ID,
            "ws-1",
            "/proj/alpha",
            "c1",
            9_000,
            EXTERNAL_ID,
            None,
        )
        .unwrap();
    ledger.mark_closed(EXTERNAL_ID).unwrap();
    {
        let row = ledger.get(EXTERNAL_ID).unwrap().unwrap();
        assert_eq!(row.turn_count, 0, "precondition: sparse ledger row");
        assert_eq!(row.last_user_prompt, None);
    }

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 1, "still one row: {response}");
    let row = &sessions[0];
    assert_eq!(row["origin"], "tug", "ledger row keeps identity");
    assert_eq!(row["turn_count"], 1, "turn count absorbed from disk");
    assert_eq!(row["last_user_prompt"], "rich prompt");
    // The file's real mtime (now) postdates the synthetic 9000ms
    // ledger stamp, so the row also rides the fresher timestamp.
    assert!(
        row["last_used_at"].as_i64().unwrap() > 9_000,
        "fresher disk mtime surfaces: {row}"
    );
}

#[tokio::test]
async fn list_sessions_annotates_terminal_live_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let registry_root = tmp.path().join("registry");
    std::fs::create_dir_all(&registry_root).unwrap();
    // A live registry entry for the external session, using the
    // test process's own (genuinely alive) pid. No procStart →
    // accepted fail-open.
    std::fs::write(
        registry_root.join("1.json"),
        format!(
            r#"{{"pid":{},"sessionId":"{EXTERNAL_ID}","status":"busy"}}"#,
            std::process::id()
        ),
    )
    .unwrap();
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, _ledger, mut rx) = make_supervisor_for_ledger(ledger, Some(registry_root));
    seed_external_jsonl(&claude_root, "/proj/alpha", EXTERNAL_ID, "held by terminal");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("list_sessions", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_list_sessions_settled(&mut rx).await;
    let sessions = response["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["terminal_live"]["status"], "busy");
}

#[tokio::test]
async fn list_sessions_missing_project_dir_errors() {
    let (sup, _ledger, _rx) = make_supervisor_with_ledger();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "list_sessions",
    }))
    .unwrap();

    let err = sup
        .handle_control("list_sessions", &payload, 10)
        .await
        .expect_error();
    assert!(
        matches!(err, ControlError::InvalidProjectDir { reason } if reason == "missing_project_dir")
    );
}
