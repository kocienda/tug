//! `tugtool file` — git-aware file lifecycle verbs that testify to what they did.
//!
//! A shell command with a glob or a variable operand is unreadable, so the
//! attribution relay can only correlate it: the file lands in `unattributed`
//! with a hint. These verbs close that gap from the other side. They perform
//! the expansion themselves and print a receipt naming exactly which files were
//! removed, renamed, or created — testimony from a tool we own, which the relay
//! turns into proof-class rows.
//!
//! The receipt names **files, never directories**: the read side's universe is
//! per-file, so a directory op could never join. A recursive operation
//! enumerates what it will touch before acting.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tugchanges_core::shell_ops::{ParseOutcome, Suggestion, parse_shell_ops};
use tugtool::edit::EditError;
use tugtool::edit_error_marker::EditErrorMarker;
use tugtool::receipt::{Receipt, current_hunk_ids, hunks_this_edit_produced};

use crate::changes::AppError;
use crate::cli::FileCommands;

pub fn run_file(command: FileCommands) -> Result<(), AppError> {
    match command {
        FileCommands::Rm { paths } => run_rm(&paths),
        FileCommands::Mv { src, dst } => run_mv(&src, &dst),
        FileCommands::Cp { src, dst } => run_cp(&src, &dst),
        FileCommands::Edit {
            preview,
            patch,
            file,
        } => run_edit(preview, patch, file),
        FileCommands::Stage { patch } => run_stage(&patch),
        FileCommands::Probe {
            patch,
            paths,
            command,
        } => super::file_probe::run_probe(patch, &paths, &command),
        FileCommands::Run { scopes, command } => super::file_run::run_run(&scopes, &command),
        FileCommands::Gate { command, base_dir } => run_gate(&command, base_dir),
    }
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

fn run_rm(patterns: &[String]) -> Result<(), AppError> {
    let mut receipt = Receipt::default();
    let mut failure: Option<String> = None;

    for target in expand(patterns) {
        // Enumerate before acting: once the directory is gone there is nothing
        // left to name.
        let files = files_under(&target);
        let tracked = git_tracks(&target);
        let mut ok = true;

        if tracked && git(&["rm", "-q", "-f", "-r", "--"], &[&target]).is_err() {
            ok = false;
        }
        if ok && target.exists() {
            let removed = if target.is_dir() {
                std::fs::remove_dir_all(&target)
            } else {
                std::fs::remove_file(&target)
            };
            if let Err(err) = removed {
                failure.get_or_insert(format!("{}: {err}", target.display()));
                ok = false;
            }
        }
        if ok {
            for file in files {
                receipt.deleted(&file);
            }
        }
    }

    receipt.emit();
    match failure {
        Some(msg) => Err(AppError::Exit1(msg)),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------------

fn run_mv(src: &str, dst: &str) -> Result<(), AppError> {
    let src = absolute(Path::new(src));
    let dst = destination(&src, Path::new(dst));
    if !src.exists() {
        return Err(AppError::Exit1(format!("{}: no such file", src.display())));
    }

    // Pair every contained file's old and new spelling before the move erases
    // the mapping.
    let pairs: Vec<(PathBuf, PathBuf)> = files_under(&src)
        .into_iter()
        .map(|file| {
            let landed = match file.strip_prefix(&src) {
                Ok(rel) if !rel.as_os_str().is_empty() => dst.join(rel),
                _ => dst.clone(),
            };
            (file, landed)
        })
        .collect();

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Exit1(format!("{}: {e}", parent.display())))?;
    }

    if git_tracks(&src) {
        git(&["mv", "--"], &[&src, &dst])?;
    } else {
        std::fs::rename(&src, &dst)
            .map_err(|e| AppError::Exit1(format!("{} -> {}: {e}", src.display(), dst.display())))?;
    }

    let mut receipt = Receipt::default();
    for (from, to) in pairs {
        receipt.renamed(&from, &to);
    }
    receipt.emit();
    Ok(())
}

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

fn run_cp(src: &str, dst: &str) -> Result<(), AppError> {
    let src = absolute(Path::new(src));
    let dst = destination(&src, Path::new(dst));
    if !src.exists() {
        return Err(AppError::Exit1(format!("{}: no such file", src.display())));
    }

    let mut receipt = Receipt::default();
    if src.is_dir() {
        for file in files_under(&src) {
            let rel = file.strip_prefix(&src).unwrap_or(Path::new(""));
            let landed = dst.join(rel);
            if let Some(parent) = landed.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::Exit1(format!("{}: {e}", parent.display())))?;
            }
            std::fs::copy(&file, &landed)
                .map_err(|e| AppError::Exit1(format!("{}: {e}", file.display())))?;
            receipt.created(&landed);
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Exit1(format!("{}: {e}", parent.display())))?;
        }
        std::fs::copy(&src, &dst)
            .map_err(|e| AppError::Exit1(format!("{}: {e}", src.display())))?;
        receipt.created(&dst);
    }
    receipt.emit();
    Ok(())
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/// Substitution and patch application that testify to what they changed.
///
/// This is the attributable form of the `perl -i`/`python3` heredoc edits the
/// grammar cannot read: the verb performs the edit itself and prints a receipt
/// naming every file whose bytes actually moved, which the relay turns into
/// proof-class rows. An edit program is the main door; `--patch` takes a
/// unified diff already in hand.
fn run_edit(preview: bool, patch: Option<String>, file: Option<String>) -> Result<(), AppError> {
    match patch {
        Some(source) => edit_by_patch(&source, preview),
        None => {
            // The program is held rather than piped through: the marker
            // carries it, and a failure nobody can see the program for is a
            // failure nobody can diagnose.
            let program = match tugtool::edit::read_program(file.as_deref()) {
                Ok(program) => program,
                Err(err) => return Err(edit_failure(&err, "")),
            };
            tugtool::edit::run(&program, preview).map_err(|err| edit_failure(&err, &program))
        }
    }
}

fn edit_by_patch(source: &str, preview: bool) -> Result<(), AppError> {
    use super::file_probe::{git_apply, patch_targets, read_patch};

    let text = read_patch(source)?;
    let targets = patch_targets(&text);
    if targets.is_empty() {
        return Err(patch_failure(
            "usage",
            AppError::Exit1("the patch names no files".to_string()),
            &text,
            &[],
        ));
    }

    // Remember each target's bytes so the receipt can name only the files that
    // actually moved — a patch may name a file and leave it identical.
    let before: Vec<Option<Vec<u8>>> = targets.iter().map(|p| std::fs::read(p).ok()).collect();
    let hunks_before: Vec<Vec<String>> = targets.iter().map(|p| current_hunk_ids(p)).collect();

    // Validate first: a patch that will not apply must change nothing and
    // testify to nothing.
    if let Err(err) = git_apply(&text, true) {
        return Err(patch_failure("resolve", err, &text, &targets));
    }
    if preview {
        // The diff the edit would produce is the patch itself; show it and
        // touch nothing.
        print!("{text}");
        return Ok(());
    }
    if let Err(err) = git_apply(&text, false) {
        return Err(patch_failure("write", err, &text, &targets));
    }

    let mut receipt = Receipt::default();
    for ((target, was), was_hunks) in targets.iter().zip(before).zip(hunks_before) {
        let now = std::fs::read(target).ok();
        if now == was {
            continue;
        }
        match (was, &now) {
            (None, Some(_)) => receipt.created(target),
            (Some(_), None) => receipt.deleted(target),
            _ => receipt.modified(target, hunks_this_edit_produced(target, &was_hunks)),
        }
    }
    receipt.emit();
    Ok(())
}

/// A failed edit program: the report, then the `TUG-EDIT-ERROR` marker, then
/// the exit-code contract carried onto the CLI's — 2 parse, 3 resolve, 4 a
/// write that failed partway. Both lines go out here because here is where the
/// program is still in hand.
fn edit_failure(err: &EditError, program: &str) -> AppError {
    tugtool::edit_error_marker::report(err, program);
    AppError::Reported(err.exit_code())
}

/// The same two lines for a `--patch` failure, whose evidence is the diff
/// rather than a program: a patch has no ops to count, so the marker carries
/// the files it named and the diff text itself. The exit code is the one the
/// mode always produced.
fn patch_failure(
    class: &'static str,
    err: AppError,
    patch: &str,
    files: &[std::path::PathBuf],
) -> AppError {
    let exit = err.exit_code();
    eprintln!("error: {}", err.message());
    EditErrorMarker::new(class, exit, err.message())
        .with_files(
            files
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        )
        .with_program(patch)
        .emit();
    AppError::Reported(exit)
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

/// Stage a patch into the index, working tree untouched.
///
/// This is `git add -p` without the prompting: filter a diff to what you want,
/// hand it here, and the index holds exactly that. The interactive form cannot
/// work in the block shell — its stdin is `/dev/null`, so it reads EOF and
/// silently stages nothing, which looks like success ([P13]).
///
/// It prints no `TUG-FILE-RECEIPT`: staging moves no working-tree bytes, and a
/// receipt would mint a false `modified` row against the session.
fn run_stage(source: &str) -> Result<(), AppError> {
    use super::file_probe::{git_apply_cached, patch_targets, read_patch};

    let text = read_patch(source)?;
    let targets = patch_targets(&text);
    if targets.is_empty() {
        return Err(AppError::Exit1("the patch names no files".to_string()));
    }

    // Validate before staging: a patch that will not apply must leave the
    // index exactly as it found it.
    git_apply_cached(&text, true)?;
    git_apply_cached(&text, false)?;

    println!("staged {} file(s):", targets.len());
    for target in &targets {
        println!("  {}", target.display());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub(crate) struct GateDecision {
    pub(crate) decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

/// The gate's verdict on one command: deny only when the grammar refuses.
pub(crate) fn gate_decision(command: &str, base: &Path) -> GateDecision {
    match parse_shell_ops(command, base) {
        ParseOutcome::Unparseable {
            reason,
            suggest,
            path,
        } => GateDecision {
            decision: "deny",
            reason: Some(format!("{reason}. {}", steering(suggest, path.as_deref()))),
        },
        ParseOutcome::Ops(_) | ParseOutcome::NoFileOps => GateDecision {
            decision: "allow",
            reason: None,
        },
    }
}

/// Where a refusal points. The grammar decides which verb covers what it could
/// not read; this only spells it out, so a denied `perl -i` is never steered at
/// `rm|mv|cp`.
///
/// The gate runs in whatever project the app opened, so nothing here names a
/// file or a tool that project may not have: the edit-program example names
/// `path` — the file the refused command itself would have written — and the
/// rest are placeholders.
fn steering(suggest: Suggestion, path: Option<&str>) -> String {
    match suggest {
        Suggestion::Lifecycle => {
            "Use `tugtool file rm|mv|cp` instead — it expands the operands itself and reports \
             exactly which files it touched, so the change stays attributed."
                .to_string()
        }
        Suggestion::Edit => {
            "Use `tugtool file edit` instead — it applies the edit program itself and reports \
             exactly which files changed, so the change stays attributed. For a patch-run-revert \
             cycle, `tugtool file probe` does the whole thing and records nothing."
                .to_string()
        }
        // The model copies the shape it is shown, so the steer shows one.
        Suggestion::Program => {
            let file = path.unwrap_or("path/to/file");
            format!(
                r#"Write it as an edit program instead — `tugtool file edit` applies the program itself and reports
exactly which files changed, so the edit stays attributed:

  tugtool file edit <<'EDIT'
  file {file}
    replace 'the text as it is now' with 'the text as it should be'
    delete 166
  EDIT

Preview first with `tugtool file edit --preview`. If the edit is computed, run the program
read-only to print the result, then put that output in a `write` or `replace` op."#
            )
        }
        Suggestion::Run => {
            r#"Run it through `tugtool file run` instead — it watches the command and reports
exactly which files it rewrote, so the change stays attributed:

  tugtool file run -- <the command, exactly as you wrote it>
  tugtool file run --scope <dir> -- <the command>    # when you know where the writes land

It fingerprints the project's files by content before and after, so a file the command
merely touched is never claimed. The command's own output and exit status pass through."#
                .to_string()
        }
    }
}

/// The PreToolUse hook's decision, computed by the same grammar the relay uses
/// so the two cannot fork. Deny is reserved for the case where correlation
/// would otherwise be the ceiling: an rm/mv-class command whose operands the
/// grammar cannot read. Always exits 0 — the decision is the JSON, and a
/// crashed gate must fail open.
fn run_gate(command: &str, base_dir: Option<PathBuf>) -> Result<(), AppError> {
    let base = base_dir.unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let decision = gate_decision(command, &base);
    println!(
        "{}",
        serde_json::to_string(&decision).unwrap_or_else(|_| "{\"decision\":\"allow\"}".to_string())
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Expand each argument: a glob against the filesystem, or a literal path.
/// Unmatched globs and literals alike come through unchanged — the caller's
/// removal reports the real error.
fn expand(patterns: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for pattern in patterns {
        let absolute_pattern = absolute(Path::new(pattern));
        let matched = glob::glob(&absolute_pattern.to_string_lossy())
            .ok()
            .map(|paths| paths.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();
        if matched.is_empty() {
            out.push(absolute_pattern);
        } else {
            out.extend(matched);
        }
    }
    out
}

/// Every regular file at or beneath `path` — the receipt's unit. A file yields
/// itself; a directory yields its contents; a path that does not exist yields
/// nothing.
fn files_under(path: &Path) -> Vec<PathBuf> {
    if path.is_file() || path.is_symlink() {
        return vec![path.to_path_buf()];
    }
    if !path.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            // A repo's own `.git` is plumbing, not content.
            if child.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            if child.is_dir() && !child.is_symlink() {
                stack.push(child);
            } else {
                out.push(child);
            }
        }
    }
    out.sort();
    out
}

/// Where `src` actually lands: a destination that already names a directory
/// receives the source under its own name, as the shell verbs do.
fn destination(src: &Path, dst: &Path) -> PathBuf {
    let dst = absolute(dst);
    match (dst.is_dir(), src.file_name()) {
        (true, Some(name)) => dst.join(name),
        _ => dst,
    }
}

pub(super) fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    normalize(&cwd.join(path))
}

pub(super) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether git tracks `path` (or anything beneath it) — the test that decides
/// between `git rm`/`git mv` and a plain filesystem operation, so the index
/// never disagrees with the disk.
fn git_tracks(path: &Path) -> bool {
    let Some(dir) = git_dir_for(path) else {
        return false;
    };
    tugcore::git_command()
        .arg("-C")
        .arg(&dir)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg("--")
        .arg(path)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn git_dir_for(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() {
        Some(path)
    } else {
        path.parent()
    }?;
    start.exists().then(|| start.to_path_buf())
}

fn git(args: &[&str], paths: &[&Path]) -> Result<(), AppError> {
    let Some(dir) = paths.first().and_then(|p| git_dir_for(p)) else {
        return Err(AppError::Exit1("no directory to run git in".to_string()));
    };
    let mut command = tugcore::git_command();
    command.arg("-C").arg(&dir);
    command.args(args);
    for path in paths {
        command.arg(path);
    }
    let output = command
        .output()
        .map_err(|e| AppError::Exit1(format!("git: {e}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Exit1(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.test"],
            vec!["config", "user.name", "t"],
        ] {
            assert!(
                tugcore::git_command()
                    .args(&args)
                    .current_dir(root)
                    .output()
                    .expect("git")
                    .status
                    .success()
            );
        }
        dir
    }

    fn commit_all(root: &Path) {
        for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", "seed"]] {
            assert!(
                tugcore::git_command()
                    .args(&args)
                    .current_dir(root)
                    .output()
                    .expect("git")
                    .status
                    .success()
            );
        }
    }

    fn tracked(root: &Path, rel: &str) -> bool {
        git_tracks(&root.join(rel))
    }

    #[test]
    fn rm_removes_a_tracked_file_through_git() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        commit_all(root);

        run_rm(&[root.join("a.txt").to_string_lossy().into_owned()]).unwrap();
        assert!(!root.join("a.txt").exists());
        assert!(!tracked(root, "a.txt"), "the index reflects the removal");
    }

    #[test]
    fn rm_removes_an_untracked_file_too() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("scratch.txt"), "x\n").unwrap();

        run_rm(&[root.join("scratch.txt").to_string_lossy().into_owned()]).unwrap();
        assert!(!root.join("scratch.txt").exists());
    }

    #[test]
    fn rm_of_a_directory_names_every_file_and_no_directory() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::create_dir_all(root.join("out/nested")).unwrap();
        std::fs::write(root.join("out/one.txt"), "1\n").unwrap();
        std::fs::write(root.join("out/two.txt"), "2\n").unwrap();
        std::fs::write(root.join("out/nested/three.txt"), "3\n").unwrap();

        let target = root.join("out");
        let files = files_under(&target);
        assert_eq!(files.len(), 3, "enumeration is per file: {files:?}");
        assert!(files.iter().all(|f| f.is_file()));

        run_rm(&[target.to_string_lossy().into_owned()]).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn rm_expands_a_glob_itself() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("apptest-1.log"), "1\n").unwrap();
        std::fs::write(root.join("apptest-2.log"), "2\n").unwrap();
        std::fs::write(root.join("keep.log"), "keep\n").unwrap();

        let pattern = root.join("apptest-*").to_string_lossy().into_owned();
        let expanded = expand(std::slice::from_ref(&pattern));
        assert_eq!(expanded.len(), 2, "the verb resolves what the shell would");

        run_rm(&[pattern]).unwrap();
        assert!(!root.join("apptest-1.log").exists());
        assert!(!root.join("apptest-2.log").exists());
        assert!(root.join("keep.log").exists(), "an unmatched file survives");
    }

    #[test]
    fn mv_moves_a_tracked_file_through_git_and_preserves_content() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("old.txt"), "body\n").unwrap();
        commit_all(root);

        run_mv(
            &root.join("old.txt").to_string_lossy(),
            &root.join("new.txt").to_string_lossy(),
        )
        .unwrap();
        assert!(!root.join("old.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt")).unwrap(),
            "body\n"
        );
        assert!(tracked(root, "new.txt"), "the index followed the move");
    }

    #[test]
    fn mv_of_a_directory_pairs_every_contained_file() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::create_dir_all(root.join("src/inner")).unwrap();
        std::fs::write(root.join("src/a.rs"), "a\n").unwrap();
        std::fs::write(root.join("src/inner/b.rs"), "b\n").unwrap();

        let src = root.join("src");
        let dst = root.join("lib");
        let pairs: Vec<(PathBuf, PathBuf)> = files_under(&src)
            .into_iter()
            .map(|file| {
                let rel = file.strip_prefix(&src).unwrap().to_path_buf();
                (file, dst.join(rel))
            })
            .collect();
        assert_eq!(pairs.len(), 2);

        run_mv(&src.to_string_lossy(), &dst.to_string_lossy()).unwrap();
        for (from, to) in pairs {
            assert!(!from.exists());
            assert!(to.exists(), "{} landed", to.display());
        }
    }

    #[test]
    fn mv_into_an_existing_directory_keeps_the_file_name() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        std::fs::create_dir(root.join("dest")).unwrap();

        run_mv(
            &root.join("a.txt").to_string_lossy(),
            &root.join("dest").to_string_lossy(),
        )
        .unwrap();
        assert!(root.join("dest/a.txt").exists());
    }

    #[test]
    fn cp_copies_a_file_and_a_tree() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        run_cp(
            &root.join("a.txt").to_string_lossy(),
            &root.join("b.txt").to_string_lossy(),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "a\n");

        std::fs::create_dir_all(root.join("tree/inner")).unwrap();
        std::fs::write(root.join("tree/inner/c.txt"), "c\n").unwrap();
        run_cp(
            &root.join("tree").to_string_lossy(),
            &root.join("copy").to_string_lossy(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("copy/inner/c.txt")).unwrap(),
            "c\n"
        );
    }

    #[test]
    fn the_receipt_names_files_only_and_pairs_renames() {
        let mut receipt = Receipt::default();
        receipt.deleted(Path::new("/abs/a.ts"));
        receipt.renamed(Path::new("/abs/old.ts"), Path::new("/abs/new.ts"));
        receipt.created(Path::new("/abs/copy.ts"));
        let json = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            json,
            r#"{"ops":[{"op":"deleted","path":"/abs/a.ts"},{"op":"renamed","path":"/abs/new.ts","orig_path":"/abs/old.ts"},{"op":"created","path":"/abs/copy.ts"}]}"#
        );
    }

    #[test]
    fn the_gate_denies_only_what_the_grammar_cannot_read() {
        let base = PathBuf::from("/repo");
        let decide = |command: &str| match parse_shell_ops(command, &base) {
            ParseOutcome::Unparseable { .. } => "deny",
            _ => "allow",
        };
        assert_eq!(decide("rm -rf apptest-*"), "deny");
        assert_eq!(decide("rm \"$WT/x\""), "deny");
        assert_eq!(decide("rm a.ts"), "allow");
        assert_eq!(decide("cargo build"), "allow");
        assert_eq!(decide("tugtool file rm 'apptest-*'"), "allow");

        // In-place editors: readable operands pass, unreadable ones do not.
        assert_eq!(decide("perl -i -pe 's/a/b/' src/x.ts"), "allow");
        assert_eq!(decide("perl -i -pe 's/a/b/' src/*.ts"), "deny");
        assert_eq!(decide("sed -i '' 's/a/b/' src/*.ts"), "deny");
        // The rev steer needs a checkout to judge a path against, and `/repo`
        // is not one — so it fails open here, which is the direction a broken
        // steer must always fail in.
        assert_eq!(
            decide("python3 - <<'PY'\nopen('src/x.ts','w').write('y')\nPY"),
            "allow"
        );

        // Given a real checkout, the same heredoc is denied and a read-only one
        // is not.
        let checkout = tempfile::tempdir().expect("temp");
        std::fs::write(checkout.path().join(".git"), "gitdir: elsewhere").expect("write .git");
        let decide_in = |command: &str| match parse_shell_ops(command, checkout.path()) {
            ParseOutcome::Unparseable { .. } => "deny",
            _ => "allow",
        };
        assert_eq!(
            decide_in("python3 - <<'PY'\nopen('src/x.ts','w').write('y')\nPY"),
            "deny"
        );
        assert_eq!(
            decide_in("python3 - <<'PY'\nprint(open('src/x.ts').read())\nPY"),
            "allow"
        );
    }

    #[test]
    fn a_refusal_steers_at_the_verb_that_covers_it() {
        let base = PathBuf::from("/repo");
        let reason = |command: &str| match parse_shell_ops(command, &base) {
            ParseOutcome::Unparseable { suggest, path, .. } => steering(suggest, path.as_deref()),
            other => panic!("expected a refusal for `{command}`, got {other:?}"),
        };

        // An unreadable edit points at `edit`, NOT at the lifecycle verbs — the
        // whole reason the suggestion rides on the refusal.
        let edit = reason("perl -i -pe 's/a/b/' src/*.ts");
        assert!(edit.contains("tugtool file edit"), "{edit}");
        assert!(edit.contains("tugtool file probe"), "{edit}");
        assert!(!edit.contains("rm|mv|cp"), "{edit}");

        // …and an unreadable lifecycle op still points where it always did.
        let lifecycle = reason("rm -rf apptest-*");
        assert!(lifecycle.contains("tugtool file rm|mv|cp"), "{lifecycle}");
        assert!(!lifecycle.contains("tugtool file edit"), "{lifecycle}");

        // An interpreter writing a repo file points at the edit program, and
        // shows the shape rather than describing it — the model copies what it
        // is shown.
        let checkout = tempfile::tempdir().expect("temp");
        std::fs::write(checkout.path().join(".git"), "gitdir: elsewhere").expect("write .git");
        let steer = match parse_shell_ops(
            "python3 - <<'PY'\nopen('src/x.ts','w').write('y')\nPY",
            checkout.path(),
        ) {
            ParseOutcome::Unparseable { suggest, path, .. } => steering(suggest, path.as_deref()),
            other => panic!("expected a refusal, got {other:?}"),
        };
        assert!(steer.contains("tugtool file edit"), "{steer}");
        assert!(steer.contains("--preview"), "{steer}");
        assert!(steer.contains("\n  file src/x.ts\n"), "{steer}");
        assert!(!steer.contains("rm|mv|cp"), "{steer}");
    }

    #[test]
    fn no_refusal_names_a_path_or_a_tool_of_this_checkout() {
        for suggest in [
            Suggestion::Lifecycle,
            Suggestion::Edit,
            Suggestion::Program,
            Suggestion::Run,
        ] {
            for path in [None, Some("Research_Master.md")] {
                let steer = steering(suggest, path);
                for ours in ["tugdeck/", "tugrust/", "cargo"] {
                    assert!(!steer.contains(ours), "{suggest:?} names `{ours}`: {steer}");
                }
            }
        }
    }

    #[test]
    fn a_steered_command_is_shown_its_own_file_in_the_example() {
        let checkout = tempfile::tempdir().expect("temp");
        std::fs::write(checkout.path().join(".git"), "gitdir: elsewhere").expect("write .git");
        for command in [
            "python3 - <<'EOF'\np=\"Research_Master.md\"\nopen(p,\"w\",encoding=\"utf-8\").write(s)\nEOF",
            "cat > /tmp/eucit/upd.py <<'EOF'\np=\"Research_Master.md\"\nopen(p,\"w\",encoding=\"utf-8\").write(s)\nEOF\npython3 /tmp/eucit/upd.py",
            "python3 - > /tmp/eucit/out.md <<'EOF'\nprint(text)\nEOF\nmv /tmp/eucit/out.md Research_Master.md",
        ] {
            let decision = gate_decision(command, checkout.path());
            assert_eq!(decision.decision, "deny", "`{command}`");
            let reason = decision.reason.expect("a denial says why");
            assert!(
                reason.contains("\n  file Research_Master.md\n"),
                "`{command}`: {reason}"
            );
        }
    }

    // ── stage ([P13]) ──────────────────────────────────────────────────────

    fn git_out(root: &Path, args: &[&str]) -> String {
        let out = tugcore::git_command()
            .args(args)
            .current_dir(root)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A repo with a committed `f.txt`, plus the patch that would add a line to
    /// it and the file's committed bytes.
    #[allow(clippy::disallowed_methods)] // the verb reads cwd; nextest gives each test its own process
    fn stage_fixture() -> (tempfile::TempDir, String, String) {
        let repo = init_repo();
        let root = repo.path();
        let committed = "alpha\nbravo\ncharlie\n";
        std::fs::write(root.join("f.txt"), committed).unwrap();
        commit_all(root);
        std::env::set_current_dir(root).unwrap();
        let patch = "\
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 alpha
+added
 bravo
 charlie
";
        (repo, patch.to_string(), committed.to_string())
    }

    #[test]
    fn stage_puts_the_patch_in_the_index_and_leaves_the_worktree_alone() {
        let (repo, patch, committed) = stage_fixture();
        let root = repo.path();
        let patch_file = root.join("p.diff");
        std::fs::write(&patch_file, &patch).unwrap();

        run_stage(&patch_file.to_string_lossy()).expect("stage succeeds");

        let staged = git_out(root, &["diff", "--cached", "--no-color"]);
        assert!(staged.contains("+added"), "staged was: {staged}");
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            committed,
            "staging moves no working-tree bytes",
        );
    }

    #[test]
    fn stage_refuses_a_non_applying_patch_and_stages_nothing() {
        let (repo, _patch, committed) = stage_fixture();
        let root = repo.path();
        let patch_file = root.join("p.diff");
        // Context that does not match the committed content.
        std::fs::write(
            &patch_file,
            "\
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 nothing
+added
 like
 this
",
        )
        .unwrap();

        let err = run_stage(&patch_file.to_string_lossy()).expect_err("a bad patch refuses");
        assert!(
            format!("{err:?}").contains("git apply"),
            "the refusal carries git's own words: {err:?}",
        );
        assert!(
            git_out(root, &["diff", "--cached", "--name-only"]).is_empty(),
            "a refusal stages nothing",
        );
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            committed,
        );
    }
}
