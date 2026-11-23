//! Revert: undo one landed arc's join with a commit on its base.
//!
//! A join lands one squash commit, and the arc log names it, so any landed
//! arc can be undone later by `git revert` of that commit — not only the
//! newest operation, which is all `arc undo` reaches. The revert is a landing
//! of the user's: it is offered behind a confirm and never run by a stage.
//!
//! The dry run says what the confirm needs to say — how many files the join
//! touched, and which later commits on the base touched them too — and the
//! real run commits the revert in the base checkout, or, when it conflicts,
//! aborts and leaves the base exactly as it was.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tugcore::instance::Paths;

use crate::arc::{append_arc_reverted, reverted_by};
use crate::error::ArcError;
use crate::log::{GenerationEnd, arc_generations};

use super::{current_branch, git_output, git_stdout, is_ancestor, main_repo_root};

/// A commit on the base after the join that touched one of the join's paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaterCommit {
    pub sha: String,
    pub subject: String,
    /// The arc whose join this commit is, from its `Tug-Arc` trailer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<String>,
}

/// What [`revert_arc`] found, and on a real run what it committed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevertOutcome {
    pub arc: String,
    /// The generation whose join this is: its start.
    pub created: String,
    /// The join commit, full sha.
    pub join: String,
    /// The base branch the join landed on.
    pub base: String,
    /// Every path the join touched.
    pub paths: Vec<String>,
    /// Later base commits touching any of those paths, newest first.
    pub later: Vec<LaterCommit>,
    /// The revert commit, on a real run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted: Option<String>,
    pub dry_run: bool,
}

/// The base a join's `Tug-Arc` trailer names: `tugarc/<name> onto <base>`.
fn trailer_base(value: &str) -> Option<String> {
    value
        .lines()
        .find_map(|line| line.split_once(" onto "))
        .map(|(_, base)| base.trim().to_owned())
        .filter(|base| !base.is_empty())
}

/// The arc a `Tug-Arc` trailer names.
fn trailer_arc(value: &str) -> Option<String> {
    let branch = value.lines().next()?.split_whitespace().next()?;
    let name = branch.strip_prefix("tugarc/").unwrap_or(branch);
    (!name.is_empty()).then(|| name.to_owned())
}

/// A path listing read through the `-z` door, so every path is the bytes git
/// holds.
fn paths_of(repo: &Path, args: &[&str]) -> Result<Vec<String>, ArcError> {
    tugchanges_core::git::read_paths(repo, args)
        .map_err(|e| ArcError::git("git listing failed", args, e.to_string()))
}

/// The later base commits after `join` touching any of `paths`.
fn later_commits(repo: &Path, join: &str, base: &str, paths: &[String]) -> Vec<LaterCommit> {
    if paths.is_empty() {
        return Vec::new();
    }
    let range = format!("{join}..{base}");
    let mut args: Vec<&str> = vec![
        "log",
        "--format=%H%x1f%s%x1f%(trailers:key=Tug-Arc,valueonly)%x1e",
        &range,
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    let Ok(out) = git_stdout(repo, &args) else {
        return Vec::new();
    };
    out.split('\u{1e}')
        .filter_map(|record| {
            let mut fields = record.trim().splitn(3, '\u{1f}');
            let sha = fields.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            let subject = fields.next().unwrap_or("").trim().to_owned();
            let arc = fields.next().and_then(trailer_arc);
            Some(LaterCommit {
                sha: sha.to_owned(),
                subject,
                arc,
            })
        })
        .collect()
}

/// Revert the join of arc `name` on its base.
///
/// The generation is the one that started at `created`, else the newest. Its
/// join commit comes from the arc log, its base from the commit's `Tug-Arc`
/// trailer, and its paths from the commit itself. Refused when the base
/// checkout is not on that base, when anything is staged there (the revert
/// commits the index, so a staged change would ride into it), when a path
/// the join touched has uncommitted changes, when the join is not on the
/// base, and when a `reverted` line already names this join.
///
/// A dry run stops there and says what the revert would undo and which later
/// commits touched the same files. A real run reverts without committing,
/// commits `Revert "<subject>"` with a `Tug-Revert-Of` trailer, and appends
/// `reverted <revert> <join>` to the arc log. A conflict aborts the revert and
/// refuses with the conflicted paths, leaving the base as it was.
pub fn revert_arc(
    paths: &Paths,
    repo: &Path,
    name: &str,
    created: Option<&str>,
    dry_run: bool,
) -> Result<RevertOutcome, ArcError> {
    let repo = main_repo_root(repo);
    let log_path = tugtool_core::paths::arc_log_path_at(paths, &repo);
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    let generations = arc_generations(&log, name);
    let generation = match created {
        Some(start) => generations.iter().find(|g| g.started_at == start.trim()),
        None => generations.last(),
    }
    .ok_or_else(|| ArcError::NotFound {
        name: name.to_owned(),
    })?;
    let GenerationEnd::Joined { sha: marker } = &generation.end else {
        return Err(ArcError::Refused(format!("{name} has not joined.")));
    };
    let join = git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{marker}^{{commit}}")],
    )
    .map_err(|_| {
        ArcError::Refused(format!(
            "The join of {name}, {marker}, is not a commit in this repository."
        ))
    })?;
    let trailer = git_stdout(
        &repo,
        &[
            "log",
            "-1",
            "--format=%(trailers:key=Tug-Arc,valueonly)",
            &join,
        ],
    )?;
    let base = trailer_base(&trailer).ok_or_else(|| {
        ArcError::Refused(format!(
            "The join of {name} carries no Tug-Arc trailer, so the base it landed on is unknown."
        ))
    })?;
    let touched = paths_of(
        &repo,
        &["diff-tree", "--no-commit-id", "--name-only", "-r", &join],
    )?;

    if let Some(revert) = reverted_by(&log, name, &join) {
        return Err(ArcError::Refused(format!(
            "{name} was already reverted by {revert}."
        )));
    }
    let on = current_branch(&repo)?;
    if on != base {
        return Err(ArcError::Refused(format!(
            "The base checkout is on {on}, not {base}, the branch {name} joined."
        )));
    }
    if !is_ancestor(&repo, &join, &base) {
        return Err(ArcError::Refused(format!(
            "The join of {name} is not on {base}."
        )));
    }
    let staged = paths_of(&repo, &["diff", "--cached", "--name-only"])?;
    if !staged.is_empty() {
        return Err(ArcError::Refused(
            "The base has staged changes; a revert commits the index.".to_owned(),
        ));
    }
    let mut dirty = paths_of(&repo, &["diff", "--name-only"])?;
    dirty.extend(paths_of(
        &repo,
        &["ls-files", "--others", "--exclude-standard"],
    )?);
    let overlap: Vec<&str> = touched
        .iter()
        .filter(|p| dirty.contains(p))
        .map(String::as_str)
        .collect();
    if !overlap.is_empty() {
        return Err(ArcError::Refused(format!(
            "The base has uncommitted changes to {}.",
            overlap.join(", ")
        )));
    }

    let later = later_commits(&repo, &join, &base, &touched);
    let mut outcome = RevertOutcome {
        arc: name.to_owned(),
        created: generation.started_at.clone(),
        join: join.clone(),
        base,
        paths: touched,
        later,
        reverted: None,
        dry_run,
    };
    if dry_run {
        return Ok(outcome);
    }

    let reverted = git_output(&repo, &["revert", "--no-commit", &join])?;
    if !reverted.status.success() {
        let conflicted =
            paths_of(&repo, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        let _ = git_output(&repo, &["revert", "--abort"]);
        if conflicted.is_empty() {
            return Err(ArcError::git(
                "git revert failed",
                &["revert", "--no-commit", &join],
                String::from_utf8_lossy(&reverted.stderr).trim(),
            ));
        }
        return Err(ArcError::Refused(format!(
            "The revert conflicts on {}; the base is as it was.",
            conflicted.join(", ")
        )));
    }
    let nothing = git_output(&repo, &["diff", "--cached", "--quiet"])?;
    if nothing.status.success() {
        let _ = git_output(&repo, &["revert", "--abort"]);
        return Err(ArcError::Refused(format!(
            "Reverting the join of {name} changes nothing; its work is already gone from {}.",
            outcome.base
        )));
    }

    let subject = git_stdout(&repo, &["log", "-1", "--format=%s", &join])?;
    let message = format!(
        "Revert \"{subject}\"\n\nThis reverts commit {join}, the join of arc {name}.\n\nTug-Revert-Of: tugarc/{name} {join}\n"
    );
    let git_dir = git_stdout(&repo, &["rev-parse", "--absolute-git-dir"])?;
    let message_file = Path::new(&git_dir).join("TUG_REVERT_MSG");
    std::fs::write(&message_file, message).map_err(|source| ArcError::Io {
        what: "failed to write the revert message".to_owned(),
        path: message_file.clone(),
        source,
    })?;
    let file = message_file.to_string_lossy().into_owned();
    let committed = git_output(&repo, &["commit", "--quiet", "-F", &file]);
    let _ = std::fs::remove_file(&message_file);
    let committed = committed?;
    if !committed.status.success() {
        let _ = git_output(&repo, &["revert", "--abort"]);
        return Err(ArcError::git(
            "failed to commit the revert",
            &["commit", "-F", &file],
            String::from_utf8_lossy(&committed.stderr).trim(),
        ));
    }
    let revert = git_stdout(&repo, &["rev-parse", "HEAD"])?;
    append_arc_reverted(paths, &repo, name, &revert, &join)
        .map_err(|e| ArcError::Refused(e.to_string()))?;
    outcome.reverted = Some(revert);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::{JoinOptions, commit_in, create_in, join_in};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Open `name`, write each `(file, text)` in its worktree, commit, and
    /// join it onto the base.
    fn join_arc(paths: &Paths, repo: &Path, name: &str, files: &[(&str, &str)]) -> String {
        create_in(paths, repo, name, None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees").join(name);
        for (file, text) in files {
            fs::write(worktree.join(file), text).unwrap();
        }
        commit_in(paths, repo, name, &format!("{name} work"), None, None).unwrap();
        join_in(
            paths,
            repo,
            name,
            JoinOptions {
                message: Some(format!("Land {name}")),
                ..mechanics()
            },
        )
        .unwrap()
        .commit_hash
        .unwrap()
    }

    fn base_repo() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        let repo = fs::canonicalize(repo).unwrap();
        fs::write(repo.join("shared.txt"), "one\ntwo\nthree\n").unwrap();
        commit_all(&repo, "seed");
        (temp, repo, paths)
    }

    #[test]
    fn reverting_an_older_join_undoes_it_and_keeps_the_newer_one() {
        let (_t, repo, paths) = base_repo();
        let join = join_arc(&paths, &repo, "older", &[("a.txt", "a\n")]);
        join_arc(&paths, &repo, "newer", &[("b.txt", "b\n")]);

        let dry = revert_arc(&paths, &repo, "older", None, true).unwrap();
        assert_eq!(dry.paths, vec!["a.txt".to_owned()]);
        assert!(dry.later.is_empty(), "nothing later touched a.txt");
        assert!(dry.reverted.is_none());
        assert!(repo.join("a.txt").exists(), "a dry run touches nothing");

        let out = revert_arc(&paths, &repo, "older", None, false).unwrap();
        let revert = out.reverted.clone().unwrap();
        assert_eq!(rev_parse_at(&repo, "HEAD"), revert);
        assert!(!repo.join("a.txt").exists(), "the older arc's file is gone");
        assert!(repo.join("b.txt").exists(), "the newer arc's file stays");
        let body = git(&repo, &["log", "-1", "--format=%B"]);
        assert!(body.starts_with("Revert \""), "{body}");
        assert!(
            body.contains(&format!("This reverts commit {}", out.join)),
            "{body}"
        );
        assert!(
            body.contains(&format!("Tug-Revert-Of: tugarc/older {}", out.join)),
            "{body}"
        );
        assert!(porcelain_of(&repo).is_empty());
        assert!(out.join.starts_with(join.trim()) || join.starts_with(&out.join));

        // The line names both commits, and is not terminal: the generation
        // still joined.
        let text = log_text(&paths, &repo);
        assert!(
            text.contains(&format!("reverted  {revert} {}", out.join)),
            "{text}"
        );
        let generations = arc_generations(&text, "older");
        assert!(matches!(
            generations.last().unwrap().end,
            GenerationEnd::Joined { .. }
        ));

        // A second revert is refused and names the first.
        let again = revert_arc(&paths, &repo, "older", None, true).unwrap_err();
        assert!(again.to_string().contains(&revert), "{again}");
    }

    #[test]
    fn the_dry_run_names_later_work_on_the_same_files() {
        let (_t, repo, paths) = base_repo();
        join_arc(
            &paths,
            &repo,
            "first",
            &[("shared.txt", "ONE\ntwo\nthree\n")],
        );
        join_arc(
            &paths,
            &repo,
            "second",
            &[("shared.txt", "ONE\ntwo\nTHREE\n")],
        );
        let dry = revert_arc(&paths, &repo, "first", None, true).unwrap();
        assert_eq!(dry.later.len(), 1, "{:?}", dry.later);
        assert_eq!(dry.later[0].arc.as_deref(), Some("second"));
    }

    #[test]
    fn a_conflicting_revert_aborts_and_leaves_the_base_as_it_was() {
        let (_t, repo, paths) = base_repo();
        join_arc(
            &paths,
            &repo,
            "first",
            &[("shared.txt", "ONE\ntwo\nthree\n")],
        );
        join_arc(
            &paths,
            &repo,
            "second",
            &[("shared.txt", "Uno\ntwo\nthree\n")],
        );
        let head = rev_parse_at(&repo, "HEAD");
        let err = revert_arc(&paths, &repo, "first", None, false).unwrap_err();
        let said = err.to_string();
        assert!(said.contains("conflicts on shared.txt"), "{said}");
        assert_eq!(rev_parse_at(&repo, "HEAD"), head);
        assert!(porcelain_of(&repo).is_empty(), "{}", porcelain_of(&repo));
        assert!(!log_text(&paths, &repo).contains("  reverted  "));
    }

    #[test]
    fn base_dirt_on_a_joined_path_refuses() {
        let (_t, repo, paths) = base_repo();
        join_arc(&paths, &repo, "only", &[("a.txt", "a\n")]);
        fs::write(repo.join("a.txt"), "edited on the base\n").unwrap();
        let err = revert_arc(&paths, &repo, "only", None, true).unwrap_err();
        assert!(
            err.to_string().contains("uncommitted changes to a.txt"),
            "{err}"
        );
    }

    #[test]
    fn a_staged_change_anywhere_refuses_and_stays_staged() {
        let (_t, repo, paths) = base_repo();
        join_arc(&paths, &repo, "only", &[("a.txt", "a\n")]);
        fs::write(repo.join("unrelated.txt"), "mine\n").unwrap();
        git(&repo, &["add", "unrelated.txt"]);
        let err = revert_arc(&paths, &repo, "only", None, false).unwrap_err();
        assert!(err.to_string().contains("staged changes"), "{err}");
        let staged = git(&repo, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged.trim(), "unrelated.txt");
    }

    #[test]
    fn a_live_arc_is_not_reverted() {
        let (_t, repo, paths) = base_repo();
        create_in(&paths, &repo, "live", None, false, None).unwrap();
        let err = revert_arc(&paths, &repo, "live", None, true).unwrap_err();
        assert!(err.to_string().contains("has not joined"), "{err}");
    }
}
