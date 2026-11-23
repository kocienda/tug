//! Successors: where a parked arc's finished work ends, and the check that a
//! new arc may start from it.
//!
//! A successor is an ordinary arc whose branch is cut inside another arc's
//! history rather than at its base tip, and which lands on that arc's base.
//! The user picks how much of the old arc it carries — the old arc's tip, the
//! end of a finished step, or nothing past its fork point — and the choice
//! resolves to one commit here. The new arc's opening records the succession
//! (`arc-succeeds`), and its seat is cut there ([`super::create_in`]).

use std::path::Path;

use tugcore::instance::Paths;

use crate::arc::{ArcStopReason, Succession, read_arc};
use crate::error::ArcError;

use super::{
    anchor_step, arc_base, branch_exists, branch_name, fork_point, is_ancestor, ledger_rows,
    main_repo_root, resolve_commit, step_boundary, worktree_path,
};

/// How much of a parked arc's work its successor carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Boundary {
    /// Everything the old arc finished: its step boundary.
    Tip,
    /// Nothing: the old arc's fork point.
    Fork,
    /// Steps up to and including step `K`, at that row's recorded commit.
    Step(u32),
}

impl Boundary {
    /// Read `tip`, `fork` or `step:<K>`.
    pub fn parse(word: &str) -> Option<Boundary> {
        match word.trim() {
            "tip" => Some(Boundary::Tip),
            "fork" => Some(Boundary::Fork),
            other => other
                .strip_prefix("step:")
                .and_then(|k| k.parse().ok())
                .map(Boundary::Step),
        }
    }

    /// The word the arc log and the CONTROL verbs carry.
    pub fn format(&self) -> String {
        match self {
            Boundary::Tip => "tip".to_owned(),
            Boundary::Fork => "fork".to_owned(),
            Boundary::Step(k) => format!("step:{k}"),
        }
    }
}

/// The full sha of the old arc's base tip.
fn base_tip(repo: &Path, old: &str) -> Result<String, ArcError> {
    let base = arc_base(repo, old)?;
    resolve_commit(repo, &base)
        .ok_or_else(|| ArcError::Refused(format!("the base branch '{base}' names no commit")))
}

/// Resolve a boundary choice against arc `old` to the full sha its successor
/// starts at.
///
/// `tip` is the old arc's step boundary, `step:K` is step K's recorded commit
/// (refused unless that row is `done`), and `fork` is its fork point. An old
/// arc with no branch — a planned arc parked before any seat was made — has no
/// finished work, and every choice resolves to its base's tip.
pub fn resolve_boundary(
    _paths: &Paths,
    repo: &Path,
    old: &str,
    boundary: Boundary,
) -> Result<String, ArcError> {
    let repo = main_repo_root(repo);
    if !branch_exists(&repo, &branch_name(old)) {
        return base_tip(&repo, old);
    }
    match boundary {
        Boundary::Tip => step_boundary(&repo, old),
        Boundary::Fork => fork_point(&repo, old)
            .ok_or_else(|| ArcError::Refused(format!("arc '{old}' has no fork point"))),
        Boundary::Step(k) => {
            let row = ledger_rows(&repo, old)
                .into_iter()
                .find(|r| anchor_step(&r.anchor) == Some(k))
                .ok_or_else(|| ArcError::Refused(format!("arc '{old}' has no step {k}")))?;
            if row.status != "done" {
                return Err(ArcError::Refused(format!(
                    "step {k} of '{old}' is {}, not done, so it ends no finished work",
                    row.status
                )));
            }
            let worktree = worktree_path(&repo, old);
            let dir: &Path = if worktree.exists() { &worktree } else { &repo };
            row.commit
                .as_deref()
                .and_then(|cell| resolve_commit(dir, cell))
                .ok_or_else(|| ArcError::Refused(format!("step {k} of '{old}' records no commit")))
        }
    }
}

/// What [`validate_succession`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuccessionCheck {
    /// The new arc may open as a successor; write this succession.
    Open(Succession),
    /// The new arc is already live and already succeeds `old` from this
    /// commit: a door run twice, which binds rather than refuses.
    AlreadyRecorded(Succession),
}

/// Whether `new` may open as a successor of `old` starting at `sha`.
///
/// Refused unless `old` is stopped as parked, `sha` is on its branch (or, when
/// it has no branch, is its base's tip), and `new` has no live generation — save
/// one that already succeeds `old` at the same commit, which is accepted.
pub fn validate_succession(
    paths: &Paths,
    repo: &Path,
    new: &str,
    old: &str,
    sha: &str,
) -> Result<SuccessionCheck, ArcError> {
    let repo = main_repo_root(repo);
    if new == old {
        return Err(ArcError::Refused(format!("'{new}' cannot succeed itself")));
    }
    let from = resolve_commit(&repo, sha)
        .ok_or_else(|| ArcError::Refused(format!("'{sha}' names no commit")))?;

    if let Some(record) = read_arc(paths, &repo, new) {
        return match record.succeeds {
            Some(s) if s.arc == old && s.from == from => Ok(SuccessionCheck::AlreadyRecorded(s)),
            _ => Err(ArcError::Refused(format!("'{new}' is already a live arc"))),
        };
    }

    let parked = read_arc(paths, &repo, old)
        .and_then(|r| r.stopped)
        .is_some_and(|(_, reason)| reason == ArcStopReason::Parked.as_str());
    if !parked {
        return Err(ArcError::Refused(format!("'{old}' is not parked")));
    }

    let branch = branch_name(old);
    if branch_exists(&repo, &branch) {
        if !is_ancestor(&repo, &from, &branch) {
            return Err(ArcError::Refused(format!(
                "{} is not on {branch}, so it is none of '{old}''s work",
                &from[..from.len().min(10)]
            )));
        }
    } else if from != base_tip(&repo, old)? {
        return Err(ArcError::Refused(format!(
            "'{old}' has no branch, so its successor starts at its base's tip"
        )));
    }

    Ok(SuccessionCheck::Open(Succession {
        arc: old.to_owned(),
        from,
        base: arc_base(&repo, old)?,
    }))
}

/// Open `new` as a successor of `old`, starting at `sha`: check the
/// succession, open the arc, and record `arc-succeeds` right after its
/// `arc-start`, in the one act that opens the generation.
///
/// A door run twice finds the succession already recorded and opens nothing
/// new: the arc's record is returned as it stands. Both openers call this —
/// `tugtool arc run`, which opens client-side before it asks the server to
/// bind, and the server's `arc_run`, which opens when it finds no record — so
/// whichever reaches the log first writes the line and the other finds it.
pub fn open_successor(
    paths: &Paths,
    repo: &Path,
    new: &str,
    old: &str,
    sha: &str,
) -> Result<super::OpenOutcome, ArcError> {
    match validate_succession(paths, repo, new, old, sha)? {
        SuccessionCheck::AlreadyRecorded(_) => super::open_arc(paths, repo, new),
        SuccessionCheck::Open(succession) => {
            let opened = super::open_arc(paths, repo, new)?;
            crate::arc::append_arc_succeeds(paths, repo, new, &succession)
                .map_err(|e| ArcError::arc_log(paths, repo, e))?;
            let record = read_arc(paths, repo, new).unwrap_or(opened.record);
            Ok(super::OpenOutcome { record, ..opened })
        }
    }
}

/// How many of the old arc's steps a successor carries: the highest `done` row
/// whose recorded commit is an ancestor of (or equal to) the commit the
/// successor was cut at. `None` when it carries none.
pub fn carried_steps(repo: &Path, succession: &Succession) -> Option<u32> {
    let repo = main_repo_root(repo);
    ledger_rows(&repo, &succession.arc)
        .into_iter()
        .filter(|r| r.status == "done")
        .filter_map(|r| {
            let k = anchor_step(&r.anchor)?;
            let sha = resolve_commit(&repo, r.commit.as_deref()?)?;
            is_ancestor(&repo, &sha, &succession.from).then_some(k)
        })
        .max()
}

/// The line a successor's every opening prompt carries, saying what arc it
/// succeeds and how much of that arc's ledger it starts with.
pub fn successor_clause(repo: &Path, succession: &Succession) -> String {
    let from = &succession.from[..succession.from.len().min(9)];
    let carries = match carried_steps(repo, succession) {
        Some(k) => format!("carries steps 1–{k} of its ledger"),
        None => "carries none".to_owned(),
    };
    format!("successor: of {} · from {from} · {carries}", succession.arc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arc::{ArcStage, append_arc_start, append_arc_stop, append_arc_succeeds};
    use crate::ops::test_support::*;
    use crate::ops::*;
    use std::fs;

    fn sha(dir: &Path, rev: &str) -> String {
        git_stdout(dir, &["rev-parse", rev]).unwrap()
    }

    /// An arc with step 1 done on one round and step 2 pending.
    fn one_step_done(name: &str) -> (tempfile::TempDir, std::path::PathBuf, Paths, String) {
        let (temp, root, paths) = stepped_arc(name);
        let wt = worktree_path(&root, name);
        step_start_in(&paths, &root, name, 1, 2).unwrap();
        fs::write(wt.join("one.txt"), "first\n").unwrap();
        commit_in(&paths, &root, name, "r1", None, None).unwrap();
        step_done_in(&paths, &root, name, 1, None).unwrap();
        let done = sha(&wt, "HEAD");
        (temp, root, paths, done)
    }

    fn park(paths: &Paths, root: &Path, name: &str) {
        append_arc_start(paths, root, name, ".tug/arcs/x/brief.md").unwrap();
        append_arc_stop(
            paths,
            root,
            name,
            ArcStage::Implement,
            ArcStopReason::Parked,
        )
        .unwrap();
    }

    #[test]
    fn boundary_words_round_trip() {
        for b in [Boundary::Tip, Boundary::Fork, Boundary::Step(3)] {
            assert_eq!(Boundary::parse(&b.format()), Some(b));
        }
        assert_eq!(Boundary::parse("step:x"), None);
        assert_eq!(Boundary::parse("later"), None);
    }

    #[test]
    fn boundaries_resolve_to_tip_fork_and_a_done_step() {
        let (_temp, root, paths, done) = one_step_done("old1");
        let fork = sha(&root, "main");
        assert_eq!(
            resolve_boundary(&paths, &root, "old1", Boundary::Tip).unwrap(),
            done
        );
        assert_eq!(
            resolve_boundary(&paths, &root, "old1", Boundary::Fork).unwrap(),
            fork
        );
        assert_eq!(
            resolve_boundary(&paths, &root, "old1", Boundary::Step(1)).unwrap(),
            done
        );
        assert!(resolve_boundary(&paths, &root, "old1", Boundary::Step(2)).is_err());
    }

    #[test]
    fn an_old_arc_with_no_branch_resolves_every_choice_to_the_base_tip() {
        let temp = tempfile::TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        let root = fs::canonicalize(&repo).unwrap();
        let tip = sha(&root, "main");
        for b in [Boundary::Tip, Boundary::Fork, Boundary::Step(2)] {
            assert_eq!(resolve_boundary(&paths, &root, "unseated", b).unwrap(), tip);
        }
    }

    #[test]
    fn validate_refuses_an_unparked_arc_and_a_commit_off_its_branch() {
        let (_temp, root, paths, done) = one_step_done("old2");
        append_arc_start(&paths, &root, "old2", ".tug/arcs/old2/brief.md").unwrap();
        let err = validate_succession(&paths, &root, "old2-v2", "old2", &done).unwrap_err();
        assert!(err.to_string().contains("not parked"), "{err}");

        append_arc_stop(
            &paths,
            &root,
            "old2",
            ArcStage::Implement,
            ArcStopReason::Parked,
        )
        .unwrap();
        // A commit on the base after the fork is not the old arc's work.
        fs::write(root.join("base.txt"), "moved\n").unwrap();
        commit_all(&root, "base moves");
        let off = sha(&root, "main");
        assert!(validate_succession(&paths, &root, "old2-v2", "old2", &off).is_err());

        let SuccessionCheck::Open(s) =
            validate_succession(&paths, &root, "old2-v2", "old2", &done).unwrap()
        else {
            panic!("expected an open succession");
        };
        assert_eq!(s.from, done);
        assert_eq!(s.base, "main");
    }

    #[test]
    fn a_successor_already_recorded_passes_a_second_check() {
        let (_temp, root, paths, done) = one_step_done("old3");
        park(&paths, &root, "old3");
        let SuccessionCheck::Open(s) =
            validate_succession(&paths, &root, "old3-v2", "old3", &done).unwrap()
        else {
            panic!("expected an open succession");
        };
        append_arc_start(&paths, &root, "old3-v2", ".tug/arcs/old3-v2/brief.md").unwrap();
        append_arc_succeeds(&paths, &root, "old3-v2", &s).unwrap();
        assert!(matches!(
            validate_succession(&paths, &root, "old3-v2", "old3", &done).unwrap(),
            SuccessionCheck::AlreadyRecorded(_)
        ));
        // A live arc that succeeds nothing is refused.
        append_arc_start(&paths, &root, "other", ".tug/arcs/other/brief.md").unwrap();
        assert!(validate_succession(&paths, &root, "other", "old3", &done).is_err());
    }

    /// Opening a successor writes its start and its succession; a second
    /// opening is a no-op that writes nothing new.
    #[test]
    fn open_successor_records_the_succession_once() {
        let (_temp, root, paths, done) = one_step_done("old6");
        park(&paths, &root, "old6");
        write_arc_document(&root, "old6-v2", "brief.md");
        let opened = open_successor(&paths, &root, "old6-v2", "old6", &done).unwrap();
        assert!(opened.started);
        assert_eq!(opened.record.succeeds.as_ref().unwrap().from, done);
        let again = open_successor(&paths, &root, "old6-v2", "old6", &done).unwrap();
        assert!(!again.started);
        assert_eq!(log_text(&paths, &root).matches("arc-succeeds").count(), 1);
    }

    /// The successor's seat is cut at the chosen commit, lands on the old
    /// base, carries the old arc's rounds, and records its cut point.
    #[test]
    fn a_successor_is_cut_at_its_from_commit() {
        let (_temp, root, paths, done) = one_step_done("old4");
        park(&paths, &root, "old4");
        let SuccessionCheck::Open(s) =
            validate_succession(&paths, &root, "old4-v2", "old4", &done).unwrap()
        else {
            panic!("expected an open succession");
        };
        append_arc_start(&paths, &root, "old4-v2", ".tug/arcs/old4-v2/brief.md").unwrap();
        append_arc_succeeds(&paths, &root, "old4-v2", &s).unwrap();

        let out = create_in(&paths, &root, "old4-v2", None, false, None).unwrap();
        assert!(out.created);
        assert_eq!(out.base_branch, "main");
        let wt = worktree_path(&root, "old4-v2");
        assert_eq!(sha(&wt, "HEAD"), done);
        assert!(wt.join("one.txt").exists());
        assert_eq!(
            config_get(&root, "branch.tugarc/old4-v2.tugbase").as_deref(),
            Some("main")
        );
        assert_eq!(
            config_get(&root, "branch.tugarc/old4-v2.tugfrom").as_deref(),
            Some(done.as_str())
        );
        let carried = git_stdout(&root, &["log", "--format=%s", "main..tugarc/old4-v2"]).unwrap();
        assert!(carried.contains("r1"), "{carried}");
        assert_eq!(fork_point(&root, "old4-v2").as_deref(), Some(done.as_str()));

        // An ordinary arc records no cut point.
        assert!(config_get(&root, "branch.tugarc/old4.tugfrom").is_none());

        // The successor's prompts say what it carries.
        assert_eq!(carried_steps(&root, &s), Some(1));
        assert!(
            successor_clause(&root, &s).ends_with("carries steps 1–1 of its ledger"),
            "{}",
            successor_clause(&root, &s)
        );
        let at_fork = Succession {
            from: sha(&root, "main"),
            ..s
        };
        assert_eq!(carried_steps(&root, &at_fork), None);
        assert!(successor_clause(&root, &at_fork).ends_with("carries none"));
    }

    /// A replay moves a carried-round cut point onto the rebuilt commit, and
    /// unsets one that names a base commit.
    #[test]
    fn a_replay_remaps_or_unsets_the_cut_point() {
        let (_temp, root, paths, done) = one_step_done("old5");
        park(&paths, &root, "old5");
        for (new, from) in [("old5-v2", done.clone()), ("old5-v3", sha(&root, "main"))] {
            let SuccessionCheck::Open(s) =
                validate_succession(&paths, &root, new, "old5", &from).unwrap()
            else {
                panic!("expected an open succession");
            };
            append_arc_start(&paths, &root, new, &format!(".tug/arcs/{new}/brief.md")).unwrap();
            append_arc_succeeds(&paths, &root, new, &s).unwrap();
            create_in(&paths, &root, new, None, false, None).unwrap();
            let wt = worktree_path(&root, new);
            fs::write(wt.join(format!("{new}.txt")), "own\n").unwrap();
            commit_in(&paths, &root, new, "own round", None, None).unwrap();
        }
        fs::write(root.join("base.txt"), "moved\n").unwrap();
        commit_all(&root, "base moves");

        crate::replay::replay_onto(&paths, &root, "old5-v2").unwrap();
        let from = config_get(&root, "branch.tugarc/old5-v2.tugfrom").unwrap();
        assert_ne!(from, done);
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%s", &from]).unwrap(),
            "r1"
        );
        assert!(is_ancestor(&root, &from, "tugarc/old5-v2"));

        crate::replay::replay_onto(&paths, &root, "old5-v3").unwrap();
        assert!(config_get(&root, "branch.tugarc/old5-v3.tugfrom").is_none());
    }
}
