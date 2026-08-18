//! Dash orchestration — the `tugdash` library API.
//!
//! Lightweight, worktree-isolated work units driven entirely on git: a dash
//! *is* a branch (`tugdash/<name>`) plus a worktree
//! (`.tug/worktrees/<name>`; legacy dashes at `.tugtree/tugdash__<name>` migrate
//! on first touch). Its base branch and description live in git
//! config (`branch.tugdash/<name>.{tugbase,description}`); its activity is
//! recorded in the per-project append-only dash-log. There is no database.
//!
//! Each verb (`create` / `commit` / `join` / `release` / `list` / `show`)
//! returns a typed outcome and never prints — the `tugdash` CLI (and the
//! Changeset card, via tugcast) own presentation. Repo resolution is
//! cwd-relative (`find_repo_root`), matching `git`'s own behaviour.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tugutil_core::paths::project_state_dir;
use tugutil_core::{Config, find_repo_root, sanitize_branch_name};

use crate::dash::{
    DashDeclaration, DashRoundMeta, MarkStage, StepPhase, append_dash_log, append_mark_declaration,
    append_step_declaration, detect_default_branch, read_declarations, validate_dash_name,
};

/// Outcome of [`create`].
#[derive(Debug, Clone, Serialize)]
pub struct CreateOutcome {
    pub name: String,
    /// The dash's owner key ([P01]) — `tugdash/<name>#<tugid>`.
    pub id: Option<String>,
    pub description: Option<String>,
    pub branch: String,
    pub worktree: String,
    pub base_branch: String,
    pub status: String,
    pub created: bool,
    /// The adoption receipt, when the dash was created with a plan. Additive:
    /// absent from the JSON for a plan-less create.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<AdoptOutcome>,
    /// What the base checkout still holds uncommitted, as create leaves it.
    /// Reporting only: create never takes it, and a create over a dirty base
    /// succeeds exactly as before. It is here because the alternative is
    /// silence — the dirt becomes either invisible divergence or the join's
    /// `base-dirt` refusal, and nothing says so at the moment it could still be
    /// dealt with cheaply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_dirt: Vec<BaseDirtPath>,
    /// The base checkout's branch, when it is not the dash's base branch.
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
    /// The `--carry` transplant moved this path into the dash worktree ([P06]);
    /// it is no longer on the base. An uncarried entry is still sitting there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub carried: bool,
}

/// One entry in the [`list`] outcome.
#[derive(Debug, Clone, Serialize)]
pub struct DashListItem {
    pub name: String,
    /// The dash's owner key ([P01]); the legacy branch ref for an id-less dash.
    pub id: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub round_count: i64,
    pub worktree: Option<String>,
    pub base_branch: String,
}

/// Outcome of [`show`].
#[derive(Debug, Clone, Serialize)]
pub struct ShowOutcome {
    pub name: String,
    /// The dash's owner key ([P01]); the legacy branch ref for an id-less dash.
    pub id: Option<String>,
    pub description: Option<String>,
    pub branch: String,
    pub worktree: String,
    pub base_branch: String,
    pub status: String,
    pub rounds: Vec<RoundItem>,
    pub uncommitted_changes: Option<bool>,
}

/// One round (commit ahead of base) in the [`show`] outcome.
#[derive(Debug, Clone, Serialize)]
pub struct RoundItem {
    pub commit_hash: String,
    pub summary: String,
    pub started_at: String,
}

/// Outcome of [`commit`].
#[derive(Debug, Clone, Serialize)]
pub struct CommitOutcome {
    pub committed: bool,
    pub commit_hash: Option<String>,
}

/// How [`join`] integrates a dash into its base branch ([P14]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JoinStrategy {
    /// One squash commit on the base (default — preserves today's behaviour).
    #[default]
    Squash,
    /// A `--no-ff` merge commit, preserving the dash's individual rounds.
    Merge,
    /// Replay the dash's commits onto the base (fast-forward when possible,
    /// else cherry-pick the range) for a linear history.
    Rebase,
}

impl JoinStrategy {
    fn as_str(self) -> &'static str {
        match self {
            JoinStrategy::Squash => "squash",
            JoinStrategy::Merge => "merge",
            JoinStrategy::Rebase => "rebase",
        }
    }
}

/// Options for [`join`] ([P14]).
#[derive(Debug, Clone, Default)]
pub struct JoinOptions {
    /// Integration strategy (default squash).
    pub strategy: JoinStrategy,
    /// Custom commit message; overrides the maintained draft / description.
    pub message: Option<String>,
    /// Report conflicts in-memory via `git merge-tree`, touching nothing.
    pub preview: bool,
    /// Resume an interrupted join's teardown from the journal.
    pub continue_join: bool,
    /// Land a pre-built candidate commit from the resolution ladder ([P31])
    /// instead of integrating per `strategy`: fast-forward the base onto it
    /// (staleness-guarded), then run the normal journaled teardown.
    pub candidate: Option<String>,
    /// Which route asked for this landing — `cli` or `card`. Recorded in the
    /// dash-log's terminal note so a landing is attributable after the fact;
    /// `None` writes the bare note the log carried before routes were recorded.
    pub origin: Option<String>,
}

/// Outcome of [`join`].
#[derive(Debug, Clone, Serialize)]
pub struct JoinOutcome {
    pub name: String,
    pub base_branch: String,
    /// The strategy used (or previewed).
    pub strategy: String,
    /// The squash/merge/replay commit on the base — `None` for a preview or a
    /// conflict-aborted join.
    pub commit_hash: Option<String>,
    /// Conflicted paths — non-empty for a conflicting preview, or a real join
    /// that hit conflicts and cleanly aborted.
    pub conflicts: Vec<String>,
    /// Whether this was a `--preview` (nothing was mutated).
    pub previewed: bool,
    /// What would refuse this join, from [`join_preflight_in`] — populated on
    /// the preview path only. Additive: absent from the JSON when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<JoinBlocker>,
    /// The squash/merge message the join actually landed with — the maintained
    /// draft, the caller's override, or the candidate's own subject. Present
    /// only on a landed join, because it is the receipt's body and a receipt
    /// that paraphrased the message would be a different document from the
    /// commit. Additive: absent from the JSON when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// For each conflicted path, what the base did to it since the merge-base
    /// — the history that explains the conflict. Computed on the preview path
    /// only. Additive: absent from the JSON when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archaeology: Vec<ConflictHistory>,
    pub warnings: Vec<String>,
}

/// The base-side history of one conflicted path.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictHistory {
    /// The conflicted path, as `conflicts` spells it.
    pub path: String,
    /// The most recent base commits that touched it, newest first, capped.
    pub commits: Vec<ConflictCommit>,
    /// How many touched it in total — `commits.len()` unless the cap bit.
    pub total: u32,
}

/// One base commit behind a conflicted path.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictCommit {
    /// Abbreviated hash.
    pub sha: String,
    /// The commit's subject line.
    pub subject: String,
}

/// One reason a join would be refused, as reported by a `--preview`.
#[derive(Debug, Clone, Serialize)]
pub struct JoinBlocker {
    /// `off-base` | `base-dirt` | `stale-journal` | `empty`.
    pub kind: String,
    /// The human line — the same sentence the execute path returns as its `Err`.
    pub detail: String,
    /// The offending paths, for `base-dirt`; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

/// Outcome of [`release`].
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseOutcome {
    pub name: String,
    /// The plan handed back to the base checkout before teardown, when the
    /// dash's copy held bytes base did not. Additive: absent when there was
    /// nothing to restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_restored: Option<String>,
    /// The worktree's uncommitted work handed back to the base checkout before
    /// teardown ([P08]) — the inverse of `create --carry`, and not limited to
    /// what arrived that way.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_restored: Vec<String>,
    pub warnings: Vec<String>,
}

// --- git helpers -----------------------------------------------------------

/// Run a git command in `dir`, returning its raw output.
pub(crate) fn git_output(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git {}: {}", args.join(" "), e))
}

/// Run a git command in `dir`, returning trimmed stdout on success.
pub(crate) fn git_stdout(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_output(dir, args)?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read a single git config value, if present and non-empty.
pub(crate) fn config_get(repo: &Path, key: &str) -> Option<String> {
    let out = git_output(repo, &["config", "--get", key]).ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn branch_name(name: &str) -> String {
    format!("tugdash/{}", name)
}

/// The current worktree home: `<repo>/.tug/worktrees/<sanitized-name>` ([P13]).
fn new_worktree_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tug")
        .join("worktrees")
        .join(sanitize_branch_name(name))
}

/// The pre-migration worktree home: `<repo>/.tugtree/tugdash__<sanitized-name>`.
/// Still operated against for a dash that hasn't (or can't) migrate yet.
fn old_worktree_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tugtree")
        .join(format!("tugdash__{}", sanitize_branch_name(name)))
}

/// The effective worktree path for a dash: the new `.tug/worktrees/` home when
/// it exists (created there, or migrated), else the legacy `.tugtree/` path when
/// that still holds it, else the new home (the creation target). So every verb
/// operates on wherever the worktree actually is, migrated or not.
pub(crate) fn worktree_path(repo: &Path, name: &str) -> PathBuf {
    let new = new_worktree_path(repo, name);
    if new.exists() {
        return new;
    }
    let old = old_worktree_path(repo, name);
    if old.exists() {
        return old;
    }
    new
}

/// Migrate legacy `.tugtree/` worktrees to `.tug/worktrees/` ([P13], Risk table).
///
/// Runs at the top of every verb. For each `tugdash/*` branch whose worktree
/// still sits under `.tugtree/` (and isn't already at the new home),
/// `git worktree move`s it when it is SAFE — the worktree is clean and no live
/// instance's app is holding it (a `git worktree move` while an app runs from
/// the dir would strand the app's cwd). Otherwise it warns once and leaves the
/// worktree where it is; the effective `worktree_path` keeps operating on the
/// old location. Best-effort: any git failure is a warning, never fatal.
fn migrate_worktrees(repo: &Path, warnings: &mut Vec<String>) {
    let Ok(branches) = git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/tugdash/",
        ],
    ) else {
        return;
    };

    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches("tugdash/");
        let old = old_worktree_path(repo, name);
        let new = new_worktree_path(repo, name);
        if !old.exists() || new.exists() {
            continue;
        }

        // Gate 1: only a clean worktree migrates — uncommitted work stays put.
        let dirty = git_stdout(&old, &["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(true);
        if dirty {
            warnings.push(format!(
                "dash '{}': worktree has uncommitted changes; left at .tugtree (not migrated to .tug/worktrees)",
                name
            ));
            continue;
        }

        // Gate 2: no live instance app holding the dir (reap-slug identity math).
        if dash_instance_live(branch) {
            warnings.push(format!(
                "dash '{}': a live instance holds the worktree; left at .tugtree (not migrated)",
                name
            ));
            continue;
        }

        if let Some(parent) = new.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let moved = git_output(
            repo,
            &[
                "worktree",
                "move",
                &old.to_string_lossy(),
                &new.to_string_lossy(),
            ],
        );
        match moved {
            Ok(o) if !o.status.success() => warnings.push(format!(
                "dash '{}': git worktree move failed; left at .tugtree: {}",
                name,
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => warnings.push(format!(
                "dash '{}': git worktree move failed; left at .tugtree: {}",
                name, e
            )),
            _ => {}
        }
    }
}

/// Whether either the debug or release instance app for `branch` is live (a
/// `cc-<profile>-<slug>` tmux session), so migration doesn't move a worktree out
/// from under a running app. Mirrors `reap_dash_tmux`'s identity math, but
/// non-destructive.
fn dash_instance_live(branch: &str) -> bool {
    let slug = branch_slug(branch);
    ["debug", "release"]
        .iter()
        .any(|profile| tugcore::instance::instance_tmux_live(&format!("{profile}-{slug}")))
}

pub(crate) fn branch_exists(repo: &Path, branch: &str) -> bool {
    git_stdout(repo, &["branch", "--list", branch])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Canonical bundle-id branch slug — mirrors `scripts/branch-slug.sh`
/// (lowercase; every run of non-`[a-z0-9]` collapses to a single `-`;
/// trim leading/trailing `-`). This is the slug `assign-bundle-id.sh`
/// folds into the per-worktree instance ID, so it lets us reconstruct
/// the tmux identity a removed dash's app used. NOTE: distinct from
/// `sanitize_branch_name` (which names the worktree *directory* and maps
/// `/` → `__`).
fn branch_slug(branch: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in branch.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Tear down the tmux server/session a removed dash worktree's app left
/// behind. A dash worktree builds the cwd-derived `<profile>-<branch-slug>`
/// identity; its tugcast created a `cc-<id>` session on that instance's
/// private `tug-<token>` server (or, for pre-isolation builds, the shared
/// default server). The dash's profile isn't recorded, so reap both
/// debug and release identities via the shared instance reaper.
fn reap_dash_tmux(branch: &str) {
    let slug = branch_slug(branch);
    for profile in ["debug", "release"] {
        tugcore::instance::reap_instance_tmux(&format!("{profile}-{slug}"));
    }
}

/// Tear down a dash's worktree robustly, always leaving the directory gone.
///
/// A dash's live app/vite dev server keeps files open inside the worktree.
/// On a mounted filesystem, removing a file that a process still holds open
/// leaves a silly-rename placeholder, so the parent `rmdir` fails with
/// "Directory not empty" — and `git worktree remove` strands a half-removed
/// worktree on disk (the exact failure `dash join` used to hit). To avoid it:
///   1. reap the dash's tmux server/app *first*, so nothing holds files open;
///   2. `--force` so gitignored build artifacts never block git's removal;
///   3. fall back to a direct filesystem wipe when git bails, retrying a few
///      times because reaped processes release their handles asynchronously;
///   4. `git worktree prune` to clear git's now-stale administrative entry.
///
/// A warning is pushed only if the directory truly survives all of that.
fn remove_dash_worktree(repo: &Path, branch: &str, worktree: &Path, warnings: &mut Vec<String>) {
    const ATTEMPTS: u32 = 5;

    reap_dash_tmux(branch);

    if !worktree.exists() {
        return;
    }

    for attempt in 0..ATTEMPTS {
        let _ = git_output(
            repo,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        if worktree.exists() {
            let _ = std::fs::remove_dir_all(worktree);
        }
        if !worktree.exists() {
            break;
        }
        if attempt + 1 < ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    let _ = git_output(repo, &["worktree", "prune"]);

    if worktree.exists() {
        warnings.push(format!("Failed to remove worktree: {}", worktree.display()));
    }
}

/// Resolve a dash's base branch: git config first ([P03]), else detection.
pub(crate) fn dash_base(repo: &Path, name: &str) -> Result<String, String> {
    if let Some(base) = config_get(repo, &format!("branch.tugdash/{}.tugbase", name)) {
        return Ok(base);
    }
    detect_default_branch(repo).map_err(|e| e.to_string())
}

// --- dash identity ---------------------------------------------------------

/// A dash's creation id lives in its branch config, beside `tugbase`.
fn tugid_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugid", name)
}

/// Mint a fresh `tugid`: unix-millis plus a 6-hex-char nonce ([P01]). Millis
/// sort chronologically; the nonce keeps two mints in the same millisecond
/// apart without any coordination.
fn mint_tugid() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut nonce = [0u8; 3];
    rand::fill(&mut nonce);
    format!("{millis}-{:02x}{:02x}{:02x}", nonce[0], nonce[1], nonce[2])
}

/// A dash's **owner key** — the identity every ledger row keys by: draft rows'
/// `owner_id`, the sessions table's `dash_id`, and the snapshot entry's
/// `owner_id` ([P01]).
///
/// `tugdash/<name>#<tugid>` when the dash has a creation id, else the bare
/// branch ref `tugdash/<name>` — the legacy identity, byte-identical to the
/// keys every pre-id build wrote.
///
/// **Read this before any teardown.** `git branch -D` deletes the branch's
/// whole config section, `tugid` included, so a key resolved after a
/// `join_in`/`release_in` returns can only ever be the legacy form — and every
/// id-keyed row it should have swept becomes unnameable ([P05], Risk R02).
pub fn dash_owner_key(repo: &Path, name: &str) -> String {
    let branch = branch_name(name);
    match config_get(repo, &tugid_config_key(name)) {
        Some(id) => format!("{branch}#{id}"),
        None => branch,
    }
}

/// The owner key for a dash, minting its `tugid` when it has none ([P01]).
///
/// Only **write-path** verbs call this — `create`, `commit`, and the
/// `/api/dash` bind handler ([P02]). Read paths use [`dash_owner_key`], which
/// never mints: a read that wrote config would make every feed recompute a
/// side-effecting multi-process race, and two racing mints would fork a dash's
/// identity (Risk R01).
pub fn ensure_dash_id(repo: &Path, name: &str) -> Result<String, String> {
    let branch = branch_name(name);
    if let Some(id) = config_get(repo, &tugid_config_key(name)) {
        return Ok(format!("{branch}#{id}"));
    }
    let id = mint_tugid();
    let out = git_output(repo, &["config", &tugid_config_key(name), &id])?;
    if !out.status.success() {
        return Err(format!(
            "failed to record dash id for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(format!("{branch}#{id}"))
}

/// The legacy (pre-id) form of an owner key: everything before the `#`. A `#`
/// cannot appear in a branch ref, so the split is unambiguous, and a key that
/// is already legacy passes through unchanged.
pub fn legacy_owner_key(owner_key: &str) -> &str {
    match owner_key.split_once('#') {
        Some((branch, _)) => branch,
        None => owner_key,
    }
}

/// Run the project's `[tugtool.dash].post_create` hooks from the worktree root.
///
/// Each command runs via `sh -c`. The first non-zero exit aborts and returns
/// the failing command's stderr, so the caller can roll the worktree back.
fn run_post_create(repo: &Path, worktree: &Path) -> Result<(), String> {
    let config = Config::load_from_project(repo).map_err(|e| e.to_string())?;
    for cmd in &config.tugtool.dash.post_create {
        let out = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(worktree)
            .output()
            .map_err(|e| format!("failed to run post_create hook '{}': {}", cmd, e))?;
        if !out.status.success() {
            return Err(format!(
                "post_create hook failed: '{}'\n{}",
                cmd,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(())
}

// --- commands --------------------------------------------------------------

/// Create a dash: branch `tugdash/<name>` + worktree, base recorded in git
/// config, `[tugtool.dash].post_create` hook run. Idempotent — a fully-present
/// dash returns as-is (`created: false`) with no re-hydration.
///
/// With `plan`, the dash adopts that plan at birth: the file lands committed on
/// the dash branch and the base copy is cleaned, so there is one live copy from
/// second zero. Adoption runs on both exits — a re-run over an existing dash is
/// a repair, not an error.
///
/// With `carry`, the base checkout's uncommitted working set moves into the new
/// worktree ([P06]), uncommitted — the work is in progress by definition, and
/// the dash's first round commits it with intent. `carry` follows `plan`'s rule
/// on the idempotent revisit: a re-run transplants whatever the base holds now,
/// because a revisit is the repair path for both.
pub fn create(
    name: &str,
    description: Option<String>,
    plan: Option<&str>,
    carry: bool,
) -> Result<CreateOutcome, String> {
    validate_dash_name(name).map_err(|e| e.to_string())?;

    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    let base_branch = detect_default_branch(&repo_root).map_err(|e| e.to_string())?;
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    let have_branch = branch_exists(&repo_root, &branch);
    let have_worktree = worktree.exists();

    // Idempotent: a fully-present dash returns as-is, with no re-hydration.
    if have_branch && have_worktree {
        let description = description
            .or_else(|| config_get(&repo_root, &format!("branch.{}.description", branch)));
        let base = dash_base(&repo_root, name).unwrap_or(base_branch);
        // A revisit is a write-path touch, so an id-less dash from an older
        // build gains its id here ([P02]).
        let id = ensure_dash_id(&repo_root, name).ok();
        // A re-run with `--plan` over a live dash is the repair path: it runs
        // the same transplant `adopt-plan` does. `--carry` is the same kind of
        // revisit — it moves whatever the base holds now.
        let carried = if carry {
            let skip = plan.and_then(|p| resolve_plan_rel_anywhere(&repo_root, &worktree, p).ok());
            carry_working_set_in(&repo_root, &worktree, skip.as_deref())?
        } else {
            Vec::new()
        };
        let adopted = match plan {
            Some(path) => Some(adopt_plan_in(&repo_root, name, Some(path))?),
            None => None,
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
            plan: adopted,
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
            return Err(format!(
                "failed to delete stale branch {}: {}",
                branch,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }

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
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Enable rerere so recorded conflict resolutions replay on join ([P31]).
    crate::resolve::ensure_rerere_config(&repo_root);

    // Record the base branch and description in git config.
    let _ = git_output(
        &repo_root,
        &[
            "config",
            &format!("branch.{}.tugbase", branch),
            &base_branch,
        ],
    );
    if let Some(desc) = description.as_deref() {
        let _ = git_output(
            &repo_root,
            &["config", &format!("branch.{}.description", branch), desc],
        );
    }

    // Mint the creation id ([P01]) beside the rest of the branch metadata, so
    // it is torn down with the branch and needs no garbage collection.
    let id = ensure_dash_id(&repo_root, name).ok();

    // The birth record. A dash created bare — no plan, no rounds — would
    // otherwise have no line in the log at all and no date to report, while one
    // created with a plan gets its `Adopt plan` line for free; the gap was
    // arbitrary. Written only here, on the genuinely-created path, so the
    // idempotent revisit above cannot forge activity.
    //
    // The note is empty, and that is load-bearing: `read_dash_log` in
    // `tugcast`'s draft engine is a second parser of this file that keeps every
    // non-empty note as a per-round authoring instruction, and skips empty ones.
    // A note here would read as an instruction the user never gave.
    let _ = append_dash_log(&repo_root, name, "created", "");

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

    // Carry before adopting, so the transplant whose failure is safest to roll
    // back runs first: by its apply-all-before-clean-any ordering the base is
    // fully intact when it fails, and tearing the dash down costs nothing. The
    // adopted plan is skipped here — it has its own engine, which runs next.
    let carried = if carry {
        let skip = plan.and_then(|p| resolve_plan_rel_anywhere(&repo_root, &worktree, p).ok());
        match carry_working_set_in(&repo_root, &worktree, skip.as_deref()) {
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

    // Adopt the plan last, so a failure rolls the dash back the same way a
    // failed hook does — and by the transplant's own ordering the base copy is
    // still intact when it does.
    let adopted = match plan {
        Some(path) => match adopt_plan_in(&repo_root, name, Some(path)) {
            Ok(outcome) => Some(outcome),
            Err(e) => {
                // Unless the carry already moved work here. Then the worktree
                // holds the only copy of it, and tearing down to tidy up a
                // failed adoption would destroy the very work the gesture was
                // asked to rescue. The dash stays; the error says so.
                if !carried.is_empty() {
                    return Err(format!(
                        "{e}\nThe dash was kept: it holds {} carried path(s) that exist nowhere else.",
                        carried.len()
                    ));
                }
                let _ = git_output(
                    &repo_root,
                    &["worktree", "remove", "--force", &worktree.to_string_lossy()],
                );
                let _ = git_output(&repo_root, &["branch", "-D", &branch]);
                return Err(e);
            }
        },
        None => None,
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
        plan: adopted,
        base_dirt,
        off_base,
    })
}

/// What `create` reports about the base checkout it is leaving behind: the
/// uncommitted working set, and the branch the checkout sits on when that is
/// not the base branch ([P05]).
///
/// Taken at the end, so it describes the base as create actually leaves it —
/// a plan the dash adopted is gone from the base by then and is correctly not
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

/// List every active dash (each `tugdash/*` branch), with round count + worktree.
pub fn list() -> Result<Vec<DashListItem>, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());

    // Every tugdash/* branch is an active dash ([P02]).
    let branches = git_stdout(
        &repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/tugdash/",
        ],
    )?;

    let mut items = Vec::new();
    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches("tugdash/").to_string();
        let base = dash_base(&repo_root, &name)?;
        let round_count = git_stdout(
            &repo_root,
            &["rev-list", "--count", &format!("{}..{}", base, branch)],
        )
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
        let worktree = worktree_path(&repo_root, &name);
        let description = config_get(&repo_root, &format!("branch.{}.description", branch));

        items.push(DashListItem {
            id: Some(dash_owner_key(&repo_root, &name)),
            name,
            description,
            status: "active".to_string(),
            round_count,
            worktree: worktree
                .exists()
                .then(|| worktree.to_string_lossy().into_owned()),
            base_branch: base,
        });
    }

    Ok(items)
}

/// Show one dash's metadata + rounds (commits ahead of base) + worktree dirt.
pub fn show(name: &str) -> Result<ShowOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    let branch = branch_name(name);

    if !branch_exists(&repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }

    let base = dash_base(&repo_root, name)?;
    let description = config_get(&repo_root, &format!("branch.{}.description", branch));
    let worktree = worktree_path(&repo_root, name);

    // Commits ahead of base are this dash's rounds ([P02]).
    let log = git_stdout(
        &repo_root,
        &[
            "log",
            "--format=%h%x1f%s%x1f%cI",
            &format!("{}..{}", base, branch),
        ],
    )?;
    let rounds: Vec<RoundItem> = log
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut parts = line.split('\u{1f}');
            RoundItem {
                commit_hash: parts.next().unwrap_or("").to_string(),
                summary: parts.next().unwrap_or("").to_string(),
                started_at: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect();

    // Uncommitted changes in the worktree, if it is present.
    let uncommitted_changes = if worktree.exists() {
        git_stdout(&worktree, &["status", "--porcelain"])
            .ok()
            .map(|s| !s.is_empty())
    } else {
        None
    };

    Ok(ShowOutcome {
        name: name.to_string(),
        id: Some(dash_owner_key(&repo_root, name)),
        description,
        branch,
        worktree: worktree.to_string_lossy().into_owned(),
        base_branch: base,
        status: "active".to_string(),
        rounds,
        uncommitted_changes,
    })
}

/// One file in a dash's `base...branch` diff, as `git diff --name-status`
/// reports it. The caller maps this into its own file row.
#[derive(Debug, Clone, Serialize)]
pub struct DashDetailFile {
    /// Path relative to the repository root. A rename reports its destination.
    pub path: String,
    /// The name-status letter (`A`, `M`, `D`, `R`, …).
    pub status: String,
}

/// Everything a display needs about one dash, composed from git in one place.
///
/// This is the shared composition [`dash_detail_entries_in`] returns — the
/// single implementation the CLI and the Changes card's snapshot both read, so
/// the two can no longer drift on what a dash's base, worktree, or round count
/// is.
#[derive(Debug, Clone, Serialize)]
pub struct DashDetail {
    pub name: String,
    /// The owner key ([P01]) — the identity every ledger row keys by.
    pub owner_key: String,
    /// The git ref (`tugdash/<name>`). Anything that needs a *ref* reads this
    /// and never `owner_key` ([P09]).
    pub branch: String,
    pub base: String,
    pub rounds: u32,
    /// Worktree path relative to the **main** repository root — the root this
    /// composition normalizes to, which is not necessarily the root the caller
    /// asked from. For display by a human who is standing in the repository;
    /// never join it against a caller-held root.
    pub worktree_rel: String,
    /// The dash's worktree, absolute. Resolved here because this is where the
    /// main repository root is known; every consumer that needs a filesystem
    /// path reads this one and composes nothing.
    pub worktree_abs: String,
    pub worktree_dirty: bool,
    pub files: Vec<DashDetailFile>,
    /// Round commit subjects, newest first; empty when the dash has no rounds.
    pub round_subjects: Vec<String>,
    /// Derived stage ([P03]); `landing` requires the join journal, so callers
    /// that can also see a draft recompute with [`derive_stage`].
    pub stage: String,
    /// How far a stepped run has got, from the latest step declaration.
    pub step_current: Option<u32>,
    pub step_total: Option<u32>,
    /// What `step_current` *is* — the latest `step-start` declaration's title.
    pub step_title: Option<String>,
    /// The plan this dash is driving, relative to its *worktree* — the copy a
    /// run edits and whose ledger the step verbs rewrite. `None` when no run
    /// has recorded one.
    pub plan_path: Option<String>,
    /// Commits the base branch has gained past this dash's merge-base — 0 when
    /// the dash already contains the base tip.
    pub base_ahead: u32,
    /// Base-checkout dirty tracked paths that this dash also changes. The join
    /// preflight computes the same intersection at landing time; this says it
    /// the moment the overlap appears, which is usually hours earlier. A
    /// warning, never a trigger — uncommitted work on the base is the user's.
    pub base_overlap: Vec<String>,
    /// The note of the dash-log's most recent `replayed` line — the settled
    /// mark's text. `None` when this dash has never been replayed.
    pub last_replay: Option<String>,
    /// When this dash was last touched: the timestamp of the newest dash-log
    /// line for its current generation, ISO-8601 UTC. `None` for a dash created
    /// before creation wrote a birth record and never logged anything since.
    pub last_activity: Option<String>,
}

/// Parse `git diff --name-status` output. Rename and copy lines
/// (`R<score>\told\tnew`) report the destination path.
fn parse_name_status(output: &str) -> Vec<DashDetailFile> {
    let mut files = Vec::new();
    for line in output.lines() {
        let mut fields = line.split('\t');
        let Some(status) = fields.next() else {
            continue;
        };
        let Some(letter) = status.chars().next() else {
            continue;
        };
        let path = if letter == 'R' || letter == 'C' {
            fields.nth(1)
        } else {
            fields.next()
        };
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            files.push(DashDetailFile {
                path: path.to_owned(),
                status: status.to_owned(),
            });
        }
    }
    files
}

/// Every active dash in `repo_root`, with the per-dash detail a display needs.
///
/// The `_in` variant of [`list`] with detail: explicit repo root (the feed
/// composing a snapshot has one and is not cwd-relative), the full
/// `base...branch` file list, round subjects, and worktree dirt.
///
/// A **pure read path** — it resolves each dash's owner key with
/// [`dash_owner_key`] and never mints ([P02]). tugcast's `compose_snapshot`
/// calls this on every recompute, and a read that wrote git config would be a
/// side-effecting read and a multi-process race.
pub fn dash_detail_entries_in(repo_root: &Path) -> Vec<DashDetail> {
    // The same normalization the join verbs do: a card whose project is a
    // linked worktree must be told about the repository's dashes, keyed the
    // way every other reader keys them — the derived `landing` stage reads the
    // join journal out of the main root's state dir.
    let repo_root = &main_repo_root(repo_root);
    let Ok(branches) = git_stdout(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/tugdash/",
        ],
    ) else {
        return Vec::new();
    };

    // One read for the whole repository, hoisted above the per-dash loop: this
    // runs on every aggregate recompute and already spends several git
    // invocations per dash, and the base's dirty set is the same answer for all
    // of them.
    let base_dirt = dirty_tracked_paths(repo_root);

    let mut entries = Vec::new();
    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches("tugdash/");
        // `dash_base`'s detection fallback, deliberately, rather than the bare
        // `"main"` default the feed's duplicate used: a repo whose default
        // branch is not `main` was silently mis-based there.
        let Ok(base) = dash_base(repo_root, name) else {
            continue;
        };

        let rounds = git_stdout(
            repo_root,
            &["rev-list", "--count", &format!("{base}..{branch}")],
        )
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

        let worktree_abs = worktree_path(repo_root, name);
        let worktree_rel = worktree_abs
            .strip_prefix(repo_root)
            .unwrap_or(&worktree_abs)
            .to_string_lossy()
            .into_owned();
        let worktree_dirty = worktree_abs.exists()
            && git_stdout(&worktree_abs, &["status", "--porcelain"])
                .map(|s| !s.is_empty())
                .unwrap_or(false);

        let files = git_stdout(
            repo_root,
            &["diff", "--name-status", &format!("{base}...{branch}")],
        )
        .map(|out| parse_name_status(&out))
        .unwrap_or_default();

        // Round subjects, newest first — what the release discard preflight
        // lists ([P14]). Empty when the dash has no rounds.
        let round_subjects = if rounds > 0 {
            git_stdout(
                repo_root,
                &["log", "--format=%s", &format!("{base}..{branch}")],
            )
            .map(|out| {
                out.lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
        } else {
            Vec::new()
        };

        // How far the base has run ahead of this dash, and which of the base
        // checkout's uncommitted edits land on files the dash also changed —
        // the divergence a landing would otherwise only reveal at the join.
        let base_ahead = git_stdout(
            repo_root,
            &["rev-list", "--count", &format!("{branch}..{base}")],
        )
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
        let base_overlap: Vec<String> = base_dirt
            .iter()
            .filter(|p| files.iter().any(|f| &&f.path == p))
            .cloned()
            .collect();

        // One dash-log read per dash per recompute — the log is small,
        // append-only, and parsed line by line. No plan markdown is read here
        // ([P01]): the declarations are the record this path derives from.
        let declarations = read_declarations(repo_root, name);

        entries.push(DashDetail {
            owner_key: dash_owner_key(repo_root, name),
            name: name.to_owned(),
            branch: branch.to_owned(),
            stage: derive_stage(
                rounds as i64,
                worktree_dirty,
                false,
                read_join_journal(repo_root, name).is_some(),
                declarations.latest,
            )
            .to_owned(),
            step_current: declarations.step.map(|(current, _)| current),
            step_total: declarations.step.map(|(_, total)| total),
            step_title: declarations.step_title.clone(),
            plan_path: dash_plan_path(repo_root, name),
            base_ahead,
            base_overlap,
            last_replay: declarations.last_replay.clone(),
            last_activity: declarations.last_activity.clone(),
            base,
            rounds,
            worktree_rel,
            worktree_abs: worktree_abs.to_string_lossy().into_owned(),
            worktree_dirty,
            files,
            round_subjects,
        });
    }
    entries
}

/// One dash's lifecycle readout (Spec S05) — the machine-readable answer to
/// "where is this dash?".
#[derive(Debug, Clone, Serialize)]
pub struct DashStatus {
    pub name: String,
    /// The owner key ([P01]).
    pub id: String,
    pub branch: String,
    pub base_branch: String,
    /// Derived lifecycle stage ([P06]) — see [`derive_stage`].
    pub stage: String,
    pub rounds: i64,
    pub worktree: String,
    pub worktree_dirty: bool,
    /// Whether a maintained join draft is on file.
    pub draft: bool,
    /// The join journal's phase when an interrupted landing left one.
    pub join_journal_phase: Option<String>,
    /// Live sessions mated to this dash ([P08]); empty when unresolvable, when
    /// the binding column has not migrated in yet, or when every bound card
    /// has closed — an empty list is how *parked* reads.
    pub bound_sessions: Vec<String>,
    /// How far a stepped run has got, from the latest step declaration.
    pub step_current: Option<i64>,
    pub step_total: Option<i64>,
    /// What `step_current` *is* — the latest `step-start` declaration's title.
    pub step_title: Option<String>,
    /// The plan this dash is driving, relative to its worktree ([P08]).
    pub plan_path: Option<String>,
    /// When this dash was last touched — the newest dash-log line's timestamp
    /// for the current generation, ISO-8601 UTC.
    pub last_activity: Option<String>,
}

/// The stage a dash is in, from what git derives and what the dash declared.
///
/// Precedence is `landing > declared > draft-ready > working > created`
/// ([P03]): a landing in flight outranks everything; otherwise the latest
/// declaration wins, because the last thing a run said about itself is the
/// truest current answer; only an undeclared dash falls through to the derived
/// chain, where an authored draft outranks mere activity and any round or
/// worktree dirt outranks a freshly created dash.
///
/// Declarations outrank `draft-ready` deliberately: a planned run writes its
/// join draft when it stops for the user's vet, *before* the audit, so a draft
/// that outranked declarations would make `audited` undisplayable.
///
/// The stage stays a plain word — `step_current`/`step_total` travel in their
/// own fields and displays compose the `implementing (3/9)` parenthetical.
pub fn derive_stage(
    rounds: i64,
    worktree_dirty: bool,
    has_draft: bool,
    landing: bool,
    declared: Option<DashDeclaration>,
) -> &'static str {
    if landing {
        "landing"
    } else if let Some(declaration) = declared {
        match declaration {
            DashDeclaration::Step { .. } => "implementing",
            DashDeclaration::Built => "built",
            DashDeclaration::Audited => "audited",
        }
    } else if has_draft {
        "draft-ready"
    } else if rounds > 0 || worktree_dirty {
        "working"
    } else {
        "created"
    }
}

/// Live sessions bound to `owner_key`, read read-only from the per-instance
/// `sessions.db` ([P08], [Q02] — this instance's view only).
///
/// **Live sessions only**, under the same predicate the tugcast-side query
/// uses: bound-ness is defined over live sessions, so a row that outlived its
/// card is never reported and a dash whose cards have all closed reads as
/// parked. Best-effort throughout — no db, no table, no `dash_id` column (an
/// unmigrated ledger) all read as an empty list.
fn bound_sessions_for(owner_key: &str) -> Vec<String> {
    let Some(db) = sessions_db_file() else {
        return Vec::new();
    };
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id FROM sessions \
         WHERE dash_id = ?1 AND state = 'live' ORDER BY last_used_at DESC",
    ) else {
        return Vec::new();
    };
    stmt.query_map(rusqlite::params![owner_key], |row| row.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// One dash's lifecycle readout against `repo_root` (Spec S05).
///
/// A pure read path: it resolves the owner key without minting ([P02]).
pub fn status_in(repo_root: &Path, name: &str) -> Result<DashStatus, String> {
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }

    let base_branch = dash_base(repo_root, name)?;
    let id = dash_owner_key(repo_root, name);
    let rounds = git_stdout(
        repo_root,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", base_branch, branch),
        ],
    )
    .ok()
    .and_then(|s| s.parse::<i64>().ok())
    .unwrap_or(0);

    let worktree = worktree_path(repo_root, name);
    let worktree_dirty = worktree.exists()
        && git_stdout(&worktree, &["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);

    let draft = dash_draft_message(repo_root, &branch).is_some();
    let join_journal_phase =
        read_join_journal(repo_root, name).map(|journal| format!("{:?}", journal.phase));
    let bound_sessions = bound_sessions_for(&id);
    let declarations = read_declarations(repo_root, name);

    Ok(DashStatus {
        stage: derive_stage(
            rounds,
            worktree_dirty,
            draft,
            join_journal_phase.is_some(),
            declarations.latest,
        )
        .to_string(),
        name: name.to_string(),
        id,
        branch,
        base_branch,
        rounds,
        worktree: worktree.to_string_lossy().into_owned(),
        worktree_dirty,
        draft,
        join_journal_phase,
        bound_sessions,
        step_current: declarations.step.map(|(current, _)| current as i64),
        step_total: declarations.step.map(|(_, total)| total as i64),
        step_title: declarations.step_title.clone(),
        plan_path: dash_plan_path(repo_root, name),
        last_activity: declarations.last_activity.clone(),
    })
}

/// [`status_in`] against the cwd's repo — the CLI's entry point.
pub fn status(name: &str) -> Result<DashStatus, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    status_in(&repo_root, name)
}

// --- steps ([P04], [P08]) --------------------------------------------------

/// A dash's plan association lives in its branch config, beside `tugid` ([P08])
/// — so `git branch -D` at teardown takes it with the rest of the section.
fn plan_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugplan", name)
}

/// The worktree-relative path of the plan a dash is driving, when one was
/// recorded by a `dash step start --plan`.
pub fn dash_plan_path(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &plan_config_key(name))
}

/// Record the plan a dash is driving ([P08]).
pub fn set_dash_plan_path(repo: &Path, name: &str, rel: &str) -> Result<(), String> {
    let out = git_output(repo, &["config", &plan_config_key(name), rel])?;
    if !out.status.success() {
        return Err(format!(
            "failed to record plan path for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// What one `dash step` verb did (Spec S02).
#[derive(Debug, Clone, Serialize)]
pub struct StepOutcome {
    pub dash: String,
    /// The plan whose ledger moved, relative to the dash worktree.
    pub plan_path: String,
    pub step: u32,
    /// Ledger rows in the plan — the `N` of `i/N`.
    pub total: u32,
    /// The status the row now carries.
    pub status: String,
    /// The commit recorded in the row, on `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// Resolve which plan a step verb drives, as a path relative to the dash's
/// worktree ([P08]).
///
/// A `--plan` argument may be absolute or worktree-relative; either way the
/// resolved file must lie inside the worktree, because the plan a run edits is
/// the worktree copy. Nothing here consults the cwd: the skills' shell cwd is
/// not reliable, so the worktree is the only base.
fn resolve_plan_rel(worktree: &Path, plan: &str) -> Result<String, String> {
    let candidate = if Path::new(plan).is_absolute() {
        PathBuf::from(plan)
    } else {
        worktree.join(plan)
    };
    let resolved = std::fs::canonicalize(&candidate)
        .map_err(|_| format!("plan not found at {}", candidate.display()))?;
    let base = std::fs::canonicalize(worktree)
        .map_err(|e| format!("cannot resolve worktree {}: {e}", worktree.display()))?;
    let rel = resolved.strip_prefix(&base).map_err(|_| {
        format!(
            "plan {} is outside the dash worktree {}",
            resolved.display(),
            base.display()
        )
    })?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Write `contents` over `path` without ever leaving a half-written plan on
/// disk: a sibling temp file, then a rename.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "plan".to_string());
    let tmp = dir.join(format!(".{stem}.tugtmp"));
    std::fs::write(&tmp, contents).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot replace {}: {e}", path.display())
    })
}

/// Drive one ledger row and the dash-log in a single gesture ([P04]).
///
/// The edit is computed, verified, and only then written, so every refusal
/// leaves the plan byte-for-byte as it was. The log line is appended after the
/// write succeeds, which is what makes the log trustworthy for derivation
/// ([P01]) — a declaration exists only where the ledger moved.
fn step_in(
    repo_root: &Path,
    name: &str,
    step: u32,
    phase: StepPhase,
    plan: Option<&str>,
    commit: Option<&str>,
) -> Result<StepOutcome, String> {
    let branch = branch_name(name);
    let worktree = worktree_path(repo_root, name);
    if !branch_exists(repo_root, &branch) || !worktree.exists() {
        return Err(format!("Dash not found or not active: {}", name));
    }

    let (rel, record) = match plan {
        Some(path) => (resolve_plan_rel(&worktree, path)?, true),
        None => (
            dash_plan_path(repo_root, name).ok_or_else(|| {
                format!(
                    "dash '{name}' has no plan recorded; pass --plan <path> on the first step start"
                )
            })?,
            false,
        ),
    };

    // A second live copy of the plan on base is a divergence with exactly one
    // right answer, and the step verbs are where a run passes often enough to
    // catch it early. Refuse before anything — config included — is written.
    if base_plan_dirt(repo_root, &rel).is_dirt() {
        return Err(format!(
            "base copy of the plan has uncommitted changes at {rel}; run: tugutil dash adopt-plan {name}"
        ));
    }

    if record {
        set_dash_plan_path(repo_root, name, &rel)?;
    }

    let abs = worktree.join(&rel);
    let source = std::fs::read_to_string(&abs)
        .map_err(|e| format!("cannot read plan at {}: {e}", abs.display()))?;
    let doc =
        tugutil_core::plan::parse(&source).map_err(|_| format!("{rel} is not a plan document"))?;

    let anchor = format!("step-{step}");
    let total = doc.ledger_rows.len() as u32;
    let title = doc
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .map(|r| r.title.clone())
        .ok_or_else(|| format!("{rel}: no ledger row for #{anchor}"))?;

    let status = match phase {
        StepPhase::Start => "in progress",
        StepPhase::Done => "done",
    };
    let sha = match phase {
        StepPhase::Start => None,
        StepPhase::Done => Some(match commit {
            Some(sha) => sha.trim().to_string(),
            None => git_stdout(repo_root, &["rev-parse", "--short", &branch])?,
        }),
    };

    let edited = tugutil_core::plan::set_ledger_status(&source, &anchor, status, sha.as_deref())
        .map_err(|e| format!("{rel}: {e}"))?;
    write_atomic(&abs, &edited)?;

    let note_tail = match &sha {
        Some(sha) => sha.clone(),
        None => format!("Step {step}: {title}"),
    };
    append_step_declaration(repo_root, name, phase, step, total, &note_tail)
        .map_err(|e| e.to_string())?;

    Ok(StepOutcome {
        dash: name.to_string(),
        plan_path: rel,
        step,
        total,
        status: status.to_string(),
        commit: sha,
    })
}

/// Begin a step: the ledger row goes `in progress` and the log records it.
///
/// Idempotent on a row already `in progress` ([P04]), so an interrupted run
/// re-enters the step it was on without a hand-edit.
pub fn step_start(name: &str, step: u32, plan: Option<&str>) -> Result<StepOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    step_in(&repo_root, name, step, StepPhase::Start, plan, None)
}

/// Finish a step: the ledger row goes `done` and records the round's commit.
pub fn step_done(name: &str, step: u32, commit: Option<&str>) -> Result<StepOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    step_in(&repo_root, name, step, StepPhase::Done, None, commit)
}

// --- plan adoption ---------------------------------------------------------

/// What one adoption did — the receipt every plan movement prints.
#[derive(Debug, Clone, Serialize)]
pub struct AdoptOutcome {
    pub dash: String,
    /// The plan, relative to both roots (it means the same file in each).
    pub plan_path: String,
    /// `committed` | `cleaned` | `inherited`.
    pub action: String,
    /// The adoption commit, when one was needed.
    pub commit: Option<String>,
    /// What happened to the base copy: `restored` | `removed` | `untouched`.
    pub base_copy: String,
    /// Ledger rows whose progress could not be replayed, as `#anchor`.
    pub dropped_rows: Vec<String>,
    pub warnings: Vec<String>,
}

/// How the base checkout currently holds a plan path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BasePlanState {
    /// Present and matching HEAD.
    Clean,
    /// Tracked, with staged or unstaged changes against HEAD.
    TrackedDirty,
    /// Present but not tracked.
    Untracked,
    /// No file there.
    Absent,
}

impl BasePlanState {
    /// Whether this state is base *dirt* — a second live copy the verbs must
    /// transplant or refuse over. A clean tracked copy is ordinary branch
    /// divergence, which the join squash resolves like any other file.
    fn is_dirt(self) -> bool {
        matches!(self, BasePlanState::TrackedDirty | BasePlanState::Untracked)
    }
}

/// Classify how the repo root holds `rel`.
fn base_plan_dirt(repo_root: &Path, rel: &str) -> BasePlanState {
    if !repo_root.join(rel).exists() {
        return BasePlanState::Absent;
    }
    let untracked = git_stdout(
        repo_root,
        &["ls-files", "--others", "--exclude-standard", "--", rel],
    )
    .unwrap_or_default();
    if !untracked.trim().is_empty() {
        return BasePlanState::Untracked;
    }
    let dirty =
        git_stdout(repo_root, &["diff", "--name-only", "HEAD", "--", rel]).unwrap_or_default();
    if dirty.trim().is_empty() {
        BasePlanState::Clean
    } else {
        BasePlanState::TrackedDirty
    }
}

/// Resolve a plan path that may live in either root, returning it relative to
/// both (a repo-relative path names the same file in a linked worktree).
///
/// The worktree is tried first because it sits *inside* the repo root, so a
/// worktree file would otherwise strip to `.tug/worktrees/<name>/…`. The strict
/// [`resolve_plan_rel`] still governs `dash step`, where adoption has already
/// guaranteed the worktree copy exists.
fn resolve_plan_rel_anywhere(
    repo_root: &Path,
    worktree: &Path,
    plan: &str,
) -> Result<String, String> {
    let strip = |base: &Path, resolved: &Path| -> Option<String> {
        let base = std::fs::canonicalize(base).ok()?;
        let rel = resolved.strip_prefix(&base).ok()?;
        Some(rel.to_string_lossy().replace('\\', "/"))
    };

    let candidates: Vec<PathBuf> = if Path::new(plan).is_absolute() {
        vec![PathBuf::from(plan)]
    } else {
        vec![worktree.join(plan), repo_root.join(plan)]
    };

    for candidate in &candidates {
        let Ok(resolved) = std::fs::canonicalize(candidate) else {
            continue;
        };
        if let Some(rel) = strip(worktree, &resolved) {
            return Ok(rel);
        }
        if let Some(rel) = strip(repo_root, &resolved) {
            return Ok(rel);
        }
        return Err(format!(
            "plan {} is outside the repository {}",
            resolved.display(),
            repo_root.display()
        ));
    }

    Err(format!(
        "plan not found at {plan} in either the worktree or the repo root"
    ))
}

/// Replay the worktree copy's ledger progress onto the incoming base body.
///
/// Returns the body to write plus the rows whose progress could not travel.
/// A row is replayed only when its status actually differs from the incoming
/// body's — a document already carrying the progress needs no edit, and
/// `set_ledger_status` treats `done` as terminal, so asking it to re-apply a
/// `done` row would read as a refusal rather than a no-op.
fn replay_ledger_progress(base_body: &str, worktree_body: &str) -> (String, Vec<String>) {
    let Ok(worktree_doc) = tugutil_core::plan::parse(worktree_body) else {
        // Nothing readable to replay from; the base body travels as-is.
        return (base_body.to_string(), vec![]);
    };
    let progressed: Vec<_> = worktree_doc
        .ledger_rows
        .iter()
        .filter(|r| r.status != "pending")
        .collect();

    let Ok(base_doc) = tugutil_core::plan::parse(base_body) else {
        // An unparseable incoming body downgrades to a byte copy — loudly.
        return (
            base_body.to_string(),
            progressed
                .iter()
                .map(|r| format!("#{}", r.anchor))
                .collect(),
        );
    };

    let mut body = base_body.to_string();
    let mut dropped = Vec::new();
    for row in progressed {
        let incoming = base_doc.ledger_rows.iter().find(|r| r.anchor == row.anchor);
        match incoming {
            Some(existing) if existing.status == row.status && existing.commit == row.commit => {}
            Some(_) => {
                match tugutil_core::plan::set_ledger_status(
                    &body,
                    &row.anchor,
                    &row.status,
                    row.commit.as_deref(),
                ) {
                    Ok(next) => body = next,
                    Err(_) => dropped.push(format!("#{}", row.anchor)),
                }
            }
            None => dropped.push(format!("#{}", row.anchor)),
        }
    }
    (body, dropped)
}

/// Clean the base copy of an adopted plan — the last act of a transplant, run
/// only once the bytes are reachable from the dash branch (Risk R01).
///
/// A tracked path is restored with `git checkout HEAD --`, naming `HEAD`
/// explicitly: a bare `git checkout --` restores from the *index*, so a
/// **staged** plan edit would survive the cleanup and the path would still read
/// as dirty against HEAD — making the step refusal fire forever and adoption
/// non-idempotent.
fn clean_base_plan_copy(
    repo_root: &Path,
    rel: &str,
    state: BasePlanState,
) -> Result<&'static str, String> {
    match state {
        BasePlanState::TrackedDirty => {
            let out = git_output(repo_root, &["checkout", "HEAD", "--", rel])?;
            if !out.status.success() {
                return Err(format!(
                    "failed to restore the base copy of {rel}: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Ok("restored")
        }
        BasePlanState::Untracked => {
            std::fs::remove_file(repo_root.join(rel))
                .map_err(|e| format!("failed to remove the base copy of {rel}: {e}"))?;
            Ok("removed")
        }
        _ => Ok("untouched"),
    }
}

/// Move the base checkout's uncommitted working set into the fresh dash
/// worktree, leaving it there **uncommitted** ([P06]).
///
/// This is the "I was editing the base and half-way through realised this
/// should be a dash" gesture. The worktree was cut from the base tip, so the
/// content the dirt was made against is the content the worktree holds — the
/// transplant is a copy, never a patch application.
///
/// The ordering is the one `adopt_plan_in` established and is not negotiable:
/// **every path is applied to the worktree before any base copy is touched.**
/// A failure in the apply phase leaves the base entirely intact, which is what
/// makes tearing the dash down a safe response to it.
///
/// `skip` names paths some other transplant owns — the adopted plan, which has
/// its own engine and its own receipt.
///
/// Returns the entries it moved, in census order.
fn carry_working_set_in(
    repo_root: &Path,
    worktree: &Path,
    skip: Option<&str>,
) -> Result<Vec<BaseDirtPath>, String> {
    let unmerged = git_stdout(repo_root, &["ls-files", "-u", "--format=%(path)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    if !unmerged.is_empty() {
        return Err(format!(
            "cannot carry the base working set: unmerged paths on the base checkout ({}). \
             Finish or abort that merge first.",
            unmerged.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }

    let census: Vec<BaseDirtPath> = base_working_set_dirt(repo_root)
        .into_iter()
        .filter(|d| Some(d.path.as_str()) != skip)
        .collect();
    if census.is_empty() {
        return Ok(census);
    }

    // Apply everything first. A deleted path carries as a deletion — there is
    // no content to read, and the worktree does hold a copy to remove.
    for entry in &census {
        let target = worktree.join(&entry.path);
        if entry.deleted {
            if target.exists() {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("failed to carry the deletion of {}: {e}", entry.path))?;
            }
            continue;
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("failed to carry {}: {e}", entry.path))?;
        }
        std::fs::copy(repo_root.join(&entry.path), &target)
            .map_err(|e| format!("failed to carry {}: {e}", entry.path))?;
    }

    // Only now is the base safe to clean. `HEAD` is named explicitly so a
    // *staged* edit is cleaned too — a bare `git checkout --` restores from the
    // index and would leave the path still dirty against HEAD.
    for entry in &census {
        match entry.state.as_str() {
            "tracked-dirty" => {
                let out = git_output(repo_root, &["checkout", "HEAD", "--", &entry.path])?;
                if !out.status.success() {
                    return Err(format!(
                        "failed to restore the base copy of {}: {}",
                        entry.path,
                        String::from_utf8_lossy(&out.stderr).trim()
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
                    return Err(format!(
                        "failed to unstage the base copy of {}: {}",
                        entry.path,
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
            _ => {
                std::fs::remove_file(repo_root.join(&entry.path)).map_err(|e| {
                    format!("failed to remove the base copy of {}: {e}", entry.path)
                })?;
            }
        }
    }

    Ok(census)
}

/// Adopt a plan into a dash: the worktree copy becomes the only live one.
///
/// The engine reads the base copy, writes and commits it on the dash branch,
/// and only then cleans base — so no ordering exists in which the user's edits
/// are unreachable. When both copies exist and their bodies differ, the base
/// body wins and the worktree's ledger progress is replayed onto it, because
/// the base copy is where the user types and the worktree ledger is where the
/// step verbs write.
pub fn adopt_plan_in(
    repo_root: &Path,
    name: &str,
    plan: Option<&str>,
) -> Result<AdoptOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);
    if !branch_exists(&repo_root, &branch) || !worktree.exists() {
        return Err(format!("Dash not found or not active: {}", name));
    }

    let rel = match plan {
        Some(path) => resolve_plan_rel_anywhere(&repo_root, &worktree, path)?,
        None => dash_plan_path(&repo_root, name)
            .ok_or_else(|| format!("dash '{name}' has no plan recorded; pass --plan <path>"))?,
    };

    let base_abs = repo_root.join(&rel);
    let work_abs = worktree.join(&rel);
    let base_state = base_plan_dirt(&repo_root, &rel);
    let work_present = work_abs.exists();

    if base_state == BasePlanState::Absent && !work_present {
        return Err(format!(
            "plan not found at {rel} in either the worktree or the repo root"
        ));
    }

    let mut warnings = Vec::new();
    let mut dropped_rows = Vec::new();

    // What the worktree copy should hold once the transplant is done. `None`
    // means it already holds it.
    let incoming: Option<String> = if !work_present {
        // The bytes only exist on base — whether it is dirty or a clean copy
        // committed after the dash was cut.
        Some(read_plan_file(&base_abs)?)
    } else if base_state.is_dirt() {
        let base_body = read_plan_file(&base_abs)?;
        let work_body = read_plan_file(&work_abs)?;
        if base_body == work_body {
            None
        } else {
            let same_content = match (
                tugutil_core::plan::parse(&base_body),
                tugutil_core::plan::parse(&work_body),
            ) {
                (Ok(base_doc), Ok(work_doc)) => {
                    tugutil_core::plan::content_stamp(&base_doc, &base_body)
                        == tugutil_core::plan::content_stamp(&work_doc, &work_body)
                }
                _ => false,
            };
            if same_content {
                // Progress-only divergence: the worktree ledger is authoritative.
                None
            } else {
                if let Some(w) = warn_on_superseded_worktree_edits(&worktree, &rel, &work_body) {
                    warnings.push(w);
                }
                let (body, dropped) = replay_ledger_progress(&base_body, &work_body);
                dropped_rows = dropped;
                Some(body)
            }
        }
    } else {
        None
    };

    // Write, stage, commit — before any base cleanup (Risk R01).
    let mut commit_hash = None;
    if let Some(body) = incoming {
        if let Some(parent) = work_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        write_atomic(&work_abs, &body)?;

        let add = git_output(&worktree, &["add", "--", &rel])?;
        if !add.status.success() {
            return Err(format!(
                "git add of {rel} failed: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }
        // Surgical: only the plan is staged, so adoption is safe mid-round.
        let staged = git_output(&worktree, &["diff", "--cached", "--quiet", "--", &rel])?;
        if !staged.status.success() {
            let message = with_dash_trailers(
                &repo_root,
                name,
                &branch,
                &format!("tugdash({name}): adopt plan {rel}"),
            );
            let out = git_output(&worktree, &["commit", "-m", &message, "--", &rel])?;
            if !out.status.success() {
                return Err(format!(
                    "adoption commit failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            let sha = git_stdout(&worktree, &["rev-parse", "--short", "HEAD"])?;
            append_dash_log(&repo_root, name, &sha, &format!("Adopt plan {rel}"))
                .map_err(|e| e.to_string())?;
            commit_hash = Some(sha);
        }
    }

    let base_copy = clean_base_plan_copy(&repo_root, &rel, base_state)?;

    set_dash_plan_path(&repo_root, name, &rel)?;
    let _ = ensure_dash_id(&repo_root, name);

    let action = if commit_hash.is_some() {
        "committed"
    } else if base_copy == "untouched" {
        "inherited"
    } else {
        "cleaned"
    };

    Ok(AdoptOutcome {
        dash: name.to_string(),
        plan_path: rel,
        action: action.to_string(),
        commit: commit_hash,
        base_copy: base_copy.to_string(),
        dropped_rows,
        warnings,
    })
}

/// Adopt a plan into a dash, resolving the repo from the process cwd.
pub fn adopt_plan(name: &str, plan: Option<&str>) -> Result<AdoptOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    adopt_plan_in(&repo_root, name, plan)
}

/// `git show <spec>` with the bytes intact. The trimming [`git_stdout`] does is
/// right for a rev or a status line and wrong for file contents: a plan
/// restored without its trailing newline is not the document the user wrote.
fn git_show_raw(dir: &Path, spec: &str) -> Option<String> {
    let out = git_output(dir, &["show", spec]).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn read_plan_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read plan at {}: {e}", path.display()))
}

/// Warn when the worktree copy carries uncommitted *body* edits the incoming
/// base body is about to supersede (Risk R02). Ledger cells are replayed, so
/// they are not a loss; a body edit that never reached a commit is.
fn warn_on_superseded_worktree_edits(
    worktree: &Path,
    rel: &str,
    work_body: &str,
) -> Option<String> {
    let head_body = git_show_raw(worktree, &format!("HEAD:{rel}"))?;
    let head_doc = tugutil_core::plan::parse(&head_body).ok()?;
    let work_doc = tugutil_core::plan::parse(work_body).ok()?;
    let changed = tugutil_core::plan::content_stamp(&head_doc, &head_body)
        != tugutil_core::plan::content_stamp(&work_doc, work_body);
    changed.then(|| {
        "worktree copy had uncommitted body edits; superseded bytes are not in git".to_string()
    })
}

/// What a `dash mark` declared ([P09]).
#[derive(Debug, Clone, Serialize)]
pub struct MarkOutcome {
    pub dash: String,
    /// The stage now declared — also the log marker that recorded it.
    pub stage: String,
}

/// Declare a lifecycle stage git cannot see ([P09]).
///
/// The vocabulary is closed to `built` and `audited`, and the whole action is
/// one dash-log line: nothing else on disk changes, so a mark is safe from a
/// skill that is otherwise forbidden to write.
pub fn mark(name: &str, stage: MarkStage, note: Option<&str>) -> Result<MarkOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    if !branch_exists(&repo_root, &branch_name(name)) {
        return Err(format!("Dash not found: {}", name));
    }
    append_mark_declaration(&repo_root, name, stage, note.unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(MarkOutcome {
        dash: name.to_string(),
        stage: stage.marker().to_string(),
    })
}

/// Commit the dash worktree (if dirty) and append a dash-log line. `round_meta`
/// carries the verbatim instruction (git's one gap) + a richer summary; the CLI
/// reads it from stdin.
pub fn commit(
    name: &str,
    message: &str,
    round_meta: Option<DashRoundMeta>,
) -> Result<CommitOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    if !branch_exists(&repo_root, &branch) || !worktree.exists() {
        return Err(format!("Dash not found or not active: {}", name));
    }

    // A round is a write-path touch, so a dash created by an older build
    // backfills its creation id here ([P02]).
    let _ = ensure_dash_id(&repo_root, name);

    // Stage all changes.
    let stage = git_output(&worktree, &["add", "-A"])?;
    if !stage.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&stage.stderr).trim()
        ));
    }

    // Anything staged?
    let diff = git_output(&worktree, &["diff", "--cached", "--quiet"])?;
    let has_changes = !diff.status.success(); // exits 1 when there are changes

    let commit_hash = if has_changes {
        // `--message` is the conventional-commit subject; a longer `summary`
        // (if any) enriches the body. Byte-safe: no slicing on a char boundary.
        let summary = round_meta
            .as_ref()
            .and_then(|m| m.summary.as_deref())
            .unwrap_or("");
        let commit_message = if summary.is_empty() || summary == message {
            message.to_string()
        } else {
            format!("{}\n\n{}", message, summary)
        };
        // Machine-parseable trailers ([P08], Spec S02): `Tug-Session:` when the
        // committing session resolves + `Tug-Dash: <branch> onto <base>`.
        let commit_message = with_dash_trailers(&repo_root, name, &branch, &commit_message);

        let commit = git_output(&worktree, &["commit", "-m", &commit_message])?;
        if !commit.status.success() {
            return Err(format!(
                "git commit failed: {}",
                String::from_utf8_lossy(&commit.stderr).trim()
            ));
        }
        Some(git_stdout(&worktree, &["rev-parse", "--short", "HEAD"])?)
    } else {
        None
    };

    // Append a dash-log line ([P04]): the verbatim instruction is git's one gap.
    let instruction = round_meta
        .as_ref()
        .and_then(|m| m.instruction.as_deref())
        .unwrap_or("");
    let marker = commit_hash.as_deref().unwrap_or("-");
    append_dash_log(&repo_root, name, marker, instruction).map_err(|e| e.to_string())?;

    Ok(CommitOutcome {
        committed: has_changes,
        commit_hash,
    })
}

/// Teardown phase of a join, recorded in the join journal so a crash between
/// steps can resume via `--continue` ([P14]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum JoinPhase {
    /// The integrate commit landed on base; worktree + branch still present.
    Integrated,
    /// Worktree removed; branch still present.
    WorktreeRemoved,
    /// Branch deleted; only the dash-log line + journal-clear remain.
    BranchDeleted,
}

/// The resumable join journal ([P14]) — a small JSON file beside the dash-log.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JoinJournal {
    name: String,
    base_branch: String,
    strategy: String,
    commit_hash: String,
    phase: JoinPhase,
    /// The message the integrate committed with, carried so a `--continue`
    /// finishing the teardown can still report it. Defaulted rather than
    /// required: a journal written before this field existed must still read.
    #[serde(default)]
    message: Option<String>,
}

fn join_journal_path(repo: &Path, name: &str) -> PathBuf {
    project_state_dir(repo).join(format!("join-journal-{}.json", sanitize_branch_name(name)))
}

fn write_join_journal(repo: &Path, journal: &JoinJournal) -> Result<(), String> {
    let dir = project_state_dir(repo);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to write join journal: {}", e))?;
    let path = dir.join(format!(
        "join-journal-{}.json",
        sanitize_branch_name(&journal.name)
    ));
    let body =
        serde_json::to_string_pretty(journal).map_err(|e| format!("join journal encode: {}", e))?;
    std::fs::write(&path, body).map_err(|e| format!("failed to write join journal: {}", e))
}

fn read_join_journal(repo: &Path, name: &str) -> Option<JoinJournal> {
    let txt = std::fs::read_to_string(join_journal_path(repo, name)).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Whether a join of `name` is in flight — the journal check, without exposing
/// the journal's shape.
pub fn join_in_flight(repo: &Path, name: &str) -> bool {
    read_join_journal(repo, name).is_some()
}

fn clear_join_journal(repo: &Path, name: &str) {
    let _ = std::fs::remove_file(join_journal_path(repo, name));
}

/// Whether `git` here supports `git merge-tree --write-tree` (git ≥ 2.38).
pub(crate) fn git_supports_merge_tree(repo: &Path) -> bool {
    let out = git_stdout(repo, &["--version"]).unwrap_or_default();
    let ver = out.split_whitespace().nth(2).unwrap_or("");
    let mut parts = ver.split('.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    major > 2 || (major == 2 && minor >= 38)
}

/// The tracked paths with uncommitted changes in `dir` (staged or unstaged vs
/// HEAD) as plain path lines — the intersection-preflight input. `git diff
/// --name-only HEAD` avoids porcelain's status-prefix parsing and never lists
/// untracked files (which can't overlap the base's tracked dirt anyway).
fn dirty_tracked_paths(dir: &Path) -> Vec<String> {
    git_stdout(dir, &["diff", "--name-only", "HEAD"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Everything `dir` holds uncommitted: tracked paths differing from HEAD
/// (staged or unstaged, deletions included) and untracked files git would not
/// ignore.
///
/// `--exclude-standard` honors `.gitignore`, which is what keeps the dash
/// worktrees under `.tug/` out of the untracked half — a hand-rolled path
/// exclusion here would be dead code in any repository that ignores its own
/// worktree home, and wrong in one that does not.
fn base_working_set_dirt(dir: &Path) -> Vec<BaseDirtPath> {
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
        git_stdout(dir, &["ls-files", "--others", "--exclude-standard"])
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|path| BaseDirtPath {
                path: path.to_string(),
                state: "untracked".to_string(),
                deleted: false,
                carried: false,
            }),
    );
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The conflicted (unmerged) paths after a failed merge/cherry-pick.
fn conflicted_paths(repo: &Path) -> Vec<String> {
    git_stdout(repo, &["diff", "--name-only", "--diff-filter=U"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default()
}

/// In-memory conflict preview via `git merge-tree --write-tree` (git ≥ 2.38):
/// returns the conflicted paths without touching any worktree, index, or ref.
/// How many base commits a conflicted path shows before the face elides.
const ARCHAEOLOGY_CAP: usize = 5;

/// What the base did to each conflicted path since the two sides parted.
///
/// A conflict names a file and stops; the question it raises is what the base
/// did to that file while the dash was away, and that answer is one `git log`
/// per path. Capped, and computed only on the preview path, so the cost is
/// bounded by the number of conflicts rather than by the size of the divergence
/// (R02).
///
/// Any git failure yields no history rather than an error: archaeology is
/// context for a conflict, and losing it must never cost the caller the
/// conflict report itself.
fn conflict_archaeology(
    repo: &Path,
    base: &str,
    branch: &str,
    conflicts: &[String],
) -> Vec<ConflictHistory> {
    if conflicts.is_empty() {
        return Vec::new();
    }
    let Ok(merge_base) = git_stdout(repo, &["merge-base", base, branch]) else {
        return Vec::new();
    };
    let range = format!("{merge_base}..{base}");
    let mut out = Vec::new();
    for path in conflicts {
        let Ok(log) = git_stdout(
            repo,
            &["log", "--format=%h%x00%s", "--no-color", &range, "--", path],
        ) else {
            continue;
        };
        let mut commits = Vec::new();
        let mut total = 0u32;
        for line in log.lines().filter(|l| !l.is_empty()) {
            total += 1;
            if commits.len() < ARCHAEOLOGY_CAP {
                let (sha, subject) = line.split_once('\0').unwrap_or((line, ""));
                commits.push(ConflictCommit {
                    sha: sha.to_string(),
                    subject: subject.to_string(),
                });
            }
        }
        if total > 0 {
            out.push(ConflictHistory {
                path: path.clone(),
                commits,
                total,
            });
        }
    }
    out
}

fn merge_tree_conflicts(repo: &Path, base: &str, branch: &str) -> Result<Vec<String>, String> {
    let out = git_output(
        repo,
        &["merge-tree", "--write-tree", "--name-only", base, branch],
    )?;
    if out.status.success() {
        return Ok(vec![]); // clean merge
    }
    // Exit 1 ⇒ conflicts. Output: the toplevel tree OID on line 1, then the
    // conflicted file names, a blank line, then informational messages.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    let _tree_oid = lines.next();
    let mut conflicts = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        conflicts.push(line.trim().to_string());
    }
    Ok(conflicts)
}

/// The dash's maintained draft ([P23], Spec S09) — the default join message
/// when the caller supplies none. Read-only from `sessions.db`; any absence
/// (no db, no table, no row) falls through to `None`.
/// Resolve the `sessions.db` path — the running instance's, else the
/// platform default. Read-only callers only.
fn sessions_db_file() -> Option<std::path::PathBuf> {
    tugcore::instance::resolve_sessions_db_path()
}

/// The committing session's identity for the commit trailers: the human
/// citation and the machine id ([P10], Spec S03).
///
/// `None` when it can't be resolved — no `TUG_SESSION_ID` env, no
/// `sessions.db`, or no row for that id. `tugutil dash commit` runs inside a
/// Claude session where tugcast exports `TUG_SESSION_ID`; the callsign is read
/// read-only from `sessions.db` (the `dash_draft_message` pattern). Any
/// absence omits both trailers silently — a commit never fails on trailer
/// resolution.
///
/// The citation grammar lives in `tugchanges_core::session_citation`, shared
/// with the deck-commit lane so the two can never drift.
pub(crate) fn session_citation() -> Option<(String, String)> {
    let session_id = std::env::var("TUG_SESSION_ID")
        .ok()
        .filter(|s| !s.is_empty())?;
    let db = sessions_db_file()?;
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    // No row → `query_row` errors → `.ok()?` omits the trailers.
    let tag: Option<String> = conn
        .query_row(
            "SELECT tag FROM sessions WHERE session_id = ?1",
            rusqlite::params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()?;
    let citation = tugchanges_core::session_citation(tag.as_deref(), &session_id);
    Some((citation, session_id))
}

/// Append the session trailers (when resolvable) + `Tug-Dash: <branch> onto
/// <base>` to a dash round-commit or join/squash message ([P08]/[P10], Spec
/// S02/S03). `base` comes from the dash's recorded base branch — the same
/// source `show()` / join use. Idempotent via `append_trailers`, so a draft
/// that already carries a trailer is never duplicated.
///
/// The session travels as a **pair**: `Tug-Session` is the human citation and
/// `Tug-Session-Id` the full uuid a reader joins against the ledger. Neither
/// is displayed as body ink — tugcast parses both into typed fields and strips
/// the lines.
fn with_dash_trailers(repo: &Path, name: &str, branch: &str, message: &str) -> String {
    let dash_value = match dash_base(repo, name) {
        Ok(base) if !base.is_empty() => format!("{branch} onto {base}"),
        _ => branch.to_string(),
    };
    let session = session_citation();
    let mut trailers: Vec<(&str, &str)> = Vec::new();
    if let Some((citation, id)) = session.as_ref() {
        trailers.push(("Tug-Session", citation.as_str()));
        trailers.push(("Tug-Session-Id", id.as_str()));
    }
    trailers.push(("Tug-Dash", dash_value.as_str()));
    tugchanges_core::append_trailers(message, &trailers)
}

/// The one sanctioned shape of a dash draft row's identity: the id-qualified
/// owner key crossed with the dash's **base repository root** as the project.
///
/// Every surface that reads or writes a dash draft obtains this pair from
/// [`dash_draft_key`] rather than assembling it inline. That is the whole point
/// of the type: each probe axis this territory carries — id key vs bare branch
/// ref, canonical vs raw spelling, base root vs worktree — exists because some
/// surface built a key by hand and drifted from the others. A key that only
/// ever comes from one resolver cannot acquire a seventh axis.
///
/// `legacy_owner_id` is the bare branch ref, present only when the dash has a
/// `tugid` (so the two actually differ) — a read-side fallback for rows written
/// before the id-qualified key existed.
///
/// Spellings are not this type's business. It answers *which directory and
/// which owner*; reconciling how a directory is spelled remains the server's,
/// through the [L29] gateway.
#[derive(Debug, Clone)]
pub struct DashDraftKey {
    pub owner_id: String,
    pub legacy_owner_id: Option<String>,
    pub project: PathBuf,
}

/// Resolve the canonical draft key for `name` in `repo_root`, which must be the
/// dash's **base repository root** — never a linked worktree. A read path, so
/// it resolves the owner key without minting a `tugid` ([P02]).
pub fn dash_draft_key(repo_root: &Path, name: &str) -> DashDraftKey {
    let branch = branch_name(name);
    let owner_id = dash_owner_key(repo_root, name);
    let legacy_owner_id = (owner_id != branch).then_some(branch);
    DashDraftKey {
        owner_id,
        legacy_owner_id,
        project: repo_root.to_path_buf(),
    }
}

/// A directory's spellings, canonical first, raw appended when it differs —
/// the Spec S05 contract, which stores `project_dir` canonical but cannot
/// promise every historical row was written through a canonicalizing writer.
fn project_spellings(dir: &Path) -> Vec<String> {
    let raw = dir.to_string_lossy().into_owned();
    let canonical = std::fs::canonicalize(dir)
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned();
    if canonical == raw {
        vec![canonical]
    } else {
        vec![canonical, raw]
    }
}

/// The maintained join draft for a dash, read read-only from the
/// machine-global changes ledger (`tugcore::instance::changes_db_path()`,
/// `TUG_CHANGES_DB` overridable) — drafts are machine-global like the working
/// tree they describe.
///
/// The primary probe is [`dash_draft_key`]'s pair. Everything after it is a
/// **migration bridge**, not a reconciliation layer, and each rung is a row
/// shape some earlier writer produced:
///
/// - the bare branch ref as owner, for rows predating the `tugid` key;
/// - the raw spelling of a project directory, for rows a non-canonicalizing
///   writer stored;
/// - the dash **worktree** as project, for rows written by a `tugutil draft
///   set` that ran from inside the worktree and keyed by its cwd — the defect
///   this contract exists to close.
///
/// Base-root rows are probed before worktree rows so a current row always beats
/// a legacy one. The bridge decays: every authored write supersedes the legacy
/// rows for its dash, and the axes come out once no pre-fix dash rows remain in
/// the machine ledger.
///
/// Note that `worktree_path` probes the filesystem (the `.tug/worktrees/` home,
/// then the legacy `.tugtree/` one, else the new form), so for a **released**
/// dash it answers the default spelling rather than where the worktree actually
/// stood. That is acceptable for a best-effort legacy probe, and is said here so
/// it is not later read as a bug.
pub(crate) fn dash_draft_message(repo: &Path, branch: &str) -> Option<String> {
    let db = tugcore::instance::changes_db_path();
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let read = |owner_id: &str, project: &str| -> Option<String> {
        conn.query_row(
            "SELECT message FROM changeset_drafts \
             WHERE owner_kind = 'dash' AND owner_id = ?1 AND project_dir = ?2",
            rusqlite::params![owner_id, project],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|m| !m.trim().is_empty())
    };

    let name = branch.trim_start_matches("tugdash/");
    let key = dash_draft_key(repo, name);
    let mut owners = vec![key.owner_id.clone()];
    owners.extend(key.legacy_owner_id.clone());

    let base = project_spellings(&key.project);
    let worktree: Vec<String> = project_spellings(&worktree_path(repo, name))
        .into_iter()
        .filter(|s| !base.contains(s))
        .collect();

    [base, worktree].into_iter().find_map(|group| {
        owners.iter().find_map(|owner| {
            group
                .iter()
                .find_map(|project| read(owner.as_str(), project))
        })
    })
}

/// The scoped integrate/join commit message: explicit override → maintained
/// dash draft ([P23]) → the dash description → a bare fallback, always wrapped
/// as `tugdash(<name>): …`. Shared by the strategy integrate and the resolution
/// ladder's candidate commit so both speak the same voice.
///
/// Every body source may legitimately already open with a dash scope — a draft
/// authored in the conventional voice, a description written by hand, an
/// override composed from a previous message. So the wrap is idempotent: **any**
/// leading `tugdash(…): ` is stripped before the subject is composed, whatever
/// name it carries.
///
/// Not only this dash's own name. A foreign scope used to pass through, on the
/// reasoning that it was content rather than an accident of composition — and
/// it produced `tugdash(close-backend): tugdash(backend): …`, which is not a
/// good subject whoever authored it. The composing side owns the scope; a body
/// that arrives wearing one is describing the same work, not naming a second
/// subject. Any other conventional prefix (`fix(x): `, `feat: `) still passes
/// through untouched — only the spelling this function itself emits is
/// absorbed.
///
/// The three skills that author join drafts are told to write a bare subject,
/// so both ends are closed: nothing produces a scope here, and a hand-typed one
/// cannot double.
pub(crate) fn integrate_message(
    repo: &Path,
    name: &str,
    branch: &str,
    override_msg: Option<String>,
) -> String {
    let description = config_get(repo, &format!("branch.{}.description", branch));
    let body = override_msg
        .or_else(|| dash_draft_message(repo, branch))
        .or(description)
        .unwrap_or_else(|| "Dash work".to_string());
    let body = strip_dash_scope(&body);
    // Subject stays `tugdash(<name>): …`; the trailers ride the body ([P08]).
    with_dash_trailers(repo, name, branch, &format!("tugdash({}): {}", name, body))
}

/// Strip one leading `tugdash(<anything>): `, or return the body unchanged.
///
/// Matched by hand rather than by pattern so a body whose text merely *contains*
/// `tugdash(` later on is untouched: the opener has to be at position 0, and the
/// closing paren is the first one after it.
fn strip_dash_scope(body: &str) -> &str {
    let Some(rest) = body.strip_prefix("tugdash(") else {
        return body;
    };
    let Some(close) = rest.find(')') else {
        return body;
    };
    rest[close + 1..].strip_prefix(": ").unwrap_or(body)
}

/// Auto-commit any outstanding changes in the dash worktree — FATAL on error
/// ([P14]). A no-op when the worktree is absent or clean. Shared by `join_in`
/// (before integrating) and the resolution ladder (before computing a candidate
/// against the branch tip) so the tip always reflects the dash's real state.
pub(crate) fn commit_worktree_dirt(worktree: &Path) -> Result<(), String> {
    if !worktree.exists() {
        return Ok(());
    }
    let dash_status = git_stdout(worktree, &["status", "--porcelain"])?;
    if dash_status.is_empty() {
        return Ok(());
    }
    let add = git_output(worktree, &["add", "-A"])?;
    if !add.status.success() {
        return Err(format!(
            "join: git add in the dash worktree failed: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }
    let c = git_output(
        worktree,
        &["commit", "-m", "join: commit outstanding changes"],
    )?;
    if !c.status.success() {
        return Err(format!(
            "join: auto-commit in the dash worktree failed: {}",
            String::from_utf8_lossy(&c.stderr).trim()
        ));
    }
    Ok(())
}

fn stale_journal_detail(name: &str) -> String {
    format!(
        "A previous join of dash '{}' is incomplete. Resume it with: tugutil dash join {} --continue",
        name, name
    )
}

fn off_base_detail(current_branch: &str, base_branch: &str) -> String {
    format!(
        "Cannot join: repo root worktree is on branch '{}' but dash targets '{}'. Check out '{}' first.",
        current_branch, base_branch, base_branch
    )
}

/// The remedy sentence for a blocked join that turns out to be jailed by the
/// dash's *own* plan — the one case where "commit or stash it" is the wrong
/// advice, because committing the stale base copy enshrines a fork and
/// stashing only hides it.
fn plan_remedy_sentence(paths: &[String], plan: Option<&str>, name: &str) -> Option<String> {
    let rel = plan?;
    paths.iter().any(|p| p == rel).then(|| {
        format!(" This includes the dash's own plan ({rel}) — run: tugutil dash adopt-plan {name}.")
    })
}

fn base_dirt_detail(paths: &[String], plan: Option<&str>, name: &str) -> String {
    let remedy = plan_remedy_sentence(paths, plan, name).unwrap_or_default();
    format!(
        "Cannot join: the base worktree has uncommitted changes to files this dash also changed ({}).{} Commit or stash them first.",
        paths.join(", "),
        remedy
    )
}

/// Untracked base files the integration would have to write over. `git merge
/// --squash` refuses these outright, so without this they read as a clean
/// preview followed by a failing join.
fn untracked_overwrite_detail(paths: &[String], plan: Option<&str>, name: &str) -> String {
    let remedy = plan_remedy_sentence(paths, plan, name).unwrap_or_default();
    format!(
        "Cannot join: untracked files at the repo root would be overwritten by this dash ({}).{} Move them aside first.",
        paths.join(", "),
        remedy
    )
}

fn empty_detail(name: &str, base_branch: &str) -> String {
    format!(
        "Nothing to join: dash '{}' has no commits past '{}'. Release it to discard.",
        name, base_branch
    )
}

/// The base paths that would block a join, split by why they block.
#[derive(Debug, Clone, Default)]
struct BlockingBasePaths {
    /// Tracked paths with uncommitted changes.
    tracked: Vec<String>,
    /// Untracked paths the integration would have to write over.
    untracked: Vec<String>,
}

impl BlockingBasePaths {
    fn is_empty(&self) -> bool {
        self.tracked.is_empty() && self.untracked.is_empty()
    }
}

/// The untracked paths at `dir`, as plain path lines.
fn untracked_paths(dir: &Path) -> Vec<String> {
    git_stdout(dir, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The base state that would block a join of `branch`: the base's dirty tracked
/// paths and its untracked paths, each intersected with the dash's changed set
/// (`base...branch` ∪ the dash worktree's own dirt). Disjoint base dirt is fine
/// — the integration only writes the dash's files.
fn blocking_base_dirt(
    repo_root: &Path,
    worktree: &Path,
    base_branch: &str,
    branch: &str,
) -> BlockingBasePaths {
    let base_dirt = dirty_tracked_paths(repo_root);
    let base_untracked = untracked_paths(repo_root);
    if base_dirt.is_empty() && base_untracked.is_empty() {
        return BlockingBasePaths::default();
    }
    let mut dash_changed: Vec<String> = git_stdout(
        repo_root,
        &[
            "diff",
            "--name-only",
            &format!("{}...{}", base_branch, branch),
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty())
    .collect();
    if worktree.exists() {
        dash_changed.extend(dirty_tracked_paths(worktree));
    }
    BlockingBasePaths {
        tracked: base_dirt
            .into_iter()
            .filter(|p| dash_changed.contains(p))
            .collect(),
        untracked: base_untracked
            .into_iter()
            .filter(|p| dash_changed.contains(p))
            .collect(),
    }
}

/// The repository root a dash operation works against.
///
/// A dash's branch, its worktree, and its join journal all live in the main
/// repository, so a caller that names a *linked worktree* means the same repo —
/// and must be answered about the same one. The CLI already resolves this way
/// (`join` → `find_repo_root`); without this, tugcast serving a card whose
/// project is itself a worktree would read every dash as `off-base` against
/// that worktree's own branch while `tugutil dash join` beside it reports a
/// clean bill. Idempotent: a main root resolves to itself.
pub(crate) fn main_repo_root(start: &Path) -> PathBuf {
    tugutil_core::find_repo_root_from(start).unwrap_or_else(|_| start.to_path_buf())
}

/// What would refuse a join of `name` right now ([P02]) — the preflight the
/// execute path checks inline, reported rather than returned as an `Err` so a
/// `--preview` can show every blocker at once and name the act that clears it.
///
/// The cwd guard is deliberately not here ([R02]): it reads the process cwd,
/// which is the server's when the call comes from tugcast.
pub fn join_preflight_in(repo_root: &Path, name: &str) -> Result<Vec<JoinBlocker>, String> {
    let repo_root = &main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    let base_branch = dash_base(repo_root, name)?;
    let worktree = worktree_path(repo_root, name);
    let mut blockers = Vec::new();

    if read_join_journal(repo_root, name).is_some() {
        blockers.push(JoinBlocker {
            kind: "stale-journal".to_string(),
            detail: stale_journal_detail(name),
            paths: vec![],
        });
    }

    let current_branch = git_stdout(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch != base_branch {
        blockers.push(JoinBlocker {
            kind: "off-base".to_string(),
            detail: off_base_detail(&current_branch, &base_branch),
            paths: vec![],
        });
    }

    let intersect = blocking_base_dirt(repo_root, &worktree, &base_branch, &branch);
    let plan_rel = dash_plan_path(repo_root, name);
    if !intersect.tracked.is_empty() {
        blockers.push(JoinBlocker {
            kind: "base-dirt".to_string(),
            detail: base_dirt_detail(&intersect.tracked, plan_rel.as_deref(), name),
            paths: intersect.tracked,
        });
    }
    if !intersect.untracked.is_empty() {
        blockers.push(JoinBlocker {
            kind: "base-dirt".to_string(),
            detail: untracked_overwrite_detail(&intersect.untracked, plan_rel.as_deref(), name),
            paths: intersect.untracked,
        });
    }

    // Empty is a *finding* on the preview path, not a refusal: the card's answer
    // to it is the release affordance. The execute path auto-commits worktree
    // dirt before testing `ahead`, so dirt makes a dash non-empty here too.
    let ahead = git_stdout(
        repo_root,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", base_branch, branch),
        ],
    )
    .ok()
    .and_then(|s| s.trim().parse::<i64>().ok())
    .unwrap_or(0);
    let worktree_dirty = worktree.exists() && !dirty_tracked_paths(&worktree).is_empty();
    if ahead == 0 && !worktree_dirty {
        blockers.push(JoinBlocker {
            kind: "empty".to_string(),
            detail: empty_detail(name, &base_branch),
            paths: vec![],
        });
    }

    Ok(blockers)
}

/// Join a dash into its base branch ([P14]): `--strategy squash|merge|rebase`,
/// a `--preview` (in-memory `git merge-tree`, nothing touched), an
/// intersection-aware preflight (base dirt blocks only when it overlaps the
/// dash's changed set), a clean abort on conflict with the structured conflict
/// list, and a journaled teardown resumable via `--continue`. The default
/// squash/merge message is the maintained dash draft, else the description.
pub fn join(name: &str, opts: JoinOptions) -> Result<JoinOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    join_in(&repo_root, name, opts)
}

/// Like [`join`], but against an explicit repo root instead of discovering it
/// from the process cwd — for callers such as tugcast that serve many projects
/// and must never depend on `current_dir`.
pub fn join_in(repo_root: &Path, name: &str, opts: JoinOptions) -> Result<JoinOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    migrate_worktrees(&repo_root, &mut warnings);
    // Pre-feature dashes get rerere enabled here so a recorded resolution
    // replays on this and future joins ([P31]).
    crate::resolve::ensure_rerere_config(&repo_root);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    if !branch_exists(&repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    let base_branch = dash_base(&repo_root, name)?;

    // --continue: resume an interrupted teardown from the journal.
    if opts.continue_join {
        let journal = read_join_journal(&repo_root, name)
            .ok_or_else(|| format!("No interrupted join to continue for dash '{}'.", name))?;
        return finish_join_teardown(
            &repo_root,
            name,
            &branch,
            &worktree,
            opts.origin.as_deref(),
            journal,
            warnings,
        );
    }

    // --preview: report conflicts and blockers in memory; nothing is mutated.
    // This sits above the stale-journal guard because a preview of a journalled
    // dash reports `stale-journal` as a blocker rather than refusing — the
    // execute path below is still what refuses.
    if opts.preview {
        if !git_supports_merge_tree(&repo_root) {
            return Err(
                "tugutil dash join --preview requires git >= 2.38 (git merge-tree --write-tree)."
                    .to_string(),
            );
        }
        let blockers = join_preflight_in(&repo_root, name)?;
        let conflicts = merge_tree_conflicts(&repo_root, &base_branch, &branch)?;
        let archaeology = conflict_archaeology(&repo_root, &base_branch, &branch, &conflicts);
        return Ok(JoinOutcome {
            name: name.to_string(),
            base_branch,
            strategy: opts.strategy.as_str().to_string(),
            commit_hash: None,
            conflicts,
            previewed: true,
            blockers,
            message: None,
            archaeology,
            warnings,
        });
    }

    // A stale journal means a prior join half-finished — require --continue.
    if read_join_journal(&repo_root, name).is_some() {
        return Err(stale_journal_detail(name));
    }

    // Must run from the base worktree, not inside the dash worktree. Deliberately
    // absent from `join_preflight_in`: it reads the *process* cwd, which from
    // tugcast is the server's and has nothing to do with the calling card.

    let current_dir =
        std::env::current_dir().map_err(|e| format!("failed to get current directory: {}", e))?;
    if current_dir.starts_with(&worktree) {
        return Err(
            "Cannot join from inside the dash worktree. Run from repo root instead.".to_string(),
        );
    }

    // Current branch must be the dash's base.
    let current_branch = git_stdout(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch != base_branch {
        return Err(off_base_detail(&current_branch, &base_branch));
    }

    // Intersection preflight ([P14]): base dirt blocks only when it touches a
    // file this dash also changed (`base...branch` diff ∪ worktree dirt).
    // Disjoint base dirt is fine — the squash-merge only writes the dash's files.
    let intersect = blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch);
    if !intersect.is_empty() {
        let plan_rel = dash_plan_path(&repo_root, name);
        return Err(if intersect.tracked.is_empty() {
            untracked_overwrite_detail(&intersect.untracked, plan_rel.as_deref(), name)
        } else {
            base_dirt_detail(&intersect.tracked, plan_rel.as_deref(), name)
        });
    }

    // Auto-commit outstanding dash-worktree changes — FATAL on error now ([P14]).
    commit_worktree_dirt(&worktree)?;

    // Nothing to integrate (no commits past base) — release, don't join.
    let ahead = git_stdout(
        &repo_root,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", base_branch, branch),
        ],
    )
    .ok()
    .and_then(|s| s.parse::<i64>().ok())
    .unwrap_or(0);
    if ahead == 0 {
        // Names the release verb generically ([P14]) — no raw terminal
        // instruction; each surface fronts its own release affordance.
        return Err(empty_detail(name, &base_branch));
    }

    // Land a pre-built candidate from the resolution ladder ([P31]) instead of
    // integrating per strategy: fast-forward the base onto it (git's `--ff-only`
    // IS the staleness guard — a base that advanced past the candidate's base
    // refuses to fast-forward), then run the same journaled teardown.
    if let Some(candidate) = opts.candidate.clone() {
        let ff = git_output(&repo_root, &["merge", "--ff-only", &candidate])?;
        if !ff.status.success() {
            return Err(format!(
                "stale candidate: base '{}' advanced since the conflicts were resolved; re-resolve and try again ({})",
                base_branch,
                String::from_utf8_lossy(&ff.stderr).trim()
            ));
        }
        let commit_hash = git_stdout(&repo_root, &["rev-parse", "HEAD"])?;
        // The candidate carries its own message — the ladder wrote it when it
        // built the resolution — so the receipt reports that rather than a
        // message this path never composed.
        let message = git_stdout(&repo_root, &["log", "-1", "--format=%B", &commit_hash]).ok();
        let journal = JoinJournal {
            name: name.to_string(),
            base_branch: base_branch.clone(),
            strategy: opts.strategy.as_str().to_string(),
            commit_hash,
            phase: JoinPhase::Integrated,
            message,
        };
        write_join_journal(&repo_root, &journal)?;
        return finish_join_teardown(
            &repo_root,
            name,
            &branch,
            &worktree,
            opts.origin.as_deref(),
            journal,
            warnings,
        );
    }

    let final_msg = integrate_message(&repo_root, name, &branch, opts.message.clone());

    // Integrate per strategy. A conflict cleanly aborts (pre-join state
    // restored) and returns the structured conflict list — never a dead end.
    let conflict_outcome = |conflicts: Vec<String>, warnings: Vec<String>| JoinOutcome {
        name: name.to_string(),
        base_branch: base_branch.clone(),
        strategy: opts.strategy.as_str().to_string(),
        commit_hash: None,
        conflicts,
        previewed: false,
        blockers: vec![],
        message: None,
        // Preview-only ([P07]): an execute that hit conflicts aborted cleanly
        // and the caller's next act is a preview, which computes it.
        archaeology: vec![],
        warnings,
    };

    let commit_hash = match opts.strategy {
        JoinStrategy::Squash => {
            let merge = git_output(&repo_root, &["merge", "--squash", &branch])?;
            if !merge.status.success() {
                let conflicts = conflicted_paths(&repo_root);
                // A squash conflict leaves the index/worktree dirty but sets no
                // MERGE_HEAD, so `reset --hard` (not `merge --abort`) restores.
                let _ = git_output(&repo_root, &["reset", "--hard"]);
                return Ok(conflict_outcome(conflicts, warnings));
            }
            let commit = git_output(&repo_root, &["commit", "-m", &final_msg])?;
            if !commit.status.success() {
                let _ = git_output(&repo_root, &["reset", "--hard"]);
                return Err(format!(
                    "git commit failed: {}",
                    String::from_utf8_lossy(&commit.stderr).trim()
                ));
            }
            git_stdout(&repo_root, &["rev-parse", "HEAD"])?
        }
        JoinStrategy::Merge => {
            let merge = git_output(&repo_root, &["merge", "--no-ff", "-m", &final_msg, &branch])?;
            if !merge.status.success() {
                let conflicts = conflicted_paths(&repo_root);
                let _ = git_output(&repo_root, &["merge", "--abort"]);
                return Ok(conflict_outcome(conflicts, warnings));
            }
            git_stdout(&repo_root, &["rev-parse", "HEAD"])?
        }
        JoinStrategy::Rebase => {
            // Fast-forward when base is unchanged (linear); else replay the
            // dash's commits onto the current base with cherry-pick.
            let ff = git_output(&repo_root, &["merge", "--ff-only", &branch])?;
            if ff.status.success() {
                git_stdout(&repo_root, &["rev-parse", "HEAD"])?
            } else {
                let pick = git_output(
                    &repo_root,
                    &["cherry-pick", &format!("{}..{}", base_branch, branch)],
                )?;
                if !pick.status.success() {
                    let conflicts = conflicted_paths(&repo_root);
                    let _ = git_output(&repo_root, &["cherry-pick", "--abort"]);
                    return Ok(conflict_outcome(conflicts, warnings));
                }
                git_stdout(&repo_root, &["rev-parse", "HEAD"])?
            }
        }
    };

    // Journal the successful integrate, then run the resumable teardown.
    let journal = JoinJournal {
        name: name.to_string(),
        base_branch: base_branch.clone(),
        strategy: opts.strategy.as_str().to_string(),
        commit_hash: commit_hash.clone(),
        phase: JoinPhase::Integrated,
        message: Some(final_msg.clone()),
    };
    write_join_journal(&repo_root, &journal)?;

    finish_join_teardown(
        &repo_root,
        name,
        &branch,
        &worktree,
        opts.origin.as_deref(),
        journal,
        warnings,
    )
}

/// The resumable teardown half of a join ([P14]): remove the worktree, delete
/// the branch, append the dash-log line, clear the journal — advancing the
/// journal phase after each step so `--continue` resumes exactly where a crash
/// left off. Idempotent per phase.
fn finish_join_teardown(
    repo_root: &Path,
    name: &str,
    branch: &str,
    worktree: &Path,
    origin: Option<&str>,
    mut journal: JoinJournal,
    mut warnings: Vec<String>,
) -> Result<JoinOutcome, String> {
    if journal.phase == JoinPhase::Integrated {
        remove_dash_worktree(repo_root, branch, worktree, &mut warnings);
        journal.phase = JoinPhase::WorktreeRemoved;
        write_join_journal(repo_root, &journal)?;
    }

    if journal.phase == JoinPhase::WorktreeRemoved {
        if branch_exists(repo_root, branch) {
            match git_output(repo_root, &["branch", "-D", branch]) {
                Ok(o) if !o.status.success() => warnings.push(format!(
                    "Failed to delete branch: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                )),
                Err(e) => warnings.push(format!("Failed to delete branch: {}", e)),
                _ => {}
            }
        }
        journal.phase = JoinPhase::BranchDeleted;
        write_join_journal(repo_root, &journal)?;
    }

    // Record the terminal action in the dash-log ([P04], R01), then clear the
    // journal so the join is no longer "incomplete".
    let short = git_stdout(repo_root, &["rev-parse", "--short", &journal.commit_hash])
        .unwrap_or_else(|_| journal.commit_hash.clone());
    let note = match origin {
        Some(origin) => format!("joined via {origin}"),
        None => "joined".to_string(),
    };
    append_dash_log(repo_root, name, &short, &note).map_err(|e| e.to_string())?;
    clear_join_journal(repo_root, name);

    Ok(JoinOutcome {
        name: name.to_string(),
        base_branch: journal.base_branch,
        strategy: journal.strategy,
        commit_hash: Some(journal.commit_hash),
        conflicts: vec![],
        previewed: false,
        blockers: vec![],
        message: journal.message,
        archaeology: vec![],
        warnings,
    })
}

/// Release a dash: tear down its worktree + branch without merging.
pub fn release(name: &str, origin: Option<&str>) -> Result<ReleaseOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    release_in(&repo_root, name, origin)
}

/// Like [`release`], but against an explicit repo root instead of the process
/// cwd — for callers such as tugcast.
pub fn release_in(
    repo_root: &Path,
    name: &str,
    origin: Option<&str>,
) -> Result<ReleaseOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    migrate_worktrees(&repo_root, &mut warnings);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    if !branch_exists(&repo_root, &branch) && !worktree.exists() {
        return Err(format!("Dash not found: {}", name));
    }

    // The worktree's uncommitted work has the same shape of problem as the
    // plan, one level up: `create --carry` moves work here and leaves it
    // uncommitted by design, so the worktree holds the only copy of it and
    // teardown would destroy it. Check for the one case that cannot be resolved
    // — the base has since acquired its own edit to the same path — before
    // anything at all has moved, so a refused release changes nothing ([P08]).
    let plan_rel = dash_plan_path(&repo_root, name);
    let hand = working_set_hand_back(&repo_root, &worktree, plan_rel.as_deref());
    if !hand.conflicts.is_empty() {
        return Err(format!(
            "Cannot release '{name}': the base checkout has its own uncommitted changes to \
             {}, which the dash also changed without committing. Handing the dash's work back \
             would overwrite yours, so the dash is left standing. Commit or stash the base \
             changes, then release again.",
            hand.conflicts.join(", ")
        ));
    }

    // Hand the plan back before anything is torn down. Adoption *removed* the
    // base copy, and release deletes the branch holding the only one — so
    // without this, discarding a dash would permanently destroy the user's
    // plan document. A plan is not the work; it is the authored document that
    // predates the dash and outlives it.
    let plan_restored = restore_plan_to_base(&repo_root, name, &branch, &mut warnings);
    let work_restored = apply_hand_back(&repo_root, &worktree, &hand, &mut warnings);

    // Reap the dash's tmux/app and remove its worktree robustly (see
    // `remove_dash_worktree` for the "Directory not empty" race this avoids).
    remove_dash_worktree(&repo_root, &branch, &worktree, &mut warnings);

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

    // Record the terminal action in the dash-log ([P04]).
    append_dash_log(
        &repo_root,
        name,
        "released",
        &origin.map_or(String::new(), |o| format!("via {o}")),
    )
    .map_err(|e| e.to_string())?;

    Ok(ReleaseOutcome {
        name: name.to_string(),
        plan_restored,
        work_restored,
        warnings,
    })
}

/// What release must do with the worktree's uncommitted work before the
/// worktree is deleted ([P08]).
struct HandBack {
    /// Paths to copy back to the base checkout.
    restore: Vec<BaseDirtPath>,
    /// Paths the base already holds its own uncommitted edit to. Handing these
    /// back would overwrite the user's other work to complete a release, so
    /// release refuses instead.
    conflicts: Vec<String>,
    /// Paths the worktree *deleted*. Deliberately not handed back: the base
    /// still holds the file, so keeping it loses no bytes, while handing the
    /// deletion back would destroy base content in order to finish a teardown.
    deletions: Vec<String>,
}

/// Read what the dash worktree holds uncommitted and sort it into [`HandBack`].
///
/// Scoped to *all* uncommitted worktree work, not only what arrived by
/// `create --carry`: tracking provenance would mean new persisted state, and
/// the broader rule is the more useful one anyway — work typed in a worktree
/// and never committed is destroyed by a release today.
///
/// `plan_rel` is excluded because `restore_plan_to_base` owns that file and
/// reads it from the branch rather than the worktree.
fn working_set_hand_back(repo_root: &Path, worktree: &Path, plan_rel: Option<&str>) -> HandBack {
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
        if Some(entry.path.as_str()) == plan_rel {
            continue;
        }
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
            "The dash deleted {path} without committing it; the base copy is left in place."
        ));
    }
    restored
}

/// Write the dash branch's copy of its recorded plan back to the base checkout,
/// when those bytes are not already what base HEAD holds.
///
/// Read from the branch rather than the worktree so it works even if the
/// worktree is already gone, and quiet by design: an untouched dash, or one
/// that never adopted a plan, releases exactly as it did before.
fn restore_plan_to_base(
    repo_root: &Path,
    name: &str,
    branch: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let rel = dash_plan_path(repo_root, name)?;
    let on_branch = git_show_raw(repo_root, &format!("{branch}:{rel}"))?;
    let on_base = git_show_raw(repo_root, &format!("HEAD:{rel}")).unwrap_or_default();
    if on_branch == on_base {
        return None;
    }
    let abs = repo_root.join(&rel);
    if let Some(parent) = abs.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        warnings.push(format!("Failed to restore plan {rel}: {e}"));
        return None;
    }
    match write_atomic(&abs, &on_branch) {
        Ok(()) => Some(rel),
        Err(e) => {
            warnings.push(format!("Failed to restore plan {rel}: {e}"));
            None
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    #[test]
    fn branch_slug_matches_canonical_bundle_id_slug() {
        // Mirrors scripts/branch-slug.sh: lowercase, non-alnum runs → '-',
        // trimmed. These reconstruct the per-worktree instance ID that
        // `assign-bundle-id.sh` stamps, so `reap_dash_tmux` targets the
        // exact tmux identity a removed dash's app used.
        assert_eq!(branch_slug("tugdash/kbd-model"), "tugdash-kbd-model");
        assert_eq!(
            branch_slug("tugdash/Focus_Gallery"),
            "tugdash-focus-gallery"
        );
        assert_eq!(branch_slug("tugdash/a--b"), "tugdash-a-b");
        assert_eq!(branch_slug("tugdash/trailing-"), "tugdash-trailing");
        // The reconstructed debug session name matches what tugcast creates
        // (`cc-<instance-id>`), e.g. the leaked `cc-debug-tugdash-kbd-model`.
        let id = format!("debug-{}", branch_slug("tugdash/kbd-model"));
        assert_eq!(id, "debug-tugdash-kbd-model");
    }

    /// Redirect `project_state_dir`'s base off the real data dir for the
    /// duration of a (serial) test, so the dash-log lands under `home`.
    fn redirect_state_dir(home: &Path) {
        // SAFETY: dash tests are #[serial]; no other thread reads the
        // environment concurrently while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home);
        }
    }

    /// A git repo under `temp`, with the redirected project-state dir as its
    /// *sibling* rather than a child, and the cwd left on it.
    ///
    /// Production never puts project state inside a working tree. A fixture
    /// that does makes every dash-log write — including the birth record
    /// `create` appends — read as untracked dirt in the base checkout, which
    /// then shows up in dirt censuses and join preflights that have nothing to
    /// do with it.
    fn repo_beside_state(temp: &TempDir) -> std::path::PathBuf {
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(&repo).unwrap();
        repo
    }

    /// Path the dash-log is written to for `repo`, given the redirected base.
    ///
    /// Canonicalizes `repo` to match `find_repo_root()`, which resolves the cwd
    /// (e.g. `/var/...` → `/private/var/...` on macOS) — the slug must agree.
    fn dash_log_path(home: &Path, repo: &Path) -> std::path::PathBuf {
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home);
        }
        let root = fs::canonicalize(repo).unwrap();
        tugutil_core::project_state_dir(&root).join("dash-log.md")
    }

    fn init_git_repo(path: &Path) {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["init", "-b", "main"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["config", "user.name", "Test User"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["config", "user.email", "test@example.com"])
            .output()
            .unwrap();

        // Both worktree homes, matching what a real tugtool checkout ignores —
        // the census reads untracked files with `--exclude-standard`, so a test
        // repo that did not ignore its own worktree home would report every
        // dash worktree as base dirt.
        fs::write(path.join(".gitignore"), ".tugtree/\n.tug/\n").unwrap();
        fs::create_dir_all(path.join(".tugtool")).unwrap();
        fs::write(path.join(".tugtool/.keep"), "").unwrap();

        fs::write(path.join("README.md"), "# Test\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["commit", "-m", "Initial commit"])
            .output()
            .unwrap();
    }

    /// Write a `.tugtool/config.toml` with the given post_create commands.
    fn write_config(path: &Path, post_create: &[&str]) {
        let cmds = post_create
            .iter()
            .map(|c| format!("\"{}\"", c))
            .collect::<Vec<_>>()
            .join(", ");
        fs::write(
            path.join(".tugtool/config.toml"),
            format!("[tugtool.dash]\npost_create = [{}]\n", cmds),
        )
        .unwrap();
    }

    fn current_branch(repo: &Path) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn branch_present(repo: &Path, branch: &str) -> bool {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["branch", "--list", branch])
            .output()
            .unwrap();
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// A skeleton-valid plan with two ledger rows, for the step verbs to drive.
    const TWO_STEP_PLAN: &str = r#"## A Two Step Plan {#two-step-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The first step | pending | — |
| #step-2 | The second step | pending | — |

#### Step 1: The first step {#step-1}

**Commit:** `thing(scope): first`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the first thing.

**Tests:**
- [ ] Unit: the first thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

#### Step 2: The second step {#step-2}

**Commit:** `thing(scope): second`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the second thing.

**Tests:**
- [ ] Unit: the second thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

    /// Stand up a repo with a dash whose worktree holds [`TWO_STEP_PLAN`].
    /// Returns the temp dir and the canonical repo root the verbs resolve to.
    fn stepped_dash(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create(name, None, None, false).unwrap();

        let worktree = worktree_path(&repo, name);
        fs::create_dir_all(worktree.join("roadmap")).unwrap();
        fs::write(worktree.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();

        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    /// The ledger row for `anchor`, as the plan on disk now reads.
    fn ledger_row(root: &Path, name: &str, anchor: &str) -> tugutil_core::plan::LedgerRow {
        let source = fs::read_to_string(worktree_path(root, name).join("roadmap/plan.md")).unwrap();
        tugutil_core::plan::parse(&source)
            .unwrap()
            .ledger_rows
            .into_iter()
            .find(|r| r.anchor == anchor)
            .unwrap_or_else(|| panic!("no row for #{anchor}"))
    }

    #[serial]
    #[test]
    fn step_verbs_drive_the_ledger_and_the_dash_log_together() {
        let (_temp, root) = stepped_dash("step-dash");

        let started = step_start("step-dash", 1, Some("roadmap/plan.md")).unwrap();
        assert_eq!(started.plan_path, "roadmap/plan.md");
        assert_eq!((started.step, started.total), (1, 2));
        assert_eq!(started.status, "in progress");
        assert_eq!(
            ledger_row(&root, "step-dash", "step-1").status,
            "in progress"
        );
        assert_eq!(
            crate::dash::read_declarations(&root, "step-dash").latest,
            Some(crate::dash::DashDeclaration::Step {
                current: 1,
                total: 2
            })
        );

        let done = step_done("step-dash", 1, Some("abc1234")).unwrap();
        assert_eq!(done.commit.as_deref(), Some("abc1234"));
        let row = ledger_row(&root, "step-dash", "step-1");
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some("abc1234"));

        // The recorded plan survives to a call that names no --plan.
        assert_eq!(
            dash_plan_path(&root, "step-dash").as_deref(),
            Some("roadmap/plan.md")
        );
        let next = step_start("step-dash", 2, None).unwrap();
        assert_eq!(next.plan_path, "roadmap/plan.md");
        assert_eq!(
            ledger_row(&root, "step-dash", "step-2").status,
            "in progress"
        );
    }

    #[serial]
    #[test]
    fn step_done_records_the_branch_tip_when_no_commit_is_named() {
        let (_temp, root) = stepped_dash("tip-dash");
        step_start("tip-dash", 1, Some("roadmap/plan.md")).unwrap();
        let tip = git_stdout(&root, &["rev-parse", "--short", "tugdash/tip-dash"]).unwrap();

        let done = step_done("tip-dash", 1, None).unwrap();
        assert_eq!(done.commit.as_deref(), Some(tip.as_str()));
        assert_eq!(
            ledger_row(&root, "tip-dash", "step-1").commit.as_deref(),
            Some(tip.as_str())
        );
    }

    #[serial]
    #[test]
    fn step_verbs_refuse_and_leave_the_plan_untouched() {
        let (_temp, root) = stepped_dash("refuse-dash");
        let plan = worktree_path(&root, "refuse-dash").join("roadmap/plan.md");
        let before = fs::read_to_string(&plan).unwrap();

        // No plan recorded and none named.
        let err = step_start("refuse-dash", 1, None).unwrap_err();
        assert!(err.contains("--plan"), "{err}");

        // A plan outside the dash worktree is not this dash's plan.
        fs::write(root.join("elsewhere.md"), TWO_STEP_PLAN).unwrap();
        let err = step_start("refuse-dash", 1, Some("../../../elsewhere.md")).unwrap_err();
        assert!(err.contains("outside the dash worktree"), "{err}");

        // A path that resolves to nothing.
        let err = step_start("refuse-dash", 1, Some("roadmap/missing.md")).unwrap_err();
        assert!(err.contains("plan not found"), "{err}");

        // An anchor the ledger does not carry.
        let err = step_start("refuse-dash", 9, Some("roadmap/plan.md")).unwrap_err();
        assert!(err.contains("no ledger row for #step-9"), "{err}");

        // A finished row refuses to be started again, naming its status.
        step_start("refuse-dash", 1, Some("roadmap/plan.md")).unwrap();
        step_done("refuse-dash", 1, Some("abc1234")).unwrap();
        let err = step_start("refuse-dash", 1, None).unwrap_err();
        assert!(err.contains("is 'done'"), "{err}");

        // Only the two successful calls moved the document.
        let after = fs::read_to_string(&plan).unwrap();
        assert_eq!(
            after.lines().filter(|l| l.starts_with("| #step-")).count(),
            2
        );
        assert_eq!(
            before.lines().count(),
            after.lines().count(),
            "no refusal added or dropped a line"
        );
    }

    /// A stepped dash reports its declared stage, its progress, and the plan it
    /// is driving; a mark moves the stage; a later step moves it back ([P03]).
    #[serial]
    #[test]
    fn status_reports_declared_stage_step_and_plan() {
        let (_temp, root) = stepped_dash("status-dash");

        // The seeded plan is uncommitted worktree dirt, so the undeclared dash
        // derives `working` exactly as it did before declarations existed.
        let fresh = status_in(&root, "status-dash").unwrap();
        assert_eq!(fresh.stage, "working");
        assert!(fresh.step_current.is_none() && fresh.plan_path.is_none());

        step_start("status-dash", 1, Some("roadmap/plan.md")).unwrap();
        let stepping = status_in(&root, "status-dash").unwrap();
        assert_eq!(stepping.stage, "implementing");
        assert_eq!(
            (stepping.step_current, stepping.step_total),
            (Some(1), Some(2))
        );
        assert_eq!(stepping.plan_path.as_deref(), Some("roadmap/plan.md"));

        mark("status-dash", MarkStage::Built, None).unwrap();
        let built = status_in(&root, "status-dash").unwrap();
        assert_eq!(built.stage, "built");
        // The step fields outlive the mark, so a display can still say how far.
        assert_eq!(built.step_current, Some(1));

        mark("status-dash", MarkStage::Audited, Some("good shape")).unwrap();
        assert_eq!(status_in(&root, "status-dash").unwrap().stage, "audited");

        // A follow-up step range demotes the dash back to implementing.
        step_start("status-dash", 2, None).unwrap();
        let again = status_in(&root, "status-dash").unwrap();
        assert_eq!(again.stage, "implementing");
        assert_eq!(again.step_current, Some(2));
    }

    /// The feed's shared composition carries the same declared stage and step
    /// progress `status` reports — which is what lights up the Lens Dashes
    /// section and the Changes dash lane with no frontend change ([P01]).
    #[serial]
    #[test]
    fn detail_entries_carry_declared_stage_and_step() {
        let (_temp, root) = stepped_dash("feed-dash");

        // A plain dash derives what it always did.
        let plain = dash_detail_entries_in(&root);
        let entry = plain.iter().find(|d| d.name == "feed-dash").unwrap();
        assert_eq!(entry.stage, "working");
        assert!(entry.step_current.is_none() && entry.step_total.is_none());

        step_start("feed-dash", 1, Some("roadmap/plan.md")).unwrap();
        let stepped = dash_detail_entries_in(&root);
        let entry = stepped.iter().find(|d| d.name == "feed-dash").unwrap();
        assert_eq!(entry.stage, "implementing");
        assert_eq!((entry.step_current, entry.step_total), (Some(1), Some(2)));

        mark("feed-dash", MarkStage::Built, None).unwrap();
        let built = dash_detail_entries_in(&root);
        let entry = built.iter().find(|d| d.name == "feed-dash").unwrap();
        assert_eq!(entry.stage, "built");
        assert_eq!(entry.step_current, Some(1));
    }

    /// The recorded plan path rides the same composition, so a card bound to a
    /// dash can resolve the plan it is implementing without a shell round-trip.
    #[serial]
    #[test]
    fn detail_entries_carry_the_recorded_plan_path() {
        let (_temp, root) = stepped_dash("plan-path-dash");

        let before = dash_detail_entries_in(&root);
        let entry = before.iter().find(|d| d.name == "plan-path-dash").unwrap();
        assert!(
            entry.plan_path.is_none(),
            "a dash no run has stepped records no plan: {:?}",
            entry.plan_path
        );

        step_start("plan-path-dash", 1, Some("roadmap/plan.md")).unwrap();
        let after = dash_detail_entries_in(&root);
        let entry = after.iter().find(|d| d.name == "plan-path-dash").unwrap();
        assert_eq!(entry.plan_path.as_deref(), Some("roadmap/plan.md"));
        // Worktree-relative, which is what makes the composition
        // `projectDir` / `worktree` / `plan_path` land on the copy a run edits.
        assert!(!entry.plan_path.as_deref().unwrap().starts_with('/'));
    }

    /// The divergence a landing would only reveal at the join, said on every
    /// recompute instead: how far the base has run ahead, and which of its
    /// uncommitted edits land on files this dash also changed.
    #[serial]
    #[test]
    fn detail_entries_carry_base_divergence() {
        let (_temp, root) = stepped_dash("divergence-dash");
        let worktree = worktree_path(&root, "divergence-dash");

        // A round on the dash, touching `shared.txt`.
        fs::write(worktree.join("shared.txt"), "dash\n").unwrap();
        git_output(&worktree, &["add", "-A"]).unwrap();
        git_output(&worktree, &["commit", "-m", "the dash's round"]).unwrap();

        let quiet = dash_detail_entries_in(&root);
        let entry = quiet.iter().find(|d| d.name == "divergence-dash").unwrap();
        assert_eq!(entry.base_ahead, 0, "the base has not moved");
        assert!(entry.base_overlap.is_empty());
        assert!(entry.last_replay.is_none());

        // The base gains a commit, then an uncommitted edit — one to a file the
        // dash also changed, one to a file it does not touch.
        fs::write(root.join("elsewhere.txt"), "base\n").unwrap();
        git_output(&root, &["add", "elsewhere.txt"]).unwrap();
        git_output(&root, &["commit", "-m", "the base moves"]).unwrap();
        fs::write(root.join("shared.txt"), "base edits it too\n").unwrap();
        git_output(&root, &["add", "shared.txt"]).unwrap();
        fs::write(root.join("elsewhere.txt"), "and this\n").unwrap();

        let moved = dash_detail_entries_in(&root);
        let entry = moved.iter().find(|d| d.name == "divergence-dash").unwrap();
        assert_eq!(entry.base_ahead, 1);
        assert_eq!(
            entry.base_overlap,
            vec!["shared.txt".to_string()],
            "only the intersection with the dash's own files is a warning"
        );
    }

    /// A replay's dash-log line reaches the snapshot as the settled mark's text
    /// without disturbing the derived stage.
    #[serial]
    #[test]
    fn detail_entries_carry_the_last_replay_note() {
        let (_temp, root) = stepped_dash("replay-note-dash");
        append_dash_log(
            &root,
            "replay-note-dash",
            "replayed",
            "onto abc123456: d->e",
        )
        .unwrap();

        let entries = dash_detail_entries_in(&root);
        let entry = entries
            .iter()
            .find(|d| d.name == "replay-note-dash")
            .unwrap();
        assert_eq!(entry.last_replay.as_deref(), Some("onto abc123456: d->e"));
        assert_eq!(
            entry.stage, "working",
            "a replay records history, it does not move the stage"
        );
    }

    #[serial]
    #[test]
    fn mark_refuses_an_unknown_dash() {
        let (_temp, _root) = stepped_dash("known-dash");
        let err = mark("no-such-dash", MarkStage::Built, None).unwrap_err();
        assert!(err.contains("Dash not found"), "{err}");
    }

    #[serial]
    #[test]
    fn step_start_re_enters_an_interrupted_step() {
        let (_temp, root) = stepped_dash("resume-dash");
        step_start("resume-dash", 1, Some("roadmap/plan.md")).unwrap();
        let interrupted =
            fs::read_to_string(worktree_path(&root, "resume-dash").join("roadmap/plan.md"))
                .unwrap();

        step_start("resume-dash", 1, None).expect("a resumed run re-enters its own step");
        let after = fs::read_to_string(worktree_path(&root, "resume-dash").join("roadmap/plan.md"))
            .unwrap();
        assert_eq!(after, interrupted, "re-entry moves no byte of the plan");
    }

    // --- plan adoption -----------------------------------------------------

    /// A repo with a dash whose worktree holds no plan yet.
    fn adopting_dash(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create(name, None, None, false).unwrap();
        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    /// A repo whose plan was committed on base *before* the dash was cut, so
    /// both roots hold it and the base copy is clean.
    fn adopted_from_committed_plan(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        write_base_plan(&repo, TWO_STEP_PLAN);
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "Add the plan"]);
        create(name, None, None, false).unwrap();
        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    fn write_base_plan(root: &Path, body: &str) {
        fs::create_dir_all(root.join("roadmap")).unwrap();
        fs::write(root.join("roadmap/plan.md"), body).unwrap();
    }

    fn base_plan_status(root: &Path) -> String {
        git_stdout(root, &["status", "--porcelain", "--", "roadmap/plan.md"]).unwrap()
    }

    fn worktree_plan(root: &Path, name: &str) -> String {
        fs::read_to_string(worktree_path(root, name).join("roadmap/plan.md")).unwrap()
    }

    fn stamp_of(body: &str) -> String {
        let doc = tugutil_core::plan::parse(body).unwrap();
        tugutil_core::plan::content_stamp(&doc, body)
    }

    #[serial]
    #[test]
    fn adopt_inherits_a_clean_base_copy_the_worktree_already_has() {
        let (_temp, root) = adopted_from_committed_plan("inherit-dash");

        let out = adopt_plan_in(&root, "inherit-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(out.action, "inherited");
        assert_eq!(out.base_copy, "untouched");
        assert!(out.commit.is_none());
        assert_eq!(out.plan_path, "roadmap/plan.md");
        assert!(base_plan_status(&root).is_empty());
        assert_eq!(
            dash_plan_path(&root, "inherit-dash").as_deref(),
            Some("roadmap/plan.md")
        );
    }

    /// The plan is committed on base *after* the dash was cut, so the worktree
    /// — made from an older base — has never seen the file.
    #[serial]
    #[test]
    fn adopt_copies_a_base_copy_committed_after_the_dash_was_cut() {
        let (_temp, root) = adopting_dash("late-dash");
        write_base_plan(&root, TWO_STEP_PLAN);
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);

        let out = adopt_plan_in(&root, "late-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(out.action, "committed");
        assert_eq!(out.base_copy, "untouched", "a clean copy is not dirt");
        assert!(out.commit.is_some());
        assert_eq!(worktree_plan(&root, "late-dash"), TWO_STEP_PLAN);
        assert!(base_plan_status(&root).is_empty());
        assert!(root.join("roadmap/plan.md").exists(), "base keeps its copy");
    }

    #[serial]
    #[test]
    fn adopt_refuses_when_the_plan_is_absent_from_both_roots() {
        let (_temp, root) = adopting_dash("nowhere-dash");
        let err = adopt_plan_in(&root, "nowhere-dash", Some("roadmap/plan.md")).unwrap_err();
        assert!(err.contains("plan not found"), "{err}");
        assert!(
            err.contains("either the worktree or the repo root"),
            "{err}"
        );
    }

    #[serial]
    #[test]
    fn adopt_transplants_an_untracked_base_copy_and_removes_it() {
        let (_temp, root) = adopting_dash("untracked-dash");
        write_base_plan(&root, TWO_STEP_PLAN);

        let out = adopt_plan_in(&root, "untracked-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(out.action, "committed");
        assert_eq!(out.base_copy, "removed");
        assert_eq!(worktree_plan(&root, "untracked-dash"), TWO_STEP_PLAN);
        assert!(!root.join("roadmap/plan.md").exists());
        assert!(base_plan_status(&root).is_empty());

        // The bytes are reachable from the branch, not merely on disk.
        let on_branch =
            git_stdout(&root, &["show", "tugdash/untracked-dash:roadmap/plan.md"]).unwrap();
        assert!(on_branch.contains("A Two Step Plan"));
    }

    #[serial]
    #[test]
    fn adopt_transplants_a_tracked_dirty_base_copy_and_restores_it() {
        let (_temp, root) = adopting_dash("dirty-dash");
        write_base_plan(&root, TWO_STEP_PLAN);
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);
        // The user's uncommitted edit, on a worktree that has never seen it.
        let edited = TWO_STEP_PLAN.replace("Some context.", "Some revised context.");
        write_base_plan(&root, &edited);

        let out = adopt_plan_in(&root, "dirty-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(out.action, "committed");
        assert_eq!(out.base_copy, "restored");
        assert_eq!(
            worktree_plan(&root, "dirty-dash"),
            edited,
            "the user's edit rode across, not the committed base version"
        );
        assert!(base_plan_status(&root).is_empty());
    }

    #[serial]
    #[test]
    fn adopt_cleans_a_byte_identical_base_copy_without_committing() {
        let (_temp, root) = adopted_from_committed_plan("identical-dash");
        // A leftover hand-copy on base: same bytes, now uncommitted dirt.
        let edited = TWO_STEP_PLAN.replace("Some context.", "Some revised context.");
        write_base_plan(&root, &edited);
        fs::write(
            worktree_path(&root, "identical-dash").join("roadmap/plan.md"),
            &edited,
        )
        .unwrap();

        let out = adopt_plan_in(&root, "identical-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(out.action, "cleaned");
        assert_eq!(out.base_copy, "restored");
        assert!(out.commit.is_none());
        assert_eq!(worktree_plan(&root, "identical-dash"), edited);
        assert!(base_plan_status(&root).is_empty());
    }

    /// Progress-only divergence: the base copy is a stale hand-copy whose body
    /// matches, and only the worktree's ledger has moved. The worktree wins.
    #[serial]
    #[test]
    fn adopt_cleans_a_progress_only_base_copy_and_keeps_worktree_progress() {
        let (_temp, root) = adopted_from_committed_plan("progress-dash");
        step_start("progress-dash", 1, Some("roadmap/plan.md")).unwrap();
        // Base dirt whose body is unchanged; the worktree carries real progress.
        write_base_plan(&root, &format!("{TWO_STEP_PLAN}\n"));

        let out = adopt_plan_in(&root, "progress-dash", None).unwrap();
        assert_eq!(out.action, "cleaned");
        assert!(out.commit.is_none());
        assert!(out.dropped_rows.is_empty());
        assert_eq!(
            ledger_row(&root, "progress-dash", "step-1").status,
            "in progress",
            "the worktree ledger is authoritative"
        );
        assert!(base_plan_status(&root).is_empty());
    }

    #[serial]
    #[test]
    fn adopt_replays_worktree_progress_onto_an_edited_base_body() {
        let (_temp, root) = adopted_from_committed_plan("replay-dash");
        // Progress on the worktree, committed there as a round would.
        step_start("replay-dash", 1, Some("roadmap/plan.md")).unwrap();
        step_done("replay-dash", 1, Some("abc1234")).unwrap();
        let worktree = worktree_path(&root, "replay-dash");
        run_git(&worktree, &["add", "-A"]);
        run_git(&worktree, &["commit", "-m", "round"]);
        // Meanwhile the user revised the body on base.
        let revised = TWO_STEP_PLAN.replace("Some context.", "Some revised context.");
        write_base_plan(&root, &revised);

        let out = adopt_plan_in(&root, "replay-dash", None).unwrap();
        assert_eq!(out.action, "committed");
        assert_eq!(out.base_copy, "restored");
        assert!(out.dropped_rows.is_empty());
        assert!(out.warnings.is_empty());

        let after = worktree_plan(&root, "replay-dash");
        assert!(after.contains("Some revised context."), "base body won");
        let row = ledger_row(&root, "replay-dash", "step-1");
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some("abc1234"));
        assert_eq!(
            stamp_of(&after),
            stamp_of(&revised),
            "replaying progress leaves the content stamp — and so the review state — alone"
        );
        assert!(base_plan_status(&root).is_empty());
    }

    /// A **staged** base edit is the case a bare `git checkout --` would leave
    /// behind: it restores from the index, so the path would stay dirty against
    /// HEAD forever and adoption would never converge.
    #[serial]
    #[test]
    fn adopt_is_idempotent_over_a_staged_base_edit() {
        let (_temp, root) = adopted_from_committed_plan("staged-dash");
        let edited = TWO_STEP_PLAN.replace("Some context.", "Some staged context.");
        write_base_plan(&root, &edited);
        run_git(&root, &["add", "--", "roadmap/plan.md"]);

        let first = adopt_plan_in(&root, "staged-dash", Some("roadmap/plan.md")).unwrap();
        assert_eq!(first.action, "committed");
        assert_eq!(first.base_copy, "restored");
        assert!(
            dirty_tracked_paths(&root).is_empty(),
            "the staged edit is gone from the index as well as the worktree"
        );

        let second = adopt_plan_in(&root, "staged-dash", None).unwrap();
        assert_eq!(second.action, "inherited");
        assert_eq!(second.base_copy, "untouched");
        assert!(second.commit.is_none());
    }

    /// The ordering invariant: base is cleaned only after the commit lands, so
    /// a failing commit leaves the user's bytes exactly where they were.
    #[serial]
    #[test]
    fn adopt_leaves_the_base_copy_intact_when_the_commit_fails() {
        let (_temp, root) = adopting_dash("failing-dash");
        write_base_plan(&root, TWO_STEP_PLAN);
        let worktree = worktree_path(&root, "failing-dash");
        let hooks = worktree.join("refusing-hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        run_git(
            &worktree,
            &["config", "core.hooksPath", &hooks.to_string_lossy()],
        );

        let err = adopt_plan_in(&root, "failing-dash", Some("roadmap/plan.md")).unwrap_err();
        assert!(err.contains("adoption commit failed"), "{err}");
        assert!(
            root.join("roadmap/plan.md").exists(),
            "the base copy survives a failed transplant"
        );
        assert_eq!(
            fs::read_to_string(root.join("roadmap/plan.md")).unwrap(),
            TWO_STEP_PLAN
        );
    }

    /// The generic "commit or stash them first" is the wrong advice when what
    /// intersects is the dash's own plan, so the detail names the remedy verb.
    #[serial]
    #[test]
    fn preflight_names_the_plan_when_the_base_copy_is_what_jails_the_join() {
        let (_temp, root) = adopted_from_committed_plan("jail-dash");
        step_start("jail-dash", 1, Some("roadmap/plan.md")).unwrap();
        commit("jail-dash", "a round", None).unwrap();
        write_base_plan(
            &root,
            &TWO_STEP_PLAN.replace("Some context.", "Some revised context."),
        );

        let blockers = join_preflight_in(&root, "jail-dash").unwrap();
        let dirt: Vec<_> = blockers.iter().filter(|b| b.kind == "base-dirt").collect();
        assert_eq!(dirt.len(), 1);
        assert!(dirt[0].detail.contains("roadmap/plan.md"), "{:?}", dirt[0]);
        assert!(
            dirt[0].detail.contains("adopt-plan jail-dash"),
            "{:?}",
            dirt[0]
        );

        // Adoption clears it.
        adopt_plan_in(&root, "jail-dash", None).unwrap();
        let after = join_preflight_in(&root, "jail-dash").unwrap();
        assert!(after.iter().all(|b| b.kind != "base-dirt"), "{after:?}");
    }

    /// Non-plan tracked dirt keeps the message it always had.
    #[serial]
    #[test]
    fn preflight_leaves_ordinary_base_dirt_wording_alone() {
        let (_temp, root) = adopted_from_committed_plan("plainly-dash");
        let worktree = worktree_path(&root, "plainly-dash");
        fs::write(worktree.join("README.md"), "# Dash\n").unwrap();
        commit("plainly-dash", "touch readme", None).unwrap();
        fs::write(root.join("README.md"), "# Local\n").unwrap();

        let blockers = join_preflight_in(&root, "plainly-dash").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert!(dirt.detail.contains("README.md"), "{:?}", dirt);
        assert!(dirt.detail.contains("Commit or stash them first."));
        assert!(!dirt.detail.contains("adopt-plan"), "{:?}", dirt);
    }

    /// An untracked base file at a path the dash changed is what `git merge
    /// --squash` refuses outright — previously a clean preview and a failing
    /// join. It is a blocker now, and only when it actually intersects.
    #[serial]
    #[test]
    fn preflight_blocks_untracked_base_files_the_dash_would_overwrite() {
        let (_temp, root) = adopting_dash("overwrite-dash");
        let worktree = worktree_path(&root, "overwrite-dash");
        fs::create_dir_all(worktree.join("roadmap")).unwrap();
        fs::write(worktree.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        commit("overwrite-dash", "add the plan", None).unwrap();

        // A disjoint untracked file does not block.
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        let clean = join_preflight_in(&root, "overwrite-dash").unwrap();
        assert!(clean.iter().all(|b| b.kind != "base-dirt"), "{clean:?}");

        // The same path the dash added does — with the plan remedy named,
        // because this dash records that plan.
        write_base_plan(&root, TWO_STEP_PLAN);
        set_dash_plan_path(&root, "overwrite-dash", "roadmap/plan.md").unwrap();
        let blockers = join_preflight_in(&root, "overwrite-dash").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert_eq!(dirt.paths, vec!["roadmap/plan.md".to_string()]);
        assert!(dirt.detail.contains("would be overwritten"), "{:?}", dirt);
        assert!(
            dirt.detail.contains("adopt-plan overwrite-dash"),
            "{:?}",
            dirt
        );

        // The execute path refuses with the same sentence, rather than a clean
        // preview followed by a squash that fails on the untracked file.
        let err = join("overwrite-dash", JoinOptions::default()).unwrap_err();
        assert_eq!(err, dirt.detail);
        assert!(branch_present(&root, "tugdash/overwrite-dash"));
    }

    /// The step verbs are a run's heartbeat, so they are the earliest place a
    /// diverging base copy shows up — as a refusal naming its one remedy.
    #[serial]
    #[test]
    fn step_verbs_refuse_while_a_base_plan_copy_diverges() {
        let (_temp, root) = adopted_from_committed_plan("jailed-dash");
        let plan = worktree_path(&root, "jailed-dash").join("roadmap/plan.md");
        step_start("jailed-dash", 1, Some("roadmap/plan.md")).unwrap();
        let before = fs::read_to_string(&plan).unwrap();

        // Tracked-dirty on base.
        write_base_plan(
            &root,
            &TWO_STEP_PLAN.replace("Some context.", "Some revised context."),
        );
        let err = step_done("jailed-dash", 1, Some("abc1234")).unwrap_err();
        assert!(err.contains("adopt-plan jailed-dash"), "{err}");
        assert!(err.contains("roadmap/plan.md"), "{err}");
        assert_eq!(
            fs::read_to_string(&plan).unwrap(),
            before,
            "a refusal moves no byte of the plan"
        );

        // Untracked on base refuses the same way.
        run_git(&root, &["checkout", "HEAD", "--", "roadmap/plan.md"]);
        run_git(&root, &["rm", "--cached", "roadmap/plan.md"]);
        run_git(&root, &["commit", "-m", "untrack the plan"]);
        let err = step_start("jailed-dash", 2, None).unwrap_err();
        assert!(err.contains("adopt-plan jailed-dash"), "{err}");

        // Adoption is the remedy, and the same call then succeeds.
        adopt_plan_in(&root, "jailed-dash", None).unwrap();
        let resumed = step_start("jailed-dash", 2, None).unwrap();
        assert_eq!(resumed.status, "in progress");
        assert_eq!(
            ledger_row(&root, "jailed-dash", "step-1").status,
            "in progress",
            "the transplant replayed the progress the run had already made"
        );
    }

    /// Adoption removed the base copy, so the branch holds the only one —
    /// and release deletes the branch. The plan has to come back out first.
    #[serial]
    #[test]
    fn release_hands_back_a_plan_that_was_untracked_on_base() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        create("discard-dash", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(!root.join("roadmap/plan.md").exists(), "adoption took it");

        let out = release("discard-dash", None).unwrap();
        assert_eq!(out.plan_restored.as_deref(), Some("roadmap/plan.md"));
        assert!(!branch_present(&root, "tugdash/discard-dash"));
        assert_eq!(
            fs::read_to_string(root.join("roadmap/plan.md")).unwrap(),
            TWO_STEP_PLAN,
            "the document survives its dash"
        );
    }

    /// The tracked-dirty shape: the user's uncommitted edits lived only on the
    /// branch, so release puts them back in the base working tree.
    #[serial]
    #[test]
    fn release_hands_back_the_users_uncommitted_plan_edits() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);
        let edited = TWO_STEP_PLAN.replace("Some context.", "Some revised context.");
        write_base_plan(&root, &edited);
        create("edited-dash", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(base_plan_status(&root).is_empty(), "adoption restored base");

        let out = release("edited-dash", None).unwrap();
        assert_eq!(out.plan_restored.as_deref(), Some("roadmap/plan.md"));
        assert_eq!(
            fs::read_to_string(root.join("roadmap/plan.md")).unwrap(),
            edited
        );
        assert!(
            !base_plan_status(&root).is_empty(),
            "the base copy is dirty again, exactly as the user left it"
        );
    }

    #[serial]
    #[test]
    fn release_of_an_untouched_or_planless_dash_restores_nothing() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);

        // No plan recorded at all.
        create("bare-dash", None, None, false).unwrap();
        assert!(release("bare-dash", None).unwrap().plan_restored.is_none());

        // A plan recorded, but the branch's copy is what base HEAD holds.
        create("same-dash", None, Some("roadmap/plan.md"), false).unwrap();
        let out = release("same-dash", None).unwrap();
        assert!(out.plan_restored.is_none());
        assert!(
            base_plan_status(&root).is_empty(),
            "nothing was written over the clean base copy"
        );
    }

    /// The whole lifecycle on the join arm: a plan authored untracked on base,
    /// adopted at birth, driven through a step, jailed by a base edit the user
    /// made mid-run, freed by the remedy verb, and landed — with the ledger the
    /// run wrote and the body the user typed both present on base afterwards.
    #[serial]
    #[test]
    fn a_plan_adopted_at_birth_survives_the_whole_run_and_lands() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));

        create("e2e-join", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(!root.join("roadmap/plan.md").exists(), "one live copy");

        step_start("e2e-join", 1, None).unwrap();
        commit("e2e-join", "the first round", None).unwrap();
        step_done("e2e-join", 1, None).unwrap();

        // The user revises the plan on base mid-run. Every seam refuses.
        let revised = TWO_STEP_PLAN.replace("Some context.", "Revised mid-run.");
        write_base_plan(&root, &revised);
        let err = step_start("e2e-join", 2, None).unwrap_err();
        assert!(err.contains("adopt-plan e2e-join"), "{err}");
        let blockers = join_preflight_in(&root, "e2e-join").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert!(dirt.detail.contains("adopt-plan e2e-join"), "{:?}", dirt);

        // The remedy verb takes both halves: the user's body, the run's ledger.
        adopt_plan_in(&root, "e2e-join", None).unwrap();
        let merged = worktree_plan(&root, "e2e-join");
        assert!(merged.contains("Revised mid-run."));
        assert_eq!(ledger_row(&root, "e2e-join", "step-1").status, "done");

        step_start("e2e-join", 2, None).unwrap();
        commit("e2e-join", "the second round", None).unwrap();
        step_done("e2e-join", 2, None).unwrap();

        assert!(join_preflight_in(&root, "e2e-join").unwrap().is_empty());
        join("e2e-join", JoinOptions::default()).unwrap();
        assert!(!branch_present(&root, "tugdash/e2e-join"));

        let landed = fs::read_to_string(root.join("roadmap/plan.md")).unwrap();
        assert!(
            landed.contains("Revised mid-run."),
            "the user's body landed"
        );
        let doc = tugutil_core::plan::parse(&landed).unwrap();
        assert!(
            doc.ledger_rows.iter().all(|r| r.status == "done"),
            "the run's ledger landed with it"
        );
    }

    /// The abandon arm — the one that proves no path through the system loses
    /// the document. Adoption removes the base copy and release deletes the
    /// branch, so release has to hand the plan back on its way out.
    #[serial]
    #[test]
    fn a_released_dash_hands_its_plan_back_to_base() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));

        create("e2e-abandon", None, Some("roadmap/plan.md"), false).unwrap();
        step_start("e2e-abandon", 1, None).unwrap();
        commit("e2e-abandon", "a round", None).unwrap();
        assert!(!root.join("roadmap/plan.md").exists());

        let out = release("e2e-abandon", None).unwrap();
        assert_eq!(out.plan_restored.as_deref(), Some("roadmap/plan.md"));
        assert!(!branch_present(&root, "tugdash/e2e-abandon"));
        assert!(
            git_stdout(
                &root,
                &["for-each-ref", "--format=%(refname)", "refs/heads/tugdash/"]
            )
            .unwrap()
            .is_empty(),
            "no dash branch survives the release"
        );

        let back = fs::read_to_string(root.join("roadmap/plan.md")).unwrap();
        assert!(back.contains("A Two Step Plan"), "the document came home");
        assert_eq!(
            tugutil_core::plan::parse(&back)
                .unwrap()
                .ledger_rows
                .iter()
                .find(|r| r.anchor == "step-1")
                .unwrap()
                .status,
            "in progress",
            "including the progress the abandoned run had made"
        );
    }

    /// A repo with no dash yet, ready for a `create --plan`.
    fn repo_for_create(base_plan: Option<&str>) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        if let Some(body) = base_plan {
            write_base_plan(&repo, body);
        }
        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    fn dirt_entry<'a>(out: &'a CreateOutcome, path: &str) -> &'a BaseDirtPath {
        out.base_dirt
            .iter()
            .find(|d| d.path == path)
            .unwrap_or_else(|| panic!("{path} not censused: {:?}", out.base_dirt))
    }

    #[serial]
    #[test]
    fn create_over_a_clean_base_reports_nothing() {
        let (_temp, _root) = repo_for_create(None);
        let out = create("tidy", None, None, false).unwrap();
        assert!(out.base_dirt.is_empty(), "{:?}", out.base_dirt);
        assert_eq!(out.off_base, None);
    }

    /// A dash created bare has no rounds and no adopted plan, so without a
    /// birth record it would have no dash-log line at all and no date to
    /// report. The revisit must not forge a second one — a re-run is a repair,
    /// not activity.
    #[serial]
    #[test]
    fn create_writes_one_birth_record_and_a_revisit_writes_none() {
        let (_temp, root) = repo_for_create(None);
        create("newborn", None, None, false).unwrap();

        let log_path = tugutil_core::paths::project_state_dir(&root).join("dash-log.md");
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

        let revisit = create("newborn", None, None, false).unwrap();
        assert!(!revisit.created);
        assert_eq!(count(&fs::read_to_string(&log_path).unwrap()), 1);
    }

    /// Most creates happen over *some* unrelated dirt, so a refusing create
    /// would be intolerable. The shape that survives is a decision, not a veto:
    /// create succeeds, says what it left behind, and takes nothing.
    #[serial]
    #[test]
    fn create_censuses_base_dirt_and_leaves_it_alone() {
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("README.md"), "# base edit\n").unwrap();
        run_git(&root, &["add", "README.md"]);
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        fs::remove_file(root.join("base.rs")).ok();

        let out = create("dirty", None, None, false).unwrap();
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
        // The dash worktree itself is gitignored, so it is not reported as dirt.
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
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("doomed.txt"), "here\n").unwrap();
        run_git(&root, &["add", "doomed.txt"]);
        run_git(&root, &["commit", "-m", "add doomed"]);
        fs::remove_file(root.join("doomed.txt")).unwrap();

        let out = create("gone", None, None, false).unwrap();
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
        let (_temp, root) = repo_for_create(None);
        run_git(&root, &["checkout", "-q", "-b", "scratch"]);

        let out = create("elsewhere", None, None, false).unwrap();
        assert_eq!(out.off_base.as_deref(), Some("scratch"));
        assert_eq!(out.base_branch, "main");
    }

    /// A plan the dash adopted is gone from the base by the time create
    /// returns, so it is not reported as dirt left behind.
    #[serial]
    #[test]
    fn an_adopted_plan_is_not_censused_as_base_dirt() {
        let (_temp, _root) = repo_for_create(Some(TWO_STEP_PLAN));
        let out = create("adopted", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(
            out.base_dirt.iter().all(|d| d.path != "roadmap/plan.md"),
            "{:?}",
            out.base_dirt
        );
    }

    /// The whole contract in one walk: work already under way on the base is
    /// carried into a dash, committed there as a round, given an authored draft
    /// written from *inside the worktree* — the write that used to disappear —
    /// and landed. The base is clean at every step it should be, and the
    /// message the landing commits is the message the author wrote.
    #[serial]
    #[test]
    fn carried_work_becomes_a_round_and_lands_the_authored_draft() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        isolate_changes_db(&temp);
        let root = fs::canonicalize(&repo).unwrap();

        // Work already under way on the base.
        fs::write(root.join("feature.rs"), "half a feature\n").unwrap();

        let created = create("walk", None, None, true).unwrap();
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

        // The dash's first round commits the carried work with intent.
        fs::write(worktree.join("feature.rs"), "the whole feature\n").unwrap();
        commit("walk", "finish the feature", None).unwrap();

        // The authored draft, written the way `dash-implement` writes it: keyed
        // by the base root that `dash_draft_key` resolves, from the worktree.
        let key = dash_draft_key(&root, "walk");
        let draft = "the feature, finished\n\nCarried in from the base and completed on the dash.";
        seed_draft_row(
            &temp.path().join("changes.db"),
            &key.owner_id,
            &canonical(&key.project),
            draft,
        );

        assert!(join_preflight_in(&root, "walk").unwrap().is_empty());
        let landed = join("walk", JoinOptions::default()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(&root, &["log", "-1", "--format=%B", &sha]).unwrap();

        assert_eq!(
            committed,
            with_dash_trailers(
                &root,
                "walk",
                "tugdash/walk",
                &format!("tugdash(walk): {draft}")
            )
        );
        assert_eq!(
            committed.matches("tugdash(walk): ").count(),
            1,
            "{committed}"
        );
        assert_eq!(
            fs::read_to_string(root.join("feature.rs")).unwrap(),
            "the whole feature\n"
        );
        assert!(!branch_present(&root, "tugdash/walk"));
    }

    /// The abandon arm of the carry gesture. Carried work is uncommitted by
    /// design, so the worktree holds the only copy of it — without the
    /// hand-back, `--carry` would move a developer's work somewhere a routine
    /// release destroys it, which is the tool creating the hazard.
    #[serial]
    #[test]
    fn release_returns_carried_work_to_the_base() {
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("returner", None, None, true).unwrap();
        assert!(!root.join("scratch.txt").exists());

        let out = release("returner", None).unwrap();
        assert_eq!(out.work_restored, vec!["scratch.txt".to_string()]);
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );
        assert!(!worktree_path(&root, "returner").exists());
    }

    /// The guard is not carry-specific: work typed in the worktree and never
    /// committed is destroyed by a release today, and that is the more useful
    /// rule as well as the one that needs no provenance tracking.
    #[serial]
    #[test]
    fn release_returns_work_that_never_arrived_by_carry() {
        let (_temp, root) = repo_for_create(None);
        create("typed", None, None, false).unwrap();
        let worktree = worktree_path(&root, "typed");
        fs::write(worktree.join("typed.txt"), "written in the dash\n").unwrap();
        fs::write(worktree.join("README.md"), "# edited in the dash\n").unwrap();

        let out = release("typed", None).unwrap();
        assert_eq!(out.work_restored, vec!["README.md", "typed.txt"]);
        assert_eq!(
            fs::read_to_string(root.join("typed.txt")).unwrap(),
            "written in the dash\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# edited in the dash\n"
        );
    }

    /// The one case that cannot be resolved: handing the work back would
    /// overwrite the user's own uncommitted edit. The work stays reachable
    /// rather than being destroyed to complete a release, and the refusal comes
    /// before anything has moved.
    #[serial]
    #[test]
    fn release_refuses_rather_than_overwrite_a_conflicting_base_edit() {
        let (_temp, root) = repo_for_create(None);
        create("clash", None, None, false).unwrap();
        let worktree = worktree_path(&root, "clash");
        fs::write(worktree.join("README.md"), "# the dash's words\n").unwrap();
        fs::write(root.join("README.md"), "# the user's words\n").unwrap();

        let err = release("clash", None).unwrap_err();
        assert!(err.contains("README.md"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# the user's words\n",
            "the base copy is untouched"
        );
        assert!(worktree.exists(), "the dash is left standing");
        assert!(branch_present(&root, "tugdash/clash"));
    }

    #[serial]
    #[test]
    fn release_of_a_clean_worktree_behaves_exactly_as_before() {
        let (_temp, root) = repo_for_create(None);
        create("spotless", None, None, false).unwrap();
        let out = release("spotless", None).unwrap();
        assert!(out.work_restored.is_empty());
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        assert!(!worktree_path(&root, "spotless").exists());
    }

    /// The "I was editing the base and half-way through realised this should be
    /// a dash" gesture. The worktree was cut from the base tip, so the content
    /// the dirt was made against is the content the worktree holds — the
    /// transplant is a copy, and it lands uncommitted because the work is in
    /// progress by definition.
    #[serial]
    #[test]
    fn carry_moves_the_base_working_set_into_the_worktree() {
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("README.md"), "# in progress\n").unwrap();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();

        let out = create("carried", None, None, true).unwrap();
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

        // Uncommitted in the worktree — the dash's first round commits it.
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
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("doomed.txt"), "here\n").unwrap();
        run_git(&root, &["add", "doomed.txt"]);
        run_git(&root, &["commit", "-m", "add doomed"]);
        fs::remove_file(root.join("doomed.txt")).unwrap();

        create("deleter", None, None, true).unwrap();
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
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("README.md"), "staged\n").unwrap();
        run_git(&root, &["add", "README.md"]);

        let out = create("staged", None, None, true).unwrap();
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
        let (_temp, root) = repo_for_create(None);
        fs::write(root.join("fresh.rs"), "brand new\n").unwrap();
        run_git(&root, &["add", "fresh.rs"]);

        let out = create("fresh", None, None, true).unwrap();
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

    /// Apply-all-before-clean-any is what makes tearing the dash down a safe
    /// response to a failed transplant: the base has not been touched yet.
    #[serial]
    #[test]
    fn a_failed_carry_tears_down_and_leaves_the_base_intact() {
        let (_temp, root) = repo_for_create(None);
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

        let err = create("doomed-carry", None, None, true).unwrap_err();
        assert!(err.contains("blocked"), "{err}");
        assert!(!branch_present(&root, "tugdash/doomed-carry"));
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
        let (_temp, root) = repo_for_create(None);
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

        let err = create("unmerged", None, None, true).unwrap_err();
        assert!(err.contains("unmerged"), "{err}");
        assert!(err.contains("clash.txt"), "{err}");
        assert!(!branch_present(&root, "tugdash/unmerged"));
    }

    #[serial]
    #[test]
    fn carry_over_a_clean_base_is_a_no_op() {
        let (_temp, root) = repo_for_create(None);
        let out = create("nothing", None, None, true).unwrap();
        assert!(out.created);
        assert!(out.base_dirt.is_empty());
        assert!(base_working_set_dirt(&root).is_empty());
    }

    /// `--carry` composes with `--plan`: the plan has its own transplant, with
    /// its own receipt and its own commit, so carry leaves it alone and the
    /// file is handled exactly once.
    #[serial]
    #[test]
    fn carry_leaves_the_adopted_plan_to_its_own_transplant() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();

        let out = create("both", None, Some("roadmap/plan.md"), true).unwrap();
        let adopted = out.plan.expect("create --plan returns its receipt");
        assert_eq!(adopted.action, "committed");

        // The plan is committed on the branch; the scratch file is carried and
        // uncommitted. Both are gone from the base.
        assert_eq!(worktree_plan(&root, "both"), TWO_STEP_PLAN);
        assert!(!root.join("roadmap/plan.md").exists());
        assert!(!root.join("scratch.txt").exists());
        assert_eq!(
            fs::read_to_string(worktree_path(&root, "both").join("scratch.txt")).unwrap(),
            "notes\n"
        );
    }

    #[serial]
    #[test]
    fn create_with_a_plan_adopts_an_untracked_base_copy() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));

        let out = create("born-dash", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(out.created);
        let adopted = out.plan.expect("create --plan returns its receipt");
        assert_eq!(adopted.action, "committed");
        assert_eq!(adopted.base_copy, "removed");

        assert_eq!(worktree_plan(&root, "born-dash"), TWO_STEP_PLAN);
        assert!(!root.join("roadmap/plan.md").exists(), "one live copy");
        assert!(base_plan_status(&root).is_empty());
        assert_eq!(
            dash_plan_path(&root, "born-dash").as_deref(),
            Some("roadmap/plan.md")
        );
    }

    #[serial]
    #[test]
    fn create_with_a_plan_carries_a_tracked_dirty_base_copy_across() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);
        let edited = TWO_STEP_PLAN.replace("Some context.", "Some revised context.");
        write_base_plan(&root, &edited);

        let adopted = create("carry-dash", None, Some("roadmap/plan.md"), false)
            .unwrap()
            .plan
            .unwrap();
        assert_eq!(adopted.action, "committed");
        assert_eq!(adopted.base_copy, "restored");
        assert_eq!(worktree_plan(&root, "carry-dash"), edited);
        assert!(base_plan_status(&root).is_empty());
    }

    #[serial]
    #[test]
    fn create_with_a_committed_clean_plan_inherits_it() {
        let (_temp, root) = repo_for_create(Some(TWO_STEP_PLAN));
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "Add the plan"]);

        let adopted = create("clean-dash", None, Some("roadmap/plan.md"), false)
            .unwrap()
            .plan
            .unwrap();
        assert_eq!(adopted.action, "inherited");
        assert_eq!(adopted.base_copy, "untouched");
        assert!(adopted.commit.is_none());
        assert!(root.join("roadmap/plan.md").exists());
    }

    /// Re-running `create --plan` over a live dash is the repair path: the
    /// resume exit returns before hydration, so adoption has to sit there too.
    #[serial]
    #[test]
    fn create_with_a_plan_repairs_an_existing_dash() {
        let (_temp, root) = repo_for_create(None);
        let first = create("repair-dash", None, None, false).unwrap();
        assert!(first.created);
        assert!(
            first.plan.is_none(),
            "a plan-less create carries no receipt"
        );

        write_base_plan(&root, TWO_STEP_PLAN);
        let second = create("repair-dash", None, Some("roadmap/plan.md"), false).unwrap();
        assert!(!second.created, "the dash was already there");
        let adopted = second.plan.expect("the resume exit adopts too");
        assert_eq!(adopted.action, "committed");
        assert_eq!(adopted.base_copy, "removed");
        assert_eq!(worktree_plan(&root, "repair-dash"), TWO_STEP_PLAN);
    }

    /// A transplant that fails takes the whole dash with it, and — by the
    /// engine's ordering — leaves the base copy where the user left it.
    #[serial]
    #[test]
    fn create_rolls_back_when_the_transplant_fails() {
        let (_temp, root) = repo_for_create(None);

        let err = create("doomed-dash", None, Some("roadmap/missing.md"), false).unwrap_err();
        assert!(err.contains("plan not found"), "{err}");
        assert!(!branch_present(&root, "tugdash/doomed-dash"));
        assert!(!worktree_path(&root, "doomed-dash").exists());
    }

    #[test]
    fn legacy_owner_key_strips_the_id_and_passes_legacy_keys_through() {
        assert_eq!(
            legacy_owner_key("tugdash/x#1723500000000-a1b2c3"),
            "tugdash/x"
        );
        assert_eq!(legacy_owner_key("tugdash/x"), "tugdash/x");
        // A name with a dash in it is not a split point — only `#` is.
        assert_eq!(
            legacy_owner_key("tugdash/fix-join#1-abc"),
            "tugdash/fix-join"
        );
    }

    #[test]
    fn minted_ids_are_millis_dash_six_hex_and_do_not_repeat() {
        let a = mint_tugid();
        let b = mint_tugid();
        assert_ne!(a, b, "the nonce keeps same-millisecond mints apart");
        let (millis, nonce) = a.split_once('-').expect("millis-nonce shape");
        assert!(millis.parse::<u128>().unwrap() > 0);
        assert_eq!(nonce.len(), 6);
        assert!(
            nonce
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    /// `create` mints once and every later touch reports the same identity;
    /// a dash with no `tugid` reads under its legacy branch-ref key until a
    /// write verb backfills it ([P01], [P02], Risk R01).
    #[serial]
    #[test]
    fn test_dash_id_minted_once_and_backfilled_on_write() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let first = create("id-dash", None, None, false).unwrap();
        let id = first.id.clone().expect("create mints an id");
        assert!(id.starts_with("tugdash/id-dash#"), "owner key shape: {id}");

        // The idempotent revisit reports the same identity, not a fresh mint.
        let second = create("id-dash", None, None, false).unwrap();
        assert!(!second.created);
        assert_eq!(second.id.as_deref(), Some(id.as_str()));

        // Every read verb agrees.
        assert_eq!(dash_owner_key(repo, "id-dash"), id);
        assert_eq!(show("id-dash").unwrap().id.as_deref(), Some(id.as_str()));
        let listed = list().unwrap();
        let entry = listed.iter().find(|d| d.name == "id-dash").unwrap();
        assert_eq!(entry.id.as_deref(), Some(id.as_str()));

        // An id-less dash (an older build's) reads under the legacy key, and a
        // read verb must not mint one ([P02]).
        run_git(repo, &["config", "--unset", "branch.tugdash/id-dash.tugid"]);
        assert_eq!(dash_owner_key(repo, "id-dash"), "tugdash/id-dash");
        let _ = show("id-dash").unwrap();
        assert_eq!(dash_owner_key(repo, "id-dash"), "tugdash/id-dash");

        // A round is a write path: it backfills.
        fs::write(repo.join(".tug/worktrees/id-dash/f.txt"), "x\n").unwrap();
        commit("id-dash", "Add f", None).unwrap();
        let backfilled = dash_owner_key(repo, "id-dash");
        assert!(backfilled.starts_with("tugdash/id-dash#"));
        assert_ne!(
            backfilled, id,
            "the backfill is a fresh mint, not the old id"
        );
    }

    /// The stage precedence table ([P03]): landing outranks a declaration, a
    /// declaration outranks a draft, a draft outranks activity, activity
    /// outranks a fresh dash.
    #[test]
    fn stage_derivation_follows_its_precedence() {
        // An undeclared dash derives exactly what it always did.
        assert_eq!(derive_stage(0, false, false, false, None), "created");
        assert_eq!(derive_stage(1, false, false, false, None), "working");
        assert_eq!(derive_stage(0, true, false, false, None), "working");
        assert_eq!(derive_stage(2, true, true, false, None), "draft-ready");
        // A draft with no work yet is still draft-ready — the draft is the
        // stronger signal.
        assert_eq!(derive_stage(0, false, true, false, None), "draft-ready");
        // A landing in flight outranks everything below it.
        assert_eq!(derive_stage(3, true, true, true, None), "landing");
        assert_eq!(derive_stage(0, false, false, true, None), "landing");

        let stepping = Some(DashDeclaration::Step {
            current: 3,
            total: 9,
        });
        // Declarations outrank a draft — a planned run writes its draft before
        // the audit, so a draft that won would hide `built` and `audited`.
        assert_eq!(derive_stage(2, true, true, false, stepping), "implementing");
        assert_eq!(
            derive_stage(2, true, true, false, Some(DashDeclaration::Built)),
            "built"
        );
        assert_eq!(
            derive_stage(2, true, true, false, Some(DashDeclaration::Audited)),
            "audited"
        );
        // …and a landing still outranks a declaration.
        assert_eq!(derive_stage(2, true, true, true, stepping), "landing");
    }

    /// `status` walks a dash's whole lifecycle: fresh → a round → an authored
    /// draft → an interrupted landing (Spec S05, [P06]).
    #[serial]
    #[test]
    fn test_dash_status_reports_each_stage() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        let changes_db = temp.path().join("changes.db");
        {
            let conn = rusqlite::Connection::open(&changes_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE changeset_drafts (
                    owner_kind   TEXT NOT NULL,
                    owner_id     TEXT NOT NULL,
                    project_dir  TEXT NOT NULL,
                    fingerprint  TEXT NOT NULL,
                    message      TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    edited       INTEGER NOT NULL DEFAULT 0,
                    selection    TEXT,
                    PRIMARY KEY (owner_kind, owner_id, project_dir)
                );",
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", &changes_db);
        }

        let created = create("status-dash", Some("Test".to_string()), None, false).unwrap();
        let owner_key = created.id.clone().unwrap();

        let fresh = status("status-dash").unwrap();
        assert_eq!(fresh.stage, "created");
        assert_eq!(fresh.id, owner_key);
        assert_eq!(fresh.branch, "tugdash/status-dash");
        assert_eq!(fresh.base_branch, "main");
        assert_eq!(fresh.rounds, 0);
        assert!(!fresh.draft);
        assert!(fresh.join_journal_phase.is_none());
        // Phase 3's slots stay empty here ([P06]).
        assert!(fresh.step_current.is_none() && fresh.step_total.is_none());

        // Uncommitted work is already `working`.
        let worktree = repo.join(".tug/worktrees/status-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        let dirty = status("status-dash").unwrap();
        assert_eq!(dirty.stage, "working");
        assert!(dirty.worktree_dirty);

        commit("status-dash", "Add f", None).unwrap();
        let after_round = status("status-dash").unwrap();
        assert_eq!(after_round.stage, "working");
        assert_eq!(after_round.rounds, 1);
        assert!(!after_round.worktree_dirty);

        // An authored draft, under the id-qualified key writers use.
        {
            let conn = rusqlite::Connection::open(&changes_db).unwrap();
            let project = fs::canonicalize(repo)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            conn.execute(
                "INSERT INTO changeset_drafts
                    (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
                 VALUES ('dash', ?1, ?2, 'fp', 'Land the work', 1, 1)",
                rusqlite::params![owner_key, project],
            )
            .unwrap();
        }
        let drafted = status("status-dash").unwrap();
        assert_eq!(drafted.stage, "draft-ready");
        assert!(drafted.draft);

        // An interrupted landing leaves a journal, and outranks the draft.
        // Written against the canonical repo path, which is what
        // `find_repo_root` (and so `status`) resolves — the state-dir slug
        // must agree.
        let canonical_repo = fs::canonicalize(repo).unwrap();
        write_join_journal(
            &canonical_repo,
            &JoinJournal {
                name: "status-dash".to_string(),
                base_branch: "main".to_string(),
                strategy: "squash".to_string(),
                commit_hash: "abc1234".to_string(),
                phase: JoinPhase::WorktreeRemoved,
                message: None,
            },
        )
        .unwrap();
        let landing = status("status-dash").unwrap();
        assert_eq!(landing.stage, "landing");
        assert_eq!(
            landing.join_journal_phase.as_deref(),
            Some("WorktreeRemoved")
        );

        // No sessions.db with a binding, so the dash reads as parked ([P08]).
        assert!(landing.bound_sessions.is_empty());

        assert!(status("no-such-dash").is_err());

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }
    }

    /// `bound_sessions` counts **live** sessions only, so a dash whose only
    /// bound card has closed reads as parked ([P08]) — the CLI-side face of
    /// the [L27] pin.
    #[serial]
    #[test]
    fn test_dash_status_bound_sessions_are_live_only() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let sessions_db = temp.path().join("sessions.db");
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                    session_id   TEXT PRIMARY KEY,
                    state        TEXT NOT NULL,
                    last_used_at INTEGER NOT NULL,
                    dash_id      TEXT
                );",
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_SESSIONS_DB", &sessions_db);
        }

        let owner_key = create("parked-dash", None, None, false)
            .unwrap()
            .id
            .unwrap();
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute(
                "INSERT INTO sessions (session_id, state, last_used_at, dash_id)
                 VALUES ('sess-live', 'live', 2, ?1), ('sess-closed', 'closed', 1, ?1)",
                rusqlite::params![owner_key],
            )
            .unwrap();
        }

        assert_eq!(
            status("parked-dash").unwrap().bound_sessions,
            vec!["sess-live".to_string()],
            "a closed session's row is never reported as a mating"
        );

        // With the last live session closed, the dash is parked.
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute("UPDATE sessions SET state = 'closed'", [])
                .unwrap();
        }
        assert!(status("parked-dash").unwrap().bound_sessions.is_empty());

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_SESSIONS_DB");
        }
    }

    #[serial]
    #[test]
    fn test_dash_create_basic() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let result = create("test-dash", Some("desc".to_string()), None, false);
        assert!(result.is_ok());

        assert!(repo.join(".tug/worktrees/test-dash").exists());
        assert!(branch_present(repo, "tugdash/test-dash"));

        // Base branch is recorded in git config.
        let base = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", "branch.tugdash/test-dash.tugbase"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&base.stdout).trim(), "main");
    }

    #[serial]
    #[test]
    fn test_dash_create_idempotent() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("first".to_string()), None, false).unwrap();
        // Second create returns the existing dash without error.
        let result = create("test-dash", Some("second".to_string()), None, false);
        assert!(!result.unwrap().created);
        assert!(repo.join(".tug/worktrees/test-dash").exists());
    }

    #[serial]
    #[test]
    fn test_dash_create_runs_post_create_once() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        // Append a line to a marker file each time the hook runs.
        write_config(repo, &["echo ran >> hook-marker.txt"]);
        std::env::set_current_dir(repo).unwrap();

        create("hooky", None, None, false).unwrap();
        let marker = repo.join(".tug/worktrees/hooky/hook-marker.txt");
        assert!(marker.exists(), "post_create should run on creation");
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);

        // Idempotent resume must NOT re-run the hook.
        create("hooky", None, None, false).unwrap();
        assert_eq!(
            fs::read_to_string(&marker).unwrap().lines().count(),
            1,
            "post_create must not run on idempotent resume"
        );
    }

    #[serial]
    #[test]
    fn test_dash_create_failing_hook_rolls_back() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        write_config(repo, &["exit 1"]);
        std::env::set_current_dir(repo).unwrap();

        let result = create("doomed", None, None, false);
        assert!(result.is_err(), "failing hook should fail create");

        // Rollback: neither worktree nor branch survive.
        assert!(!repo.join(".tug/worktrees/doomed").exists());
        assert!(!branch_present(repo, "tugdash/doomed"));

        // A retry (with a passing hook) then succeeds cleanly.
        write_config(repo, &[]);
        let retry = create("doomed", None, None, false);
        assert!(retry.is_ok());
        assert!(repo.join(".tug/worktrees/doomed").exists());
    }

    #[serial]
    #[test]
    fn test_dash_commit_with_changes_writes_log() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), None, false).unwrap();

        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "content\n").unwrap();

        let result = commit("test-dash", "Add test file", None);
        assert!(result.unwrap().committed);

        // A new commit landed on the dash branch.
        let count = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-list", "--count", "main..tugdash/test-dash"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "1");

        // The dash-log got a line naming the dash.
        let log = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            log.contains("test-dash"),
            "dash-log should record the commit: {log}"
        );
    }

    #[serial]
    #[test]
    fn test_dash_commit_no_changes() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), None, false).unwrap();

        let result = commit("test-dash", "No changes", None);
        assert!(!result.unwrap().committed);

        // No commit ahead of base.
        let count = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-list", "--count", "main..tugdash/test-dash"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "0");
    }

    #[serial]
    #[test]
    fn test_dash_commit_multibyte_summary_does_not_panic() {
        // A multibyte summary longer than 72 bytes must not panic on a byte
        // slice, and `--message` must remain the commit subject.
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();

        // A long multibyte summary that straddles byte 72 (100 bytes, 50 chars).
        let meta = DashRoundMeta {
            instruction: Some("i".to_string()),
            summary: Some("é".repeat(50)),
        };
        commit("test-dash", "feat: thing", Some(meta)).unwrap();

        // The subject is the --message; the summary rode into the body.
        let subject = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%s", "tugdash/test-dash"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&subject.stdout).trim(),
            "feat: thing"
        );
    }

    #[serial]
    #[test]
    fn test_dash_commit_round_meta_writes_instruction() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        std::env::set_current_dir(repo).unwrap();
        redirect_state_dir(&home);

        create("test-dash", Some("Test".to_string()), None, false).unwrap();

        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        // The verbatim instruction is git's one gap — it must reach the dash-log.
        let meta = DashRoundMeta {
            instruction: Some("add test file".to_string()),
            summary: Some("Added test file".to_string()),
        };
        commit("test-dash", "Test commit", Some(meta)).unwrap();

        let log = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            log.contains("add test file"),
            "log should carry the instruction: {log}"
        );
    }

    #[serial]
    #[test]
    fn test_dash_list_and_show() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("dash1", None, None, false).unwrap();
        create("dash2", None, None, false).unwrap();

        assert_eq!(list().unwrap().len(), 2);
        assert!(show("dash1").is_ok());
        assert!(show("nonexistent").is_err());
    }

    #[serial]
    #[test]
    fn test_dash_join_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test dash".to_string()), None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("feature.txt"), "new feature\n").unwrap();
        commit("test-dash", "Add feature", None).unwrap();

        let result = join(
            "test-dash",
            JoinOptions {
                message: Some("Add new feature".to_string()),
                ..Default::default()
            },
        );
        assert!(result.is_ok());

        // Squash commit on base, worktree + branch gone.
        let log = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "--oneline", "-1"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("tugdash(test-dash):"));
        assert!(!worktree.exists());
        assert!(!branch_present(repo, "tugdash/test-dash"));

        // dash-log records the terminal action.
        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("joined"),
            "dash-log should record join: {dlog}"
        );
    }

    /// The route that asked for a landing is recorded in the dash-log's
    /// terminal note, so a join is attributable to the CLI or the card after
    /// the fact rather than only to "something".
    #[serial]
    #[test]
    fn a_join_records_the_route_that_asked_for_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("routed", None, None, false).unwrap();
        fs::write(repo.join(".tug/worktrees/routed/f.txt"), "work\n").unwrap();
        commit("routed", "Add f", None).unwrap();

        join(
            "routed",
            JoinOptions {
                origin: Some("card".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("joined via card"),
            "dash-log should name the route: {dlog}"
        );
    }

    /// A release records its route the same way — its marker already carries
    /// the word `released`, so the note carries the route alone.
    #[serial]
    #[test]
    fn a_release_records_the_route_that_asked_for_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("dropped", None, None, false).unwrap();
        release("dropped", Some("cli")).unwrap();

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("released  via cli"),
            "dash-log should name the route: {dlog}"
        );
    }

    /// A join with no explicit message uses the dash's maintained draft from
    /// the machine-global changes ledger (`TUG_CHANGES_DB`) as its squash
    /// message — pins `dash_draft_message` reading
    /// `changes.changeset_drafts`, not the legacy per-instance `sessions.db`.
    #[serial]
    #[test]
    fn test_dash_join_uses_changes_ledger_draft_message() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        // Seed the machine-global draft row under the canonical repo
        // spelling (Spec S05 write contract).
        let changes_db = temp.path().join("changes.db");
        {
            let conn = rusqlite::Connection::open(&changes_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE changeset_drafts (
                    owner_kind   TEXT NOT NULL,
                    owner_id     TEXT NOT NULL,
                    project_dir  TEXT NOT NULL,
                    fingerprint  TEXT NOT NULL,
                    message      TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    edited       INTEGER NOT NULL DEFAULT 0,
                    selection    TEXT,
                    PRIMARY KEY (owner_kind, owner_id, project_dir)
                );",
            )
            .unwrap();
            let project = fs::canonicalize(repo)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            conn.execute(
                "INSERT INTO changeset_drafts
                    (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
                 VALUES ('dash', 'tugdash/draft-dash', ?1, 'fp', 'Land the drafted work', 1, 1)",
                rusqlite::params![project],
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", &changes_db);
        }

        create("draft-dash", Some("Test".to_string()), None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/draft-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("draft-dash", "Add f", None).unwrap();

        // Preview first (`/join`'s beat 1): in-memory, clean, mutates nothing.
        let preview = join(
            "draft-dash",
            JoinOptions {
                preview: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(preview.previewed);
        assert!(preview.conflicts.is_empty(), "clean preview");
        assert!(preview.commit_hash.is_none(), "a preview lands nothing");
        assert!(
            worktree.exists() && branch_present(repo, "tugdash/draft-dash"),
            "a preview tears nothing down"
        );

        // Execute: the squash message comes from the ledger draft.
        join("draft-dash", JoinOptions::default()).unwrap();

        // SAFETY: serial test; clear before the next test resolves the path.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }

        let log = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let body = String::from_utf8_lossy(&log.stdout);
        assert!(
            body.contains("tugdash(draft-dash): Land the drafted work"),
            "squash message comes from the changes-ledger draft: {body}"
        );
        assert!(
            body.contains("Tug-Dash: tugdash/draft-dash onto "),
            "the squash carries the Tug-Dash trailer: {body}"
        );
    }

    /// Round commits and the join/squash commit carry the `Tug-Dash:` trailer
    /// ([P08], Spec S02). With no `TUG_SESSION_ID` in the environment the
    /// `Tug-Session:` trailer is omitted (no error).
    /// A join reaches the dash's draft under the id-qualified owner key — the
    /// key writers use once a dash has a creation id ([P01], [P03], Spec S02).
    /// Same fixture as the legacy-key case above; only the key differs.
    #[serial]
    #[test]
    fn test_dash_join_uses_id_keyed_draft_message() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        let changes_db = temp.path().join("changes.db");
        {
            let conn = rusqlite::Connection::open(&changes_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE changeset_drafts (
                    owner_kind   TEXT NOT NULL,
                    owner_id     TEXT NOT NULL,
                    project_dir  TEXT NOT NULL,
                    fingerprint  TEXT NOT NULL,
                    message      TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    edited       INTEGER NOT NULL DEFAULT 0,
                    selection    TEXT,
                    PRIMARY KEY (owner_kind, owner_id, project_dir)
                );",
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", &changes_db);
        }

        let created = create("id-draft-dash", Some("Test".to_string()), None, false).unwrap();
        let owner_key = created.id.expect("created dash has an owner key");
        assert!(owner_key.contains('#'), "id-qualified: {owner_key}");

        // Seed the draft under the owner key the writers now use.
        {
            let conn = rusqlite::Connection::open(&changes_db).unwrap();
            let project = fs::canonicalize(repo)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            conn.execute(
                "INSERT INTO changeset_drafts
                    (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
                 VALUES ('dash', ?1, ?2, 'fp', 'Land the id-keyed work', 1, 1)",
                rusqlite::params![owner_key, project],
            )
            .unwrap();
        }

        let worktree = repo.join(".tug/worktrees/id-draft-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("id-draft-dash", "Add f", None).unwrap();

        join("id-draft-dash", JoinOptions::default()).unwrap();

        let log = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "--format=%B", "-1"])
            .output()
            .unwrap();
        let body = String::from_utf8_lossy(&log.stdout);
        assert!(
            body.contains("Land the id-keyed work"),
            "the id-keyed draft is the squash message: {body}"
        );

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }
    }

    #[serial]
    #[test]
    fn test_dash_commits_carry_dash_trailer() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("trailer-dash", Some("Test".to_string()), None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/trailer-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("trailer-dash", "Add f", None).unwrap();

        let round = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let round = String::from_utf8_lossy(&round.stdout);
        assert!(
            round.contains("Tug-Dash: tugdash/trailer-dash onto "),
            "round commit carries Tug-Dash: {round}"
        );
        // Only assert absence when the environment genuinely lacks the id, so
        // the test never flakes on a runner that happens to export it. Both
        // keys travel together — neither lands without the other.
        if std::env::var("TUG_SESSION_ID").is_err() {
            assert!(
                !round.contains("Tug-Session:"),
                "no session env → no Tug-Session: {round}"
            );
            assert!(
                !round.contains("Tug-Session-Id:"),
                "no session env → no Tug-Session-Id: {round}"
            );
        }

        join(
            "trailer-dash",
            JoinOptions {
                message: Some("Land it".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let squash = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let squash = String::from_utf8_lossy(&squash.stdout);
        assert!(
            squash.contains("tugdash(trailer-dash):"),
            "squash subject stays tugdash(<name>): {squash}"
        );
        assert!(
            squash.contains("Tug-Dash: tugdash/trailer-dash onto "),
            "squash commit carries Tug-Dash: {squash}"
        );
    }

    /// The resolution ladder builds a candidate off to the side; `join_in` with
    /// `candidate` fast-forwards the base onto it and tears the dash down
    /// ([P31]). Uses the replay scenario: base advanced to the dash's first
    /// round, so the squash conflicts but replay is clean.
    #[serial]
    #[test]
    fn test_dash_join_lands_resolved_candidate() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();
        // Baseline file the dash and main both evolve.
        fs::write(repo.join("f.txt"), "A\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "seed f"]);

        create("cand", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/cand");
        fs::write(worktree.join("f.txt"), "B\n").unwrap();
        commit("cand", "r1", None).unwrap();
        fs::write(worktree.join("f.txt"), "C\n").unwrap();
        commit("cand", "r2", None).unwrap();

        // Main independently advances to the dash's first-round state.
        fs::write(repo.join("f.txt"), "B\n").unwrap();
        run_git(repo, &["commit", "-am", "main advances to B"]);

        let outcome = crate::resolve::resolve_conflicts(repo, "cand", None).unwrap();
        assert_eq!(outcome.shape, crate::resolve::JoinShape::Replay);
        let candidate = outcome.candidate_commit.clone().expect("candidate");

        let landed = join(
            "cand",
            JoinOptions {
                candidate: Some(candidate),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(landed.commit_hash.is_some());
        assert_eq!(fs::read_to_string(repo.join("f.txt")).unwrap(), "C\n");
        assert!(!worktree.exists(), "worktree torn down");
        assert!(!branch_present(repo, "tugdash/cand"), "branch deleted");
        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"));
    }

    /// A candidate built against a base head that has since moved must refuse to
    /// land — git's own `--ff-only` is the staleness guard ([P31]).
    #[serial]
    #[test]
    fn test_dash_join_stale_candidate_refused() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("f.txt"), "A\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "seed f"]);

        create("cand", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/cand");
        fs::write(worktree.join("f.txt"), "B\n").unwrap();
        commit("cand", "r1", None).unwrap();
        fs::write(worktree.join("f.txt"), "C\n").unwrap();
        commit("cand", "r2", None).unwrap();
        fs::write(repo.join("f.txt"), "B\n").unwrap();
        run_git(repo, &["commit", "-am", "main to B"]);

        let candidate = crate::resolve::resolve_conflicts(repo, "cand", None)
            .unwrap()
            .candidate_commit
            .expect("candidate");

        // Base moves after the candidate was built.
        fs::write(repo.join("other.txt"), "z\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "base advances again"]);

        let err = join(
            "cand",
            JoinOptions {
                candidate: Some(candidate),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("stale candidate"), "got: {err}");
        // Nothing torn down — the dash survives for a re-resolve.
        assert!(worktree.exists(), "worktree intact after refusal");
        assert!(branch_present(repo, "tugdash/cand"));
    }

    /// Regression: when git's own `worktree remove` refuses (in production, a
    /// mounted-filesystem "Directory not empty" caused by the dash's app still
    /// holding files open; here, a `git worktree lock` that single-`--force`
    /// won't override), `remove_dash_worktree` must still leave the directory
    /// gone via its filesystem-wipe fallback — no stranded worktree, no
    /// warning. This drives the real fallback code path on real files.
    #[serial]
    #[test]
    fn test_remove_dash_worktree_fallback_when_git_refuses() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", None, None, false).unwrap();
        let branch = branch_name("test-dash");
        let worktree = worktree_path(repo, "test-dash");
        assert!(worktree.exists());

        // Lock the worktree so `git worktree remove --force` (single -f)
        // refuses, standing in for the mount-level rmdir failure production
        // hits. Only the filesystem fallback can clear it.
        git_output(repo, &["worktree", "lock", &worktree.to_string_lossy()]).unwrap();
        assert!(
            !git_output(
                repo,
                &["worktree", "remove", "--force", &worktree.to_string_lossy()]
            )
            .unwrap()
            .status
            .success(),
            "precondition: git must refuse to remove the locked worktree"
        );
        assert!(worktree.exists(), "precondition: worktree still present");

        let mut warnings = Vec::new();
        remove_dash_worktree(repo, &branch, &worktree, &mut warnings);

        assert!(!worktree.exists(), "fallback must remove the directory");
        assert!(
            warnings.is_empty(),
            "no warning when the directory is gone: {warnings:?}"
        );
    }

    /// Intersection preflight ([P14]): base dirt blocks a join only when it
    /// touches a file the dash also changed; disjoint base dirt joins fine.
    #[serial]
    #[test]
    fn test_dash_join_intersecting_base_dirt_fails_but_disjoint_joins() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // Two tracked files on base.
        for f in ["shared.txt", "other.txt"] {
            fs::write(repo.join(f), "base\n").unwrap();
        }
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();

        // A dash that changes shared.txt.
        create("isect", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/isect");
        fs::write(worktree.join("shared.txt"), "base\ndash change\n").unwrap();
        commit("isect", "touch shared", None).unwrap();

        // Base dirt on the SAME file the dash changed → refuses, naming it.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let blocked = join("isect", JoinOptions::default());
        assert!(blocked.is_err());
        let err = blocked.unwrap_err();
        assert!(err.contains("also changed"), "{err}");
        assert!(err.contains("shared.txt"), "{err}");
        assert!(branch_present(repo, "tugdash/isect"));

        // Move the base dirt to a DISJOINT file → the join now succeeds.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        let ok = join("isect", JoinOptions::default()).unwrap();
        assert!(ok.commit_hash.is_some());
        assert!(!branch_present(repo, "tugdash/isect"));
    }

    /// Seed a repo with one commit and a dash carrying one round, returning the
    /// repo path's owner so it outlives the call. The shared fixture for the
    /// preview-blocker tests ([P02]).
    fn seed_dash_with_a_round(temp: &TempDir, name: &str) {
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create(name, None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees").join(name);
        fs::write(worktree.join("shared.txt"), "base\ndash change\n").unwrap();
        commit(name, "touch shared", None).unwrap();
    }

    fn preview(name: &str) -> JoinOutcome {
        join(
            name,
            JoinOptions {
                preview: true,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn blocker<'a>(outcome: &'a JoinOutcome, kind: &str) -> Option<&'a JoinBlocker> {
        outcome.blockers.iter().find(|b| b.kind == kind)
    }

    #[serial]
    #[test]
    fn preview_reports_off_base_when_the_root_is_on_another_branch() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "offbase");
        let repo = temp.path();

        assert!(preview("offbase").blockers.is_empty());

        git_output(repo, &["checkout", "-b", "scratch"]).unwrap();
        let out = preview("offbase");
        let b = blocker(&out, "off-base").expect("off-base blocker");
        assert!(b.detail.contains("Check out"), "{}", b.detail);
        assert!(b.paths.is_empty());
    }

    #[serial]
    #[test]
    fn join_outcome_carries_the_message_it_committed() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "msg");
        let repo = temp.path();

        let landed = join(
            "msg",
            JoinOptions {
                message: Some("the override the card sent".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        // The receipt's body is the message the commit actually carries —
        // `integrate_message`'s composition, trailer and all, not the raw
        // override the caller passed. The two are read off one landing rather
        // than composed twice, so the receipt cannot describe a commit that
        // says something else.
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();
        assert_eq!(landed.message.as_deref(), Some(committed.as_str()));
        assert!(
            committed.contains("the override the card sent"),
            "{committed}"
        );
    }

    /// Point the draft reader at an empty tempdir path for the duration of a
    /// (serial) test, so a message composition never reads — or is coloured by —
    /// the live machine ledger.
    fn isolate_changes_db(temp: &TempDir) {
        // SAFETY: these tests are #[serial]; no other thread reads the
        // environment concurrently while this runs.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", temp.path().join("changes.db"));
        }
    }

    /// Seed a draft row directly into the isolated ledger, bootstrapping the
    /// table the way every writer does. `project` is taken verbatim, which is
    /// what lets a test reproduce a pre-fix worktree-keyed row.
    fn seed_draft_row(db: &Path, owner_id: &str, project: &Path, message: &str) {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS changeset_drafts (
                owner_kind   TEXT NOT NULL,
                owner_id     TEXT NOT NULL,
                project_dir  TEXT NOT NULL,
                fingerprint  TEXT NOT NULL,
                message      TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                edited       INTEGER NOT NULL DEFAULT 0,
                selection    TEXT,
                PRIMARY KEY (owner_kind, owner_id, project_dir)
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO changeset_drafts \
             (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited) \
             VALUES ('dash', ?1, ?2, '', ?3, 0, 1)",
            rusqlite::params![owner_id, project.to_string_lossy(), message],
        )
        .unwrap();
    }

    fn canonical(p: &Path) -> std::path::PathBuf {
        fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
    }

    #[serial]
    #[test]
    fn dash_draft_key_is_the_id_qualified_owner_over_the_base_root() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "keyed");
        let repo = temp.path();

        let key = dash_draft_key(repo, "keyed");
        assert!(
            key.owner_id.starts_with("tugdash/keyed#"),
            "{}",
            key.owner_id
        );
        // The bare branch ref is the legacy axis, and appears exactly because
        // `create` minted a tugid that made the two differ.
        assert_eq!(key.legacy_owner_id.as_deref(), Some("tugdash/keyed"));
        assert_eq!(key.project, repo);

        // A dash without a tugid keys under the bare ref, and there is no
        // second owner shape to fall back to.
        git_output(repo, &["config", "--unset", "branch.tugdash/keyed.tugid"]).unwrap();
        let bare = dash_draft_key(repo, "keyed");
        assert_eq!(bare.owner_id, "tugdash/keyed");
        assert_eq!(bare.legacy_owner_id, None);
    }

    /// The pre-fix row shape: `tugutil draft set` ran from inside the worktree
    /// and keyed by its cwd, so the join's base-root probes never matched it.
    /// The bridge finds it until the next authored write supersedes it.
    #[serial]
    #[test]
    fn a_worktree_keyed_row_is_still_found() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "legacy");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &dash_owner_key(repo, "legacy"),
            &canonical(&repo.join(".tug/worktrees/legacy")),
            "the draft nobody could read",
        );
        assert_eq!(
            dash_draft_message(repo, "tugdash/legacy").as_deref(),
            Some("the draft nobody could read")
        );
    }

    #[serial]
    #[test]
    fn the_base_root_row_wins_over_a_worktree_row() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "both");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");
        let owner = dash_owner_key(repo, "both");

        seed_draft_row(
            &db,
            &owner,
            &canonical(&repo.join(".tug/worktrees/both")),
            "the stale worktree row",
        );
        seed_draft_row(&db, &owner, &canonical(repo), "the current row");
        assert_eq!(
            dash_draft_message(repo, "tugdash/both").as_deref(),
            Some("the current row")
        );
    }

    /// A body may already open with this dash's scope — a draft authored in the
    /// conventional voice is the common case, and the doubled subject on the
    /// first real landing is what the un-idempotent wrap looked like in the
    /// commit log.
    #[serial]
    #[test]
    fn integrate_message_does_not_double_this_dashs_own_prefix() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "idem");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
            repo,
            "idem",
            "tugdash/idem",
            Some("tugdash(idem): the authored subject".to_string()),
        );
        assert!(
            out.starts_with("tugdash(idem): the authored subject"),
            "{out}"
        );
        assert_eq!(out.matches("tugdash(idem): ").count(), 1, "{out}");
    }

    /// A foreign scope is stripped too, and this replaces the contract that
    /// used to preserve it. `tugdash(a): tugdash(b): …` was never a good
    /// subject: the composing side owns the scope, so a body arriving with one
    /// is describing the same work rather than naming a second subject.
    #[serial]
    #[test]
    fn integrate_message_strips_a_foreign_scope() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "mine");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
            repo,
            "mine",
            "tugdash/mine",
            Some("tugdash(theirs): borrowed work".to_string()),
        );
        assert!(out.starts_with("tugdash(mine): borrowed work"), "{out}");
        assert_eq!(out.matches("tugdash(").count(), 1, "{out}");
    }

    /// The strip reads a *leading* scope only. A subject that merely mentions
    /// the spelling later keeps every character of it.
    #[serial]
    #[test]
    fn integrate_message_leaves_an_inner_mention_alone() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "inner");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let body = "teach the linter about tugdash(name): prefixes";
        let out = integrate_message(repo, "inner", "tugdash/inner", Some(body.to_string()));
        assert!(out.starts_with(&format!("tugdash(inner): {body}")), "{out}");
    }

    /// A body that opens with the spelling but is not a scope — no closing
    /// paren, or no `: ` after it — is left whole rather than half-eaten.
    #[serial]
    #[test]
    fn integrate_message_leaves_a_malformed_scope_whole() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "malformed");
        isolate_changes_db(&temp);
        let repo = temp.path();

        for body in ["tugdash(unclosed work", "tugdash(x) no colon"] {
            let out = integrate_message(
                repo,
                "malformed",
                "tugdash/malformed",
                Some(body.to_string()),
            );
            assert!(
                out.starts_with(&format!("tugdash(malformed): {body}")),
                "{out}"
            );
        }
    }

    #[serial]
    #[test]
    fn integrate_message_wraps_an_unprefixed_body_and_the_bare_fallback() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "plain");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
            repo,
            "plain",
            "tugdash/plain",
            Some("a plain subject".to_string()),
        );
        assert!(out.starts_with("tugdash(plain): a plain subject"), "{out}");

        // No override, no draft row (the ledger is an empty tempdir path), and
        // no branch description — the bare fallback, still wrapped once.
        let fallback = integrate_message(repo, "plain", "tugdash/plain", None);
        assert!(
            fallback.starts_with("tugdash(plain): Dash work"),
            "{fallback}"
        );
    }

    /// The contract the whole draft feature exists to honor, at the layer that
    /// lands it: when a maintained draft exists and no override is given, the
    /// squash commit's message is the authored draft, prefixed once, plus
    /// exactly the trailers — nothing added, reordered, or regenerated. The
    /// first real dash landing is what this looks like broken, and a string
    /// equality is what makes any future writer or reader drift fail loudly
    /// instead of landing someone else's words.
    #[serial]
    #[test]
    fn the_landing_commits_the_authored_draft_byte_for_byte() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "pinned");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        let draft = "the subject the author wrote\n\nA body paragraph that must survive intact,\nincluding its own line breaks.";
        seed_draft_row(
            &db,
            &dash_owner_key(repo, "pinned"),
            &canonical(repo),
            draft,
        );

        let landed = join("pinned", JoinOptions::default()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        let expected = with_dash_trailers(
            repo,
            "pinned",
            "tugdash/pinned",
            &format!("tugdash(pinned): {draft}"),
        );
        assert_eq!(committed, expected);
        assert!(committed.starts_with("tugdash(pinned): the subject the author wrote\n"));
    }

    /// A draft authored in the conventional voice — which is how a skill writes
    /// one — lands with the subject scoped exactly once.
    #[serial]
    #[test]
    fn a_draft_that_already_carries_the_prefix_lands_it_once() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "once");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &dash_owner_key(repo, "once"),
            &canonical(repo),
            "tugdash(once): the authored subject",
        );

        let landed = join("once", JoinOptions::default()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        assert!(
            committed.starts_with("tugdash(once): the authored subject\n"),
            "{committed}"
        );
        assert_eq!(
            committed.matches("tugdash(once): ").count(),
            1,
            "{committed}"
        );
    }

    #[serial]
    #[test]
    fn preflight_asked_from_a_linked_worktree_answers_about_the_main_root() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "linked");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/linked");

        // The dash's own worktree is checked out on `tugdash/linked`, which is
        // not the base. Asking from there must still answer about the
        // repository — a card whose project *is* a worktree would otherwise
        // read every dash as off-base while the CLI beside it reports clean.
        let from_worktree = join_preflight_in(&worktree, "linked").unwrap();
        assert!(from_worktree.is_empty(), "{from_worktree:?}");
        assert!(join_preflight_in(repo, "linked").unwrap().is_empty());
    }

    /// The same class of bug one field over: `worktree_rel` is stripped against
    /// the *main* root this composition normalizes to, so a consumer that joins
    /// it against the root it asked from gets a path that does not exist — and
    /// every consumer of that path degrades silently. `worktree_abs` is the
    /// answer that does not depend on which root the question came from.
    #[serial]
    #[test]
    fn dash_detail_asked_from_a_linked_worktree_reports_an_absolute_worktree() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "abs");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/abs");

        let from_worktree = dash_detail_entries_in(&worktree);
        let from_root = dash_detail_entries_in(repo);
        let asked_there = from_worktree
            .iter()
            .find(|d| d.name == "abs")
            .expect("the dash is visible from its own worktree");
        let asked_here = from_root
            .iter()
            .find(|d| d.name == "abs")
            .expect("and from the main root");

        // Both spellings must name the same directory. They are compared after
        // canonicalization because a linked worktree resolves its main root
        // through git, which reports macOS's `/private/var` form of a temp dir
        // while the caller holds the `/var` symlink — a difference in spelling,
        // not in answer. What matters is that neither is relative to the root
        // the question came from.
        assert_eq!(
            std::fs::canonicalize(&asked_there.worktree_abs).unwrap(),
            std::fs::canonicalize(&asked_here.worktree_abs).unwrap(),
            "the absolute worktree does not depend on the root asked from"
        );
        assert!(
            Path::new(&asked_there.worktree_abs).is_dir(),
            "and it names a directory that exists: {}",
            asked_there.worktree_abs
        );
    }

    #[serial]
    #[test]
    fn preview_reports_intersecting_base_dirt_and_names_the_paths() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "dirt");
        let repo = temp.path();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "second"]).unwrap();

        // Dirt on a file the dash also changed → blocked, and named.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let out = preview("dirt");
        let b = blocker(&out, "base-dirt").expect("base-dirt blocker");
        assert_eq!(b.paths, vec!["shared.txt".to_string()]);
        assert!(b.detail.contains("shared.txt"), "{}", b.detail);

        // Disjoint dirt → no blocker.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        assert!(blocker(&preview("dirt"), "base-dirt").is_none());
    }

    /// A conflict names a file; the archaeology names what the base did to it.
    /// Only the base commits that touched the conflicted path may appear, and
    /// they appear newest first — a list including the untouching commit would
    /// be worse than none, since the reader would be reading the wrong history.
    #[serial]
    #[test]
    fn a_conflicted_preview_names_the_base_commits_behind_each_path() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "digs");
        let repo = temp.path();

        // Two base commits touch the file the dash also changed, and one does
        // not. Editing it on the base is what makes the merge conflict.
        fs::write(repo.join("shared.txt"), "base\nfirst base edit\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base touches shared once"]).unwrap();
        fs::write(repo.join("other.txt"), "unrelated\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base touches something else"]).unwrap();
        fs::write(repo.join("shared.txt"), "base\nsecond base edit\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base touches shared again"]).unwrap();

        let out = preview("digs");
        assert_eq!(out.conflicts, vec!["shared.txt".to_string()]);
        assert_eq!(out.archaeology.len(), 1, "one conflicted path, one history");
        let history = &out.archaeology[0];
        assert_eq!(history.path, "shared.txt");
        assert_eq!(history.total, 2, "the unrelated commit is not this path's");
        let subjects: Vec<&str> = history.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(
            subjects,
            vec!["base touches shared again", "base touches shared once"],
            "newest first"
        );
        assert!(
            history.commits.iter().all(|c| !c.sha.is_empty()),
            "every row carries its short sha"
        );
    }

    /// The cap bounds what the face renders; `total` is what it counts. A cap
    /// that also truncated the count would make "+N earlier" a lie.
    #[serial]
    #[test]
    fn a_long_base_history_is_capped_but_still_counted() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "deep");
        let repo = temp.path();

        for n in 0..(ARCHAEOLOGY_CAP + 3) {
            fs::write(repo.join("shared.txt"), format!("base\nedit {n}\n")).unwrap();
            git_output(repo, &["add", "."]).unwrap();
            git_output(repo, &["commit", "-m", &format!("base edit {n}")]).unwrap();
        }

        let history = &preview("deep").archaeology[0];
        assert_eq!(history.commits.len(), ARCHAEOLOGY_CAP);
        assert_eq!(history.total, (ARCHAEOLOGY_CAP + 3) as u32);
        assert_eq!(
            history.commits[0].subject,
            format!("base edit {}", ARCHAEOLOGY_CAP + 2),
            "the cap keeps the newest, not the oldest"
        );
    }

    /// Pins the ordering: the preview arm sits above the stale-journal guard,
    /// so a journalled dash previews with a blocker instead of erroring.
    #[serial]
    #[test]
    fn preview_reports_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "journalled");
        let repo = temp.path();

        // The journal's state dir is slugged from the repo's *canonical* path,
        // which on macOS is `/private/var/…` where a TempDir reads `/var/…`.
        let root = std::fs::canonicalize(repo).unwrap();
        write_join_journal(
            &root,
            &JoinJournal {
                name: "journalled".to_string(),
                base_branch: dash_base(repo, "journalled").unwrap(),
                strategy: "squash".to_string(),
                commit_hash: git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
                phase: JoinPhase::Integrated,
                message: None,
            },
        )
        .unwrap();

        let out = preview("journalled");
        let b = blocker(&out, "stale-journal").expect("stale-journal blocker");
        assert!(b.detail.contains("--continue"), "{}", b.detail);
        assert!(
            !b.detail.contains("tugdash join"),
            "the detail must name the real verb: {}",
            b.detail
        );
    }

    #[serial]
    #[test]
    fn preview_reports_empty_for_a_dash_with_no_rounds() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create("hollow", None, None, false).unwrap();

        assert!(blocker(&preview("hollow"), "empty").is_some());

        let worktree = repo.join(".tug/worktrees/hollow");
        fs::write(worktree.join("shared.txt"), "base\nround\n").unwrap();
        commit("hollow", "a round", None).unwrap();
        assert!(blocker(&preview("hollow"), "empty").is_none());
    }

    #[serial]
    #[test]
    fn a_clean_dash_previews_with_no_blockers() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "clean");
        let out = preview("clean");
        assert!(out.previewed);
        assert!(out.conflicts.is_empty());
        assert!(out.blockers.is_empty(), "{:?}", out.blockers);
    }

    /// Every blocker's `detail` is the sentence the execute path refuses with,
    /// so the preview and the land read identically ([P02]).
    #[serial]
    #[test]
    fn preflight_and_the_execute_path_agree() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "agree");
        let repo = temp.path();

        let assert_agrees = |kind: &str| {
            let out = preview("agree");
            let b = blocker(&out, kind).unwrap_or_else(|| panic!("expected a {kind} blocker"));
            let err = join("agree", JoinOptions::default()).unwrap_err();
            assert_eq!(err, b.detail, "{kind}");
        };

        // off-base
        git_output(repo, &["checkout", "-b", "scratch"]).unwrap();
        assert_agrees("off-base");
        git_output(repo, &["checkout", "main"]).unwrap();

        // base-dirt
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        assert_agrees("base-dirt");
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();

        // stale-journal
        let root = std::fs::canonicalize(repo).unwrap();
        write_join_journal(
            &root,
            &JoinJournal {
                name: "agree".to_string(),
                base_branch: dash_base(repo, "agree").unwrap(),
                strategy: "squash".to_string(),
                commit_hash: git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
                phase: JoinPhase::Integrated,
                message: None,
            },
        )
        .unwrap();
        assert_agrees("stale-journal");
        clear_join_journal(&root, "agree");

        // empty — a dash of its own, since the one above has a round.
        create("agree2", None, None, false).unwrap();
        let out = preview("agree2");
        let b = blocker(&out, "empty").expect("empty blocker");
        let err = join("agree2", JoinOptions::default()).unwrap_err();
        assert_eq!(err, b.detail);
    }

    #[serial]
    #[test]
    fn test_dash_join_wrong_branch_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), None, false).unwrap();
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["checkout", "-b", "feature"])
            .output()
            .unwrap();

        let result = join("test-dash", JoinOptions::default());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("on branch 'feature'"));
        assert!(err.contains("Check out 'main' first"));
        assert_eq!(current_branch(repo), "feature");
    }

    #[serial]
    #[test]
    fn test_dash_release_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        let result = release("test-dash", None);
        assert!(result.is_ok());

        assert!(!worktree.exists());
        assert!(!branch_present(repo, "tugdash/test-dash"));

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("released"),
            "dash-log should record release: {dlog}"
        );
    }

    #[serial]
    #[test]
    fn test_dash_release_nonexistent_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let result = release("nonexistent", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[serial]
    #[test]
    fn test_dash_join_already_gone_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();
        commit("test-dash", "Add test", None).unwrap();
        join("test-dash", JoinOptions::default()).unwrap();

        // Joining again fails: the branch no longer exists.
        let result = join("test-dash", JoinOptions::default());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    /// A clean legacy `.tugtree/` worktree migrates to `.tug/worktrees/` on the
    /// next tugdash command; a dirty one stays put and still operates from its
    /// old path ([P13], migration risk mitigation).
    #[serial]
    #[test]
    fn test_legacy_worktree_migrates_but_dirty_stays() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // Stand up two legacy-layout dashes by hand, as pre-migration builds did.
        for name in ["clean", "dirty"] {
            let old = repo.join(format!(".tugtree/tugdash__{name}"));
            let branch = format!("tugdash/{name}");
            assert!(
                git_output(
                    repo,
                    &[
                        "worktree",
                        "add",
                        &old.to_string_lossy(),
                        "-b",
                        &branch,
                        "main"
                    ]
                )
                .unwrap()
                .status
                .success()
            );
            git_output(
                repo,
                &["config", &format!("branch.{branch}.tugbase"), "main"],
            )
            .unwrap();
        }
        fs::write(repo.join(".tugtree/tugdash__dirty/scratch.txt"), "wip\n").unwrap();

        // A single list() runs the migration pass.
        list().unwrap();

        // Clean legacy dash moved to the new home; dirty one stayed at .tugtree.
        assert!(
            repo.join(".tug/worktrees/clean").exists(),
            "clean dash migrated"
        );
        assert!(
            !repo.join(".tugtree/tugdash__clean").exists(),
            "old clean path gone"
        );
        assert!(
            repo.join(".tugtree/tugdash__dirty").exists(),
            "dirty dash stays at .tugtree"
        );
        assert!(
            !repo.join(".tug/worktrees/dirty").exists(),
            "dirty dash did not migrate"
        );

        // The dirty dash still operates from its old path — commit works on it.
        let out = commit("dirty", "wip: scratch", None).unwrap();
        assert!(out.committed, "commit operates on the un-migrated worktree");
    }

    /// Helper: a fresh repo with a dash carrying one commit that adds `f.txt`.
    fn repo_with_committed_dash(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = fs::canonicalize(temp.path()).unwrap();
        init_git_repo(&repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(&repo).unwrap();
        create(name, None, None, false).unwrap();
        let worktree = repo.join(format!(".tug/worktrees/{name}"));
        fs::write(worktree.join("f.txt"), "dash\n").unwrap();
        commit(name, &format!("{name}-only"), None).unwrap();
        (temp, repo)
    }

    #[serial]
    #[test]
    fn test_join_merge_strategy_makes_a_merge_commit() {
        let (_temp, repo) = repo_with_committed_dash("mrg");
        let out = join(
            "mrg",
            JoinOptions {
                strategy: JoinStrategy::Merge,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.commit_hash.is_some());
        assert_eq!(out.strategy, "merge");
        // A `--no-ff` merge commit has two parents.
        let parents = git_stdout(&repo, &["rev-list", "--parents", "-1", "HEAD"]).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "merge commit has two parents: {parents}"
        );
    }

    #[serial]
    #[test]
    fn test_join_rebase_strategy_is_linear() {
        let (_temp, repo) = repo_with_committed_dash("rb");
        join(
            "rb",
            JoinOptions {
                strategy: JoinStrategy::Rebase,
                ..Default::default()
            },
        )
        .unwrap();
        // Base fast-forwarded to the dash commit — linear, message preserved.
        let subject = git_stdout(&repo, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, "rb-only");
        let parents = git_stdout(&repo, &["rev-list", "--parents", "-1", "HEAD"]).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            2,
            "single parent = linear history: {parents}"
        );
    }

    #[serial]
    #[test]
    fn test_join_preview_reports_conflicts_without_touching_tree() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // A tracked file both sides will edit on the same line.
        fs::write(repo.join("conflict.txt"), "line1\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();

        create("pv", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/pv");
        fs::write(worktree.join("conflict.txt"), "dash line\n").unwrap();
        commit("pv", "dash edit", None).unwrap();

        // Base advances with a conflicting edit to the same line.
        fs::write(repo.join("conflict.txt"), "base line\n").unwrap();
        git_output(repo, &["commit", "-am", "base edit"]).unwrap();
        let base_head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        let preview = join(
            "pv",
            JoinOptions {
                preview: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(preview.previewed);
        assert!(preview.commit_hash.is_none());
        assert!(
            preview.conflicts.iter().any(|p| p == "conflict.txt"),
            "preview names the conflict: {:?}",
            preview.conflicts
        );
        // Nothing touched: branch + worktree present, base HEAD unchanged.
        assert!(branch_present(repo, "tugdash/pv"));
        assert!(worktree.exists());
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), base_head);
    }

    #[serial]
    #[test]
    fn test_join_continue_resumes_teardown() {
        // Simulate a crash right after the integrate commit: a journal at phase
        // `Integrated` with the worktree + branch still present. `--continue`
        // must finish the teardown (remove worktree, delete branch, dash-log).
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("resume", None, None, false).unwrap();
        let worktree = repo.join(".tug/worktrees/resume");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("resume", "add f", None).unwrap();

        // Do the integrate by hand, then journal it as if we crashed next.
        git_output(repo, &["merge", "--squash", "tugdash/resume"]).unwrap();
        git_output(repo, &["commit", "-m", "tugdash(resume): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        // `join` resolves the repo via `find_repo_root` (canonical), so the
        // journal must be written to the canonical state dir to be found.
        let canon = fs::canonicalize(repo).unwrap();
        write_join_journal(
            &canon,
            &JoinJournal {
                name: "resume".to_string(),
                base_branch: "main".to_string(),
                strategy: "squash".to_string(),
                commit_hash: head.clone(),
                phase: JoinPhase::Integrated,
                message: None,
            },
        )
        .unwrap();
        assert!(worktree.exists());
        assert!(branch_present(repo, "tugdash/resume"));

        // A plain join now refuses (journal present); --continue resumes.
        assert!(join("resume", JoinOptions::default()).is_err());
        let out = join(
            "resume",
            JoinOptions {
                continue_join: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.commit_hash.as_deref(), Some(head.as_str()));
        assert!(!worktree.exists(), "worktree removed on continue");
        assert!(
            !branch_present(repo, "tugdash/resume"),
            "branch deleted on continue"
        );
        assert!(
            read_join_journal(&canon, "resume").is_none(),
            "journal cleared on completion"
        );
        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"), "dash-log records the join: {dlog}");
    }
}
