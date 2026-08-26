//! Integration tests for `tugutil file rev` and the `tugrev` binary, driving
//! the built binaries against a real temp git repo.
//!
//! The contract under test is the verb's, not the language's: the receipt names
//! exactly the files whose bytes moved, `--preview` touches neither bytes nor
//! mtime, and the exit codes say which phase refused. The language's own
//! semantics are proved in `tugrev-core` against an in-memory source, and the
//! relay side of the receipt is already covered by `attribution.rs`, so nothing
//! here stands up a substitute for either.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::SystemTime;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?} failed");
}

fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@t.test"]);
    git(&root, &["config", "user.name", "t"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(root.join("b.txt"), "alpha\nbeta\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "init"]);
    (dir, root)
}

/// Run a program through a binary, feeding it on stdin the way a heredoc does.
fn run(binary: Command, root: &Path, program: &str) -> Output {
    let mut binary = binary;
    let mut child = binary
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(program.as_bytes())
        .expect("write program");
    child.wait_with_output().expect("wait")
}

fn rev(root: &Path, args: &[&str], program: &str) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugutil"));
    cmd.args(["file", "rev"]).args(args);
    run(cmd, root, program)
}

fn tugrev(root: &Path, args: &[&str], program: &str) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugrev"));
    cmd.args(args);
    run(cmd, root, program)
}

fn receipt_ops(out: &Output) -> Vec<serde_json::Value> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .find_map(|l| l.strip_prefix("TUG-FILE-RECEIPT: "))
        .unwrap_or_else(|| panic!("no receipt in output: {stdout}"));
    let parsed: serde_json::Value = serde_json::from_str(line).expect("receipt is valid json");
    parsed["ops"].as_array().expect("ops array").clone()
}

fn has_receipt(out: &Output) -> bool {
    String::from_utf8_lossy(&out.stdout).contains("TUG-FILE-RECEIPT: ")
}

fn code(out: &Output) -> i32 {
    out.status.code().expect("an exit code")
}

fn mtime(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

#[test]
fn a_multi_pair_program_edits_one_file_and_receipts_the_regions_it_produced() {
    let (_dir, root) = init_repo();
    let out = rev(
        &root,
        &[],
        "file a.txt\n  replace 'one' with 'uno'\n  replace 'three' with 'tres'\n",
    );
    assert_eq!(code(&out), 0);
    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["op"], "modified");
    assert_eq!(ops[0]["path"], root.join("a.txt").to_string_lossy().as_ref());
    assert!(
        !ops[0]["hunks"].as_array().expect("hunks").is_empty(),
        "a modification names the regions it produced"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "uno\ntwo\ntres\n"
    );
}

#[test]
fn a_files_block_receipts_each_file_that_moved_and_no_file_that_did_not() {
    let (_dir, root) = init_repo();
    std::fs::write(root.join("c.txt"), "alpha\n").unwrap();
    let out = rev(
        &root,
        &[],
        // `b.txt` is named and left byte-identical: its replacement is what it
        // replaced, so it is not written and not receipted.
        "file a.txt\n  replace 'two' with 'deux'\nfile b.txt\n  replace 'beta' with 'beta'\nfile c.txt\n  replace 'alpha' with 'aleph'\n",
    );
    assert_eq!(code(&out), 0);
    let ops = receipt_ops(&out);
    let named: Vec<String> = ops
        .iter()
        .map(|op| op["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(named.len(), 2);
    assert!(named.iter().any(|p| p.ends_with("a.txt")));
    assert!(named.iter().any(|p| p.ends_with("c.txt")));
    assert!(!named.iter().any(|p| p.ends_with("b.txt")));
}

#[test]
fn create_and_write_receipt_the_right_op_for_what_they_did() {
    let (_dir, root) = init_repo();

    let out = rev(&root, &[], "file made.txt\n  create <<\n  fresh\n  >>\n");
    assert_eq!(code(&out), 0);
    assert_eq!(receipt_ops(&out)[0]["op"], "created");
    assert_eq!(
        std::fs::read_to_string(root.join("made.txt")).unwrap(),
        "fresh\n"
    );

    let out = rev(&root, &[], "file written.txt\n  write <<\n  fresh\n  >>\n");
    assert_eq!(receipt_ops(&out)[0]["op"], "created");

    let out = rev(&root, &[], "file a.txt\n  write <<\n  whole\n  >>\n");
    assert_eq!(receipt_ops(&out)[0]["op"], "modified");
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "whole\n"
    );
}

#[test]
fn preview_leaves_bytes_and_mtime_untouched_and_prints_no_receipt() {
    let (_dir, root) = init_repo();
    let target = root.join("a.txt");
    let before = std::fs::read(&target).unwrap();
    let stamp = mtime(&target);

    let out = rev(&root, &["--preview"], "file a.txt\n  replace 'two' with 'deux'\n");
    assert_eq!(code(&out), 0);
    assert!(!has_receipt(&out), "a preview changed nothing to testify to");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("+deux"),
        "a preview shows the diff it would make"
    );
    assert_eq!(std::fs::read(&target).unwrap(), before);
    assert_eq!(mtime(&target), stamp);
}

#[test]
fn a_syntax_error_exits_two_with_nothing_read() {
    let (_dir, root) = init_repo();
    let out = rev(&root, &[], "file a.txt\n  frobnicate 3\n");
    assert_eq!(code(&out), 2);
    assert!(!has_receipt(&out));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("2:3"),
        "a parse error names its line and column: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ntwo\nthree\n"
    );
}

#[test]
fn a_resolve_failure_exits_three_reporting_every_stale_address_and_writing_nothing() {
    let (_dir, root) = init_repo();
    let out = rev(
        &root,
        &[],
        "file a.txt\n  replace 'two' with 'deux'\n  replace 'gone' with 'x'\n  delete 99\n",
    );
    assert_eq!(code(&out), 3);
    assert!(!has_receipt(&out));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("line 3"), "{stderr}");
    assert!(stderr.contains("line 4"), "{stderr}");
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ntwo\nthree\n",
        "a program that cannot resolve writes nothing at all"
    );
}

#[test]
fn a_write_that_fails_partway_exits_four_naming_what_it_did_write() {
    let (_dir, root) = init_repo();
    let locked = root.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("b.txt"), "beta\n").unwrap();
    let mut mode = std::fs::metadata(&locked).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o555);
    std::fs::set_permissions(&locked, mode).unwrap();

    let out = rev(
        &root,
        &[],
        "file a.txt\n  replace 'two' with 'deux'\nfile locked/b.txt\n  replace 'beta' with 'gamma'\n",
    );
    assert_eq!(code(&out), 4);
    assert!(
        has_receipt(&out),
        "the files that did move are named even though the run failed"
    );
    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 1);
    assert!(ops[0]["path"].as_str().unwrap().ends_with("a.txt"));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("a.txt"), "{stderr}");

    let mut mode = std::fs::metadata(&locked).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    std::fs::set_permissions(&locked, mode).unwrap();
}

#[test]
fn a_files_mode_survives_the_atomic_write() {
    let (_dir, root) = init_repo();
    let target = root.join("a.txt");
    let mut mode = std::fs::metadata(&target).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    std::fs::set_permissions(&target, mode).unwrap();

    let out = rev(&root, &[], "file a.txt\n  replace 'two' with 'deux'\n");
    assert_eq!(code(&out), 0);
    let after = std::fs::metadata(&target).unwrap().permissions();
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&after) & 0o777,
        0o755
    );
}

#[test]
fn tugrev_and_tugutil_file_rev_are_the_same_verb() {
    let (_dir_one, one) = init_repo();
    let (_dir_two, two) = init_repo();
    let program = "file a.txt\n  replace 'two' with 'deux'\n  append <<\n  four\n  >>\n";

    let through_tugutil = rev(&one, &["--preview"], program);
    let through_tugrev = tugrev(&two, &["--preview"], program);
    assert_eq!(code(&through_tugutil), 0);
    assert_eq!(code(&through_tugrev), 0);
    assert_eq!(through_tugutil.stdout, through_tugrev.stdout);

    // And the apply path testifies the same way.
    let applied = tugrev(&two, &[], program);
    assert_eq!(code(&applied), 0);
    assert_eq!(receipt_ops(&applied).len(), 1);
    assert_eq!(
        std::fs::read_to_string(two.join("a.txt")).unwrap(),
        "one\ndeux\nthree\nfour\n"
    );
}

#[test]
fn a_program_reads_from_a_named_file_as_well_as_from_stdin() {
    let (_dir, root) = init_repo();
    std::fs::write(root.join("edit.rev"), "file a.txt\n  replace 'two' with 'deux'\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_tugrev"))
        .current_dir(&root)
        .arg("edit.rev")
        .output()
        .expect("run tugrev");
    assert_eq!(code(&out), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ndeux\nthree\n"
    );
}
