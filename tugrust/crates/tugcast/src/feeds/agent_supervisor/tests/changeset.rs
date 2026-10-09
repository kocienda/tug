//! Tests for the changeset family (`control/changeset.rs`): the payload
//! parsers, the commit message, the join and its resolve ladder, discard,
//! replay, the landing drafts, and the landing receipts the verbs write.

use super::*;

/// The shared `changeset_join_resolve_base_ok` wire fixture, also read by
/// the tugdeck bun suite — drift on either side of the mirror fails one of
/// the two. Declared against `CARGO_MANIFEST_DIR` because a bare relative
/// `include_str!` resolves against this source file rather than the crate.
const RESOLVE_BASE_OK_GOLDEN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tugdeck/src/__tests__/fixtures/changeset-join-resolve-base-ok.golden.json"
));

/// **The commit fact carries the branch it landed on** ([P02]).
///
/// The branch is a payload field rather than a column anywhere else, and
/// the commit path is the one place that has it in hand without a second
/// `git` read.
#[test]
fn a_commit_fact_carries_its_branch() {
    let fact = crate::feeds::facts_library::commit_fact(
        0,
        Some("sess-a"),
        "0123456789abcdef0123456789abcdef01234567",
        "a landing",
        &["README.md".to_owned()],
        None,
        Some("main"),
    );
    let payload: serde_json::Value = serde_json::from_str(&fact.payload).unwrap();
    assert_eq!(payload["branch"], "main");
}

/// The frame the deck correlates by `arc` carries one, and every other key
/// Spec S01 names.
#[test]
fn changeset_join_resolve_base_ok_body_matches_the_shared_fixture() {
    let outcome = tugarc_core::ops::ResolveBaseOutcome {
        name: "demo".to_owned(),
        base_branch: "main".to_owned(),
        committed: Some("0123456789abcdef0123456789abcdef01234567".to_owned()),
        folded: vec!["shared.txt".to_owned()],
        dropped: vec!["same.txt".to_owned()],
        folded_from: [("shared.txt".to_owned(), "other-session".to_owned())]
            .into_iter()
            .collect(),
        warnings: vec![],
    };

    let body = AgentSupervisor::changeset_join_resolve_base_ok_body("/p", &outcome.name, &outcome);
    let expected: serde_json::Value =
        serde_json::from_str(RESOLVE_BASE_OK_GOLDEN).expect("the shared fixture is valid JSON");
    assert_eq!(body, expected);
}

/// A fold that only dropped the arc's own copies committed nothing, and
/// the frame says so by leaving the key out rather than by carrying null.
#[test]
fn changeset_join_resolve_base_ok_body_omits_committed_when_nothing_was() {
    let outcome = tugarc_core::ops::ResolveBaseOutcome {
        name: "demo".to_owned(),
        base_branch: "main".to_owned(),
        committed: None,
        folded: vec![],
        dropped: vec!["same.txt".to_owned()],
        folded_from: Default::default(),
        warnings: vec![],
    };

    let body = AgentSupervisor::changeset_join_resolve_base_ok_body("/p", &outcome.name, &outcome);
    assert!(body.get("committed").is_none(), "no commit, no key");
    // Everything else stays present-and-empty, so the deck reads counts
    // without guarding each one.
    assert_eq!(body["folded"], serde_json::json!([]));
    assert_eq!(body["folded_from"], serde_json::json!({}));
    assert_eq!(body["warnings"], serde_json::json!([]));
    assert_eq!(body["arc"], "demo");
}

/// What the holder reads, and what it must not contain.
///
/// The count, the base and the short sha are the facts; the absence of a
/// CLI verb is the voice ([P08]). A sentence from Tug that tells somebody
/// to go type something has already conceded that the surface they are
/// looking at cannot do the thing.
#[test]
fn resolve_base_notice_text_names_the_count_the_sha_and_no_verb() {
    let text = AgentSupervisor::resolve_base_notice_text(
        "demo",
        "main",
        2,
        Some("0123456789abcdef0123456789abcdef01234567"),
    );
    assert!(text.contains("2 files"), "{text}");
    assert!(text.contains("onto main"), "{text}");
    assert!(text.contains("`012345678`"), "the short sha: {text}");
    assert!(text.contains("Nothing changed on disk"), "{text}");
    assert!(text.contains("Undo is in your Changes shade"), "{text}");
    assert!(!text.contains("tugtool"), "Tug names no CLI verb: {text}");

    // One file is a file, and the drop case has no sha to name and no
    // undo to offer — nothing was taken away.
    let one = AgentSupervisor::resolve_base_notice_text("demo", "main", 1, Some("abcdef012"));
    assert!(one.contains("1 file onto"), "{one}");
    let dropped = AgentSupervisor::resolve_base_notice_text("demo", "main", 3, None);
    assert!(
        dropped.contains("dropped your 3 identical files"),
        "{dropped}"
    );
    assert!(!dropped.contains("Undo"), "nothing to undo: {dropped}");
    assert!(!dropped.contains("tugtool"), "{dropped}");
}

fn commit_request(session_id: Option<&str>) -> ChangesetCommitPayload {
    ChangesetCommitPayload {
        project_dir: "/p".to_string(),
        files: vec!["a.txt".to_string()],
        message: "commit a".to_string(),
        session_id: session_id.map(str::to_owned),
        hunks: None,
    }
}

#[test]
fn changeset_commit_message_appends_the_citation_and_the_machine_id() {
    // The name never appears — the callsign is the session's name, and it
    // is immutable, so an old commit keeps saying where it came from.
    let request = commit_request(Some("f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"));
    assert_eq!(
        changeset_commit_message(&request, Some("stocky-pixie"), None),
        "commit a\n\nTug-Session: stocky-pixie (f6e43925)\n\
             Tug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
    );
}

/// [P13]. The parenthesized short id is the **line's**, so every commit a
/// card ever makes cites one conversation however many ids it rotates
/// through; `Tug-Session-Id` beside it still names the segment.
#[test]
fn the_citation_names_the_line_and_the_id_pins_the_segment() {
    let request = commit_request(Some("f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"));
    assert_eq!(
        changeset_commit_message(
            &request,
            Some("stocky-pixie"),
            Some("9c14ab70-dead-4beef-8888-000000000001"),
        ),
        "commit a\n\nTug-Session: stocky-pixie (9c14ab70)\n\
             Tug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
    );
}

#[test]
fn a_tagless_session_cites_the_bare_short_id() {
    // A doubled hash is noise, so the legacy fallback drops the parens.
    let request = commit_request(Some("f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"));
    assert_eq!(
        changeset_commit_message(&request, None, None),
        "commit a\n\nTug-Session: f6e43925\n\
             Tug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
    );
}

#[test]
fn changeset_commit_message_is_byte_for_byte_without_a_session_id() {
    let request = commit_request(None);
    assert_eq!(
        changeset_commit_message(&request, Some("stocky-pixie"), None),
        "commit a"
    );
}

#[test]
fn parse_changeset_commit_payload_reads_optional_session_fields() {
    // A legacy client may still send `session_name` beside the id; the
    // parser ignores it — the trailer's name resolves from the ledger.
    let payload = br#"{"project_dir":"/p","files":["a.txt"],"message":"m","session_name":"web","session_id":"sess-1"}"#;
    let parsed = parse_changeset_commit_payload(payload).expect("parse");
    assert_eq!(parsed.session_id.as_deref(), Some("sess-1"));
    // Absent fields parse to None (back-compat with today's callers).
    let bare = br#"{"project_dir":"/p","files":["a.txt"],"message":"m"}"#;
    let parsed_bare = parse_changeset_commit_payload(bare).expect("parse");
    assert_eq!(parsed_bare.session_id, None);
    assert_eq!(parsed_bare.hunks, None);
}

#[test]
fn parse_changeset_commit_payload_reads_the_hunk_election() {
    let payload = br#"{"project_dir":"/p","files":["a.txt","b.rs"],"message":"m","hunks":{"a.txt":["aaaa111122223333"]}}"#;
    let parsed = parse_changeset_commit_payload(payload).expect("parse");
    let hunks = parsed.hunks.expect("hunks present");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks["a.txt"], vec!["aaaa111122223333".to_string()]);

    // An empty map means "no election" rather than an empty one.
    let empty = br#"{"project_dir":"/p","files":["a.txt"],"message":"m","hunks":{}}"#;
    assert_eq!(parse_changeset_commit_payload(empty).unwrap().hunks, None);

    // Electing a path the commit is not landing is malformed, not ignored.
    let stray =
        br#"{"project_dir":"/p","files":["a.txt"],"message":"m","hunks":{"other.txt":["x"]}}"#;
    assert!(matches!(
        parse_changeset_commit_payload(stray),
        Err(ControlError::Malformed)
    ));
}

/// The control wire names the work `arc`, and a payload that does not
/// carry it is refused rather than parsed into a nameless request. There
/// is no read of the retired key: a CONTROL frame is live traffic between
/// two halves that ship together, never a durable record ([F19]).
#[test]
fn every_payload_parser_needs_the_arc_key_and_reads_no_other() {
    let bind = br#"{"tug_session_id":"s","project_dir":"/p","arc":"d"}"#;
    assert_eq!(parse_bind_arc_payload(bind).expect("parse").arc, "d");
    assert!(
        parse_bind_arc_payload(br#"{"tug_session_id":"s","project_dir":"/p","dash":"d"}"#).is_err(),
        "the retired key names nothing on a live wire"
    );

    let join = br#"{"project_dir":"/p","arc":"d"}"#;
    assert_eq!(parse_changeset_join_payload(join).expect("parse").arc, "d");
    assert!(parse_changeset_join_payload(br#"{"project_dir":"/p"}"#).is_err());

    let resolve = br#"{"project_dir":"/p","arc":"d"}"#;
    assert_eq!(
        parse_changeset_join_resolve_payload(resolve)
            .expect("parse")
            .arc,
        "d"
    );
    assert!(parse_changeset_join_resolve_payload(br#"{"project_dir":"/p"}"#).is_err());

    let answer = br#"{"project_dir":"/p","arc":"d","request_id":"r","answer":"a"}"#;
    assert_eq!(
        parse_changeset_join_question_answer_payload(answer)
            .expect("parse")
            .arc,
        "d"
    );

    let discard = br#"{"project_dir":"/p","arc":"d"}"#;
    assert_eq!(
        parse_changeset_discard_payload(discard).expect("parse").arc,
        "d"
    );
    assert!(parse_changeset_discard_payload(br#"{"project_dir":"/p"}"#).is_err());
}

#[test]
fn changeset_join_payload_defaults_continue_to_false() {
    let bare = br#"{"project_dir":"/p","arc":"d"}"#;
    let parsed = parse_changeset_join_payload(bare).expect("parse");
    assert!(!parsed.continue_join);
    assert_eq!(parsed.session_id, None);
    assert!(!parsed.preview);
}

#[test]
fn changeset_join_payload_reads_continue_and_session_id() {
    let payload =
        br#"{"project_dir":"/p","arc":"d","continue":true,"session_id":"sess-1","preview":true}"#;
    let parsed = parse_changeset_join_payload(payload).expect("parse");
    assert!(parsed.continue_join);
    assert_eq!(parsed.session_id.as_deref(), Some("sess-1"));
    assert!(parsed.preview);
}

#[test]
fn landing_receipt_reads_a_well_formed_press() {
    let payload = br#"{"kind":"join","verdict":"refused","reason":"turn","sentence":"Wait for the turn to finish","gate":{"turnInProgress":true,"messageLen":214}}"#;
    let parsed = parse_landing_receipt_payload(payload);
    assert_eq!(parsed.kind, "join");
    assert_eq!(parsed.verdict, "refused");
    assert_eq!(parsed.reason, "turn");
    assert!(parsed.gate.contains("messageLen"));
}

/// A receipt is a diagnostic, and a diagnostic that can be refused has a
/// failure mode of its own. Everything missing reads `-`; nothing panics,
/// and no shape of payload — including one that is not JSON at all —
/// produces an error the way the verb payloads do.
#[test]
fn landing_receipt_never_refuses_a_payload() {
    let accepted = parse_landing_receipt_payload(br#"{"kind":"commit","verdict":"ok"}"#);
    assert_eq!(accepted.kind, "commit");
    assert_eq!(accepted.reason, "-");
    assert_eq!(accepted.gate, "-");

    let empty = parse_landing_receipt_payload(b"{}");
    assert_eq!(empty.kind, "-");
    assert_eq!(empty.verdict, "-");

    let garbage = parse_landing_receipt_payload(b"not json at all");
    assert_eq!(garbage.kind, "-");
    assert_eq!(garbage.gate, "-");

    // A field of the wrong type is a missing field, not a panic.
    let wrong_type = parse_landing_receipt_payload(br#"{"kind":42,"verdict":null}"#);
    assert_eq!(wrong_type.kind, "-");
    assert_eq!(wrong_type.verdict, "-");
}

#[test]
fn changeset_discard_payload_session_id_is_optional() {
    let bare = br#"{"project_dir":"/p","arc":"d"}"#;
    assert_eq!(
        parse_changeset_discard_payload(bare)
            .expect("parse")
            .session_id,
        None
    );
    let tagged = br#"{"project_dir":"/p","arc":"d","session_id":"sess-1"}"#;
    assert_eq!(
        parse_changeset_discard_payload(tagged)
            .expect("parse")
            .session_id
            .as_deref(),
        Some("sess-1")
    );
    // Whitespace is not a session id.
    let blank = br#"{"project_dir":"/p","arc":"d","session_id":"  "}"#;
    assert_eq!(
        parse_changeset_discard_payload(blank)
            .expect("parse")
            .session_id,
        None
    );
}

#[test]
fn changeset_delete_documents_payload_parses_like_the_discard_s() {
    let bare = br#"{"project_dir":"/p","arc":"d"}"#;
    let parsed = parse_changeset_delete_documents_payload(bare).expect("parse");
    assert_eq!(parsed.project_dir, "/p");
    assert_eq!(parsed.arc, "d");
    assert_eq!(parsed.session_id, None);

    let tagged = br#"{"project_dir":"/p","arc":"d","session_id":"sess-1"}"#;
    assert_eq!(
        parse_changeset_delete_documents_payload(tagged)
            .expect("parse")
            .session_id
            .as_deref(),
        Some("sess-1")
    );

    // The two fields the frame cannot do without.
    assert!(parse_changeset_delete_documents_payload(br#"{"arc":"d"}"#).is_err());
    assert!(parse_changeset_delete_documents_payload(br#"{"project_dir":"/p"}"#).is_err());
}

#[test]
fn changeset_replay_payload_parses_like_the_discard_s() {
    let bare = br#"{"project_dir":"/p","arc":"d"}"#;
    let parsed = parse_changeset_replay_payload(bare).expect("parse");
    assert_eq!(parsed.project_dir, "/p");
    assert_eq!(parsed.arc, "d");
    assert_eq!(parsed.session_id, None);

    let tagged = br#"{"project_dir":"/p","arc":"d","session_id":"sess-1"}"#;
    assert_eq!(
        parse_changeset_replay_payload(tagged)
            .expect("parse")
            .session_id
            .as_deref(),
        Some("sess-1")
    );

    assert!(parse_changeset_replay_payload(br#"{"arc":"d"}"#).is_err());
    assert!(parse_changeset_replay_payload(br#"{"project_dir":"/p"}"#).is_err());
    assert!(parse_changeset_replay_payload(b"not json").is_err());
}

/// The wire word comes from `ReplayOutcome`'s own serde tag, and the
/// variant's fields ride with it — those fields are the only text a
/// non-moving outcome can be read from, so a bare word would leave the
/// press silent.
#[test]
fn every_replay_outcome_serializes_its_word_and_its_fields() {
    use tugarc_core::ReplayOutcome;

    let current = serde_json::to_value(ReplayOutcome::Current).unwrap();
    assert_eq!(current["outcome"], "current");

    let deferred = serde_json::to_value(ReplayOutcome::Deferred {
        reason: "dirty-worktree".to_string(),
        detail: "arc 'demo' has uncommitted changes".to_string(),
    })
    .unwrap();
    assert_eq!(deferred["outcome"], "deferred");
    assert_eq!(deferred["reason"], "dirty-worktree");
    assert_eq!(deferred["detail"], "arc 'demo' has uncommitted changes");

    let conflicted = serde_json::to_value(ReplayOutcome::Conflicted {
        base_head: "abc123".to_string(),
        round: "def456".to_string(),
        round_subject: "teach the row to speak".to_string(),
        paths: vec!["src/a.rs".to_string(), "src/b.rs".to_string()],
    })
    .unwrap();
    assert_eq!(conflicted["outcome"], "conflicted");
    assert_eq!(conflicted["round_subject"], "teach the row to speak");
    assert_eq!(conflicted["paths"][1], "src/b.rs");

    let replayed = serde_json::to_value(ReplayOutcome::Replayed {
        base_head: "abc123".to_string(),
        mapping: vec![("old".to_string(), "new".to_string())],
    })
    .unwrap();
    assert_eq!(replayed["outcome"], "replayed");
    assert_eq!(replayed["mapping"][0][1], "new");

    let recorded = serde_json::to_value(ReplayOutcome::Recorded {
        base_head: "abc123".to_string(),
        remapped: vec!["r1".to_string()],
        unmapped: vec![],
    })
    .unwrap();
    assert_eq!(recorded["outcome"], "recorded");
    assert_eq!(recorded["remapped"][0], "r1");
}

/// The `blockers` key is additive: absent, not `[]`, when nothing blocks
/// (Spec S03), so every shipped `changeset_join_ok` consumer is unaffected.
#[test]
fn changeset_join_ok_omits_blockers_when_there_are_none() {
    let outcome = tugarc_core::JoinOutcome {
        fit: None,
        name: "d".to_string(),
        base_branch: "main".to_string(),
        strategy: "squash".to_string(),
        commit_hash: None,
        conflicts: vec![],
        previewed: true,
        blockers: vec![],
        message: None,
        archaeology: vec![],
        warnings: vec![],
    };
    let mut body = serde_json::json!({ "action": "changeset_join_ok" });
    if !outcome.blockers.is_empty()
        && let Ok(blockers) = serde_json::to_value(&outcome.blockers)
    {
        body["blockers"] = blockers;
    }
    if !outcome.archaeology.is_empty()
        && let Ok(archaeology) = serde_json::to_value(&outcome.archaeology)
    {
        body["archaeology"] = archaeology;
    }
    assert!(body.get("blockers").is_none());
    // Same contract for the archaeology key: a clean preview carries no
    // history, and it must be absent rather than an empty array.
    assert!(body.get("archaeology").is_none());

    let blocked = tugarc_core::JoinBlocker {
        kind: "off-base".to_string(),
        title: "The base is on another branch".to_string(),
        detail: "Check out 'main' first.".to_string(),
        paths: vec![],
        overlap: vec![],
        remedy: None,
    };
    let value = serde_json::to_value(vec![blocked]).expect("serializes");
    assert_eq!(value[0]["kind"], "off-base");
    // `paths` is skip-if-empty too.
    assert!(value[0].get("paths").is_none());
}

#[test]
fn parse_changeset_claim_payload_requires_session_and_files() {
    let payload = br#"{"project_dir":"/p","session_id":"sess-1","files":["a.txt","b.rs"]}"#;
    let parsed = parse_changeset_claim_payload(payload).expect("parse");
    assert_eq!(parsed.project_dir, "/p");
    assert_eq!(parsed.session_id, "sess-1");
    assert_eq!(parsed.files, vec!["a.txt".to_string(), "b.rs".to_string()]);
    // A claim without a session id is malformed — a claim is by a session.
    let no_session = br#"{"project_dir":"/p","files":["a.txt"]}"#;
    assert!(matches!(
        parse_changeset_claim_payload(no_session),
        Err(ControlError::Malformed)
    ));
    // Missing project_dir is the shared invalid-project error.
    let no_project = br#"{"session_id":"sess-1","files":["a.txt"]}"#;
    assert!(parse_changeset_claim_payload(no_project).is_err());
}

#[test]
fn parse_changeset_disclaim_payload_matches_the_claim_shape() {
    let payload = br#"{"project_dir":"/p","session_id":"sess-1","files":["a.txt","b.rs"]}"#;
    let parsed = parse_changeset_disclaim_payload(payload).expect("parse");
    assert_eq!(parsed.project_dir, "/p");
    assert_eq!(parsed.session_id, "sess-1");
    assert_eq!(parsed.files, vec!["a.txt".to_string(), "b.rs".to_string()]);
    // A disclaim is by a session, so a missing session id is malformed.
    let no_session = br#"{"project_dir":"/p","files":["a.txt"]}"#;
    assert!(matches!(
        parse_changeset_disclaim_payload(no_session),
        Err(ControlError::Malformed)
    ));
    assert!(parse_changeset_disclaim_payload(br#"{"session_id":"s","files":["a.txt"]}"#).is_err());
}

#[tokio::test]
async fn changeset_git_init_inits_non_repo_and_guards() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    async fn next_control(rx: &mut broadcast::Receiver<Frame>) -> serde_json::Value {
        loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("control response within timeout")
                .expect("sender alive");
            let body: serde_json::Value =
                serde_json::from_slice(&frame.payload).expect("control body is JSON");
            if body["action"] != "changeset_join_land_delta" {
                return body;
            }
        }
    }

    fn init_payload(project_dir: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "changeset_git_init",
            "project_dir": project_dir,
        }))
        .unwrap()
    }

    // Register a temp non-repo dir as an open workspace.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    // Init it → ok, and the dir is now a git repo.
    sup.handle_control("changeset_git_init", &init_payload(&root_str), 1)
        .await;
    let ok = next_control(&mut control_rx).await;
    assert_eq!(ok["action"], "changeset_git_init_ok");
    assert_eq!(ok["project_dir"], root_str);
    assert!(root.join(".git").exists(), "git init created a repo");

    // Re-init the now-repo dir → err "already a git repository".
    sup.handle_control("changeset_git_init", &init_payload(&root_str), 1)
        .await;
    let already = next_control(&mut control_rx).await;
    assert_eq!(already["action"], "changeset_git_init_err");
    assert_eq!(already["detail"], "already a git repository");

    // A dir that is not a registered workspace → err "not an open project".
    let other = tempfile::tempdir().unwrap();
    let other_str = other
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    sup.handle_control("changeset_git_init", &init_payload(&other_str), 1)
        .await;
    let unknown = next_control(&mut control_rx).await;
    assert_eq!(unknown["action"], "changeset_git_init_err");
    assert_eq!(unknown["detail"], "not an open project");

    cancel.cancel();
}

#[tokio::test]
async fn changeset_refresh_fires_the_aggregate_bump() {
    let (sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    let bump = sup.registry.changeset_all_bump();

    let payload =
        serde_json::to_vec(&serde_json::json!({ "action": "changeset_refresh" })).unwrap();
    sup.handle_control("changeset_refresh", &payload, 1).await;

    // `notify_one` stores a permit even with no waiter registered yet, so a
    // `notified()` awaited after the handler completes resolves at once —
    // the recompute signal fired.
    tokio::time::timeout(std::time::Duration::from_secs(2), bump.notified())
        .await
        .expect("changeset_refresh fires the aggregate recompute bump");
}

#[tokio::test]
async fn changeset_join_previews_and_executes() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// The next control frame that is not one of the join's beats.
    ///
    /// A real join narrates itself ([P03]) and its beats arrive before its
    /// terminal reply. They are a liveness hint, so a test about the
    /// join's *result* skips them; their own shape is pinned by
    /// `a_join_narrates_its_beats_on_the_wire`.
    async fn next_control(rx: &mut broadcast::Receiver<Frame>) -> serde_json::Value {
        loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
                .await
                .expect("control response within timeout")
                .expect("sender alive");
            let body: serde_json::Value =
                serde_json::from_slice(&frame.payload).expect("control body is JSON");
            if body["action"] != "changeset_join_land_delta" {
                return body;
            }
        }
    }

    fn join_payload(project_dir: &str, arc: &str, preview: bool) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "changeset_join",
            "project_dir": project_dir,
            "arc": arc,
            "preview": preview,
            // The subject here is the join's own mechanics, not the
            // verification gate — which has its own tests.
        }))
        .unwrap()
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    // Scratch repo on main with a base commit and a `tugarc/demo` arc one
    // commit ahead, checked out in a `.tug/worktrees/demo` worktree.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("keep.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    let wt = root.join(".tug/worktrees/demo");
    git(
        &root,
        &["worktree", "add", wt.to_str().unwrap(), "tugarc/demo"],
    );
    std::fs::write(wt.join("round.txt"), "round\n").unwrap();
    git(&wt, &["add", "-A"]);
    git(&wt, &["commit", "-m", "round 1"]);

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    // Preview: clean, nothing mutated.
    sup.handle_control("changeset_join", &join_payload(&root_str, "demo", true), 1)
        .await;
    let preview = next_control(&mut control_rx).await;
    assert_eq!(preview["action"], "changeset_join_ok");
    assert_eq!(preview["previewed"], true);
    assert_eq!(
        preview["conflicts"].as_array().unwrap().len(),
        0,
        "clean preview reports no conflicts"
    );
    assert!(preview["commit_hash"].is_null(), "preview lands no commit");
    assert!(wt.exists(), "preview left the arc worktree in place");

    // Execute: squash-lands the arc on main and tears the arc down.
    sup.handle_control("changeset_join", &join_payload(&root_str, "demo", false), 1)
        .await;
    let done = next_control(&mut control_rx).await;
    assert_eq!(done["action"], "changeset_join_ok");
    assert_eq!(done["previewed"], false);
    assert!(done["commit_hash"].is_string(), "real join lands a commit");
    let tree = tugcore::git_command()
        .current_dir(&root)
        .args(["ls-tree", "--name-only", "HEAD"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&tree.stdout).contains("round.txt"),
        "squash landed the arc file on main"
    );
    let branches = tugcore::git_command()
        .current_dir(&root)
        .args(["branch", "--list", "tugarc/demo"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "arc branch removed after join"
    );

    // Guard: a dir that is not a registered workspace is refused.
    let other = tempfile::tempdir().unwrap();
    let other_str = other
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    sup.handle_control("changeset_join", &join_payload(&other_str, "demo", true), 1)
        .await;
    let unknown = next_control(&mut control_rx).await;
    assert_eq!(unknown["action"], "changeset_join_err");
    assert_eq!(unknown["detail"], "not an open project");

    cancel.cancel();
}

/// The join speaks while it works, and the frame says exactly what
/// [Spec S03] says it says ([P03]).
///
/// The silence being replaced was real: the press landed and the next word
/// was the durable commit message, many seconds later. `project_dir` is
/// echoed **verbatim** as the request sent it, which is what keeps a beat
/// correlated to the cell the press opened with no spelling to reconcile
/// ([L29]) — the same rule `changeset_join_resolve_delta` already follows.
#[tokio::test]
async fn a_join_narrates_its_beats_on_the_wire() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("keep.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    let wt = root.join(".tug/worktrees/demo");
    git(
        &root,
        &["worktree", "add", wt.to_str().unwrap(), "tugarc/demo"],
    );
    std::fs::write(wt.join("round.txt"), "round\n").unwrap();
    git(&wt, &["add", "-A"]);
    git(&wt, &["commit", "-m", "round 1"]);

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    // A preview narrates nothing: it touches no tree, so there is no work
    // to report on and no press waiting to hear about it.
    let preview_payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": root_str,
        "arc": "demo",
        "preview": true,
    }))
    .unwrap();
    sup.handle_control("changeset_join", &preview_payload, 1)
        .await;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
            .await
            .expect("a control frame")
            .expect("sender alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        match body["action"].as_str() {
            Some("changeset_join_land_delta") => {
                panic!("a preview emitted a beat: {body}")
            }
            Some("changeset_join_ok") => {
                assert_eq!(body["previewed"], true, "{body}");
                break;
            }
            Some("changeset_join_err") => panic!("the preview was refused: {body}"),
            _ => {}
        }
    }

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": root_str,
        "arc": "demo",
        "preview": false,
    }))
    .unwrap();
    sup.handle_control("changeset_join", &payload, 1).await;

    let mut beats: Vec<(String, String)> = Vec::new();
    let mut landed = false;
    for _ in 0..40 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
            .await
            .expect("a control frame")
            .expect("sender alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        match body["action"].as_str() {
            Some("changeset_join_land_delta") => {
                assert_eq!(
                    body["project_dir"], root_str,
                    "project_dir is echoed verbatim ([L29]): {body}"
                );
                assert_eq!(body["arc"], "demo", "{body}");
                beats.push((
                    body["beat"].as_str().expect("a beat name").to_string(),
                    body["status"].as_str().expect("a status").to_string(),
                ));
            }
            Some("changeset_join_ok") => {
                landed = true;
                break;
            }
            Some("changeset_join_err") => panic!("the join was refused: {body}"),
            _ => {}
        }
    }
    assert!(landed, "the join reached its terminal frame");
    assert!(
        !beats.is_empty(),
        "at least one beat arrives before the join's own _ok"
    );
    for (beat, status) in &beats {
        assert!(
            matches!(
                beat.as_str(),
                "preflight" | "squash" | "record" | "teardown" | "release"
            ),
            "unknown beat {beat}"
        );
        assert!(
            matches!(status.as_str(), "start" | "done"),
            "unknown status {status}"
        );
    }
    assert_eq!(
        beats.first().map(|(b, s)| (b.as_str(), s.as_str())),
        Some(("preflight", "start")),
        "the first thing said is that the handler took the press: {beats:?}"
    );
    let first_squash = beats
        .iter()
        .position(|(b, _)| b == "squash")
        .expect("the squash is narrated");
    assert!(
        first_squash > 0,
        "every squash beat comes after the front beat: {beats:?}"
    );
    assert_eq!(
        beats.iter().filter(|(b, _)| b == "preflight").count(),
        1,
        "the front beat is said once and has no paired done: {beats:?}"
    );

    cancel.cancel();
}

/// The documents-delete round trip: the paperwork goes, the receipt names
/// what went, and nothing else about the repo moves. A press on a ghost
/// row is the case — no branch, no worktree, documents nothing else can
/// remove ([B04], [B05]).
#[tokio::test]
async fn changeset_delete_documents_removes_only_the_documents() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("keep.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    let documents = root.join(".tug/arcs/ghost");
    std::fs::create_dir_all(&documents).unwrap();
    std::fs::write(documents.join("brief.md"), "# Ghost\n").unwrap();
    std::fs::write(documents.join("tasks.md"), "# Tasks\n").unwrap();
    let neighbour = root.join(".tug/arcs/keeper");
    std::fs::create_dir_all(&neighbour).unwrap();
    std::fs::write(neighbour.join("brief.md"), "# Keeper\n").unwrap();

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_delete_documents",
        "project_dir": root_str,
        "arc": "ghost",
    }))
    .unwrap();
    sup.handle_control("changeset_delete_documents", &payload, 1)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
        .await
        .expect("control response within timeout")
        .expect("sender alive");
    let done: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(done["action"], "changeset_delete_documents_ok", "{done}");
    assert_eq!(done["name"], "ghost");
    assert_eq!(done["files"][0], "brief.md");
    assert_eq!(done["files"][1], "tasks.md");
    assert!(
        done["summary"]
            .as_str()
            .expect("a summary")
            .contains("git will not give them back"),
        "{done}"
    );

    assert!(!documents.exists(), "the arc's documents are gone");
    assert!(
        neighbour.join("brief.md").is_file(),
        "the neighbouring arc's brief is untouched"
    );
    assert!(root.join("keep.txt").is_file(), "the checkout is untouched");

    cancel.cancel();
}

#[tokio::test]
async fn changeset_discard_discards_arc() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// The next control frame that is not one of the join's beats.
    ///
    /// A real join narrates itself ([P03]) and its beats arrive before its
    /// terminal reply. They are a liveness hint, so a test about the
    /// join's *result* skips them; their own shape is pinned by
    /// `a_join_narrates_its_beats_on_the_wire`.
    async fn next_control(rx: &mut broadcast::Receiver<Frame>) -> serde_json::Value {
        loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
                .await
                .expect("control response within timeout")
                .expect("sender alive");
            let body: serde_json::Value =
                serde_json::from_slice(&frame.payload).expect("control body is JSON");
            if body["action"] != "changeset_join_land_delta" {
                return body;
            }
        }
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("keep.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    let wt = root.join(".tug/worktrees/demo");
    git(
        &root,
        &["worktree", "add", wt.to_str().unwrap(), "tugarc/demo"],
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_discard",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_discard", &payload, 1).await;
    let done = next_control(&mut control_rx).await;
    assert_eq!(done["action"], "changeset_discard_ok");
    assert_eq!(done["name"], "demo");

    let branches = tugcore::git_command()
        .current_dir(&root)
        .args(["branch", "--list", "tugarc/demo"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "arc branch discarded"
    );
    assert!(!wt.exists(), "arc worktree discarded");

    cancel.cancel();
}

/// The replay verb's two guards refuse before any git runs, and each
/// refusal arrives as an `_err` frame rather than as silence.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changeset_replay_guards_refuse_with_err() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    async fn next_control(rx: &mut broadcast::Receiver<Frame>) -> serde_json::Value {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("control response within timeout")
            .expect("sender alive");
        serde_json::from_slice(&frame.payload).expect("control body is JSON")
    }

    // Guard one: a project the registry has never opened.
    let stranger = tempfile::tempdir().unwrap();
    let stranger_str = stranger.path().to_string_lossy().to_string();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_replay",
        "project_dir": stranger_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_replay", &payload, 1).await;
    let refused = next_control(&mut control_rx).await;
    assert_eq!(refused["action"], "changeset_replay_err");
    assert_eq!(refused["detail"], "not an open project");

    // Guard two: an open project that is not a git checkout.
    let plain = tempfile::tempdir().unwrap();
    let root = plain.path().canonicalize().unwrap();
    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_replay",
        "project_dir": root.to_string_lossy(),
        "arc": "demo",
        "session_id": "sess-1",
    }))
    .unwrap();
    sup.handle_control("changeset_replay", &payload, 1).await;
    let refused = next_control(&mut control_rx).await;
    assert_eq!(refused["action"], "changeset_replay_err");
    assert_eq!(refused["detail"], "not a git repository");
    // The session id rides back so the notice knows whose bulletin to post on.
    assert_eq!(refused["session_id"], "sess-1");

    cancel.cancel();
}

/// A replay of an arc whose base has not moved reports `current` on the
/// wire — the common non-moving outcome, and the one that would read as a
/// dead button if the frame carried no word.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changeset_replay_reports_current_when_the_base_has_not_moved() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("keep.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    let wt = root.join(".tug/worktrees/demo");
    git(
        &root,
        &["worktree", "add", wt.to_str().unwrap(), "tugarc/demo"],
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_replay",
        "project_dir": root.to_string_lossy(),
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_replay", &payload, 1).await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
        .await
        .expect("control response within timeout")
        .expect("sender alive");
    let body: serde_json::Value =
        serde_json::from_slice(&frame.payload).expect("control body is JSON");
    assert_eq!(body["action"], "changeset_replay_ok");
    assert_eq!(body["arc"], "demo");
    assert_eq!(body["outcome"], "current");

    cancel.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changeset_join_resolve_uses_scribe_and_reports_candidate() {
    // A fake scribe that returns a fixed clean merge and echoes it as one
    // streamed delta — no real claude call.
    struct FixedScribe(String);
    impl crate::scribe::ScribeSpawner for FixedScribe {
        fn run(
            &self,
            _model: String,
            _prompt: String,
            deltas: crate::scribe::ScribeDeltas,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        {
            let s = self.0.clone();
            Box::pin(async move {
                if let Some(tx) = deltas {
                    let _ = tx.send(s.clone());
                }
                Ok(s)
            })
        }
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.set_scribe(ScribeContext {
        spawner: std::sync::Arc::new(FixedScribe("MERGED\n".to_string())),
        model: std::sync::Arc::new(|| "haiku".to_string()),
    });

    // An arc whose one round overlaps the base's change → the algorithmic
    // rungs can't resolve it, so the scribe AI rung does.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("f.txt"), "A\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    git(&root, &["switch", "-q", "tugarc/demo"]);
    std::fs::write(root.join("f.txt"), "B\n").unwrap();
    git(&root, &["commit", "-am", "r1"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(root.join("f.txt"), "C\n").unwrap();
    git(&root, &["commit", "-am", "main to C"]);

    // Every conflicted join runs the resolver's audit pass ([P10]), so one
    // is scripted here: it keeps the AI rung's resolution and says so. The
    // stub is what keeps this test off a live model — the seam never
    // reaches for one on its own.
    let stub = root.join("stub-resolver.sh");
    std::fs::write(
            &stub,
            "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"ai\",\"what_each_side_did\":\"both rewrote it\",\"reconciliation\":\"the AI rung merged it\",\"audit\":\"kept\"}],\"notes\":\"audited\"}'\n",
        )
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &root,
        &["config", "tugarc.joinresolver", &stub.to_string_lossy()],
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve", &payload, 1)
        .await;

    // Drain frames: at least one AI delta, then the terminal ok.
    let mut saw_ai_delta = false;
    let mut terminal: Option<serde_json::Value> = None;
    for _ in 0..20 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
            .await
            .expect("a control frame")
            .expect("sender alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        match body["action"].as_str() {
            Some("changeset_join_resolve_delta") => {
                if body["rung"] == "ai" {
                    saw_ai_delta = true;
                }
            }
            Some("changeset_join_resolve_ok") | Some("changeset_join_resolve_err") => {
                terminal = Some(body);
                break;
            }
            _ => {}
        }
    }

    let ok = terminal.expect("a terminal resolve frame");
    assert_eq!(ok["action"], "changeset_join_resolve_ok", "resolved: {ok}");
    assert!(saw_ai_delta, "an AI progress delta streamed");
    assert!(ok["candidate_commit"].is_string(), "candidate built: {ok}");
    assert_eq!(ok["shape"], "squash");
    assert_eq!(ok["resolved"][0]["resolved_by"], "ai");
    assert!(
        ok["unresolved"].as_array().unwrap().is_empty(),
        "nothing left unresolved"
    );

    // The candidate's f.txt carries the scribe's merged content.
    let candidate = ok["candidate_commit"].as_str().unwrap();
    let show = tugcore::git_command()
        .current_dir(&root)
        .args(["show", &format!("{candidate}:f.txt")])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&show.stdout), "MERGED\n");

    cancel.cancel();
}

/// A repo on `main` with an arc that changed a shared path, and the base
/// dirty over that same path — the overlap a fold exists to clear.
fn base_dirt_repo() -> (tempfile::TempDir, std::path::PathBuf) {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("f.txt"), "A\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    git(&root, &["switch", "-q", "tugarc/demo"]);
    std::fs::write(root.join("f.txt"), "B\n").unwrap();
    git(&root, &["commit", "-am", "r1"]);
    git(&root, &["switch", "-q", "main"]);
    // Uncommitted, and over the path the arc changed: a `base-dirt`
    // blocker, and the user's own divergent work rather than a copy of
    // the arc's.
    std::fs::write(root.join("f.txt"), "A\nmy own edit\n").unwrap();
    (dir, root)
}

/// A second press lands on a held arc and is refused by name, without
/// touching git.
///
/// The refusal carries `admission: true`, which is what keeps the running
/// overlay up rather than painting the healthy first fold as failed: the
/// press was refused, the run was not.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changeset_join_resolve_base_refuses_a_second_press_by_name() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    let (_dir, root) = base_dirt_repo();

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let owner_key = tugarc_core::ops::arc_owner_key(&root, "demo");
    let held = crate::feeds::join_occupancy::acquire(
        &owner_key,
        crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
        None,
    )
    .expect("the arc is free");

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve_base",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve_base", &payload, 1)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["action"], "changeset_join_resolve_err", "{body}");
    assert_eq!(body["admission"], true, "{body}");
    assert_eq!(
        body["detail"], "a resolve-base is already running for this arc",
        "{body}"
    );
    // And the refused press did nothing to the base.
    assert_eq!(
        std::fs::read_to_string(root.join("f.txt")).unwrap(),
        "A\nmy own edit\n"
    );

    drop(held);
    cancel.cancel();
}

/// The fold's hold is gone by the time the recompute that clears the
/// blocker runs.
///
/// The two facts have to move together: that recompute is what takes the
/// `base-dirt` row off the entry, and a hold still standing at that moment
/// would leave `run: "resolve-base"` on an arc with nothing running — a
/// register saying an act is in flight over a surface that has already
/// settled (Risk R02).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changeset_join_resolve_base_releases_the_hold_before_the_bump() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    let (dir, root) = base_dirt_repo();

    // The fold records an op so `arc undo` can reverse it, and a debug
    // build refuses to write a tempdir repo's arc state into the live data
    // directory. Redirect it at the fixture's own scratch path.
    // SAFETY: single-threaded setup, and nextest runs one test per process.
    unsafe {
        std::env::set_var(tugcore::instance::ENV_DATA_DIR, dir.path().join("state"));
    }

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();
    let owner_key = tugarc_core::ops::arc_owner_key(&root, "demo");
    assert_eq!(
        crate::feeds::join_occupancy::run_kind(&owner_key),
        None,
        "precondition: nothing holds the arc"
    );

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve_base",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve_base", &payload, 1)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["action"], "changeset_join_resolve_base_ok", "{body}");
    assert_eq!(
        body["arc"], "demo",
        "the frame the deck correlates by: {body}"
    );
    assert_eq!(body["folded"], serde_json::json!(["f.txt"]), "{body}");

    assert_eq!(
        crate::feeds::join_occupancy::run_kind(&owner_key),
        None,
        "the hold is released with the work, before the ok frame goes out"
    );

    cancel.cancel();
}

/// The undo verb, end to end: a real fold through `handle_control`, then
/// the reversal, and the file is uncommitted again in the base checkout.
///
/// The frame is asserted for the two fields the deck reads — `arc`, which
/// correlates the reply to its cell, and `base_tip`, which says where the
/// base was put back — because a frame the deck cannot correlate is a
/// frame it drops in silence, which is the incident this whole arc is
/// about.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changeset_join_resolve_base_undo_reverts_the_fold_and_bumps() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    let (dir, root) = base_dirt_repo();

    // SAFETY: single-threaded setup, and nextest runs one test per process.
    unsafe {
        std::env::set_var(tugcore::instance::ENV_DATA_DIR, dir.path().join("state"));
    }

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve_base",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve_base", &payload, 1)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["action"], "changeset_join_resolve_base_ok", "{body}");

    let porcelain = tugcore::git_command()
        .current_dir(&root)
        .args(["status", "--porcelain", "--", "f.txt"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&porcelain.stdout).trim().is_empty(),
        "precondition: the fold cleared the path it folded"
    );

    let undo = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve_base_undo",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve_base_undo", &undo, 2)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(
        body["action"], "changeset_join_resolve_base_undo_ok",
        "{body}"
    );
    assert_eq!(
        body["arc"], "demo",
        "the frame the deck correlates by: {body}"
    );
    assert!(
        body["base_tip"].as_str().is_some_and(|s| s.len() == 40),
        "and where the base was put back: {body}"
    );

    let porcelain = tugcore::git_command()
        .current_dir(&root)
        .args(["status", "--porcelain", "--", "f.txt"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&porcelain.stdout).contains("f.txt"),
        "the edit is uncommitted again: {}",
        String::from_utf8_lossy(&porcelain.stdout)
    );

    cancel.cancel();
}

/// While a resolve holds an arc, every act that would touch its workshop is
/// refused by name — and a preview, which touches nothing, is not.
///
/// The failure this closes is concrete: the client's silence deadline used
/// to paint a healthy resolve as an error, and the error face re-mounted
/// the Resolve control. Pressing it started a second `finish_join` doing
/// `reset --hard` on the workshop the first one's resolver was editing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_resolve_refuses_every_other_run_on_that_arc() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// The next frame whose action is one of `wanted`, ignoring deltas.
    async fn await_action(
        rx: &mut broadcast::Receiver<Frame>,
        wanted: &[&str],
    ) -> serde_json::Value {
        for _ in 0..40 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
                .await
                .expect("a control frame")
                .expect("sender alive");
            let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
            if let Some(action) = body["action"].as_str() {
                if wanted.contains(&action) {
                    return body;
                }
            }
        }
        panic!("no frame among {wanted:?}");
    }

    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    // An arc with a real conflict, so the ladder cannot settle it alone and
    // the resolver rung runs — which is what keeps the arc held.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("f.txt"), "A\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    git(&root, &["switch", "-q", "tugarc/demo"]);
    std::fs::write(root.join("f.txt"), "B\n").unwrap();
    git(&root, &["commit", "-am", "r1"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(root.join("f.txt"), "C\n").unwrap();
    git(&root, &["commit", "-am", "main to C"]);

    // A resolver that reads its charter and then never answers, so the run
    // is unambiguously live for the whole test.
    let stub = root.join("stub-resolver.sh");
    std::fs::write(&stub, "#!/bin/sh\nread -r _charter\nsleep 120\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &root,
        &["config", "tugarc.joinresolver", &stub.to_string_lossy()],
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let resolve = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    // Returns as soon as the resolver rung is detached — the hold travels
    // with it, so the arc is occupied from here on.
    sup.handle_control("changeset_join_resolve", &resolve, 1)
        .await;

    sup.handle_control("changeset_join_resolve", &resolve, 1)
        .await;
    let refused = await_action(
        &mut control_rx,
        &["changeset_join_resolve_err", "changeset_join_resolve_ok"],
    )
    .await;
    assert_eq!(refused["action"], "changeset_join_resolve_err");
    assert_eq!(
        refused["detail"], "a resolve is already running for this arc",
        "the second press says what holds the arc"
    );

    let join = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": root_str,
        "arc": "demo",
        "preview": false,
    }))
    .unwrap();
    sup.handle_control("changeset_join", &join, 1).await;
    let refused = await_action(
        &mut control_rx,
        &["changeset_join_err", "changeset_join_ok"],
    )
    .await;
    assert_eq!(refused["action"], "changeset_join_err");
    assert_eq!(
        refused["detail"], "a resolve is already running for this arc",
        "a join would tear the workshop down under the resolve"
    );

    // A preview touches nothing, so it is never gated — the face asks for
    // one constantly, including while a resolve runs.
    let preview = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join",
        "project_dir": root_str,
        "arc": "demo",
        "preview": true,
    }))
    .unwrap();
    sup.handle_control("changeset_join", &preview, 1).await;
    let previewed = await_action(
        &mut control_rx,
        &["changeset_join_err", "changeset_join_ok"],
    )
    .await;
    assert_ne!(
        previewed["detail"], "a resolve is already running for this arc",
        "a preview is not a run: {previewed}"
    );

    cancel.cancel();
}

#[test]
fn a_landing_receipt_needs_a_session_to_belong_to() {
    let ledger =
        Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("in-memory ledger"));

    AgentSupervisor::record_landing_receipt(Some(&ledger), None, None, "/arc-join", "landed", "/p");
    assert!(
        ledger.lines_with_rows().unwrap().is_empty(),
        "a sessionless landing writes no row"
    );

    AgentSupervisor::record_landing_receipt(
        Some(&ledger),
        None,
        Some("f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f"),
        "/arc-join",
        "landed",
        "/p",
    );
    assert_eq!(
        ledger.lines_with_rows().unwrap().len(),
        1,
        "a named session gets its receipt"
    );
}

/// The arc's receipt is ordinary durable ink, and the census is how that
/// gets verified ([P12]).
///
/// The point of writing it through `record_landing_receipt` rather than
/// through a writer of its own is that it then restores by the same
/// machinery `/commit` and `/arc-join` restore by, and shows up in the
/// same `GET /api/ink-census` read. Counting DOM rows after a relaunch
/// would prove the render; this proves what the render is *of*.
#[test]
fn the_arc_receipt_lands_as_ink_the_census_counts() {
    let ledger =
        Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("in-memory ledger"));
    let session = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

    let id = AgentSupervisor::record_landing_receipt(
        Some(&ledger),
        None,
        Some(session),
        "/arc-run",
        "arc complete · foo\ndevise · opus · claude-a",
        "/p",
    );
    assert!(id.is_some(), "the row identity rides back to the deck");

    let census = ledger.ink_census(Some(session)).expect("census");
    assert_eq!(census.len(), 1, "one session, one holding");
    assert_eq!(census[0].rows, 1, "one arc, one receipt");
    assert_eq!(census[0].tug_session_id, session);
}

// ── durable ink follows the line of work ────────────────────────────────

#[test]
fn a_landing_receipt_written_under_any_segment_lands_on_the_line() {
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let sessions = forked_pair();

    // The proven failure window: the deck stays bound to `parent` until
    // the next relaunch, so this is the id a join receipt arrives under.
    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("parent"),
        "/arc-join",
        "landed",
        "/proj",
    );

    assert_eq!(
        shell.lines_with_rows().unwrap(),
        std::collections::HashSet::from(["line-1".to_string()]),
        "the receipt is keyed to the line of work, not to the id it arrived under"
    );
    // And the row still records which segment wrote it — a transcript
    // fact, and the only thing that could ever place it.
    let rows = shell.list_exchanges_since("line-1", None).unwrap();
    assert_eq!(rows[0].tug_session_id, "parent");
}

#[test]
fn a_landing_receipt_on_a_line_of_one_keys_under_that_line() {
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let sessions =
        Arc::new(crate::session_ledger::SessionLedger::open_in_memory().expect("sessions ledger"));
    sessions
        .record_spawn("solo", "ws", "/proj", "card-1", 1_000, "line-solo", None)
        .expect("spawn");

    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("solo"),
        "/commit",
        "landed",
        "/proj",
    );

    assert_eq!(
        shell.lines_with_rows().unwrap(),
        std::collections::HashSet::from(["line-solo".to_string()]),
    );
}

// ── the receipt records where it belongs in the transcript ──────────────

/// A sessions ledger with real Claude transcripts on disk, so the anchor
/// read at the write gateway has a file to walk. Returns the tempdir too —
/// dropping it would delete the transcripts mid-test.
fn sessions_with_transcripts(
    rows: &[(&str, &str)],
) -> (Arc<crate::session_ledger::SessionLedger>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let sessions = Arc::new(
        crate::session_ledger::SessionLedger::open_with_claude_home(
            dir.path().join("sessions.db"),
            tugcore::claude_home::ClaudeHome::at(dir.path()),
        )
        .expect("sessions ledger"),
    );
    let (project, _) = crate::session_ledger::claude_project_dir(sessions.claude_home(), "/proj");
    std::fs::create_dir_all(&project).expect("project dir");
    for (i, (session, msg_id)) in rows.iter().enumerate() {
        sessions
            .record_spawn(
                session,
                "ws",
                "/proj",
                "card-1",
                1_000 + i as i64,
                session,
                None,
            )
            .expect("spawn");
        std::fs::write(
            project.join(format!("{session}.jsonl")),
            format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\"}}}}\n\
                     {{\"type\":\"assistant\",\"message\":{{\"id\":\"{msg_id}\"}}}}\n"
            ),
        )
        .expect("write jsonl");
    }
    (sessions, dir)
}

#[test]
fn a_landing_receipt_is_stamped_with_the_sessions_newest_assistant_message() {
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let (sessions, _dir) = sessions_with_transcripts(&[("solo", "msg_01TURN")]);

    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("solo"),
        "/commit",
        "landed",
        "/proj",
    );

    let rows = shell.list_exchanges_since("solo", None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].anchor_msg_id.as_deref(),
        Some("msg_01TURN"),
        "the receipt records the turn it follows",
    );
}

#[test]
fn the_receipt_anchor_comes_from_the_segments_own_transcript() {
    // Two lines, two transcripts: a fork the user cut into its own card
    // is not a segment of the parent's line, so a receipt posted under the
    // parent reads the parent's file and never the fork's.
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let (sessions, _dir) =
        sessions_with_transcripts(&[("parent", "msg_01PARENT"), ("fork", "msg_01FORK")]);
    sessions
        .set_fork_provenance("fork", "parent", Some("point-1"))
        .expect("provenance");

    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("parent"),
        "/arc-join",
        "landed",
        "/proj",
    );

    let line = sessions.line_of("parent").expect("the parent has a line");
    let rows = shell.list_exchanges_since(&line, None).unwrap();
    assert_eq!(rows.len(), 1, "the receipt keyed onto the line");
    assert_eq!(rows[0].anchor_msg_id.as_deref(), Some("msg_01PARENT"));
}

#[test]
fn the_receipt_anchor_is_the_lines_live_head_not_the_id_the_card_was_spawned_as() {
    // The shape every arc join has once the Wheel has rotated: the card's
    // own id is the line's first segment, closed at the first rotation,
    // and the deck posts the join under it. The receipt has to seat after
    // the head's last turn — the audit's report — not after the door's,
    // which is where an anchor read off the posted id's file put it, and
    // where a relaunch then "lost" the join beneath two whole stages.
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let (sessions, dir) = sessions_with_transcripts(&[]);
    let (project, _) = crate::session_ledger::claude_project_dir(sessions.claude_home(), "/proj");
    let transcript = |session: &str, msg_id: &str| {
        std::fs::write(
            project.join(format!("{session}.jsonl")),
            format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\"}}}}\n\
                     {{\"type\":\"assistant\",\"message\":{{\"id\":\"{msg_id}\"}}}}\n"
            ),
        )
        .expect("write jsonl");
    };
    sessions
        .record_spawn("door", "ws", "/proj", "card-1", 1_000, "line-1", None)
        .expect("spawn the door");
    transcript("door", "msg_01DOOR");
    sessions
        .demote_live_to_closed(crate::session_ledger::DemoteScope::EveryLiveRow)
        .expect("the door rotates away");
    sessions
        .record_spawn("audit", "ws", "/proj", "card-1", 2_000, "line-1", None)
        .expect("spawn the head");
    sessions
        .set_fork_provenance("audit", "door", None)
        .expect("provenance");
    transcript("audit", "msg_01AUDIT");

    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("door"),
        "/arc-join",
        "landed",
        "/proj",
    );

    let rows = shell.list_exchanges_since("line-1", None).unwrap();
    assert_eq!(rows.len(), 1, "the receipt keyed onto the line");
    assert_eq!(
        rows[0].tug_session_id, "door",
        "the writer's id is still the record"
    );
    assert_eq!(
        rows[0].anchor_msg_id.as_deref(),
        Some("msg_01AUDIT"),
        "the anchor is the live head's last turn, not the door's",
    );
    drop(dir);
}

#[test]
fn a_receipt_from_a_transcript_less_session_still_lands_unanchored() {
    // [L23] posture at the gateway: no anchor degrades placement, it never
    // blocks the write.
    let shell = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().expect("shell ledger"));
    let (sessions, _dir) = sessions_with_transcripts(&[]);
    sessions
        .record_spawn(
            "zero-turns",
            "ws",
            "/proj",
            "card-1",
            1_000,
            "zero-turns",
            None,
        )
        .expect("spawn");

    AgentSupervisor::record_landing_receipt(
        Some(&shell),
        Some(&sessions),
        Some("zero-turns"),
        "/commit",
        "landed",
        "/proj",
    );

    let rows = shell.list_exchanges_since("zero-turns", None).unwrap();
    assert_eq!(rows.len(), 1, "the receipt is written regardless");
    assert_eq!(rows[0].anchor_msg_id, None);
}

/// Correctness must not ride a droppable channel.
///
/// CONTROL is `LagPolicy::Warn` — a frame may simply not arrive, and a lost
/// `_ok` used to lose a real candidate forever. Here every CONTROL send
/// fails outright (no receiver at all), and the resolve still has to land
/// in git and still has to show up in the state the feed composes.
#[tokio::test]
async fn a_resolve_survives_losing_every_control_frame() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let (sup, _state_rx, _meta_rx, control_rx) = make_supervisor_with_store();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("f.txt"), "A\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["branch", "tugarc/demo"]);
    git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    git(&root, &["switch", "-q", "tugarc/demo"]);
    std::fs::write(root.join("f.txt"), "B\n").unwrap();
    git(&root, &["commit", "-am", "r1"]);
    git(&root, &["switch", "-q", "main"]);
    std::fs::write(root.join("f.txt"), "C\n").unwrap();
    git(&root, &["commit", "-am", "main to C"]);

    let stub = root.join("stub-driver.sh");
    std::fs::write(&stub, "#!/bin/sh\nprintf 'RESOLVED\\n' > \"$4\"\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &root,
        &["config", "tugarc.mergedriver", &stub.to_string_lossy()],
    );

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    // Every CONTROL frame this handler sends is now dropped on the floor.
    drop(control_rx);

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_join_resolve",
        "project_dir": root_str,
        "arc": "demo",
    }))
    .unwrap();
    sup.handle_control("changeset_join_resolve", &payload, 1)
        .await;

    // The result is in git regardless, and the composition the feed runs
    // reports it — which is the whole point of moving terminal truth off
    // CONTROL and onto the replayed snapshot feed.
    let detail = tugarc_core::ops::arc_detail_entry_in(&root, "demo").expect("detail");
    let branch = tugarc_core::ops::current_branch(&root).unwrap();
    let state = crate::feeds::join_board::join_state_for(
        &root,
        &detail,
        &branch,
        &std::collections::BTreeMap::new(),
        &crate::feeds::join_board::standing_resolve_receipts(&root),
    );
    assert_eq!(state.phase, "resolved", "{state:?}");
    assert!(
        state.candidate.is_some(),
        "the candidate survived: {state:?}"
    );
    assert!(
        tugarc_core::resolve::read_candidate(&root, "demo").is_some(),
        "and it is anchored in git"
    );

    cancel.cancel();
}

/// A fake scribe that streams one delta and returns a fixed message.
struct DraftScribe(String);
impl crate::scribe::ScribeSpawner for DraftScribe {
    fn run(
        &self,
        _model: String,
        _prompt: String,
        deltas: crate::scribe::ScribeDeltas,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
        let s = self.0.clone();
        Box::pin(async move {
            if let Some(tx) = deltas {
                let _ = tx.send(s.clone());
            }
            Ok(s)
        })
    }
}

/// A one-session snapshot. `project_dir` is the raw checkout (the git cwd
/// the engine runs in) and `workspace_key` is the canonical identity every
/// draft frame, registry entry, and ledger row is keyed by — production
/// keeps them apart, so the fixture does too.
fn draft_session_snapshot(
    project_dir: &str,
    workspace_key: &str,
) -> tugcast_core::types::WorkspacesChangesetSnapshot {
    use tugcast_core::types::{
        ChangesetEntry, ChangesetFile, ChangesetSnapshot, ProjectChangeset,
        WorkspacesChangesetSnapshot,
    };
    let entry = ChangesetEntry::Session {
        owner_id: "s1".to_string(),
        line_id: None,
        display_name: "s1".to_string(),
        live: true,
        files: vec![ChangesetFile {
            path: "a.txt".to_string(),
            git_status: "M".to_string(),
            op: "edit".to_string(),
            origin: "exact".to_string(),
            shared: false,
            last_touched: 1,
            own_hunks: Vec::new(),
            contested_hunks: Vec::new(),
            shared_with: Vec::new(),
            added: None,
            deleted: None,
        }],
        draft: None,
    };
    WorkspacesChangesetSnapshot {
        ledger_degraded: false,
        projects: vec![ProjectChangeset {
            project_dir: project_dir.to_string(),
            display_name: "proj".to_string(),
            no_repo: false,
            snapshot: ChangesetSnapshot {
                workspace_key: workspace_key.to_string(),
                branch: "main".to_string(),
                ahead: 0,
                behind: 0,
                head_sha: String::new(),
                head_message: String::new(),
                changesets: vec![entry],
                unattributed: vec![],
                orphaned: vec![],
            },
            unattributed_draft: None,
            document_arcs: vec![],
        }],
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changeset_draft_request_spawns_generation_over_snapshot() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    sup.set_scribe(ScribeContext {
        spawner: Arc::new(DraftScribe("Draft message\n".to_string())),
        model: Arc::new(|| "haiku".to_string()),
    });

    // A repo with a committed file and one tracked modification.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);
    std::fs::write(root.join("a.txt"), "changed\n").unwrap();

    let cancel = CancellationToken::new();
    let _entry = sup.registry.get_or_create(&root, cancel.clone()).unwrap();
    let root_str = root.to_string_lossy().to_string();

    // Store the aggregate watch frame the request resolves against.
    let (_wtx, wrx) = watch::channel(Frame::new(
        FeedId::CHANGESET_ALL,
        serde_json::to_vec(&draft_session_snapshot(&root_str, &root_str)).unwrap(),
    ));
    sup.changeset_watch.set(wrx).ok();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_draft_request",
        "workspace_key": root_str,
        "owner_kind": "session",
        "owner_id": "s1",
    }))
    .unwrap();
    // Generation is detached: handle_control returns before it runs, so we
    // poll the CONTROL broadcast for the drafting→ready sequence.
    sup.handle_control("changeset_draft_request", &payload, 1)
        .await;

    let mut saw_drafting = false;
    let mut saw_ready = false;
    for _ in 0..40 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), control_rx.recv())
            .await
            .expect("a control frame")
            .expect("sender alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        if body["action"] == "changeset_draft_state" {
            match body["state"].as_str() {
                Some("drafting") => saw_drafting = true,
                Some("ready") => {
                    saw_ready = true;
                    break;
                }
                _ => {}
            }
        }
    }
    assert!(saw_drafting, "a drafting state streamed");
    assert!(saw_ready, "a ready state landed");

    let row = sup
        .session_ledger
        .as_ref()
        .unwrap()
        .changeset_draft("session", "s1", &root_str)
        .unwrap()
        .expect("draft row persisted");
    assert_eq!(row.message, "Draft message");

    cancel.cancel();
}

#[tokio::test]
async fn changeset_draft_request_nothing_to_generate_replies_error() {
    let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    sup.set_scribe(ScribeContext {
        spawner: Arc::new(DraftScribe("unused".to_string())),
        model: Arc::new(|| "haiku".to_string()),
    });

    // An empty snapshot surfaces no eligible entry for the requested owner.
    let empty = tugcast_core::types::WorkspacesChangesetSnapshot {
        projects: vec![],
        ledger_degraded: false,
    };
    let (_wtx, wrx) = watch::channel(Frame::new(
        FeedId::CHANGESET_ALL,
        serde_json::to_vec(&empty).unwrap(),
    ));
    sup.changeset_watch.set(wrx).ok();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_draft_request",
        "workspace_key": "/nope",
        "owner_kind": "session",
        "owner_id": "s1",
    }))
    .unwrap();
    sup.handle_control("changeset_draft_request", &payload, 1)
        .await;

    // The error reply is synchronous — readable right after the call.
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["action"], "changeset_draft_state");
    assert_eq!(body["state"], "error");
    // The detail names the owner that could not be placed, which is the
    // whole of what a rotated card needs to see ([B04]).
    assert_eq!(
        body["detail"],
        crate::feeds::draft_engine::unmatched_owner_detail("s1")
    );
    assert_eq!(body["owner_id"], "s1");
}

/// A cancel with no in-flight generation still broadcasts the terminal
/// `cancelled` state: it is the client's only exit from a `drafting`
/// overlay whose terminal frame was lost, so it must always be answered.
#[tokio::test]
async fn changeset_draft_cancel_with_nothing_in_flight_still_replies_cancelled() {
    let (sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();

    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_draft_cancel",
        "workspace_key": "/nope",
        "owner_kind": "session",
        "owner_id": "s1",
    }))
    .unwrap();
    sup.handle_control("changeset_draft_cancel", &payload, 1)
        .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), control_rx.recv())
        .await
        .expect("a control frame")
        .expect("sender alive");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(body["action"], "changeset_draft_state");
    assert_eq!(body["state"], "cancelled");
    assert_eq!(body["owner_id"], "s1");
}

/// Every terminal draft frame is addressed by `workspace_key`, and by
/// nothing else. The client overlay map compares this string literally and
/// has no gateway to reconcile a second spelling with, so a frame that
/// carried a raw `project_dir` instead would land on a key nothing reads —
/// which is how a `drafting` overlay latches the composer read-only with
/// no exit ([L29]).
#[tokio::test]
async fn terminal_draft_frames_are_addressed_by_workspace_key() {
    for (verb, state) in [
        ("changeset_draft_request", "error"),
        ("changeset_draft_cancel", "cancelled"),
    ] {
        let (mut sup, _state_rx, _meta_rx, mut control_rx) = make_supervisor_with_store();
        sup.session_ledger = Some(Arc::new(
            crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
        ));
        sup.set_scribe(ScribeContext {
            spawner: Arc::new(DraftScribe("unused".to_string())),
            model: Arc::new(|| "haiku".to_string()),
        });
        let empty = tugcast_core::types::WorkspacesChangesetSnapshot {
            projects: vec![],
            ledger_degraded: false,
        };
        let (_wtx, wrx) = watch::channel(Frame::new(
            FeedId::CHANGESET_ALL,
            serde_json::to_vec(&empty).unwrap(),
        ));
        sup.changeset_watch.set(wrx).ok();

        let payload = serde_json::to_vec(&serde_json::json!({
            "action": verb,
            "workspace_key": "/canonical/ws",
            "owner_kind": "session",
            "owner_id": "s1",
        }))
        .unwrap();
        sup.handle_control(verb, &payload, 1).await;

        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), control_rx.recv())
            .await
            .expect("a control frame")
            .expect("sender alive");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["state"], state, "{verb} terminal state");
        assert_eq!(body["workspace_key"], "/canonical/ws", "{verb} identity");
        assert!(
            body.get("project_dir").is_none(),
            "{verb} must not address a client by a raw project_dir"
        );
    }
}

/// A payload that names only a `project_dir` is refused outright rather
/// than resolved by guesswork — the whole point of the key being canonical
/// is that there is nothing left to guess.
#[tokio::test]
async fn draft_request_without_workspace_key_is_refused() {
    let payload = serde_json::to_vec(&serde_json::json!({
        "action": "changeset_draft_request",
        "project_dir": "/u/src/tugtool",
        "owner_kind": "session",
        "owner_id": "s1",
    }))
    .unwrap();
    assert!(matches!(
        parse_changeset_draft_request_payload(&payload),
        Err(ControlError::InvalidProjectDir {
            reason: "missing_workspace_key"
        })
    ));
}

#[tokio::test]
async fn changeset_draft_set_partially_upserts_and_clears() {
    let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();

    // A message write creates the row with the edited pin.
    let payload = serde_json::to_vec(&serde_json::json!({
        "workspace_key": "/proj",
        "owner_kind": "session",
        "owner_id": "s1",
        "message": "Hand-tuned message",
        "edited": true,
    }))
    .unwrap();
    sup.handle_control("changeset_draft_set", &payload, 1).await;
    let row = ledger
        .changeset_draft("session", "s1", "/proj")
        .unwrap()
        .expect("row created");
    assert_eq!(row.message, "Hand-tuned message");
    assert!(row.edited);
    assert!(row.selection.is_none());

    // A selection-only write keeps the message and the edited pin
    // (edited is monotonic through this verb).
    let payload = serde_json::to_vec(&serde_json::json!({
        "workspace_key": "/proj",
        "owner_kind": "session",
        "owner_id": "s1",
        "selection": {"include": ["a.rs"], "exclude": []},
        "edited": false,
    }))
    .unwrap();
    sup.handle_control("changeset_draft_set", &payload, 1).await;
    let row = ledger
        .changeset_draft("session", "s1", "/proj")
        .unwrap()
        .unwrap();
    assert_eq!(row.message, "Hand-tuned message");
    assert!(row.edited, "edited survives a selection-only write");
    assert!(row.selection.as_deref().unwrap().contains("a.rs"));

    // An explicit null clears the selection without touching the message.
    let payload = serde_json::to_vec(&serde_json::json!({
        "workspace_key": "/proj",
        "owner_kind": "session",
        "owner_id": "s1",
        "selection": serde_json::Value::Null,
        "edited": false,
    }))
    .unwrap();
    sup.handle_control("changeset_draft_set", &payload, 1).await;
    let row = ledger
        .changeset_draft("session", "s1", "/proj")
        .unwrap()
        .unwrap();
    assert!(row.selection.is_none());
    assert_eq!(row.message, "Hand-tuned message");

    // `clear` deletes the row (the post-landing path).
    let payload = serde_json::to_vec(&serde_json::json!({
        "workspace_key": "/proj",
        "owner_kind": "session",
        "owner_id": "s1",
        "edited": false,
        "clear": true,
    }))
    .unwrap();
    sup.handle_control("changeset_draft_set", &payload, 1).await;
    assert!(
        ledger
            .changeset_draft("session", "s1", "/proj")
            .unwrap()
            .is_none()
    );
}

/// A ledger mutation that fails is logged with its operation and key, and
/// the aggregate bump after it still fires — so the deck re-reads rather
/// than trusting a row the failed delete left behind.
#[tokio::test]
async fn a_failed_draft_delete_is_logged_and_still_bumps() {
    #[derive(Clone, Default)]
    struct Sink(Arc<SyncMutex<Vec<u8>>>);
    impl std::io::Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let sink = Sink::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer({
            let sink = sink.clone();
            move || sink.clone()
        })
        .with_ansi(false)
        .finish();
    let _log = tracing::subscriber::set_default(subscriber);
    let logged = || String::from_utf8_lossy(&sink.0.lock()).into_owned();

    let (mut sup, _state_rx, _meta_rx, _control_rx) = make_supervisor_with_store();
    sup.session_ledger = Some(Arc::new(
        crate::session_ledger::SessionLedger::open_in_memory().unwrap(),
    ));
    let ledger = sup.session_ledger.clone().unwrap();
    ledger.break_changeset_drafts_for_test();

    // The landed-arc path: each key's delete fails and says so.
    AgentSupervisor::clear_arc_draft(&ledger, "/proj", "arc-key");
    let log = logged();
    assert!(log.contains("ledger mutation failed"), "no warning: {log}");
    assert!(log.contains("op=\"delete_changeset_draft\""), "{log}");
    assert!(log.contains("arc:arc-key in /proj"), "{log}");

    // The post-landing `clear` verb: its delete fails, and the bump fires.
    let bump = sup.registry.changeset_all_bump();
    assert!(
        tokio::time::timeout(Duration::from_millis(5), bump.notified())
            .await
            .is_err(),
        "no bump is pending before the clear"
    );
    let payload = serde_json::to_vec(&serde_json::json!({
        "workspace_key": "/proj",
        "owner_kind": "session",
        "owner_id": "s1",
        "edited": false,
        "clear": true,
    }))
    .unwrap();
    sup.handle_control("changeset_draft_set", &payload, 1).await;
    let log = logged();
    assert!(log.contains("session:s1 in /proj"), "{log}");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), bump.notified())
            .await
            .is_ok(),
        "the bump still fires after a failed delete"
    );
}

/// A `changeset_commit` with a `session_id` persists exactly one `/commit`
/// row to the shell ledger whose `output` is the server-formatted summary
/// echoed on `changeset_commit_ok` ([P07], S02); a commit without a
/// `session_id` writes no row (R02).
#[tokio::test]
async fn changeset_commit_persists_the_landing_to_the_shell_ledger() {
    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = tugcore::git_command()
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let temp = tempfile::tempdir().expect("tempdir");
    let repo = temp.path().canonicalize().expect("canonicalize");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "t@t"]);
    git(&repo, &["config", "user.name", "t"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);

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
    let registry = Arc::new(WorkspaceRegistry::new_for_test());
    registry
        .get_or_create(&repo, CancellationToken::new())
        .expect("register repo");
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
        registry,
        CancellationToken::new(),
    );
    sup.set_shell_ledger(Arc::clone(&shell_ledger));
    tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

    // Commit with a session_id → one ledger row keyed by the session.
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    let request = ChangesetCommitPayload {
        project_dir: repo.to_string_lossy().into_owned(),
        files: vec!["a.txt".to_string()],
        message: "Add a second line".to_string(),
        session_id: Some("sess".to_string()),
        hunks: None,
    };
    sup.do_changeset_commit(&request).await;

    let ok = drain_until_action(&mut rx, "changeset_commit_ok");
    let summary = ok["summary"].as_str().expect("summary on _ok");
    assert!(summary.starts_with("committed "), "summary: {summary}");
    assert!(summary.contains("1 file(s) · +1 −0"), "summary: {summary}");

    let rows = shell_ledger
        .list_exchanges_since("sess", None)
        .expect("list");
    assert_eq!(rows.len(), 1, "exactly one /commit row");
    assert_eq!(rows[0].command, "/commit");
    assert_eq!(rows[0].exit_code, Some(0));
    assert_eq!(rows[0].cwd, request.project_dir);
    // The ledger row's output is byte-identical to the live summary.
    assert_eq!(rows[0].output, summary);

    // A commit without a session_id writes no row.
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    let bare = ChangesetCommitPayload {
        project_dir: repo.to_string_lossy().into_owned(),
        files: vec!["a.txt".to_string()],
        message: "Add a third line".to_string(),
        session_id: None,
        hunks: None,
    };
    sup.do_changeset_commit(&bare).await;
    let _ = drain_until_action(&mut rx, "changeset_commit_ok");
    assert_eq!(
        shell_ledger
            .list_exchanges_since("sess", None)
            .expect("list")
            .len(),
        1,
        "the session-less commit added no ledger row",
    );
}
