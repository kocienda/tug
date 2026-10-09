//! Tests for the arc family (`control/arc.rs`): the session↔arc binding and
//! the stop protocol.

use super::*;

// --- session↔arc binding (Spec S03/S04, [P05], [P08]) ----------------

fn git_in(dir: &std::path::Path, args: &[&str]) {
    let ok = tugcore::git_command()
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

/// A repo with one commit and one `tugarc/<name>` branch, plus the
/// creation id a bind would mint.
fn repo_with_arc(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git_in(&root, &["init", "-b", "main"]);
    git_in(&root, &["config", "user.name", "t"]);
    git_in(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git_in(&root, &["add", "-A"]);
    git_in(&root, &["commit", "-m", "base"]);
    git_in(&root, &["branch", &format!("tugarc/{name}")]);
    (dir, root)
}

/// Insert a live session row bound to nothing yet.
fn seed_live_session(
    ledger: &crate::session_ledger::SessionLedger,
    session_id: &str,
    card_id: &str,
    project_dir: &str,
) {
    ledger
        .record_spawn(
            session_id,
            project_dir,
            project_dir,
            card_id,
            crate::session_ledger::now_millis(),
            session_id,
            None,
        )
        .unwrap();
}

/// bind → the binding shows on the restore round-trip → unbind → nulls.
#[tokio::test]
async fn bind_arc_round_trips_through_the_card_bindings_listing() {
    let (_dir, root) = repo_with_arc("demo");
    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    let project = root.to_string_lossy().to_string();
    seed_live_session(&ledger, "sess-1", "card-1", &project);

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "bind_arc",
        "tug_session_id": "sess-1",
        "project_dir": project,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("bind_arc", &payload, 1).await;

    let arc_id = ledger.get("sess-1").unwrap().unwrap().arc_id.unwrap();
    assert!(
        arc_id.starts_with("tugarc/demo#"),
        "bind is a write path, so it mints the id: {arc_id}"
    );
    while control_rx.try_recv().is_ok() {}

    // The restore round-trip carries the pair.
    sup.do_list_card_bindings().await;
    let body = next_action(&mut control_rx, "list_card_bindings_ok").await;
    assert_eq!(body["bindings"][0]["arc_id"], arc_id);
    assert_eq!(body["bindings"][0]["arc_name"], "demo");

    // Unbind nulls them.
    let payload = serde_json::to_vec(&serde_json::json!({"tug_session_id": "sess-1"})).unwrap();
    sup.handle_control("unbind_arc", &payload, 1).await;
    sup.do_list_card_bindings().await;
    let body = next_action(&mut control_rx, "list_card_bindings_ok").await;
    assert!(body["bindings"][0]["arc_id"].is_null());
    assert!(body["bindings"][0]["arc_name"].is_null());
}

/// The door prompt's token parse: exactly the door's two spellings, then
/// a well-formed arc name, and nothing else reads as a door — the retired
/// `/arc-plan` included.
#[test]
fn arc_door_target_reads_exactly_the_two_spellings_of_the_door() {
    for door in ["/arc", "/tugplug:arc"] {
        assert_eq!(
            super::arc_door_target(&format!("{door} demo-arc2")),
            Some("demo-arc2"),
            "{door}"
        );
        assert_eq!(
            super::arc_door_target(&format!("  {door}   demo  \n")),
            Some("demo"),
            "{door} with stray whitespace"
        );
    }
    // Not a door.
    for text in [
        "/arc-plan demo-arc2",
        "/tugplug:arc-plan demo",
        "/arc-join demo",
        "/arc-bind demo",
        "/tugplug:draft demo",
        "/commit",
        "arc demo",
        "please /arc demo",
        "",
    ] {
        assert_eq!(super::arc_door_target(text), None, "{text:?}");
    }
    // A door with no name, with a name that is not one, or with an idea
    // whose first word merely looks like one.
    for text in [
        "/arc",
        "/arc make the ring pulse",
        "/arc demo sharpen this",
        "/arc a",
        "/arc demo_arc",
        "/arc Demo",
        "/arc status",
        "/arc --plan",
    ] {
        assert_eq!(super::arc_door_target(text), None, "{text:?}");
    }
}

/// **[B02]'s second step.** A door prompt binds the session at submit
/// time, through the intercept that already writes `turn_active`; an
/// ordinary prompt binds nothing.
#[tokio::test]
async fn a_door_prompt_binds_the_session_at_submit_time() {
    let (_dir, root) = repo_with_arc("demo");
    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    let project = root.to_string_lossy().to_string();
    seed_live_session(&ledger, "sess-1", "card-1", &project);
    let tug_id = TugSessionId::new("sess-1");
    let entry = insert_ledger_entry(&sup, &tug_id).await;
    entry.lock().await.project_dir = root.clone();

    let prompt = |text: &str| {
        let body = serde_json::json!({
            "tug_session_id": "sess-1",
            "type": "user_message",
            "text": text,
        });
        Frame::new(FeedId::CODE_INPUT, serde_json::to_vec(&body).unwrap())
    };

    sup.dispatch_one(prompt("/tugplug:draft demo")).await;
    assert!(
        ledger.get("sess-1").unwrap().unwrap().arc_id.is_none(),
        "an ordinary prompt binds nothing"
    );
    while control_rx.try_recv().is_ok() {}

    sup.dispatch_one(prompt("/arc demo")).await;
    let row = ledger.get("sess-1").unwrap().unwrap();
    assert!(
        row.arc_id
            .as_deref()
            .unwrap_or("")
            .starts_with("tugarc/demo#"),
        "the door prompt bound the session with the keystroke: {:?}",
        row.arc_id
    );
    assert_eq!(row.arc_name.as_deref(), Some("demo"));
    let body = next_action(&mut control_rx, "bind_arc_ok").await;
    assert_eq!(body["tug_session_id"], "sess-1");
    assert_eq!(body["arc_name"], "demo");
    assert!(
        root.join(".tug/arcs/demo").is_dir(),
        "the bind minted the directory the aggregate lists"
    );
}

/// A binding whose arc branch is gone reads as unbound even when nothing
/// swept the row — the lazy half of [P05], which is what keeps reads
/// correct after a terminal join tugcast never saw.
#[tokio::test]
async fn a_binding_to_a_deleted_arc_reads_as_unbound() {
    let (_dir, root) = repo_with_arc("demo");
    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    let project = root.to_string_lossy().to_string();
    seed_live_session(&ledger, "sess-1", "card-1", &project);
    ledger
        .set_arc_binding("sess-1", Some(("tugarc/demo#1-abc", "demo")))
        .unwrap();

    git_in(&root, &["branch", "-D", "tugarc/demo"]);

    sup.do_list_card_bindings().await;
    let body = next_action(&mut control_rx, "list_card_bindings_ok").await;
    assert!(
        body["bindings"][0]["arc_id"].is_null(),
        "an arc that no longer exists is not a mating"
    );
}

/// **The [L27] pin.** Closing a session returns the acquisition its bind
/// made, so an arc whose cards have all closed reports zero mated sessions
/// and reads as *unbound* ([P08]).
#[test]
fn closing_a_bound_session_releases_its_binding() {
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    for (session, card) in [("sess-1", "card-1"), ("sess-2", "card-2")] {
        seed_live_session(&ledger, session, card, "/proj");
        ledger
            .set_arc_binding(session, Some(("tugarc/demo#1-abc", "demo")))
            .unwrap();
    }

    ledger.mark_closed("sess-1").unwrap();
    assert!(ledger.get("sess-1").unwrap().unwrap().arc_id.is_none());
    assert_eq!(
        ledger.get("sess-2").unwrap().unwrap().arc_id.as_deref(),
        Some("tugarc/demo#1-abc"),
        "the other session's binding is untouched"
    );

    ledger.mark_closed("sess-2").unwrap();
    assert!(
        ledger.get("sess-2").unwrap().unwrap().arc_id.is_none(),
        "with every card closed the arc is unbound, not still mated"
    );
}

/// **The [L29] pin.** `/api/arc` resolves `project_dir` through the
/// gateway, so a non-canonical spelling reaches the same session row as
/// the canonical one — the CLI never canonicalizes.
#[cfg(unix)]
#[tokio::test]
async fn api_arc_bind_resolves_a_non_canonical_project_spelling() {
    let (_dir, root) = repo_with_arc("demo");
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    seed_live_session(&ledger, "sess-1", "card-1", &root.to_string_lossy());

    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("linked-repo");
    std::os::unix::fs::symlink(&root, &link).unwrap();

    let canonical = crate::path_resolver::resolve_to_claude_form(&link);
    let outcome = crate::arc_api::bind(&ledger, &canonical, "sess-1", "demo");
    assert!(matches!(
        outcome,
        crate::arc_api::ArcApiOutcome::Bound { .. }
    ));

    let arc_id = ledger.get("sess-1").unwrap().unwrap().arc_id.unwrap();
    // The id was minted in the *real* repo, reachable through the link.
    assert_eq!(
        tugarc_core::ops::arc_owner_key(&root, "demo"),
        arc_id,
        "the symlink spelling resolved to the same repo the canonical one names"
    );
}

/// A session may only bind an arc in its **own** project ([D147]).
///
/// The Arcs card's Bind control has always said this to the user ("This arc
/// belongs to …") and the server took it on trust — so any short-lived CLI
/// process on the machine could rebind a live session to an arc in a
/// directory that session had never seen. It happened: an app-test's
/// `arc bind` walked the instance registry, found the developer's live
/// Tug, and mated their session to a scratch arc in a temp dir, which
/// then evaporated with the fixture and left the masthead blank.
#[test]
fn api_arc_bind_refuses_a_arc_in_another_project() {
    let (_dir, root) = repo_with_arc("demo");
    let (_elsewhere_dir, elsewhere) = repo_with_arc("stranger");
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    seed_live_session(&ledger, "sess-1", "card-1", &root.to_string_lossy());

    let refused = crate::arc_api::bind(&ledger, &elsewhere, "sess-1", "stranger");
    match refused {
        crate::arc_api::ArcApiOutcome::Error(message) => assert!(
            message.contains("cannot bind"),
            "the refusal names what it refused: {message}"
        ),
        _ => panic!("a cross-project bind must be refused, not written"),
    }
    assert!(
        ledger.get("sess-1").unwrap().unwrap().arc_id.is_none(),
        "and it left the session's own binding alone"
    );

    // The same session's own project still binds, so the guard costs the
    // ordinary path nothing.
    assert!(matches!(
        crate::arc_api::bind(&ledger, &root, "sess-1", "demo"),
        crate::arc_api::ArcApiOutcome::Bound { .. }
    ));
}

/// A bind for a session this instance's ledger does not hold answers
/// `unknown_session`, so the CLI's try-each-instance loop continues
/// silently ([P04]).
#[test]
fn api_arc_bind_for_a_foreign_session_reports_unknown_session() {
    let (_dir, root) = repo_with_arc("demo");
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    assert!(matches!(
        crate::arc_api::bind(&ledger, &root, "not-mine", "demo"),
        crate::arc_api::ArcApiOutcome::UnknownSession
    ));
    assert!(matches!(
        crate::arc_api::unbind(&ledger, "not-mine"),
        crate::arc_api::ArcApiOutcome::UnknownSession
    ));
}

/// `arc_gone` sweeps the bindings and the id-keyed draft, and reports how
/// many bindings it cleared.
#[test]
fn api_arc_gone_clears_bindings_and_the_draft_and_counts_them() {
    let (_dir, root) = repo_with_arc("demo");
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    let project = root.to_string_lossy().to_string();
    let owner_key = "tugarc/demo#1-abc";
    for (session, card) in [("sess-1", "card-1"), ("sess-2", "card-2")] {
        seed_live_session(&ledger, session, card, &project);
        ledger
            .set_arc_binding(session, Some((owner_key, "demo")))
            .unwrap();
    }
    ledger
        .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
            owner_kind: "arc".to_string(),
            owner_id: owner_key.to_string(),
            project_dir: crate::path_resolver::CanonicalPath::from_raw(&root)
                .as_str()
                .to_string(),
            fingerprint: "fp".to_string(),
            message: "Land it".to_string(),
            updated_at: 1,
            edited: true,
            selection: None,
        })
        .unwrap();

    let outcome = crate::arc_api::arc_gone(&ledger, &root, owner_key);
    assert!(matches!(
        outcome,
        crate::arc_api::ArcApiOutcome::Cleared { cleared: 2, .. }
    ));
    assert!(ledger.get("sess-1").unwrap().unwrap().arc_id.is_none());
    assert!(ledger.get("sess-2").unwrap().unwrap().arc_id.is_none());
    assert!(
        ledger
            .changeset_draft(
                "arc",
                owner_key,
                crate::path_resolver::CanonicalPath::from_raw(&root).as_str()
            )
            .unwrap()
            .is_none()
    );
}

/// **The [L23] pin.** A join resolves the arc's owner key *before* the
/// teardown and sweeps with it, so the user's authored draft and every
/// binding row are gone once the branch — and with it the `tugid` in its
/// config — no longer exists (Risk R02).
///
/// The ordering is the whole mitigation. Resolve the key after
/// `join_in` returns and `arc_owner_key` can only answer with the legacy
/// form, which matches neither row; the assertions below would then fail
/// on rows nothing left in the system is able to name.
#[tokio::test]
async fn joining_a_arc_sweeps_its_draft_and_bindings_after_the_branch_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git_in(&root, &["init", "-b", "main"]);
    git_in(&root, &["config", "user.name", "t"]);
    git_in(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git_in(&root, &["add", "-A"]);
    git_in(&root, &["commit", "-m", "base"]);

    // A real arc, with a round, so the join has something to land.
    let worktree = root.join(".tug/worktrees/demo");
    git_in(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugarc/demo",
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::write(worktree.join("b.txt"), "work\n").unwrap();
    git_in(&worktree, &["add", "-A"]);
    git_in(&worktree, &["commit", "-m", "round"]);
    let owner_key = tugarc_core::ops::ensure_arc_id(&root, "demo").unwrap();
    assert!(owner_key.contains('#'), "id-qualified: {owner_key}");

    let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    let project = root.to_string_lossy().to_string();
    seed_live_session(&ledger, "sess-1", "card-1", &project);
    ledger
        .set_arc_binding("sess-1", Some((&owner_key, "demo")))
        .unwrap();
    let draft_project = crate::path_resolver::CanonicalPath::from_raw(&root)
        .as_str()
        .to_string();
    ledger
        .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
            owner_kind: "arc".to_string(),
            owner_id: owner_key.clone(),
            project_dir: draft_project.clone(),
            fingerprint: "fp".to_string(),
            message: "Land the demo work".to_string(),
            updated_at: 1,
            edited: true,
            selection: None,
        })
        .unwrap();

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": project,
        "arc": "demo",
        // The subject is the teardown's sweep, not the verification gate.
    }))
    .unwrap();
    sup.handle_control("changeset_join", &payload, 1).await;

    // The teardown really happened — the branch and its config are gone,
    // so nothing could re-derive the key from here.
    assert_eq!(
        tugarc_core::ops::arc_owner_key(&root, "demo"),
        "tugarc/demo",
        "the branch config died with the branch"
    );
    assert!(
        ledger
            .changeset_draft("arc", &owner_key, &draft_project)
            .unwrap()
            .is_none(),
        "the id-keyed draft was swept with the key captured before teardown"
    );
    assert!(
        ledger.get("sess-1").unwrap().unwrap().arc_id.is_none(),
        "the binding to the landed arc was released"
    );
}

/// A join is a commit made through Tug, so it records a `commit` fact
/// exactly as `/commit` does — under the initiating session, carrying the
/// landed sha and the base branch. That fact is the whole of what a fact
/// reader sees, so one that saw one landing gesture and not the other
/// would be watching half of them.
#[tokio::test]
async fn joining_an_arc_records_the_landed_commit_as_a_fact() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git_in(&root, &["init", "-b", "main"]);
    git_in(&root, &["config", "user.name", "t"]);
    git_in(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git_in(&root, &["add", "-A"]);
    git_in(&root, &["commit", "-m", "base"]);
    let worktree = root.join(".tug/worktrees/demo");
    git_in(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugarc/demo",
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::write(worktree.join("b.txt"), "work\n").unwrap();
    git_in(&worktree, &["add", "-A"]);
    git_in(&worktree, &["commit", "-m", "round"]);
    tugarc_core::ops::ensure_arc_id(&root, "demo").unwrap();

    let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    let project = root.to_string_lossy().to_string();
    seed_live_session(&ledger, "sess-1", "card-1", &project);
    assert!(
        ledger
            .list_facts_for_session_since("sess-1", Some("commit"), None, 10)
            .unwrap()
            .is_empty(),
        "nothing has been committed through this session yet"
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": project,
        "arc": "demo",
        "session_id": "sess-1",
    }))
    .unwrap();
    sup.handle_control("changeset_join", &payload, 1).await;

    let landed = tugcore::git_command()
        .args(["-C", &project, "rev-parse", "main"])
        .output()
        .unwrap();
    let landed = String::from_utf8_lossy(&landed.stdout).trim().to_string();
    let facts = ledger
        .list_facts_for_session_since("sess-1", Some("commit"), None, 10)
        .unwrap();
    assert_eq!(facts.len(), 1, "one landing, one commit fact: {facts:?}");
    let payload: serde_json::Value = serde_json::from_str(&facts[0].payload).unwrap();
    assert_eq!(
        payload["sha"], landed,
        "the fact names the commit the join landed"
    );
    assert_eq!(payload["branch"], "main", "and the base it landed on");
    assert_eq!(
        payload["files"],
        serde_json::json!(["b.txt"]),
        "a squash join's file list is the landing's own"
    );
}

#[tokio::test]
async fn releasing_or_joining_a_arc_clears_its_draft() {
    let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
    let seed = |owner_id: &str| {
        ledger
            .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
                owner_kind: "arc".to_string(),
                owner_id: owner_id.to_string(),
                project_dir: "/proj".to_string(),
                fingerprint: "fp".to_string(),
                message: "Join the snippets work".to_string(),
                updated_at: 1,
                edited: true,
                selection: None,
            })
            .unwrap();
    };
    // One row under each key: the id-qualified one this build writes, and
    // the bare branch ref an older build left behind ([P03]).
    seed("tugarc/snippets");
    seed("tugarc/snippets#1723500000000-a1b2c3");

    AgentSupervisor::clear_arc_draft(&ledger, "/proj", "tugarc/snippets#1723500000000-a1b2c3");

    // A same-named future arc starts with no inherited draft ([P14]) —
    // under either key, or the haunting comes back in a form no
    // `draft clear` can reach.
    for key in ["tugarc/snippets", "tugarc/snippets#1723500000000-a1b2c3"] {
        assert!(
            ledger
                .changeset_draft("arc", key, "/proj")
                .unwrap()
                .is_none(),
            "row under {key} survived the landing"
        );
    }
}

#[tokio::test]
async fn test_spawn_session_writes_pending() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let frame = state_rx.try_recv().unwrap();
    let (id, state) = session_state_of(&frame);
    assert_eq!(id, "sess-1");
    assert_eq!(state, "pending");
}

#[tokio::test]
async fn test_spawn_session_inserts_into_client_sessions() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 10)
        .await
        .expect_handled();

    let cs = sup.client_sessions.lock().await;
    let set = cs.get(&10).expect("client 10 has a session set");
    assert!(set.contains(&TugSessionId::new("sess-1")));
}

/// A headless spawn is a whole session — ledger entry, workspace
/// refcount, spawn claim — carrying the owner's card id, and no client
/// holds it, because no client asked.
#[tokio::test]
async fn a_headless_spawn_is_held_by_its_owner_and_by_no_client() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let session = sup
        .spawn_headless_session(
            "tugedit",
            Path::new(test_project_dir()),
            Some("acceptEdits".to_string()),
            Some("background".to_string()),
        )
        .await
        .expect("headless spawn succeeds");

    let entry_arc = {
        let ledger = sup.ledger.lock().await;
        ledger
            .get(&session)
            .cloned()
            .expect("ledger holds the entry")
    };
    let entry = entry_arc.lock().await;
    assert_eq!(entry.card_id.as_deref(), Some("background:tugedit"));
    assert_eq!(entry.session_mode, SessionMode::New);
    assert_eq!(entry.permission_mode.as_deref(), Some("acceptEdits"));
    assert_eq!(entry.tag.as_deref(), Some("background"));
    assert!(entry.line_id.is_some(), "a headless session mints its line");
    assert!(entry.holds_workspace_refcount);
    drop(entry);

    let cs = sup.client_sessions.lock().await;
    assert!(
        cs.values().all(|set| !set.contains(&session)),
        "no client connection may hold a headless session"
    );
    drop(cs);

    let frame = state_rx.try_recv().expect("pending state published");
    let (id, state) = session_state_of(&frame);
    assert_eq!(id, session.as_str());
    assert_eq!(state, "pending");
}

/// Closing a headless session gives the workspace back. The refcount the
/// spawn acquired is the entry's alone, so the last close tears the
/// workspace down rather than leaving it open with nobody in it.
#[tokio::test]
async fn closing_a_headless_session_gives_the_workspace_back() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    let project_dir = Path::new(test_project_dir());

    let session = sup
        .spawn_headless_session("tugedit", project_dir, None, None)
        .await
        .expect("headless spawn succeeds");
    assert!(sup.registry.find_entry_by_path(project_dir).is_some());

    sup.close_headless_session("tugedit", &session).await;

    assert!(
        sup.ledger.lock().await.get(&session).is_none(),
        "the close removes the ledger entry"
    );
    assert!(
        sup.registry.find_entry_by_path(project_dir).is_none(),
        "the last refcount released tears the workspace down"
    );
}

/// Records the `--permission-mode` every spawn is handed, then stalls the
/// way `StallSpawner` does — the test reads the modes off the channel
/// because the spawn happens in a detached bridge task.
struct RecordingSpawner {
    modes: mpsc::UnboundedSender<Option<String>>,
}

impl ChildSpawner for RecordingSpawner {
    fn spawn_child(
        &self,
        _project_dir: &std::path::Path,
        _session_id: &str,
        _session_mode: SessionMode,
        _resume_claude_session_id: Option<&str>,
        permission_mode: Option<&str>,
        _relocate_from: Option<&crate::feeds::agent_bridge::RelocateOrigin>,
    ) -> SpawnFuture {
        let _ = self.modes.send(permission_mode.map(str::to_string));
        Box::pin(async { pending::<std::io::Result<SessionChild>>().await })
    }
}

/// The spawn is a detached task, so the mode arrives on the channel rather
/// than with the call that caused it.
async fn next_spawned_mode(rx: &mut mpsc::UnboundedReceiver<Option<String>>) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("a spawn reached the spawner within 5s")
        .expect("the spawner channel is open")
}

fn permission_mode_frame(tug_session_id: &str, mode: &str) -> Frame {
    Frame::new(
        FeedId::CODE_INPUT,
        serde_json::to_vec(&serde_json::json!({
            "tug_session_id": tug_session_id,
            "type": "permission_mode",
            "mode": mode,
        }))
        .unwrap(),
    )
}

/// The mode the user switched to mid-flight is the mode the next spawn
/// gets. Every respawn — a wheel rotation, an arc Resume, a crash-loop
/// respawn — reads `entry.permission_mode` and hands it to the child as
/// `--permission-mode`, so a live `permission_mode` frame has to move it;
/// otherwise the respawn silently undoes a direct action the user took.
#[tokio::test]
async fn a_live_permission_mode_change_is_the_mode_the_respawn_spawns_with() {
    let (tx, mut spawned_modes) = mpsc::unbounded_channel::<Option<String>>();
    let factory: SpawnerFactory =
        Arc::new(move || Arc::new(RecordingSpawner { modes: tx.clone() }) as Arc<dyn ChildSpawner>);
    let ((sup, _state_rx, _meta_rx, _control_rx), mut register_rx) =
        make_supervisor_with_spawner(factory);
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "spawn_session",
        "card_id": "card-1",
        "tug_session_id": "sess-1",
        "project_dir": test_project_dir(),
        "line_id": "line-sess-1",
        "permission_mode": "auto",
    }))
    .unwrap();
    sup.handle_control("spawn_session", &payload, 10)
        .await
        .expect_handled();

    assert_eq!(
        next_spawned_mode(&mut spawned_modes).await.as_deref(),
        Some("auto"),
        "the birth spawn carries the mode the deck asked for",
    );

    // The chip's switch, as the deck sends it: a live frame, which reaches
    // the running tugcode.
    sup.dispatch_one(permission_mode_frame("sess-1", "bypassPermissions"))
        .await;

    // The respawn a rotation or an arc Resume takes. (A crash-loop respawn
    // never leaves the bridge; it is covered by
    // `a_crash_loop_respawn_carries_the_mode_the_session_is_in`.)
    sup.spawn_session_worker(&TugSessionId::new("sess-1")).await;

    assert_eq!(
        next_spawned_mode(&mut spawned_modes).await.as_deref(),
        Some("bypassPermissions"),
        "the respawn carries the mode the session is in, not the one it was born in",
    );
}

/// The id a headless session ran under is an ordinary session id
/// afterwards: a card can resume it, and the supervisor arbitrates that
/// resume against nothing, because a headless session was never in any
/// client's set to begin with.
#[tokio::test]
async fn a_card_can_adopt_a_headless_sessions_id_afterwards() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    let session = sup
        .spawn_headless_session("tugedit", Path::new(test_project_dir()), None, None)
        .await
        .expect("headless spawn succeeds");
    sup.close_headless_session("tugedit", &session).await;

    sup.handle_control(
        "spawn_session",
        &resume_payload("card-1", session.as_str()),
        10,
    )
    .await
    .expect_handled();

    let entry_arc = {
        let ledger = sup.ledger.lock().await;
        ledger.get(&session).cloned().expect("the card's entry")
    };
    assert_eq!(
        entry_arc.lock().await.card_id.as_deref(),
        Some("card-1"),
        "the card now holds the session the background owner opened"
    );
    let cs = sup.client_sessions.lock().await;
    assert!(cs.get(&10).expect("client 10's set").contains(&session));
}

/// A `resume` payload for a session already bound to a different
/// card must be rejected with `session_live_elsewhere` and a
/// `SESSION_STATE = errored` broadcast, while same-card reconnects
/// (the WS-drop-and-reconnect path) still succeed.
#[tokio::test]
async fn test_spawn_session_rejects_resume_when_live_on_other_card() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    // First spawn binds sess-1 to card-A. Eager spawn publishes
    // `pending` then `spawning`; drain both so the rejection
    // assertion isolates the `errored` frame.
    sup.handle_control("spawn_session", &spawn_payload("card-A", "sess-1"), 10)
        .await
        .expect_handled();
    while state_rx.try_recv().is_ok() {}

    // Second spawn from card-B with mode=resume on the same session
    // id must be rejected, with an `errored{session_live_elsewhere}`
    // SESSION_STATE broadcast.
    let err = sup
        .handle_control("spawn_session", &resume_payload("card-B", "sess-1"), 11)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "session_live_elsewhere"
        }
    );
    let frame = state_rx.try_recv().expect("errored state for rejection");
    let (id, state) = session_state_of(&frame);
    assert_eq!(id, "sess-1");
    assert_eq!(state, "errored");

    // card-B's per-client affinity must NOT carry sess-1 (the
    // rejection rolled back the insert). card-A's still does.
    {
        let cs = sup.client_sessions.lock().await;
        assert!(cs.get(&11).is_none_or(|s| s.is_empty()));
        assert!(cs.get(&10).unwrap().contains(&TugSessionId::new("sess-1")));
    }

    // Same-card reconnect (card-A again) must still succeed — Phase
    // B's WS-drop-then-reconnect contract requires this.
    sup.handle_control("spawn_session", &resume_payload("card-A", "sess-1"), 10)
        .await
        .expect_handled_with("same-card reconnect must succeed");
}

/// A `resume` from a different card must SUCCEED when the recorded
/// holder card has no live client connection — the
/// `rebind_from_ledger` case. After a tugcast restart the entry is
/// `Idle` carrying its old `card_id`, but `client_sessions` is
/// empty for it; a new card is free to adopt the session.
#[tokio::test]
async fn test_spawn_session_allows_resume_when_recorded_card_has_no_live_client() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    // Simulate a rebound-from-ledger entry: present in the ledger,
    // `Idle`, carrying a recorded `card_id`, but with NO
    // `client_sessions` row (rebind does not populate it).
    let tug_id = TugSessionId::new("sess-1");
    let entry_arc = insert_ledger_entry(&sup, &tug_id).await;
    {
        let mut e = entry_arc.lock().await;
        e.spawn_state = SpawnState::Idle;
        e.card_id = Some("card-old".to_string());
    }

    // A different card resumes it. No other live client holds the
    // session, so the resume is allowed and the binding moves.
    sup.handle_control("spawn_session", &resume_payload("card-new", "sess-1"), 20)
        .await
        .expect_handled_with("resume of an orphaned (rebound-from-ledger) session must succeed");

    let entry = entry_arc.lock().await;
    assert_eq!(
        entry.card_id.as_deref(),
        Some("card-new"),
        "the resuming card adopts the session binding",
    );
}

/// A `resume` from a different card on the SAME live client
/// connection is still rejected — the session is genuinely held
/// (the client's `client_sessions` row carries it), so a second
/// card on that connection cannot steal it.
#[tokio::test]
async fn test_spawn_session_rejects_resume_same_client_other_card() {
    let (sup, mut state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();

    // client 10 binds sess-1 to card-A.
    sup.handle_control("spawn_session", &spawn_payload("card-A", "sess-1"), 10)
        .await
        .expect_handled();
    while state_rx.try_recv().is_ok() {}

    // Same client 10 tries to resume sess-1 on card-B. The session
    // is still live on this very connection → rejected.
    let err = sup
        .handle_control("spawn_session", &resume_payload("card-B", "sess-1"), 10)
        .await
        .expect_error();
    assert_eq!(
        err,
        ControlError::CapExceeded {
            reason: "session_live_elsewhere"
        }
    );
}

#[tokio::test]
async fn test_spawn_session_replays_latest_metadata_for_known_session() {
    let (sup, _state_rx, mut meta_rx, _control_rx) = make_supervisor_with_store();

    // Pre-populate a ledger entry with latest_metadata (simulates reconnect
    // after a previous session had produced a system_metadata frame).
    let tug_id = TugSessionId::new("sess-1");
    let entry = insert_ledger_entry(&sup, &tug_id).await;
    let original = fake_metadata_frame("sess-1");
    {
        let mut e = entry.lock().await;
        e.latest_metadata = Some(original.clone());
    }

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 99)
        .await
        .expect_handled();

    // The broadcast subscriber must receive exactly one metadata frame.
    let received = meta_rx.try_recv().expect("replay frame present");
    assert_eq!(received, original);
    assert!(
        meta_rx.try_recv().is_err(),
        "only a single replay frame is emitted"
    );
}

#[tokio::test]
async fn test_spawn_session_with_no_prior_metadata_fires_no_replay() {
    let (sup, _state_rx, mut meta_rx, _control_rx) = make_supervisor_with_store();

    sup.handle_control("spawn_session", &spawn_payload("card-1", "sess-1"), 7)
        .await
        .expect_handled();

    assert!(
        meta_rx.try_recv().is_err(),
        "no replay should fire for a brand-new session"
    );
}

/// A live card seated on a running arc, with the frames it is sent
/// observable: the shape every stop test below asks a question of.
///
/// Returns the supervisor, the arc log's project root, the entry, the
/// session's `input_rx`, and the merger registration the caller must hold
/// — dropping it would close a channel under a live supervisor, which is
/// not the state any of these tests is about.
async fn stop_harness(
    root: &std::path::Path,
    attach_wheel: bool,
) -> (
    Arc<AgentSupervisor>,
    Arc<Mutex<LedgerEntry>>,
    mpsc::Receiver<Frame>,
    mpsc::Receiver<MergerRegistration>,
) {
    std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
    std::fs::write(root.join(".tug/arcs/demo/brief.md"), "# A brief\n").unwrap();
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(
        root.join(".tugtool/config.toml"),
        "[tugtool.arc]\nidle_settle_secs = 0\n",
    )
    .unwrap();
    tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
    tugarc_core::arc::append_arc_stage(
        root,
        "demo",
        tugarc_core::ArcStage::Implement,
        "claude-1",
        None,
    )
    .unwrap();

    let (sup, ledger, register_rx) = test_minimal_supervisor_reading_its_ledger();
    ledger
        .record_spawn(
            "claude-1",
            "ws-test",
            &root.to_string_lossy(),
            "card-1",
            1_000,
            "claude-1",
            None,
        )
        .unwrap();
    ledger
        .set_arc_binding("claude-1", Some(("tugarc/demo#1", "demo")))
        .unwrap();
    if attach_wheel {
        let _ = sup.wheel.set(Arc::new(crate::wheel::WheelState::default()));
    }

    let id = TugSessionId::new("claude-1".to_string());
    let input_rx = install_live_session_for_tests(
        &sup,
        &id,
        WorkspaceKey::from_test_str("ws-test"),
        root.to_path_buf(),
    )
    .await;
    let entry = sup.ledger.lock().await.get(&id).cloned().expect("entry");
    (sup, entry, input_rx, register_rx)
}

/// Stand in for the tugcode a stop is waiting on: after a beat, answer
/// the teardown verb the way the real one does ([P12]).
///
/// Without it every stop taken over a running turn waits out its whole
/// ceiling, because nothing in a test ever makes a session quiet — the
/// frames that would are the ones a live claude sends.
fn answer_the_teardown(sup: &Arc<AgentSupervisor>, card: &'static str) {
    let sup = Arc::clone(sup);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        sup.apply_stop_all_work_done(&TugSessionId::new(card.to_owned()))
            .await;
    });
}

/// The frames a session was sent, by `type`, drained without blocking.
fn frame_types(input_rx: &mut mpsc::Receiver<Frame>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(frame) = input_rx.try_recv() {
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        out.push(parsed["type"].as_str().unwrap_or("?").to_string());
    }
    out
}

/// **Stop is a button, not a request** ([B06]). A stop over a running turn
/// interrupts it first, so the work ends now rather than at the end of a
/// turn that may have minutes left in it — and the hand-back follows on
/// the same ordered channel.
#[tokio::test]
async fn a_stop_on_a_busy_session_interrupts_then_hands_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = true;
    answer_the_teardown(&sup, "claude-1");

    sup.stop_arc_now(
        "claude-1",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
            question: None,
            halt: true,
        },
    )
    .await
    .expect("the stop lands");

    assert_eq!(
        frame_types(&mut input_rx),
        vec![
            "interrupt".to_string(),
            "stop_all_work".to_string(),
            "model_change".to_string()
        ],
        "the interrupt goes first, the teardown follows it, and the \
             hand-back comes last",
    );
    assert_eq!(
        tugarc_core::arc::read_arc(root, "demo").unwrap().stopped,
        Some((
            tugarc_core::ArcStage::Implement,
            "stopped by user".to_string()
        )),
    );
}

/// And an idle session is interrupted by nothing: there is no turn to end,
/// and a frame sent to say so would be one the card has to answer.
#[tokio::test]
async fn a_stop_on_an_idle_session_sends_no_interrupt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = false;

    sup.stop_arc_now(
        "claude-1",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
            question: None,
            halt: true,
        },
    )
    .await
    .expect("the stop lands");

    assert_eq!(
        frame_types(&mut input_rx),
        vec!["stop_all_work".to_string(), "model_change".to_string()],
        "no turn to end, but the rest of the work still ends",
    );
}

/// **An `arc ask` never interrupts** ([P03]). A stage stopping over a
/// question is mid-sentence, and the sentence is the whole of what the
/// receipt has to carry.
#[tokio::test]
async fn an_ask_never_interrupts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = true;
    answer_the_teardown(&sup, "claude-1");

    sup.stop_arc_now(
        "claude-1",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::NeedsDecision,
            question: Some("which of the two?"),
            halt: false,
        },
    )
    .await
    .expect("the stop lands");

    assert_eq!(
        frame_types(&mut input_rx),
        vec!["stop_all_work".to_string(), "model_change".to_string()],
        "a turn ending on its own question is not cut short",
    );
    let record = tugarc_core::arc::read_arc(root, "demo").unwrap();
    assert!(
        record
            .notes
            .iter()
            .any(|note| note.contains("which of the two?")),
        "and the question is on the record before the stop: {:?}",
        record.notes,
    );
}

/// **A stop that did not happen answers `_err`** ([L31]). With no wheel
/// there is nowhere for the hand-back or the receipt to go, so nothing is
/// stopped and nothing is recorded — and a green button over an arc still
/// running is the exact fault this control exists to remove.
#[tokio::test]
async fn a_stop_with_no_wheel_answers_err_not_ok() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, _entry, mut input_rx, _register_rx) = stop_harness(root, false).await;
    let mut control_rx = sup.control_tx.subscribe();

    assert_eq!(
        sup.stop_arc_now(
            "claude-1",
            root,
            "demo",
            StopTerms {
                stage: tugarc_core::ArcStage::Implement,
                reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
                question: None,
                halt: true,
            },
        )
        .await,
        Err("no_wheel"),
    );
    assert!(frame_types(&mut input_rx).is_empty());
    assert!(
        tugarc_core::arc::read_arc(root, "demo")
            .unwrap()
            .stopped
            .is_none(),
        "no `arc-stop` line was appended",
    );

    sup.do_arc_stop(&BindArcPayload {
        tug_session_id: "claude-1".to_string(),
        project_dir: root.to_string_lossy().to_string(),
        arc: "demo".to_string(),
    })
    .await;
    let mut answers = Vec::new();
    while let Ok(frame) = control_rx.try_recv() {
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        if let Some(action) = parsed["action"].as_str() {
            answers.push((
                action.to_string(),
                parsed["reason"].as_str().map(str::to_owned),
            ));
        }
    }
    assert!(
        answers
            .iter()
            .any(|(action, reason)| action == "arc_stop_err"
                && reason.as_deref() == Some("no_wheel")),
        "the press is answered with the refusal, never a green `_ok`: {answers:?}",
    );
    assert!(
        !answers.iter().any(|(action, _)| action == "arc_stop_ok"),
        "{answers:?}",
    );
}

/// The [`stop_harness`] after a rotation: the card is `card-A`, the
/// stage's live segment is `segment-B`, and the arc line is bound to the
/// segment — which is what `arc_api::arc_stop` resolves a press to, and
/// an id no supervisor entry is keyed by ([P01]).
async fn rotated_stop_harness(
    root: &std::path::Path,
    attach_wheel: bool,
) -> (
    Arc<AgentSupervisor>,
    Arc<Mutex<LedgerEntry>>,
    mpsc::Receiver<Frame>,
    mpsc::Receiver<MergerRegistration>,
) {
    std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
    std::fs::write(root.join(".tug/arcs/demo/brief.md"), "# A brief\n").unwrap();
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(
        root.join(".tugtool/config.toml"),
        "[tugtool.arc]\nidle_settle_secs = 0\n",
    )
    .unwrap();
    tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
    tugarc_core::arc::append_arc_stage(
        root,
        "demo",
        tugarc_core::ArcStage::Implement,
        "segment-B",
        None,
    )
    .unwrap();

    let (sup, ledger, register_rx) = test_minimal_supervisor_reading_its_ledger();
    // One line, two segments: the card's own row first, the rotation's
    // later, so `live_segment_of("card-A")` is `segment-B`.
    for (id, now) in [("card-A", 1_000), ("segment-B", 2_000)] {
        ledger
            .record_spawn(
                id,
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                now,
                "line-1",
                None,
            )
            .unwrap();
    }
    ledger
        .set_arc_binding("segment-B", Some(("tugarc/demo#1", "demo")))
        .unwrap();
    if attach_wheel {
        let _ = sup.wheel.set(Arc::new(crate::wheel::WheelState::default()));
    }

    let card = TugSessionId::new("card-A".to_string());
    let input_rx = install_live_session_for_tests(
        &sup,
        &card,
        WorkspaceKey::from_test_str("ws-test"),
        root.to_path_buf(),
    )
    .await;
    let entry = sup.ledger.lock().await.get(&card).cloned().expect("entry");
    entry.lock().await.claude_session_id = Some("segment-B".to_string());
    (sup, entry, input_rx, register_rx)
}

/// Every frame a session was sent, parsed, drained without blocking.
fn frames(input_rx: &mut mpsc::Receiver<Frame>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(frame) = input_rx.try_recv() {
        out.push(serde_json::from_slice(&frame.payload).unwrap());
    }
    out
}

/// Every CONTROL frame carrying an `action`, drained without blocking.
fn control_actions(control_rx: &mut broadcast::Receiver<Frame>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(frame) = control_rx.try_recv() {
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        if parsed["action"].is_string() {
            out.push(parsed);
        }
    }
    out
}

/// **A stop after a rotation interrupts the card** ([P01]). The press
/// resolves to the live segment, which no supervisor entry is keyed by;
/// the interrupt has to reach the card that entry belongs to, or it
/// reaches nothing and the turn runs on under a button that says it
/// stopped.
#[tokio::test]
async fn a_stop_after_a_rotation_interrupts_the_card() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = rotated_stop_harness(root, true).await;
    entry.lock().await.turn_active = true;
    answer_the_teardown(&sup, "card-A");

    sup.stop_arc_now(
        "segment-B",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
            question: None,
            halt: true,
        },
    )
    .await
    .expect("the stop lands");

    let sent = frames(&mut input_rx);
    let interrupt = sent
        .iter()
        .find(|frame| frame["type"] == "interrupt")
        .unwrap_or_else(|| panic!("an interrupt was sent: {sent:?}"));
    assert_eq!(
        interrupt["tug_session_id"], "card-A",
        "the interrupt is addressed to the card, not the segment: {sent:?}",
    );
    assert_eq!(
        tugarc_core::arc::read_arc(root, "demo").unwrap().stopped,
        Some((
            tugarc_core::ArcStage::Implement,
            "stopped by user".to_string()
        )),
    );
}

/// And the receipt reaches the same card, because the deck is bound to the
/// card's id and a receipt addressed to a segment finds no card to paint.
#[tokio::test]
async fn a_stop_after_a_rotation_delivers_its_receipt_to_the_card() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = rotated_stop_harness(root, true).await;
    entry.lock().await.turn_active = true;
    let mut control_rx = sup.control_tx.subscribe();
    answer_the_teardown(&sup, "card-A");

    sup.stop_arc_now(
        "segment-B",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
            question: None,
            halt: true,
        },
    )
    .await
    .expect("the stop lands");

    let actions = control_actions(&mut control_rx);
    let receipt = actions
        .iter()
        .find(|frame| frame["action"] == "arc_receipt")
        .unwrap_or_else(|| panic!("a receipt was sent: {actions:?}"));
    assert_eq!(receipt["tug_session_id"], "card-A", "{actions:?}");
    // The hand-back rides the card's channel for the same reason.
    assert!(
        frames(&mut input_rx)
            .iter()
            .any(|frame| frame["type"] == "model_change" && frame["tug_session_id"] == "card-A"),
    );
}

/// **A segment no live card wears is refused, ahead of every other act**
/// ([P01]). Nothing is interrupted and nothing is recorded: a stop that
/// found no card to act on has not happened, and a green answer over it
/// would be the [L31] fault again.
#[tokio::test]
async fn a_stop_on_a_segment_no_card_wears_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
    std::fs::write(root.join(".tug/arcs/demo/brief.md"), "# A brief\n").unwrap();
    tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
    let (sup, _ledger, _register_rx) = test_minimal_supervisor_reading_its_ledger();
    let _ = sup.wheel.set(Arc::new(crate::wheel::WheelState::default()));

    assert_eq!(
        sup.stop_arc_now(
            "segment-B",
            root,
            "demo",
            StopTerms {
                stage: tugarc_core::ArcStage::Implement,
                reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
                question: None,
                halt: true,
            },
        )
        .await,
        Err("no_card"),
    );
    assert!(
        tugarc_core::arc::read_arc(root, "demo")
            .unwrap()
            .stopped
            .is_none(),
        "no `arc-stop` line was appended",
    );
}

/// **A refused stop after a rotation answers the card** ([P01]). The
/// `_err` is parked by session and read off the card's bound id, so one
/// addressed to the segment lands in a slot no reader subscribes to — and
/// every refusal this arc adds would be invisible on exactly the arcs it
/// is about. Without this pin the deck-side notice path is covered by
/// nothing.
#[tokio::test]
async fn a_refused_stop_after_a_rotation_answers_the_card() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, _entry, _input_rx, _register_rx) = rotated_stop_harness(root, false).await;
    let mut control_rx = sup.control_tx.subscribe();

    sup.do_arc_stop(&BindArcPayload {
        tug_session_id: "card-A".to_string(),
        project_dir: root.to_string_lossy().to_string(),
        arc: "demo".to_string(),
    })
    .await;

    let actions = control_actions(&mut control_rx);
    let refusal = actions
        .iter()
        .find(|frame| frame["action"] == "arc_stop_err")
        .unwrap_or_else(|| panic!("the press was refused: {actions:?}"));
    assert_eq!(refusal["reason"], "no_wheel", "{actions:?}");
    assert_eq!(
        refusal["tug_session_id"], "card-A",
        "the refusal is addressed to the card the press came from: {actions:?}",
    );
    assert!(
        !actions.iter().any(|frame| frame["action"] == "arc_stop_ok"),
        "{actions:?}",
    );
}

/// Spawn `stop_arc_now` as its own task, so a test can observe the stop
/// while it is still waiting. Everything it needs is owned, because the
/// real caller's borrows do not outlive a `tokio::spawn`.
fn spawn_stop(
    sup: &Arc<AgentSupervisor>,
    root: &std::path::Path,
    segment: &'static str,
    halt: bool,
) -> tokio::task::JoinHandle<Result<(), &'static str>> {
    let sup = Arc::clone(sup);
    let root = root.to_path_buf();
    tokio::spawn(async move {
        sup.stop_arc_now(
            segment,
            &root,
            "demo",
            StopTerms {
                stage: tugarc_core::ArcStage::Implement,
                reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
                question: None,
                halt,
            },
        )
        .await
    })
}

/// Every arc-log marker written for `demo`, in the order they were
/// written. Split on the log's own field separator rather than matched as
/// substrings, because `arc-stop` is a prefix of `arc-stopping` and a
/// `contains` would read one for the other.
fn arc_log_markers(root: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(tugtool_core::paths::arc_log_path(root))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_end().splitn(4, "  ");
            let _at = fields.next()?;
            let arc = fields.next()?;
            let marker = fields.next()?;
            (arc.trim() == "demo").then(|| marker.trim().to_owned())
        })
        .collect()
}

/// **The stop does not answer while a job is open** ([P12]). `is_quiet` is
/// two facts and the turn ending is only one of them: work the stage
/// backgrounded runs on until the group it ran in is gone. Nothing but the
/// teardown's own answer can close those jobs — the claude that would have
/// sent their per-task closing edges is dead by then — so folding one of
/// those edges here would be testing the branch the real stop can never
/// take.
#[tokio::test]
async fn the_stop_does_not_answer_while_a_job_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, _input_rx, _register_rx) = stop_harness(root, true).await;
    {
        let mut guard = entry.lock().await;
        guard.turn_active = false;
        guard
            .open_jobs
            .insert("t1".to_owned(), bash_job(Instant::now()));
    }

    let stopping = spawn_stop(&sup, root, "claude-1", true);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !stopping.is_finished(),
        "the stop is still waiting on the open job",
    );
    assert!(
        tugarc_core::arc::read_arc(root, "demo")
            .unwrap()
            .stopped
            .is_none(),
        "so no `arc-stop` line is on the record and no `_ok` can have been sent",
    );

    sup.apply_stop_all_work_done(&TugSessionId::new("claude-1".to_owned()))
        .await;

    stopping.await.unwrap().expect("the stop lands");
    assert_eq!(
        tugarc_core::arc::read_arc(root, "demo").unwrap().stopped,
        Some((
            tugarc_core::ArcStage::Implement,
            "stopped by user".to_string()
        )),
        "and both land once the teardown has answered",
    );
}

/// **The verb carries the open task ids** ([P12]). tugcode holds no
/// open-job set of its own, so a `stop_all_work` naming none would make
/// its first rung a loop over nothing. Sending the ids gives a running
/// agent its one chance to close cleanly before the group sweep takes the
/// choice away.
#[tokio::test]
async fn the_stop_carries_the_open_task_ids() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = stop_harness(root, true).await;
    {
        let mut guard = entry.lock().await;
        guard.turn_active = false;
        guard
            .open_jobs
            .insert("t1".to_owned(), bash_job(Instant::now()));
        guard
            .open_jobs
            .insert("t2".to_owned(), bash_job(Instant::now()));
    }

    let stopping = spawn_stop(&sup, root, "claude-1", true);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let sent = frames(&mut input_rx);
    let verb = sent
        .iter()
        .find(|frame| frame["type"] == "stop_all_work")
        .unwrap_or_else(|| panic!("the teardown verb was dispatched: {sent:?}"));
    assert_eq!(
        verb["task_ids"],
        serde_json::json!(["t1", "t2"]),
        "both open jobs ride the verb: {sent:?}",
    );
    assert_eq!(verb["tug_session_id"], "claude-1", "{sent:?}");

    sup.apply_stop_all_work_done(&TugSessionId::new("claude-1".to_owned()))
        .await;
    stopping.await.unwrap().expect("the stop lands");
}

/// **The teardown's answer empties the job set** ([P12]). It is the only
/// notify site that can fire with several jobs open at once, and the only
/// writer for the half of `is_quiet` that nothing else on this path can
/// write.
#[tokio::test]
async fn a_stop_all_work_done_empties_the_job_set() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, _input_rx, _register_rx) = stop_harness(root, true).await;
    {
        let mut guard = entry.lock().await;
        guard.turn_active = true;
        for task in ["t1", "t2", "t3"] {
            guard
                .open_jobs
                .insert(task.to_owned(), bash_job(Instant::now()));
        }
    }

    // A waiter armed first, so the assertion is about the notify and not
    // only about the fields it moved.
    let waiting = tokio::spawn({
        let entry = Arc::clone(&entry);
        async move { AgentSupervisor::await_quiet(&entry, Duration::from_secs(5)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;

    sup.apply_stop_all_work_done(&TugSessionId::new("claude-1".to_owned()))
        .await;

    assert!(
        waiting.await.unwrap(),
        "the wait was released by the fold, not by its ceiling",
    );
    let guard = entry.lock().await;
    assert!(guard.open_jobs.is_empty(), "{:?}", guard.open_jobs);
    assert!(guard.is_quiet());
}

/// **A wait that runs out abandons the stop rather than reporting one**
/// ([P03], [P05]). The `_err` names the rung, the abandon line clears the
/// stopping mark so the arc is not frozen out of the wheel, and no
/// `arc-stop` is written over an arc that may still be running.
#[tokio::test]
async fn the_stop_answers_err_at_the_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, _input_rx, _register_rx) = stop_harness(root, true).await;
    std::fs::write(
        root.join(".tugtool/config.toml"),
        "[tugtool.arc]\nidle_settle_secs = 0\narc_stop_ceiling_secs = 1\n",
    )
    .unwrap();
    // Never quiet: the turn does not end and nothing answers the teardown.
    entry.lock().await.turn_active = true;

    assert_eq!(
        spawn_stop(&sup, root, "claude-1", true).await.unwrap(),
        Err("stop stalled at: quiet"),
        "the refusal names the rung it stalled on",
    );
    let record = tugarc_core::arc::read_arc(root, "demo").unwrap();
    assert!(record.stopped.is_none(), "no `arc-stop` line was written");
    assert!(
        record.stopping.is_none(),
        "and the mark does not outlive the press it was taken for",
    );
    assert_eq!(
        arc_log_markers(root)
            .iter()
            .filter(|marker| *marker == "arc-stopping")
            .count(),
        2,
        "the mark and its abandon line are both on the log",
    );
}

/// **The `arc-stop` line is the last thing a stop writes** ([P06]). The
/// `arc-stopping` mark precedes it, nothing sits between them, and the
/// record moving is what `arc_stop_ok` then means.
#[tokio::test]
async fn the_arc_stop_line_is_the_last_thing_the_stop_writes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, _input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = false;

    spawn_stop(&sup, root, "claude-1", true)
        .await
        .unwrap()
        .expect("the stop lands");

    let markers = arc_log_markers(root);
    let stopping = markers
        .iter()
        .position(|marker| marker == "arc-stopping")
        .unwrap_or_else(|| panic!("the mark was written: {markers:?}"));
    let stopped = markers
        .iter()
        .position(|marker| marker == "arc-stop")
        .unwrap_or_else(|| panic!("the stop was recorded: {markers:?}"));
    assert!(stopping < stopped, "{markers:?}");
    assert_eq!(
        stopped,
        stopping + 1,
        "nothing sits between them: {markers:?}"
    );
    assert_eq!(
        stopped,
        markers.len() - 1,
        "and nothing follows: {markers:?}"
    );
}

/// **A missed notify degrades to a late refusal, never a hang** (Risk
/// R01's residual). The entry goes quiet behind the waiter's back, with no
/// edge to wake it; the ceiling is what answers instead.
#[tokio::test]
async fn a_missed_notify_degrades_to_a_late_err() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (_sup, entry, _input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = true;

    let waiting = tokio::spawn({
        let entry = Arc::clone(&entry);
        async move { AgentSupervisor::await_quiet(&entry, Duration::from_secs(1)).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Quiet, and silent about it — the one failure this wait is allowed.
    entry.lock().await.turn_active = false;

    assert!(
        !waiting.await.unwrap(),
        "the ceiling answered rather than the wait hanging on a lost edge",
    );
}

/// **An ask quiesces without interrupting** ([P06]). A stage ending its
/// own turn over a question is mid-sentence and must not be truncated —
/// but its jobs and its children should end exactly as a user stop's do,
/// or the question is asked over a card still doing work.
#[tokio::test]
async fn an_ask_quiesces_without_interrupting() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (sup, entry, mut input_rx, _register_rx) = stop_harness(root, true).await;
    entry.lock().await.turn_active = false;

    sup.stop_arc_now(
        "claude-1",
        root,
        "demo",
        StopTerms {
            stage: tugarc_core::ArcStage::Implement,
            reason: tugarc_core::arc::ArcStopReason::NeedsDecision,
            question: Some("which of the two?"),
            halt: false,
        },
    )
    .await
    .expect("the stop lands");

    let sent = frame_types(&mut input_rx);
    assert!(
        !sent.iter().any(|frame| frame == "interrupt"),
        "nothing truncates the sentence: {sent:?}",
    );
    assert!(
        sent.iter().any(|frame| frame == "stop_all_work"),
        "and the rest of the work ends all the same: {sent:?}",
    );
}
