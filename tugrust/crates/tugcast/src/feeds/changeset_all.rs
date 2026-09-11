//! Aggregate changeset feed — the account-global view of every open
//! project's dirty state (CHANGESET_ALL, 0x24).
//!
//! One process-level feed (delivered like USAGE/DIGEST, registered once in
//! `main.rs`, fanned out to every deck), replacing the per-workspace
//! `ChangesetFeed`. On each recompute it enumerates the current
//! `WorkspaceRegistry` entries (the open session cards + bootstrap) and composes
//! one [`ProjectChangeset`] per project: a git working tree goes through the
//! shared [`compose_snapshot`] building block; a non-repo dir yields a
//! `no_repo: true` element the card renders with an "Initialize git"
//! affordance. The result is one [`WorkspacesChangesetSnapshot`] frame.
//!
//! Recompute triggers: a process-global `Notify` ("global bump") that the
//! attribution intercept fires (via `ChangesetBumper`) after each file-event
//! write, and that `WorkspaceRegistry::get_or_create`/`release` fire when a
//! project's first/last session card opens/closes — plus a poll fallback that
//! catches hand edits. Emission is diff-suppressed.
//!
//! One deliberate exception to "every recompute is driven by a real event"
//! ([P12], Risk R01): out-of-process draft writes (`tugtool draft set`, a
//! skill authoring a landing draft) are invisible to this process's bump. A
//! 2 s drafts-version probe (`MAX(updated_at)` over
//! `changes.changeset_drafts`) fires the existing bump only when the value
//! moves — the event is real (a draft write), only its *observation* is
//! polled, the same relationship `git_watch` has to git state.
//!
//! The same probe stats each open project's `arc-log.md` ([P06]). That file
//! lives under the data dir rather than the workspace, so a log-only write
//! reaches no watcher at all — and since the join now derives its
//! readiness from what the log records, an unobserved append would leave a
//! ready arc dark until something unrelated moved.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use tugcast_core::types::{ChangesetSnapshot, ProjectChangeset, WorkspacesChangesetSnapshot};
use tugcast_core::{FeedId, Frame, SnapshotFeed};

use super::changeset::{apply_session_rows, compose_snapshot};
use super::git::is_within_git_worktree;
use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

/// How long a bump waits before recomposing, so a burst of them costs one
/// recompute. Imperceptible against the Changes card's human timescale, and
/// the same scale as the debounce the file watchers already apply.
const BUMP_FLOOR: std::time::Duration = std::time::Duration::from_millis(150);

/// The account-global CHANGESET_ALL feed.
pub struct ChangesetAllFeed {
    /// The set of open projects to enumerate each recompute.
    registry: Arc<WorkspaceRegistry>,
    /// Shared ledger for the per-project `file_events` / owner joins.
    /// `None` in harnesses without a ledger — every dirty file then lands
    /// unattributed.
    ledger: Option<Arc<SessionLedger>>,
    /// Process-global recompute signal — shared with `ChangesetBumper`, the
    /// registry's open/close hooks, and every workspace's event-driven git
    /// watch (`feeds/git_watch.rs`). Permit semantics: bursts coalesce. This is
    /// the *only* recompute trigger — there is no poll.
    bump: Arc<Notify>,
}

impl ChangesetAllFeed {
    pub fn new(
        registry: Arc<WorkspaceRegistry>,
        ledger: Option<Arc<SessionLedger>>,
        bump: Arc<Notify>,
    ) -> Self {
        Self {
            registry,
            ledger,
            bump,
        }
    }
}

#[async_trait]
impl SnapshotFeed for ChangesetAllFeed {
    fn feed_id(&self) -> FeedId {
        FeedId::CHANGESET_ALL
    }

    fn name(&self) -> &str {
        "changeset_all"
    }

    async fn run(self: Box<Self>, tx: watch::Sender<Frame>, cancel: CancellationToken) {
        info!("aggregate changeset feed started");

        let mut previous: Option<WorkspacesChangesetSnapshot> = None;

        // The drafts-version probe ([P12]): observe out-of-process draft
        // writes by polling `MAX(updated_at)`; fire the bump only on change.
        let mut probe = tokio::time::interval(std::time::Duration::from_secs(2));
        probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_drafts_version = drafts_version(self.ledger.as_deref());
        let mut last_arc_log_stamps = arc_log_stamps(&self.registry);

        // Compose the initial snapshot immediately, then recompute only when the
        // bump fires — every recompute is driven by a real event (an attributed
        // write, an open/close, a workspace's event-driven git watch, or a
        // probed draft write). The probe tick itself never recomputes.
        loop {
            let started = std::time::Instant::now();
            let snapshot = compose_aggregate(&self.registry, self.ledger.as_deref()).await;
            debug!(
                projects = snapshot.projects.len(),
                millis = started.elapsed().as_millis() as u64,
                "aggregate changeset recomputed"
            );

            if previous.as_ref() != Some(&snapshot) {
                let json = serde_json::to_vec(&snapshot).unwrap_or_default();
                let _ = tx.send(Frame::new(FeedId::CHANGESET_ALL, json));
                debug!(
                    projects = snapshot.projects.len(),
                    "aggregate changeset snapshot updated"
                );
                previous = Some(snapshot);
            }

            'wait: loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        info!("aggregate changeset feed shutting down");
                        return;
                    }
                    _ = self.bump.notified() => {
                        // Coalescing floor. `git_watch` bumps on every
                        // filesystem batch under any workspace root, so
                        // sustained activity (a build, a save burst) would
                        // otherwise drive full recomputes of every project
                        // back to back, rate-limited only by how long a
                        // recompute takes.
                        tokio::select! {
                            _ = cancel.cancelled() => {
                                info!("aggregate changeset feed shutting down");
                                return;
                            }
                            _ = tokio::time::sleep(BUMP_FLOOR) => {}
                        }
                        // Nothing awaited `notified()` during the sleep, so a
                        // bump that landed there left a stored permit. Consume
                        // it — its work is already folded into the recompute
                        // about to run, and leaving it would spend a second
                        // full compose on an identical snapshot.
                        let _ = tokio::time::timeout(
                            std::time::Duration::ZERO,
                            self.bump.notified(),
                        )
                        .await;
                        break 'wait;
                    }
                    // Deliberately ungated: the arc-log half must run in a
                    // harness with no ledger too, and gating the whole tick on
                    // `ledger.is_some()` (as the drafts probe alone once did)
                    // would take the mark path down with it ([P06]).
                    _ = probe.tick() => {
                        let version = drafts_version(self.ledger.as_deref());
                        if self.ledger.is_some() && version != last_drafts_version {
                            last_drafts_version = version;
                            self.bump.notify_one();
                        }
                        let stamps = arc_log_stamps(&self.registry);
                        if stamps != last_arc_log_stamps {
                            last_arc_log_stamps = stamps;
                            self.bump.notify_one();
                        }
                    }
                }
            }
        }
    }
}

/// The current drafts version: `MAX(updated_at)` over
/// `changes.changeset_drafts`, `None` when no ledger or no rows.
fn drafts_version(ledger: Option<&SessionLedger>) -> Option<i64> {
    ledger.and_then(|l| l.changeset_drafts_version().ok().flatten())
}

/// Each open project's `arc-log.md` mtime, in registry order ([P06]).
///
/// The log lives under the data dir, outside every watched workspace root, so
/// a write that touches nothing else — `arc mark`, a lone `run-through` line
/// — reaches no watcher. The same relationship the drafts probe has to a
/// draft write: the event is real, only its observation is polled. A missing
/// log is `None`, which means creating the first one moves the vector and
/// fires the bump exactly like a later append does.
fn arc_log_stamps(registry: &WorkspaceRegistry) -> Vec<Option<std::time::SystemTime>> {
    registry
        .project_dirs()
        .iter()
        .map(|(root, _key)| {
            std::fs::metadata(tugtool_core::paths::arc_log_path(root))
                .and_then(|meta| meta.modified())
                .ok()
        })
        .collect()
}

/// Compose one aggregate snapshot over the registry's current entries.
///
/// Projects are emitted in the registry's enumeration order (sorted by
/// `project_dir`, so diff-suppression is stable). Each project is gated by
/// the subprocess-free [`is_within_git_worktree`] before any `git` runs: a
/// non-repo dir becomes a `no_repo: true` element; a repo dir goes through
/// [`compose_snapshot`]. A repo dir whose `git status` fails transiently
/// (compose returns `None` despite being within a worktree) degrades to an
/// empty repo element rather than flipping to `no_repo` — it self-heals on
/// the next recompute, and the card never offers "Initialize git" for a real
/// repository.
///
/// Every project (repo or not) then joins its workspace's ledger session
/// rows via [`apply_session_rows`]: live sessions gain (possibly fileless)
/// entries and session titles follow the chooser's name → prompt → id rule,
/// so the card can render one row per open session.
pub(crate) async fn compose_aggregate(
    registry: &WorkspaceRegistry,
    ledger: Option<&SessionLedger>,
) -> WorkspacesChangesetSnapshot {
    let open = registry.project_dirs();
    let mut projects = Vec::with_capacity(open.len());
    // What owner election needs about each open project, parallel to
    // `projects`: its dir, whether it is a repo, and whether this cycle's
    // `compose_snapshot` actually succeeded (a transient `git status`
    // failure degrades to an empty repo element, which must not be elected
    // to carry the repo's arc list — a sibling that composed should).
    let mut compose_facts: Vec<(std::path::PathBuf, bool, bool)> =
        Vec::with_capacity(projects.capacity());
    // Entries whose directory is gone from disk: they compose nothing this
    // cycle and are swept from the registry below — a deleted project's open
    // card holds its refcount forever, so nothing else can ever reap them.
    let mut gone: Vec<String> = Vec::new();

    for (project_dir, workspace_key) in open {
        if !project_dir.is_dir() {
            tracing::warn!(
                project = %project_dir.display(),
                "workspace directory no longer exists; sweeping its registry entry"
            );
            gone.push(workspace_key);
            continue;
        }
        let display_name = project_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| project_dir.to_string_lossy().into_owned());
        let dir_str = project_dir.to_string_lossy().into_owned();

        let (no_repo, composed, mut snapshot) = if is_within_git_worktree(&project_dir).await {
            match compose_snapshot(&project_dir, ledger).await {
                Some(mut snapshot) => {
                    snapshot.workspace_key = workspace_key;
                    (false, true, snapshot)
                }
                // Within a worktree but `git status` failed this cycle —
                // keep the project as a repo, empty until it recovers.
                None => (false, false, empty_snapshot(workspace_key)),
            }
        } else {
            (true, false, empty_snapshot(workspace_key))
        };

        if let Some(ledger) = ledger {
            match ledger.list_for_workspace(&snapshot.workspace_key) {
                Ok(rows) => {
                    apply_session_rows(&mut snapshot, &rows);
                    super::changeset::attach_live_session_drafts(&mut snapshot, ledger);
                }
                Err(err) => {
                    crate::ledger_integrity::health::note_error("sessions", &err);
                    tracing::warn!(error = %err, "session-row join failed; session titles unavailable this cycle");
                }
            }
        }

        // The unattributed bucket's maintained draft (Spec S10), attached only
        // when the bucket has files. Keyed by `workspace_key` — the spelling
        // every draft row is written under — so there is one lookup and no
        // spelling to reconcile.
        let unattributed_draft = if snapshot.unattributed.is_empty() {
            None
        } else {
            ledger
                .and_then(|l| {
                    l.changeset_draft("unattributed", "", snapshot.workspace_key.as_ref())
                        .ok()
                        .flatten()
                })
                .as_ref()
                .map(super::changeset::draft_from_row)
        };

        // Per-project compose trace: what this cycle produced for each open
        // project. The load-bearing diagnostic for a stale/empty Changes view —
        // `unattributed=N` here is ground truth against the deck's "No changes".
        debug!(
            project = %dir_str,
            no_repo,
            changesets = snapshot.changesets.len(),
            unattributed = snapshot.unattributed.len(),
            orphaned = snapshot.orphaned.len(),
            "changeset compose"
        );

        compose_facts.push((project_dir, no_repo, composed));
        projects.push(ProjectChangeset {
            project_dir: dir_str,
            display_name,
            no_repo,
            snapshot,
            unattributed_draft,
            document_arcs: Vec::new(),
        });
    }

    attach_arcs_per_repo(&mut projects, &compose_facts, ledger).await;

    if !gone.is_empty() {
        registry.sweep_missing(&gone);
    }

    WorkspacesChangesetSnapshot {
        projects,
        ledger_degraded: crate::ledger_integrity::health::is_degraded(),
    }
}

/// Attach each repo's arc composition to exactly one of its open projects.
///
/// An arc list is a property of the repo — `git worktree list` answers
/// repo-wide from any worktree — so composing it per project duplicated every
/// arc row whenever two open projects shared one repo: a linked worktree
/// beside its base, or one checkout open under two spellings. Projects group
/// by the `(device, inode)` of `git rev-parse --git-common-dir`, which is
/// what actually identifies one directory across spellings; a resolved path
/// *string* does not, because `/Users` is a firmlink and no path-string
/// resolution crosses it.
///
/// The owner is elected **after** file composition, from the group's
/// successfully-composed projects — the base checkout (dir identity equal to
/// the common dir's parent) when it is among them, else the first by
/// `project_dir` order — so a transient `git status` failure on one project
/// never takes the whole repo's arc list off the frame while a sibling could
/// carry it. A project whose probe fails composes its own list, exactly as
/// every project did before grouping existed. `join_board::sweep` and
/// `sweep_workshops` ride inside `arc_entries`, so under this grouping they
/// run once per repo, on the owner.
async fn attach_arcs_per_repo(
    projects: &mut [ProjectChangeset],
    compose_facts: &[(std::path::PathBuf, bool, bool)],
    ledger: Option<&SessionLedger>,
) {
    use std::collections::HashMap;

    // (group key, is the base checkout) per project; `None` for a non-repo
    // or a failed probe.
    let mut identities: Vec<Option<((u64, u64), bool)>> = Vec::with_capacity(compose_facts.len());
    for (project_dir, no_repo, _composed) in compose_facts {
        identities.push(if *no_repo {
            None
        } else {
            repo_group_identity(project_dir).await
        });
    }

    let mut groups: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
    for (index, identity) in identities.iter().enumerate() {
        if let Some((key, _)) = identity {
            groups.entry(*key).or_default().push(index);
        }
    }

    for (index, (project_dir, no_repo, composed)) in compose_facts.iter().enumerate() {
        if *no_repo {
            continue;
        }
        let owns_arcs = match &identities[index] {
            // Probe failed — the project composes its own list, as it always
            // did before grouping existed.
            None => true,
            Some((key, _)) => {
                let members = &groups[key];
                let owner = members
                    .iter()
                    .copied()
                    .filter(|&i| compose_facts[i].2)
                    .find(|&i| identities[i].is_some_and(|(_, is_base)| is_base))
                    .or_else(|| members.iter().copied().find(|&i| compose_facts[i].2));
                owner == Some(index)
            }
        };
        if !owns_arcs {
            continue;
        }
        if *composed {
            super::changeset::attach_arc_composition(
                project_dir,
                ledger,
                &mut projects[index].snapshot,
            )
            .await;
        }
        projects[index].document_arcs =
            super::changeset::document_arc_entries(project_dir, ledger).await;
    }
}

/// The `(device, inode)` of a project's git common dir, plus whether the
/// project *is* the base checkout (its own directory identity equals the
/// common dir's parent's). `None` when any probe step fails, which the
/// caller treats as "compose alone" rather than "compose nothing".
async fn repo_group_identity(project_dir: &std::path::Path) -> Option<((u64, u64), bool)> {
    use std::os::unix::fs::MetadataExt;
    let common = super::changeset::git_stdout(
        project_dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    if common.is_empty() {
        return None;
    }
    let common_path = std::path::Path::new(&common);
    let common_meta = std::fs::metadata(common_path).ok()?;
    let key = (common_meta.dev(), common_meta.ino());
    let is_base = match (
        std::fs::metadata(common_path.parent()?),
        std::fs::metadata(project_dir),
    ) {
        (Ok(parent), Ok(own)) => (parent.dev(), parent.ino()) == (own.dev(), own.ino()),
        _ => false,
    };
    Some((key, is_base))
}

/// The empty per-project payload for a non-repo (or transiently-degraded)
/// project — no branch header, no changesets, nothing unattributed.
fn empty_snapshot(workspace_key: String) -> ChangesetSnapshot {
    ChangesetSnapshot {
        workspace_key,
        branch: String::new(),
        ahead: 0,
        behind: 0,
        head_sha: String::new(),
        head_message: String::new(),
        changesets: Vec::new(),
        unattributed: Vec::new(),
        orphaned: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_ledger::FileEventRow;
    use std::path::Path;
    use std::time::Duration;
    use tugcast_core::spawn_snapshot_feed;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("committed.txt"), "base\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "base commit"]);
    }

    /// Mint an arc on the repo — a `tugarc/<name>` branch with its base
    /// config, the shape `arc_detail_entries_in` composes from.
    fn add_arc(dir: &Path, name: &str) {
        let branch = format!("tugarc/{name}");
        git(dir, &["branch", &branch]);
        git(
            dir,
            &["config", &format!("branch.{branch}.tugbase"), "main"],
        );
    }

    fn arc_count(project: &ProjectChangeset) -> usize {
        project
            .snapshot
            .changesets
            .iter()
            .filter(|e| matches!(e, tugcast_core::types::ChangesetEntry::Arc { .. }))
            .count()
    }

    fn bare_project(dir: &Path) -> ProjectChangeset {
        ProjectChangeset {
            project_dir: dir.to_string_lossy().into_owned(),
            display_name: "p".to_owned(),
            no_repo: false,
            snapshot: empty_snapshot("wk".to_owned()),
            unattributed_draft: None,
            document_arcs: Vec::new(),
        }
    }

    /// The aggregate carries a repo's arc list exactly once when the base
    /// checkout and one of its linked worktrees are open together — on the
    /// base's project, never duplicated onto the worktree's.
    #[tokio::test]
    async fn one_repo_open_twice_composes_its_arcs_once() {
        let base_dir = tempfile::tempdir().unwrap();
        let base = base_dir.path().canonicalize().unwrap();
        init_repo(&base);
        add_arc(&base, "demo");
        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().canonicalize().unwrap().join("wt");
        git(
            &base,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "tugarc/demo"],
        );

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _base_entry = registry.get_or_create(&base, cancel.clone()).unwrap();
        let _wt_entry = registry.get_or_create(&wt, cancel.clone()).unwrap();

        let snapshot = compose_aggregate(&registry, None).await;
        assert_eq!(snapshot.projects.len(), 2);
        let base_project = snapshot
            .projects
            .iter()
            .find(|p| Path::new(&p.project_dir) == base)
            .expect("base project");
        let wt_project = snapshot
            .projects
            .iter()
            .find(|p| Path::new(&p.project_dir) == wt)
            .expect("worktree project");
        assert_eq!(arc_count(base_project), 1, "the base carries the list");
        assert_eq!(arc_count(wt_project), 0, "the worktree does not repeat it");
        assert!(
            wt_project.document_arcs.is_empty(),
            "document arcs stay with the owner too"
        );
    }

    /// A linked worktree open without its base still carries the repo's arc
    /// list — the owner fallback when the base checkout is not among the open
    /// projects.
    #[tokio::test]
    async fn a_worktree_open_alone_carries_the_repo_arcs() {
        let base_dir = tempfile::tempdir().unwrap();
        let base = base_dir.path().canonicalize().unwrap();
        init_repo(&base);
        add_arc(&base, "demo");
        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().canonicalize().unwrap().join("wt");
        git(
            &base,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "tugarc/demo"],
        );

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _wt_entry = registry.get_or_create(&wt, cancel.clone()).unwrap();

        let snapshot = compose_aggregate(&registry, None).await;
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(
            arc_count(&snapshot.projects[0]),
            1,
            "with no base open, the worktree is the owner"
        );
    }

    /// Two unrelated repos keep their own lists — grouping only collapses
    /// projects that share a git common dir.
    #[tokio::test]
    async fn unrelated_repos_each_keep_their_arcs() {
        let a_dir = tempfile::tempdir().unwrap();
        let a = a_dir.path().canonicalize().unwrap();
        init_repo(&a);
        add_arc(&a, "one");
        let b_dir = tempfile::tempdir().unwrap();
        let b = b_dir.path().canonicalize().unwrap();
        init_repo(&b);
        add_arc(&b, "two");

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _a_entry = registry.get_or_create(&a, cancel.clone()).unwrap();
        let _b_entry = registry.get_or_create(&b, cancel.clone()).unwrap();

        let snapshot = compose_aggregate(&registry, None).await;
        assert_eq!(snapshot.projects.len(), 2);
        for project in &snapshot.projects {
            assert_eq!(
                arc_count(project),
                1,
                "{} carries exactly its own arc",
                project.project_dir
            );
        }
    }

    /// Two spellings of one checkout — same `(device, inode)`, different path
    /// strings — group as one repo and compose one copy. A symlinked spelling
    /// gives the shape under test without depending on the machine's firmlink
    /// layout; the registry cannot hold this pair (its resolver collapses
    /// symlinks), so the attachment is driven directly.
    #[tokio::test]
    async fn two_spellings_of_one_checkout_compose_one_copy() {
        let base_dir = tempfile::tempdir().unwrap();
        let base = base_dir.path().canonicalize().unwrap();
        init_repo(&base);
        add_arc(&base, "demo");
        let link_parent = tempfile::tempdir().unwrap();
        let link = link_parent.path().join("spelled-differently");
        std::os::unix::fs::symlink(&base, &link).unwrap();

        let mut projects = vec![bare_project(&base), bare_project(&link)];
        let facts = vec![(base.clone(), false, true), (link.clone(), false, true)];
        attach_arcs_per_repo(&mut projects, &facts, None).await;

        assert_eq!(
            arc_count(&projects[0]) + arc_count(&projects[1]),
            1,
            "one directory, however spelled, is one repo"
        );
    }

    /// Owner election reads which projects actually composed: when the base
    /// checkout's compose failed this cycle, a sibling carries the repo's
    /// list rather than nobody.
    #[tokio::test]
    async fn a_failed_base_compose_hands_the_arcs_to_a_sibling() {
        let base_dir = tempfile::tempdir().unwrap();
        let base = base_dir.path().canonicalize().unwrap();
        init_repo(&base);
        add_arc(&base, "demo");
        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().canonicalize().unwrap().join("wt");
        git(
            &base,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "tugarc/demo"],
        );

        let mut projects = vec![bare_project(&base), bare_project(&wt)];
        // The base is open but its `compose_snapshot` failed this cycle.
        let facts = vec![(base.clone(), false, false), (wt.clone(), false, true)];
        attach_arcs_per_repo(&mut projects, &facts, None).await;

        assert_eq!(arc_count(&projects[0]), 0, "a failed compose cannot own");
        assert_eq!(arc_count(&projects[1]), 1, "the sibling carries the list");
    }

    /// An entry whose directory has been deleted contributes nothing to the
    /// aggregate and one compose sweeps it out of the registry — cancel token
    /// fired, entry removed — while a live sibling is untouched. The refcount
    /// is deliberately not consulted: a deleted project's open card holds its
    /// count forever, so the refcounted path can never reap the ghost.
    #[tokio::test]
    async fn a_deleted_directory_is_swept_and_a_live_one_is_not() {
        let doomed_parent = tempfile::tempdir().unwrap();
        let doomed = doomed_parent.path().canonicalize().unwrap().join("doomed");
        std::fs::create_dir(&doomed).unwrap();
        let live_dir = tempfile::tempdir().unwrap();
        let live = live_dir.path().canonicalize().unwrap();
        init_repo(&live);

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let doomed_entry = registry.get_or_create(&doomed, cancel.clone()).unwrap();
        let live_entry = registry.get_or_create(&live, cancel.clone()).unwrap();

        std::fs::remove_dir_all(&doomed).unwrap();

        let snapshot = compose_aggregate(&registry, None).await;
        assert_eq!(snapshot.projects.len(), 1, "the ghost composes nothing");
        assert_eq!(Path::new(&snapshot.projects[0].project_dir), live);

        assert!(doomed_entry.cancel.is_cancelled(), "sweep fires the cancel");
        assert!(
            !live_entry.cancel.is_cancelled(),
            "the live entry is untouched"
        );
        assert_eq!(registry.inner_for_test().len(), 1, "the ghost is removed");
    }

    fn event(session: &str, tool_use: &str, path: &Path, project: &Path) -> FileEventRow {
        FileEventRow {
            tug_session_id: session.to_owned(),
            tool_use_id: tool_use.to_owned(),
            file_path: path.to_string_lossy().into_owned(),
            tool_name: "Write".to_owned(),
            op: "write".to_owned(),
            origin: "exact".to_owned(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: project.to_string_lossy().into_owned(),
            at: 1_700_000_000_000,
        }
    }

    /// The aggregate composes one repo project (with attributed dirt) and one
    /// non-repo project into a single frame, and a global bump recomputes
    /// long before the poll fires.
    #[tokio::test]
    async fn aggregate_composes_repo_and_non_repo_and_bumps() {
        // Two open projects: a git repo and a bare directory.
        let repo_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().canonicalize().unwrap();
        init_repo(&repo);

        let plain_dir = tempfile::tempdir().unwrap();
        let plain = plain_dir.path().canonicalize().unwrap();

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _repo_entry = registry.get_or_create(&repo, cancel.clone()).unwrap();
        let _plain_entry = registry.get_or_create(&plain, cancel.clone()).unwrap();

        // Sessions recorded under the registry's canonical keys, one per
        // project — the aggregate's ledger join must give each a (fileless)
        // entry even before any file event lands.
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        ledger
            .record_spawn(
                "sess-a",
                _repo_entry.workspace_key.as_ref(),
                &repo.to_string_lossy(),
                "card-1",
                0,
                "sess-a",
                None,
            )
            .unwrap();
        ledger
            .record_spawn(
                "sess-b",
                _plain_entry.workspace_key.as_ref(),
                &plain.to_string_lossy(),
                "card-2",
                0,
                "sess-b",
                None,
            )
            .unwrap();

        let bump = Arc::new(Notify::new());
        // There is no poll: the initial snapshot emits at once, and every later
        // emission must come from the bump.
        let feed = ChangesetAllFeed::new(
            Arc::clone(&registry),
            Some(Arc::clone(&ledger)),
            Arc::clone(&bump),
        );

        let (tx, mut rx) = watch::channel(Frame::new(FeedId::CHANGESET_ALL, vec![]));
        let feed_cancel = CancellationToken::new();
        let task = spawn_snapshot_feed(Box::new(feed), tx, feed_cancel.clone());

        // First emission: the immediate initial tick. Both projects present;
        // each carries a fileless entry for its live session (the ledger
        // join), the repo otherwise clean, plain flagged no_repo.
        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("initial snapshot within timeout")
            .expect("sender alive");
        let initial: WorkspacesChangesetSnapshot =
            serde_json::from_slice(&rx.borrow_and_update().payload).unwrap();
        assert_eq!(initial.projects.len(), 2);
        let repo_proj = initial
            .projects
            .iter()
            .find(|p| p.project_dir == repo.to_string_lossy())
            .expect("repo project present");
        assert!(!repo_proj.no_repo);
        assert_eq!(repo_proj.snapshot.branch, "main");
        assert_eq!(repo_proj.snapshot.changesets.len(), 1);
        let tugcast_core::types::ChangesetEntry::Session {
            owner_id,
            live,
            files,
            ..
        } = &repo_proj.snapshot.changesets[0]
        else {
            panic!("expected session entry");
        };
        assert_eq!(owner_id, "sess-a");
        assert!(live);
        assert!(files.is_empty(), "no file events yet — a fileless entry");
        let plain_proj = initial
            .projects
            .iter()
            .find(|p| p.project_dir == plain.to_string_lossy())
            .expect("plain project present");
        assert!(plain_proj.no_repo);
        assert_eq!(plain_proj.snapshot.branch, "");
        assert_eq!(
            plain_proj.snapshot.changesets.len(),
            1,
            "non-repo projects list their live sessions too"
        );

        // A new attributed file in the repo + a global bump → recompute long
        // before the 60s poll.
        std::fs::write(repo.join("bumped.txt"), "x").unwrap();
        ledger
            .record_file_event(&event("sess-a", "tu-1", &repo.join("bumped.txt"), &repo))
            .unwrap();
        bump.notify_one();

        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("bumped snapshot within timeout")
            .expect("sender alive");
        let bumped: WorkspacesChangesetSnapshot =
            serde_json::from_slice(&rx.borrow_and_update().payload).unwrap();
        let repo_proj = bumped
            .projects
            .iter()
            .find(|p| p.project_dir == repo.to_string_lossy())
            .expect("repo project present");
        assert_eq!(repo_proj.snapshot.changesets.len(), 1);
        let tugcast_core::types::ChangesetEntry::Session { files, .. } =
            &repo_proj.snapshot.changesets[0]
        else {
            panic!("expected session entry");
        };
        assert_eq!(files.len(), 1, "the attributed write now shows");

        feed_cancel.cancel();
        let _ = task.await;
        cancel.cancel();
        drop(_repo_entry);
        drop(_plain_entry);
    }

    /// Two bumps inside the floor publish one frame, not two. Frames are the
    /// observable contract — a redundant recompute would compose an identical
    /// snapshot and be swallowed by diff-suppression, so the thing worth
    /// pinning is that the second bump's work rides the first bump's compose.
    #[tokio::test]
    async fn bumps_inside_the_floor_publish_one_frame() {
        let repo_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().canonicalize().unwrap();
        init_repo(&repo);

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _entry = registry.get_or_create(&repo, cancel.clone()).unwrap();

        let bump = Arc::new(Notify::new());
        let feed = ChangesetAllFeed::new(Arc::clone(&registry), None, Arc::clone(&bump));
        let (tx, mut rx) = watch::channel(Frame::new(FeedId::CHANGESET_ALL, vec![]));
        let feed_cancel = CancellationToken::new();
        let task = spawn_snapshot_feed(Box::new(feed), tx, feed_cancel.clone());

        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("initial snapshot within timeout")
            .expect("sender alive");
        rx.borrow_and_update();

        // Two changes, two bumps, 50 ms apart — both land inside the floor.
        std::fs::write(repo.join("one.txt"), "x").unwrap();
        bump.notify_one();
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(repo.join("two.txt"), "x").unwrap();
        bump.notify_one();

        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("coalesced snapshot within timeout")
            .expect("sender alive");
        let snapshot: WorkspacesChangesetSnapshot =
            serde_json::from_slice(&rx.borrow_and_update().payload).unwrap();
        assert_eq!(
            snapshot.projects[0].snapshot.unattributed.len(),
            2,
            "one frame carries both writes"
        );

        // The stored permit was consumed, so no second frame follows.
        assert!(
            tokio::time::timeout(Duration::from_millis(750), rx.changed())
                .await
                .is_err(),
            "the coalesced bump must not spend a second compose"
        );

        feed_cancel.cancel();
        let _ = task.await;
        cancel.cancel();
        drop(_entry);
    }

    /// End-to-end firmlink split through the real record → store → compose path:
    /// a session opened under a symlink spelling records a symlink-spelled tool
    /// `file_path`; `into_row` projects it to repo-relative in canonical space,
    /// and `compose_aggregate` shows the file owned, not unattributed.
    #[cfg(unix)]
    #[tokio::test]
    async fn end_to_end_firmlink_split_attributes() {
        use crate::feeds::attribution::{PendingCall, repo_root_for};
        use crate::path_resolver::CanonicalPath;
        use tokio_util::sync::CancellationToken;
        use tugcast_core::types::ChangesetEntry;

        let repo_dir = tempfile::tempdir().unwrap();
        let root = repo_dir.path().canonicalize().unwrap();
        init_repo(&root);
        // Track arc/x.md, then modify it — git then reports the individual
        // file (a wholly-untracked dir would collapse to `arc/`).
        std::fs::create_dir(root.join("arc")).unwrap();
        std::fs::write(root.join("arc/x.md"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "add arc"]);
        std::fs::write(root.join("arc/x.md"), "edited\n").unwrap();

        // A symlink to the repo — the "other spelling" the session opens under.
        let link_home = tempfile::tempdir().unwrap();
        let link = link_home.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let entry = registry.get_or_create(&link, cancel.clone()).unwrap();

        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        ledger
            .record_spawn(
                "sess",
                entry.workspace_key.as_ref(),
                &link.to_string_lossy(),
                "card-1",
                0,
                "sess",
                None,
            )
            .unwrap();

        // The relay's capture: canonical project_dir + canonical repo root, and a
        // symlink-spelled tool file_path that `into_row` projects repo-relative.
        let canonical_project_dir = CanonicalPath::from_raw(&link);
        let repo_root = CanonicalPath::from_raw(
            &repo_root_for(canonical_project_dir.as_path())
                .await
                .expect("repo root"),
        );
        let pending = PendingCall {
            tool_name: "Write".to_owned(),
            file_path: link.join("arc/x.md").to_string_lossy().into_owned(),
            op: "write",
            parent_tool_use_id: None,
            timestamp: None,
            spans: Vec::new(),
        };
        // The edit postdates the fixture's commit, so the row is live.
        let row = pending
            .into_row(
                "sess",
                "tu-1",
                &canonical_project_dir,
                Some(&repo_root),
                "exact",
                crate::session_ledger::now_millis() + 2_000,
            )
            .expect("the symlink-spelled path canonicalizes into the repo");
        assert_eq!(
            row.file_path, "arc/x.md",
            "recorded repo-relative despite the split"
        );
        ledger.record_file_event(&row).unwrap();

        let snapshot = compose_aggregate(&registry, Some(&ledger)).await;
        let project = snapshot
            .projects
            .iter()
            .find(|p| !p.no_repo)
            .expect("repo project present");
        let owned: Vec<&str> = project
            .snapshot
            .changesets
            .iter()
            .flat_map(|e| match e {
                ChangesetEntry::Session { files, .. } => {
                    files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>()
                }
                _ => Vec::new(),
            })
            .collect();
        assert_eq!(
            owned,
            ["arc/x.md"],
            "the split edit is owned, not unattributed"
        );
        assert!(
            project.snapshot.unattributed.is_empty(),
            "nothing falls to unattributed: {:?}",
            project.snapshot.unattributed
        );

        drop(entry);
        cancel.cancel();
    }

    /// The drafts-version probe's change detection ([P12]): the version moves
    /// exactly once per external write — one bump per write, none while quiet.
    #[test]
    fn drafts_version_moves_once_per_write() {
        let ledger = SessionLedger::open_in_memory().unwrap();
        assert_eq!(drafts_version(Some(&ledger)), None, "empty table");

        let mut row = crate::session_ledger::ChangesetDraftRow {
            owner_kind: "session".to_string(),
            owner_id: "s1".to_string(),
            project_dir: "/proj".to_string(),
            fingerprint: "fp".to_string(),
            message: "Draft".to_string(),
            updated_at: 100,
            edited: true,
            selection: None,
        };
        ledger.upsert_changeset_draft(&row).unwrap();
        let after_first = drafts_version(Some(&ledger));
        assert_eq!(after_first, Some(100), "one write moves the version once");
        // Quiet reads stay put — a probe tick with no write never bumps.
        assert_eq!(drafts_version(Some(&ledger)), after_first);

        row.updated_at = 200;
        ledger.upsert_changeset_draft(&row).unwrap();
        assert_eq!(drafts_version(Some(&ledger)), Some(200));
    }
}
