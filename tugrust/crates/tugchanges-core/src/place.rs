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

use tugcore::pathform::resolve_to_claude_form;

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
        // Both sides through the path gateway ([L29]): one directory has many
        // spellings (`/u/…` → `/System/Volumes/Data/Users/…` ≡ `/Users/…`),
        // and only the gateway's form makes them one string.
        let owner_root = resolve_to_claude_form(&repo_root_for(project));
        if owner_root != resolve_to_claude_form(composing_root) {
            return OwnerPlace::Elsewhere(owner_root);
        }
    }
    if live {
        OwnerPlace::SameRepo
    } else {
        OwnerPlace::Dead
    }
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
    fn a_firmlinked_spelling_of_this_checkout_is_same_repo() {
        // macOS reaches one directory by two paths through a firmlink:
        // `/private/…` and `/System/Volumes/Data/private/…`. Bare
        // `canonicalize` keeps the two apart, so a workspace opened through a
        // symlink into the Data volume (`/u -> /System/Volumes/Data/Users/…`)
        // read every session rooted on `/Users/…` as another repo, and a claim
        // made there lifted straight back out as `elsewhere` ([L29]).
        let here = repo();
        let real = resolve_to_claude_form(here.path());
        let data = Path::new("/System/Volumes/Data").join(real.strip_prefix("/").unwrap());
        if !data.is_dir() {
            return; // no Data-volume spelling on this host
        }
        assert_eq!(owner_place(true, Some(&real), &data), OwnerPlace::SameRepo);
        assert_eq!(owner_place(true, Some(&data), &real), OwnerPlace::SameRepo);
        assert_eq!(owner_place(false, Some(&real), &data), OwnerPlace::Dead);
    }

    #[test]
    fn an_owner_on_another_repo_is_elsewhere_live_or_not() {
        let here = repo();
        let there = repo();
        let root = resolve_to_claude_form(there.path());
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
