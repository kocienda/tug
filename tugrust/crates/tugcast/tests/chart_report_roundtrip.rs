//! Live round-trip proof for `POST /api/chart/report`.
//!
//! Spins up a real `tugcast` subprocess, posts report reads over HTTP against
//! a committed git working tree, and asserts the row records that come back —
//! exercising the route's registration, its JSON extraction, the three status
//! codes a caller branches on, and the wire shape of a page.
//!
//! Needs only `git` + the harness's `tmux` session; no `claude`.
//!
//! Run: `cargo nextest run -p tugcast --test chart_report_roundtrip`

use std::path::Path;

use tempfile::{NamedTempFile, TempDir};

mod common;
use common::TestTugcast;

use tugcore::test_fixtures::git::{GitFixture, git};

/// A committed repo on `main` with three commits, and their shas oldest
/// first.
fn make_repo() -> (TempDir, Vec<String>) {
    let temp = TempDir::new().expect("repo tempdir");
    let repo = temp.path();
    GitFixture::init(repo);
    let mut shas = Vec::new();
    for subject in ["first", "second", "third"] {
        std::fs::write(repo.join(format!("{subject}.txt")), "x\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", subject]);
        shas.push(git(repo, &["rev-parse", "HEAD"]).trim().to_string());
    }
    (temp, shas)
}

/// Spawn tugcast over `repo` with every machine-global ledger it might open
/// pointed into `scratch`, so the run leaves nothing in the developer's own.
async fn spawn(repo: &Path, scratch: &Path) -> TestTugcast {
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let index = scratch.join("session_index.db");
    let gaps = scratch.join("report_gaps.db");
    let semantic = scratch.join("semantic.db");
    TestTugcast::spawn_with_env(
        repo,
        bank_path,
        None,
        &[
            ("TUG_SESSION_INDEX_DB", index.to_str().unwrap()),
            ("TUG_REPORT_GAPS_DB", gaps.to_str().unwrap()),
            ("TUG_SEMANTIC_DB", semantic.to_str().unwrap()),
        ],
    )
    .await
}

async fn post(port: u16, body: String) -> (u16, serde_json::Value) {
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/chart/report"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .expect("the route answers");
    let status = response.status().as_u16();
    let text = response.text().await.expect("a body");
    let json = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("a JSON body, got {text:?}: {e}"));
    (status, json)
}

#[tokio::test]
async fn the_report_route_describes_commits_over_http() {
    let (repo, shas) = make_repo();
    let scratch = TempDir::new().expect("scratch tempdir");
    let tc = spawn(repo.path(), scratch.path()).await;
    let project = repo.path().to_string_lossy().to_string();

    let (status, page) = post(
        tc.port,
        serde_json::json!({
            "project": project,
            "refs": [format!("commit:{}", shas[2]), format!("commit:{}", &shas[0][..10])],
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, 200, "{page:#}");
    assert_eq!(page["status"], "ok");
    assert_eq!(page["total"], 2);
    assert_eq!(page["moved"], false);
    assert!(page["sum"].is_null() && page["measure"].is_null());
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows[0]["kind"], "commit");
    assert_eq!(rows[0]["ref"], format!("commit:{}", shas[2]));
    assert_eq!(rows[0]["found"], true);
    assert_eq!(rows[0]["commit"]["subject"], "third");
    assert_eq!(rows[0]["commit"]["sha"], shas[2]);
    assert_eq!(rows[1]["commit"]["subject"], "first");
    assert!(rows[1]["measure"].is_null() && rows[1]["group"].is_null());

    // The statuses a caller branches on, each with the error body's shape.
    let (status, refused) = post(
        tc.port,
        serde_json::json!({"project": project}).to_string(),
    )
    .await;
    assert_eq!(status, 400, "{refused:#}");
    assert_eq!(refused["status"], "error");
    assert!(refused["message"].is_string());

    let (status, malformed) = post(tc.port, "{\"refs\": 7}".to_string()).await;
    assert_eq!(status, 400, "{malformed:#}");
    assert_eq!(malformed["status"], "error");

    let (status, stranger) = post(
        tc.port,
        serde_json::json!({
            "project": project,
            "source": {"recipe": "no-such-recipe", "args": {}},
            "address": {"row": 0, "label": "x", "col": null, "series": null, "item": null, "whole_row": false},
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, 404, "{stranger:#}");
    assert_eq!(stranger["status"], "error");
}
