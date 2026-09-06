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
