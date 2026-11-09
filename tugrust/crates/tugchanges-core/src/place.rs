//! Where an owner of a file stands relative to the project being composed —
//! the one rule both readers of the attribution ledger apply.
//!
//! A Session card reads the changeset of the project it is rooted on, so a
//! file owned by a session rooted on *another* repo is surfaced by no card:
//! the owner's card composes its own project, and this project's card shows
//! only its own entry, `unattributed` and `orphaned`. The snapshot feed's
//! orphan lift and `tugtool changes` therefore both ask the same question of
//! every owner — does it surface this file here? — and this module is the
//! single answer, so the two cannot disagree.
//!
//! "Rooted elsewhere" is decided by **repo root**, never by raw project dir:
//! a session rooted on a subdirectory of this checkout, or on this checkout
//! under another spelling, is the same repo. An arc worktree is its own repo
//! root, so a session rooted on one is elsewhere to the checkout it forked
//! from.

use std::path::{Path, PathBuf};

use crate::git::repo_root_for;

/// Where one owner stands relative to the repo being composed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerPlace {
    /// A live owner rooted on this repo: its own card surfaces the file.
    SameRepo,
    /// An owner rooted on another repo, carrying that repo's root. It
    /// surfaces nothing here whether or not it is live, so its files lift on
    /// this repo's cards naming where they came from.
    Elsewhere(PathBuf),
    /// A non-live owner rooted on this repo (or whose project is unknown):
    /// no card surfaces it, the closed-session case.
    Dead,
}

/// Classify an owner from its liveness and the project its line's seat is
/// rooted on, against `composing_root` — the repo root of the project whose
/// changeset is being composed.
///
/// Elsewhere outranks liveness: an owner rooted on another repo is named with
/// its project whether it is live or closed, because the project is the fact
/// this card cannot otherwise learn. An owner whose project is unknown (no
/// session row) is judged by liveness alone, which is the rule as it stood
/// before an owner's project was read at all.
pub fn owner_place(live: bool, owner_project: Option<&Path>, composing_root: &Path) -> OwnerPlace {
    if let Some(project) = owner_project.filter(|p| !p.as_os_str().is_empty()) {
        let owner_root = canonical(&repo_root_for(project));
        if owner_root != canonical(composing_root) {
            return OwnerPlace::Elsewhere(owner_root);
        }
    }
    if live {
        OwnerPlace::SameRepo
    } else {
        OwnerPlace::Dead
    }
}

/// The canonical spelling of `path`, or the path as given when it cannot be
/// resolved (a removed worktree): a vanished root still compares by its
/// recorded spelling rather than failing the question.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::test_fixtures::git::GitFixture;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        GitFixture::init(dir.path());
        dir
    }

    #[test]
    fn a_live_owner_on_a_subdirectory_is_same_repo() {
        let here = repo();
        let sub = here.path().join("tests/app-test");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            owner_place(true, Some(&sub), here.path()),
            OwnerPlace::SameRepo
        );
    }

    #[test]
    fn another_spelling_of_this_checkout_is_same_repo() {
        let here = repo();
        let link_parent = tempfile::tempdir().expect("tempdir");
        let link = link_parent.path().join("spelled-otherwise");
        std::os::unix::fs::symlink(here.path(), &link).unwrap();
        assert_eq!(
            owner_place(true, Some(&link), here.path()),
            OwnerPlace::SameRepo
        );
        assert_eq!(
            owner_place(false, Some(here.path()), &link),
            OwnerPlace::Dead
        );
    }

    #[test]
    fn an_owner_on_another_repo_is_elsewhere_live_or_not() {
        let here = repo();
        let there = repo();
        let root = std::fs::canonicalize(there.path()).unwrap();
        std::fs::create_dir_all(there.path().join("nested")).unwrap();
        assert_eq!(
            owner_place(true, Some(there.path()), here.path()),
            OwnerPlace::Elsewhere(root.clone())
        );
        assert_eq!(
            owner_place(false, Some(&there.path().join("nested")), here.path()),
            OwnerPlace::Elsewhere(root)
        );
    }

    #[test]
    fn a_repo_nested_inside_this_checkout_is_elsewhere() {
        // An arc worktree lives under the checkout's directory and is its own
        // repo root, so a prefix test would wrongly call it this repo.
        let here = repo();
        let nested = here.path().join(".tug/worktrees/some-arc");
        std::fs::create_dir_all(&nested).unwrap();
        GitFixture::init(&nested);
        assert!(matches!(
            owner_place(true, Some(&nested), here.path()),
            OwnerPlace::Elsewhere(_)
        ));
    }

    #[test]
    fn a_dead_same_repo_owner_is_dead_and_an_unknown_project_falls_to_liveness() {
        let here = repo();
        assert_eq!(
            owner_place(false, Some(here.path()), here.path()),
            OwnerPlace::Dead
        );
        assert_eq!(owner_place(false, None, here.path()), OwnerPlace::Dead);
        assert_eq!(owner_place(true, None, here.path()), OwnerPlace::SameRepo);
        assert_eq!(
            owner_place(true, Some(Path::new("")), here.path()),
            OwnerPlace::SameRepo
        );
    }
}
