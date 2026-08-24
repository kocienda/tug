//! The on-demand draft engine (#draft-engine).
//!
//! A changeset entry's commit-message draft is generated on an explicit
//! request: [`spawn_on_demand_draft`] resolves the request against the latest
//! CHANGESET_ALL aggregate snapshot, derives the entry's generation target via
//! [`eligible_entries`], and — when a matching entry exists — spawns a detached
//! task that regenerates through the headless scribe. It regenerates
//! unconditionally: an explicit request always spends a scribe call (the
//! content **fingerprint**, Spec S11, is still computed and persisted, but no
//! longer gates generation).
//!
//! Results persist to `changeset_drafts` (Spec S09) and fire the global
//! aggregate bump so the next frame carries the draft. Live text deltas ride
//! CONTROL frames (Spec S10, [P24]). Generation runs on a detached task so the
//! caller — the router's per-client socket loop — never parks awaiting it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::warn;

use tugcast_core::types::{ChangesetEntry, WorkspacesChangesetSnapshot};
use tugcast_core::{FeedId, Frame};

use super::agent_supervisor::ScribeContext;
use super::workspace_registry::WorkspaceRegistry;
use crate::scribe;
use crate::session_ledger::{ChangesetDraftRow, SessionLedger};

/// Resolves a `tug_session_id` to its `claude_session_id` (for the session
/// JSONL path) — backed by the supervisor's in-memory ledger entries.
pub type SessionResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Identity of a changeset entry across recomputes.
///
/// `workspace_key` is the identity — the canonical spelling the workspace
/// registry produced through the [L29] gateway, and the only thing that is
/// ever compared, persisted, or put on the wire. `project_dir` is the raw
/// registry directory, which L29 permits for exactly one use: handing to the
/// git invocations in [`generate_for_entry`]. It is not an identity and must
/// never be matched against anything.
#[derive(Clone, PartialEq, Eq, Hash)]
struct EntryKey {
    workspace_key: String,
    project_dir: String,
    owner_kind: String,
    owner_id: String,
}

/// The in-flight generation tasks, keyed by an entry's canonical identity. A
/// live handle is aborted on [`cancel_draft`] (the user cancelling an
/// Auto-Message) or superseded when a fresh request for the same entry spawns.
/// Aborting the task drops the scribe's `kill_on_drop` child, so only that
/// draft's headless `claude` process dies — the interactive session's own turn
/// is a wholly separate worker and is never touched ([P06]).
pub type DraftTaskRegistry = Arc<StdMutex<HashMap<DraftIdentity, JoinHandle<()>>>>;

/// `(workspace_key, owner_kind, owner_id)` key into [`DraftTaskRegistry`].
///
/// No canonicalization here, and that is the point: `workspace_key` arrives
/// canonical from the gateway on both sides — the aggregate composed it, and
/// the client echoes back the one it was given — so there is nothing left to
/// reconcile. The gateway ran once, where the path was born.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct DraftIdentity {
    workspace_key: String,
    owner_kind: String,
    owner_id: String,
}

fn draft_identity(workspace_key: &str, owner_kind: &str, owner_id: &str) -> DraftIdentity {
    DraftIdentity {
        workspace_key: workspace_key.to_owned(),
        owner_kind: owner_kind.to_owned(),
        owner_id: owner_id.to_owned(),
    }
}

/// A file in a head-flavor entry, carrying everything the fingerprint and the
/// prompt need.
#[derive(Clone)]
struct FileMeta {
    path: String,
    git_status: String,
    op: String,
    origin: String,
}

/// What to generate for one eligible entry.
#[derive(Clone)]
enum DraftTarget {
    /// A session or unattributed entry — `git diff HEAD` scoped to its files.
    Head { files: Vec<FileMeta> },
    /// A dash entry — the range (rounds + worktree dirt) and its metadata.
    Dash {
        base: String,
        branch: String,
        worktree: String,
    },
}

/// One eligible entry pulled from a snapshot: its identity and its generation
/// target.
struct PendingEntry {
    key: EntryKey,
    target: DraftTarget,
}

/// The engine's shared dependencies, moved into the generation task.
#[derive(Clone)]
struct EngineDeps {
    control_tx: broadcast::Sender<Frame>,
    ledger: Arc<SessionLedger>,
    registry: Arc<WorkspaceRegistry>,
    scribe: ScribeContext,
    resolver: SessionResolver,
}

/// Resolve a draft request against the latest aggregate snapshot and, if an
/// eligible entry matches, spawn its generation on a detached task
/// (regenerating unconditionally — no fingerprint gate). Returns IMMEDIATELY:
/// `true` when a generation was spawned, `false` when no eligible entry matched
/// (nothing to draft). Does NOT await the scribe run — the caller is the
/// router's per-client socket loop, which must not park (R02, [P03]).
///
/// [P03] edited gate: once a human has touched the draft (`edited=1`), a
/// non-`force` request never overwrites it — the entry replies `ready`
/// (the persisted draft is the answer) and no scribe runs. An explicit
/// `force` (the shade's confirmed Regenerate) spends a scribe call and
/// resets `edited`.
#[allow(clippy::too_many_arguments)]
pub fn spawn_on_demand_draft(
    control_tx: broadcast::Sender<Frame>,
    ledger: Arc<SessionLedger>,
    registry: Arc<WorkspaceRegistry>,
    scribe: ScribeContext,
    resolver: SessionResolver,
    tasks: &DraftTaskRegistry,
    snapshot: WorkspacesChangesetSnapshot,
    workspace_key: &str,
    owner_kind: &str,
    owner_id: &str,
    force: bool,
) -> bool {
    let deps = EngineDeps {
        control_tx,
        ledger,
        registry,
        scribe,
        resolver,
    };
    // A string compare, not a path reconciliation: both sides carry the
    // registry's canonical `workspace_key` ([L29]).
    let Some(entry) = eligible_entries(snapshot).into_iter().find(|p| {
        p.key.owner_kind == owner_kind
            && p.key.owner_id == owner_id
            && p.key.workspace_key == workspace_key
    }) else {
        return false;
    };
    let key = entry.key;
    let target = entry.target;
    if !force {
        let edited = read_draft(
            &deps.ledger,
            &key.owner_kind,
            &key.owner_id,
            &key.workspace_key,
        )
        .map(|row| row.edited)
        .unwrap_or(false);
        if edited {
            send_state(&deps, &key, "ready", None);
            return true;
        }
    }
    // Register the generation so a cancel (or a superseding request) can abort
    // it. A fresh request for the same entry supersedes the in-flight one —
    // abort the old task before spawning, so two scribes never race to persist.
    let identity = draft_identity(&key.workspace_key, &key.owner_kind, &key.owner_id);
    let handle = tokio::spawn(async move {
        generate_for_entry(&deps, &key, &target).await;
    });
    if let Ok(mut map) = tasks.lock() {
        if let Some(old) = map.insert(identity, handle) {
            old.abort();
        }
    }
    true
}

/// Abort an in-flight Auto-Message generation for one entry ([P06]). Returns
/// `true` when a live task was found and aborted; `false` when nothing was
/// drafting (an already-settled or never-started draft — a stray finished
/// handle is reaped). The caller broadcasts the terminal `cancelled` state
/// either way: cancel is the client's only exit from a `drafting` overlay
/// whose terminal frame was lost, so it must always be answered. Aborting
/// drops the scribe's `kill_on_drop` child; the session's own turn is
/// untouched.
pub fn cancel_draft(
    tasks: &DraftTaskRegistry,
    workspace_key: &str,
    owner_kind: &str,
    owner_id: &str,
) -> bool {
    let identity = draft_identity(workspace_key, owner_kind, owner_id);
    let Ok(mut map) = tasks.lock() else {
        return false;
    };
    let Some(handle) = map.remove(&identity) else {
        return false;
    };
    if handle.is_finished() {
        return false;
    }
    handle.abort();
    true
}

/// Broadcast the terminal `cancelled` `changeset_draft_state` for a cancelled
/// Auto-Message — the same wire shape `send_state` emits, so the client overlay
/// resets identically.
pub fn send_draft_cancelled(
    control_tx: &broadcast::Sender<Frame>,
    workspace_key: &str,
    owner_kind: &str,
    owner_id: &str,
) {
    let body = serde_json::json!({
        "action": "changeset_draft_state",
        "workspace_key": workspace_key,
        "owner_kind": owner_kind,
        "owner_id": owner_id,
        "state": "cancelled",
    });
    let _ = control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_draft_state serializes"),
    ));
}

/// Read the persisted draft for an entry, keyed by the canonical
/// `workspace_key` the row was written under. One lookup, one spelling — the
/// raw-spelling union this used to carry existed only because the wire shipped
/// a raw `project_dir`, and there is no longer a second spelling to union.
pub(crate) fn read_draft(
    ledger: &SessionLedger,
    owner_kind: &str,
    owner_id: &str,
    workspace_key: &str,
) -> Option<ChangesetDraftRow> {
    ledger
        .changeset_draft(owner_kind, owner_id, workspace_key)
        .ok()
        .flatten()
}

/// Pull the eligible entries out of a snapshot with their generation targets.
/// Sessions/unattributed need ≥1 file; dashes need rounds or worktree dirt.
fn eligible_entries(snapshot: WorkspacesChangesetSnapshot) -> Vec<PendingEntry> {
    let mut out = Vec::new();
    for project in snapshot.projects {
        // The identity ([L29] gateway output) and the git cwd (raw), kept
        // apart on purpose — see `EntryKey`.
        let workspace_key = project.snapshot.workspace_key.clone();
        let project_dir = project.project_dir.clone();
        if project.no_repo {
            continue;
        }
        for entry in project.snapshot.changesets {
            match entry {
                ChangesetEntry::Session {
                    owner_id, files, ..
                } => {
                    if files.is_empty() {
                        continue;
                    }
                    let metas: Vec<FileMeta> = files
                        .iter()
                        .map(|f| FileMeta {
                            path: f.path.clone(),
                            git_status: f.git_status.clone(),
                            op: f.op.clone(),
                            origin: f.origin.clone(),
                        })
                        .collect();
                    out.push(PendingEntry {
                        key: EntryKey {
                            workspace_key: workspace_key.clone(),
                            project_dir: project_dir.clone(),
                            owner_kind: "session".to_string(),
                            owner_id,
                        },
                        target: DraftTarget::Head { files: metas },
                    });
                }
                ChangesetEntry::Dash {
                    owner_id,
                    display_name,
                    branch,
                    base,
                    rounds,
                    worktree,
                    worktree_dirty,
                    ..
                } => {
                    if rounds == 0 && !worktree_dirty {
                        continue;
                    }
                    // The git ref comes from the entry's own `branch` field
                    // ([P09]). `owner_id` is the dash's *identity* — an owner
                    // key that carries the creation id — and deriving a ref
                    // from it would fail silently: `rev-parse` and `log`
                    // return empty, the fingerprint and prompt come out
                    // degenerate, and dash draft generation just stops with no
                    // error anywhere. An older sender that omits the field
                    // falls back to the name, never to the identity.
                    let branch = branch.unwrap_or_else(|| format!("tugdash/{display_name}"));
                    out.push(PendingEntry {
                        key: EntryKey {
                            workspace_key: workspace_key.clone(),
                            project_dir: project_dir.clone(),
                            owner_kind: "dash".to_string(),
                            owner_id,
                        },
                        target: DraftTarget::Dash {
                            base,
                            branch,
                            worktree,
                        },
                    });
                }
            }
        }
        if !project.snapshot.unattributed.is_empty() {
            let metas: Vec<FileMeta> = project
                .snapshot
                .unattributed
                .iter()
                .map(|f| FileMeta {
                    path: f.path.clone(),
                    git_status: f.git_status.clone(),
                    op: String::new(),
                    origin: String::new(),
                })
                .collect();
            out.push(PendingEntry {
                key: EntryKey {
                    workspace_key: workspace_key.clone(),
                    project_dir: project_dir.clone(),
                    owner_kind: "unattributed".to_string(),
                    owner_id: String::new(),
                },
                target: DraftTarget::Head { files: metas },
            });
        }
    }
    out
}

/// Generate the draft for one entry (regenerating unconditionally, [P02]).
async fn generate_for_entry(deps: &EngineDeps, key: &EntryKey, target: &DraftTarget) {
    let repo_dir = PathBuf::from(&key.project_dir);
    let style_rules = scribe::commit_style_rules();
    let git_subjects = git_log_subjects(&repo_dir, 10).await;

    let (fingerprint, prompt) = match target {
        DraftTarget::Head { files } => {
            gather_head(deps, key, &repo_dir, files, &style_rules, &git_subjects).await
        }
        DraftTarget::Dash {
            base,
            branch,
            worktree,
        } => {
            gather_dash(
                &repo_dir,
                base,
                branch,
                worktree,
                &style_rules,
                &git_subjects,
            )
            .await
        }
    };

    send_state(deps, key, "drafting", None);

    // Forward accumulated text deltas over CONTROL while the scribe runs.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let delta_deps = deps.clone();
    let delta_key = key.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            send_delta(&delta_deps, &delta_key, &text);
        }
    });

    let model = (deps.scribe.model)();
    let result = scribe::summarize_with(&deps.scribe.spawner, model, prompt, Some(tx)).await;
    forwarder.abort();

    match result {
        Ok(message) => {
            // A wrapped generation never reaches the ledger, whatever the
            // model did with the prompt's no-hard-wrap rule.
            let message = scribe::unwrap_hard_wraps(&message);
            // Selection dispositions are the user's, not the scribe's — a
            // regeneration replaces the message but carries them forward.
            let selection = read_draft(
                &deps.ledger,
                &key.owner_kind,
                &key.owner_id,
                &key.workspace_key,
            )
            .and_then(|existing| existing.selection);
            // The stored key is the canonical `workspace_key` verbatim — the
            // gateway ran when the registry composed it, so there is nothing
            // to canonicalize here ([L29]: gateway once, at the source).
            let row = ChangesetDraftRow {
                owner_kind: key.owner_kind.clone(),
                owner_id: key.owner_id.clone(),
                project_dir: key.workspace_key.clone(),
                fingerprint,
                message,
                updated_at: now_millis(),
                edited: false,
                selection,
            };
            if let Err(err) = deps.ledger.upsert_changeset_draft(&row) {
                warn!(error = %err, "draft-engine: persist failed");
                send_state(deps, key, "error", Some("failed to persist draft"));
                return;
            }
            send_state(deps, key, "ready", None);
            // Fire the global aggregate bump so the next frame carries the draft.
            deps.registry.changeset_all_bump().notify_one();
        }
        Err(detail) => {
            warn!(detail = %detail, owner = %key.owner_id, "draft-engine: scribe failed");
            send_state(deps, key, "error", Some(&detail));
        }
    }
}

/// Gather the fingerprint + prompt for a head-flavor (session/unattributed)
/// entry.
async fn gather_head(
    deps: &EngineDeps,
    key: &EntryKey,
    repo_dir: &Path,
    files: &[FileMeta],
    style_rules: &str,
    git_subjects: &[String],
) -> (String, String) {
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    // The untracked-inclusive diff: created-but-never-committed files arrive
    // as synthesized new-file diffs, so their content reaches both the prompt
    // and the fingerprint (no side-band (size, mtime) fold-in needed).
    let diff = crate::feeds::git::fetch_git_diff_with_untracked(repo_dir, &paths)
        .await
        .unwrap_or_default();
    let status_pairs: Vec<(String, String)> = files
        .iter()
        .map(|f| (f.path.clone(), f.git_status.clone()))
        .collect();
    let fingerprint = scribe::fingerprint_head_entry(&status_pairs, &diff, &[]);

    let file_provenance: Vec<(String, String, String)> = files
        .iter()
        .map(|f| (f.path.clone(), f.op.clone(), f.origin.clone()))
        .collect();

    let prompt = if key.owner_kind == "session" {
        let user_prompts = session_user_prompts(deps, key, files).await;
        scribe::compose_draft_prompt_session(
            style_rules,
            &file_provenance,
            &user_prompts,
            git_subjects,
            &diff,
        )
    } else {
        scribe::compose_draft_prompt_unattributed(
            style_rules,
            &file_provenance,
            git_subjects,
            &diff,
        )
    };
    (fingerprint, prompt)
}

/// The owning session's user prompts since the changeset began, read from its
/// claude JSONL. Empty when the claude id / file can't be resolved (the prompt
/// then degrades to diff + conventions).
async fn session_user_prompts(
    deps: &EngineDeps,
    key: &EntryKey,
    files: &[FileMeta],
) -> Vec<String> {
    let Some(claude_id) = (deps.resolver)(&key.owner_id) else {
        return Vec::new();
    };
    // The entry key carries the project path as it was recorded, which may be
    // any spelling of the directory; claude names its project folder after one
    // of them. The chokepoint is what makes them agree ([L29]).
    let (project_root, _canonical) = crate::session_ledger::claude_project_dir(
        deps.ledger.claude_projects_root(),
        &key.project_dir,
    );
    let jsonl = project_root.join(format!("{claude_id}.jsonl"));

    // "Since the changeset began" = the earliest file-event time across the
    // entry's currently-dirty paths.
    let dirty: std::collections::HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let since_ms = deps
        .ledger
        .file_events_for_session(&key.owner_id)
        .map(|events| earliest_dirty_touch(&events, &dirty))
        .unwrap_or(0);

    scribe::session_prompts_since(&jsonl, since_ms, 20, 2_000)
}

/// The earliest touch time across the entry's dirty paths, or 0 when none
/// match. `file_events.file_path` is repo-relative at capture (canonical-path
/// identity, c6d7b806), matching the dirty set's repo-relative `path` directly
/// — no prefix strip ([P09]).
fn earliest_dirty_touch(
    events: &[crate::session_ledger::FileEventRow],
    dirty: &std::collections::HashSet<&str>,
) -> i64 {
    events
        .iter()
        .filter(|e| dirty.contains(e.file_path.as_str()))
        .map(|e| e.at)
        .min()
        .unwrap_or(0)
}

/// Gather the fingerprint + prompt for a dash entry ([P23]).
async fn gather_dash(
    repo_dir: &Path,
    base: &str,
    branch: &str,
    worktree: &str,
    style_rules: &str,
    git_subjects: &[String],
) -> (String, String) {
    let head_sha = git_output(repo_dir, &["rev-parse", branch])
        .await
        .unwrap_or_default();
    let worktree_abs = repo_dir.join(worktree);
    let worktree_status = if worktree_abs.is_dir() {
        git_output(&worktree_abs, &["status", "--porcelain"])
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };
    let fingerprint = scribe::fingerprint_dash_entry(&head_sha, &worktree_status);

    let diff = crate::feeds::git::fetch_dash_diff(repo_dir, worktree, base, branch)
        .await
        .unwrap_or_default();
    let git_log = git_output(
        repo_dir,
        &["log", "--format=%s%n%b", &format!("{base}..{branch}")],
    )
    .await
    .unwrap_or_default();
    let dash_name = branch.strip_prefix("tugdash/").unwrap_or(branch);
    let dash_log_lines = read_dash_log(repo_dir, dash_name);

    let prompt = scribe::compose_draft_prompt_dash(
        style_rules,
        &git_log,
        &dash_log_lines,
        git_subjects,
        &diff,
    );
    (fingerprint, prompt)
}

/// The last `n` commit subjects in `repo_dir` (voice for the draft).
async fn git_log_subjects(repo_dir: &Path, n: usize) -> Vec<String> {
    git_output(repo_dir, &["log", &format!("-n{n}"), "--format=%s"])
        .await
        .map(|out| out.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Read the dash's per-round instruction lines from the well-known
/// project-state-dir `dash-log.md` ([P23]), filtered to `dash_name`.
///
/// The grammar is `tugdash_core`'s and is borrowed rather than re-derived: the
/// same splitter and the same terminal-line test, so a dash name reused after
/// a join or a discard starts its draft from an empty slate instead of
/// inheriting the previous incarnation's instructions.
///
/// The *policy* is this engine's own and stays here — every non-empty `<note>`
/// in the surviving generation is a per-round instruction, whatever marker
/// carried it, which is why the birth record writes an empty note and so
/// contributes nothing.
fn read_dash_log(repo_dir: &Path, dash_name: &str) -> Vec<String> {
    let path = tugutil_core::paths::project_state_dir(repo_dir).join("dash-log.md");
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for line in content.lines() {
        let Some((_iso, dash, marker, note)) = tugdash_core::split_log_line(line) else {
            continue;
        };
        if dash != dash_name {
            continue;
        }
        if tugdash_core::is_terminal(marker, note) {
            lines.clear();
            continue;
        }
        if !note.is_empty() {
            lines.push(note.to_string());
        }
    }
    lines
}

/// Run a git command at `dir`, returning trimmed stdout on success.
async fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

fn send_state(deps: &EngineDeps, key: &EntryKey, state: &str, detail: Option<&str>) {
    let mut body = serde_json::json!({
        "action": "changeset_draft_state",
        "workspace_key": key.workspace_key,
        "owner_kind": key.owner_kind,
        "owner_id": key.owner_id,
        "state": state,
    });
    if let Some(detail) = detail {
        body["detail"] = serde_json::Value::String(detail.to_string());
    }
    let _ = deps.control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_draft_state serializes"),
    ));
}

fn send_delta(deps: &EngineDeps, key: &EntryKey, text: &str) {
    let body = serde_json::json!({
        "action": "changeset_draft_delta",
        "workspace_key": key.workspace_key,
        "owner_kind": key.owner_kind,
        "owner_id": key.owner_id,
        "text": text,
    });
    let _ = deps.control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_draft_delta serializes"),
    ));
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use crate::session_ledger::FileEventRow;

    use tugcast_core::types::{
        ChangesetEntry, ChangesetFile, ChangesetSnapshot, ProjectChangeset,
        WorkspacesChangesetSnapshot,
    };

    use crate::scribe::{ScribeDeltas, ScribeSpawner};

    /// A fake scribe: counts calls, streams two deltas, returns a scripted
    /// message.
    struct FakeScribe {
        message: String,
        calls: AtomicUsize,
        prompts: StdMutex<Vec<String>>,
    }
    impl FakeScribe {
        fn new(message: &str) -> Arc<Self> {
            Arc::new(Self {
                message: message.to_string(),
                calls: AtomicUsize::new(0),
                prompts: StdMutex::new(Vec::new()),
            })
        }
    }
    impl ScribeSpawner for FakeScribe {
        fn run(
            &self,
            _model: String,
            prompt: String,
            deltas: ScribeDeltas,
        ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.prompts.lock().unwrap().push(prompt);
            if let Some(tx) = &deltas {
                let _ = tx.send("partial".to_string());
                let _ = tx.send(self.message.clone());
            }
            let message = self.message.clone();
            Box::pin(async move { Ok(message) })
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo with one committed file and one tracked modification.
    fn init_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@t"]);
        git(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        (dir, root)
    }

    /// **The [P09] regression pin.** An id-keyed dash entry still produces a
    /// real fingerprint and a real prompt, because the git ref comes from the
    /// entry's `branch` field.
    ///
    /// Deriving the ref from `owner_id` — which is what the code did before
    /// the identity carried a creation id — fails *silently* against an
    /// id-qualified key: `rev-parse` and `log` return empty, the fingerprint
    /// degenerates, the prompt loses its diff, and nothing errors anywhere.
    /// A non-empty assertion is the only thing that catches it.
    #[tokio::test]
    async fn gather_dash_uses_the_entry_branch_not_the_owner_key() {
        let (_dir, root) = init_repo();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "second"]);
        let worktree = root.join(".tug/worktrees/demo");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "tugdash/demo",
                worktree.to_str().unwrap(),
            ],
        );
        std::fs::write(worktree.join("dash-work.txt"), "round\n").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-q", "-m", "dash round"]);

        let (fingerprint, prompt) = gather_dash(
            &root,
            "main",
            // The ref, as the entry's `branch` field carries it.
            "tugdash/demo",
            ".tug/worktrees/demo",
            "",
            &[],
        )
        .await;
        assert!(!fingerprint.is_empty(), "a real fingerprint");
        assert!(
            prompt.contains("dash round"),
            "the prompt carries the dash's real history: {prompt}"
        );
        assert!(
            prompt.contains("dash-work.txt"),
            "and its real diff: {prompt}"
        );

        // The same call with the *owner key* in the ref slot is the silent
        // failure: git resolves nothing, and the prompt comes out degenerate.
        let (degenerate_fp, degenerate_prompt) = gather_dash(
            &root,
            "main",
            "tugdash/demo#1723500000000-a1b2c3",
            ".tug/worktrees/demo",
            "",
            &[],
        )
        .await;
        assert_ne!(
            degenerate_fp, fingerprint,
            "an owner key is not a ref, and using one as one loses the history \
             without raising anything"
        );
        assert!(!degenerate_prompt.contains("dash-work.txt"));
    }

    /// A one-session snapshot for `project_dir`, whose `workspace_key` is that
    /// same string: the fixture's checkout is already the canonical spelling,
    /// and the key is what requests address the entry by.
    fn session_snapshot(project_dir: &str, status: &str) -> WorkspacesChangesetSnapshot {
        let entry = ChangesetEntry::Session {
            owner_id: "s1".to_string(),
            display_name: "s1".to_string(),
            live: true,
            files: vec![ChangesetFile {
                path: "a.txt".to_string(),
                git_status: status.to_string(),
                op: "edit".to_string(),
                origin: "exact".to_string(),
                shared: false,
                last_touched: 1,
                own_hunks: Vec::new(),
                contested_hunks: Vec::new(),
                shared_with: Vec::new(),
            }],
            draft: None,
        };
        WorkspacesChangesetSnapshot {
            ledger_degraded: false,
            projects: vec![ProjectChangeset {
                project_dir: project_dir.to_string(),
                display_name: "proj".to_string(),
                no_repo: false,
                snapshot: ChangesetSnapshot {
                    workspace_key: project_dir.to_string(),
                    branch: "main".to_string(),
                    ahead: 0,
                    behind: 0,
                    head_sha: String::new(),
                    head_message: String::new(),
                    changesets: vec![entry],
                    unattributed: vec![],
                    orphaned: vec![],
                },
                unattributed_draft: None,
                plans: vec![],
            }],
        }
    }

    fn fileless_session_snapshot(project_dir: &str) -> WorkspacesChangesetSnapshot {
        let entry = ChangesetEntry::Session {
            owner_id: "s1".to_string(),
            display_name: "s1".to_string(),
            live: true,
            files: vec![],
            draft: None,
        };
        WorkspacesChangesetSnapshot {
            ledger_degraded: false,
            projects: vec![ProjectChangeset {
                project_dir: project_dir.to_string(),
                display_name: "proj".to_string(),
                no_repo: false,
                snapshot: ChangesetSnapshot {
                    workspace_key: project_dir.to_string(),
                    branch: "main".to_string(),
                    ahead: 0,
                    behind: 0,
                    head_sha: String::new(),
                    head_message: String::new(),
                    changesets: vec![entry],
                    unattributed: vec![],
                    orphaned: vec![],
                },
                unattributed_draft: None,
                plans: vec![],
            }],
        }
    }

    fn file_event(path: &str, at: i64) -> FileEventRow {
        FileEventRow {
            tug_session_id: "s1".to_string(),
            tool_use_id: "t".to_string(),
            file_path: path.to_string(),
            tool_name: "Edit".to_string(),
            op: "edit".to_string(),
            origin: "exact".to_string(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".to_string(),
            at,
        }
    }

    fn scribe_ctx(fake: Arc<FakeScribe>) -> ScribeContext {
        ScribeContext {
            spawner: fake,
            model: Arc::new(|| "sonnet".to_string()),
        }
    }

    /// Issue an on-demand draft request for a `session` entry, returning the
    /// synchronous matched/no-match bool. Generation (if any) runs on a
    /// detached task.
    fn request(
        fake: Arc<FakeScribe>,
        ledger: Arc<SessionLedger>,
        snapshot: WorkspacesChangesetSnapshot,
        owner_id: &str,
        project: &str,
    ) -> bool {
        request_force(fake, ledger, snapshot, owner_id, project, false)
    }

    fn request_force(
        fake: Arc<FakeScribe>,
        ledger: Arc<SessionLedger>,
        snapshot: WorkspacesChangesetSnapshot,
        owner_id: &str,
        project: &str,
        force: bool,
    ) -> bool {
        let (control_tx, _rx) = broadcast::channel(64);
        spawn_on_demand_draft(
            control_tx,
            ledger,
            Arc::new(WorkspaceRegistry::new_for_test()),
            scribe_ctx(fake),
            Arc::new(|_| None),
            &DraftTaskRegistry::default(),
            snapshot,
            project,
            "session",
            owner_id,
            force,
        )
    }

    async fn wait_for_draft(ledger: &SessionLedger, project: &str) -> Option<ChangesetDraftRow> {
        for _ in 0..50 {
            if let Ok(Some(row)) = ledger.changeset_draft("session", "s1", project) {
                return Some(row);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }

    async fn wait_for_calls(fake: &FakeScribe, n: usize) {
        for _ in 0..50 {
            if fake.calls.load(Ordering::SeqCst) >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("scribe calls did not reach {n}");
    }

    #[tokio::test]
    async fn on_demand_regenerates_ignoring_fingerprint() {
        let (_dir, root) = init_repo();
        let project = root.to_string_lossy().to_string();
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let fake = FakeScribe::new("Change a.txt\n\n- edit the file");
        let snap = session_snapshot(&project, "M");

        // First request generates and persists a row (storing its fingerprint).
        assert!(request(
            fake.clone(),
            ledger.clone(),
            snap.clone(),
            "s1",
            &project
        ));
        let row = wait_for_draft(&ledger, &project)
            .await
            .expect("draft persisted");
        assert_eq!(row.message, "Change a.txt\n\n- edit the file");
        wait_for_calls(&fake, 1).await;

        // The repo is unchanged, so a second request computes the SAME
        // fingerprint. The old gate would skip; on-demand regenerates.
        assert!(request(fake.clone(), ledger.clone(), snap, "s1", &project));
        wait_for_calls(&fake, 2).await;
        assert_eq!(
            fake.calls.load(Ordering::SeqCst),
            2,
            "regenerates despite a matching fingerprint"
        );
        assert!(
            ledger
                .changeset_draft("session", "s1", &project)
                .unwrap()
                .is_some()
        );
    }

    /// The match is exact on `workspace_key`, with no spelling tolerance —
    /// and that is the [L29] contract, not a gap in it. A raw spelling of the
    /// same checkout is not a key; there is exactly one canonical key, minted
    /// by the registry, and everything that addresses an entry carries it. A
    /// request bearing anything else is a caller that skipped the gateway, and
    /// it fails loudly here rather than drafting under a key its own overlay
    /// will never read back.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_non_canonical_spelling_is_not_a_key() {
        let (_dir, root) = init_repo();
        let canonical = root.to_string_lossy().to_string();
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("linked-repo");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let raw = link.to_string_lossy().to_string();

        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let fake = FakeScribe::new("Change a.txt");

        assert!(
            !request(
                fake.clone(),
                ledger.clone(),
                session_snapshot(&canonical, "M"),
                "s1",
                &raw,
            ),
            "a symlink spelling ({raw}) must not resolve to the canonical entry ({canonical})"
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "no scribe call");

        // The canonical key, by contrast, matches.
        assert!(request(
            fake.clone(),
            ledger.clone(),
            session_snapshot(&canonical, "M"),
            "s1",
            &canonical,
        ));
        wait_for_calls(&fake, 1).await;
    }

    #[tokio::test]
    async fn edited_draft_survives_non_forced_request() {
        let (_dir, root) = init_repo();
        let project = root.to_string_lossy().to_string();
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let fake = FakeScribe::new("machine message");

        // A human-touched draft is on file.
        ledger
            .upsert_changeset_draft(&ChangesetDraftRow {
                owner_kind: "session".to_string(),
                owner_id: "s1".to_string(),
                project_dir: project.clone(),
                fingerprint: "fp".to_string(),
                message: "Hand-tuned message".to_string(),
                updated_at: 1,
                edited: true,
                selection: Some(r#"{"include":["a.txt"]}"#.to_string()),
            })
            .unwrap();

        // A non-forced request matches but never spends a scribe call or
        // touches the row ([P03]).
        let matched = request(
            fake.clone(),
            ledger.clone(),
            session_snapshot(&project, "M"),
            "s1",
            &project,
        );
        assert!(
            matched,
            "the entry matched — the gate is not a no-entry miss"
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "no scribe call");
        let row = ledger
            .changeset_draft("session", "s1", &project)
            .unwrap()
            .unwrap();
        assert_eq!(row.message, "Hand-tuned message");
        assert!(row.edited);
    }

    #[tokio::test]
    async fn forced_request_regenerates_and_resets_edited() {
        let (_dir, root) = init_repo();
        let project = root.to_string_lossy().to_string();
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let fake = FakeScribe::new("Regenerated message");

        ledger
            .upsert_changeset_draft(&ChangesetDraftRow {
                owner_kind: "session".to_string(),
                owner_id: "s1".to_string(),
                project_dir: project.clone(),
                fingerprint: "fp".to_string(),
                message: "Hand-tuned message".to_string(),
                updated_at: 1,
                edited: true,
                selection: Some(r#"{"include":["a.txt"]}"#.to_string()),
            })
            .unwrap();

        assert!(request_force(
            fake.clone(),
            ledger.clone(),
            session_snapshot(&project, "M"),
            "s1",
            &project,
            true,
        ));
        wait_for_calls(&fake, 1).await;
        let row = loop {
            let row = ledger
                .changeset_draft("session", "s1", &project)
                .unwrap()
                .unwrap();
            if row.message == "Regenerated message" {
                break row;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(!row.edited, "force resets the edited pin");
        assert_eq!(
            row.selection.as_deref(),
            Some(r#"{"include":["a.txt"]}"#),
            "selection dispositions carry across a regeneration"
        );
    }

    /// A draft row is read by its `workspace_key` and by nothing else. The
    /// canonical-then-raw union this used to perform is gone with the raw
    /// spelling that made it necessary: one key, one lookup, no guessing.
    #[cfg(unix)]
    #[test]
    fn read_draft_keys_on_the_workspace_key_alone() {
        let (_dir, root) = init_repo();
        let workspace_key = root.to_string_lossy().to_string();
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("linked-repo");
        std::os::unix::fs::symlink(&root, &link).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .upsert_changeset_draft(&ChangesetDraftRow {
                owner_kind: "session".to_string(),
                owner_id: "s1".to_string(),
                project_dir: workspace_key.clone(),
                fingerprint: "fp".to_string(),
                message: "Canonical-keyed draft".to_string(),
                updated_at: 1,
                edited: true,
                selection: None,
            })
            .unwrap();

        assert_eq!(
            read_draft(&ledger, "session", "s1", &workspace_key)
                .expect("found by its key")
                .message,
            "Canonical-keyed draft"
        );
        assert!(
            read_draft(&ledger, "session", "s1", &link.to_string_lossy()).is_none(),
            "a symlink spelling is not the key the row was written under"
        );
    }

    #[tokio::test]
    async fn on_demand_no_entry_returns_false() {
        let (_dir, root) = init_repo();
        let project = root.to_string_lossy().to_string();
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let fake = FakeScribe::new("msg");

        // A fileless session is not eligible → no match, synchronous `false`.
        let matched = request(
            fake.clone(),
            ledger.clone(),
            fileless_session_snapshot(&project),
            "s1",
            &project,
        );
        assert!(!matched, "no eligible entry");
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "no scribe call");
        assert!(
            ledger
                .changeset_draft("session", "s1", &project)
                .unwrap()
                .is_none()
        );
    }

    /// A scribe that never returns — models a generation still in flight, so a
    /// cancel has a live task to abort. The `run` future sleeps well past the
    /// test's own timeout; `cancel_draft`'s `handle.abort()` drops it.
    struct HangingScribe {
        started: Arc<tokio::sync::Notify>,
    }
    impl ScribeSpawner for HangingScribe {
        fn run(
            &self,
            _model: String,
            _prompt: String,
            _deltas: ScribeDeltas,
        ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            let started = self.started.clone();
            Box::pin(async move {
                started.notify_one();
                tokio::time::sleep(Duration::from_secs(3600)).await;
                Ok(String::new())
            })
        }
    }

    #[tokio::test]
    async fn cancel_draft_aborts_an_in_flight_generation() {
        let (_dir, root) = init_repo();
        let project = root.to_string_lossy().to_string();
        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        let started = Arc::new(tokio::sync::Notify::new());
        let scribe = ScribeContext {
            spawner: Arc::new(HangingScribe {
                started: started.clone(),
            }),
            model: Arc::new(|| "sonnet".to_string()),
        };
        let (control_tx, _rx) = broadcast::channel(64);
        let tasks = DraftTaskRegistry::default();

        assert!(spawn_on_demand_draft(
            control_tx.clone(),
            ledger.clone(),
            Arc::new(WorkspaceRegistry::new_for_test()),
            scribe,
            Arc::new(|_| None),
            &tasks,
            session_snapshot(&project, "M"),
            &project,
            "session",
            "s1",
            false,
        ));

        // Wait until the scribe is actually running (the task is registered).
        started.notified().await;
        assert_eq!(tasks.lock().unwrap().len(), 1, "task registered while live");

        // Cancel finds the live task and aborts it; the registry empties and no
        // draft row is ever persisted (the scribe never returned).
        assert!(cancel_draft(&tasks, &project, "session", "s1"));
        assert!(tasks.lock().unwrap().is_empty(), "cancelled task removed");
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            ledger
                .changeset_draft("session", "s1", &project)
                .unwrap()
                .is_none(),
            "a cancelled generation persists nothing"
        );

        // A second cancel with nothing in flight is a no-op false.
        assert!(!cancel_draft(&tasks, &project, "session", "s1"));
    }

    #[test]
    fn session_prompts_since_uses_repo_relative_paths() {
        let dirty: std::collections::HashSet<&str> = ["a.txt", "sub/b.txt"].into_iter().collect();
        let events = vec![
            file_event("a.txt", 500),
            file_event("sub/b.txt", 200),
            // An unrelated (earlier) path must not lower the floor.
            file_event("unrelated.txt", 10),
        ];
        // The min touch across the dirty repo-relative paths — never 0, as the
        // broken absolute-prefix strip produced.
        assert_eq!(earliest_dirty_touch(&events, &dirty), 200);
    }

    /// Redirect the data dir and hand back a repo root whose project state dir
    /// holds `lines` as its dash-log. The redirect is why these are `#[serial]`.
    fn log_repo(lines: &str) -> (tempfile::TempDir, tempfile::TempDir) {
        let home = tempfile::tempdir().expect("tempdir");
        // SAFETY: these tests are #[serial]; no other thread reads the
        // environment concurrently while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let repo = tempfile::tempdir().expect("tempdir");
        let state = tugutil_core::paths::project_state_dir(repo.path());
        std::fs::create_dir_all(&state).expect("state dir");
        std::fs::write(state.join("dash-log.md"), lines).expect("write log");
        (home, repo)
    }

    fn log_line(dash: &str, marker: &str, note: &str) -> String {
        format!("2026-08-14T12:00:00Z  {dash}  {marker}  {note}\n")
    }

    #[test]
    #[serial_test::serial]
    fn every_non_empty_note_in_the_generation_is_an_instruction() {
        let log = format!(
            "{}{}{}{}",
            // The birth record's note is empty, which is the whole reason it
            // contributes nothing here.
            log_line("d", "created", ""),
            log_line("d", "abc1234", "the first round"),
            log_line("other", "abc1234", "a different dash"),
            log_line("d", "abc5678", "the second round"),
        );
        let (_home, repo) = log_repo(&log);
        assert_eq!(
            read_dash_log(repo.path(), "d"),
            vec!["the first round", "the second round"],
        );
    }

    #[test]
    #[serial_test::serial]
    fn a_reused_name_starts_its_draft_from_an_empty_slate() {
        // Both spellings of the teardown, and the join — each must end the
        // generation, or the reused name's draft is authored from the previous
        // incarnation's instructions.
        for terminal in [
            log_line("d", "discarded", ""),
            log_line("d", "released", ""),
            log_line("d", "a4477d5", "joined via card"),
        ] {
            let log = format!(
                "{}{}{}",
                log_line("d", "abc1234", "a round from the previous incarnation"),
                terminal,
                log_line("d", "abc5678", "the reused name's own first round"),
            );
            let (_home, repo) = log_repo(&log);
            assert_eq!(
                read_dash_log(repo.path(), "d"),
                vec!["the reused name's own first round"],
            );
        }
    }
}
