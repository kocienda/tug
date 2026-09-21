//! `tugtool arc doctor` reading the base checkout, end to end.
//!
//! The state is the one a join that lost the base's index lock used to leave:
//! the arc's squash staged on the base, never committed, `SQUASH_MSG`
//! standing. None of the arc's own records is wrong, so what is under test is
//! that the verb does not say they agree — its text, its exit code, its
//! `--json` shape — and that it does once `resolve-base` has run.

mod common;
use common::tugtool;

use std::path::Path;
use std::process::{Command, Output};

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

fn tug(tmp: &Path, root: &Path, args: &[&str]) -> Output {
    let mut cmd = tugtool();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd.args(args)
        .current_dir(root)
        .output()
        .expect("failed to run tugtool")
}

/// A project whose arc `demo` edits one file and adds another, with that
/// squash staged on the base and left there.
fn stranded_project(root: &Path) {
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.name", "t"]);
    git(root, &["config", "user.email", "t@t"]);
    std::fs::write(root.join("seed.txt"), "base\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "base"]);

    let worktree = root.join(".tug/worktrees/demo");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugarc/demo",
            worktree.to_str().unwrap(),
        ],
    );
    git(root, &["config", "branch.tugarc/demo.tugbase", "main"]);
    std::fs::write(worktree.join("seed.txt"), "base\narc\n").unwrap();
    std::fs::write(worktree.join("added.txt"), "new\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-qm", "round"]);

    git(root, &["merge", "-q", "--squash", "tugarc/demo"]);
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn the_doctor_names_the_stranded_base_and_the_verb_that_clears_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    stranded_project(&root);

    let output = tug(tmp.path(), &root, &["arc", "doctor", "demo"]);
    let said = text(&output);
    assert_eq!(output.status.code(), Some(1), "unhealthy exits 1: {said}");
    assert!(!said.contains("The records agree."), "{said}");
    assert!(said.contains("[base-squash-standing]"), "{said}");
    assert!(said.contains("[base-echo]"), "{said}");
    assert!(said.contains("added.txt"), "{said}");
    assert!(said.contains("tugtool arc resolve-base demo"), "{said}");

    let output = tug(tmp.path(), &root, &["arc", "doctor", "demo", "--json"]);
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|e| panic!("{e}: {}", text(&output)));
    let findings = json["data"]["findings"].as_array().expect("findings");
    let codes: Vec<&str> = findings
        .iter()
        .map(|f| f["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, vec!["base-squash-standing", "base-echo"]);
    for finding in findings {
        assert!(finding["sentence"].as_str().unwrap().contains("resolve-base"));
        assert!(finding.get("repair").is_none(), "no automatic repair");
    }
    assert_eq!(json["data"]["left_for_a_person"], 2);

    let resolved = tug(tmp.path(), &root, &["arc", "resolve-base", "demo"]);
    assert_eq!(resolved.status.code(), Some(0), "{}", text(&resolved));

    let output = tug(tmp.path(), &root, &["arc", "doctor", "demo"]);
    let said = text(&output);
    assert_eq!(output.status.code(), Some(0), "{said}");
    assert!(said.contains("The records agree."), "{said}");
}
