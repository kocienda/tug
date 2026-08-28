//! Integration tests for `tugutil file edit` and the `tugedit` binary, driving
//! the built binaries against a real temp git repo.
//!
//! The contract under test is the verb's, not the language's: the receipt names
//! exactly the files whose bytes moved, `--preview` touches neither bytes nor
//! mtime, and the exit codes say which phase refused. The language's own
//! semantics are proved in `tugedit-core` against an in-memory source, and the
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

fn edit(root: &Path, args: &[&str], program: &str) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugutil"));
    cmd.args(["file", "edit"]).args(args);
    run(cmd, root, program)
}

fn tugedit(root: &Path, args: &[&str], program: &str) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugedit"));
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

// ---------------------------------------------------------------------------
// The program mode
// ---------------------------------------------------------------------------

#[test]
fn a_patch_hunk_edits_the_file_and_receipts_it() {
    let (_dir, root) = init_repo();
    let out = edit(
        &root,
        &[],
        "file a.txt\n  patch <<\n one\n-two\n+deux\n three\n>>\n",
    );
    assert_eq!(code(&out), 0);
    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["op"], "modified");
    assert_eq!(
        ops[0]["path"],
        root.join("a.txt").to_string_lossy().as_ref()
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ndeux\nthree\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "alpha\nbeta\n"
    );
}

#[test]
fn a_patch_hunk_that_finds_nothing_exits_three_naming_the_hunk_and_writes_nothing() {
    let (_dir, root) = init_repo();
    let before = mtime(&root.join("a.txt"));
    let out = edit(
        &root,
        &[],
        "file a.txt\n  patch <<\n-absent\n+present\n>>\n",
    );
    assert_eq!(code(&out), 3);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("patch hunk 1: expected 1 match, found 0"),
        "{stderr}"
    );
    assert!(stderr.contains("nothing was written"), "{stderr}");
    assert!(!has_receipt(&out));
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ntwo\nthree\n"
    );
    assert_eq!(mtime(&root.join("a.txt")), before);
}

#[test]
fn a_patch_hunk_carries_a_gtgt_line_through_stdin() {
    let (_dir, root) = init_repo();
    let out = tugedit(&root, &[], "file a.txt\n  patch <<\n one\n+>>\n>>\n");
    assert_eq!(code(&out), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\n>>\ntwo\nthree\n"
    );
}

#[test]
fn a_multi_pair_program_edits_one_file_and_receipts_the_regions_it_produced() {
    let (_dir, root) = init_repo();
    let out = edit(
        &root,
        &[],
        "file a.txt\n  replace 'one' with 'uno'\n  replace 'three' with 'tres'\n",
    );
    assert_eq!(code(&out), 0);
    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["op"], "modified");
    assert_eq!(
        ops[0]["path"],
        root.join("a.txt").to_string_lossy().as_ref()
    );
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
fn a_regex_substitution_supports_captures() {
    let (_dir, root) = init_repo();
    let out = edit(
        &root,
        &[],
        "file b.txt\n  sub /\\b(alpha|beta)\\b/ '$1!' all\n",
    );
    assert_eq!(code(&out), 0, "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "alpha!\nbeta!\n"
    );
}

#[test]
fn a_files_block_receipts_each_file_that_moved_and_no_file_that_did_not() {
    let (_dir, root) = init_repo();
    std::fs::write(root.join("c.txt"), "alpha\n").unwrap();
    let out = edit(
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

    let out = edit(&root, &[], "file made.txt\n  create <<\nfresh\n>>\n");
    assert_eq!(code(&out), 0);
    assert_eq!(receipt_ops(&out)[0]["op"], "created");
    assert_eq!(
        std::fs::read_to_string(root.join("made.txt")).unwrap(),
        "fresh\n"
    );

    let out = edit(&root, &[], "file written.txt\n  write <<\nfresh\n>>\n");
    assert_eq!(receipt_ops(&out)[0]["op"], "created");

    let out = edit(&root, &[], "file a.txt\n  write <<\nwhole\n>>\n");
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

    let out = edit(
        &root,
        &["--preview"],
        "file a.txt\n  replace 'two' with 'deux'\n",
    );
    assert_eq!(code(&out), 0);
    assert!(
        !has_receipt(&out),
        "a preview changed nothing to testify to"
    );
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
    let out = edit(&root, &[], "file a.txt\n  frobnicate 3\n");
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
    let out = edit(
        &root,
        &[],
        "file a.txt\n  replace 'two' with 'deux'\n  replace 'gone' with 'x'\n  delete 99\n",
    );
    assert_eq!(code(&out), 3);
    assert!(!has_receipt(&out));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("line 3"), "{stderr}");
    assert!(stderr.contains("line 4"), "{stderr}");
    assert!(
        stderr.contains("nothing was written — 1 op resolved and 2 did not"),
        "the refusal says in words that the op which did resolve is still pending: {stderr}"
    );
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

    let out = edit(
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

    let out = edit(&root, &[], "file a.txt\n  replace 'two' with 'deux'\n");
    assert_eq!(code(&out), 0);
    let after = std::fs::metadata(&target).unwrap().permissions();
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&after) & 0o777,
        0o755
    );
}

#[test]
fn tugedit_and_tugutil_file_edit_are_the_same_verb() {
    let (_dir_one, one) = init_repo();
    let (_dir_two, two) = init_repo();
    let program = "file a.txt\n  replace 'two' with 'deux'\n  append <<\nfour\n>>\n";

    let through_tugutil = edit(&one, &["--preview"], program);
    let through_tugedit = tugedit(&two, &["--preview"], program);
    assert_eq!(code(&through_tugutil), 0);
    assert_eq!(code(&through_tugedit), 0);
    assert_eq!(through_tugutil.stdout, through_tugedit.stdout);

    // And the apply path testifies the same way.
    let applied = tugedit(&two, &[], program);
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
    std::fs::write(
        root.join("prog.edit"),
        "file a.txt\n  replace 'two' with 'deux'\n",
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_tugedit"))
        .current_dir(&root)
        .arg("prog.edit")
        .output()
        .expect("run tugedit");
    assert_eq!(code(&out), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\ndeux\nthree\n"
    );
}

/// Spec S05: the verb names the regions its bytes landed in, by the same
/// [P06] identity the diff wire and the landing engine use — which is what
/// lets the relay mint `hunk` spans that match against a later diff.
#[test]
fn a_substitution_receipt_names_the_hunk_it_produced() {
    let (_dir, root) = init_repo();
    let out = edit(&root, &[], "file a.txt\n  replace 'two' with 'deux'\n");
    assert_eq!(code(&out), 0);

    let ops = receipt_ops(&out);
    let hunks: Vec<String> = ops[0]["hunks"]
        .as_array()
        .expect("the receipt names its hunks")
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(hunks.len(), 1, "one edit, one region");

    // The id is the one the engine computes for the file's current diff —
    // the agreement the whole feature rests on.
    let engine: Vec<String> = tugchanges_core::hunks::file_hunks(&root, "a.txt")
        .expect("engine hunks")
        .into_iter()
        .map(|h| h.id)
        .collect();
    assert_eq!(hunks, engine);
}

/// A second edit reports only what *it* changed. Naming the file's whole
/// current diff would testify to regions another session wrote — a false
/// sole claim, the one direction [P12] forbids.
#[test]
fn a_second_edit_reports_only_its_own_region() {
    let (_dir, root) = init_repo();
    // Two edits far enough apart that git keeps them in separate hunks.
    let long: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
    std::fs::write(root.join("long.txt"), &long).unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "long"]);

    let first = edit(
        &root,
        &[],
        "file long.txt\n  replace 'line005' with 'FIVE'\n",
    );
    assert_eq!(code(&first), 0);
    let first_hunks: Vec<serde_json::Value> =
        receipt_ops(&first)[0]["hunks"].as_array().unwrap().clone();
    assert_eq!(first_hunks.len(), 1);

    let second = edit(
        &root,
        &[],
        "file long.txt\n  replace 'line050' with 'FIFTY'\n",
    );
    assert_eq!(code(&second), 0);
    let second_hunks: Vec<serde_json::Value> =
        receipt_ops(&second)[0]["hunks"].as_array().unwrap().clone();
    assert_eq!(second_hunks.len(), 1, "only the new region");
    assert_ne!(second_hunks[0], first_hunks[0]);
}

// ---------------------------------------------------------------------------
// The --patch mode
// ---------------------------------------------------------------------------

#[test]
fn a_multi_file_diff_reports_one_op_per_file_that_actually_moved() {
    let (_dir, root) = init_repo();
    let patch = root.join("p.diff");
    std::fs::write(
        &patch,
        "\
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
-one
+uno
 two
 three
--- a/b.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
-alpha
+aleph
 beta
",
    )
    .unwrap();

    let out = edit(&root, &["--patch", patch.to_str().unwrap()], "");
    assert_eq!(code(&out), 0, "{}", String::from_utf8_lossy(&out.stderr));

    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 2);
    assert!(ops.iter().all(|op| op["op"] == "modified"));
    let mut paths: Vec<String> = ops
        .iter()
        .map(|op| op["path"].as_str().unwrap().to_string())
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            root.join("a.txt").to_string_lossy().to_string(),
            root.join("b.txt").to_string_lossy().to_string(),
        ]
    );
}

#[test]
fn a_patch_creating_a_file_reports_it_as_created() {
    let (_dir, root) = init_repo();
    let patch = root.join("p.diff");
    std::fs::write(
        &patch,
        "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n",
    )
    .unwrap();

    let out = edit(&root, &["--patch", patch.to_str().unwrap()], "");
    assert_eq!(code(&out), 0, "{}", String::from_utf8_lossy(&out.stderr));
    let ops = receipt_ops(&out);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["op"], "created");
    assert!(root.join("new.txt").exists());
}

#[test]
fn a_patch_that_does_not_apply_changes_nothing_and_testifies_to_nothing() {
    let (_dir, root) = init_repo();
    let before = std::fs::read(root.join("a.txt")).unwrap();
    let patch = root.join("p.diff");
    std::fs::write(
        &patch,
        "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-this line is not in the file\n+replacement\n",
    )
    .unwrap();

    let out = edit(&root, &["--patch", patch.to_str().unwrap()], "");
    assert!(!out.status.success());
    assert!(!has_receipt(&out));
    assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), before);
}

#[test]
fn the_patch_can_come_from_stdin() {
    let (_dir, root) = init_repo();
    let out = edit(
        &root,
        &["--patch", "-"],
        "--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n-alpha\n+aleph\n beta\n",
    );
    assert_eq!(code(&out), 0, "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(receipt_ops(&out).len(), 1);
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "aleph\nbeta\n"
    );
}

#[test]
fn a_patch_preview_validates_and_writes_nothing() {
    let (_dir, root) = init_repo();
    let target = root.join("a.txt");
    let before = std::fs::read(&target).unwrap();
    let stamp = mtime(&target);

    let out = edit(
        &root,
        &["--preview", "--patch", "-"],
        "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+uno\n two\n three\n",
    );
    assert_eq!(code(&out), 0);
    assert!(
        !has_receipt(&out),
        "a preview changed nothing to testify to"
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("+uno"),
        "a preview shows the diff it would make"
    );
    assert_eq!(std::fs::read(&target).unwrap(), before);
    assert_eq!(mtime(&target), stamp);
}

/// A created file has no diff to read hunks from ([P07]), so the receipt says
/// nothing about regions — and the row it mints widens to the whole file,
/// which is exactly right for a file this session brought into existence.
#[test]
fn a_created_file_names_no_hunks() {
    let (_dir, root) = init_repo();
    let patch = root.join("new.diff");
    std::fs::write(
        &patch,
        "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+const n = 1;\n",
    )
    .unwrap();
    let out = edit(&root, &["--patch", patch.to_str().unwrap()], "");
    assert_eq!(code(&out), 0, "{}", String::from_utf8_lossy(&out.stderr));
    let ops = receipt_ops(&out);
    assert_eq!(ops[0]["op"], "created");
    assert!(ops[0].get("hunks").is_none(), "no regions to name");
}
