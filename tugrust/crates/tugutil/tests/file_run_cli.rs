//! Integration tests for `tugutil file run`, driving the built binary against a
//! real temp git repo.
//!
//! The verb's contract is the receipt: exactly the files whose **content** the
//! wrapped command moved, and nothing it merely touched. These assert on that
//! line, on the tree the command left behind, and on the exit status it carries
//! through.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use assert_cmd::cargo::CommandCargoExt;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
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

/// A temp git repo with one committed file, one in a subdirectory, and an
/// ignored directory that must never enter the universe.
fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@t.test"]);
    git(&root, &["config", "user.name", "t"]);
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::create_dir_all(root.join("build")).unwrap();
    std::fs::write(root.join(".gitignore"), "build\n").unwrap();
    std::fs::write(root.join("keep.txt"), "a\n").unwrap();
    std::fs::write(root.join("change.txt"), "b\n").unwrap();
    std::fs::write(root.join("sub/deep.txt"), "c\n").unwrap();
    std::fs::write(root.join("build/artifact.txt"), "ignored\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "init"]);
    (dir, root)
}

/// Run `file run` in `root`, wrapping `script` under `sh -c`.
fn run(root: &Path, extra: &[&str], script: &str) -> Output {
    let mut cmd = Command::cargo_bin("tugutil").unwrap();
    cmd.current_dir(root).args(["file", "run"]);
    cmd.args(extra);
    cmd.args(["--", "sh", "-c", script]);
    cmd.output().expect("run tugutil file run")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn receipt(out: &Output) -> String {
    stdout(out)
        .lines()
        .find(|l| l.starts_with("TUG-FILE-RECEIPT: "))
        .unwrap_or_default()
        .to_string()
}

#[test]
fn the_receipt_names_what_moved_and_how() {
    let (_dir, root) = init_repo();
    let out = run(
        &root,
        &[],
        "printf 'B\\n' > change.txt; printf 'new\\n' > added.txt; rm sub/deep.txt",
    );
    assert!(out.status.success());

    let line = receipt(&out);
    assert!(line.contains(r#""op":"created""#), "{line}");
    assert!(line.contains("added.txt"), "{line}");
    assert!(line.contains(r#""op":"modified""#), "{line}");
    assert!(line.contains("change.txt"), "{line}");
    assert!(line.contains(r#""op":"deleted""#), "{line}");
    assert!(line.contains("deep.txt"), "{line}");
}

#[test]
fn a_file_only_touched_is_not_in_the_receipt() {
    // The whole reason the universe is fingerprinted by content rather than by
    // mtime: a build step that rewrites a file identically, or merely stats and
    // touches it, has not earned a row.
    let (_dir, root) = init_repo();
    let out = run(&root, &[], "touch keep.txt; cp change.txt /tmp/x; cat keep.txt");
    assert!(out.status.success());
    assert_eq!(receipt(&out), "", "a touch-only run receipted something");
}

#[test]
fn a_run_that_changes_nothing_prints_no_receipt() {
    let (_dir, root) = init_repo();
    let out = run(&root, &[], "echo hello");
    assert!(out.status.success());
    assert!(stdout(&out).contains("hello"), "the child's own output passes through");
    assert_eq!(receipt(&out), "");
}

#[test]
fn an_ignored_file_is_outside_the_universe() {
    let (_dir, root) = init_repo();
    let out = run(&root, &[], "printf 'rebuilt\\n' > build/artifact.txt");
    assert!(out.status.success());
    assert_eq!(
        receipt(&out),
        "",
        "an ignored path must never reach the receipt"
    );
}

#[test]
fn a_scope_narrows_what_can_be_claimed() {
    let (_dir, root) = init_repo();
    let out = run(
        &root,
        &["--scope", "sub"],
        "printf 'X\\n' > sub/deep.txt; printf 'Y\\n' > change.txt",
    );
    assert!(out.status.success());

    let line = receipt(&out);
    assert!(line.contains("deep.txt"), "{line}");
    assert!(
        !line.contains("change.txt"),
        "a path outside the scope was claimed: {line}"
    );
    // The command still did its work — the scope bounds the claim, not the run.
    assert_eq!(
        std::fs::read_to_string(root.join("change.txt")).unwrap(),
        "Y\n"
    );
}

#[test]
fn the_childs_exit_status_carries_through_and_the_receipt_still_lands() {
    // A formatter that fails partway still moved bytes, and those bytes are
    // this session's to answer for.
    let (_dir, root) = init_repo();
    let out = run(&root, &[], "printf 'Z\\n' > change.txt; exit 3");
    assert_eq!(out.status.code(), Some(3));
    assert!(receipt(&out).contains("change.txt"), "{}", receipt(&out));
}

#[test]
fn a_scope_outside_the_repository_is_refused() {
    let (_dir, root) = init_repo();
    let out = run(&root, &["--scope", "/etc"], "true");
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("outside the repository"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn no_command_is_refused_rather_than_treated_as_a_no_op() {
    let (_dir, root) = init_repo();
    let out = Command::cargo_bin("tugutil")
        .unwrap()
        .current_dir(&root)
        .args(["file", "run"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("no command to run"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
