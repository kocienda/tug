//! What the retired join pipeline left in a repository, and the two sweeps
//! that collect it.
//!
//! The join once ran a resolution ladder of its own: it anchored a candidate
//! commit, parked an unresolved conflict as a commit chain, leased that chain
//! to a resolver working in a `tugworkshop/<name>` checkout, recorded the
//! resolver's report, its question and its last ask, kept a ledger of each
//! run, marked what its pilot had last tried, and before that wrote a verdict
//! for every candidate. A ready arc's audit now verifies the fit of exactly
//! the tree the join lands, so the join is a squash and a land, and none of
//! that is written any more.
//!
//! Repositories that ran the older pipeline still hold its state: `tugjoin*`
//! keys on live arc branches, loose refs under `refs/tug/join/` and
//! `refs/tug/conflict/`, and workshop checkouts with their branches. Nothing
//! reads any of it, and a fact nothing reads is a lie waiting to be believed.
//!
//! [`forget_join_residue`] collects one arc's, at every teardown: a join's
//! release, a discard, and a re-performed teardown. A branch's config section
//! dies with `git branch -D`, but a loose ref and a workshop do not, so the
//! forget is what keeps them from outliving the arc. [`sweep_join_residue`]
//! collects a whole repository's, for the live arcs no teardown will reach
//! soon; tugcast's changeset recompute runs it once per repository per
//! process.
//!
//! `refs/tug/oplog/` is live state — the operation log's keepalives — and
//! nothing here touches it.

use std::path::{Path, PathBuf};

use tugtool_core::worktree::sanitize_branch_name;

use crate::ops::{branch_exists, git_output, git_stdout, main_repo_root};

/// The prefix every retired join key carried on an arc branch's config:
/// `branch.tugarc/<name>.tugjoin<what>`. The family is closed — no live key
/// begins with it — which is what lets the sweep match it whole rather than
/// keep a list that a missed spelling would leave behind.
const RETIRED_KEY_PREFIX: &str = "tugjoin";

/// The loose-ref namespaces the retired pipeline wrote, one ref per arc.
const RETIRED_REF_NAMESPACES: [&str; 2] = ["refs/tug/join/", "refs/tug/conflict/"];

/// The branch an arc's retired workshop was checked out on.
fn workshop_branch(name: &str) -> String {
    format!("tugworkshop/{}", sanitize_branch_name(name))
}

/// Where an arc's retired workshop was checked out: `<repo>/.tug/workshops/<name>`.
fn workshop_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tug")
        .join("workshops")
        .join(sanitize_branch_name(name))
}

/// Collect one arc's residue: its retired config keys, its join and conflict
/// refs, and its workshop. Run at every teardown, so a name reused later
/// starts with nothing the old pipeline wrote.
pub fn forget_join_residue(repo: &Path, name: &str, warnings: &mut Vec<String>) {
    let repo_root = main_repo_root(repo);
    let section = format!("branch.tugarc/{}.", name);
    for key in retired_keys(&repo_root) {
        if key.starts_with(&section) {
            let _ = git_output(&repo_root, &["config", "--unset-all", &key]);
        }
    }
    let leaf = sanitize_branch_name(name);
    for namespace in RETIRED_REF_NAMESPACES {
        let _ = git_output(
            &repo_root,
            &["update-ref", "-d", &format!("{namespace}{leaf}")],
        );
    }
    remove_workshop(&repo_root, &leaf, warnings);
}

/// Collect a whole repository's residue — every arc's retired keys, every
/// join and conflict ref, and every workshop. Idempotent, and cheap when
/// there is nothing to find: one config read, one ref listing, one directory
/// read and one branch listing.
pub fn sweep_join_residue(repo: &Path) -> Vec<String> {
    let repo_root = main_repo_root(repo);
    let mut warnings = Vec::new();
    for key in retired_keys(&repo_root) {
        let _ = git_output(&repo_root, &["config", "--unset-all", &key]);
    }
    for namespace in RETIRED_REF_NAMESPACES {
        if let Ok(list) = git_stdout(
            &repo_root,
            &["for-each-ref", "--format=%(refname)", namespace],
        ) {
            for refname in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
                let _ = git_output(&repo_root, &["update-ref", "-d", refname]);
            }
        }
    }
    for name in existing_workshops(&repo_root) {
        remove_workshop(&repo_root, &name, &mut warnings);
    }
    warnings
}

/// Every retired key standing in the repository's config, by full name.
fn retired_keys(repo_root: &Path) -> Vec<String> {
    let Ok(list) = git_stdout(
        repo_root,
        &["config", "--get-regexp", r"^branch\.tugarc/.*\.tugjoin"],
    ) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = list
        .lines()
        .map(|line| {
            line.split_once(' ')
                .map_or(line, |(key, _)| key)
                .to_string()
        })
        .filter(|key| {
            key.rsplit_once('.')
                .is_some_and(|(_, leaf)| leaf.starts_with(RETIRED_KEY_PREFIX))
        })
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Every workshop the repository still has, by its sanitized name.
///
/// Both halves are read, because either can outlive the other: a `worktree
/// remove` that failed leaves a directory with no branch, and a `worktree
/// prune` after a hand-deleted directory leaves a branch with no worktree.
fn existing_workshops(repo_root: &Path) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(repo_root.join(".tug").join("workshops")) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    if let Ok(list) = git_stdout(
        repo_root,
        &[
            "branch",
            "--list",
            "tugworkshop/*",
            "--format=%(refname:short)",
        ],
    ) {
        for line in list.lines() {
            if let Some(name) = line.trim().strip_prefix("tugworkshop/") {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Remove one workshop — its worktree and its `tugworkshop/<name>` branch.
fn remove_workshop(repo_root: &Path, name: &str, warnings: &mut Vec<String>) {
    let path = workshop_path(repo_root, name);
    let branch = workshop_branch(name);
    if path.exists() {
        let _ = git_output(
            repo_root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        );
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
        let _ = git_output(repo_root, &["worktree", "prune"]);
        if path.exists() {
            warnings.push(format!("Failed to remove workshop: {}", path.display()));
        }
    }
    if branch_exists(repo_root, &branch) {
        match git_output(repo_root, &["branch", "-D", &branch]) {
            Ok(o) if !o.status.success() => warnings.push(format!(
                "Failed to delete workshop branch {}: {}",
                branch,
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => warnings.push(format!("Failed to delete workshop branch {branch}: {e}")),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::config_get;
    use tugcore::test_fixtures::git::{GitFixture, git};

    /// A repo with two arc branches, each carrying what the old pipeline left.
    fn littered() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        GitFixture::init(repo);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        for name in ["one", "two"] {
            git(repo, &["branch", &format!("tugarc/{name}")]);
            for leaf in [
                "tugjoinstuck",
                "tugjoinledger",
                "tugjoinpilot",
                "tugjoinverified",
            ] {
                git(
                    repo,
                    &["config", &format!("branch.tugarc/{name}.{leaf}"), "x"],
                );
            }
            git(
                repo,
                &["config", &format!("branch.tugarc/{name}.tugbase"), "main"],
            );
            git(
                repo,
                &["update-ref", &format!("refs/tug/join/{name}"), "HEAD"],
            );
            git(
                repo,
                &["update-ref", &format!("refs/tug/conflict/{name}"), "HEAD"],
            );
            git(repo, &["branch", &format!("tugworkshop/{name}")]);
        }
        git(repo, &["update-ref", "refs/tug/oplog/1", "HEAD"]);
        temp
    }

    fn has_ref(repo: &Path, refname: &str) -> bool {
        git_stdout(repo, &["for-each-ref", "--format=%(refname)", refname])
            .is_ok_and(|s| !s.trim().is_empty())
    }

    /// One arc's teardown collects its own residue and leaves its sibling's,
    /// and leaves every live key and the operation log alone.
    #[test]
    fn a_teardown_forgets_only_its_own_arc() {
        let temp = littered();
        let repo = temp.path();
        let mut warnings = Vec::new();
        forget_join_residue(repo, "one", &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");

        assert!(config_get(repo, "branch.tugarc/one.tugjoinstuck").is_none());
        assert!(config_get(repo, "branch.tugarc/one.tugjoinpilot").is_none());
        assert!(!has_ref(repo, "refs/tug/join/one"));
        assert!(!has_ref(repo, "refs/tug/conflict/one"));
        assert!(!branch_exists(repo, "tugworkshop/one"));

        assert!(config_get(repo, "branch.tugarc/two.tugjoinstuck").is_some());
        assert!(has_ref(repo, "refs/tug/join/two"));
        assert!(branch_exists(repo, "tugworkshop/two"));

        assert_eq!(
            config_get(repo, "branch.tugarc/one.tugbase").as_deref(),
            Some("main"),
            "a live key is not residue"
        );
        assert!(
            has_ref(repo, "refs/tug/oplog/1"),
            "the op log is live state"
        );
    }

    /// The repository sweep collects every arc's residue at once, and a second
    /// sweep finds nothing.
    #[test]
    fn the_sweep_collects_every_arc_and_is_idempotent() {
        let temp = littered();
        let repo = temp.path();
        assert!(sweep_join_residue(repo).is_empty());

        for name in ["one", "two"] {
            assert!(config_get(repo, &format!("branch.tugarc/{name}.tugjoinledger")).is_none());
            assert!(config_get(repo, &format!("branch.tugarc/{name}.tugjoinverified")).is_none());
            assert!(!has_ref(repo, &format!("refs/tug/join/{name}")));
            assert!(!has_ref(repo, &format!("refs/tug/conflict/{name}")));
            assert!(!branch_exists(repo, &format!("tugworkshop/{name}")));
            assert_eq!(
                config_get(repo, &format!("branch.tugarc/{name}.tugbase")).as_deref(),
                Some("main")
            );
        }
        assert!(has_ref(repo, "refs/tug/oplog/1"));
        assert!(retired_keys(repo).is_empty());
        assert!(
            sweep_join_residue(repo).is_empty(),
            "a second sweep finds nothing"
        );
    }
}
