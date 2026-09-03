//! Keeping Tug-created `assets/` directories out of git.
//!
//! Attachments are overwhelmingly ephemeral — a screenshot pasted into a note,
//! an image dropped to look at once — and committing them to history forever is
//! the wrong default. The first time an asset is written into a directory
//! inside a working tree, this module adds that directory's **anchored,
//! worktree-relative path** to `.git/info/exclude` inside a marked block.
//!
//! Three choices in that sentence carry the weight:
//!
//! - **`.git/info/exclude`, not the project's `.gitignore`.** The exclude file
//!   needs no commit, produces no working-tree diff, is invisible to
//!   collaborators, and reverses by deleting a line. Writing the project's
//!   `.gitignore` would create an uncommitted diff in the very act of avoiding
//!   uncommitted noise, in a file the user owns.
//! - **An anchored exact path (`/arc/assets/`), never a bare `assets/`.** A
//!   bare pattern would hide a load-bearing source directory in an arbitrary
//!   repo. An anchored path cannot collide with anything.
//! - **The file is found through `git rev-parse --git-common-dir`, never by
//!   joining `<root>/.git`.** In a linked worktree — which is what every arc
//!   is — `.git` is a *file*, not a directory, so `<root>/.git/info/exclude`
//!   cannot be created. `--git-common-dir` answers with the shared `info/` in
//!   both layouts, which is also what makes "the rule is shared across
//!   worktrees" true rather than incidental: a rule written from an arc
//!   worktree is the rule the main checkout reads.
//!
//! A directory whose files git already tracks is left alone entirely, so a
//! project that has chosen to commit its assets is never touched. Tracked files
//! beat ignore rules in git's own semantics, so the flip is safe in both
//! directions with no migration either way.

use std::path::{Path, PathBuf};

use tracing::warn;

/// Opens the block this module owns inside `.git/info/exclude`.
const BLOCK_START: &str = "# tug:attachments";
/// Closes it. Everything between the two markers is ours; everything outside
/// is the user's and is never reordered, rewritten, or removed.
const BLOCK_END: &str = "# end tug:attachments";

/// The exclude-file contents that carry `line`, or `None` when they already do.
///
/// Pure over its inputs, which is the whole point: the block arithmetic — is
/// there a block, is the line in it, where does it go — is the part that can be
/// wrong, and it is tested without touching a repo.
pub(crate) fn exclude_contents_with(existing: &str, line: &str) -> Option<String> {
    let start = existing.lines().position(|l| l.trim() == BLOCK_START);
    let end = start.and_then(|from| {
        existing
            .lines()
            .skip(from + 1)
            .position(|l| l.trim() == BLOCK_END)
            .map(|offset| from + 1 + offset)
    });

    let Some((start, end)) = start.zip(end) else {
        // No block yet (or an unterminated one, which we do not try to repair —
        // appending a fresh, well-formed block is the conservative answer).
        let mut out = existing.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(BLOCK_START);
        out.push('\n');
        out.push_str(line);
        out.push('\n');
        out.push_str(BLOCK_END);
        out.push('\n');
        return Some(out);
    };

    if existing
        .lines()
        .skip(start + 1)
        .take(end - start - 1)
        .any(|l| l.trim() == line)
    {
        return None;
    }

    let mut out = String::new();
    for (i, existing_line) in existing.lines().enumerate() {
        if i == end {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(existing_line);
        out.push('\n');
    }
    Some(out)
}

/// The exclude line for `assets_dir` relative to `toplevel`: anchored, with a
/// trailing slash so it can only ever match a directory.
///
/// `None` when the directory is not inside the worktree at all, which is not a
/// situation to invent a pattern for.
fn exclude_line(toplevel: &Path, assets_dir: &Path) -> Option<String> {
    let relative = assets_dir.strip_prefix(toplevel).ok()?;
    let text = relative.to_str()?;
    if text.is_empty() {
        return None;
    }
    Some(format!("/{text}/"))
}

/// `git -C dir rev-parse <flag>`, resolved against `dir` when git answers with
/// a relative path (`--git-common-dir` commonly answers `.git`).
fn rev_parse_path(dir: &Path, flag: &str) -> Option<PathBuf> {
    let out = tugchanges_core::git::git_stdout(dir, &["rev-parse", flag]).ok()?;
    let text = out.trim();
    if text.is_empty() {
        return None;
    }
    let path = PathBuf::from(text);
    Some(if path.is_absolute() {
        path
    } else {
        dir.join(path)
    })
}

/// True when git already tracks something inside `assets_dir`, in which case
/// this module does nothing at all.
fn is_tracked(dir: &Path, assets_dir: &Path) -> bool {
    let Some(text) = assets_dir.to_str() else {
        return false;
    };
    tugchanges_core::git::git_stdout(dir, &["ls-files", "--error-unmatch", "--", text])
        .is_ok_and(|out| !out.trim().is_empty())
}

/// Add `assets_dir` to its repository's `.git/info/exclude`, if it is in one.
///
/// Idempotent, and quiet about every reason to do nothing: not a repo, already
/// excluded, already tracked. A failure is logged and never propagated — an
/// attachment that landed on disk must not be reported as failed because a
/// housekeeping write did.
pub(crate) fn ensure_assets_excluded(assets_dir: &Path) {
    // Ask git from inside the directory's own parent: `assets_dir` may not
    // exist yet at call time in some orders, and its parent always does.
    let anchor = assets_dir.parent().unwrap_or(assets_dir);
    let Some(toplevel) = rev_parse_path(anchor, "--show-toplevel") else {
        // Not a working tree. The common case outside a project.
        return;
    };
    let Some(common_dir) = rev_parse_path(anchor, "--git-common-dir") else {
        return;
    };
    if is_tracked(anchor, assets_dir) {
        return;
    }
    let Some(line) = exclude_line(&toplevel, assets_dir) else {
        return;
    };

    let info = common_dir.join("info");
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let Some(updated) = exclude_contents_with(&existing, &line) else {
        return; // Already there.
    };
    if let Err(err) = std::fs::create_dir_all(&info) {
        warn!(error = %err, "git-exclude: info dir unavailable");
        return;
    }
    if let Err(err) = std::fs::write(&exclude, updated) {
        warn!(error = %err, path = %exclude.display(), "git-exclude: write failed");
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// A real repo with one committed file, so `git status` has a baseline.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(path, &["init", "--initial-branch=main", "-q"]);
        git(path, &["config", "user.email", "t@example.com"]);
        git(path, &["config", "user.name", "Test"]);
        std::fs::write(path.join("notes.md"), b"# notes").unwrap();
        git(path, &["add", "notes.md"]);
        git(path, &["commit", "-qm", "init"]);
        dir
    }

    fn attach(dir: &Path, relative: &str) -> PathBuf {
        let assets = dir.join(relative);
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("photo.png"), b"bytes").unwrap();
        ensure_assets_excluded(&assets);
        assets
    }

    fn porcelain(dir: &Path) -> String {
        tugchanges_core::git::git_stdout(dir, &["status", "--porcelain"]).unwrap()
    }

    #[test]
    fn first_asset_writes_one_anchored_line_in_a_marked_block() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        attach(&path, "assets");

        let exclude =
            std::fs::read_to_string(path.join(".git").join("info").join("exclude")).unwrap();
        assert!(
            exclude.contains("# tug:attachments\n/assets/\n# end tug:attachments\n"),
            "{exclude}"
        );
        // The point of all of it: the asset is invisible to git.
        assert_eq!(porcelain(&path), "");
    }

    #[test]
    fn a_second_asset_in_the_same_directory_adds_nothing() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        let assets = attach(&path, "assets");
        let after_first =
            std::fs::read_to_string(path.join(".git").join("info").join("exclude")).unwrap();

        std::fs::write(assets.join("second.png"), b"more").unwrap();
        ensure_assets_excluded(&assets);

        assert_eq!(
            std::fs::read_to_string(path.join(".git").join("info").join("exclude")).unwrap(),
            after_first,
        );
    }

    #[test]
    fn two_directories_get_two_anchored_lines_in_one_block() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        attach(&path, "assets");
        attach(&path, "arc/assets");

        let exclude =
            std::fs::read_to_string(path.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.contains("/assets/"), "{exclude}");
        assert!(exclude.contains("/arc/assets/"), "{exclude}");
        assert_eq!(exclude.matches(BLOCK_START).count(), 1, "{exclude}");
        assert_eq!(exclude.matches(BLOCK_END).count(), 1, "{exclude}");
        assert_eq!(porcelain(&path), "");
    }

    /// A project that has chosen to commit its assets is never touched — and
    /// does not need to be, since tracked files beat ignore rules anyway.
    #[test]
    fn a_tracked_assets_directory_is_left_alone() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        let assets = path.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("photo.png"), b"bytes").unwrap();
        git(&path, &["add", "assets"]);
        git(&path, &["commit", "-qm", "assets"]);

        // `git init` lays down a template exclude file, so the claim is that
        // its bytes do not move — not that it is absent.
        let exclude = path.join(".git").join("info").join("exclude");
        let before = std::fs::read_to_string(&exclude).unwrap_or_default();
        ensure_assets_excluded(&assets);
        let after = std::fs::read_to_string(&exclude).unwrap_or_default();

        assert_eq!(before, after);
        assert!(!after.contains(BLOCK_START), "{after}");
    }

    #[test]
    fn a_non_repo_directory_writes_no_exclude_file() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();

        ensure_assets_excluded(&assets);

        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn the_project_gitignore_is_never_modified() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(path.join(".gitignore"), "target/\n").unwrap();

        attach(&path, "assets");

        assert_eq!(
            std::fs::read_to_string(path.join(".gitignore")).unwrap(),
            "target/\n",
        );
    }

    /// The layout that broke the obvious implementation: in a linked worktree
    /// `.git` is a file, so `<root>/.git/info/exclude` cannot exist. The rule
    /// belongs in the shared common dir, which is also what makes it apply in
    /// the main checkout and every other worktree.
    #[test]
    fn a_linked_worktree_writes_into_the_shared_common_dir() {
        let dir = repo();
        let main = std::fs::canonicalize(dir.path()).unwrap();
        let linked = main.join("wt");
        git(&main, &["worktree", "add", "-q", "wt"]);
        let linked = std::fs::canonicalize(&linked).unwrap();
        assert!(
            linked.join(".git").is_file(),
            "worktree .git should be a file"
        );

        attach(&linked, "assets");

        let exclude =
            std::fs::read_to_string(main.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.contains("/assets/"), "{exclude}");
        assert_eq!(porcelain(&linked), "");
    }

    #[test]
    fn a_bare_assets_pattern_is_never_written() {
        let dir = repo();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        attach(&path, "assets");

        let exclude =
            std::fs::read_to_string(path.join(".git").join("info").join("exclude")).unwrap();
        for line in exclude.lines() {
            assert!(
                line.trim() != "assets/" && line.trim() != "assets",
                "an unanchored pattern would hide a source directory: {exclude}",
            );
        }
    }

    #[test]
    fn the_users_own_exclude_lines_are_preserved() {
        let existing = "# my own notes\n*.swp\n";
        let updated = exclude_contents_with(existing, "/assets/").unwrap();
        assert!(updated.starts_with("# my own notes\n*.swp\n"), "{updated}");
        assert!(updated.contains("/assets/"), "{updated}");

        // A second line joins the existing block rather than starting another.
        let twice = exclude_contents_with(&updated, "/arc/assets/").unwrap();
        assert_eq!(twice.matches(BLOCK_START).count(), 1, "{twice}");
        assert!(
            twice.contains("/assets/") && twice.contains("/arc/assets/"),
            "{twice}"
        );

        // And the same line again is a no-op.
        assert_eq!(exclude_contents_with(&twice, "/assets/"), None);
    }
}
