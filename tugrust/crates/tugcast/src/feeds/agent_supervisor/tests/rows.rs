//! Tests for the session-rows family (`control/rows.rs`), driven end-to-end
//! through `handle_control`.

use super::*;

/// `set_session_private` writes the flag, acks, and pushes the row so the
/// chip can show a resting state ([P05], [Q01]). No fact is recorded for
/// the toggle — recording the act of hiding would leak the hiding.
#[tokio::test]
async fn set_session_private_acks_and_pushes_the_flag() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn("sess", "ws-1", "/proj", "card-A", 1_000, "sess", None)
        .unwrap();
    let facts_before = ledger.facts_for_test().len();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "set_session_private",
        "session_id": "sess",
        "private": true,
    }))
    .unwrap();
    sup.handle_control("set_session_private", &payload, 10)
        .await
        .expect_handled();

    let ack = drain_until_action(&mut rx, "set_session_private_ok");
    assert_eq!(ack["session_id"], "sess");
    assert_eq!(ack["private"], true);
    assert!(ledger.is_session_private("sess").unwrap());
    assert_eq!(
        ledger.facts_for_test().len(),
        facts_before,
        "the toggle itself is not a fact"
    );

    // Turning it back off is the same verb; the push carries the new value.
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "set_session_private",
        "session_id": "sess",
        "private": false,
    }))
    .unwrap();
    sup.handle_control("set_session_private", &payload, 10)
        .await
        .expect_handled();
    let pushed = drain_until_action(&mut rx, "session_updated");
    assert_eq!(pushed["fields"]["private"], false);
    assert!(!ledger.is_session_private("sess").unwrap());
}

#[tokio::test]
async fn set_session_private_on_an_unknown_session_errs() {
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "set_session_private",
        "session_id": "nope",
        "private": true,
    }))
    .unwrap();
    sup.handle_control("set_session_private", &payload, 10)
        .await
        .expect_handled();
    let err = drain_until_action(&mut rx, "set_session_private_err");
    assert_eq!(err["reason"], "not_found");
}

/// A refusal names the value it refused in either direction. The client
/// puts back the negation of that value, so an omitted or one-sided field
/// would leave a failed un-private toggle showing "public" over a session
/// the ledger still holds private.
#[tokio::test]
async fn a_refused_toggle_names_the_value_it_refused() {
    let (sup, _ledger, mut rx) = make_supervisor_with_ledger();
    for requested in [true, false] {
        let payload = serde_json::to_vec(&serde_json::json!({
            "action": "set_session_private",
            "session_id": "nope",
            "private": requested,
        }))
        .unwrap();
        sup.handle_control("set_session_private", &payload, 10)
            .await
            .expect_handled();
        let err = drain_until_action(&mut rx, "set_session_private_err");
        assert_eq!(err["session_id"], "nope");
        assert_eq!(err["private"], requested);
    }
}

/// Both rename acks name the rename they answer. The client renames
/// optimistically off a broadcast feed, so an ack it cannot place is one it
/// cannot act on — and the refusal is the only thing that puts the replaced
/// name back.
#[tokio::test]
async fn rename_acks_carry_the_name_they_answer() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn("sess", "ws-1", "/proj", "card-A", 1_000, "line-A", None)
        .unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "rename_session",
        "line_id": "line-A",
        "name": "harbor light",
    }))
    .unwrap();
    sup.handle_control("rename_session", &payload, 10)
        .await
        .expect_handled();
    let ack = drain_until_action(&mut rx, "rename_session_ok");
    assert_eq!(ack["line_id"], "line-A");
    assert_eq!(ack["name"], "harbor light");

    // A cleared name acks as null — the same value the request carried.
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "rename_session",
        "line_id": "line-A",
        "name": "   ",
    }))
    .unwrap();
    sup.handle_control("rename_session", &payload, 10)
        .await
        .expect_handled();
    let ack = drain_until_action(&mut rx, "rename_session_ok");
    assert!(ack["name"].is_null());

    // And the refusal names it too.
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "rename_session",
        "line_id": "nope",
        "name": "harbor light",
    }))
    .unwrap();
    sup.handle_control("rename_session", &payload, 10)
        .await
        .expect_handled();
    let err = drain_until_action(&mut rx, "rename_session_err");
    assert_eq!(err["reason"], "not_found");
    assert_eq!(err["name"], "harbor light");
}

/// A rename onto a name another line wears TAKES it ([P11]): the newest
/// gesture wins, the previous holder falls back to its callsign, and the
/// ack names whom the name was taken from so the gesture can say so.
#[tokio::test]
async fn rename_by_line_takes_a_taken_name() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn("first", "ws-1", "/proj", "card-A", 1_000, "line-A", None)
        .unwrap();
    ledger
        .record_spawn("second", "ws-1", "/proj", "card-B", 1_000, "line-B", None)
        .unwrap();
    ledger.rename("line-A", Some("harbor light")).unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "rename_session",
        "line_id": "line-B",
        "name": "harbor light",
    }))
    .unwrap();
    sup.handle_control("rename_session", &payload, 10)
        .await
        .expect_handled();

    let ack = drain_until_action(&mut rx, "rename_session_ok");
    assert_eq!(ack["line_id"], "line-B");
    assert_eq!(ack["displaced"][0]["line_id"], serde_json::json!("line-A"));
    assert_eq!(
        ack["displaced"][0]["tag"],
        serde_json::json!(
            ledger
                .get("first")
                .unwrap()
                .unwrap()
                .tag
                .expect("the displaced line wears a callsign")
        )
    );

    // The name moved: the previous holder lost it, the renamed line wears
    // it.
    assert_eq!(ledger.get("first").unwrap().unwrap().name, None);
    assert!(!ledger.get("first").unwrap().unwrap().name_user_set);
    assert_eq!(
        ledger.get("second").unwrap().unwrap().name.as_deref(),
        Some("harbor light")
    );
}

/// The name lands on the **line**, so every segment of it reads the new
/// name — including one recorded after the rename. That is the whole
/// point of addressing the write by line: a card that rotates its claude
/// id mid-conversation does not go back to being untitled.
#[tokio::test]
async fn a_rename_lands_on_the_line_and_every_segment_reads_it() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn("root", "ws-1", "/proj", "card-A", 1_000, "line-A", None)
        .unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "rename_session",
        "line_id": "line-A",
        "name": "harbor light",
    }))
    .unwrap();
    sup.handle_control("rename_session", &payload, 10)
        .await
        .expect_handled();
    drain_until_action(&mut rx, "rename_session_ok");

    // A rotation joins the line after the rename has already landed.
    ledger
        .record_spawn("stage", "ws-1", "/proj", "card-A", 2_000, "line-A", None)
        .unwrap();
    assert_eq!(
        ledger.get("stage").unwrap().unwrap().name.as_deref(),
        Some("harbor light"),
        "the segment reads the line's name through the join"
    );
    assert_eq!(
        ledger.get("root").unwrap().unwrap().name.as_deref(),
        Some("harbor light")
    );
}

#[tokio::test]
async fn trash_of_terminal_live_session_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let registry_root = tmp.path().join("registry");
    write_registry_entry(&registry_root, "held-row", std::process::id(), "1");
    let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
    ledger
        .record_spawn(
            "held-row",
            "ws-1",
            "/proj/alpha",
            "c1",
            1_000,
            "held-row",
            None,
        )
        .unwrap();
    ledger.mark_closed("held-row").unwrap();
    let (sup, ledger, mut rx) = make_supervisor_for_ledger(ledger, Some(registry_root));

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_session",
        "session_id": "held-row",
    }))
    .unwrap();
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "trash_session_err");
    assert_eq!(response["reason"], "session_live_in_terminal");
    assert!(
        ledger.get("held-row").unwrap().is_some(),
        "refused trash must leave the row intact"
    );
}

#[tokio::test]
async fn trash_external_session_moves_jsonl_without_ledger_row() {
    let tmp = tempfile::tempdir().unwrap();
    let claude_root = tmp.path().join("projects");
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, _ledger, mut rx) = make_supervisor_for_ledger(ledger, None);
    let jsonl_path = seed_external_jsonl(&claude_root, "/proj/alpha", EXTERNAL_ID, "to trash");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_session",
        "session_id": EXTERNAL_ID,
        "project_dir": "/proj/alpha",
    }))
    .unwrap();
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();

    let response = drain_until_action(&mut rx, "trash_session_ok");
    assert_eq!(response["session_id"], EXTERNAL_ID);
    assert!(
        !jsonl_path.exists(),
        "JSONL must be moved out of the project dir"
    );
    let trash_root = claude_root
        .join(tugcore::claude_home::encode_project_dir("/proj/alpha"))
        .join(".tug-trash");
    assert!(trash_root.exists(), "JSONL must land in .tug-trash");

    // Second trash of the same id: nothing on disk, no row → not_found.
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();
    let response = drain_until_action(&mut rx, "trash_session_err");
    assert_eq!(response["reason"], "not_found");
}

#[tokio::test]
async fn trash_unledgered_session_without_project_dir_errors_cleanly() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = Arc::new(
        SessionLedger::open_with_claude_home(
            tmp.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(tmp.path()),
        )
        .unwrap(),
    );
    let (sup, _ledger, mut rx) = make_supervisor_for_ledger(ledger, None);
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_session",
        "session_id": "no-such-session",
    }))
    .unwrap();
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();
    let response = drain_until_action(&mut rx, "trash_session_err");
    assert_eq!(response["reason"], "not_found");
}

#[tokio::test]
async fn trash_session_drops_row_and_broadcasts_removed() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    ledger
        .record_spawn("s1", "ws-1", "/p", "c1", 1_000, "s1", None)
        .unwrap();
    ledger.mark_closed("s1").unwrap();
    // Drain whatever the seed wrote.
    while rx.try_recv().is_ok() {}

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_session",
        "session_id": "s1",
    }))
    .unwrap();
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();

    // session_updated push first, then trash_session_ok ack.
    let push = drain_until_action(&mut rx, "session_updated");
    assert_eq!(push["session_id"], "s1");
    assert_eq!(push["removed"], true);

    // The receiver was reset by drain_until_action consuming the push;
    // re-drain to find the ok frame.
    let ack = drain_until_action(&mut rx, "trash_session_ok");
    assert_eq!(ack["session_id"], "s1");
    assert!(ledger.get("s1").unwrap().is_none());
}

#[tokio::test]
async fn trash_session_on_live_row_returns_error() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();
    ledger
        .record_spawn("live1", "ws-1", "/p", "c1", 1_000, "live1", None)
        .unwrap();
    while rx.try_recv().is_ok() {}

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_session",
        "session_id": "live1",
    }))
    .unwrap();
    sup.handle_control("trash_session", &payload, 10)
        .await
        .expect_handled();

    let err = drain_until_action(&mut rx, "trash_session_err");
    assert_eq!(err["session_id"], "live1");
    assert_eq!(err["reason"], "session_is_live");
    assert!(ledger.get("live1").unwrap().is_some(), "row retained");
}

#[tokio::test]
async fn trash_project_dir_sessions_drops_matching_only() {
    let (sup, ledger, mut rx) = make_supervisor_with_ledger();

    ledger
        .record_spawn(
            "matched-1",
            "ws-1",
            "/proj/x",
            "c1",
            1_000,
            "matched-1",
            None,
        )
        .unwrap();
    ledger.mark_closed("matched-1").unwrap();
    ledger
        .record_spawn(
            "matched-2",
            "ws-1",
            "/proj/x",
            "c2",
            2_000,
            "matched-2",
            None,
        )
        .unwrap();
    ledger.mark_closed("matched-2").unwrap();
    // Different project_dir — survives.
    ledger
        .record_spawn("other", "ws-2", "/proj/y", "c3", 3_000, "other", None)
        .unwrap();
    ledger.mark_closed("other").unwrap();
    while rx.try_recv().is_ok() {}

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "trash_project_dir_sessions",
        "project_dir": "/proj/x",
    }))
    .unwrap();
    sup.handle_control("trash_project_dir_sessions", &payload, 10)
        .await
        .expect_handled();

    let ack = drain_until_action(&mut rx, "trash_project_dir_sessions_ok");
    assert_eq!(ack["project_dir"], "/proj/x");
    assert_eq!(ack["count"], 2);

    assert!(ledger.get("matched-1").unwrap().is_none());
    assert!(ledger.get("matched-2").unwrap().is_none());
    assert!(ledger.get("other").unwrap().is_some(), "/proj/y untouched");
}
