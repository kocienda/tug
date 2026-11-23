//! The docket loop's CLI surface: the flags that open a successor arc, and
//! `arc follow-up`, and `arc revert`.
//!
//! A usage error is refused by the argument parser before any repository,
//! session or server is consulted, so these run from a scratch directory with
//! a scratch data root and nothing else.

mod common;
use common::tugtool;

fn run(args: &[&str]) -> std::process::Output {
    let state = tempfile::tempdir().unwrap();
    let mut cmd = tugtool();
    cmd.env("TUG_DATA_DIR", state.path());
    cmd.env("TMPDIR", state.path());
    cmd.current_dir(state.path());
    cmd.args(args).output().unwrap()
}

#[test]
fn successor_of_without_from_is_a_usage_error() {
    let out = run(&["arc", "run", "next-v2", "--successor-of", "next"]);
    assert_eq!(out.status.code(), Some(2), "clap's usage exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--from"), "{stderr}");
}

#[test]
fn from_without_successor_of_is_a_usage_error() {
    let out = run(&["arc", "run", "next-v2", "--from", "abc123"]);
    assert_eq!(out.status.code(), Some(2), "clap's usage exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--successor-of"), "{stderr}");
}

/// `arc follow-up` writes one log line per new line and answers its k; a
/// repeat answers the first k and writes nothing, and a name with no record
/// is refused.
#[test]
fn follow_up_round_trips_through_the_log() {
    use tugcore::test_fixtures::git::{GitFixture, git};
    let repo_dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let state = state_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    let paths = tugcore::instance::Paths::under(&state);
    let log = tugtool_core::paths::arc_log_path_at(&paths, &root);
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, "2026-11-01T00:00:00Z  rail  arc-start  brief.md\n").unwrap();

    let follow = |line: &str| {
        let mut cmd = tugtool();
        cmd.env("TUG_DATA_DIR", &state);
        cmd.env("TMPDIR", &state);
        cmd.current_dir(&root);
        cmd.args(["arc", "follow-up", "rail", line, "--json"])
            .output()
            .unwrap()
    };
    let k_of = |out: std::process::Output| -> serde_json::Value {
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        v["data"]["k"].clone()
    };
    assert_eq!(k_of(follow("Name the rails")), 1);
    assert_eq!(k_of(follow("Paint the rails")), 2);
    assert_eq!(
        k_of(follow("Name the rails")),
        1,
        "a repeat answers its first k"
    );
    let text = std::fs::read_to_string(&log).unwrap();
    assert_eq!(text.matches("follow-up").count(), 2, "{text}");
    assert!(
        text.contains("rail  follow-up  2 Paint the rails"),
        "{text}"
    );

    let mut cmd = tugtool();
    cmd.env("TUG_DATA_DIR", &state);
    cmd.env("TMPDIR", &state);
    cmd.current_dir(&root);
    let none = cmd
        .args(["arc", "follow-up", "nobody", "x"])
        .output()
        .unwrap();
    assert_eq!(none.status.code(), Some(2), "an unknown arc is not found");
}

/// `arc revert --dry-run --json` names the join's paths and the later base
/// commits that touched them, with the arc each one landed, and commits
/// nothing.
#[test]
fn revert_dry_run_reports_paths_and_later_commits() {
    use tugcore::test_fixtures::git::{GitFixture, git};
    let repo_dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let state = state_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    std::fs::write(root.join("a.txt"), "rail\n").unwrap();
    std::fs::write(root.join("b.txt"), "rail\n").unwrap();
    git(&root, &["add", "-A"]);
    git(
        &root,
        &[
            "commit",
            "-q",
            "-m",
            "Lay the rail\n\nTug-Arc: tugarc/rail onto main",
        ],
    );
    let join = git(&root, &["rev-parse", "--short", "HEAD"])
        .trim()
        .to_owned();
    std::fs::write(root.join("a.txt"), "rail, oiled\n").unwrap();
    git(&root, &["add", "-A"]);
    git(
        &root,
        &[
            "commit",
            "-q",
            "-m",
            "Oil the rail\n\nTug-Arc: tugarc/oil onto main",
        ],
    );
    let head = git(&root, &["rev-parse", "HEAD"]);
    let paths = tugcore::instance::Paths::under(&state);
    let log = tugtool_core::paths::arc_log_path_at(&paths, &root);
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(
        &log,
        format!(
            "2026-11-01T00:00:00Z  rail  arc-start  brief.md\n2026-11-01T00:00:05Z  rail  {join}  joined via card\n"
        ),
    )
    .unwrap();

    let mut cmd = tugtool();
    cmd.env("TUG_DATA_DIR", &state);
    cmd.env("TMPDIR", &state);
    cmd.current_dir(&root);
    let out = cmd
        .args(["arc", "revert", "rail", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let data = &v["data"];
    assert_eq!(data["paths"], serde_json::json!(["a.txt", "b.txt"]));
    assert_eq!(data["base"], "main");
    assert_eq!(data["later"].as_array().unwrap().len(), 1, "{data}");
    assert_eq!(data["later"][0]["arc"], "oil");
    assert_eq!(data["later"][0]["subject"], "Oil the rail");
    assert!(data.get("reverted").is_none(), "{data}");
    assert_eq!(
        git(&root, &["rev-parse", "HEAD"]),
        head,
        "nothing committed"
    );
}
