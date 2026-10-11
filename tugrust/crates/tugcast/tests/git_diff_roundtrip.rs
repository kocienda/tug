//! Live round-trip proof for the `/diff` sourcing path ([#step-10a]).
//!
//! Spins up a real `tugcast` subprocess pointed at a deliberately dirtied
//! git working tree, connects a WebSocket client, fires a `GIT_DIFF_QUERY`
//! frame, and asserts the single-shot `GIT_DIFF` response carries the right
//! files / stats for that project dir — exercising the full wire path
//! (frame ingress → router → registry resolution → `git diff HEAD` →
//! serialize → broadcast) before any `/diff` UI exists.
//!
//! Needs only `git` + the harness's `tmux` session; no `claude`, so it runs
//! in the default suite (unlike the `#[ignore]`-gated real-claude tests).
//!
//! Run: `cargo nextest run -p tugcast --test git_diff_roundtrip`

use std::time::Duration;

use tempfile::{NamedTempFile, TempDir};

mod common;
use common::{TestTugcast, TestWs};

const WIRE_TIMEOUT: Duration = Duration::from_secs(10);

use tugcore::test_fixtures::git::{GitFixture, git};

/// Create a committed repo, then dirty it with one of each change kind
/// (modify / delete / rename / add), staged so `git diff HEAD` shows all.
fn make_dirty_repo() -> TempDir {
    let temp = TempDir::new().expect("repo tempdir");
    let repo = temp.path();
    GitFixture::init(repo);
    std::fs::write(repo.join("keep.txt"), "v1\n").unwrap();
    std::fs::write(repo.join("del.txt"), "delete me\n").unwrap();
    std::fs::write(repo.join("ren_src.txt"), "rename me\n").unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", "init"]);

    std::fs::write(repo.join("keep.txt"), "v2\n").unwrap();
    git(repo, &["rm", "del.txt"]);
    git(repo, &["mv", "ren_src.txt", "ren_dst.txt"]);
    std::fs::write(repo.join("new.txt"), "fresh line\n").unwrap();
    git(repo, &["add", "-A"]);
    temp
}

fn file_by_path<'a>(resp: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
    resp["files"]
        .as_array()
        .expect("files array")
        .iter()
        .find(|f| f["path"] == path)
        .unwrap_or_else(|| panic!("no file entry for {path} in {resp:#}"))
}

#[tokio::test]
async fn git_diff_query_returns_project_dir_diff() {
    let repo = make_dirty_repo();

    // Spawn tugcast with the dirty repo as its `--source-tree` (bootstrap
    // workspace). A `root: None` query then resolves to bootstrap → diffs
    // this repo.
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_git_diff_query(None, "rt-1").await;
    let resp = ws
        .await_git_diff("rt-1", WIRE_TIMEOUT)
        .await
        .expect("git_diff response");

    // Correlation + summary.
    assert_eq!(resp["request_id"], "rt-1");
    assert_eq!(resp["base"], "HEAD");
    assert!(
        resp["workspace_key"]
            .as_str()
            .is_some_and(|k| !k.is_empty()),
        "response must carry the resolved workspace_key",
    );
    assert_eq!(
        resp["file_count"], 4,
        "modify + delete + rename + add (got {resp:#})",
    );

    // One of each status, with the rename carrying its old path.
    assert_eq!(file_by_path(&resp, "keep.txt")["status"], "modified");
    assert_eq!(file_by_path(&resp, "new.txt")["status"], "added");
    assert_eq!(file_by_path(&resp, "del.txt")["status"], "deleted");
    let renamed = file_by_path(&resp, "ren_dst.txt");
    assert_eq!(renamed["status"], "renamed");
    assert_eq!(renamed["old_path"], "ren_src.txt");

    // The modified file's unified chunk renders as a real hunk.
    let keep = file_by_path(&resp, "keep.txt");
    assert!(
        keep["unified"].as_str().unwrap().contains("@@"),
        "unified text must include at least one hunk header",
    );

    // Header totals equal the sum across files.
    let summed_added: u64 = resp["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["added"].as_u64().unwrap())
        .sum();
    let summed_removed: u64 = resp["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["removed"].as_u64().unwrap())
        .sum();
    assert_eq!(resp["total_added"].as_u64().unwrap(), summed_added);
    assert_eq!(resp["total_removed"].as_u64().unwrap(), summed_removed);
}

#[tokio::test]
async fn git_diff_query_clean_tree_reports_no_files() {
    let temp = TempDir::new().expect("repo tempdir");
    let repo = temp.path();
    GitFixture::init(repo);
    std::fs::write(repo.join("a.txt"), "stable\n").unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", "init"]);

    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo, bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_git_diff_query(Some(repo), "rt-clean").await;
    let resp = ws
        .await_git_diff("rt-clean", WIRE_TIMEOUT)
        .await
        .expect("git_diff response");

    assert_eq!(resp["file_count"], 0);
    assert!(resp["files"].as_array().unwrap().is_empty());
    assert_eq!(resp["total_added"], 0);
    assert_eq!(resp["total_removed"], 0);
}
