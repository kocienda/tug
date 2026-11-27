//! `tugtool brief dir` — where a brief is written, and what answers when the
//! setting is missing, empty, or points somewhere else.
//!
//! Every case is a real spawn against a real project directory, because the
//! whole verb is resolution: the project root, the instance's tugbank, the
//! template. A test that called the resolver directly would prove the part
//! that never breaks.
//!
//! Two environment facts shape these tests. `TUG_DATA_DIR` is the isolation —
//! `common/mod.rs` scrubs the ambient session and nothing else, deliberately —
//! and the project path must be **canonicalized** before any assertion: a
//! `tempfile` directory lives under `/var/folders/…` on macOS, `/var` is a
//! symlink to `/private/var`, and `find_project_root()` starts from
//! `std::env::current_dir()`, which reports the resolved spelling.

mod common;
use common::tugtool;

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use tugcore::test_fixtures::git::{GitFixture, git};

/// A project that declares itself with a `.tugtool/` directory and no git.
fn project() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join(".tugtool")).expect("mkdir .tugtool");
    let canonical = dir.path().canonicalize().expect("canonicalize");
    (dir, canonical)
}

/// A data directory holding one instance's tugbank, seeded in-process the way
/// the app's own settings write would. `TUG_DATA_DIR` names the directory the
/// `Tug/` root is made under, so the instance path starts there.
fn seed_tugbank(data_dir: &Path, instance: &str, template: &str) -> PathBuf {
    let db = data_dir
        .join("Tug")
        .join("instances")
        .join(instance)
        .join("tugbank.db");
    fs::create_dir_all(db.parent().unwrap()).expect("mkdir instance dir");
    let store = tugbank_core::DefaultsStore::open(&db).expect("open tugbank");
    store
        .domain("dev.tugapp.app")
        .expect("domain")
        .set("briefs-path", tugbank_core::Value::String(template.into()))
        .expect("set briefs-path");
    db
}

fn stdout_of(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn with_no_instance_the_answer_is_the_projects_own_briefs() {
    let (dir, proj) = project();
    let out = tugtool()
        .current_dir(dir.path())
        .args(["brief", "dir"])
        .output()
        .expect("spawn");
    assert!(out.status.success(), "brief dir exits 0");
    assert_eq!(stdout_of(&out), proj.join("briefs").display().to_string());

    let out = tugtool()
        .current_dir(dir.path())
        .args(["--json", "brief", "dir"])
        .output()
        .expect("spawn");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["source"], "default");
    assert_eq!(json["data"]["exists"], false);
    assert_eq!(json["data"]["template"], "{project_dir}/briefs");
}

#[test]
fn ensure_creates_the_directory() {
    let (dir, proj) = project();
    let out = tugtool()
        .current_dir(dir.path())
        .args(["--json", "brief", "dir", "--ensure"])
        .output()
        .expect("spawn");
    assert!(out.status.success(), "brief dir --ensure exits 0");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["exists"], true);
    assert!(proj.join("briefs").is_dir(), "the directory is on disk");
}

#[test]
fn a_stored_template_moves_the_directory() {
    let (dir, proj) = project();
    let data = tempfile::tempdir().expect("data dir");
    seed_tugbank(data.path(), "brief-test", "{project_dir}/docs/briefs");

    let out = tugtool()
        .current_dir(dir.path())
        .env("TUG_DATA_DIR", data.path())
        .env("TUG_INSTANCE_ID", "brief-test")
        .args(["--json", "brief", "dir"])
        .output()
        .expect("spawn");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["source"], "setting");
    assert_eq!(
        json["data"]["dir"],
        proj.join("docs/briefs").display().to_string()
    );
}

#[test]
fn an_instance_with_no_database_is_a_default_and_creates_nothing() {
    let (dir, proj) = project();
    let data = tempfile::tempdir().expect("data dir");
    let db = data.path().join("Tug/instances/brief-test/tugbank.db");

    let out = tugtool()
        .current_dir(dir.path())
        .env("TUG_DATA_DIR", data.path())
        .env("TUG_INSTANCE_ID", "brief-test")
        .args(["--json", "brief", "dir"])
        .output()
        .expect("spawn");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["source"], "default");
    assert_eq!(
        json["data"]["dir"],
        proj.join("briefs").display().to_string()
    );
    assert!(!db.exists(), "a read never brings a tugbank into being");
}

#[test]
fn an_empty_value_is_unset() {
    let (dir, proj) = project();
    let data = tempfile::tempdir().expect("data dir");
    seed_tugbank(data.path(), "brief-test", "");

    let out = tugtool()
        .current_dir(dir.path())
        .env("TUG_DATA_DIR", data.path())
        .env("TUG_INSTANCE_ID", "brief-test")
        .args(["--json", "brief", "dir"])
        .output()
        .expect("spawn");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["source"], "default");
    assert_eq!(
        json["data"]["dir"],
        proj.join("briefs").display().to_string()
    );
}

#[test]
fn an_absolute_template_is_one_directory_for_every_project() {
    let (dir, _proj) = project();
    let data = tempfile::tempdir().expect("data dir");
    let elsewhere = tempfile::tempdir().expect("elsewhere");
    let all = elsewhere.path().canonicalize().expect("canonicalize");
    seed_tugbank(data.path(), "brief-test", &all.display().to_string());

    let out = tugtool()
        .current_dir(dir.path())
        .env("TUG_DATA_DIR", data.path())
        .env("TUG_INSTANCE_ID", "brief-test")
        .args(["--json", "brief", "dir"])
        .output()
        .expect("spawn");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(json["data"]["source"], "setting");
    assert_eq!(json["data"]["dir"], all.display().to_string());
}

/// A git checkout and a data directory of its own, for the verbs that keep a
/// brief's record.
fn checkout() -> (TempDir, TempDir, PathBuf, PathBuf) {
    let repo_dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let state = state_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    (repo_dir, state_dir, root, state)
}

fn in_checkout(state: &Path, root: &Path, args: &[&str]) -> std::process::Output {
    tugtool()
        .env("TMPDIR", state)
        .env("TUG_DATA_DIR", state)
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn record_writes_the_id_line_and_show_reads_the_record_back() {
    let (_repo, _state, root, state) = checkout();
    fs::create_dir_all(root.join("briefs")).unwrap();
    fs::write(root.join("briefs/store.md"), "# The brief store\n\nFound.\n").unwrap();

    let out = in_checkout(&state, &root, &["brief", "record", "briefs/store.md"]);
    assert!(out.status.success(), "{out:?}");
    let id = stdout_of(&out);
    assert_eq!(id.len(), 8, "an id: {id}");
    let text = fs::read_to_string(root.join("briefs/store.md")).unwrap();
    assert_eq!(text.lines().next(), Some(format!("<!-- tug-brief: {id} -->").as_str()));

    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "brief"]);
    let sha = git(&root, &["rev-parse", "HEAD"]).trim().to_string();

    let shown = in_checkout(&state, &root, &["brief", "show", &id, "--json"]);
    assert!(shown.status.success(), "{shown:?}");
    let data: serde_json::Value = serde_json::from_slice(&shown.stdout).unwrap();
    let data = &data["data"];
    assert_eq!(data["id"], id.as_str());
    assert_eq!(data["path"], "briefs/store.md");
    assert_eq!(data["title"], "The brief store");
    assert_eq!(data["sketches"], serde_json::json!([]));
    assert_eq!(data["versions"][0]["sha"], sha.as_str(), "{data}");

    let by_path = in_checkout(&state, &root, &["brief", "show", "briefs/store.md"]);
    assert!(stdout_of(&by_path).starts_with(&format!("{id}  briefs/store.md")));

    let listed = in_checkout(&state, &root, &["brief", "list"]);
    assert!(stdout_of(&listed).starts_with(&id), "{listed:?}");

    let absent = in_checkout(&state, &root, &["brief", "show", "00ff00ff"]);
    assert_eq!(absent.status.code(), Some(3), "{absent:?}");
    let missing = in_checkout(&state, &root, &["brief", "record", "briefs/none.md"]);
    assert!(!missing.status.success(), "no file, no record");
}
