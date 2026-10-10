//! Ending an arc without landing it: `discard`, the hand-back of uncommitted work
//! to the base, and deleting a branchless arc's documents.

use serde::Serialize;
use std::path::Path;
use std::time::SystemTime;

use super::{
    BaseDirtPath, base_working_set_dirt, branch_exists, branch_name, broke_lease_warning,
    documents_dir, git_output, live_resolve_detail, main_repo_root, reconcile_branches,
    remove_arc_worktree, worktree_path,
};
use crate::error::ArcError;
use crate::log::{append_arc_log, validate_arc_name};

/// Outcome of [`discard`].
#[derive(Debug, Clone, Serialize)]
pub struct DiscardOutcome {
    pub name: String,
    /// The documents directory a discard left standing ([P11]). A discarded
    /// arc's brief and plan are the only trace of decisions the user may
    /// return to, so discard keeps them and names where they are. Absent when
    /// the arc had no documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documents_kept: Option<String>,
    /// The worktree's uncommitted work handed back to the base checkout before
    /// teardown ([P08]) — the inverse of `create --carry`, and not limited to
    /// what arrived that way.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_restored: Vec<String>,
    pub warnings: Vec<String>,
}

/// Outcome of [`delete_documents_in`].
#[derive(Debug, Clone, Serialize)]
pub struct DeleteDocumentsOutcome {
    pub name: String,
    /// The directory that was removed. Absent when there was nothing there —
    /// a delete of documents that are already gone is a state, not an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<String>,
    /// The file names the directory held, read before the removal so the
    /// receipt can say what was destroyed. Unrecoverable afterwards: `.tug/`
    /// is excluded from git, so nothing on disk or in history holds a copy.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// Delete an arc's documents directory — `.tug/arcs/<name>/` — and nothing
/// else. No branch, no worktree, no arc-log teardown ([B05]).
///
/// **This is not a discard, and must never route through one.** `discard` is
/// about a branch and a worktree, keeps the documents on purpose ([P11]), and
/// refuses outright for a name that has neither — which is exactly the case
/// this verb exists for: a discarded arc, or a door abandoned before it cut a
/// branch, leaves a documents directory that nothing else can remove. Keeping
/// the two distinct is what stops the destructive teardown path from
/// acquiring a second meaning.
///
/// An arc that still has a branch or a worktree is refused by name: those are
/// the arc's own, `discard` is the verb that ends them, and deleting the brief
/// out from under a running arc would strand it. A directory that is not there
/// reports `removed: None` and succeeds, so a double press is quiet.
pub fn delete_documents_in(
    repo_root: &Path,
    name: &str,
) -> Result<DeleteDocumentsOutcome, ArcError> {
    validate_arc_name(name).map_err(ArcError::InvalidName)?;

    let branch = branch_name(name);
    if branch_exists(repo_root, &branch) {
        return Err(ArcError::Refused(format!(
            "arc '{name}' still has the branch {branch}; `tugtool arc discard {name}` ends an arc"
        )));
    }
    if worktree_path(repo_root, name).exists() {
        return Err(ArcError::Refused(format!(
            "arc '{name}' still has a worktree; `tugtool arc discard {name}` ends an arc"
        )));
    }

    let dir = documents_dir(repo_root, name);
    if !dir.is_dir() {
        return Ok(DeleteDocumentsOutcome {
            name: name.to_string(),
            removed: None,
            files: Vec::new(),
        });
    }

    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| ArcError::io(format!("cannot read {}", dir.display()), &dir, e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();

    std::fs::remove_dir_all(&dir)
        .map_err(|e| ArcError::io(format!("cannot delete {}", dir.display()), &dir, e))?;

    Ok(DeleteDocumentsOutcome {
        name: name.to_string(),
        removed: Some(dir.display().to_string()),
        files,
    })
}

/// Like [`discard`], but against an explicit repo root instead of the process
/// cwd — for callers such as tugcast.
pub fn discard_in(
    repo_root: &Path,
    name: &str,
    origin: Option<&str>,
    break_lease: bool,
) -> Result<DiscardOutcome, ArcError> {
    discard_inner(repo_root, name, origin, break_lease, true)
}

/// Discard an arc an **agent** made, handing nothing back to the base checkout
/// ([P09]).
///
/// The hand-back exists to protect a *user's* carried work: `create --carry`
/// moves uncommitted bytes into the worktree, so the worktree holds the only
/// copy and teardown would destroy it. Everything in an abandoned agent's
/// worktree belongs to a process nobody watched, and restoring it onto the
/// user's checkout is not a courtesy — it is an edit the user did not make.
///
/// The whole apparatus is skipped, not merely its copy step, and that is the
/// load-bearing part. [`working_set_hand_back`] runs *before* anything is
/// written and **refuses the entire discard** when the base holds its own
/// uncommitted edit to a path the worktree also changed. For a `--carry` arc
/// that refusal is the right protection; for an agent's arc it is a leak
/// wearing a message, because the discard fails, the worktree survives, and
/// the next firing meets an arc that already exists. And
/// [`apply_hand_back`] **deletes** base files for every entry in
/// `hand.deletions`, so an agent that removed a file is one hand-back away
/// from removing it from the user's checkout. One skip closes both.
///
/// `break_lease` is always true: a settle-ceiling kill is precisely the case
/// where a resolve lease may still be held by the process being killed, and a
/// cleanup that refuses on a lease held by its own corpse never cleans up.
pub fn discard_agent_arc_in(
    repo_root: &Path,
    name: &str,
    origin: Option<&str>,
) -> Result<DiscardOutcome, ArcError> {
    discard_inner(repo_root, name, origin, true, false)
}

fn discard_inner(
    repo_root: &Path,
    name: &str,
    origin: Option<&str>,
    break_lease: bool,
    hand_back: bool,
) -> Result<DiscardOutcome, ArcError> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    reconcile_branches(&repo_root, &mut warnings);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    if !branch_exists(&repo_root, &branch) && !worktree.exists() {
        // An arc that exists only as an arc record — an arc that stopped
        // before its devise stage created anything — has no branch or
        // worktree to tear down, but it has a record a later `arc run` under
        // the name would resume into. Discard ends that record the way it
        // ends an arc's: with the terminal marker.
        if crate::arc::read_arc(&repo_root, name).is_some() {
            append_arc_log(
                &repo_root,
                name,
                "discarded",
                &origin.map_or(String::new(), |o| format!("via {o}")),
            )
            .map_err(|e| ArcError::arc_log(&repo_root, e))?;
            return Ok(DiscardOutcome {
                name: name.to_string(),
                documents_kept: documents_dir(&repo_root, name)
                    .is_dir()
                    .then(|| documents_dir(&repo_root, name).display().to_string()),
                work_restored: Vec::new(),
                warnings: vec![
                    "no branch or worktree existed; the arc's record was ended".to_string(),
                ],
            });
        }
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }

    // The worktree's uncommitted work has the same shape of problem as the
    // plan, one level up: `create --carry` moves work here and leaves it
    // uncommitted by design, so the worktree holds the only copy of it and
    // teardown would destroy it. Check for the one case that cannot be resolved
    // — the base has since acquired its own edit to the same path — before
    // anything at all has moved, so a refused discard changes nothing ([P08]).
    //
    // An agent's arc reaches none of this ([P09]): the read itself is what
    // refuses, so the mode skips the read rather than the copy.
    let hand = hand_back.then(|| working_set_hand_back(&repo_root, &worktree));
    if let Some(hand) = &hand
        && !hand.conflicts.is_empty()
    {
        return Err(ArcError::Refused(format!(
            "Cannot discard '{name}': the base checkout has its own uncommitted changes to \
             {}, which the arc also changed without committing. Handing the arc's work back \
             would overwrite yours, so the arc is left standing. Commit or stash the base \
             changes, then discard again.",
            hand.conflicts.join(", ")
        )));
    }

    // A resolve another process may still be running holds the arc, and the
    // teardown below removes the workshop it is working in. Above every write,
    // beside the hand-back refusal, so a refused discard changes nothing.
    let broke_lease = match crate::resolve::resolve_lease(&repo_root, name, SystemTime::now()) {
        Some(lease) if !break_lease => {
            return Err(ArcError::Refused(live_resolve_detail(
                name, &lease, "discard",
            )));
        }
        Some(lease) => Some(lease),
        None => None,
    };

    // Everything above this line refuses without touching anything, so the
    // record starts here — at the first write, with the branch still standing
    // and its config still readable.
    let op_seq = match crate::oplog::capture_before(&repo_root, name) {
        Ok(mut before) => {
            before.broke_lease = broke_lease.as_ref().map(|l| l.age.as_secs());
            let tips = crate::oplog::tips_of(&before);
            crate::oplog::record_begin(
                &repo_root,
                crate::oplog::OpVerb::Discard,
                name,
                before,
                &tips,
            )
            .map_err(|e| e.context("cannot record the discard in the op log"))?
        }
        Err(e) => {
            return Err(e.context("cannot record the discard in the op log"));
        }
    };
    if let Some(lease) = &broke_lease {
        warnings.push(broke_lease_warning(name, lease, op_seq));
    }

    let work_restored = match &hand {
        Some(hand) => apply_hand_back(&repo_root, &worktree, hand, &mut warnings),
        None => Vec::new(),
    };

    // Reap the arc's tmux/app and remove its worktree robustly (see
    // `remove_arc_worktree` for the "Directory not empty" race this avoids).
    remove_arc_worktree(&repo_root, &branch, &worktree, &mut warnings);

    // A loose ref outlives the branch config it was written beside, so the
    // candidate is dropped explicitly here too.
    crate::resolve::clear_candidate(&repo_root, name);
    crate::workshop::remove(&repo_root, name, &mut warnings);

    // Delete the branch (warn on failure).
    if branch_exists(&repo_root, &branch) {
        match git_output(&repo_root, &["branch", "-D", &branch]) {
            Ok(o) if !o.status.success() => warnings.push(format!(
                "Failed to delete branch: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => warnings.push(format!("Failed to delete branch: {}", e)),
            _ => {}
        }
    }

    // Record the terminal action in the arc log ([P04]).
    append_arc_log(
        &repo_root,
        name,
        "discarded",
        &origin.map_or(String::new(), |o| format!("via {o}")),
    )
    .map_err(|e| ArcError::arc_log(&repo_root, e))?;

    // The handed-back paths are the discard's one irreversible half: they were
    // copied into the base checkout, and an undo names them rather than
    // clawing them back.
    if let Err(e) = crate::oplog::record_complete(
        &repo_root,
        op_seq,
        crate::oplog::OpAfter {
            handed_back: work_restored.clone(),
            ..Default::default()
        },
    ) {
        warnings.push(format!("Failed to complete the op-log record: {}", e));
    }

    // The documents stay: a discarded arc's brief and plan are the only trace
    // of decisions the user may want back, and `arc run <name>` reopens on
    // them ([P11]).
    let documents = documents_dir(&repo_root, name);
    Ok(DiscardOutcome {
        name: name.to_string(),
        documents_kept: documents.is_dir().then(|| documents.display().to_string()),
        work_restored,
        warnings,
    })
}

/// What discard must do with the worktree's uncommitted work before the
/// worktree is deleted ([P08]).
struct HandBack {
    /// Paths to copy back to the base checkout.
    restore: Vec<BaseDirtPath>,
    /// Paths the base already holds its own uncommitted edit to. Handing these
    /// back would overwrite the user's other work to complete a discard, so
    /// discard refuses instead.
    conflicts: Vec<String>,
    /// Paths the worktree *deleted*. Deliberately not handed back: the base
    /// still holds the file, so keeping it loses no bytes, while handing the
    /// deletion back would destroy base content in order to finish a teardown.
    deletions: Vec<String>,
}

/// Read what the arc worktree holds uncommitted and sort it into [`HandBack`].
///
/// Scoped to *all* uncommitted worktree work, not only what arrived by
/// `create --carry`: tracking provenance would mean new persisted state, and
/// the broader rule is the more useful one anyway — work typed in a worktree
/// and never committed is destroyed by a discard today.
fn working_set_hand_back(repo_root: &Path, worktree: &Path) -> HandBack {
    let mut out = HandBack {
        restore: Vec::new(),
        conflicts: Vec::new(),
        deletions: Vec::new(),
    };
    if !worktree.exists() {
        return out;
    }
    let base_dirty: std::collections::BTreeSet<String> = base_working_set_dirt(repo_root)
        .into_iter()
        .map(|d| d.path)
        .collect();
    for entry in base_working_set_dirt(worktree) {
        if entry.deleted {
            out.deletions.push(entry.path);
        } else if base_dirty.contains(&entry.path) {
            out.conflicts.push(entry.path);
        } else {
            out.restore.push(entry);
        }
    }
    out
}

/// Copy the worktree's uncommitted work back to the base checkout. Content
/// only: a staged worktree edit arrives on base unstaged, the same asymmetry
/// `create --carry` states in its own flag help.
fn apply_hand_back(
    repo_root: &Path,
    worktree: &Path,
    hand: &HandBack,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let mut restored = Vec::new();
    for entry in &hand.restore {
        let target = repo_root.join(&entry.path);
        if let Some(dir) = target.parent()
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            warnings.push(format!("Failed to hand back {}: {e}", entry.path));
            continue;
        }
        match std::fs::copy(worktree.join(&entry.path), &target) {
            Ok(_) => restored.push(entry.path.clone()),
            Err(e) => warnings.push(format!("Failed to hand back {}: {e}", entry.path)),
        }
    }
    for path in &hand.deletions {
        warnings.push(format!(
            "The arc deleted {path} without committing it; the base copy is left in place."
        ));
    }
    restored
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use tempfile::TempDir;

    // ── The documents home ───────────────────────────────────────────────────

    /// The delete destroys the directory and names what was in it — the
    /// receipt's only chance, since `.tug/` is excluded from git and nothing
    /// gives the brief back.
    #[test]
    fn deleting_documents_removes_the_directory_and_names_its_files() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_arc_document(root, "ghost", "brief.md");
        write_arc_document(root, "ghost", "tasks.md");
        // A neighbour, so this is a delete of one arc rather than of `.tug/`.
        write_arc_document(root, "keeper", "brief.md");

        let outcome = delete_documents_in(root, "ghost").unwrap();
        assert_eq!(outcome.name, "ghost");
        assert!(outcome.removed.is_some());
        assert_eq!(outcome.files, vec!["brief.md", "tasks.md"]);
        assert!(!documents_dir(root, "ghost").exists());
        assert!(
            brief_file(root, "keeper").is_file(),
            "the neighbouring arc's brief is untouched"
        );
    }

    /// A delete of documents that are already gone is a state, not an error:
    /// a second press on a row mid-recompute must not raise a notice.
    #[test]
    fn deleting_absent_documents_succeeds_quietly() {
        let temp = TempDir::new().unwrap();
        let outcome = delete_documents_in(temp.path(), "never-was").unwrap();
        assert_eq!(outcome.removed, None);
        assert!(outcome.files.is_empty());
    }

    /// **An arc that still has a branch is refused by name.** Deleting the
    /// brief out from under a running arc would strand it, and ending an arc
    /// is `discard`'s job — the two verbs stay distinct ([B05]).
    #[serial]
    #[test]
    fn deleting_documents_refuses_an_arc_that_still_has_a_branch() {
        let (_temp, root) = repo_for_create();
        create_in(&root, "live-arc", None, false, None).unwrap();
        write_arc_document(&root, "live-arc", "brief.md");

        let err = delete_documents_in(&root, "live-arc")
            .expect_err("refused")
            .to_string();
        assert!(err.contains("tugarc/live-arc"), "{err}");
        assert!(err.contains("arc discard"), "{err}");
        assert!(
            brief_file(&root, "live-arc").is_file(),
            "a refusal deletes nothing"
        );
    }

    /// An invalid name never reaches the filesystem — the guard is the same
    /// one every other arc verb takes.
    #[test]
    fn deleting_documents_validates_the_arc_name() {
        let temp = TempDir::new().unwrap();
        assert!(delete_documents_in(temp.path(), "../escape").is_err());
    }

    #[serial]
    #[test]
    fn discard_ends_an_arc_that_never_made_a_arc() {
        let (_temp, root) = repo_for_create();
        crate::arc::append_arc_start(&root, "arc-only", "arc/idea.md").unwrap();
        assert!(crate::arc::read_arc(&root, "arc-only").is_some());

        let out = discard("arc-only", Some("cli"), false).unwrap();
        assert_eq!(out.documents_kept, None);
        assert!(out.work_restored.is_empty());
        assert_eq!(out.warnings.len(), 1, "it says what it ended");
        assert_eq!(crate::arc::read_arc(&root, "arc-only"), None);
        // With the record ended there is nothing left under the name.
        assert!(discard("arc-only", Some("cli"), false).is_err());
    }

    /// The inverse: a discarded arc's decisions are the only trace the user
    /// may want back, so they stay and the receipt says where ([P11]).
    #[serial]
    #[test]
    fn a_discarded_arc_keeps_its_documents_and_says_so() {
        let temp = TempDir::new().unwrap();
        let repo = bare_repo_beside_state(&temp);
        create("kept", None, false, None).unwrap();
        let root = fs::canonicalize(&repo).unwrap();

        let documents = documents_dir(&root, "kept");
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("brief.md"), "# The brief\n").unwrap();
        fs::write(documents.join("plan.md"), TWO_STEP_PLAN).unwrap();

        let out = discard("kept", Some("cli"), false).unwrap();
        assert_eq!(
            out.documents_kept.as_deref(),
            Some(&*documents.to_string_lossy())
        );
        assert!(documents.join("brief.md").is_file());
        assert!(documents.join("plan.md").is_file());
        assert!(!branch_present(&root, "tugarc/kept"));
    }

    /// The abandon arm of the carry gesture. Carried work is uncommitted by
    /// design, so the worktree holds the only copy of it — without the
    /// hand-back, `--carry` would move a developer's work somewhere a routine
    /// discard destroys it, which is the tool creating the hazard.
    #[serial]
    #[test]
    fn discard_returns_carried_work_to_the_base() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("returner", None, true, None).unwrap();
        assert!(!root.join("scratch.txt").exists());

        let out = discard("returner", None, false).unwrap();
        assert_eq!(out.work_restored, vec!["scratch.txt".to_string()]);
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );
        assert!(!worktree_path(&root, "returner").exists());
    }

    /// The guard is not carry-specific: work typed in the worktree and never
    /// committed is destroyed by a discard today, and that is the more useful
    /// rule as well as the one that needs no provenance tracking.
    #[serial]
    #[test]
    fn discard_returns_work_that_never_arrived_by_carry() {
        let (_temp, root) = repo_for_create();
        create("typed", None, false, None).unwrap();
        let worktree = worktree_path(&root, "typed");
        fs::write(worktree.join("typed.txt"), "written in the arc\n").unwrap();
        fs::write(worktree.join("README.md"), "# edited in the arc\n").unwrap();

        let out = discard("typed", None, false).unwrap();
        assert_eq!(out.work_restored, vec!["README.md", "typed.txt"]);
        assert_eq!(
            fs::read_to_string(root.join("typed.txt")).unwrap(),
            "written in the arc\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# edited in the arc\n"
        );
    }

    /// The one case that cannot be resolved: handing the work back would
    /// overwrite the user's own uncommitted edit. The work stays reachable
    /// rather than being destroyed to complete a discard, and the refusal comes
    /// before anything has moved.
    #[serial]
    #[test]
    fn discard_refuses_rather_than_overwrite_a_conflicting_base_edit() {
        let (_temp, root) = repo_for_create();
        create("clash", None, false, None).unwrap();
        let worktree = worktree_path(&root, "clash");
        fs::write(worktree.join("README.md"), "# the arc's words\n").unwrap();
        fs::write(root.join("README.md"), "# the user's words\n").unwrap();

        let err = discard("clash", None, false).unwrap_err().to_string();
        assert!(err.contains("README.md"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# the user's words\n",
            "the base copy is untouched"
        );
        assert!(worktree.exists(), "the arc is left standing");
        assert!(branch_present(&root, "tugarc/clash"));
    }

    #[serial]
    #[test]
    fn discard_of_a_clean_worktree_behaves_exactly_as_before() {
        let (_temp, root) = repo_for_create();
        create("spotless", None, false, None).unwrap();
        let out = discard("spotless", None, false).unwrap();
        assert!(out.work_restored.is_empty());
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        assert!(!worktree_path(&root, "spotless").exists());
    }

    /// The pinning test for [P09]: an agent's arc is torn down and the base
    /// checkout does not move by a byte.
    ///
    /// Everything in an abandoned agent's worktree belongs to a process nobody
    /// watched. Restoring it onto the user's checkout is not a courtesy — it is
    /// an edit the user did not make, and it is the incident this mode exists
    /// to close.
    #[serial]
    #[test]
    fn an_agent_arc_is_discarded_without_handing_a_byte_back() {
        let (_temp, root) = repo_for_create();
        create("agent-ci-abc12345", None, false, None).unwrap();
        let worktree = worktree_path(&root, "agent-ci-abc12345");
        fs::write(worktree.join("agent.txt"), "the agent's leftovers\n").unwrap();
        fs::write(worktree.join("README.md"), "# the agent's words\n").unwrap();

        let before = base_fingerprint(&root);
        let out = discard_agent_arc_in(&root, "agent-ci-abc12345", Some("agent")).unwrap();

        assert!(out.work_restored.is_empty(), "{:?}", out.work_restored);
        assert_eq!(base_fingerprint(&root), before, "the base did not move");
        assert!(!root.join("agent.txt").exists());
        assert!(!worktree.exists());
        assert!(!branch_present(&root, "tugarc/agent-ci-abc12345"));
    }

    /// The case that a mode skipping only `apply_hand_back` would still fail,
    /// and the reason the skip has to reach `working_set_hand_back` itself.
    ///
    /// The read runs before any write and **refuses the whole discard** on a
    /// conflicting base edit. For a user's `--carry` arc that refusal is the
    /// right protection. For an agent's arc it is a leak wearing a message:
    /// the discard fails, the worktree survives, and the wire's next firing
    /// meets an arc that already exists.
    #[serial]
    #[test]
    fn an_agent_arc_is_discarded_even_when_the_base_holds_a_conflicting_edit() {
        let (_temp, root) = repo_for_create();
        create("agent-ci-clash", None, false, None).unwrap();
        let worktree = worktree_path(&root, "agent-ci-clash");
        fs::write(worktree.join("README.md"), "# the agent's words\n").unwrap();
        fs::write(root.join("README.md"), "# the user's words\n").unwrap();

        let before = base_fingerprint(&root);
        discard_agent_arc_in(&root, "agent-ci-clash", Some("agent")).unwrap();

        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# the user's words\n",
            "the user's own uncommitted edit survived untouched"
        );
        assert_eq!(base_fingerprint(&root), before);
        assert!(!worktree.exists(), "and the arc did not survive the clash");
    }

    /// The same bug wearing its other face. `apply_hand_back` **deletes** base
    /// files for every entry in `hand.deletions`, so an agent that removed a
    /// file is one hand-back away from removing it from the user's checkout.
    #[serial]
    #[test]
    fn an_agent_arc_that_deleted_a_file_does_not_delete_it_from_the_base() {
        let (_temp, root) = repo_for_create();
        create("agent-ci-deleter", None, false, None).unwrap();
        let worktree = worktree_path(&root, "agent-ci-deleter");
        assert!(worktree.join("README.md").exists());
        fs::remove_file(worktree.join("README.md")).unwrap();

        let before = base_fingerprint(&root);
        discard_agent_arc_in(&root, "agent-ci-deleter", Some("agent")).unwrap();

        assert!(
            root.join("README.md").exists(),
            "the base still holds the file the agent deleted in its own tree"
        );
        assert_eq!(base_fingerprint(&root), before);
    }

    /// An agent's arc with committed rounds is torn down the same way. The
    /// caller decided the work was not worth keeping; the mode's promise is
    /// only that nothing reaches the base checkout.
    #[serial]
    #[test]
    fn an_agent_arc_with_rounds_is_discarded_and_the_base_does_not_move() {
        let (_temp, root) = repo_for_create();
        create("agent-ci-rounds", None, false, None).unwrap();
        let worktree = worktree_path(&root, "agent-ci-rounds");
        fs::write(worktree.join("fixed.rs"), "the agent's fix\n").unwrap();
        for args in [
            vec!["add", "-A"],
            vec!["commit", "-m", "tugarc(agent-ci-rounds): the round"],
        ] {
            git_output(&worktree, &args).unwrap();
        }
        assert_eq!(round_count_in(&root, "agent-ci-rounds"), 1);

        let before = base_fingerprint(&root);
        discard_agent_arc_in(&root, "agent-ci-rounds", Some("agent")).unwrap();

        assert!(!root.join("fixed.rs").exists());
        assert_eq!(base_fingerprint(&root), before);
        assert!(!branch_present(&root, "tugarc/agent-ci-rounds"));
    }

    /// Teardown is symmetric: a discard from inside the universe removes the
    /// branch and the worktree there, leaving the base alone.
    #[serial]
    #[test]
    fn test_universe_discard_tears_down_inside_the_universe() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);
        create("goner", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/goner");
        assert!(worktree.exists());

        discard_in(&universe, "goner", None, false).unwrap();

        assert!(!worktree.exists(), "worktree gone");
        assert!(!branch_present(&universe, "tugarc/goner"), "branch gone");
        assert!(!base.join(".tug").exists());
    }

    /// A discard records its route the same way — its marker already carries
    /// the word `discarded`, so the note carries the route alone.
    #[serial]
    #[test]
    fn a_discard_records_the_route_that_asked_for_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("dropped", None, false, None).unwrap();
        discard("dropped", Some("cli"), false).unwrap();

        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("discarded  via cli"),
            "arc log should name the route: {dlog}"
        );
    }

    #[serial]
    #[test]
    fn undo_of_a_discard_rebuilds_the_arc_and_leaves_handed_back_work_alone() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("backagain", None, true, None).unwrap();
        let arc_tip = git_stdout(&root, &["rev-parse", "tugarc/backagain"]).unwrap();
        discard("backagain", None, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );

        let out = crate::oplog::undo_in(&root, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Discard);
        assert_eq!(
            git_stdout(&root, &["rev-parse", "tugarc/backagain"]).unwrap(),
            arc_tip
        );
        assert!(worktree_path(&root, "backagain").exists());
        // The hand-back copied the file into the base checkout. Pulling it back
        // out is what this engine never does, so the undo names it instead.
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n",
            "the handed-back file stays where the discard put it"
        );
        assert_eq!(
            out.handed_back_left_in_place,
            vec!["scratch.txt".to_string()]
        );
    }

    #[serial]
    #[test]
    fn a_discard_over_a_live_chain_is_refused_the_same_way() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "leased");
        let repo = temp.path();
        let marker = lease_a_parked_conflict(repo, "leased");
        let ops_before = crate::oplog::list_ops(repo).len();

        let err = discard("leased", None, false).unwrap_err().to_string();
        assert!(err.contains("A resolve may still be running"), "{err}");
        assert!(err.contains("to discard anyway"), "{err}");

        assert_eq!(
            crate::resolve::read_conflict(repo, "leased").unwrap().tip,
            marker
        );
        assert!(branch_exists(repo, "tugarc/leased"), "the arc stands");
        assert!(worktree_path(repo, "leased").exists());
        assert_eq!(crate::oplog::list_ops(repo).len(), ops_before);
    }

    /// The full receipt: an op that records the break, a warning that names
    /// it, and an undo that puts the resolver's checkpoints back.
    ///
    /// A discard, because that is the shape where a lease genuinely still
    /// stands: a join lands a *candidate*, and a candidate standing beside the
    /// chain is the resolver's own receipt that it finished ([P02]).
    #[serial]
    #[test]
    fn breaking_the_lease_tears_down_records_the_age_and_is_undoable() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "broken");
        let repo = temp.path();
        park_conflict(repo, "broken");
        crate::resolve::mark_resolve_begun(repo, "broken").unwrap();

        // The crashed resolver's committed work, above the begin marker.
        let ws = crate::workshop::Workshop::open_conflict(repo, "broken").unwrap();
        fs::write(ws.path().join("shared.txt"), "base\nboth sides\n").unwrap();
        ws.checkpoint("tugresolve(broken): checkpoint").unwrap();
        let chain_tip = crate::resolve::read_conflict(repo, "broken").unwrap().tip;
        assert!(crate::resolve::resolve_lease(repo, "broken", SystemTime::now()).is_some());

        let out = discard("broken", Some("cli"), true).expect("the break tears the arc down");
        let warning = out
            .warnings
            .iter()
            .find(|w| w.contains("Broke the resolve lease"))
            .expect("the break is narrated");

        let op = crate::oplog::newest_undoable(repo, Some("broken")).expect("an op stands");
        assert!(warning.contains(&format!("#{}", op.seq)), "{warning}");
        assert!(
            op.before.broke_lease.is_some(),
            "the op records that a lease was broken"
        );
        assert_eq!(op.before.conflict.as_deref(), Some(chain_tip.as_str()));

        assert!(
            crate::resolve::read_conflict(repo, "broken").is_none(),
            "the discard tore the chain down, as it always has"
        );
        crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            crate::resolve::read_conflict(repo, "broken").map(|c| c.tip),
            Some(chain_tip),
            "and undo puts the resolver's checkpoints back"
        );
    }

    #[serial]
    #[test]
    fn undo_of_a_discard_restores_the_conflict_ref_too() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "tossed");
        let repo = temp.path();
        park_conflict(repo, "tossed");
        let (chain_tip, _candidate) = resolve_parked_conflict(repo, "tossed");

        discard("tossed", None, false).unwrap();
        assert!(crate::resolve::read_conflict(repo, "tossed").is_none());

        crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            crate::resolve::read_conflict(repo, "tossed").map(|c| c.tip),
            Some(chain_tip)
        );
    }

    #[serial]
    #[test]
    fn a_discard_undone_is_redone_without_repeating_the_hand_back() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("backandgone", None, true, None).unwrap();
        discard("backandgone", None, false).unwrap();
        crate::oplog::undo_in(&root, None).unwrap();
        assert!(branch_exists(&root, "tugarc/backandgone"));

        let out = crate::oplog::redo_in(&root, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Discard);
        assert!(!branch_exists(&root, "tugarc/backandgone"));
        assert!(!worktree_path(&root, "backandgone").exists());
        // The handed-back file was copied into the base checkout by the
        // original discard and is still there. A redo neither re-copies it nor
        // takes it away; it names it.
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );
        assert_eq!(
            out.handed_back_left_in_place,
            vec!["scratch.txt".to_string()]
        );
    }

    #[serial]
    #[test]
    fn a_discard_records_what_it_handed_back() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("recorder", None, true, None).unwrap();
        let arc_tip = git_stdout(&root, &["rev-parse", "tugarc/recorder"]).unwrap();

        discard("recorder", None, false).unwrap();

        let op = crate::oplog::list_ops(&root)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Discard)
            .expect("the discard recorded an operation");
        assert_eq!(op.before.arc_tip, arc_tip);
        let after = op.after.expect("a completed discard has an after");
        assert_eq!(
            after.handed_back,
            vec!["scratch.txt".to_string()],
            "the handed-back paths are named, because an undo cannot claw them back"
        );
        assert!(
            git_output(&root, &["cat-file", "-e", &format!("{arc_tip}^{{commit}}")])
                .unwrap()
                .status
                .success(),
            "the discarded arc's tip survives its branch"
        );
    }

    #[serial]
    #[test]
    fn test_arc_discard_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        let result = discard("test-arc", None, false);
        assert!(result.is_ok());

        assert!(!worktree.exists());
        assert!(!branch_present(repo, "tugarc/test-arc"));

        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("discarded"),
            "arc log should record discard: {dlog}"
        );
    }

    #[serial]
    #[test]
    fn test_arc_discard_nonexistent_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let result = discard("nonexistent", None, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }
}
