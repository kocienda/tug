//! Integration tests for `tugtool file probe`, driving the built binary against
//! a real temp git repo.
//!
//! The verb's whole contract is that it leaves nothing behind, so these assert
//! on the tree after the fact: the bytes, the mtime, the presence or absence of
//! files the patch created, and the absence of a receipt line.

mod common;
use common::tugtool;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

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

/// A temp git repo holding one committed file, `src/x.ts`.
fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@t.test"]);
    git(&root, &["config", "user.name", "t"]);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/x.ts"), "const a = 1;\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "init"]);
    (dir, root)
}

fn write_patch(root: &Path, body: &str) -> PathBuf {
    let path = root.join("p.diff");
    std::fs::write(&path, body).unwrap();
    path
}

/// A diff turning `src/x.ts`'s single line into `const a = 2;`.
const EDIT_PATCH: &str = "\
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
";

fn probe(root: &Path, args: &[&str]) -> std::process::Output {
    tugtool()
        .current_dir(root)
        .args(["file", "probe"])
        .args(args)
        .output()
        .expect("run tugtool")
}

fn mtime(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

#[test]
fn a_probe_shows_the_patched_content_and_restores_bytes_and_mtime() {
    let (_dir, root) = init_repo();
    let target = root.join("src/x.ts");
    let patch = write_patch(&root, EDIT_PATCH);
    let before_bytes = std::fs::read(&target).unwrap();
    let before_mtime = mtime(&target);

    // A second of daylight, so a restore that forgot the mtime would show.
    std::thread::sleep(std::time::Duration::from_millis(1100));

    let out = probe(
        &root,
        &["--patch", patch.to_str().unwrap(), "--", "cat", "src/x.ts"],
    );

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // The command saw the patch…
    assert_eq!(String::from_utf8_lossy(&out.stdout), "const a = 2;\n");
    // …and the tree did not keep it.
    assert_eq!(std::fs::read(&target).unwrap(), before_bytes);
    assert_eq!(mtime(&target), before_mtime);
    // A probe records nothing.
    assert!(!String::from_utf8_lossy(&out.stdout).contains("TUG-FILE-RECEIPT"));
}

#[test]
fn a_probe_leaves_git_status_exactly_as_it_found_it() {
    let (_dir, root) = init_repo();
    let patch = write_patch(&root, EDIT_PATCH);
    let status = |root: &Path| {
        let out = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["status", "--porcelain=v2", "--untracked-files=all"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let before = status(&root);
    let out = probe(&root, &["--patch", patch.to_str().unwrap(), "--", "true"]);
    assert!(out.status.success());
    assert_eq!(status(&root), before);
}

#[test]
fn pre_existing_uncommitted_work_survives_a_probe() {
    let (_dir, root) = init_repo();
    let target = root.join("src/x.ts");
    // The common case in a working repo: the file is already dirty. A
    // git-based restore would destroy this; a byte snapshot does not.
    std::fs::write(&target, "const a = 1;\n// mine, uncommitted\n").unwrap();
    let mine = std::fs::read(&target).unwrap();
    let patch = write_patch(
        &root,
        "\
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 // mine, uncommitted
",
    );

    let out = probe(&root, &["--patch", patch.to_str().unwrap(), "--", "true"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(std::fs::read(&target).unwrap(), mine);
}

#[test]
fn a_file_the_patch_creates_is_gone_afterwards() {
    let (_dir, root) = init_repo();
    let patch = write_patch(
        &root,
        "\
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+fresh
",
    );
    let created = root.join("src/new.ts");

    let out = probe(
        &root,
        &[
            "--patch",
            patch.to_str().unwrap(),
            "--",
            "test",
            "-f",
            "src/new.ts",
        ],
    );
    // The command saw the created file…
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // …and it is not there now.
    assert!(!created.exists());
}

#[test]
fn the_childs_exit_code_is_the_probes_exit_code() {
    let (_dir, root) = init_repo();
    let target = root.join("src/x.ts");
    let before = std::fs::read(&target).unwrap();
    let patch = write_patch(&root, EDIT_PATCH);

    let out = probe(
        &root,
        &[
            "--patch",
            patch.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            "exit 7",
        ],
    );
    assert_eq!(out.status.code(), Some(7));
    // Restore still happened — a failing command is the normal case.
    assert_eq!(std::fs::read(&target).unwrap(), before);
}

#[test]
fn a_patch_that_does_not_apply_changes_nothing_and_runs_nothing() {
    let (_dir, root) = init_repo();
    let target = root.join("src/x.ts");
    let before = std::fs::read(&target).unwrap();
    let patch = write_patch(
        &root,
        "\
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-this line is not in the file
+replacement
",
    );

    let out = probe(
        &root,
        &[
            "--patch",
            patch.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            "echo the-command-ran",
        ],
    );
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("the-command-ran"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("TUG-FILE-RECEIPT"));
    assert_eq!(std::fs::read(&target).unwrap(), before);
}

/// The regression that motivated unioning `git apply --numstat` with the header
/// parse. A patch mixing a hunked file with a 100%-similarity rename passes the
/// "names no files" guard on the strength of the hunked file alone, so a
/// header-only scan snapshots one file, `git apply` performs the rename anyway,
/// and the rename is never undone — the probe reporting success on a tree it
/// permanently modified.
#[test]
fn a_rename_riding_along_with_a_hunked_file_is_still_restored() {
    let (_dir, root) = init_repo();
    std::fs::write(root.join("src/keep.ts"), "keep\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "keep"]);

    // Build the patch the way git really emits one: a content change plus a
    // pure rename, which carries no hunks.
    std::fs::write(root.join("src/x.ts"), "const a = 2;\n").unwrap();
    git(&root, &["mv", "src/keep.ts", "src/moved.ts"]);
    git(&root, &["add", "-A"]);
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["diff", "--cached"])
        .output()
        .unwrap();
    let patch = write_patch(&root, &String::from_utf8_lossy(&out.stdout));
    git(&root, &["reset", "-q", "--hard"]);

    assert!(root.join("src/keep.ts").exists());
    assert!(!root.join("src/moved.ts").exists());

    let out = probe(
        &root,
        &[
            "--patch",
            patch.to_str().unwrap(),
            "--",
            "test",
            "-f",
            "src/moved.ts",
        ],
    );
    // The command saw the renamed file…
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // …and the rename was undone on the way out.
    assert!(
        root.join("src/keep.ts").exists(),
        "the rename source was not restored"
    );
    assert!(
        !root.join("src/moved.ts").exists(),
        "the rename destination was left behind"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("src/x.ts")).unwrap(),
        "const a = 1;\n"
    );
}

/// A mode-only entry carries neither hunks nor `rename from` — only
/// `old mode`/`new mode`. `git apply --numstat` is the only thing that sees it.
#[test]
fn a_mode_only_change_is_restored() {
    use std::os::unix::fs::PermissionsExt;

    let (_dir, root) = init_repo();
    let target = root.join("src/x.ts");
    let before = std::fs::metadata(&target).unwrap().permissions().mode();

    let mut perms = std::fs::metadata(&target).unwrap().permissions();
    perms.set_mode(before | 0o111);
    std::fs::set_permissions(&target, perms).unwrap();
    git(&root, &["add", "-A"]);
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["diff", "--cached"])
        .output()
        .unwrap();
    let patch = write_patch(&root, &String::from_utf8_lossy(&out.stdout));
    git(&root, &["reset", "-q", "--hard"]);
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(before)).unwrap();

    let out = probe(&root, &["--patch", patch.to_str().unwrap(), "--", "true"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode(),
        before,
        "the mode change was left behind"
    );
}

#[test]
fn an_extra_path_is_protected_even_when_the_command_writes_it() {
    let (_dir, root) = init_repo();
    let other = root.join("src/other.ts");
    std::fs::write(&other, "untouched\n").unwrap();
    let patch = write_patch(&root, EDIT_PATCH);

    let out = probe(
        &root,
        &[
            "--patch",
            patch.to_str().unwrap(),
            "--path",
            "src/other.ts",
            "--",
            "sh",
            "-c",
            "echo clobbered > src/other.ts",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(std::fs::read_to_string(&other).unwrap(), "untouched\n");
}
