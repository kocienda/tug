//! Whole steps: where an arc's last step boundary is, and the settle a user's
//! Stop runs to put the worktree back on it.
//!
//! A Stop pressed mid-step used to leave whatever the interrupted turn had
//! written — uncommitted edits, and any `yield:` rounds the open step had
//! already committed — on a ledger row still reading `in progress`. The arc
//! then resumed on top of half a step nobody had finished. The settle makes a
//! Stop leave whole steps: the worktree goes back to the newest commit a
//! finished step recorded, the open row goes back to `pending`, and the work
//! that was cut off is kept, not destroyed, at `refs/tug/partial/<name>`.
//!
//! The snapshot is taken **before** anything is reset, and the log line that
//! names it is written in the same act. An internal operation may not destroy
//! user-visible state ([L23]); the reset is lawful only because what it
//! removes is still reachable and the receipt says where.

use std::path::{Path, PathBuf};

use tugcore::instance::Paths;
use tugtool_core::worktree::sanitize_branch_name;

use crate::error::ArcError;

use super::{
    arc_base, branch_exists, branch_name, config_get, git_output, git_stdout, ledger_file,
    main_repo_root, step_reset_in, worktree_path,
};

/// The git config key a successor's branch records its cut point under. Only a
/// successor carries it; every other arc's fork point is its merge-base with
/// the base ([`fork_point`]).
pub(crate) fn fork_config_key(name: &str) -> String {
    format!("branch.{}.tugfrom", branch_name(name))
}

/// The ref a settle keeps the cut-off work at. Overwritten by each settle and
/// collected at the arc's teardown.
pub fn partial_ref(name: &str) -> String {
    format!("refs/tug/partial/{}", sanitize_branch_name(name))
}

/// The arc-log marker a settle writes. Not a short sha, so no reader takes it
/// for a round, and not terminal.
pub const PARTIAL_MARKER: &str = "partial";

/// Whether `ancestor` is an ancestor of (or equal to) `of`, in `dir`.
pub(crate) fn is_ancestor(dir: &Path, ancestor: &str, of: &str) -> bool {
    git_output(dir, &["merge-base", "--is-ancestor", ancestor, of])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Resolve a commit-ish to a full sha in `dir`, or `None` when it names no
/// commit there.
pub(crate) fn resolve_commit(dir: &Path, rev: &str) -> Option<String> {
    let rev = rev.trim().trim_matches('`');
    if rev.is_empty() {
        return None;
    }
    git_stdout(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .ok()
    .filter(|sha| !sha.is_empty())
}

/// Where an arc's branch was cut from.
///
/// A successor's branch starts inside another arc's history, so its cut point
/// is recorded at creation as `tugfrom` and read back while it is still an
/// ancestor of the branch head. Every other arc sits directly on its base, so
/// its fork point is the merge-base with the base — which is also right after
/// a replay has moved it onto a newer base tip, the case a stored base tip
/// would get wrong.
pub fn fork_point(repo: &Path, name: &str) -> Option<String> {
    let repo = main_repo_root(repo);
    let branch = branch_name(name);
    let head = resolve_commit(&repo, &branch)?;
    if let Some(from) = config_get(&repo, &fork_config_key(name)) {
        if let Some(from) = resolve_commit(&repo, &from) {
            if is_ancestor(&repo, &from, &head) {
                return Some(from);
            }
        }
    }
    let base = arc_base(&repo, name).ok()?;
    git_stdout(&repo, &["merge-base", &base, &branch])
        .ok()
        .filter(|sha| !sha.is_empty())
}

/// The ledger's rows, read from the arc's plan or task list. An arc with no
/// ledger yet — one still in devise — has none.
pub(crate) fn ledger_rows(repo: &Path, name: &str) -> Vec<tugtool_core::plan::LedgerRow> {
    let Some(file) = ledger_file(repo, name) else {
        return Vec::new();
    };
    let Ok(source) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    tugtool_core::plan::parse(&source)
        .map(|doc| doc.ledger_rows)
        .unwrap_or_default()
}

/// The step number a ledger anchor names (`step-3` → 3).
pub(crate) fn anchor_step(anchor: &str) -> Option<u32> {
    anchor.strip_prefix("step-")?.parse().ok()
}

/// The arc's last step boundary: the commit its worktree would be at had every
/// step it started been either finished or never begun.
///
/// With no row `in progress` that is the branch head. Otherwise it is the
/// newest, by ancestry, of the fork point and every `done` row's recorded
/// commit that is still an ancestor of the head.
pub fn step_boundary(repo: &Path, name: &str) -> Result<String, ArcError> {
    let repo = main_repo_root(repo);
    let branch = branch_name(name);
    let head = resolve_commit(&repo, &branch)
        .ok_or_else(|| ArcError::Refused(format!("arc '{name}' has no branch {branch}")))?;
    let rows = ledger_rows(&repo, name);
    if !rows.iter().any(|r| r.status == "in progress") {
        return Ok(head);
    }
    let worktree = worktree_path(&repo, name);
    let dir: &Path = if worktree.exists() { &worktree } else { &repo };

    let mut candidates: Vec<String> = Vec::new();
    if let Some(fork) = fork_point(&repo, name) {
        candidates.push(fork);
    }
    for row in rows.iter().filter(|r| r.status == "done") {
        if let Some(sha) = row.commit.as_deref().and_then(|c| resolve_commit(dir, c)) {
            candidates.push(sha);
        }
    }
    candidates.retain(|c| is_ancestor(dir, c, &head));
    candidates.dedup();
    let newest = candidates
        .iter()
        .find(|c| candidates.iter().all(|o| is_ancestor(dir, o, c)))
        .cloned();
    newest.ok_or_else(|| {
        ArcError::Refused(format!(
            "arc '{name}' has a step in progress but no finished step or fork point beneath its head"
        ))
    })
}

/// What a settle did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    /// The worktree was already on a step boundary and clean, or there is no
    /// worktree to settle.
    Nothing,
    Settled(Settled),
}

/// A settle that moved the worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    /// The commit the worktree now sits on.
    pub boundary: String,
    /// The snapshot of everything that was cut off, at [`partial_ref`].
    pub partial: String,
    /// The step whose row went back to `pending`, if one was open.
    pub reset_step: Option<u32>,
    /// Commits on the branch past the boundary that the reset dropped.
    pub rounds_dropped: u32,
    /// Uncommitted paths the snapshot took.
    pub dirty_paths: usize,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

/// Commit everything in `worktree` — tracked and untracked, never ignored — as
/// a snapshot on top of its HEAD, through a scratch index so the worktree's
/// own index is untouched. Answers the snapshot's sha.
fn snapshot(worktree: &Path, name: &str) -> Result<String, ArcError> {
    let index_rel = git_stdout(worktree, &["rev-parse", "--git-path", "tug-partial-index"])?;
    let index = {
        let p = PathBuf::from(&index_rel);
        if p.is_absolute() { p } else { worktree.join(p) }
    };
    let _ = std::fs::remove_file(&index);
    let with_index = |args: &[&str]| -> Result<String, ArcError> {
        let out = tugcore::git_command()
            .arg("-C")
            .arg(worktree)
            .env("GIT_INDEX_FILE", &index)
            .args(args)
            .output()
            .map_err(|e| {
                ArcError::git(
                    format!("failed to run git {}", args.join(" ")),
                    args,
                    e.to_string(),
                )
            })?;
        if !out.status.success() {
            return Err(ArcError::git(
                format!("git {} failed", args.join(" ")),
                args,
                String::from_utf8_lossy(&out.stderr).trim(),
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let result = (|| {
        with_index(&["read-tree", "HEAD"])?;
        with_index(&["add", "-A"])?;
        let tree = with_index(&["write-tree"])?;
        with_index(&[
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            &format!("partial: {name} at stop"),
        ])
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Put an arc's worktree back on its last step boundary, keeping what that
/// cuts off at [`partial_ref`].
///
/// In order: snapshot the worktree on top of its head, point the partial ref
/// at it, reset to the boundary, remove untracked files (never ignored ones,
/// so build output survives), put the open step back to `pending`, and write
/// a `partial` line naming the snapshot.
pub fn settle_to_step_boundary(
    paths: &Paths,
    repo: &Path,
    name: &str,
) -> Result<SettleOutcome, ArcError> {
    let repo = main_repo_root(repo);
    let worktree = worktree_path(&repo, name);
    if !worktree.exists() || !branch_exists(&repo, &branch_name(name)) {
        return Ok(SettleOutcome::Nothing);
    }
    let head = git_stdout(&worktree, &["rev-parse", "HEAD"])?;
    let boundary = step_boundary(&repo, name)?;
    let status = tugchanges_core::git::read_status(&worktree, &["--untracked-files=all"])
        .map_err(|e| ArcError::git("git status failed", &["status"], e.to_string()))?;
    let dirty_paths = status.entries.len() + status.untracked.len();
    if boundary == head && dirty_paths == 0 {
        return Ok(SettleOutcome::Nothing);
    }

    let partial = if dirty_paths == 0 {
        head.clone()
    } else {
        snapshot(&worktree, name)?
    };
    git_stdout(&repo, &["update-ref", &partial_ref(name), &partial])?;

    let rounds_dropped = git_stdout(
        &worktree,
        &["rev-list", "--count", &format!("{boundary}..{head}")],
    )?
    .parse()
    .unwrap_or(0);
    git_stdout(&worktree, &["reset", "--hard", &boundary])?;
    git_stdout(&worktree, &["clean", "-fd"])?;

    let open = ledger_rows(&repo, name)
        .into_iter()
        .find(|r| r.status == "in progress")
        .and_then(|r| anchor_step(&r.anchor));
    if let Some(step) = open {
        let why = format!(
            "stopped by user; the cut-off work is at {} ({})",
            partial_ref(name),
            short(&partial)
        );
        step_reset_in(paths, &repo, name, step, Some(&why))?;
    }
    let note = match open {
        Some(step) => format!("{} step {step}", short(&partial)),
        None => format!("{} -", short(&partial)),
    };
    crate::log::append_arc_log(paths, &repo, name, PARTIAL_MARKER, &note)
        .map_err(|e| ArcError::arc_log(paths, &repo, e))?;

    Ok(SettleOutcome::Settled(Settled {
        boundary,
        partial,
        reset_step: open,
        rounds_dropped,
        dirty_paths,
    }))
}

/// The partial ref a stop receipt should name: set when the arc's current
/// generation has a `partial` line newer than its last `arc-stage` line, so a
/// settle from an earlier stop is not announced again after the arc resumed.
pub fn unreported_partial(paths: &Paths, repo: &Path, name: &str) -> Option<String> {
    let repo = main_repo_root(repo);
    let path = tugtool_core::paths::arc_log_path_at(paths, &repo);
    let text = std::fs::read_to_string(path).ok()?;
    let mut partial: Option<String> = None;
    for line in text.lines() {
        let Some((_, arc, marker, note)) = crate::log::split_log_line(line) else {
            continue;
        };
        if arc != name {
            continue;
        }
        if crate::log::is_terminal(marker, note) || marker == "arc-stage" {
            partial = None;
        } else if marker == PARTIAL_MARKER {
            partial = Some(partial_ref(name));
        }
    }
    partial
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use std::fs;

    fn wt(root: &Path, name: &str) -> PathBuf {
        worktree_path(root, name)
    }

    fn head_of(root: &Path, name: &str) -> String {
        git_stdout(&wt(root, name), &["rev-parse", "HEAD"]).unwrap()
    }

    fn tree_has(root: &Path, rev: &str, path: &str, content: &str) -> bool {
        git_stdout(root, &["show", &format!("{rev}:{path}")])
            .map(|s| s == content.trim_end())
            .unwrap_or(false)
    }

    #[test]
    fn dirt_with_no_open_step_settles_to_head_and_keeps_the_dirt() {
        let (_temp, root, paths) = stepped_arc("s1");
        let head = head_of(&root, "s1");
        fs::write(wt(&root, "s1").join("README.md"), "changed\n").unwrap();
        fs::write(wt(&root, "s1").join("new.txt"), "untracked\n").unwrap();

        let SettleOutcome::Settled(s) = settle_to_step_boundary(&paths, &root, "s1").unwrap()
        else {
            panic!("expected a settle");
        };
        assert_eq!(s.boundary, head);
        assert_eq!(s.reset_step, None);
        assert_eq!(s.dirty_paths, 2);
        assert_eq!(porcelain_of(&wt(&root, "s1")), "");
        let kept = git_stdout(&root, &["rev-parse", &partial_ref("s1")]).unwrap();
        assert_eq!(kept, s.partial);
        assert!(tree_has(&root, &kept, "README.md", "changed"));
        assert!(tree_has(&root, &kept, "new.txt", "untracked"));
        assert!(log_text(&paths, &root).contains("s1  partial  "));
    }

    #[test]
    fn an_open_step_settles_to_the_last_done_commit_and_parks_the_row() {
        let (_temp, root, paths) = stepped_arc("s2");
        step_start_in(&paths, &root, "s2", 1, 2).unwrap();
        fs::write(wt(&root, "s2").join("one.txt"), "first\n").unwrap();
        commit_in(&paths, &root, "s2", "r1", None, None).unwrap();
        step_done_in(&paths, &root, "s2", 1, None).unwrap();
        let done = head_of(&root, "s2");

        step_start_in(&paths, &root, "s2", 2, 2).unwrap();
        fs::write(wt(&root, "s2").join("two.txt"), "yielded\n").unwrap();
        commit_in(&paths, &root, "s2", "yield: half", None, None).unwrap();
        fs::write(wt(&root, "s2").join("three.txt"), "dirt\n").unwrap();

        let SettleOutcome::Settled(s) = settle_to_step_boundary(&paths, &root, "s2").unwrap()
        else {
            panic!("expected a settle");
        };
        assert_eq!(s.boundary, done);
        assert_eq!(s.reset_step, Some(2));
        assert_eq!(s.rounds_dropped, 1);
        assert_eq!(head_of(&root, "s2"), done);
        assert_eq!(porcelain_of(&wt(&root, "s2")), "");
        assert_eq!(ledger_row(&root, "s2", "step-2").status, "pending");
        assert_eq!(ledger_row(&root, "s2", "step-1").status, "done");
        assert!(tree_has(&root, &s.partial, "two.txt", "yielded"));
        assert!(tree_has(&root, &s.partial, "three.txt", "dirt"));

        // The park line comes before the partial line, which names the step.
        let log = log_text(&paths, &root);
        let reset_at = log.rfind("step-reset").expect("a step-reset line");
        let partial_at = log.rfind("  partial  ").expect("a partial line");
        assert!(reset_at < partial_at);
        assert!(log[partial_at..].contains("step 2"));
    }

    #[test]
    fn an_open_first_step_settles_to_the_fork_point() {
        let (_temp, root, paths) = stepped_arc("s3");
        let fork = head_of(&root, "s3");
        step_start_in(&paths, &root, "s3", 1, 2).unwrap();
        fs::write(wt(&root, "s3").join("one.txt"), "half\n").unwrap();
        commit_in(&paths, &root, "s3", "yield: half", None, None).unwrap();

        let SettleOutcome::Settled(s) = settle_to_step_boundary(&paths, &root, "s3").unwrap()
        else {
            panic!("expected a settle");
        };
        assert_eq!(s.boundary, fork);
        assert_eq!(head_of(&root, "s3"), fork);
        assert!(!wt(&root, "s3").join("one.txt").exists());
        assert_eq!(ledger_row(&root, "s3", "step-1").status, "pending");
    }

    #[test]
    fn a_clean_worktree_at_a_boundary_settles_nothing() {
        let (_temp, root, paths) = stepped_arc("s4");
        assert_eq!(
            settle_to_step_boundary(&paths, &root, "s4").unwrap(),
            SettleOutcome::Nothing
        );
        assert!(
            git_stdout(
                &root,
                &["rev-parse", "--verify", "--quiet", &partial_ref("s4")]
            )
            .is_err()
        );
    }

    #[test]
    fn an_ignored_file_survives_the_clean() {
        let (_temp, root, paths) = stepped_arc("s5");
        let w = wt(&root, "s5");
        fs::write(w.join(".gitignore"), ".tugtree/\n.tug/\ntarget/\n").unwrap();
        commit_in(&paths, &root, "s5", "ignore target", None, None).unwrap();
        fs::create_dir_all(w.join("target")).unwrap();
        fs::write(w.join("target/x"), "built\n").unwrap();
        fs::write(w.join("stray.txt"), "stray\n").unwrap();

        settle_to_step_boundary(&paths, &root, "s5").unwrap();
        assert!(w.join("target/x").exists());
        assert!(!w.join("stray.txt").exists());
    }

    #[test]
    fn fork_point_is_the_merge_base_unless_a_tugfrom_is_an_ancestor() {
        let (_temp, root, _paths) = stepped_arc("s6");
        let base = git_stdout(&root, &["rev-parse", "main"]).unwrap();
        assert_eq!(fork_point(&root, "s6").as_deref(), Some(base.as_str()));

        // A tugfrom that is not on the branch's history is ignored.
        fs::write(root.join("elsewhere.txt"), "x\n").unwrap();
        git(&root, &["checkout", "-q", "-b", "side"]);
        commit_all(&root, "side");
        let side = git_stdout(&root, &["rev-parse", "HEAD"]).unwrap();
        git(&root, &["checkout", "-q", "main"]);
        git(&root, &["config", &fork_config_key("s6"), &side]);
        assert_eq!(fork_point(&root, "s6").as_deref(), Some(base.as_str()));

        // One that is an ancestor is read back.
        git(&root, &["config", &fork_config_key("s6"), &base]);
        assert_eq!(fork_point(&root, "s6").as_deref(), Some(base.as_str()));
    }

    #[test]
    fn after_a_replay_the_fork_point_is_the_new_base_tip() {
        let (_temp, root, paths) = stepped_arc("s7");
        fs::write(wt(&root, "s7").join("arc.txt"), "arc\n").unwrap();
        commit_in(&paths, &root, "s7", "a round", None, None).unwrap();
        // The base moves on.
        fs::write(root.join("base.txt"), "moved\n").unwrap();
        commit_all(&root, "base moves");
        let new_base = git_stdout(&root, &["rev-parse", "main"]).unwrap();

        crate::replay::replay_onto(&paths, &root, "s7").unwrap();
        assert_eq!(fork_point(&root, "s7").as_deref(), Some(new_base.as_str()));

        // A settle over an open first step stays on the new base rather than
        // rewinding the arc onto the old one.
        step_start_in(&paths, &root, "s7", 1, 2).unwrap();
        fs::write(wt(&root, "s7").join("half.txt"), "half\n").unwrap();
        settle_to_step_boundary(&paths, &root, "s7").unwrap();
        assert_eq!(head_of(&root, "s7"), new_base);
        assert!(wt(&root, "s7").join("base.txt").exists());
    }

    #[test]
    fn the_partial_is_unreported_only_until_the_next_rotation() {
        let (_temp, root, paths) = stepped_arc("s8");
        fs::write(wt(&root, "s8").join("d.txt"), "d\n").unwrap();
        assert_eq!(unreported_partial(&paths, &root, "s8"), None);
        settle_to_step_boundary(&paths, &root, "s8").unwrap();
        assert_eq!(
            unreported_partial(&paths, &root, "s8").as_deref(),
            Some("refs/tug/partial/s8")
        );
        crate::arc::append_arc_stage(
            &paths,
            &root,
            "s8",
            crate::arc::ArcStage::Implement,
            "sess-1",
            None,
        )
        .unwrap();
        assert_eq!(unreported_partial(&paths, &root, "s8"), None);
    }
}
