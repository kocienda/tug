//! `tugtool arc commit` running a surface's `commit_check`, end to end, against
//! a synthesized project that is not Tug.
//!
//! The declared check is a shell line that prints and exits 1 — a test that
//! ran a real type checker would be testing the type checker. What is under
//! test is that the check runs over the round's claimed paths, that a red one
//! refuses the commit with the surface and the output named, and that a round
//! outside the surface's `commit_check_only` filter lands without it.

mod common;
use common::tugtool;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::path::Path;
use std::process::{Command, Output};

fn tug(tmp: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd
}

const CHECKED_SRC: &str = "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = []\ncommit_check = [\"sh -c 'echo deliberate type error; exit 1'\"]\ncommit_check_only = [\"*.ts\"]\n";

/// A project carrying `config`, with the arc `demo` created by the real verb.
fn project(tmp: &Path, root: &Path, config: &str) -> std::path::PathBuf {
    GitFixture::init(root);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), config).unwrap();
    std::fs::write(root.join("seed.txt"), "base\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "base"]);

    let create = tug(tmp)
        .args(["arc", "create", "demo"])
        .current_dir(root)
        .output()
        .expect("failed to run tugtool arc create");
    assert!(
        create.status.success(),
        "arc create: {}",
        String::from_utf8_lossy(&create.stderr)
    );
    root.join(".tug/worktrees/demo")
}

fn touch(worktree: &Path, path: &str) {
    let full = worktree.join(path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, "work\n").unwrap();
}

fn commit(tmp: &Path, root: &Path, subject: &str) -> Output {
    tug(tmp)
        .args(["arc", "commit", "demo", "--message", subject])
        .current_dir(root)
        .output()
        .expect("failed to run tugtool arc commit")
}

fn head(dir: &Path) -> String {
    let out = tugcore::test_fixtures::git::command()
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn a_red_commit_check_refuses_the_round_naming_the_surface_and_the_output() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let root = tmp.join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(&tmp, &root, CHECKED_SRC);
    let before = head(&worktree);
    touch(&worktree, "src/a.ts");

    let output = commit(&tmp, &root, "tugarc(demo): a typescript round");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "a red check is a refused commit: {stderr}"
    );
    assert!(
        stderr.contains("deliberate type error"),
        "the check's output is on stderr: {stderr}"
    );
    assert!(stderr.contains("src"), "the surface is named: {stderr}");
    assert_eq!(head(&worktree), before, "no commit was made");
}

#[test]
fn a_round_outside_the_filter_commits_without_running_the_check() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let root = tmp.join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(&tmp, &root, CHECKED_SRC);
    let before = head(&worktree);
    touch(&worktree, "src/a.rs");

    let output = commit(&tmp, &root, "tugarc(demo): a rust round");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "a Rust-only round pays nothing: {stderr}"
    );
    assert!(
        !stderr.contains("deliberate type error"),
        "the check did not run: {stderr}"
    );
    assert_ne!(head(&worktree), before, "the round landed");
}
