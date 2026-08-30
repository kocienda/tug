//! `tugtool dash verify` end to end, against a synthesized project that is not
//! Tug.
//!
//! The declared commands are `true`, `false`, and `printf` — a test that ran a
//! real build would be testing the build tool rather than the runner. What is
//! under test is the resolution, the refusal, the exit codes, and the receipt.

use std::path::Path;
use std::process::{Command, Output};

use assert_cmd::cargo::CommandCargoExt;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn tug(tmp: &Path) -> Command {
    let mut cmd = Command::cargo_bin("tugtool").unwrap();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd
}

/// A project with a dash whose worktree carries `config`, and whose one round
/// touches `files`.
fn project(root: &Path, config: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "t"]);
    git(root, &["config", "user.email", "t@t"]);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), config).unwrap();
    std::fs::write(root.join("seed.txt"), "base\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "base"]);

    let worktree = root.join(".tug/worktrees/demo");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugdash/demo",
            worktree.to_str().unwrap(),
        ],
    );
    git(root, &["config", "branch.tugdash/demo.tugbase", "main"]);

    for (path, body) in files {
        let full = worktree.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, body).unwrap();
    }
    if !files.is_empty() {
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "round"]);
    }
    worktree
}

fn verify(tmp: &Path, root: &Path, args: &[&str]) -> Output {
    tug(tmp)
        .args(["dash", "verify", "demo"])
        .args(args)
        .current_dir(root)
        .output()
        .expect("failed to run tugtool dash verify")
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

const TWO_SURFACES: &str = "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"true\"]\n\n[[tugtool.dash.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = []\n";

#[test]
fn a_green_run_names_both_counts_and_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    project(
        &root,
        TWO_SURFACES,
        &[("src/a.rs", "a\n"), ("docs/b.md", "b\n")],
    );

    let output = verify(tmp.path(), &root, &[]);
    let text = stdout_of(&output);
    assert_eq!(output.status.code(), Some(0), "a green run exits 0: {text}");
    assert!(
        text.contains("1 surfaces checked · 1 claimed unchecked"),
        "the receipt must count the two kinds apart: {text}"
    );
    assert!(text.contains("TUG-VERIFY-RECEIPT: verified"), "{text}");
}

#[test]
fn an_unclaimed_path_refuses_before_anything_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    // The declared command would leave a sentinel behind, so "nothing ran" is
    // asserted against the filesystem rather than against the absence of text.
    let worktree = project(
        &root,
        "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"touch ran.sentinel\"]\n",
        &[("src/a.rs", "a\n"), ("other/b.ts", "b\n")],
    );

    let output = verify(tmp.path(), &root, &[]);
    let text = stdout_of(&output);
    assert_eq!(output.status.code(), Some(2), "unclaimed exits 2: {text}");
    assert!(
        text.contains("other/b.ts"),
        "the path must be named: {text}"
    );
    assert!(
        text.contains("[[tugtool.dash.surface]]") && text.contains("\"other/\""),
        "the refusal must print a declaration to paste: {text}"
    );
    assert!(
        text.contains("TUG-VERIFY-RECEIPT: unclaimed 1 paths"),
        "{text}"
    );
    assert!(
        !worktree.join("ran.sentinel").exists(),
        "a refusal must run no check at all"
    );
}

#[test]
fn a_red_surface_does_not_stop_the_run() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(
        &root,
        "[[tugtool.dash.surface]]\nname = \"first\"\npaths = [\"first/\"]\ncheck = [\"false\", \"touch not-reached.sentinel\"]\n\n[[tugtool.dash.surface]]\nname = \"second\"\npaths = [\"second/\"]\ncheck = [\"touch second-ran.sentinel\"]\n",
        &[("first/a.rs", "a\n"), ("second/b.rs", "b\n")],
    );

    let output = verify(tmp.path(), &root, &[]);
    let text = stdout_of(&output);
    assert_eq!(output.status.code(), Some(1), "a red check exits 1: {text}");
    assert!(
        text.contains("TUG-VERIFY-RECEIPT: red 1 surfaces")
            && text.contains("first: `false` (exit 1)"),
        "the receipt must quote the failing command: {text}"
    );
    assert!(
        !worktree.join("not-reached.sentinel").exists(),
        "a red command ends its own surface"
    );
    assert!(
        worktree.join("second-ran.sentinel").exists(),
        "every surface still runs, so one report names every failure"
    );
}

#[test]
fn a_project_with_no_surfaces_exits_zero_and_says_so() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    project(
        &root,
        "[tugtool.dash]\npost_create = []\n",
        &[("a.rs", "a\n")],
    );

    let output = verify(tmp.path(), &root, &[]);
    let text = stdout_of(&output);
    assert_eq!(output.status.code(), Some(0), "{text}");
    assert!(
        text.contains("TUG-VERIFY-RECEIPT: this project declares no surfaces"),
        "{text}"
    );
}

#[test]
fn an_empty_range_reports_the_range_and_runs_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(
        &root,
        "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"touch ran.sentinel\"]\n",
        &[("src/a.rs", "a\n")],
    );
    let head = git_stdout(&worktree, &["rev-parse", "HEAD"]);

    let output = verify(tmp.path(), &root, &["--base", &head, "--head", &head]);
    let text = stdout_of(&output);
    assert_eq!(output.status.code(), Some(0), "{text}");
    assert!(
        text.contains("TUG-VERIFY-RECEIPT: nothing in range"),
        "{text}"
    );
    assert!(
        !worktree.join("ran.sentinel").exists(),
        "an empty range runs nothing"
    );
}

#[test]
fn paths_reach_the_shell_scoped_to_their_own_surface() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(
        &root,
        "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"printf '%s\\\\n' {paths} > out.txt\"]\n\n[[tugtool.dash.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = []\n",
        &[
            ("src/a.rs", "a\n"),
            ("src/b.rs", "b\n"),
            ("docs/c.md", "c\n"),
        ],
    );

    let output = verify(tmp.path(), &root, &[]);
    assert_eq!(output.status.code(), Some(0), "{}", stdout_of(&output));
    let written = std::fs::read_to_string(worktree.join("out.txt")).expect("the command ran");
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(
        lines,
        vec!["src/a.rs", "src/b.rs"],
        "{{paths}} carries this surface's own paths and no others"
    );
}

#[test]
fn the_derived_range_is_the_dashs_own_contribution_and_the_overrides_narrow_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let worktree = project(&root, TWO_SURFACES, &[("src/a.rs", "a\n")]);
    // A second round, so the derived range spans both and an override can
    // name just one.
    std::fs::create_dir_all(worktree.join("docs")).unwrap();
    std::fs::write(worktree.join("docs/second.md"), "second\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-m", "second round"]);

    let derived: serde_json::Value =
        serde_json::from_str(&stdout_of(&verify(tmp.path(), &root, &["--json"])))
            .expect("valid JSON");
    let merge_base = git_stdout(&root, &["merge-base", "main", "tugdash/demo"]);
    let tip = git_stdout(&root, &["rev-parse", "tugdash/demo"]);
    assert_eq!(derived["data"]["base"], merge_base);
    assert_eq!(derived["data"]["head"], tip);
    // Both rounds are in the derived range, so both surfaces are in the run.
    assert_eq!(derived["data"]["surfaces"].as_array().unwrap().len(), 2);

    // Narrowed to the second round alone, only `docs` moved.
    let first = git_stdout(&worktree, &["rev-parse", "HEAD~1"]);
    let narrowed: serde_json::Value = serde_json::from_str(&stdout_of(&verify(
        tmp.path(),
        &root,
        &["--json", "--base", &first, "--head", &tip],
    )))
    .expect("valid JSON");
    let surfaces = narrowed["data"]["surfaces"].as_array().unwrap();
    assert_eq!(surfaces.len(), 1);
    assert_eq!(surfaces[0]["name"], "docs");
}

#[test]
fn json_carries_the_same_verdict_counts_and_receipt_as_the_text() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    project(
        &root,
        TWO_SURFACES,
        &[("src/a.rs", "a\n"), ("docs/b.md", "b\n")],
    );

    let text = stdout_of(&verify(tmp.path(), &root, &[]));
    let receipt = text
        .lines()
        .find(|l| l.starts_with("TUG-VERIFY-RECEIPT:"))
        .expect("the text output closes with a receipt");

    let json: serde_json::Value =
        serde_json::from_str(&stdout_of(&verify(tmp.path(), &root, &["--json"])))
            .expect("valid JSON");
    assert_eq!(json["command"], "dash verify");
    assert_eq!(json["data"]["verdict"], "verified");
    assert_eq!(json["data"]["checked"], 1);
    assert_eq!(json["data"]["claimed_unchecked"], 1);
    assert_eq!(json["data"]["receipt"], receipt);
}

#[test]
fn a_name_that_is_no_dash_refuses_the_way_status_does() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    project(&root, TWO_SURFACES, &[("src/a.rs", "a\n")]);

    let output = tug(tmp.path())
        .args(["dash", "verify", "ghost"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_ne!(output.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Dash not found: ghost"),
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
}
