//! Live round-trip proof for the Git History `git log` sourcing path.
//!
//! Spins up a real `tugcast` subprocess pointed at a committed git working
//! tree, connects a WebSocket client, fires a `GIT_LOG_QUERY` frame, and
//! asserts the single-shot `GIT_LOG` response carries the repo's real commits
//! (most-recent-first, correct branch, echoed `request_id`, honored `limit`) —
//! exercising the full wire path (frame ingress → router → registry resolution
//! → `git log` → serialize → broadcast) before any UI exists.
//!
//! Needs only `git` + the harness's `tmux` session; no `claude`, so it runs in
//! the default suite (unlike the `#[ignore]`-gated real-claude tests).
//!
//! Run: `cargo nextest run -p tugcast --test git_log_roundtrip`

use std::time::Duration;

use tempfile::{NamedTempFile, TempDir};

mod common;
use common::{TestTugcast, TestWs};

const WIRE_TIMEOUT: Duration = Duration::from_secs(10);

use tugcore::test_fixtures::git::{GitFixture, git};

/// Create a committed repo on `main` with three commits whose subjects are,
/// oldest to newest, `first`/`second`/`third`.
fn make_log_repo() -> TempDir {
    let temp = TempDir::new().expect("repo tempdir");
    let repo = temp.path();
    GitFixture::init(repo);
    for subject in ["first", "second", "third"] {
        std::fs::write(repo.join(format!("{subject}.txt")), "x\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", subject]);
    }
    temp
}

fn subjects(resp: &serde_json::Value) -> Vec<String> {
    resp["commits"]
        .as_array()
        .expect("commits array")
        .iter()
        .map(|c| c["subject"].as_str().expect("subject").to_string())
        .collect()
}

#[tokio::test]
async fn git_log_query_returns_recent_commits() {
    let repo = make_log_repo();

    // Spawn tugcast with the repo as its `--source-tree` (bootstrap
    // workspace). A `root: None` query resolves to bootstrap → logs this repo.
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_git_log_query(None, "gl-rt-1", None).await;
    let resp = ws
        .await_git_log("gl-rt-1", WIRE_TIMEOUT)
        .await
        .expect("git_log response");

    assert_eq!(resp["request_id"], "gl-rt-1");
    assert_eq!(resp["branch"], "main");
    assert_eq!(resp["no_repo"], false);
    assert!(
        resp["workspace_key"]
            .as_str()
            .is_some_and(|k| !k.is_empty()),
        "response must carry the resolved workspace_key",
    );
    assert_eq!(
        subjects(&resp),
        ["third", "second", "first"],
        "most-recent-first (got {resp:#})",
    );
    // The head commit carries a full 40-char sha for future affordances.
    let head_sha = resp["commits"][0]["sha"].as_str().unwrap();
    assert_eq!(head_sha.len(), 40);
}

#[tokio::test]
async fn git_log_query_honors_limit() {
    let repo = make_log_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_git_log_query(Some(repo.path()), "gl-rt-2", Some(2))
        .await;
    let resp = ws
        .await_git_log("gl-rt-2", WIRE_TIMEOUT)
        .await
        .expect("git_log response");

    assert_eq!(subjects(&resp), ["third", "second"], "the newest two only");
}

#[tokio::test]
async fn git_log_query_reads_explicit_root_not_bootstrap() {
    // Bootstrap source-tree is repo A; the query names an UNREGISTERED repo B.
    // The log must come from B (the explicit root), not fall back to A — the
    // restore race where a followed card's workspace isn't registered yet.
    let repo_a = make_log_repo();
    let temp_b = TempDir::new().expect("repo b tempdir");
    let repo_b = temp_b.path();
    GitFixture::init(repo_b);
    std::fs::write(repo_b.join("only-in-b.txt"), "b\n").unwrap();
    git(repo_b, &["add", "-A"]);
    git(repo_b, &["commit", "-m", "b-only-commit"]);

    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo_a.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_git_log_query(Some(repo_b), "gl-rt-b", None).await;
    let resp = ws
        .await_git_log("gl-rt-b", WIRE_TIMEOUT)
        .await
        .expect("git_log response");

    assert_eq!(
        subjects(&resp),
        ["b-only-commit"],
        "explicit root B, not bootstrap A (got {resp:#})",
    );
}

#[tokio::test]
async fn git_log_query_correlates_two_rapid_requests() {
    let repo = make_log_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    // Two queries with distinct request_ids fired back-to-back; the broadcast
    // response for each must correlate by request_id (client-side).
    ws.send_git_log_query(None, "gl-rt-a", Some(1)).await;
    ws.send_git_log_query(None, "gl-rt-b", None).await;

    let resp_b = ws
        .await_git_log("gl-rt-b", WIRE_TIMEOUT)
        .await
        .expect("git_log response b");
    let resp_a = ws
        .await_git_log("gl-rt-a", WIRE_TIMEOUT)
        .await
        .expect("git_log response a");

    assert_eq!(resp_a["request_id"], "gl-rt-a");
    assert_eq!(subjects(&resp_a), ["third"], "limit 1 honored for a");
    assert_eq!(resp_b["request_id"], "gl-rt-b");
    assert_eq!(subjects(&resp_b), ["third", "second", "first"]);
}
