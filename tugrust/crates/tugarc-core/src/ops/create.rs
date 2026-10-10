//! Creating an arc: the branch, the worktree, the base recorded in config, the
//! `post_create` hook, and the base working set carried into the new worktree.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tugtool_core::Config;

use super::documents::ensure_tug_excluded;
use super::git::{config_get, git_output, git_stdout};
use super::identity::{
    arc_base, base_config_key, base_detection_error, branch_exists, branch_name,
    description_config_key, ensure_arc_id, reconcile_branches, worktree_path,
};
use super::listing::git_paths_or_empty;
use super::{dirty_tracked_paths, main_repo_root};
use crate::error::ArcError;
use crate::log::{append_arc_log, detect_default_branch, validate_arc_name};

/// Outcome of [`create`].
#[derive(Debug, Clone, Serialize)]
pub struct CreateOutcome {
    pub name: String,
    /// The arc's owner key ([P01]) — `tugarc/<name>#<tugid>`.
    pub id: Option<String>,
    pub description: Option<String>,
    pub branch: String,
    pub worktree: String,
    pub base_branch: String,
    pub status: String,
    pub created: bool,
    /// What the base checkout still holds uncommitted, as create leaves it.
    /// Reporting only: create never takes it, and a create over a dirty base
    /// succeeds exactly as before. It is here because the alternative is
    /// silence — the dirt becomes either invisible divergence or the join's
    /// `base-dirt` refusal, and nothing says so at the moment it could still be
    /// dealt with cheaply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_dirt: Vec<BaseDirtPath>,
    /// The base checkout's branch, when it is not the arc's base branch.
    ///
    /// Creation is commit-based — the worktree is cut from the base *ref*, so
    /// where the checkout happens to sit does not affect it. The join's
    /// preflight is not: it refuses with `off-base` unless the checkout is on
    /// the base branch. This is the warning at the start about what the end
    /// will demand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off_base: Option<String>,
}

/// One entry in the base-dirt census ([`base_working_set_dirt`]).
#[derive(Debug, Clone, Serialize)]
pub struct BaseDirtPath {
    /// Repo-relative, as git names it.
    pub path: String,
    /// How the path is dirty, which is also how it is put back:
    ///
    /// - `tracked-dirty` — in HEAD, changed against it (staged or unstaged);
    ///   restored with `git checkout HEAD --`.
    /// - `staged-new` — added to the index but not in HEAD, so there is
    ///   *nothing to restore to*; put back means `git rm`, index entry and all.
    /// - `untracked` — not in the index either; put back means removing it.
    ///
    /// The middle case is the one that reads as a detail and is not: it is
    /// reported by `git diff HEAD` exactly like `tracked-dirty`, and treating
    /// it as such fails with "pathspec did not match any file(s) known to git"
    /// *after* the content has already been moved.
    pub state: String,
    /// The path is dirty because it was *deleted* on the base. There is no
    /// content behind it, which is the distinction anything that copies these
    /// entries has to make before it reads a file that is not there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    /// The `--carry` transplant moved this path into the arc worktree ([P06]);
    /// it is no longer on the base. An uncarried entry is still sitting there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub carried: bool,
}

/// Run the project's `[tugtool.arc].post_create` hooks from the worktree root.
///
/// Each command runs via `sh -c`. The first non-zero exit aborts and returns
/// the failing command's stderr, so the caller can roll the worktree back.
pub(crate) fn run_post_create(repo: &Path, worktree: &Path) -> Result<(), ArcError> {
    let config = Config::load_from_project(repo).map_err(|e| ArcError::Refused(e.to_string()))?;
    for cmd in &config.tugtool.arc.post_create {
        let out = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(worktree)
            .output()
            .map_err(|e| {
                ArcError::io(
                    format!("failed to run post_create hook '{}'", cmd),
                    worktree,
                    e,
                )
            })?;
        if !out.status.success() {
            // The project's own hook declining the worktree, in its words.
            return Err(ArcError::Refused(format!(
                "post_create hook failed: '{}'\n{}",
                cmd,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }
    Ok(())
}

/// Like [`create`], but against an explicit repo root instead of the process
/// cwd — for callers such as tugcast, which has no cwd worth consulting and
/// knows exactly which checkout it means.
pub fn create_in(
    repo_root: &Path,
    name: &str,
    description: Option<String>,
    carry: bool,
    base: Option<&str>,
) -> Result<CreateOutcome, ArcError> {
    validate_arc_name(name).map_err(ArcError::InvalidName)?;
    let repo_root = main_repo_root(repo_root);
    reconcile_branches(&repo_root, &mut Vec::new());
    let base_branch = match base {
        Some(requested) => {
            if !branch_exists(&repo_root, requested) {
                return Err(ArcError::Refused(format!(
                    "base branch '{}' does not exist in {}",
                    requested,
                    repo_root.display()
                )));
            }
            requested.to_string()
        }
        None => detect_default_branch(&repo_root).map_err(base_detection_error)?,
    };
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    let have_branch = branch_exists(&repo_root, &branch);
    let have_worktree = worktree.exists();

    // Idempotent: a fully-present arc returns as-is, with no re-hydration.
    if have_branch && have_worktree {
        let description =
            description.or_else(|| config_get(&repo_root, &description_config_key(name)));
        let base = arc_base(&repo_root, name).unwrap_or(base_branch);
        // A revisit is a write-path touch, so an id-less arc from an older
        // build gains its id here ([P02]).
        let id = ensure_arc_id(&repo_root, name).ok();
        // `--carry` on a revisit moves whatever the base holds now.
        let carried = if carry {
            carry_working_set_in(&repo_root, &worktree)?
        } else {
            Vec::new()
        };
        let (base_dirt, off_base) = base_census(&repo_root, &base);
        let base_dirt = with_carried(base_dirt, carried);
        return Ok(CreateOutcome {
            name: name.to_string(),
            id,
            description,
            branch,
            worktree: worktree.to_string_lossy().into_owned(),
            base_branch: base,
            status: "active".to_string(),
            created: false,
            base_dirt,
            off_base,
        });
    }

    // Clean up any partial leftovers from a half-built or stale incarnation.
    if have_worktree {
        let _ = git_output(
            &repo_root,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
    }
    if branch_exists(&repo_root, &branch) {
        let out = git_output(&repo_root, &["branch", "-D", &branch])?;
        if !out.status.success() {
            return Err(ArcError::git(
                format!("failed to delete stale branch {}", branch),
                &["branch", "-D", &branch],
                String::from_utf8_lossy(&out.stderr).trim(),
            ));
        }
    }

    // Every arc artifact in the tree lives under `.tug/` — the worktree about
    // to be created, and the documents — so a project that never declared it
    // would show the whole directory as untracked in the act of starting an
    // arc ([P08]).
    ensure_tug_excluded(&repo_root);

    // Create the worktree + branch in one step.
    let out = git_output(
        &repo_root,
        &[
            "worktree",
            "add",
            &worktree.to_string_lossy(),
            "-b",
            &branch,
            &base_branch,
        ],
    )?;
    if !out.status.success() {
        return Err(ArcError::git(
            "git worktree add failed",
            &[
                "worktree",
                "add",
                &worktree.to_string_lossy(),
                "-b",
                &branch,
                &base_branch,
            ],
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }

    // Enable rerere so recorded conflict resolutions replay on join ([P31]).
    crate::resolve::ensure_rerere_config(&repo_root);

    // Record the base branch and description in git config.
    let _ = git_output(
        &repo_root,
        &["config", &base_config_key(name), &base_branch],
    );
    if let Some(desc) = description.as_deref() {
        let _ = git_output(&repo_root, &["config", &description_config_key(name), desc]);
    }

    // Mint the creation id ([P01]) beside the rest of the branch metadata, so
    // it is torn down with the branch and needs no garbage collection.
    let id = ensure_arc_id(&repo_root, name).ok();

    // The birth record. An arc created bare — no plan, no rounds — would
    // otherwise have no line in the log at all and no date to report, while one
    // created with a plan gets its `Adopt plan` line for free; the gap was
    // arbitrary. Written only here, on the genuinely-created path, so the
    // idempotent revisit above cannot forge activity.
    //
    // The note is empty, and that is load-bearing: `read_arc_log` in
    // `tugcast`'s draft engine is a second parser of this file that keeps every
    // non-empty note as a per-round authoring instruction, and skips empty ones.
    // A note here would read as an instruction the user never gave.
    let _ = append_arc_log(&repo_root, name, "created", "");

    // Hydrate the worktree; on failure, roll it (and the branch) back so a
    // retry re-creates cleanly and the idempotent path never strands it.
    if let Err(hook_err) = run_post_create(&repo_root, &worktree) {
        let _ = git_output(
            &repo_root,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        let _ = git_output(&repo_root, &["branch", "-D", &branch]);
        return Err(hook_err);
    }

    // By the transplant's apply-all-before-clean-any ordering the base is fully
    // intact when a carry fails, so tearing the arc down costs nothing.
    let carried = if carry {
        match carry_working_set_in(&repo_root, &worktree) {
            Ok(moved) => moved,
            Err(e) => {
                let _ = git_output(
                    &repo_root,
                    &["worktree", "remove", "--force", &worktree.to_string_lossy()],
                );
                let _ = git_output(&repo_root, &["branch", "-D", &branch]);
                return Err(e);
            }
        }
    } else {
        Vec::new()
    };

    let (base_dirt, off_base) = base_census(&repo_root, &base_branch);
    let base_dirt = with_carried(base_dirt, carried);
    Ok(CreateOutcome {
        name: name.to_string(),
        id,
        description,
        branch,
        worktree: worktree.to_string_lossy().into_owned(),
        base_branch,
        status: "active".to_string(),
        created: true,
        base_dirt,
        off_base,
    })
}

/// What `create` reports about the base checkout it is leaving behind: the
/// uncommitted working set, and the branch the checkout sits on when that is
/// not the base branch ([P05]).
///
/// Taken at the end, so it describes the base as create actually leaves it —
/// a plan the arc adopted is gone from the base by then and is correctly not
/// reported as dirt.
/// Fold what `--carry` moved back into the reported census, marked `carried`.
///
/// The census is taken after the transplant, so the carried paths are no longer
/// on the base and would otherwise vanish from the report entirely — leaving a
/// successful `--carry` looking indistinguishable from a create over a clean
/// base. One list, each entry saying whether it moved or is still sitting there.
fn with_carried(mut census: Vec<BaseDirtPath>, carried: Vec<BaseDirtPath>) -> Vec<BaseDirtPath> {
    census.extend(carried.into_iter().map(|mut e| {
        e.carried = true;
        e
    }));
    census.sort_by(|a, b| a.path.cmp(&b.path));
    census
}

fn base_census(repo_root: &Path, base_branch: &str) -> (Vec<BaseDirtPath>, Option<String>) {
    let off_base = git_stdout(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty() && b != base_branch);
    (base_working_set_dirt(repo_root), off_base)
}

/// Move the base checkout's uncommitted working set into the fresh arc
/// worktree, leaving it there **uncommitted** ([P06]).
///
/// This is the "I was editing the base and half-way through realised this
/// should be an arc" gesture. The worktree was cut from the base tip, so the
/// content the dirt was made against is the content the worktree holds — the
/// transplant is a copy, never a patch application.
///
/// The ordering is not negotiable: **every path is applied to the worktree
/// before any base copy is touched.** A failure in the apply phase leaves the
/// base entirely intact, which is what makes tearing the arc down a safe
/// response to it.
///
/// Returns the entries it moved, in census order.
fn carry_working_set_in(repo_root: &Path, worktree: &Path) -> Result<Vec<BaseDirtPath>, ArcError> {
    let unmerged = git_paths_or_empty(repo_root, &["ls-files", "-u", "--format=%(path)"])
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    if !unmerged.is_empty() {
        return Err(ArcError::Refused(format!(
            "cannot carry the base working set: unmerged paths on the base checkout ({}). \
             Finish or abort that merge first.",
            unmerged.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }

    let census: Vec<BaseDirtPath> = base_working_set_dirt(repo_root);
    if census.is_empty() {
        return Ok(census);
    }

    // Apply everything first. A deleted path carries as a deletion — there is
    // no content to read, and the worktree does hold a copy to remove.
    for entry in &census {
        let target = worktree.join(&entry.path);
        if entry.deleted {
            if target.exists() {
                std::fs::remove_file(&target).map_err(|e| {
                    ArcError::io(
                        format!("failed to carry the deletion of {}", entry.path),
                        &target,
                        e,
                    )
                })?;
            }
            continue;
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| ArcError::io(format!("failed to carry {}", entry.path), dir, e))?;
        }
        std::fs::copy(repo_root.join(&entry.path), &target)
            .map_err(|e| ArcError::io(format!("failed to carry {}", entry.path), &target, e))?;
    }

    // Only now is the base safe to clean. `HEAD` is named explicitly so a
    // *staged* edit is cleaned too — a bare `git checkout --` restores from the
    // index and would leave the path still dirty against HEAD.
    for entry in &census {
        match entry.state.as_str() {
            "tracked-dirty" => {
                let out = git_output(repo_root, &["checkout", "HEAD", "--", &entry.path])?;
                if !out.status.success() {
                    return Err(ArcError::git(
                        format!("failed to restore the base copy of {}", entry.path),
                        &["checkout", "HEAD", "--", &entry.path],
                        String::from_utf8_lossy(&out.stderr).trim(),
                    ));
                }
            }
            "staged-new" => {
                // Nothing in HEAD to restore to, so the index entry has to go
                // with the file — otherwise the path stays dirty against HEAD
                // as a staged addition of something that is no longer there.
                let out = git_output(
                    repo_root,
                    &[
                        "rm",
                        "--force",
                        "--quiet",
                        "--ignore-unmatch",
                        "--",
                        &entry.path,
                    ],
                )?;
                if !out.status.success() {
                    return Err(ArcError::git(
                        format!("failed to unstage the base copy of {}", entry.path),
                        &[
                            "rm",
                            "--force",
                            "--quiet",
                            "--ignore-unmatch",
                            "--",
                            &entry.path,
                        ],
                        String::from_utf8_lossy(&out.stderr).trim(),
                    ));
                }
            }
            _ => {
                let base_copy = repo_root.join(&entry.path);
                std::fs::remove_file(&base_copy).map_err(|e| {
                    ArcError::io(
                        format!("failed to remove the base copy of {}", entry.path),
                        &base_copy,
                        e,
                    )
                })?;
            }
        }
    }

    Ok(census)
}

/// Everything `dir` holds uncommitted: tracked paths differing from HEAD
/// (staged or unstaged, deletions included) and untracked files git would not
/// ignore.
///
/// `--exclude-standard` honors `.gitignore`, which is what keeps the arc
/// worktrees under `.tug/` out of the untracked half — a hand-rolled path
/// exclusion here would be dead code in any repository that ignores its own
/// worktree home, and wrong in one that does not.
pub(super) fn base_working_set_dirt(dir: &Path) -> Vec<BaseDirtPath> {
    let in_head = |path: &str| {
        git_output(dir, &["cat-file", "-e", &format!("HEAD:{path}")])
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    let mut out: Vec<BaseDirtPath> = dirty_tracked_paths(dir)
        .into_iter()
        .map(|path| BaseDirtPath {
            deleted: !dir.join(&path).exists(),
            state: if in_head(&path) {
                "tracked-dirty".to_string()
            } else {
                "staged-new".to_string()
            },
            path,
            carried: false,
        })
        .collect();
    out.extend(
        git_paths_or_empty(dir, &["ls-files", "--others", "--exclude-standard"])
            .into_iter()
            .map(|path| BaseDirtPath {
                path,
                state: "untracked".to_string(),
                deleted: false,
                carried: false,
            }),
    );
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// An arc created against an explicit root, by a caller with no cwd worth
    /// consulting, and stamped with who laid it. The provenance is readable
    /// both directly and off the list every arc surface reads, because a
    /// badge nobody can see is not provenance.
    #[serial]
    #[test]
    fn a_arc_created_against_an_explicit_root_carries_its_provenance() {
        let (_temp, root) = repo_for_create();
        // Somewhere other than the repo, so nothing can be resolving the root
        // from the cwd behind the explicit one.
        std::env::set_current_dir(std::env::temp_dir()).unwrap();

        let created = create_in(&root, "agent-ci-abc12345", None, false, None).unwrap();
        assert!(created.created);
        set_laid_by(&root, "agent-ci-abc12345", "agent/ci");

        assert_eq!(
            laid_by(&root, "agent-ci-abc12345").as_deref(),
            Some("agent/ci")
        );
        std::env::set_current_dir(&root).unwrap();
        let listed = list().unwrap();
        let row = listed
            .iter()
            .find(|d| d.name == "agent-ci-abc12345")
            .expect("the staged arc is listed");
        assert_eq!(row.laid_by.as_deref(), Some("agent/ci"));
        assert!(
            listed.iter().all(|d| d.name != "hand-made"),
            "no other arc exists to confuse the reading"
        );
    }

    #[serial]
    #[test]
    fn create_over_a_clean_base_reports_nothing() {
        let (_temp, _root) = repo_for_create();
        let out = create("tidy", None, false, None).unwrap();
        assert!(out.base_dirt.is_empty(), "{:?}", out.base_dirt);
        assert_eq!(out.off_base, None);
    }

    /// An arc created bare has no rounds and no adopted plan, so without a
    /// birth record it would have no arc log line at all and no date to
    /// report. The revisit must not forge a second one — a re-run is a repair,
    /// not activity.
    #[serial]
    #[test]
    fn create_writes_one_birth_record_and_a_revisit_writes_none() {
        let (_temp, root) = repo_for_create();
        create("newborn", None, false, None).unwrap();

        let log_path =
            tugtool_core::paths::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG);
        let count = |text: &str| {
            text.lines()
                .filter(|l| l.contains("  newborn  created  "))
                .count()
        };
        let after_create = fs::read_to_string(&log_path).unwrap();
        assert_eq!(count(&after_create), 1, "{after_create}");

        // The note is empty — the draft engine reads every non-empty note as an
        // authoring instruction, and a birth record is not one.
        let line = after_create
            .lines()
            .find(|l| l.contains("  newborn  created"))
            .unwrap();
        assert!(
            line.trim_end().ends_with("created"),
            "the created line carries no note: {line:?}"
        );

        let revisit = create("newborn", None, false, None).unwrap();
        assert!(!revisit.created);
        assert_eq!(count(&fs::read_to_string(&log_path).unwrap()), 1);
    }

    /// Most creates happen over *some* unrelated dirt, so a refusing create
    /// would be intolerable. The shape that survives is a decision, not a veto:
    /// create succeeds, says what it left behind, and takes nothing.
    #[serial]
    #[test]
    fn create_censuses_base_dirt_and_leaves_it_alone() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("README.md"), "# base edit\n").unwrap();
        run_git(&root, &["add", "README.md"]);
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        fs::remove_file(root.join("base.rs")).ok();

        let out = create("dirty", None, false, None).unwrap();
        assert!(out.created);

        assert_eq!(dirt_entry(&out, "README.md").state, "tracked-dirty");
        assert!(!dirt_entry(&out, "README.md").deleted);
        assert_eq!(dirt_entry(&out, "scratch.txt").state, "untracked");

        // The base is exactly as the caller left it — including the staged edit.
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# base edit\n"
        );
        assert!(root.join("scratch.txt").exists());
        // The arc worktree itself is gitignored, so it is not reported as dirt.
        assert!(
            out.base_dirt.iter().all(|d| !d.path.starts_with(".tug/")),
            "{:?}",
            out.base_dirt
        );
    }

    /// `git diff --name-only HEAD` reports a *deleted* tracked file as dirty,
    /// and there is no content behind it. The census says so, because anything
    /// that copies these entries has to know before it opens the file.
    #[serial]
    #[test]
    fn a_deletion_on_base_is_censused_as_a_deletion() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("doomed.txt"), "here\n").unwrap();
        run_git(&root, &["add", "doomed.txt"]);
        run_git(&root, &["commit", "-m", "add doomed"]);
        fs::remove_file(root.join("doomed.txt")).unwrap();

        let out = create("gone", None, false, None).unwrap();
        let entry = dirt_entry(&out, "doomed.txt");
        assert_eq!(entry.state, "tracked-dirty");
        assert!(entry.deleted);
    }

    /// Creation cuts from the base *ref*, so an off-base checkout does not
    /// affect it — but the join's preflight refuses until the checkout is back.
    /// This is the warning at the start about what the end will demand.
    #[serial]
    #[test]
    fn create_warns_when_the_base_checkout_is_on_another_branch() {
        let (_temp, root) = repo_for_create();
        run_git(&root, &["checkout", "-q", "-b", "scratch"]);

        let out = create("elsewhere", None, false, None).unwrap();
        assert_eq!(out.off_base.as_deref(), Some("scratch"));
        assert_eq!(out.base_branch, "main");
    }

    /// The whole contract in one walk: work already under way on the base is
    /// carried into an arc, committed there as a round, given an authored draft
    /// written from *inside the worktree* — the write that used to disappear —
    /// and landed. The base is clean at every step it should be, and the
    /// message the join commits is the message the author wrote.
    #[serial]
    #[test]
    fn carried_work_becomes_a_round_and_lands_the_authored_draft() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        isolate_changes_db(&temp);
        let root = fs::canonicalize(&repo).unwrap();

        // Work already under way on the base.
        fs::write(root.join("feature.rs"), "half a feature\n").unwrap();

        let created = create("walk", None, true, None).unwrap();
        assert!(created.base_dirt.iter().all(|d| d.carried));
        assert!(
            base_working_set_dirt(&root).is_empty(),
            "the base is clean after the carry"
        );

        let worktree = worktree_path(&root, "walk");
        assert_eq!(
            fs::read_to_string(worktree.join("feature.rs")).unwrap(),
            "half a feature\n"
        );

        // The arc's first round commits the carried work with intent.
        fs::write(worktree.join("feature.rs"), "the whole feature\n").unwrap();
        commit("walk", "finish the feature", None).unwrap();

        // The authored draft, written the way `arc-implement` writes it: keyed
        // by the base root that `arc_draft_key` resolves, from the worktree.
        let key = arc_draft_key(&root, "walk");
        let draft = "the feature, finished\n\nCarried in from the base and completed on the arc.";
        seed_draft_row(
            &temp.path().join("changes.db"),
            &key.owner_id,
            &canonical(&key.project),
            draft,
        );

        assert!(join_preflight_in(&root, "walk").unwrap().is_empty());
        let landed = join("walk", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(&root, &["log", "-1", "--format=%B", &sha]).unwrap();

        assert_eq!(
            committed,
            with_arc_trailers(
                &root,
                "walk",
                "tugarc/walk",
                &format!("tugarc(walk): {draft}"),
                None
            )
        );
        assert_eq!(
            committed.matches("tugarc(walk): ").count(),
            1,
            "{committed}"
        );
        assert_eq!(
            fs::read_to_string(root.join("feature.rs")).unwrap(),
            "the whole feature\n"
        );
        assert!(!branch_present(&root, "tugarc/walk"));
    }

    /// The "I was editing the base and half-way through realised this should be
    /// an arc" gesture. The worktree was cut from the base tip, so the content
    /// the dirt was made against is the content the worktree holds — the
    /// transplant is a copy, and it lands uncommitted because the work is in
    /// progress by definition.
    #[serial]
    #[test]
    fn carry_moves_the_base_working_set_into_the_worktree() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("README.md"), "# in progress\n").unwrap();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();

        let out = create("carried", None, true, None).unwrap();
        let worktree = worktree_path(&root, "carried");

        assert_eq!(
            fs::read_to_string(worktree.join("README.md")).unwrap(),
            "# in progress\n"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("scratch.txt")).unwrap(),
            "notes\n"
        );
        // Moved, not copied: the base is clean afterwards.
        assert!(base_working_set_dirt(&root).is_empty());
        assert!(!root.join("scratch.txt").exists());

        // Uncommitted in the worktree — the arc's first round commits it.
        assert!(!base_working_set_dirt(&worktree).is_empty());

        // The report says what moved rather than falling silent.
        assert!(
            out.base_dirt.iter().all(|d| d.carried),
            "{:?}",
            out.base_dirt
        );
        assert_eq!(out.base_dirt.len(), 2);
    }

    /// `git diff --name-only HEAD` lists a deleted tracked file as dirty, and
    /// there is nothing to read behind it. Carrying a deletion means deleting
    /// the worktree's copy — the worktree was cut from the base tip, so it has
    /// one.
    #[serial]
    #[test]
    fn carry_carries_a_deletion_as_a_deletion() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("doomed.txt"), "here\n").unwrap();
        run_git(&root, &["add", "doomed.txt"]);
        run_git(&root, &["commit", "-m", "add doomed"]);
        fs::remove_file(root.join("doomed.txt")).unwrap();

        create("deleter", None, true, None).unwrap();
        let worktree = worktree_path(&root, "deleter");

        assert!(
            !worktree.join("doomed.txt").exists(),
            "the deletion carried"
        );
        assert!(
            root.join("doomed.txt").exists(),
            "the base copy is restored from HEAD"
        );
        assert!(base_working_set_dirt(&root).is_empty());
    }

    /// `HEAD` is named explicitly in the restore, because a bare
    /// `git checkout --` restores from the *index* and a staged edit would
    /// survive — leaving the path still dirty against HEAD after a carry that
    /// reported success.
    #[serial]
    #[test]
    fn carry_cleans_a_staged_base_edit_too() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("README.md"), "staged\n").unwrap();
        run_git(&root, &["add", "README.md"]);

        let out = create("staged", None, true, None).unwrap();
        let worktree = worktree_path(&root, "staged");

        assert_eq!(out.base_dirt[0].state, "tracked-dirty");
        assert_eq!(
            fs::read_to_string(worktree.join("README.md")).unwrap(),
            "staged\n"
        );
        assert!(
            base_working_set_dirt(&root).is_empty(),
            "the staged edit is cleaned, not merely unstaged"
        );
    }

    /// A file `git add`ed but never committed is reported by `git diff HEAD`
    /// exactly like an ordinary tracked change, and there is no HEAD version to
    /// restore it to. Putting it back means removing the index entry as well —
    /// otherwise the base is left holding a staged addition of a file that is
    /// no longer there, which is dirtier than what carry was asked to clean.
    #[serial]
    #[test]
    fn carry_puts_back_a_staged_new_file_index_entry_and_all() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("fresh.rs"), "brand new\n").unwrap();
        run_git(&root, &["add", "fresh.rs"]);

        let out = create("fresh", None, true, None).unwrap();
        let worktree = worktree_path(&root, "fresh");

        assert_eq!(out.base_dirt[0].state, "staged-new");
        assert_eq!(
            fs::read_to_string(worktree.join("fresh.rs")).unwrap(),
            "brand new\n"
        );
        assert!(!root.join("fresh.rs").exists());
        assert!(
            base_working_set_dirt(&root).is_empty(),
            "no staged phantom left behind: {:?}",
            base_working_set_dirt(&root)
        );
    }

    /// Apply-all-before-clean-any is what makes tearing the arc down a safe
    /// response to a failed transplant: the base has not been touched yet.
    #[serial]
    #[test]
    fn a_failed_carry_tears_down_and_leaves_the_base_intact() {
        let (_temp, root) = repo_for_create();
        fs::create_dir_all(root.join("blocked")).unwrap();
        fs::write(root.join("blocked/keep.txt"), "kept\n").unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "add blocked/"]);

        // The base replaces the directory with a file of the same name. The
        // worktree, cut from the base tip, still holds the directory — so the
        // copy of the untracked `blocked` cannot land, and it fails before any
        // base copy has been touched.
        fs::remove_dir_all(root.join("blocked")).unwrap();
        fs::write(root.join("blocked"), "now a file\n").unwrap();

        let err = create("doomed-carry", None, true, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("blocked"), "{err}");
        assert!(!branch_present(&root, "tugarc/doomed-carry"));
        assert!(!new_worktree_path(&root, "doomed-carry").exists());
        assert_eq!(
            fs::read_to_string(root.join("blocked")).unwrap(),
            "now a file\n",
            "the base is exactly as the caller left it"
        );
    }

    #[serial]
    #[test]
    fn carry_refuses_over_unmerged_base_paths() {
        let (_temp, root) = repo_for_create();
        // Two branches editing one file, merged into a conflict.
        fs::write(root.join("clash.txt"), "one\n").unwrap();
        run_git(&root, &["add", "clash.txt"]);
        run_git(&root, &["commit", "-m", "seed clash"]);
        run_git(&root, &["checkout", "-q", "-b", "other"]);
        fs::write(root.join("clash.txt"), "other\n").unwrap();
        run_git(&root, &["commit", "-am", "other side"]);
        run_git(&root, &["checkout", "-q", "main"]);
        fs::write(root.join("clash.txt"), "main\n").unwrap();
        run_git(&root, &["commit", "-am", "main side"]);
        let _ = git_output(&root, &["merge", "other"]);

        let err = create("unmerged", None, true, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("unmerged"), "{err}");
        assert!(err.contains("clash.txt"), "{err}");
        assert!(!branch_present(&root, "tugarc/unmerged"));
    }

    #[serial]
    #[test]
    fn carry_over_a_clean_base_is_a_no_op() {
        let (_temp, root) = repo_for_create();
        let out = create("nothing", None, true, None).unwrap();
        assert!(out.created);
        assert!(out.base_dirt.is_empty());
        assert!(base_working_set_dirt(&root).is_empty());
    }

    /// An arc created from inside a universe is born there: its worktree lives
    /// under the universe, it forks from the branch the universe has out, and
    /// the checkout that merely owns the common dir is left alone ([P01],
    /// [P03], [P07] — refs stay shared, paths do not).
    #[serial]
    #[test]
    fn test_universe_create_stays_inside_the_universe() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);

        // Content that exists only on the universe's branch, so an arc forked
        // from `main` instead would be visibly wrong.
        fs::write(universe.join("scoped.txt"), "universe\n").unwrap();
        run_git(&universe, &["add", "-A"]);
        run_git(&universe, &["commit", "-m", "universe work"]);
        let feature_tip = rev_parse_at(&universe, "feature");

        let created = create("scoped", None, false, Some("feature")).unwrap();
        assert!(created.created);
        assert_eq!(created.base_branch, "feature");
        assert_eq!(
            created.worktree,
            universe
                .join(".tug/worktrees/scoped")
                .to_string_lossy()
                .into_owned(),
            "the arc worktree is born inside the universe, not beside the base"
        );
        assert_eq!(rev_parse_at(&universe, "tugarc/scoped"), feature_tip);
        assert!(
            Path::new(&created.worktree).join("scoped.txt").exists(),
            "the arc holds the universe's content"
        );

        // The base checkout is untouched: no worktree home, no arc log, clean.
        assert!(!base.join(".tug").exists(), "no worktree home under base");
        assert!(
            !arc_log_path(&temp.path().join("state"), &base).exists(),
            "the base's project state records nothing"
        );
        let dirt = tugcore::git_command()
            .arg("-C")
            .arg(&base)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&dirt.stdout).trim().is_empty(),
            "base checkout stayed clean"
        );
    }

    /// An explicit base forks the arc from that branch and records it, so a
    /// checkout parked off the default branch makes an arc that holds the
    /// content it is actually working on ([P03]).
    #[serial]
    #[test]
    fn test_create_base_forks_from_the_named_branch() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // A `feature` tip that `main` does not have.
        run_git(repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("only-on-feature.txt"), "x\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "feature work"]);
        let feature_tip = rev_parse_at(repo, "feature");
        run_git(repo, &["checkout", "main"]);
        assert_ne!(feature_tip, rev_parse_at(repo, "main"));

        let created = create("based", None, false, Some("feature")).unwrap();
        assert!(created.created);
        assert_eq!(created.base_branch, "feature");
        assert_eq!(arc_base(repo, "based").unwrap(), "feature");
        assert_eq!(rev_parse_at(repo, "tugarc/based"), feature_tip);
        assert!(
            Path::new(&created.worktree)
                .join("only-on-feature.txt")
                .exists(),
            "the worktree holds the base branch's content"
        );
    }

    /// A base that does not exist is refused before anything is created —
    /// no branch, no worktree, no config residue.
    #[serial]
    #[test]
    fn test_create_base_refuses_an_unknown_branch() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let err = create("nobase", None, false, Some("no-such-branch"))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("no-such-branch"),
            "the refusal must name the branch: {err}"
        );
        assert!(!branch_present(repo, "tugarc/nobase"));
        assert!(!worktree_path(repo, "nobase").exists());
        assert!(config_get(repo, "branch.tugarc/nobase.tugbase").is_none());
    }

    /// An arc's base is set at birth: a revisit reports the recorded base and
    /// does not rewrite it ([P03]).
    #[serial]
    #[test]
    fn test_create_base_is_ignored_on_a_revisit() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let first = create("settled", None, false, None).unwrap();
        assert_eq!(first.base_branch, "main");
        run_git(repo, &["branch", "feature"]);

        let again = create("settled", None, false, Some("feature")).unwrap();
        assert!(!again.created);
        assert_eq!(again.base_branch, "main");
        assert_eq!(arc_base(repo, "settled").unwrap(), "main");
    }

    #[serial]
    #[test]
    fn test_arc_create_basic() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let result = create("test-arc", Some("desc".to_string()), false, None);
        assert!(result.is_ok());

        assert!(repo.join(".tug/worktrees/test-arc").exists());
        assert!(branch_present(repo, "tugarc/test-arc"));

        // Base branch is recorded in git config.
        let base = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", "branch.tugarc/test-arc.tugbase"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&base.stdout).trim(), "main");
    }

    #[serial]
    #[test]
    fn test_arc_create_idempotent() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("first".to_string()), false, None).unwrap();
        // Second create returns the existing arc without error.
        let result = create("test-arc", Some("second".to_string()), false, None);
        assert!(!result.unwrap().created);
        assert!(repo.join(".tug/worktrees/test-arc").exists());
    }

    #[serial]
    #[test]
    fn test_arc_create_runs_post_create_once() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        // Append a line to a marker file each time the hook runs.
        write_config(repo, &["echo ran >> hook-marker.txt"]);
        std::env::set_current_dir(repo).unwrap();

        create("hooky", None, false, None).unwrap();
        let marker = repo.join(".tug/worktrees/hooky/hook-marker.txt");
        assert!(marker.exists(), "post_create should run on creation");
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);

        // Idempotent resume must NOT re-run the hook.
        create("hooky", None, false, None).unwrap();
        assert_eq!(
            fs::read_to_string(&marker).unwrap().lines().count(),
            1,
            "post_create must not run on idempotent resume"
        );
    }

    #[serial]
    #[test]
    fn test_arc_create_failing_hook_rolls_back() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        write_config(repo, &["exit 1"]);
        std::env::set_current_dir(repo).unwrap();

        let result = create("doomed", None, false, None);
        assert!(result.is_err(), "failing hook should fail create");

        // Rollback: neither worktree nor branch survive.
        assert!(!repo.join(".tug/worktrees/doomed").exists());
        assert!(!branch_present(repo, "tugarc/doomed"));

        // A retry (with a passing hook) then succeeds cleanly.
        write_config(repo, &[]);
        let retry = create("doomed", None, false, None);
        assert!(retry.is_ok());
        assert!(repo.join(".tug/worktrees/doomed").exists());
    }
}
