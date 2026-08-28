//! Dash orchestration — the `tugdash` library API.
//!
//! Lightweight, worktree-isolated work units driven entirely on git: a dash
//! *is* a branch (`tugdash/<name>`) plus a worktree
//! (`.tug/worktrees/<name>`; legacy dashes at `.tugtree/tugdash__<name>` migrate
//! on first touch). Its base branch and description live in git
//! config (`branch.tugdash/<name>.{tugbase,description}`); its activity is
//! recorded in the per-project append-only dash-log. There is no database.
//!
//! Each verb (`create` / `commit` / `join` / `discard` / `list` / `show`)
//! returns a typed outcome and never prints — the `tugdash` CLI (and the
//! Changeset card, via tugcast) own presentation. Repo resolution is
//! cwd-relative (`find_repo_root`), matching `git`'s own behaviour.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use tugutil_core::{Config, find_repo_root, sanitize_branch_name};

use crate::dash::{
    DashDeclaration, DashDeclarations, DashRoundMeta, FitFact, MarkStage, StepPhase,
    append_dash_log, append_mark_declaration, append_run_through, append_step_declaration,
    detect_default_branch, read_declarations, validate_dash_name,
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
    /// Resume an interrupted join's teardown from its open op-log record.
    pub continue_join: bool,
    /// Land a pre-built candidate commit from the resolution ladder ([P31])
    /// instead of merging the dash branch: the candidate supplies the resolved
    /// **bytes**, `strategy` still decides the **shape**, and the normal
    /// recorded teardown follows. Staleness-guarded by ancestry, the same test
    /// [`crate::resolve::candidate_status`] applies.
    ///
    /// The candidate's own internal shape — one commit on the base, or a chain
    /// of replayed rounds — is an implementation detail of the ladder and never
    /// decides what the base's history looks like.
    pub candidate: Option<String>,
    /// Which route asked for this join — `cli` or `card`. Recorded in the
    /// dash-log's terminal note so a join is attributable after the fact;
    /// `None` writes the bare note the log carried before routes were recorded.
    pub origin: Option<String>,
    /// The session that asked for this join, when the caller knows it — the
    /// pressing card's tug session id, which the CONTROL request already
    /// carries for its receipt ([P06]).
    ///
    /// It is here because the join is executed by **tugcast**, not by the
    /// session: the server exports no `TUG_SESSION_ID`, so without this the
    /// squash commit can name the dash and nothing else, and the History row
    /// shows one pill for work that had a session behind it. `None` falls back
    /// to the running process's own id, which is what the CLI wants.
    pub session_id: Option<String>,
    /// Proceed past the `live-resolve` refusal, tearing down a conflict chain
    /// the lease says somebody may still be working on.
    ///
    /// Consent, not capability: the teardown is unchanged, and the op log's
    /// keepalive already holds the chain so `tugutil dash undo` puts it back.
    /// What the flag adds is a recorded decision and a receipt naming it.
    pub break_lease: bool,
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
    /// What the last green verify said about the tree this join landed —
    /// captured before teardown, because the branch and the dash-log line it
    /// derives from are both gone by the time the outcome is read. Additive:
    /// absent from the JSON when the dash carried no fit fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitFact>,
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
    /// `off-base` | `base-dirt` | `stale-journal` | `live-resolve` | `empty`.
    pub kind: String,
    /// The situation named as a short phrase, for the dialog's title row.
    ///
    /// Server-composed like every other sentence here, and never a second
    /// spelling of `detail` — the two show together, the phrase heading the
    /// act and the sentence stating the fact.
    pub title: String,
    /// The human line — the same sentence the execute path returns as its `Err`.
    pub detail: String,
    /// The offending paths, for `base-dirt`; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// The same paths with what their uncommitted bytes are, for `base-dirt`.
    /// Empty otherwise, and empty on a blocker whose kind has no paths at all.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overlap: Vec<BaseOverlapPath>,
    /// What a `Resolve` on this blocker would do, when one can. Absent on the
    /// kinds nothing here can clear — an off-base checkout, a teardown left by
    /// a crash — which are still reported, and still say what they are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remedy: Option<JoinRemedy>,
}

/// The one way out of a blocker, and the sentence that explains it.
///
/// **The remedy is not in the button.** The sentence carries it, so the reader
/// weighs what will happen before pressing, and the control is always the same
/// word. A blocker nobody at this card can clear still carries the sentence —
/// it says whose turn it is — and `refused` is why its button is dead ([L31]).
///
/// It also does not restate `detail`. The two run one line apart under a
/// register already fronting the detail, so a remedy that named the paths
/// again said the same thing three times over.
#[derive(Debug, Clone, Serialize)]
pub struct JoinRemedy {
    /// What Resolve will do, as one sentence.
    pub explain: String,
    /// Why it cannot be pressed, or absent when it can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// Outcome of [`discard`].
#[derive(Debug, Clone, Serialize)]
pub struct DiscardOutcome {
    pub name: String,
    /// The documents directory a discard left standing ([P11]). A discarded
    /// dash's brief and plan are the only trace of decisions the user may
    /// return to, so discard keeps them and names where they are. Absent when
    /// the dash had no documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documents_kept: Option<String>,
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

/// The commits since `since` that touched any of `paths`, newest first,
/// capped at `cap` lines.
///
/// The anchor for "what changed since this document was written". `since` is a
/// wall-clock instant — the document's own modification time — rather than the
/// commit that last touched it, because a dash's documents are not tracked and
/// so have no such commit; the clause always meant "since the author wrote
/// this", and the mtime is that fact more directly.
///
/// Total: an unborn HEAD, a repo that is not one, and a time git cannot parse
/// all answer with an empty vector, because a rotation must never fail over a
/// paragraph it could have omitted.
pub fn commits_touching_after(
    root: &Path,
    since: SystemTime,
    paths: &[String],
    cap: usize,
) -> Vec<String> {
    if paths.is_empty() || cap == 0 {
        return Vec::new();
    }
    let Ok(epoch) = since.duration_since(SystemTime::UNIX_EPOCH) else {
        return Vec::new();
    };
    // git reads `@<seconds>` as a raw epoch instant in every locale.
    let since = format!("--since=@{}", epoch.as_secs());
    let mut args: Vec<&str> = vec!["log", "--oneline", &since, "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    let Ok(out) = git_stdout(root, &args) else {
        return Vec::new();
    };
    out.lines()
        .filter(|line| !line.trim().is_empty())
        .take(cap)
        .map(str::to_owned)
        .collect()
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

// --- the dash's documents home ---------------------------------------------

/// The directory holding a dash's documents: `<repo>/.tug/dashes/<name>`.
///
/// The directory component is the validated raw name, not
/// [`sanitize_branch_name`]'s spelling: nothing constrains a directory name
/// beyond `validate_dash_name`, so the raw name round-trips and enumeration
/// maps a directory back to its dash with no inverse function.
///
/// `repo` is normalized through [`main_repo_root`] here rather than trusted,
/// because both callers outside this crate hold paths that may be linked
/// worktrees (a card's project directory, the CLI's cwd) and `main_repo_root`
/// is crate-private. Without it a dash worktree would resolve its own empty
/// `.tug/dashes/` and a run would write a second ledger nothing reads.
pub fn documents_dir(repo: &Path, name: &str) -> PathBuf {
    main_repo_root(repo).join(".tug").join("dashes").join(name)
}

/// The dash's brief: `<repo>/.tug/dashes/<name>/brief.md`.
pub fn brief_file(repo: &Path, name: &str) -> PathBuf {
    documents_dir(repo, name).join("brief.md")
}

/// The dash's plan: `<repo>/.tug/dashes/<name>/plan.md`.
pub fn plan_file(repo: &Path, name: &str) -> PathBuf {
    documents_dir(repo, name).join("plan.md")
}

/// Every name under `<repo>/.tug/dashes/` that is a dash with documents.
///
/// Sorted, and filtered twice: the directory name must pass
/// `validate_dash_name`, and the directory must actually hold a brief or a
/// plan. An absent `.tug/dashes` is an empty list, not an error — a repository
/// with no dashes is the ordinary case.
pub fn document_dashes(repo: &Path) -> Vec<String> {
    let root = main_repo_root(repo).join(".tug").join("dashes");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| validate_dash_name(name).is_ok())
        .filter(|name| !DashDocuments::read(repo, name).is_empty())
        .collect();
    names.sort();
    names
}

/// Which of a dash's documents exist, with the first heading of each.
///
/// Absolute paths, present only when the file is there. The title is a
/// convenience for a surface that cannot open the file itself (the deck has no
/// filesystem); a file whose bytes cannot be read leaves the title `None`
/// rather than failing the read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashDocuments {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_title: Option<String>,
}

impl DashDocuments {
    /// Stat both documents of `name` under `repo`.
    pub fn read(repo: &Path, name: &str) -> Self {
        let dir = documents_dir(repo, name);
        let (brief, brief_title) = read_document(&dir.join("brief.md"));
        let (plan, plan_title) = read_document(&dir.join("plan.md"));
        Self {
            brief,
            brief_title,
            plan,
            plan_title,
        }
    }

    /// True when the dash has neither document.
    pub fn is_empty(&self) -> bool {
        self.brief.is_none() && self.plan.is_none()
    }
}

/// A document's absolute path and its first heading's text, when it exists.
fn read_document(path: &Path) -> (Option<String>, Option<String>) {
    if !path.is_file() {
        return (None, None);
    }
    let abs = path.to_string_lossy().to_string();
    let title = std::fs::read_to_string(path).ok().and_then(|text| {
        text.lines()
            .find(|line| line.starts_with('#'))
            .map(heading_text)
    });
    (Some(abs), title)
}

/// The readable text of a markdown heading line: leading `#`s, a trailing
/// `{#anchor}`, and surrounding `**` removed.
fn heading_text(line: &str) -> String {
    let mut text = line.trim_start_matches('#').trim();
    if let Some(open) = text.rfind("{#")
        && text.ends_with('}')
    {
        text = text[..open].trim();
    }
    text.trim_matches('*').trim().to_string()
}

/// A `plan` verb's argument: the dash's name, or a path to a document.
///
/// The shape decides, and the rule is pure so the CLI and the deck agree: an
/// argument carrying a separator, starting with `.`, or ending in `.md` is a
/// path; anything else is a name. A dash named `foo.md` cannot exist —
/// `validate_dash_name` refuses `.` — so the two forms cannot collide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentArgument {
    Name(String),
    Path(PathBuf),
}

impl DocumentArgument {
    pub fn parse(arg: &str) -> Self {
        if arg.contains('/') || arg.contains('\\') || arg.starts_with('.') || arg.ends_with(".md") {
            DocumentArgument::Path(PathBuf::from(arg))
        } else {
            DocumentArgument::Name(arg.to_string())
        }
    }
}

/// Opens the block `tugdash-core` owns inside `.git/info/exclude`.
const TUG_EXCLUDE_BLOCK_START: &str = "# tug:dashes";
/// Closes it. Everything between the two markers is ours; everything outside
/// is the user's and is never reordered, rewritten, or removed. Its own marker
/// pair rather than the attachments module's: two owners editing one block is
/// the drift the pair exists to prevent.
const TUG_EXCLUDE_BLOCK_END: &str = "# end tug:dashes";

/// The exclude-file contents that carry `line`, or `None` when they already do.
///
/// Pure over its inputs: the block arithmetic is the part that can be wrong,
/// and it is tested without touching a repo.
fn exclude_contents_with(existing: &str, line: &str) -> Option<String> {
    let start = existing
        .lines()
        .position(|l| l.trim() == TUG_EXCLUDE_BLOCK_START);
    let end = start.and_then(|from| {
        existing
            .lines()
            .skip(from + 1)
            .position(|l| l.trim() == TUG_EXCLUDE_BLOCK_END)
            .map(|offset| from + 1 + offset)
    });

    let Some((start, end)) = start.zip(end) else {
        let mut out = existing.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(TUG_EXCLUDE_BLOCK_START);
        out.push('\n');
        out.push_str(line);
        out.push('\n');
        out.push_str(TUG_EXCLUDE_BLOCK_END);
        out.push('\n');
        return Some(out);
    };

    if existing
        .lines()
        .skip(start + 1)
        .take(end - start - 1)
        .any(|l| l.trim() == line)
    {
        return None;
    }

    let mut out = String::new();
    for (i, existing_line) in existing.lines().enumerate() {
        if i == end {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(existing_line);
        out.push('\n');
    }
    Some(out)
}

/// Keep `<repo>/.tug/` out of git, for a project whose `.gitignore` does not.
///
/// Every dash artifact in the tree lives under `.tug/` — the worktrees, and now
/// the documents — and a project that never declared it would show the whole
/// directory as untracked, dirtying the base checkout in the act of starting a
/// dash. Three choices carry the same weight they carry in tugcast's
/// attachments exclusion:
///
/// - **`.git/info/exclude`, not the project's `.gitignore`.** The exclude file
///   needs no commit and produces no working-tree diff, in a file the user owns.
/// - **An anchored exact path (`/.tug/`), never a bare pattern.**
/// - **The file is found through `--git-common-dir`, never `<root>/.git`.** In a
///   linked worktree — which is what every dash is — `.git` is a file.
///
/// Idempotent and quiet: a project that already ignores `.tug` is left alone,
/// and every failure is logged nowhere and propagated nowhere. A document that
/// landed on disk must not be reported as failed because a housekeeping write
/// did.
pub fn ensure_tug_excluded(repo: &Path) {
    let repo = main_repo_root(repo);
    // The trailing slash matters: a `.tug/` pattern only matches a directory,
    // and `check-ignore` on a bare `.tug` that does not exist yet reads as a
    // file and answers "not ignored".
    if git_output(&repo, &["check-ignore", "-q", ".tug/"]).is_ok_and(|out| out.status.success()) {
        return;
    }
    let Ok(common_dir) = git_stdout(
        &repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return;
    };
    if common_dir.is_empty() {
        return;
    }
    let info = PathBuf::from(common_dir).join("info");
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let Some(updated) = exclude_contents_with(&existing, "/.tug/") else {
        return;
    };
    if std::fs::create_dir_all(&info).is_err() {
        return;
    }
    let _ = std::fs::write(&exclude, updated);
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

pub fn branch_exists(repo: &Path, branch: &str) -> bool {
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

/// The four branch-config keys a dash carries, each spelled in exactly one
/// place.
///
/// Every one of them hangs off `branch.tugdash/<name>.`, built from the **raw**
/// dash name — not the sanitized spelling `worktree_path` uses for directories.
/// They were previously composed inline at five call sites in three different
/// forms, which is one typo away from a dash that silently forgets its base.
pub(crate) fn base_config_key(name: &str) -> String {
    format!("branch.{}.tugbase", branch_name(name))
}

pub(crate) fn description_config_key(name: &str) -> String {
    format!("branch.{}.description", branch_name(name))
}

/// Resolve a dash's base branch: git config first ([P03]), else detection.
pub(crate) fn dash_base(repo: &Path, name: &str) -> Result<String, String> {
    if let Some(base) = config_get(repo, &base_config_key(name)) {
        return Ok(base);
    }
    detect_default_branch(repo).map_err(|e| e.to_string())
}

// --- dash identity ---------------------------------------------------------

/// A dash's creation id lives in its branch config, beside `tugbase`.
pub(crate) fn tugid_config_key(name: &str) -> String {
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
/// `join_in`/`discard_in` returns can only ever be the legacy form — and every
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
pub(crate) fn run_post_create(repo: &Path, worktree: &Path) -> Result<(), String> {
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
///
/// With `base`, the dash forks from that branch and records it as its
/// `tugbase` instead of consulting [`detect_default_branch`]. A checkout parked
/// off the default branch — a linked worktree under test, say — would otherwise
/// fork a dash from content it is not working on, and the join preflight would
/// later refuse over a base branch nobody has out. A base that does not exist
/// is refused before anything is created. A revisit ignores it: a dash's base
/// is set at birth.
pub fn create(
    name: &str,
    description: Option<String>,
    carry: bool,
    base: Option<&str>,
) -> Result<CreateOutcome, String> {
    validate_dash_name(name).map_err(|e| e.to_string())?;

    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    let base_branch = match base {
        Some(requested) => {
            if !branch_exists(&repo_root, requested) {
                return Err(format!(
                    "base branch '{}' does not exist in {}",
                    requested,
                    repo_root.display()
                ));
            }
            requested.to_string()
        }
        None => detect_default_branch(&repo_root).map_err(|e| e.to_string())?,
    };
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    let have_branch = branch_exists(&repo_root, &branch);
    let have_worktree = worktree.exists();

    // Idempotent: a fully-present dash returns as-is, with no re-hydration.
    if have_branch && have_worktree {
        let description =
            description.or_else(|| config_get(&repo_root, &description_config_key(name)));
        let base = dash_base(&repo_root, name).unwrap_or(base_branch);
        // A revisit is a write-path touch, so an id-less dash from an older
        // build gains its id here ([P02]).
        let id = ensure_dash_id(&repo_root, name).ok();
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
            return Err(format!(
                "failed to delete stale branch {}: {}",
                branch,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }

    // Every dash artifact in the tree lives under `.tug/` — the worktree about
    // to be created, and the documents — so a project that never declared it
    // would show the whole directory as untracked in the act of starting a
    // dash ([P08]).
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
        &["config", &base_config_key(name), &base_branch],
    );
    if let Some(desc) = description.as_deref() {
        let _ = git_output(&repo_root, &["config", &description_config_key(name), desc]);
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

    // By the transplant's apply-all-before-clean-any ordering the base is fully
    // intact when a carry fails, so tearing the dash down costs nothing.
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
        let round_count = dash_rounds(&repo_root, &base, branch).len() as i64;
        let worktree = worktree_path(&repo_root, &name);
        let description = config_get(&repo_root, &description_config_key(&name));

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

    // Commits ahead of base are this dash's rounds ([P02]) — minus the join
    // arc's preflight sweeps, which are plumbing rather than authored work
    // (Spec S03).
    let rounds: Vec<RoundItem> = dash_rounds(&repo_root, &base, &branch)
        .into_iter()
        .map(|r| RoundItem {
            commit_hash: r.hash,
            summary: r.subject,
            started_at: r.committed_at,
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
/// reports it, with the line counts `--numstat` reports for the same range.
/// The caller maps this into its own file row.
#[derive(Debug, Clone, Serialize)]
pub struct DashDetailFile {
    /// Path relative to the repository root. A rename reports its destination.
    pub path: String,
    /// The name-status letter (`A`, `M`, `D`, `R`, …).
    pub status: String,
    /// Lines added, `None` for a binary file or when the numstat read failed.
    pub added: Option<u32>,
    /// Lines deleted, on the same terms.
    pub deleted: Option<u32>,
}

/// What a server-driven arc ([P01]) is doing on this dash, when one is running
/// it at all — `None` for every dash created by hand.
///
/// Reported **beside** [`DashDetail::stage`] and never folded into it.
/// [`derive_stage`] answers "what is this dash doing in git"; this answers
/// "which stage of the arc is driving it". The two disagree routinely and both
/// readings are true: a dash whose git stage reads `working` may be sitting on
/// an arc that stopped in `review`, and a surface that collapsed them would
/// have no way to say so.
#[derive(Debug, Clone, Serialize)]
pub struct DashArcState {
    /// The stage last rotated, or `None` before the first rotation lands.
    pub stage: Option<String>,
    /// Why the arc stopped, when it did ([P11]). Cleared by the next rotation,
    /// because resuming a stopped arc *is* rotating it again.
    pub stopped: Option<String>,
    /// The stage it stopped *in*, which is not necessarily [`Self::stage`]: a
    /// refused rotation stops in the stage it was trying to leave.
    pub stopped_stage: Option<String>,
    /// Whether the arc reached its terminal line.
    pub done: bool,
    /// The arc's most recent note — what it last did, in its own words.
    pub note: Option<String>,
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
    /// Derived stage ([P03]); `joining` requires a join in flight, so callers
    /// that can also see a draft recompute with [`derive_stage`].
    pub stage: String,
    /// How far a stepped run has got, from the latest step declaration.
    pub step_current: Option<u32>,
    pub step_total: Option<u32>,
    /// What `step_current` *is* — the latest `step-start` declaration's title.
    pub step_title: Option<String>,
    /// Which of this dash's documents exist, with absolute paths ([P01]).
    /// Read from `<repo>/.tug/dashes/<name>/` on every composition — there is
    /// no record of where a plan is, because there is no choice to record.
    pub documents: DashDocuments,
    /// Commits the base branch has gained past this dash's merge-base — 0 when
    /// the dash already contains the base tip.
    pub base_ahead: u32,
    /// Base-checkout dirty tracked paths that this dash also changes. The join
    /// preflight computes the same intersection at join time; this says it
    /// the moment the overlap appears, which is usually hours earlier. A
    /// warning, never a trigger — uncommitted work on the base is the user's.
    ///
    /// Literally the same set, from the same function: the dash's changed set
    /// is its committed diff **plus** its worktree's uncommitted tracked paths,
    /// because the join's preamble commits that dirt before joining and it
    /// therefore blocks exactly as a committed change would.
    ///
    /// Each path carries its relation, because the blockers composed from this
    /// turn on it: an identical copy is the dash's own bytes and refuses
    /// nothing ([`overlap_relation`]).
    pub base_overlap: Vec<BaseOverlapPath>,
    /// The untracked half of the same intersection — base-checkout files git
    /// does not track yet, which this dash would overwrite on joining.
    pub base_overlap_untracked: Vec<BaseOverlapPath>,
    /// Whether the worktree holds uncommitted changes to **tracked** files.
    ///
    /// Narrower than [`Self::worktree_dirty`], which counts untracked files
    /// too, and the distinction decides a blocker: the join's preamble commits
    /// tracked dirt, so a dash with no rounds but dirty tracked files is not
    /// empty, while one whose only dirt is an untracked scratch file is.
    pub worktree_dirty_tracked: bool,
    /// Whether this dash has finished the work somebody asked it for, derived
    /// by [`crate::dash::join_ready`] ([P04]). The join pilot and the standing
    /// prompt both act on this and nothing else, so what a face says and what
    /// the arc does cannot disagree.
    pub join_ready: bool,
    /// The final step of the run's declared selection ([P01]), for display and
    /// for tests. `None` for a generation that declared no run.
    pub run_through: Option<u32>,
    /// Whether that declared selection finished.
    pub run_complete: bool,
    /// How far through the *declared run* this dash has got, from
    /// [`crate::dash::run_fraction`] — position within the selection somebody
    /// asked for, which is what every glanceable counter shows.
    ///
    /// Distinct from [`Self::step_current`]/[`Self::step_total`], which stay
    /// plan-absolute: a run of steps 5–7 reports `run_position` 2 while
    /// `step_current` is 6. The ring draws the plan from the latter and lights
    /// this span across it. Both `None` for a generation that declared no run.
    pub run_position: Option<u32>,
    pub run_length: Option<u32>,
    /// The note of the dash-log's most recent `replayed` line — the settled
    /// mark's text. `None` when this dash has never been replayed.
    pub last_replay: Option<String>,
    /// What the last green verify said about the tree a join would land.
    /// `None` when nothing has verified this dash. It says; it gates nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitFact>,
    /// When this dash was last touched: the timestamp of the newest dash-log
    /// line for its current generation, ISO-8601 UTC. `None` for a dash created
    /// before creation wrote a birth record and never logged anything since.
    pub last_activity: Option<String>,
    /// The arc driving this dash ([P01]), when one is. See [`DashArcState`] for
    /// why it sits beside [`Self::stage`] rather than inside it.
    pub arc: Option<DashArcState>,
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
                added: None,
                deleted: None,
            });
        }
    }
    files
}

/// Fold a `--numstat` read over the same range onto the name-status rows,
/// keyed by path. A rename is keyed by its destination on both sides, so the
/// two reads meet; a path the numstat does not name keeps `None`.
fn with_numstat(mut files: Vec<DashDetailFile>, numstat: &str) -> Vec<DashDetailFile> {
    let counts: BTreeMap<String, (Option<u32>, Option<u32>)> =
        tugchanges_core::parse_numstat(numstat)
            .into_iter()
            .map(|e| (e.path, (e.added, e.deleted)))
            .collect();
    for file in &mut files {
        if let Some((added, deleted)) = counts.get(&file.path) {
            file.added = *added;
            file.deleted = *deleted;
        }
    }
    files
}

/// The dash's `base...branch` file list with its line counts: two reads of
/// one range, joined on path. Either read failing degrades — no status read
/// is an empty list, no numstat read is a list without counts.
fn dash_range_files(repo_root: &Path, base: &str, branch: &str) -> Vec<DashDetailFile> {
    let range = format!("{base}...{branch}");
    let files = git_stdout(repo_root, &["diff", "--name-status", &range])
        .ok()
        .map(|out| parse_name_status(&out))
        .unwrap_or_default();
    match git_stdout(repo_root, &["diff", "--numstat", &range]).ok() {
        Some(numstat) => with_numstat(files, &numstat),
        None => files,
    }
}

/// The paths a `git diff --name-status` output names, renames reported at
/// their destination.
pub(crate) fn name_status_paths(output: &str) -> Vec<String> {
    parse_name_status(output)
        .into_iter()
        .map(|file| file.path)
        .collect()
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
    // way every other reader keys them — the derived `joining` stage reads the
    // op log out of the main root's state dir.
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
    let base_untracked = untracked_paths(repo_root);

    let mut entries = Vec::new();
    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches("tugdash/");
        // `dash_base`'s detection fallback, deliberately, rather than the bare
        // `"main"` default the feed's duplicate used: a repo whose default
        // branch is not `main` was silently mis-based there.
        let Ok(base) = dash_base(repo_root, name) else {
            continue;
        };

        // One read serves both the count and the subjects, so the two cannot
        // disagree about what a round is (Spec S03).
        let authored = dash_rounds(repo_root, &base, branch);
        let rounds = authored.len() as u32;

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
        let worktree_dirt_tracked = if worktree_abs.exists() {
            dirty_tracked_paths(&worktree_abs)
        } else {
            Vec::new()
        };
        let worktree_dirty_tracked = !worktree_dirt_tracked.is_empty();

        let files = dash_range_files(repo_root, &base, branch);

        // Round subjects, newest first — what the discard preflight
        // lists ([P14]). Empty when the dash has no rounds.
        let round_subjects: Vec<String> = authored.into_iter().map(|r| r.subject).collect();

        // How far the base has run ahead of this dash, and which of the base
        // checkout's uncommitted edits land on files the dash also changed —
        // the divergence a join would otherwise only reveal at merge time.
        let base_ahead = git_stdout(
            repo_root,
            &["rev-list", "--count", &format!("{branch}..{base}")],
        )
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
        // The dash's changed set is what it has committed plus what its
        // worktree holds uncommitted — the join's preamble commits the latter,
        // so it blocks exactly as a committed change does. Composed through the
        // same intersection the preflight uses, so the two cannot drift.
        let mut dash_changed: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        dash_changed.extend(worktree_dirt_tracked.iter().cloned());
        let overlap = intersect_base_dirt(
            repo_root,
            branch,
            &base_dirt,
            &base_untracked,
            &dash_changed,
        );

        // Two dash-log reads per dash per recompute — the declarations and the
        // arc record, each folding the same small append-only file through its
        // own typed reader. No plan markdown is read here ([P01]): the
        // declarations are the record this path derives from.
        let declarations = read_declarations(repo_root, name);
        let arc = crate::arc::read_arc(repo_root, name).map(|record| DashArcState {
            stage: record.current_stage().map(|s| s.as_str().to_owned()),
            stopped_stage: record
                .stopped
                .as_ref()
                .map(|(stage, _)| stage.as_str().to_owned()),
            stopped: record.stopped.as_ref().map(|(_, reason)| reason.clone()),
            done: record.done,
            note: record.notes.last().cloned(),
        });
        let run_span = crate::dash::run_fraction(&declarations);
        // The other reading of a join in flight, and deliberately the wide
        // one: any teardown under way — live or left by a crash — means this
        // dash is not joinable right now, so readiness stands down either way. The blocker
        // set makes the opposite call for the opposite reason; see
        // `join_blockers_from_detail`.
        let joining = crate::oplog::join_in_flight(repo_root, name).is_some();
        let documents = DashDocuments::read(repo_root, name);
        // Every input is already in hand from this dash's own composition, so
        // readiness costs no extra git call on the recompute's hot path ([P04]).
        let join_ready = crate::dash::join_ready(
            rounds,
            crate::dash::unfinished_tracked_dirt(&worktree_dirt_tracked),
            joining,
            &declarations,
            documents.plan.is_some(),
        );

        entries.push(DashDetail {
            owner_key: dash_owner_key(repo_root, name),
            name: name.to_owned(),
            branch: branch.to_owned(),
            stage: derive_stage(
                rounds as i64,
                worktree_dirty,
                false,
                joining,
                declarations.latest,
                join_ready,
            )
            .to_owned(),
            join_ready,
            run_through: declarations.run_through,
            run_complete: declarations.run_complete,
            run_position: run_span.map(|(position, _)| position),
            run_length: run_span.map(|(_, length)| length),
            step_current: declarations.step.map(|(current, _)| current),
            step_total: declarations.step.map(|(_, total)| total),
            step_title: declarations.step_title.clone(),
            documents,
            base_ahead,
            base_overlap: overlap.tracked,
            base_overlap_untracked: overlap.untracked,
            worktree_dirty_tracked,
            last_replay: declarations.last_replay.clone(),
            fit: fit_fact(repo_root, branch, &base, &declarations),
            last_activity: declarations.last_activity.clone(),
            arc,
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

/// One dash's detail, composed exactly as [`dash_detail_entries_in`] composes
/// every dash's.
///
/// Shares that walk rather than reimplementing it, so a caller asking about one
/// dash and a caller asking about all of them cannot get different answers about
/// the same dash. Returns `None` when the dash has no branch.
pub fn dash_detail_entry_in(repo_root: &Path, name: &str) -> Option<DashDetail> {
    let repo_root = &main_repo_root(repo_root);
    dash_detail_entries_in(repo_root)
        .into_iter()
        .find(|d| d.name == name)
}

/// The fit fact a dash's declarations carry, with its currency resolved
/// against the live tips.
///
/// Both endpoints are compared, because a base that moved invalidates a
/// verified head just as surely as a new round does. An unparseable note
/// yields `None` rather than a fact with half its pair.
pub(crate) fn fit_fact(
    repo: &Path,
    branch: &str,
    base_branch: &str,
    declarations: &DashDeclarations,
) -> Option<FitFact> {
    let note = declarations.last_verified.as_deref()?;
    let (head, base) = crate::dash::parse_verified_note(note)?;
    let live_head = git_stdout(repo, &["rev-parse", branch]).ok();
    let live_base = git_stdout(repo, &["rev-parse", base_branch]).ok();
    let current =
        live_head.as_deref() == Some(head.as_str()) && live_base.as_deref() == Some(base.as_str());
    Some(FitFact {
        head,
        base,
        current,
    })
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
    /// The teardown phase an interrupted join reached, from its open record.
    pub join_journal_phase: Option<String>,
    /// Live sessions mated to this dash ([P08]); empty when unresolvable, when
    /// the binding column has not migrated in yet, or when every bound card
    /// has closed — an empty list is how *unbound* reads.
    pub bound_sessions: Vec<String>,
    /// How far a stepped run has got, from the latest step declaration.
    pub step_current: Option<i64>,
    pub step_total: Option<i64>,
    /// How far through the *declared run* — position within the selection,
    /// where `step_current` is position within the plan. Both `None` for a
    /// generation that declared no run.
    pub run_position: Option<i64>,
    pub run_length: Option<i64>,
    /// What `step_current` *is* — the latest `step-start` declaration's title.
    pub step_title: Option<String>,
    /// Which of this dash's documents exist, with absolute paths ([P01]).
    pub documents: DashDocuments,
    /// When this dash was last touched — the newest dash-log line's timestamp
    /// for the current generation, ISO-8601 UTC.
    pub last_activity: Option<String>,
    /// What the last green verify said about the tree a join would land, and
    /// whether it still stands. Absent when nothing has verified this dash —
    /// which is the honest record of "not verified". It gates nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitFact>,
    /// The standing conflict, when this dash has one.
    ///
    /// Derived at read time from `refs/tug/conflict/<name>` and absent — not
    /// zeroed — when no *valid* chain stands, so the field's presence is the
    /// answer to "is this dash conflicted" and a stale chain can never
    /// masquerade as a live one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictSummary>,
}

/// What a standing conflict looks like from outside: how many paths it holds
/// and how many of them are done.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictSummary {
    /// Paths the ladder could not settle.
    pub paths_total: usize,
    /// How many of those are marker-free at the chain's tip — the resolver's
    /// progress, counted from the tree rather than declared anywhere.
    pub paths_resolved: usize,
    /// Paths a machine rung settled before the ladder gave up.
    pub machine_resolved: usize,
}

/// Summarize a dash's standing conflict, or `None` when none does.
pub fn conflict_summary(repo_root: &Path, name: &str) -> Option<ConflictSummary> {
    let chain = crate::resolve::valid_conflict(repo_root, name)?;
    let paths: Vec<String> = chain.record.paths.iter().map(|p| p.path.clone()).collect();
    // Progress is read off the tip's tree, never declared: a count somebody
    // wrote down is a count that can disagree with the files.
    let still_conflicted = crate::resolve::marker_paths_in_tree(repo_root, &chain.tip, &paths);
    Some(ConflictSummary {
        paths_total: paths.len(),
        paths_resolved: paths.len().saturating_sub(still_conflicted.len()),
        machine_resolved: chain.record.resolved.len(),
    })
}

/// The stage a dash is in, from what git derives and what the dash declared.
///
/// Precedence is
/// `joining > built|audited > ready > implementing > draft-ready > working >
/// created` ([P03], [P07]): a join in flight outranks everything; otherwise a
/// declared mark wins, because the last thing a run said about itself is the
/// truest current answer; a dash the machine derives as joinable reads `ready`;
/// only an undeclared dash falls through to the derived chain, where an
/// authored draft outranks mere activity and any round or worktree dirt
/// outranks a freshly created dash.
///
/// `ready` sits above `implementing` because a finished run's latest
/// declaration is a `step-done` — left below, a completed selection would read
/// as step *m* still being worked, forever.
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
    joining: bool,
    declared: Option<DashDeclaration>,
    join_ready: bool,
) -> &'static str {
    if joining {
        "joining"
    } else if matches!(declared, Some(DashDeclaration::Built)) {
        "built"
    } else if matches!(declared, Some(DashDeclaration::Audited)) {
        "audited"
    } else if join_ready {
        // Above the step arm: a finished run's latest declaration is a
        // `step-done`, which would otherwise read `implementing` forever. Below
        // `built`/`audited` so a dash somebody marked keeps its own word ([P07]).
        "ready"
    } else if declared.is_some() {
        "implementing"
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
/// unbound. Best-effort throughout — no db, no table, no `dash_id` column (an
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
    let rounds = dash_rounds(repo_root, &base_branch, &branch).len() as i64;

    let worktree = worktree_path(repo_root, name);
    let worktree_dirty = worktree.exists()
        && git_stdout(&worktree, &["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);

    // Readiness is measured over tracked dirt only ([P04]), which the porcelain
    // read above cannot answer — an untracked scratch file makes `worktree_dirty`
    // true and must not make the dash unready, or `dash status` would disagree
    // with the feed about the same dash. This is the CLI path, not the
    // recompute, so the extra git call costs the hot path nothing.
    let worktree_dirt_tracked = if worktree.exists() {
        dirty_tracked_paths(&worktree)
    } else {
        Vec::new()
    };
    let documents = DashDocuments::read(repo_root, name);

    let draft = dash_draft_message(repo_root, &branch).is_some();
    let join_journal_phase = crate::oplog::join_in_flight(repo_root, name)
        .and_then(|op| op.join)
        .map(|progress| format!("{:?}", progress.phase));
    let bound_sessions = bound_sessions_for(&id);
    let declarations = read_declarations(repo_root, name);
    let run_span = crate::dash::run_fraction(&declarations);
    let fit = fit_fact(repo_root, &branch, &base_branch, &declarations);
    let join_ready = crate::dash::join_ready(
        rounds.max(0) as u32,
        crate::dash::unfinished_tracked_dirt(&worktree_dirt_tracked),
        join_journal_phase.is_some(),
        &declarations,
        documents.plan.is_some(),
    );

    Ok(DashStatus {
        stage: derive_stage(
            rounds,
            worktree_dirty,
            draft,
            join_journal_phase.is_some(),
            declarations.latest,
            join_ready,
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
        run_position: run_span.map(|(position, _)| position as i64),
        run_length: run_span.map(|(_, length)| length as i64),
        step_title: declarations.step_title.clone(),
        documents,
        last_activity: declarations.last_activity.clone(),
        fit,
        conflict: conflict_summary(repo_root, name),
    })
}

/// [`status_in`] against the cwd's repo — the CLI's entry point.
pub fn status(name: &str) -> Result<DashStatus, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    status_in(&repo_root, name)
}

// --- steps ([P04], [P08]) --------------------------------------------------

/// What one `dash step` verb did (Spec S02).
#[derive(Debug, Clone, Serialize)]
pub struct StepOutcome {
    pub dash: String,
    /// The absolute path of the plan whose ledger moved.
    pub plan: String,
    pub step: u32,
    /// Ledger rows in the plan — the `N` of `i/N`.
    pub total: u32,
    /// The status the row now carries.
    pub status: String,
    /// The commit recorded in the row, on `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The run's declared final step — the `--through <m>` of [P01]. Present on
    /// a start, and on a done when the generation has declared a run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<u32>,
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
    commit: Option<&str>,
    through: Option<u32>,
) -> Result<StepOutcome, String> {
    let branch = branch_name(name);
    let worktree = worktree_path(repo_root, name);
    if !branch_exists(repo_root, &branch) || !worktree.exists() {
        return Err(format!("Dash not found or not active: {}", name));
    }

    let abs = plan_file(repo_root, name);
    let rel = abs.display().to_string();
    if !abs.is_file() {
        return Err(format!("dash '{name}' has no plan at {rel}"));
    }
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

    // The run's selection is declared before its first step moves, so a run that
    // dies after the start still says what it set out to do ([P01], Spec S01).
    let declared = read_declarations(repo_root, name);
    if let Some(through) = through {
        if through < step {
            return Err(format!(
                "--through {through} is before step {step}: it names the final step of this run's selection"
            ));
        }
        let through_anchor = format!("step-{through}");
        if !doc.ledger_rows.iter().any(|r| r.anchor == through_anchor) {
            return Err(format!("{rel}: no ledger row for #{through_anchor}"));
        }
        if declared.run_through != Some(through) {
            append_run_through(repo_root, name, through).map_err(|e| e.to_string())?;
        }
    }
    let through = through.or(declared.run_through);

    let status = match phase {
        StepPhase::Start => "in progress",
        StepPhase::Done => "done",
        StepPhase::Withdrawn => "withdrawn",
    };
    // A withdrawal records no commit, because none was made — so its note tail
    // falls through to the step's title, the grammar a `step-start` writes.
    let sha = match phase {
        StepPhase::Start | StepPhase::Withdrawn => None,
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
        plan: rel,
        step,
        total,
        status: status.to_string(),
        commit: sha,
        through,
    })
}

/// Begin a step: the ledger row goes `in progress` and the log records it.
///
/// Idempotent on a row already `in progress` ([P04]), so an interrupted run
/// re-enters the step it was on without a hand-edit.
///
/// `through` is the final step of this run's selection, which the log records
/// so the join can tell a finished run from a paused one ([P01]).
pub fn step_start(name: &str, step: u32, through: u32) -> Result<StepOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    step_in(
        &repo_root,
        name,
        step,
        StepPhase::Start,
        None,
        Some(through),
    )
}

/// Finish a step: the ledger row goes `done` and records the round's commit.
pub fn step_done(name: &str, step: u32, commit: Option<&str>) -> Result<StepOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    step_in(&repo_root, name, step, StepPhase::Done, commit, None)
}

/// Withdraw a step: the ledger row goes `withdrawn` and the commit cell stays
/// empty, because a step nobody walked produced no round.
///
/// A withdrawal closes the step and advances the run exactly as a completion
/// does, so withdrawing a run's final selected step arms the join rather than
/// wedging the dash. It is reversible through `step_start`.
pub fn step_withdraw(name: &str, step: u32) -> Result<StepOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    migrate_worktrees(&repo_root, &mut Vec::new());
    step_in(&repo_root, name, step, StepPhase::Withdrawn, None, None)
}

/// Move the base checkout's uncommitted working set into the fresh dash
/// worktree, leaving it there **uncommitted** ([P06]).
///
/// This is the "I was editing the base and half-way through realised this
/// should be a dash" gesture. The worktree was cut from the base tip, so the
/// content the dirt was made against is the content the worktree holds — the
/// transplant is a copy, never a patch application.
///
/// The ordering is not negotiable: **every path is applied to the worktree
/// before any base copy is touched.** A failure in the apply phase leaves the
/// base entirely intact, which is what makes tearing the dash down a safe
/// response to it.
///
/// Returns the entries it moved, in census order.
fn carry_working_set_in(repo_root: &Path, worktree: &Path) -> Result<Vec<BaseDirtPath>, String> {
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
    // A round commit runs inside the session that made it, so the env answers.
    let commit_message = with_dash_trailers(&repo_root, name, &branch, &commit_message, None);

    // Stage and commit, re-attempting past a held `index.lock` (Spec S02) —
    // the join's preflight sweep commits into this same worktree, and
    // whichever writer lost the race used to die outright.
    let mut last_error = String::new();
    let mut result: Option<Option<String>> = None;
    for attempt in 0..INDEX_LOCK_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(INDEX_LOCK_BACKOFF);
        }
        let stage = git_output(&worktree, &["add", "-A"])?;
        if !stage.status.success() {
            let stderr = String::from_utf8_lossy(&stage.stderr).trim().to_string();
            last_error = format!("git add failed: {stderr}");
            if index_lock_blocked(&stderr) {
                continue;
            }
            return Err(last_error);
        }

        // Anything staged? Re-asked on every attempt, which is what makes a
        // concurrent sweep a graceful outcome rather than an error: it took
        // these changes, so this round has nothing left to commit and reports
        // `committed: false` — already a legal outcome for a clean worktree.
        let diff = git_output(&worktree, &["diff", "--cached", "--quiet"])?;
        let has_changes = !diff.status.success(); // exits 1 when there are changes
        if !has_changes {
            result = Some(None);
            break;
        }

        let commit = git_output(&worktree, &["commit", "-m", &commit_message])?;
        if !commit.status.success() {
            let stderr = String::from_utf8_lossy(&commit.stderr).trim().to_string();
            last_error = format!("git commit failed: {stderr}");
            if index_lock_blocked(&stderr) {
                continue;
            }
            return Err(last_error);
        }
        result = Some(Some(git_stdout(
            &worktree,
            &["rev-parse", "--short", "HEAD"],
        )?));
        break;
    }
    // The window closed with the lock still held — the original error, verbatim.
    let Some(commit_hash) = result else {
        return Err(last_error);
    };
    let has_changes = commit_hash.is_some();

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

/// Whether a join of `name` is between its integrate and its end — the bool
/// face of [`crate::oplog::join_in_flight`], for callers that only need to know
/// whether to stand down.
///
/// `main_repo_root` is a filesystem walk, so a caller holding a worktree path
/// reads the right state directory without paying for a git process.
pub fn join_in_flight(repo: &Path, name: &str) -> bool {
    crate::oplog::join_in_flight(&main_repo_root(repo), name).is_some()
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
/// **Who is asked first is the caller's, not the environment's.** A round
/// commit is made by `tugutil dash commit` running *inside* the Claude session,
/// where tugcast exports `TUG_SESSION_ID`, and the env is the whole answer. A
/// **join** is not: the card's press is served by tugcast itself, a process
/// that belongs to no session and exports no such variable — so every join
/// commit ever made carried the dash trailer alone and the History row showed
/// one pill where the work had two. The request already names the pressing
/// card, so the id travels as an argument and the env is the fallback for the
/// callers that have none.
///
/// `None` when it can't be resolved — no id from either source, no
/// `sessions.db`, or no row for that id. Any absence omits both trailers
/// silently: a commit never fails on trailer resolution.
///
/// The citation grammar lives in `tugchanges_core::session_citation`, shared
/// with the deck-commit lane so the two can never drift.
pub(crate) fn session_citation_for(session_id: Option<&str>) -> Option<(String, String)> {
    let session_id = match session_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => std::env::var("TUG_SESSION_ID")
            .ok()
            .filter(|s| !s.is_empty())?,
    };
    let db = sessions_db_file()?;
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    // No row → `query_row` errors → `.ok()?` omits the trailers.
    // The citation names the **line** ([P13]): its callsign, and its eight
    // characters inside the parentheses, so a citation written from inside an
    // arc stage resolves to the conversation rather than to the segment that
    // happened to be seated. `Tug-Session-Id` beside it still pins the exact
    // transcript.
    let (tag, line_id): (String, String) = conn
        .query_row(
            "SELECT l.tag, l.line_id FROM sessions s
             JOIN lines l ON l.line_id = s.line_id
             WHERE s.session_id = ?1",
            rusqlite::params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let citation = tugchanges_core::session_citation(Some(&tag), &line_id);
    Some((citation, session_id))
}

/// Append the session trailers (when resolvable) + `Tug-Dash: <branch> onto
/// <base>` to a dash round-commit or join/squash message ([P08]/[P10], Spec
/// S02/S03). `base` comes from the dash's recorded base branch — the same
/// source `show()` / join use. Idempotent via `append_trailers`, so a draft
/// that already carries a trailer is never duplicated.
///
/// `session` is the id the caller knows, if any — see
/// [`session_citation_for`]; `None` falls back to the process's own.
///
/// The session travels as a **pair**: `Tug-Session` is the human citation and
/// `Tug-Session-Id` the full uuid a reader joins against the ledger. Neither
/// is displayed as body ink — tugcast parses both into typed fields and strips
/// the lines.
fn with_dash_trailers(
    repo: &Path,
    name: &str,
    branch: &str,
    message: &str,
    session: Option<&str>,
) -> String {
    let dash_value = match dash_base(repo, name) {
        Ok(base) if !base.is_empty() => format!("{branch} onto {base}"),
        _ => branch.to_string(),
    };
    let session = session_citation_for(session);
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
///
/// The canonical spelling is the **gateway** form ([L29]) — the same
/// `tugcore::pathform::resolve_to_claude_form` the writer keys on. A bare
/// `std::fs::canonicalize` here would not do: on macOS `realpath(3)` expands
/// the data-volume firmlink to `/System/Volumes/Data/…`, a spelling no writer
/// ever stores, so a base root reached through a firmlink or a
/// `synthetic.conf` alias would read as a different project and the dash's
/// authored draft would silently go missing.
fn project_spellings(dir: &Path) -> Vec<String> {
    let raw = dir.to_string_lossy().into_owned();
    let canonical = tugcore::pathform::resolve_to_claude_form(dir)
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
/// then the legacy `.tugtree/` one, else the new form), so for a **discarded**
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
pub fn integrate_message(
    repo: &Path,
    name: &str,
    branch: &str,
    override_msg: Option<String>,
    session: Option<&str>,
) -> String {
    let subject = match override_msg {
        Some(body) => compose_landing_subject(name, &body),
        None => landing_message_preview(repo, name, branch).0,
    };
    // Subject stays `tugdash(<name>): …`; the trailers ride the body ([P08]).
    with_dash_trailers(repo, name, branch, &subject, session)
}

/// Where a landing message's words came from ([P05]).
///
/// The precedence itself is silent — a forgotten draft lands the branch
/// description, and a dash with neither lands `Dash work` — so the source
/// travels beside the text and the prompt says which one it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandingMessageSource {
    /// The dash's authored join draft.
    Draft,
    /// The branch description, because no draft was written.
    Description,
    /// Neither existed: the message is the generic stand-in.
    Fallback,
}

impl LandingMessageSource {
    /// The wire spelling, which is also what the sheet keys its annotation on.
    pub fn as_str(self) -> &'static str {
        match self {
            LandingMessageSource::Draft => "draft",
            LandingMessageSource::Description => "description",
            LandingMessageSource::Fallback => "fallback",
        }
    }
}

/// Scope-strip a body and wear this dash's own scope — the one composition
/// [`integrate_message`] and [`landing_message_preview`] share, so what the
/// prompt shows and what the join lands cannot drift.
fn compose_landing_subject(name: &str, body: &str) -> String {
    format!("tugdash({}): {}", name, strip_dash_scope(body))
}

/// The message a join would land with right now, and where it came from ([P05]).
///
/// Trailers are omitted: they are composed against the round set at landing
/// time, and a preview that carried them would be showing the user provenance
/// they cannot act on. The subject and body are byte-identical to what
/// [`integrate_message`] would produce with no override.
pub fn landing_message_preview(
    repo: &Path,
    name: &str,
    branch: &str,
) -> (String, LandingMessageSource) {
    let (body, source) = match dash_draft_message(repo, branch) {
        Some(draft) => (draft, LandingMessageSource::Draft),
        None => match config_get(repo, &format!("branch.{}.description", branch)) {
            Some(description) => (description, LandingMessageSource::Description),
            None => ("Dash work".to_string(), LandingMessageSource::Fallback),
        },
    };
    (compose_landing_subject(name, &body), source)
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
pub(crate) fn commit_worktree_dirt(worktree: &Path, name: &str) -> Result<(), String> {
    if !worktree.exists() {
        return Ok(());
    }
    // The subject speaks in the same scope-colon voice the engine's own dash
    // commits wear, so `tug log` on the branch reads as one voice wherever
    // this commit does surface. The trailer is what keeps it from being
    // *counted* as a round: the two are separate jobs, and both are needed.
    let message = tugchanges_core::append_trailers(
        &format!("tugdash({name}): commit outstanding changes"),
        &[(SWEEP_TRAILER_KEY, "1")],
    );
    let mut last_error = String::new();
    for attempt in 0..INDEX_LOCK_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(INDEX_LOCK_BACKOFF);
        }
        // Re-read the status on every attempt, not once before the loop. This
        // is what makes losing the race a graceful yield rather than an error:
        // if the other writer swept the dirt while we waited, there is nothing
        // left to commit, and the act this call exists to produce has already
        // happened ([L31] — the act, not a swallowed failure).
        let dash_status = git_stdout(worktree, &["status", "--porcelain"])?;
        if dash_status.is_empty() {
            return Ok(());
        }
        let add = git_output(worktree, &["add", "-A"])?;
        if !add.status.success() {
            let stderr = String::from_utf8_lossy(&add.stderr).trim().to_string();
            last_error = format!("join: git add in the dash worktree failed: {stderr}");
            if index_lock_blocked(&stderr) {
                continue;
            }
            return Err(last_error);
        }
        let c = git_output(worktree, &["commit", "-m", &message])?;
        if !c.status.success() {
            let stderr = String::from_utf8_lossy(&c.stderr).trim().to_string();
            last_error = format!("join: auto-commit in the dash worktree failed: {stderr}");
            if index_lock_blocked(&stderr) {
                continue;
            }
            return Err(last_error);
        }
        return Ok(());
    }
    // The window closed with the lock still held. The original message goes
    // back verbatim — a retry that rewrote the error would cost the reader the
    // one word (`index.lock`) that says what actually happened.
    Err(last_error)
}

/// The trailer that marks a commit as the join's preflight sweep rather
/// than authored work (Spec S03).
///
/// Written at exactly one site — [`commit_worktree_dirt`] — and read as an
/// exact key match, never as a subject-string pattern. A trailer is a fact the
/// commit carries; a subject is prose, and prose that a rename or a user's own
/// commit could collide with is not an identity.
const SWEEP_TRAILER_KEY: &str = "Tug-Sweep";

/// One authored round on a dash branch.
#[derive(Debug, Clone)]
pub(crate) struct DashRound {
    pub hash: String,
    pub subject: String,
    pub committed_at: String,
}

/// A dash's rounds — every commit ahead of its base **except** the join's
/// preflight sweeps (Spec S03). Newest first, as git logs them.
///
/// This is the one reader. `rounds` was four separate `rev-list --count`s
/// before, which meant the sweep counted as authored work in four places at
/// once — including the round count this phase's own join receipt prints, and
/// the number `join_ready` and `derive_stage` read to decide whether a dash
/// has done anything worth joining. A dash whose only commit is a sweep now
/// reports zero rounds, which is the truth: nothing was authored.
///
/// Sweeps written before the trailer existed carry no mark and still count.
/// They are not rewritten — history is not edited to make a count prettier —
/// and they age out as their dashes join or are discarded.
pub(crate) fn dash_rounds(repo_root: &Path, base: &str, branch: &str) -> Vec<DashRound> {
    // One read for all four fields. `%x1f` (unit separator) divides fields and
    // `%x1e` (record separator) divides commits, because a subject cannot
    // contain either and a trailer value spans to end of line — a plain
    // newline-per-commit format could not tell a two-line record from two.
    let format =
        format!("--format=%h%x1f%s%x1f%cI%x1f%(trailers:key={SWEEP_TRAILER_KEY},valueonly)%x1e");
    let Ok(out) = git_stdout(repo_root, &["log", &format, &format!("{base}..{branch}")]) else {
        return Vec::new();
    };
    out.split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            if record.trim().is_empty() {
                return None;
            }
            let mut parts = record.split('\u{1f}');
            let hash = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let committed_at = parts.next().unwrap_or("").to_string();
            let sweep_mark = parts.next().unwrap_or("");
            // A non-empty trailer field means this commit marked itself.
            if !sweep_mark.trim().is_empty() {
                return None;
            }
            Some(DashRound {
                hash,
                subject,
                committed_at,
            })
        })
        .collect()
}

/// How many times a commit path re-attempts past a held `index.lock`, and how
/// long it waits between attempts — a ~1.5s ceiling (Spec S02).
///
/// The bound is what keeps this a retry rather than a wait: a lock still held
/// after a second and a half is not the other writer finishing its commit, it
/// is a crashed process leaving a file behind, and that wants the error.
const INDEX_LOCK_ATTEMPTS: u32 = 10;
const INDEX_LOCK_BACKOFF: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether a failed git invocation lost the race for the worktree's index
/// rather than failing on its merits.
///
/// Two writers commit into the same dash worktree at the same moment: the join
/// arc's preflight sweep, and a live `tugutil dash commit` closing the run's
/// final step. They want the same dirt, and the loser used to die on
/// `index.lock: File exists` — killing either a join the user had just
/// accepted or the round that ends the run.
///
/// Matched on the lock file's name, which git spells the same way in every
/// message that reports it. One predicate for both sites, so they can never
/// disagree about what is transient.
fn index_lock_blocked(stderr: &str) -> bool {
    stderr.contains("index.lock")
}

fn stale_journal_detail(name: &str) -> String {
    format!(
        "A previous join of dash '{}' is incomplete. Resume it with: tugutil dash join {} --continue",
        name, name
    )
}

/// The receipt a broken lease leaves in the verb's warnings.
fn broke_lease_warning(name: &str, lease: &crate::resolve::ResolveLease, seq: u64) -> String {
    format!(
        "Broke the resolve lease on '{}' (chain tip {} old); the resolver's checkpoints are kept at op #{} — tugutil dash undo restores them.",
        name,
        human_age(lease.age),
        seq
    )
}

/// A duration as a reader would say it: `45s`, `12m`, `1h 20m`.
pub fn human_age(age: Duration) -> String {
    let secs = age.as_secs();
    if secs < 60 {
        return format!("{secs}s");
    }
    let minutes = secs / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

/// What a verb says when the chain says somebody is still resolving.
///
/// **Both ways out, because the sentence has two audiences.** `--break-lease`
/// is a flag no Session card user can reach; the card's way past a lease that
/// outlived its resolver is its Resolve arm, which runs the ladder and starts a
/// fresh chain. A refusal naming only the flag would be a control that does
/// nothing for half the people who read it ([L31]).
pub fn live_resolve_detail(name: &str, lease: &crate::resolve::ResolveLease, verb: &str) -> String {
    format!(
        "A resolve may still be running for dash '{}': its conflict chain was last advanced {} ago, inside the {} lease. Wait for it to finish, resolve again to start a fresh one, or pass `--break-lease` to {} anyway — the resolver's checkpoints are kept by the op log and `tugutil dash undo` puts them back.",
        name,
        human_age(lease.age),
        human_age(crate::resolve::RESOLVE_LEASE),
        verb
    )
}

fn off_base_detail(current_branch: &str, base_branch: &str) -> String {
    format!(
        "Cannot join: repo root worktree is on branch '{}' but dash targets '{}'. Check out '{}' first.",
        current_branch, base_branch, base_branch
    )
}

/// What a divergent base copy of the user's own says.
///
/// It states the fact and stops. The sentence used to end "Commit or stash
/// them first", which named two acts no control in the app performs and, for
/// the commonest case, recommended the wrong one — that case is no longer a
/// refusal at all, and this one has a control of its own.
fn base_dirt_detail(paths: &[String]) -> String {
    format!(
        "Cannot join: your uncommitted edit to {} on the base differs from this dash's version of it.",
        paths.join(", "),
    )
}

/// The same fact when the edit belongs to another live session.
///
/// No remedy rides this one, and that is the honest answer rather than a gap:
/// the edit is somebody's work in progress, and the join unblocks itself the
/// moment they commit or set it aside.
fn foreign_dirt_detail(holder: &str, paths: &[String]) -> String {
    format!(
        "Cannot join: {} holds an uncommitted edit to {} that this dash also changed.",
        holder,
        paths.join(", "),
    )
}

/// Untracked base files the integration would have to write over. `git merge
/// --squash` refuses these outright, so without this they read as a clean
/// preview followed by a failing join.
fn untracked_overwrite_detail(paths: &[String]) -> String {
    format!(
        "Cannot join: untracked files at the repo root would be overwritten by this dash ({}). Move them aside first.",
        paths.join(", "),
    )
}

fn empty_detail(name: &str, base_branch: &str) -> String {
    format!(
        "Nothing to join: dash '{}' has no commits past '{}'. Discard it instead.",
        name, base_branch
    )
}

/// One base path a dash also changed, and what its uncommitted bytes are.
///
/// The relation is the fact everything downstream turns on, and it is worth
/// stating what it means rather than only how it is spelled: `identical` says
/// the base's working copy is **byte for byte the version the dash carries**,
/// which makes restoring it from HEAD lossless — those bytes are on the dash
/// branch, reachable after the restore as they were before it. That guarantee
/// is why a machine may act on this without asking; `divergent` carries no
/// such licence, and is somebody's work.
#[derive(Debug, Clone, Serialize)]
pub struct BaseOverlapPath {
    /// Repo-relative, as git spells it.
    pub path: String,
    /// `identical` | `divergent`.
    pub relation: String,
    /// The live session holding this path, when it is not one working this
    /// dash. Present means the edit is somebody else's in-progress work, which
    /// nothing here may move: folding a half-written edit into a join would
    /// take it out from under the session writing it. Absent means the user's
    /// own, which a resolve may act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
}

/// The base copy is the dash's own bytes; dropping it loses nothing.
pub const OVERLAP_IDENTICAL: &str = "identical";
/// The base copy is other work, and only a person or a merge may decide it.
pub const OVERLAP_DIVERGENT: &str = "divergent";

/// Which of the two a path is, read off the object database.
///
/// Both sides are reduced to a blob id before they are compared — the base's
/// working file through `hash-object`, which applies the same clean filters
/// git applied to what it stored, and the dash's through `rev-parse`. Comparing
/// ids rather than bytes is exact, is one read per side, and gets the filter
/// question right for free; comparing the file's raw bytes against a stored
/// blob would call every filtered file divergent.
///
/// A path absent from **both** sides is identical: the base deleted a file the
/// dash also deleted, and the join's result is the deletion either way.
fn overlap_relation(repo_root: &Path, branch: &str, path: &str) -> String {
    let base_blob = if repo_root.join(path).exists() {
        git_stdout(repo_root, &["hash-object", "--path", path, "--", path]).ok()
    } else {
        None
    };
    let dash_blob = git_stdout(
        repo_root,
        &["rev-parse", "--verify", &format!("{branch}:{path}")],
    )
    .ok();
    if base_blob == dash_blob {
        OVERLAP_IDENTICAL.to_string()
    } else {
        OVERLAP_DIVERGENT.to_string()
    }
}

/// Just the paths, for the sentences and the wire fields that take them.
fn overlap_paths(overlap: &[BaseOverlapPath]) -> Vec<String> {
    overlap.iter().map(|o| o.path.clone()).collect()
}

/// Put the base's identical copies back the way HEAD has them, so the merge
/// may write the paths it owns.
///
/// **This is why the relation is read from the objects.** Every path here holds
/// exactly what the dash branch carries, so the restore destroys nothing: the
/// bytes are reachable at `<branch>:<path>` the instant after, and the join
/// about to run commits those same bytes onto the base. Git refuses the merge
/// regardless of whether the dirty content happens to equal the merge result —
/// it compares against HEAD, not against the result — so a path the join would
/// have written identically still has to be cleared by hand, and this is the
/// hand.
///
/// The untracked half is removed rather than restored, HEAD having nothing to
/// restore it to, and on the same guarantee.
///
/// Every drop is reported. A file the user last saw as uncommitted work is now
/// committed work, which is a fact about their checkout they are owed.
fn drop_identical_base_copies(
    repo_root: &Path,
    droppable: &BlockingBasePaths,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    for entry in &droppable.tracked {
        git_stdout(repo_root, &["checkout", "HEAD", "--", &entry.path])
            .map_err(|e| format!("failed to drop the base's copy of {}: {e}", entry.path))?;
    }
    for entry in &droppable.untracked {
        let path = repo_root.join(&entry.path);
        std::fs::remove_file(&path)
            .map_err(|e| format!("failed to drop the base's copy of {}: {e}", entry.path))?;
    }
    let dropped = [
        overlap_paths(&droppable.tracked),
        overlap_paths(&droppable.untracked),
    ]
    .concat();
    if !dropped.is_empty() {
        warnings.push(format!(
            "Dropped the base checkout's uncommitted copy of {} — this dash carries the same bytes, and lands them.",
            dropped.join(", ")
        ));
    }
    Ok(())
}

/// The base paths that would block a join, split by why they block.
#[derive(Debug, Clone, Default)]
struct BlockingBasePaths {
    /// Tracked paths with uncommitted changes.
    tracked: Vec<BaseOverlapPath>,
    /// Untracked paths the integration would have to write over.
    untracked: Vec<BaseOverlapPath>,
}

impl BlockingBasePaths {
    fn is_empty(&self) -> bool {
        self.tracked.is_empty() && self.untracked.is_empty()
    }

    /// Partition on the one question that decides what the join does: whether
    /// the base's copy is bytes the dash already carries. The first half still
    /// refuses; the second the join simply drops.
    fn split_on_relation(self) -> (BlockingBasePaths, BlockingBasePaths) {
        let identical = |o: &BaseOverlapPath| o.relation == OVERLAP_IDENTICAL;
        let (tracked_drop, tracked_block): (Vec<_>, Vec<_>) =
            self.tracked.into_iter().partition(identical);
        let (untracked_drop, untracked_block): (Vec<_>, Vec<_>) =
            self.untracked.into_iter().partition(identical);
        (
            BlockingBasePaths {
                tracked: tracked_block,
                untracked: untracked_block,
            },
            BlockingBasePaths {
                tracked: tracked_drop,
                untracked: untracked_drop,
            },
        )
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
    intersect_base_dirt(
        repo_root,
        branch,
        &base_dirt,
        &base_untracked,
        &dash_changed,
    )
}

/// The intersection itself, over sets the caller has already read.
///
/// Split out so the per-dash detail walk — which has hoisted the base's dirty
/// set above its loop, and already holds each dash's changed file list — can
/// reach the same answer without re-running the reads, and, more importantly,
/// without a second definition of what "blocking" means. The card's early
/// warning and the join's refusal are the same set because they are the same
/// function.
///
/// Each surviving path is read for its relation ([`overlap_relation`]) — two
/// object reads on a set that is empty in the ordinary case, and small in
/// every other, because it is already an intersection.
fn intersect_base_dirt(
    repo_root: &Path,
    branch: &str,
    base_dirt: &[String],
    base_untracked: &[String],
    dash_changed: &[String],
) -> BlockingBasePaths {
    let read = |p: &String| BaseOverlapPath {
        relation: overlap_relation(repo_root, branch, p),
        path: p.clone(),
        // Whose work it is arrives with the caller ([`attach_holders`]); git
        // cannot answer it, and this function reads only git.
        holder: None,
    };
    BlockingBasePaths {
        tracked: base_dirt
            .iter()
            .filter(|p| dash_changed.contains(p))
            .map(read)
            .collect(),
        untracked: base_untracked
            .iter()
            .filter(|p| dash_changed.contains(p))
            .map(read)
            .collect(),
    }
}

/// The repository root a dash operation works against.
///
/// A dash's branch, its worktree, and its op log all live in the main
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
    let detail =
        dash_detail_entry_in(repo_root, name).ok_or_else(|| format!("Dash not found: {}", name))?;
    let current = current_branch(repo_root)?;
    // No occupancy view from a CLI process, and none wanted: a join in flight
    // refuses a join started from here whether or not the server is mid-join.
    // Which is exactly why the resolve lease exists — the one occupancy fact a
    // second process can still read, because it is written in git.
    Ok(join_blockers_from_detail(
        repo_root,
        &detail,
        &current,
        None,
        // The CLI has no attribution view — it is the running instance's. A
        // preflight from here therefore reads every overlap as the user's own,
        // which is the right default for a person at a terminal in their own
        // checkout.
        &BTreeMap::new(),
    ))
}

/// What a `resolve-base` did.
#[derive(Debug, Clone, Serialize)]
pub struct ResolveBaseOutcome {
    pub name: String,
    /// The commit the fold made on the base, when there was divergent work to
    /// fold. Absent when every overlapping path was the dash's own bytes and
    /// dropping them was the whole of the job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed: Option<String>,
    /// Paths folded into that commit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<String>,
    /// Paths dropped as the dash's own bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dropped: Vec<String>,
    pub warnings: Vec<String>,
}

/// Clear the base-side work that is refusing this dash's join.
///
/// **It clears the block and stops.** Landing stays the user's own gesture —
/// which is why the control that runs this reads `Resolve` and not `Resolve and
/// join`, and why nothing here calls [`join_in`].
///
/// Two things happen, in the order that makes a refusal cost nothing. Paths the
/// dash already carries byte for byte are dropped ([`drop_identical_base_copies`]).
/// Paths that are the user's own divergent work are **committed onto the base
/// as their own commit**, which is the whole of the fold: from that commit
/// forward the two sides are ordinary git history, so a collision between the
/// user's edit and the dash's is an ordinary base-versus-dash conflict and
/// reaches the resolution ladder that every join conflict already reaches. No
/// new merge machinery, and no third side for the ladder to learn.
///
/// It is one commit, with its own message naming what it is, and it is
/// op-logged: `tugutil dash undo` resets the base back and leaves the same
/// content uncommitted, exactly where the user had it.
///
/// A path another live session holds is refused by name and nothing is
/// touched — folding a half-written edit into a join would take it out from
/// under whoever is writing it. `live_dirt` is the caller's, on the same terms
/// as [`join_blockers_from_detail`]'s.
pub fn resolve_base_in(
    repo_root: &Path,
    name: &str,
    live_dirt: &BTreeMap<String, String>,
) -> Result<ResolveBaseOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(&repo_root, &branch) {
        return Err(format!("no such dash: '{name}'"));
    }
    let base_branch = dash_base(&repo_root, name)?;
    let current_branch = git_stdout(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch != base_branch {
        return Err(off_base_detail(&current_branch, &base_branch));
    }
    let worktree = worktree_path(&repo_root, name);

    let (blocking, droppable) =
        blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch).split_on_relation();

    // Every refusal first, so a resolve that cannot finish has moved nothing
    // ([L28]).
    let held = attach_holders(&blocking.tracked, live_dirt)
        .into_iter()
        .chain(attach_holders(&blocking.untracked, live_dirt))
        .filter(|o| o.holder.is_some())
        .collect::<Vec<_>>();
    if let Some(first) = held.first() {
        return Err(foreign_dirt_detail(
            first.holder.as_deref().unwrap_or_default(),
            &overlap_paths(&held),
        ));
    }
    if blocking.is_empty() && droppable.is_empty() {
        return Err(format!(
            "Nothing to resolve: no uncommitted work on '{base_branch}' touches what dash '{name}' changed."
        ));
    }

    let mut warnings = Vec::new();
    let folded = [
        overlap_paths(&blocking.tracked),
        overlap_paths(&blocking.untracked),
    ]
    .concat();
    let dropped = [
        overlap_paths(&droppable.tracked),
        overlap_paths(&droppable.untracked),
    ]
    .concat();

    let op_before = crate::oplog::capture_before(&repo_root, name)?;
    let op_tips = crate::oplog::tips_of(&op_before);
    let op_seq = crate::oplog::record_begin(
        &repo_root,
        crate::oplog::OpVerb::ResolveBase,
        name,
        op_before,
        &op_tips,
    )?;

    drop_identical_base_copies(&repo_root, &droppable, &mut warnings)?;

    let committed = if folded.is_empty() {
        None
    } else {
        let message = fold_commit_message(name, &folded);
        // Untracked paths are not in the index, and a pathspec commit refuses
        // a pathspec git does not know. Staging first covers the add/add case
        // — the base created a file the dash also creates — which is a real
        // shape of this blocker and not an edge.
        let mut add = vec!["add", "--"];
        add.extend(folded.iter().map(String::as_str));
        git_stdout(&repo_root, &add)
            .map_err(|e| format!("failed to stage the base's work in progress: {e}"))?;
        let mut args = vec!["commit", "-m", &message, "--"];
        args.extend(folded.iter().map(String::as_str));
        git_stdout(&repo_root, &args)
            .map_err(|e| format!("failed to commit the base's work in progress: {e}"))?;
        Some(git_stdout(&repo_root, &["rev-parse", "HEAD"])?)
    };

    crate::oplog::record_complete(
        &repo_root,
        op_seq,
        crate::oplog::OpAfter {
            base_tip: Some(git_stdout(&repo_root, &["rev-parse", &base_branch])?),
            ..Default::default()
        },
    )?;

    Ok(ResolveBaseOutcome {
        name: name.to_string(),
        committed,
        folded,
        dropped,
        warnings,
    })
}

/// The message the fold's commit carries.
///
/// It says what the commit is and stops. A machine writing prose about work it
/// did not do is the thing to avoid here, so it does not describe the change —
/// it describes the *act*, which is the part the machine actually performed,
/// and names the paths so the log reads without the op record beside it.
fn fold_commit_message(dash: &str, paths: &[String]) -> String {
    format!(
        "Commit base work in progress to unblock the join of {}\n\n{}\n\nThis commit was made by `tugutil dash resolve-base` to clear a join blocked by uncommitted work on these paths. `tugutil dash undo` reverses it and leaves the same content uncommitted.\n",
        dash,
        paths
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// Attach each overlapping path's holder — the live session whose work it is.
///
/// `live_dirt` maps a base path to the display name of the live session that
/// holds it — the changeset feed's own attribution, **passed rather than read**
/// for the same reason `held` is: it is an in-process view a crate away, and a
/// second definition of it here would be free to disagree with the one the
/// Changes card renders.
///
/// The map arrives already scoped to sessions that are **not** working this
/// dash — a session mated to it is no stranger to its files, and its dirt is
/// the user's own by every reading that matters here. That scoping belongs to
/// the caller, which is the half that knows the bindings.
fn attach_holders(
    overlap: &[BaseOverlapPath],
    live_dirt: &BTreeMap<String, String>,
) -> Vec<BaseOverlapPath> {
    overlap
        .iter()
        .map(|o| BaseOverlapPath {
            holder: live_dirt.get(&o.path).cloned(),
            ..o.clone()
        })
        .collect()
}

/// Split what still blocks into the user's own and somebody else's, each
/// carrying the sentence its case earns.
fn base_dirt_blockers(blocking: Vec<BaseOverlapPath>, untracked: bool) -> Vec<JoinBlocker> {
    let (foreign, mine): (Vec<_>, Vec<_>) = blocking.into_iter().partition(|o| o.holder.is_some());
    let mut out = Vec::new();
    if !mine.is_empty() {
        out.push(JoinBlocker {
            kind: "base-dirt".to_string(),
            title: if untracked {
                "An untracked file in the way".to_string()
            } else {
                "Base work in the way".to_string()
            },
            detail: if untracked {
                untracked_overwrite_detail(&overlap_paths(&mine))
            } else {
                base_dirt_detail(&overlap_paths(&mine))
            },
            paths: overlap_paths(&mine),
            remedy: Some(JoinRemedy {
                explain: "Resolve commits that work onto the base as its own commit, so the join can reconcile the two versions. Undo puts it back uncommitted.".to_string(),
                refused: None,
            }),
            overlap: mine,
        });
    }
    // One blocker per holder, so the sentence can name whose turn it is
    // rather than saying "somebody" over a list belonging to two people.
    let mut by_holder: BTreeMap<String, Vec<BaseOverlapPath>> = BTreeMap::new();
    for entry in foreign {
        by_holder
            .entry(entry.holder.clone().unwrap_or_default())
            .or_default()
            .push(entry);
    }
    for (holder, entries) in by_holder {
        out.push(JoinBlocker {
            kind: "base-dirt".to_string(),
            title: "Another session's edit".to_string(),
            detail: foreign_dirt_detail(&holder, &overlap_paths(&entries)),
            paths: overlap_paths(&entries),
            remedy: Some(JoinRemedy {
                explain: format!(
                    "When {holder} commits that edit or sets it aside, this join unblocks by itself."
                ),
                refused: Some(format!("Held by {holder}")),
            }),
            overlap: entries,
        });
    }
    out
}

/// What would refuse a join right now, composed from a detail the caller
/// already holds.
///
/// **Never cache this.** Every input is something that moves without moving a
/// SHA: a join in flight, which branch the base checkout has out, and the
/// working-tree dirt on both sides. A blocker set cached against the two heads
/// keeps refusing a join whose real answer changed the moment the user
/// cleaned their checkout — which is a face that lies, and the specific failure
/// this whole seam exists to prevent. It is cheap instead of cached: every git
/// read but one is already paid for by the detail walk, and the exception
/// (which branch is checked out) is per-repository rather than per-dash.
///
/// `held` says which run holds this dash right now — `"join"`, `"resolve"`, or
/// `None` for nobody, exactly what tugcast's in-process occupancy registry
/// answers. It is the one input the caller must supply: see the in-flight note
/// in the body for why the answer cannot be read from disk. A caller with no
/// occupancy view passes `None` and is answered from git alone, which is what
/// the resolve lease below is for.
///
/// `live_dirt` is the second such input, and the second for the same reason:
/// base paths another live session holds, mapped to its display name, already
/// scoped to sessions that are not working this dash ([`attach_holders`]). An
/// empty map reads every overlap as the user's own.
pub fn join_blockers_from_detail(
    repo_root: &Path,
    detail: &DashDetail,
    current_branch: &str,
    held: Option<&str>,
    live_dirt: &BTreeMap<String, String>,
) -> Vec<JoinBlocker> {
    let name = detail.name.as_str();
    let base_branch = detail.base.as_str();
    let mut blockers = Vec::new();

    // A join in flight means *a join owns this dash*, and that reading splits
    // on one fact this function cannot see: whether anybody is still running. A
    // join advances its record's phase at each teardown boundary and completes
    // it at the end, so for the whole squash-to-record window the record is
    // open while the join is perfectly healthy. Only a teardown nobody holds is
    // stale.
    //
    // A *resolve* holding the dash does not excuse it: it would be
    // running over a crashed join's leavings, and the refusal is still right.
    //
    // `held` is passed rather than read because the holder registry is
    // in-process and lives a crate away — the same reason `pilot_action` takes
    // its facts rather than fetching them.
    if held != Some("join") && crate::oplog::join_in_flight(repo_root, name).is_some() {
        blockers.push(JoinBlocker {
            kind: "stale-journal".to_string(),
            title: "A join left a teardown behind".to_string(),
            detail: stale_journal_detail(name),
            paths: vec![],
            overlap: vec![],
            remedy: None,
        });
    }

    if current_branch != base_branch {
        blockers.push(JoinBlocker {
            kind: "off-base".to_string(),
            title: "The base is on another branch".to_string(),
            detail: off_base_detail(current_branch, base_branch),
            paths: vec![],
            overlap: vec![],
            remedy: None,
        });
    }

    // Only the paths that are somebody's work. A base copy the dash already
    // carries byte for byte is dropped by the join rather than refused over,
    // so reporting it here would be a refusal the join does not make — the
    // face and the act have to be the same answer.
    let still_blocks = |o: &&BaseOverlapPath| o.relation != OVERLAP_IDENTICAL;
    let tracked_blocking: Vec<BaseOverlapPath> = detail
        .base_overlap
        .iter()
        .filter(still_blocks)
        .cloned()
        .collect();
    let untracked_blocking: Vec<BaseOverlapPath> = detail
        .base_overlap_untracked
        .iter()
        .filter(still_blocks)
        .cloned()
        .collect();

    blockers.extend(base_dirt_blockers(
        attach_holders(&tracked_blocking, live_dirt),
        false,
    ));
    blockers.extend(base_dirt_blockers(
        attach_holders(&untracked_blocking, live_dirt),
        true,
    ));

    // Only when nobody in this process holds the dash: the in-process registry
    // is exact and instant, and the lease is the two-hour derived answer for
    // the case it cannot see — another process entirely.
    if held.is_none()
        && let Some(lease) = crate::resolve::resolve_lease(repo_root, name, SystemTime::now())
    {
        blockers.push(JoinBlocker {
            kind: "live-resolve".to_string(),
            title: "A resolve is running".to_string(),
            detail: live_resolve_detail(name, &lease, "join"),
            paths: vec![],
            overlap: vec![],
            remedy: None,
        });
    }

    // Empty is a *finding* on the preview path, not a refusal: the card's answer
    // to it is the discard affordance. The execute path auto-commits worktree
    // dirt before testing `ahead`, so dirt makes a dash non-empty here too.
    if detail.rounds == 0 && !detail.worktree_dirty_tracked {
        blockers.push(JoinBlocker {
            kind: "empty".to_string(),
            title: "Nothing to join".to_string(),
            detail: empty_detail(name, base_branch),
            paths: vec![],
            overlap: vec![],
            remedy: None,
        });
    }

    blockers
}

/// Resolve a revision to its commit sha.
///
/// Exposed because a cache keyed by a head pair has to be able to read that
/// pair cheaply — two of these are what a cache hit costs.
pub fn rev_parse(repo_root: &Path, rev: &str) -> Result<String, String> {
    git_stdout(&main_repo_root(repo_root), &["rev-parse", rev])
}

/// Which branch the repository has checked out.
///
/// A property of the repository rather than of any dash, so a composition
/// covering many dashes reads it once and passes it down — the one blocker
/// input the per-dash detail walk does not already hold.
pub fn current_branch(repo_root: &Path) -> Result<String, String> {
    git_stdout(
        &main_repo_root(repo_root),
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
}

/// The conflict half of a join preview: what `merge-tree` says, plus the base
/// archaeology behind it, plus the two heads the answer was computed from.
#[derive(Debug, Clone)]
pub struct JoinConflicts {
    pub conflicts: Vec<String>,
    pub archaeology: Vec<ConflictHistory>,
    pub base_sha: String,
    pub dash_sha: String,
}

/// Probe a dash's conflict set without touching anything.
///
/// **This half is cacheable**, and it is the expensive one: `merge-tree` plus a
/// `git log` per conflicted path. It is a pure function of the two heads it
/// reports, which is what makes a cache keyed by that pair sound — unlike the
/// blockers ([`join_blockers_from_detail`]), which move without either head
/// moving and must never be cached.
pub fn join_conflicts_in(repo_root: &Path, name: &str) -> Result<JoinConflicts, String> {
    let repo_root = &main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    if !git_supports_merge_tree(repo_root) {
        return Err(
            "a join preview requires git >= 2.38 (git merge-tree --write-tree).".to_string(),
        );
    }
    let base_branch = dash_base(repo_root, name)?;
    let conflicts = merge_tree_conflicts(repo_root, &base_branch, &branch)?;
    let archaeology = conflict_archaeology(repo_root, &base_branch, &branch, &conflicts);
    Ok(JoinConflicts {
        conflicts,
        archaeology,
        base_sha: git_stdout(repo_root, &["rev-parse", &base_branch])?,
        dash_sha: git_stdout(repo_root, &["rev-parse", &branch])?,
    })
}

/// Join a dash into its base branch ([P14]): `--strategy squash|merge|rebase`,
/// a `--preview` (in-memory `git merge-tree`, nothing touched), an
/// intersection-aware preflight (base dirt blocks only when it overlaps the
/// dash's changed set), a clean abort on conflict with the structured conflict
/// list, and a recorded teardown resumable via `--continue`. The default
/// squash/merge message is the maintained dash draft, else the description.
pub fn join(name: &str, opts: JoinOptions) -> Result<JoinOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    join_in(&repo_root, name, opts)
}

/// Like [`join`], but against an explicit repo root instead of discovering it
/// from the process cwd — for callers such as tugcast that serve many projects
/// and must never depend on `current_dir`.
pub fn join_in(repo_root: &Path, name: &str, opts: JoinOptions) -> Result<JoinOutcome, String> {
    join_in_with_progress(repo_root, name, opts, |_, _| {})
}

/// [`join_in`], narrating itself as it goes.
///
/// `on_beat(beat, status)` fires around each of the join's real boundaries,
/// with `status` one of `start` / `done`:
///
/// | Beat | What it surrounds |
/// |---|---|
/// | `squash` | the integrate — squash-merge and commit, of the dash branch or of a resolved candidate, per `strategy` |
/// | `teardown` | removing the dash worktree |
/// | `release` | dropping the candidate ref, removing the workshop, deleting the branch |
/// | `record` | the dash-log line and closing the op-log record |
///
/// **The order is the code's, not the wire's convenience.** The dash-log line
/// is written *last*, after teardown and release, because it is the terminal
/// record of a join that has already happened — so `record` fires at the end
/// rather than second. A beat table that read better and matched worse would be
/// a progress line that lies about where the work is.
///
/// A preview emits nothing: it mutates nothing, so there is nothing to narrate.
///
/// The beats are a **liveness hint and never the carrier of truth** — the
/// caller's own recompute stays authoritative, exactly as it already is for the
/// resolve path. Dropping every beat costs the progress line and nothing else.
pub fn join_in_with_progress(
    repo_root: &Path,
    name: &str,
    opts: JoinOptions,
    on_beat: impl Fn(&str, &str),
) -> Result<JoinOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    migrate_worktrees(&repo_root, &mut warnings);
    // A journal an older build left behind becomes an op record here, where
    // every path below can see it — and an unreadable one is named rather than
    // ignored, because ignoring it would let a plain join run over a dash that
    // is half torn down.
    crate::oplog::fold_legacy_join_journal(&repo_root, name)?;
    // Pre-feature dashes get rerere enabled here so a recorded resolution
    // replays on this and future joins ([P31]).
    crate::resolve::ensure_rerere_config(&repo_root);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    // --continue: resume an interrupted teardown from the record it left open.
    //
    // **Above the branch-exists guard, because the last phase of a teardown is
    // the branch being gone.** A join killed after `branch -D` has a worktree
    // to be sure of, a dash-log line to append, and a record to close — and the
    // dash it names no longer has a branch, so a guard asking git would refuse
    // the one resume that most needs to run. The record is what says this dash
    // is mid-teardown; git cannot know it.
    if opts.continue_join {
        let op = crate::oplog::join_in_flight(&repo_root, name)
            .ok_or_else(|| format!("No interrupted join to continue for dash '{}'.", name))?;
        let progress = op
            .join
            .clone()
            .ok_or_else(|| format!("No interrupted join to continue for dash '{}'.", name))?;
        return finish_join_teardown(
            TeardownTarget {
                repo_root: &repo_root,
                name,
                branch: &branch,
                worktree: &worktree,
                origin: opts.origin.as_deref(),
            },
            op.seq,
            progress,
            warnings,
            &on_beat,
        );
    }

    if !branch_exists(&repo_root, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    let base_branch = dash_base(&repo_root, name)?;

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
        let probe = join_conflicts_in(&repo_root, name)?;
        return Ok(JoinOutcome {
            name: name.to_string(),
            base_branch,
            strategy: opts.strategy.as_str().to_string(),
            commit_hash: None,
            // A preview lands nothing, so there is no landed tree to speak of
            // the fit of; the receipt this field feeds is written only on a
            // join that landed.
            fit: None,
            conflicts: probe.conflicts,
            previewed: true,
            blockers,
            message: None,
            archaeology: probe.archaeology,
            warnings,
        });
    }

    // A join still in flight means a prior one half-finished — require
    // --continue.
    if crate::oplog::join_in_flight(&repo_root, name).is_some() {
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
    //
    // And it blocks only when the base's copy is *other work*. A copy holding
    // byte for byte what this dash carries is the dash's own edit sitting on
    // the base — the shape a note written on main from the dash's work leaves
    // — and refusing over it would be refusing to land bytes on the grounds
    // that they are already there. The drop is below, past every refusal, so
    // nothing is touched on a path that ends in `Err` ([L28]).
    let (blocking, droppable) =
        blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch).split_on_relation();
    if !blocking.is_empty() {
        return Err(if blocking.tracked.is_empty() {
            untracked_overwrite_detail(&overlap_paths(&blocking.untracked))
        } else {
            base_dirt_detail(&overlap_paths(&blocking.tracked))
        });
    }

    // A resolve another process may still be running holds the dash, and the
    // teardown below would take its workshop out from under it. Above the dirt
    // sweep on purpose: every refusal to this point has touched nothing, and a
    // refusal that had first committed a round would be a mutation on a
    // refusal path ([L28]).
    let broke_lease = match crate::resolve::resolve_lease(&repo_root, name, SystemTime::now()) {
        Some(lease) if !opts.break_lease => {
            return Err(live_resolve_detail(name, &lease, "join"));
        }
        Some(lease) => Some(lease),
        None => None,
    };

    // The verification gate stood here. Nothing replaces it: the run's ending
    // replays the dash onto the live base and verifies the tree that lands
    // ([D142]'s successor), so the bytes were checked once, warm, where a
    // failure could still be fixed. What remains between a join and the base
    // is what the execution itself enforces — the preflight above, and a merge
    // that either applies or does not.

    // Auto-commit outstanding dash-worktree changes — FATAL on error now ([P14]).
    commit_worktree_dirt(&worktree, name)?;

    // Nothing to integrate (no commits past base) — discard, don't join.
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
        // Names the discard verb generically ([P14]) — no raw terminal
        // instruction; each surface fronts its own discard affordance.
        return Err(empty_detail(name, &base_branch));
    }

    // The last refusal is behind us, so the base's stale copies of this dash's
    // own bytes can go. Git would refuse the merge over them otherwise, even
    // though it is about to write those exact bytes.
    drop_identical_base_copies(&repo_root, &droppable, &mut warnings)?;

    // Record the operation before the integrate, and after the dirt sweep above
    // — the sweep's commit is work the dash owns, so a `before` read any
    // earlier would describe a dash missing it. Every refusal above this line
    // touched nothing that needs undoing, which is why the record starts here
    // rather than at the verb's entry.
    //
    // The keepalive is what survives the teardown: `branch -D` below would
    // otherwise leave the dash's rounds reachable only from a reflog on a
    // clock.
    let mut op_before = crate::oplog::capture_before(&repo_root, name)?;
    op_before.broke_lease = broke_lease.as_ref().map(|l| l.age.as_secs());
    let op_tips = crate::oplog::tips_of(&op_before);
    let op_seq = crate::oplog::record_begin(
        &repo_root,
        crate::oplog::OpVerb::Join,
        name,
        op_before,
        &op_tips,
    )?;
    if let Some(lease) = &broke_lease {
        warnings.push(broke_lease_warning(name, lease, op_seq));
    }
    // Integrate, in one function with one return type ([P03]): what it landed,
    // or the conflicts that stopped it landing anything.
    let conflict_outcome = |conflicts: Vec<String>, warnings: Vec<String>| JoinOutcome {
        name: name.to_string(),
        base_branch: base_branch.clone(),
        strategy: opts.strategy.as_str().to_string(),
        commit_hash: None,
        fit: None,
        conflicts,
        previewed: false,
        blockers: vec![],
        message: None,
        // Preview-only ([P07]): an execute that hit conflicts aborted cleanly
        // and the caller's next act is a preview, which computes it.
        archaeology: vec![],
        warnings,
    };

    on_beat("squash", "start");
    let integration = match integrate_join(&repo_root, name, &branch, &base_branch, &opts) {
        Ok(integration) => integration,
        // A record describes an operation that happened, and this one did not:
        // the integrate left the base as it found it. So the record opened
        // above goes with it — jj states the rule as a transaction that is not
        // committed writing no operation, and undo and replay already keep it.
        // Dropping it here is what lets an incomplete join record *mean* a
        // teardown to resume.
        Err(e) => {
            crate::oplog::abandon(&repo_root, op_seq);
            return Err(e);
        }
    };
    let (commit_hash, message) = match integration {
        Integration::Landed {
            commit_hash,
            message,
        } => (commit_hash, message),
        Integration::Conflicted(conflicts) => {
            crate::oplog::abandon(&repo_root, op_seq);
            return Ok(conflict_outcome(conflicts, warnings));
        }
    };

    // Record the integrate on the op the join opened, then run the resumable
    // teardown. From here the record is the resume record: an incomplete join
    // op carrying progress is what `--continue` finishes.
    let progress = crate::oplog::JoinProgress {
        phase: crate::oplog::JoinPhase::Integrated,
        commit_hash,
        strategy: opts.strategy.as_str().to_string(),
        message,
    };
    crate::oplog::record_join_progress(&repo_root, op_seq, progress.clone())?;
    on_beat("squash", "done");

    finish_join_teardown(
        TeardownTarget {
            repo_root: &repo_root,
            name,
            branch: &branch,
            worktree: &worktree,
            origin: opts.origin.as_deref(),
        },
        op_seq,
        progress,
        warnings,
        &on_beat,
    )
}
/// What an integrate did: it landed a commit on the base, or it hit conflicts
/// and left the base exactly as it found it.
///
/// The distinction is the one the operation log turns on. A join that lands
/// nothing records nothing, so the caller needs the two apart as data rather
/// than as an outcome it has to inspect.
enum Integration {
    Landed {
        commit_hash: String,
        message: Option<String>,
    },
    Conflicted(Vec<String>),
}

/// Put the dash's work on the base — the whole integrate, in one place.
///
/// Three landing shapes read together: a pre-built candidate from the
/// resolution ladder, and the strategy match for a plain join, which is the
/// same three strategies over the dash branch itself. Every exit that does not
/// land — a conflict, a stale candidate, a failed merge or commit — leaves the
/// base as it was, which is what lets the caller drop the record it opened.
fn integrate_join(
    repo_root: &Path,
    name: &str,
    branch: &str,
    base_branch: &str,
    opts: &JoinOptions,
) -> Result<Integration, String> {
    // Land a pre-built candidate from the resolution ladder ([P31]) instead of
    // merging the dash branch. The candidate is the resolved bytes; `strategy`
    // still decides the shape, and the recorded teardown is the same one.
    if let Some(candidate) = opts.candidate.clone() {
        // Staleness, stated rather than inferred. This used to ride on
        // `merge --ff-only` failing, which conflated two different facts: a
        // base that moved past the candidate, and a strategy that declines to
        // fast-forward. Asking ancestry directly is the same test
        // `resolve::candidate_status` applies, so the join's verdict and the
        // face's verdict cannot disagree — and it leaves the landing free to be
        // whatever the caller asked for.
        let base_head = git_stdout(repo_root, &["rev-parse", base_branch])?;
        let current = git_output(
            repo_root,
            &["merge-base", "--is-ancestor", &base_head, &candidate],
        )?;
        if !current.status.success() {
            return Err(format!(
                "stale candidate: base '{}' advanced since the conflicts were resolved; re-resolve and try again",
                base_branch
            ));
        }

        // **The candidate is the bytes, never the shape.** What the ladder
        // hands back is a tree that resolves the join — sometimes one commit on
        // the base, sometimes a chain of replayed rounds. Landing it by
        // fast-forward let that internal shape decide what the base's history
        // looks like and threw the authored draft away with it: a clean join
        // arrived on the base as N round commits carrying no composed message
        // at all, because a fast-forward has no commit to put one in. The
        // strategy the caller asked for is what decides the shape, exactly as
        // it does for a join with no candidate, and `Squash` is the default
        // every route asks for.
        let final_msg = integrate_message(
            repo_root,
            name,
            branch,
            opts.message.clone(),
            opts.session_id.as_deref(),
        );
        let commit_hash = match opts.strategy {
            JoinStrategy::Squash => {
                // The candidate is a descendant of the base head, so this
                // stages its tree without conflict; the commit below is what
                // the draft was written for.
                let merge = git_output(repo_root, &["merge", "--squash", &candidate])?;
                if !merge.status.success() {
                    let _ = git_output(repo_root, &["reset", "--hard"]);
                    return Err(format!(
                        "failed to stage the resolved candidate: {}",
                        String::from_utf8_lossy(&merge.stderr).trim()
                    ));
                }
                let commit = git_output(repo_root, &["commit", "-m", &final_msg])?;
                if !commit.status.success() {
                    let _ = git_output(repo_root, &["reset", "--hard"]);
                    return Err(format!(
                        "git commit failed: {}",
                        String::from_utf8_lossy(&commit.stderr).trim()
                    ));
                }
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            }
            JoinStrategy::Merge => {
                let merge = git_output(
                    repo_root,
                    &["merge", "--no-ff", "-m", &final_msg, &candidate],
                )?;
                if !merge.status.success() {
                    let _ = git_output(repo_root, &["merge", "--abort"]);
                    return Err(format!(
                        "failed to merge the resolved candidate: {}",
                        String::from_utf8_lossy(&merge.stderr).trim()
                    ));
                }
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            }
            // The one strategy that asks for the candidate's own history on the
            // base, and therefore the one that keeps its own messages.
            JoinStrategy::Rebase => {
                let ff = git_output(repo_root, &["merge", "--ff-only", &candidate])?;
                if !ff.status.success() {
                    return Err(format!(
                        "failed to fast-forward '{}' onto the resolved candidate: {}",
                        base_branch,
                        String::from_utf8_lossy(&ff.stderr).trim()
                    ));
                }
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            }
        };
        // A rebase landed the candidate's own commits, so the receipt reports
        // what is actually on the base rather than a message it never wrote.
        let message = match opts.strategy {
            JoinStrategy::Rebase => {
                git_stdout(repo_root, &["log", "-1", "--format=%B", &commit_hash]).ok()
            }
            _ => Some(final_msg),
        };
        return Ok(Integration::Landed {
            commit_hash,
            message,
        });
    }

    let final_msg = integrate_message(
        repo_root,
        name,
        branch,
        opts.message.clone(),
        opts.session_id.as_deref(),
    );

    // Integrate per strategy. A conflict cleanly aborts (pre-join state
    // restored) and returns the structured conflict list — never a dead end.

    let commit_hash = match opts.strategy {
        JoinStrategy::Squash => {
            let merge = git_output(repo_root, &["merge", "--squash", branch])?;
            if !merge.status.success() {
                let conflicts = conflicted_paths(repo_root);
                // A squash conflict leaves the index/worktree dirty but sets no
                // MERGE_HEAD, so `reset --hard` (not `merge --abort`) restores.
                let _ = git_output(repo_root, &["reset", "--hard"]);
                return Ok(Integration::Conflicted(conflicts));
            }
            let commit = git_output(repo_root, &["commit", "-m", &final_msg])?;
            if !commit.status.success() {
                let _ = git_output(repo_root, &["reset", "--hard"]);
                return Err(format!(
                    "git commit failed: {}",
                    String::from_utf8_lossy(&commit.stderr).trim()
                ));
            }
            git_stdout(repo_root, &["rev-parse", "HEAD"])?
        }
        JoinStrategy::Merge => {
            let merge = git_output(repo_root, &["merge", "--no-ff", "-m", &final_msg, branch])?;
            if !merge.status.success() {
                let conflicts = conflicted_paths(repo_root);
                let _ = git_output(repo_root, &["merge", "--abort"]);
                return Ok(Integration::Conflicted(conflicts));
            }
            git_stdout(repo_root, &["rev-parse", "HEAD"])?
        }
        JoinStrategy::Rebase => {
            // Fast-forward when base is unchanged (linear); else replay the
            // dash's commits onto the current base with cherry-pick.
            let ff = git_output(repo_root, &["merge", "--ff-only", branch])?;
            if ff.status.success() {
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            } else {
                let pick = git_output(
                    repo_root,
                    &["cherry-pick", &format!("{}..{}", base_branch, branch)],
                )?;
                if !pick.status.success() {
                    let conflicts = conflicted_paths(repo_root);
                    let _ = git_output(repo_root, &["cherry-pick", "--abort"]);
                    return Ok(Integration::Conflicted(conflicts));
                }
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            }
        }
    };

    Ok(Integration::Landed {
        commit_hash,
        message: Some(final_msg),
    })
}

/// What a join's teardown acts on: the repo, the dash, and the git objects
/// that name it. Every caller has these five in hand together, so carrying
/// them together keeps the teardown's signature about what actually varies
/// between calls — the journal, the warnings, and the beat sink.
struct TeardownTarget<'a> {
    repo_root: &'a Path,
    name: &'a str,
    branch: &'a str,
    worktree: &'a Path,
    origin: Option<&'a str>,
}

/// The resumable teardown half of a join: remove the worktree, delete the
/// branch, append the dash-log line, complete the record — advancing the
/// record's phase after each step so `--continue` resumes exactly where a
/// crash left off. Idempotent per phase.
///
/// The sequence number is carried in rather than searched for. This is also the
/// `--continue` entry point, and there the caller found the record by asking
/// which join is in flight — so both paths arrive holding the op they are
/// finishing, and a completion can no longer land on the wrong one.
fn finish_join_teardown(
    target: TeardownTarget<'_>,
    op_seq: u64,
    mut progress: crate::oplog::JoinProgress,
    mut warnings: Vec<String>,
    on_beat: &dyn Fn(&str, &str),
) -> Result<JoinOutcome, String> {
    let TeardownTarget {
        repo_root,
        name,
        branch,
        worktree,
        origin,
    } = target;
    // Captured while the branch still exists and the dash-log has not had its
    // terminal line written: both are gone by the time the outcome is read,
    // and a fact read afterwards would be no fact at all.
    let fit = fit_fact(
        repo_root,
        branch,
        &dash_base(repo_root, name).unwrap_or_default(),
        &read_declarations(repo_root, name),
    );
    if progress.phase == crate::oplog::JoinPhase::Integrated {
        on_beat("teardown", "start");
        remove_dash_worktree(repo_root, branch, worktree, &mut warnings);
        progress.phase = crate::oplog::JoinPhase::WorktreeRemoved;
        crate::oplog::record_join_progress(repo_root, op_seq, progress.clone())?;
        on_beat("teardown", "done");
    }

    if progress.phase == crate::oplog::JoinPhase::WorktreeRemoved {
        on_beat("release", "start");
        // The branch config section dies with the branch, but a loose ref does
        // not — so the candidate is dropped explicitly, on every join path,
        // rather than being left to outlive the dash it described.
        crate::resolve::clear_candidate(repo_root, name);
        // The workshop outlives every resolve on purpose; it does not outlive
        // the dash. A `tugworkshop/*` ref standing past its dash is a leak.
        crate::workshop::remove(repo_root, name, &mut warnings);
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
        // The documents go with the branch ([P11]): the squash commit is the
        // durable record of a joined dash, and the brief and the plan have
        // nothing to add to it. Named in the receipt rather than done quietly,
        // because an `undo` does not bring the directory back.
        let documents = documents_dir(repo_root, name);
        if documents.is_dir() {
            match std::fs::remove_dir_all(&documents) {
                Ok(()) => warnings.push(format!("removed .tug/dashes/{name}/")),
                Err(e) => warnings.push(format!("could not remove {}: {e}", documents.display())),
            }
        }
        progress.phase = crate::oplog::JoinPhase::BranchDeleted;
        crate::oplog::record_join_progress(repo_root, op_seq, progress.clone())?;
        on_beat("release", "done");
    }

    // Record the terminal action in the dash-log, then close the record — in
    // that order, so a crash between the two leaves a join that visibly
    // happened and an op `--continue` can still complete.
    on_beat("record", "start");
    let short = git_stdout(repo_root, &["rev-parse", "--short", &progress.commit_hash])
        .unwrap_or_else(|_| progress.commit_hash.clone());
    let note = match origin {
        Some(origin) => format!("joined via {origin}"),
        None => "joined".to_string(),
    };
    append_dash_log(repo_root, name, &short, &note).map_err(|e| e.to_string())?;

    let base_branch = base_branch_of(repo_root, op_seq, name);
    let after = crate::oplog::OpAfter {
        base_tip: git_stdout(repo_root, &["rev-parse", &base_branch]).ok(),
        landed_commit: Some(progress.commit_hash.clone()),
        ..Default::default()
    };
    if let Err(e) = crate::oplog::record_complete(repo_root, op_seq, after) {
        warnings.push(format!("Failed to complete the op-log record: {}", e));
    }
    on_beat("record", "done");

    Ok(JoinOutcome {
        name: name.to_string(),
        base_branch,
        strategy: progress.strategy,
        commit_hash: Some(progress.commit_hash),
        conflicts: vec![],
        previewed: false,
        blockers: vec![],
        fit,
        message: progress.message,
        archaeology: vec![],
        warnings,
    })
}

/// The base branch the join was recorded against, from the record itself.
///
/// The op's `before` is the one place it is stated as a fact rather than
/// re-derived: by the time a `--continue` runs, the dash branch may already be
/// deleted and `dash_base` would fall back to the repository's default branch,
/// which is a guess.
fn base_branch_of(repo_root: &Path, op_seq: u64, name: &str) -> String {
    crate::oplog::read_op(repo_root, op_seq)
        .map(|op| op.before.base_branch)
        .or_else(|| dash_base(repo_root, name).ok())
        .unwrap_or_else(|| "main".to_string())
}

/// Release a dash: tear down its worktree + branch without merging.
pub fn discard(
    name: &str,
    origin: Option<&str>,
    break_lease: bool,
) -> Result<DiscardOutcome, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    discard_in(&repo_root, name, origin, break_lease)
}

/// Like [`discard`], but against an explicit repo root instead of the process
/// cwd — for callers such as tugcast.
pub fn discard_in(
    repo_root: &Path,
    name: &str,
    origin: Option<&str>,
    break_lease: bool,
) -> Result<DiscardOutcome, String> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    migrate_worktrees(&repo_root, &mut warnings);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    if !branch_exists(&repo_root, &branch) && !worktree.exists() {
        // A dash that exists only as an arc record — an arc that stopped
        // before its devise stage created anything — has no branch or
        // worktree to tear down, but it has a record a later `dash run` under
        // the name would resume into. Discard ends that record the way it
        // ends a dash's: with the terminal marker.
        if crate::arc::read_arc(&repo_root, name).is_some() {
            append_dash_log(
                &repo_root,
                name,
                "discarded",
                &origin.map_or(String::new(), |o| format!("via {o}")),
            )
            .map_err(|e| e.to_string())?;
            return Ok(DiscardOutcome {
                name: name.to_string(),
                documents_kept: documents_dir(&repo_root, name)
                    .is_dir()
                    .then(|| documents_dir(&repo_root, name).display().to_string()),
                work_restored: Vec::new(),
                warnings: vec![
                    "no branch or worktree existed; the dash's arc record was ended".to_string(),
                ],
            });
        }
        return Err(format!("Dash not found: {}", name));
    }

    // The worktree's uncommitted work has the same shape of problem as the
    // plan, one level up: `create --carry` moves work here and leaves it
    // uncommitted by design, so the worktree holds the only copy of it and
    // teardown would destroy it. Check for the one case that cannot be resolved
    // — the base has since acquired its own edit to the same path — before
    // anything at all has moved, so a refused discard changes nothing ([P08]).
    let hand = working_set_hand_back(&repo_root, &worktree);
    if !hand.conflicts.is_empty() {
        return Err(format!(
            "Cannot discard '{name}': the base checkout has its own uncommitted changes to \
             {}, which the dash also changed without committing. Handing the dash's work back \
             would overwrite yours, so the dash is left standing. Commit or stash the base \
             changes, then discard again.",
            hand.conflicts.join(", ")
        ));
    }

    // A resolve another process may still be running holds the dash, and the
    // teardown below removes the workshop it is working in. Above every write,
    // beside the hand-back refusal, so a refused discard changes nothing.
    let broke_lease = match crate::resolve::resolve_lease(&repo_root, name, SystemTime::now()) {
        Some(lease) if !break_lease => {
            return Err(live_resolve_detail(name, &lease, "discard"));
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
            .map_err(|e| format!("cannot record the discard in the op log: {e}"))?
        }
        Err(e) => return Err(format!("cannot record the discard in the op log: {e}")),
    };
    if let Some(lease) = &broke_lease {
        warnings.push(broke_lease_warning(name, lease, op_seq));
    }

    let work_restored = apply_hand_back(&repo_root, &worktree, &hand, &mut warnings);

    // Reap the dash's tmux/app and remove its worktree robustly (see
    // `remove_dash_worktree` for the "Directory not empty" race this avoids).
    remove_dash_worktree(&repo_root, &branch, &worktree, &mut warnings);

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

    // Record the terminal action in the dash-log ([P04]).
    append_dash_log(
        &repo_root,
        name,
        "discarded",
        &origin.map_or(String::new(), |o| format!("via {o}")),
    )
    .map_err(|e| e.to_string())?;

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

    // The documents stay: a discarded dash's brief and plan are the only trace
    // of decisions the user may want back, and `dash run <name>` reopens on
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

/// Read what the dash worktree holds uncommitted and sort it into [`HandBack`].
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
            "The dash deleted {path} without committing it; the base copy is left in place."
        ));
    }
    restored
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

    /// Join options for a test whose subject is the join's **mechanics** — the
    /// squash, the teardown, the draft, the record.
    ///
    /// Nothing but the defaults, since verification left the join: these
    /// options carried an `anyway: true` for as long as a gate stood between a
    /// join and the base, and there is no gate left to name.
    fn mechanics() -> JoinOptions {
        JoinOptions::default()
    }

    /// The numstat fold keys on the destination path a rename reports, so the
    /// two reads of one range meet; a binary file's `-` stays `None`; a path
    /// the numstat does not name is left uncounted rather than zeroed.
    #[test]
    fn numstat_folds_onto_name_status_by_destination_path() {
        let files = parse_name_status("M\ta.rs\nR100\told.rs\tnew.rs\nA\tpic.png\nD\tgone.rs\n");
        let numstat = "3\t1\ta.rs\n0\t0\told.rs => new.rs\n-\t-\tpic.png\n";
        let folded = with_numstat(files, numstat);
        let got: Vec<(&str, Option<u32>, Option<u32>)> = folded
            .iter()
            .map(|f| (f.path.as_str(), f.added, f.deleted))
            .collect();
        assert_eq!(
            got,
            vec![
                ("a.rs", Some(3), Some(1)),
                ("new.rs", Some(0), Some(0)),
                ("pic.png", None, None),
                ("gone.rs", None, None),
            ]
        );
    }

    /// Seed a join interrupted at `phase`, through the real code path: capture,
    /// record, attach progress. Never a hand-written payload — a fixture that
    /// spelled the record itself would stop testing the writer.
    fn seed_interrupted_join(
        repo: &Path,
        name: &str,
        phase: crate::oplog::JoinPhase,
        commit_hash: &str,
    ) -> u64 {
        let root = fs::canonicalize(repo).unwrap();
        let before = crate::oplog::capture_before(&root, name).unwrap();
        let tips = crate::oplog::tips_of(&before);
        let seq =
            crate::oplog::record_begin(&root, crate::oplog::OpVerb::Join, name, before, &tips)
                .unwrap();
        crate::oplog::record_join_progress(
            &root,
            seq,
            crate::oplog::JoinProgress {
                phase,
                commit_hash: commit_hash.to_string(),
                strategy: "squash".to_string(),
                message: None,
            },
        )
        .unwrap();
        seq
    }

    // ── The documents home ───────────────────────────────────────────────────

    #[test]
    fn documents_home_is_spelled_from_the_raw_name() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        assert!(
            documents_dir(root, "foo-bar").ends_with(".tug/dashes/foo-bar"),
            "{}",
            documents_dir(root, "foo-bar").display()
        );
        assert!(brief_file(root, "foo-bar").ends_with(".tug/dashes/foo-bar/brief.md"));
        assert!(plan_file(root, "foo-bar").ends_with(".tug/dashes/foo-bar/plan.md"));
    }

    /// The property [P01] and [P02] both rest on: a validated name is one safe
    /// directory component, and cannot be mistaken for a path. A later
    /// loosening of the validator fails here rather than in a path join.
    #[test]
    fn a_validated_dash_name_is_one_safe_directory_component() {
        for bad in ["a/b", "a\\b", "..", ".hidden", "foo.md", "/abs"] {
            assert!(
                validate_dash_name(bad).is_err(),
                "{bad} must not be a valid dash name"
            );
        }
        for good in ["foo-bar", "at0473-adopter", "dash-documents"] {
            assert!(validate_dash_name(good).is_ok(), "{good} should validate");
        }
    }

    #[test]
    #[serial]
    fn documents_dir_answers_the_main_root_from_a_linked_worktree() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        let outcome = create("wt-dash", None, false, None).unwrap();
        let worktree = Path::new(&outcome.worktree);

        let from_worktree = documents_dir(worktree, "wt-dash");
        let from_main = documents_dir(&fs::canonicalize(&repo).unwrap(), "wt-dash");

        assert_eq!(from_worktree, from_main);
        assert!(
            !from_worktree.starts_with(worktree),
            "a linked worktree must not resolve its own .tug/dashes: {}",
            from_worktree.display()
        );
    }

    #[test]
    fn dash_documents_read_reports_existence_and_titles() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let dir = documents_dir(root, "titles");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("brief.md"), "# The brief {#brief}\n\nbody\n").unwrap();

        let docs = DashDocuments::read(root, "titles");
        assert_eq!(docs.brief_title.as_deref(), Some("The brief"));
        assert_eq!(
            docs.brief.as_deref(),
            Some(&*dir.join("brief.md").to_string_lossy())
        );
        assert_eq!(docs.plan, None);
        assert_eq!(docs.plan_title, None);
        assert!(!docs.is_empty());

        fs::write(dir.join("plan.md"), "## **A plan** {#plan}\n").unwrap();
        assert_eq!(
            DashDocuments::read(root, "titles").plan_title.as_deref(),
            Some("A plan")
        );

        assert!(DashDocuments::read(root, "nothing").is_empty());
    }

    #[test]
    fn document_dashes_lists_directories_with_documents_only() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let dashes = root.join(".tug").join("dashes");
        fs::create_dir_all(dashes.join("beta")).unwrap();
        fs::write(dashes.join("beta").join("brief.md"), "# b\n").unwrap();
        fs::create_dir_all(dashes.join("alpha")).unwrap();
        fs::write(dashes.join("alpha").join("plan.md"), "# a\n").unwrap();
        // An empty directory, a directory whose name is not a dash name, and a
        // file at the top level are all skipped.
        fs::create_dir_all(dashes.join("empty")).unwrap();
        fs::create_dir_all(dashes.join("Not-A-Name")).unwrap();
        fs::write(dashes.join("Not-A-Name").join("brief.md"), "# n\n").unwrap();
        fs::write(dashes.join("loose.md"), "# l\n").unwrap();

        assert_eq!(document_dashes(root), vec!["alpha", "beta"]);
        assert!(document_dashes(temp.path().join("absent").as_path()).is_empty());
    }

    #[test]
    fn document_argument_parse_splits_on_shape() {
        assert_eq!(
            DocumentArgument::parse("foo"),
            DocumentArgument::Name("foo".into())
        );
        for path in ["foo.md", "./foo", "a/b", "/abs", "../up", "a\\b"] {
            assert_eq!(
                DocumentArgument::parse(path),
                DocumentArgument::Path(PathBuf::from(path)),
                "{path} should parse as a path"
            );
        }
    }

    #[test]
    fn ensure_tug_excluded_makes_git_status_clean_without_a_gitignore() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("bare-project");
        fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .output()
                .unwrap();
        }
        fs::write(repo.join("README.md"), "# Test\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();

        let dir = repo.join(".tug").join("dashes").join("x");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("brief.md"), "# x\n").unwrap();
        assert!(!porcelain_of(&repo).is_empty(), "fixture must start dirty");

        ensure_tug_excluded(&repo);
        assert_eq!(porcelain_of(&repo), "");

        // Idempotent: a second call adds no second line.
        ensure_tug_excluded(&repo);
        let exclude = fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(exclude.matches("/.tug/").count(), 1, "{exclude}");
        assert_eq!(
            exclude.matches(TUG_EXCLUDE_BLOCK_START).count(),
            1,
            "{exclude}"
        );
        assert_eq!(
            exclude.matches(TUG_EXCLUDE_BLOCK_END).count(),
            1,
            "{exclude}"
        );
    }

    /// A project whose `.gitignore` already covers `.tug` is left alone.
    #[test]
    fn ensure_tug_excluded_leaves_a_declared_project_alone() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        let exclude = repo.join(".git").join("info").join("exclude");
        let before = fs::read_to_string(&exclude).unwrap_or_default();

        ensure_tug_excluded(&repo);

        assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
    }

    fn porcelain_of(repo: &Path) -> String {
        git_stdout(repo, &["status", "--porcelain"]).unwrap()
    }

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

    #[test]
    fn the_git_reader_answers_what_moved_and_never_fails_over_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let paths = ["a.rs".to_string()];

        // An unborn HEAD: git has never seen anything here.
        assert!(commits_touching_after(root, SystemTime::UNIX_EPOCH, &paths, 20).is_empty());

        init_git_repo(root);
        fs::write(root.join("a.rs"), "fn a() {}\n").unwrap();
        commit_all(root, "add the file the document cites");
        // A second past the commit, because git commit timestamps have
        // one-second granularity and `--since` on the same second still hits.
        let written = SystemTime::now() + Duration::from_secs(1);

        // Nothing has moved since the document was written.
        assert!(commits_touching_after(root, written, &paths, 20).is_empty());

        // A commit landing after it does, and only in the cited paths.
        std::thread::sleep(Duration::from_millis(2100));
        fs::write(root.join("a.rs"), "fn a() { todo!() }\n").unwrap();
        commit_all(root, "change the cited file");
        fs::write(root.join("b.rs"), "fn b() {}\n").unwrap();
        commit_all(root, "add an uncited file");

        let moved = commits_touching_after(root, written, &paths, 20);
        assert_eq!(moved.len(), 1, "scoped to the paths, not the whole repo");
        assert!(moved[0].contains("change the cited file"));

        // No paths and no cap are each no clause rather than an error.
        assert!(commits_touching_after(root, written, &[], 20).is_empty());
        assert!(commits_touching_after(root, written, &paths, 0).is_empty());
    }

    fn commit_all(path: &Path, message: &str) {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["commit", "-m", message])
            .output()
            .unwrap();
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

    // -----------------------------------------------------------------------
    // index.lock contention (Spec S02)
    //
    // The race is real and symmetric: the join's preflight sweep and a
    // live `tugutil dash commit` both commit the same worktree's dirt at the
    // same moment, and the loser used to die on `index.lock: File exists`.
    // These hold the lock deterministically and release it from a helper
    // thread — racing two real processes would be flake by construction.
    // -----------------------------------------------------------------------

    /// The index lock's real path for a worktree, which is inside the
    /// worktree's own git dir — for a linked worktree that is
    /// `…/.git/worktrees/<name>/`, not a `.git` directory beside the files.
    fn index_lock_path(worktree: &Path) -> std::path::PathBuf {
        let git_dir = Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(["rev-parse", "--absolute-git-dir"])
            .output()
            .unwrap();
        let dir = String::from_utf8_lossy(&git_dir.stdout).trim().to_string();
        Path::new(&dir).join("index.lock")
    }

    /// Take the index lock and release it after `hold`.
    ///
    /// The releasing thread does nothing else — it is a clock, not a second
    /// writer — so the call under test is the only process touching the index
    /// and the outcome cannot depend on an interleaving.
    fn hold_index_lock(worktree: &Path, hold: std::time::Duration) -> std::thread::JoinHandle<()> {
        let lock = index_lock_path(worktree);
        fs::write(&lock, b"").unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(hold);
            let _ = fs::remove_file(&lock);
        })
    }

    fn head_sha(dir: &Path) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A plain repo with one commit and one uncommitted change — the shape
    /// `commit_worktree_dirt` is handed at join time.
    fn dirty_repo(temp: &TempDir) -> std::path::PathBuf {
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        fs::write(repo.join("a.txt"), "base\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-q", "-m", "base"])
            .output()
            .unwrap();
        fs::write(repo.join("a.txt"), "dirty\n").unwrap();
        repo
    }

    #[test]
    fn commit_worktree_dirt_survives_a_lock_released_mid_call() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        let before = head_sha(&repo);
        let releaser = hold_index_lock(&repo, std::time::Duration::from_millis(300));
        commit_worktree_dirt(&repo, "sweeper").expect("the sweep waits out a transient lock");
        releaser.join().unwrap();
        assert_ne!(head_sha(&repo), before, "the dirt was committed");
    }

    /// The losing side's outcome, asserted without racing anything.
    ///
    /// The other writer having already taken the dirt is the *state* a loser
    /// wakes up to, so the test produces that state directly instead of
    /// starting a second writer and hoping the interleaving lands. Two live
    /// writers is flake by construction: git reports contention with more than
    /// one message, and one of them is not the `index.lock` this retries on.
    #[test]
    fn commit_worktree_dirt_yields_when_the_other_writer_took_the_dirt() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-q", "-m", "the other writer got there first"])
            .output()
            .unwrap();

        commit_worktree_dirt(&repo, "sweeper").expect("losing the race is not an error");

        let subject = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["log", "-1", "--format=%s"])
            .output()
            .unwrap();
        // The yield is a no-op: nothing stacked on top of the winner's commit,
        // because the status re-read found the worktree already clean.
        assert_eq!(
            String::from_utf8_lossy(&subject.stdout).trim(),
            "the other writer got there first"
        );
    }

    #[test]
    fn commit_worktree_dirt_surfaces_a_lock_that_never_clears() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        fs::write(index_lock_path(&repo), b"").unwrap();
        let err = commit_worktree_dirt(&repo, "sweeper").expect_err("a stuck lock is an error");
        // Verbatim: the retry must not cost the reader the one word that says
        // what happened.
        assert!(err.contains("index.lock"), "error was: {err}");
    }

    #[serial]
    #[test]
    fn dash_commit_survives_a_lock_released_mid_call() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("locked", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "locked");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        let releaser = hold_index_lock(&worktree, std::time::Duration::from_millis(300));
        let outcome = commit("locked", "tugdash(locked): a round", None)
            .expect("the round waits out a transient lock");
        releaser.join().unwrap();
        assert!(outcome.committed, "the round landed");
    }

    /// The round's side of the same yield, produced directly for the same
    /// reason: the sweep having already taken the changes is a state, not a
    /// timing.
    #[serial]
    #[test]
    fn dash_commit_reports_uncommitted_when_a_sweep_took_its_changes() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("swept", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "swept");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        commit_worktree_dirt(&worktree, "swept").unwrap();

        let outcome = commit("swept", "tugdash(swept): a round", None)
            .expect("losing the race is not an error");
        // The sweep committed these bytes, so the round has nothing of its own
        // left — the same outcome a clean worktree has always produced.
        assert!(!outcome.committed);
        assert!(outcome.commit_hash.is_none());
    }

    // -----------------------------------------------------------------------
    // The sweep is marked, and is not a round (Spec S03)
    // -----------------------------------------------------------------------

    /// Commit one authored round in a dash worktree, the way a run does.
    fn author_round(worktree: &Path, n: u32) {
        fs::write(
            worktree.join(format!("round{n}.txt")),
            format!("work {n}\n"),
        )
        .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(["commit", "-q", "-m", &format!("tugdash(d): round {n}")])
            .output()
            .unwrap();
    }

    #[serial]
    #[test]
    fn a_sweep_does_not_inflate_the_round_count_or_the_subject_list() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("swept-count", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "swept-count");
        author_round(&worktree, 1);
        author_round(&worktree, 2);

        // Dirt, then the join's preflight sweep over it.
        fs::write(worktree.join("late.txt"), "uncommitted\n").unwrap();
        commit_worktree_dirt(&worktree, "swept-count").unwrap();

        let detail = dash_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "swept-count")
            .expect("the dash is listed");
        assert_eq!(detail.rounds, 2, "the sweep is not authored work");
        assert_eq!(detail.round_subjects.len(), 2);
        assert!(
            !detail
                .round_subjects
                .iter()
                .any(|s| s.contains("commit outstanding changes")),
            "subjects were: {:?}",
            detail.round_subjects
        );
    }

    #[serial]
    #[test]
    fn the_sweep_wears_the_round_voice_and_marks_itself() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("voiced", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "voiced");
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "voiced").unwrap();

        let message = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let message = String::from_utf8_lossy(&message.stdout);
        assert!(
            message.starts_with("tugdash(voiced): commit outstanding changes"),
            "message was: {message}"
        );
        assert!(message.contains("Tug-Sweep: 1"), "message was: {message}");
    }

    #[serial]
    #[test]
    fn a_dash_whose_only_commit_is_a_sweep_has_no_rounds() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("sweep-only", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "sweep-only");
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "sweep-only").unwrap();

        let detail = dash_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "sweep-only")
            .expect("the dash is listed");
        // Nothing was authored, so there is nothing to join — and `join_ready`
        // refuses on `rounds < 1` even with the run declared complete.
        assert_eq!(detail.rounds, 0);
        let decls = crate::dash::DashDeclarations {
            run_complete: true,
            ..Default::default()
        };
        assert!(!crate::dash::join_ready(
            detail.rounds,
            false,
            false,
            &decls,
            true
        ));
    }

    #[serial]
    #[test]
    fn a_sweep_from_before_the_marker_still_counts() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("legacy-sweep", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "legacy-sweep");
        // Exactly what the sweep used to write: the old subject, no trailer.
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["commit", "-q", "-m", "join: commit outstanding changes"])
            .output()
            .unwrap();

        let detail = dash_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "legacy-sweep")
            .expect("the dash is listed");
        // The filter keys on the trailer, never on the subject. A sweep written
        // before the marker existed keeps counting rather than having its
        // history rewritten under it.
        assert_eq!(detail.rounds, 1);
    }

    #[serial]
    #[test]
    fn every_round_reader_agrees_about_a_swept_dash() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("agreeing", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "agreeing");
        author_round(&worktree, 1);
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "agreeing").unwrap();

        let detail = dash_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "agreeing")
            .expect("the dash is listed");
        let status = status_in(&repo, "agreeing").unwrap();
        let shown = show("agreeing").unwrap();
        let listed = list()
            .unwrap()
            .into_iter()
            .find(|d| d.name == "agreeing")
            .expect("the dash is listed");
        // Four readers, one definition of a round.
        assert_eq!(detail.rounds, 1);
        assert_eq!(status.rounds, 1);
        assert_eq!(shown.rounds.len(), 1);
        assert_eq!(listed.round_count, 1);
    }

    /// Stand up a repo with a dash whose documents home holds [`TWO_STEP_PLAN`].
    /// Returns the temp dir and the canonical repo root the verbs resolve to.
    fn stepped_dash(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create(name, None, false, None).unwrap();

        let plan = plan_file(&repo, name);
        fs::create_dir_all(plan.parent().unwrap()).unwrap();
        fs::write(&plan, TWO_STEP_PLAN).unwrap();

        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    /// The ledger row for `anchor`, as the plan on disk now reads.
    fn ledger_row(root: &Path, name: &str, anchor: &str) -> tugutil_core::plan::LedgerRow {
        let source = fs::read_to_string(plan_file(root, name)).unwrap();
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

        let started = step_start("step-dash", 1, 2).unwrap();
        assert_eq!(
            started.plan,
            plan_file(&root, "step-dash").display().to_string()
        );
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

        // Nothing records where the plan is; the next step finds it at the same
        // address the first one did.
        let next = step_start("step-dash", 2, 2).unwrap();
        assert_eq!(
            next.plan,
            plan_file(&root, "step-dash").display().to_string()
        );
        assert_eq!(
            ledger_row(&root, "step-dash", "step-2").status,
            "in progress"
        );
    }

    /// The incident's shape, inverted: a dash driven only by the verbs a run
    /// cannot skip is offerable without anybody declaring anything ([P01]–[P04]).
    #[serial]
    #[test]
    fn a_finished_run_reads_ready_without_a_mark() {
        let (_temp, root) = stepped_dash("ready-dash");
        let worktree = worktree_path(&root, "ready-dash");

        step_start("ready-dash", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("ready-dash", "r1", None).unwrap();

        // Mid-run: a step is open and the selection is unfinished.
        let detail = dash_detail_entry_in(&root, "ready-dash").unwrap();
        assert!(!detail.join_ready);
        assert_eq!(detail.stage, "implementing");
        assert_eq!(detail.run_through, Some(2));

        step_done("ready-dash", 1, None).unwrap();
        // Still short of the declared end.
        let detail = dash_detail_entry_in(&root, "ready-dash").unwrap();
        assert!(!detail.join_ready);
        assert!(!detail.run_complete);

        step_start("ready-dash", 2, 2).unwrap();
        fs::write(worktree.join("two.txt"), "second\n").unwrap();
        commit("ready-dash", "r2", None).unwrap();
        step_done("ready-dash", 2, None).unwrap();

        let detail = dash_detail_entry_in(&root, "ready-dash").unwrap();
        assert!(detail.run_complete);
        assert!(detail.join_ready, "the declared selection finished");
        assert_eq!(detail.stage, "ready");
        // And the CLI's own composition agrees with the feed's.
        assert_eq!(status_in(&root, "ready-dash").unwrap().stage, "ready");

        // An untracked scratch file does not unready the dash — the join's
        // preamble would not commit it, so it is not the run's unfinished work.
        fs::write(worktree.join("scratch.tmp"), "notes\n").unwrap();
        let detail = dash_detail_entry_in(&root, "ready-dash").unwrap();
        assert!(detail.join_ready, "untracked dirt is not unfinished work");
        assert_eq!(status_in(&root, "ready-dash").unwrap().stage, "ready");

        // A tracked edit does: that is work the join would sweep in.
        fs::write(worktree.join("one.txt"), "edited\n").unwrap();
        let detail = dash_detail_entry_in(&root, "ready-dash").unwrap();
        assert!(!detail.join_ready);
        assert_eq!(
            status_in(&root, "ready-dash").unwrap().stage,
            "implementing"
        );
    }

    /// The two pairs answer different questions and both reach the callers:
    /// the run's counts the selection, the plan's counts the document.
    #[serial]
    #[test]
    fn the_run_pair_counts_the_selection_and_the_plan_pair_the_document() {
        let (_temp, root) = stepped_dash("span-dash");
        let worktree = worktree_path(&root, "span-dash");

        // A run of just step 1 against a two-row plan: the numbers diverge.
        step_start("span-dash", 1, 1).unwrap();
        let detail = dash_detail_entry_in(&root, "span-dash").unwrap();
        assert_eq!(
            (detail.step_current, detail.step_total),
            (Some(1), Some(2)),
            "the plan pair still counts the whole document"
        );
        assert_eq!(
            (detail.run_position, detail.run_length),
            (Some(1), Some(1)),
            "the run pair counts only what was asked for"
        );
        // The CLI's composition agrees with the feed's.
        let status = status_in(&root, "span-dash").unwrap();
        assert_eq!((status.run_position, status.run_length), (Some(1), Some(1)));

        // Finishing that selection holds the full fraction.
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("span-dash", "r1", None).unwrap();
        step_done("span-dash", 1, None).unwrap();
        let detail = dash_detail_entry_in(&root, "span-dash").unwrap();
        assert!(detail.run_complete);
        assert_eq!((detail.run_position, detail.run_length), (Some(1), Some(1)));

        // A second selection re-declares, and the run pair follows it rather
        // than the plan — step 2 of the document is step 1 of this run.
        step_start("span-dash", 2, 2).unwrap();
        let detail = dash_detail_entry_in(&root, "span-dash").unwrap();
        assert_eq!((detail.step_current, detail.step_total), (Some(2), Some(2)));
        assert_eq!((detail.run_position, detail.run_length), (Some(1), Some(1)));
    }

    /// A dash that declared no run reports no run pair, so its displays fall
    /// back to the plan's counters exactly as they did before ([P05]).
    #[serial]
    #[test]
    fn an_undeclared_run_reports_no_run_pair() {
        let (_temp, root) = stepped_dash("plain-dash");
        let worktree = worktree_path(&root, "plain-dash");
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("plain-dash", "r1", None).unwrap();

        let detail = dash_detail_entry_in(&root, "plain-dash").unwrap();
        assert_eq!((detail.run_position, detail.run_length), (None, None));
        let status = status_in(&root, "plain-dash").unwrap();
        assert_eq!((status.run_position, status.run_length), (None, None));
    }

    #[serial]
    #[test]
    fn the_run_declares_its_selection_once_and_refuses_a_nonsense_one() {
        let (_temp, root) = stepped_dash("through-dash");

        let started = step_start("through-dash", 1, 2).unwrap();
        assert_eq!(started.through, Some(2));
        assert_eq!(
            crate::dash::read_declarations(&root, "through-dash").run_through,
            Some(2)
        );

        // Re-entering the same step re-declares nothing.
        step_start("through-dash", 1, 2).unwrap();
        let log =
            fs::read_to_string(tugutil_core::project_state_dir(&root).join("dash-log.md")).unwrap();
        assert_eq!(
            log.lines()
                .filter(|l| l.contains("  through-dash  run-through  "))
                .count(),
            1,
            "an unchanged selection writes no second line"
        );

        // A done carries the standing declaration without re-writing it.
        let done = step_done("through-dash", 1, Some("abc1234")).unwrap();
        assert_eq!(done.through, Some(2));

        // A selection ending before the step it starts is not a selection.
        let err = step_start("through-dash", 2, 1).unwrap_err();
        assert!(err.contains("--through 1 is before step 2"), "{err}");

        // Nor is one naming a row the ledger does not carry.
        let err = step_start("through-dash", 2, 9).unwrap_err();
        assert!(err.contains("no ledger row for #step-9"), "{err}");
    }

    #[serial]
    #[test]
    fn step_done_records_the_branch_tip_when_no_commit_is_named() {
        let (_temp, root) = stepped_dash("tip-dash");
        step_start("tip-dash", 1, 2).unwrap();
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
        let plan = plan_file(&root, "refuse-dash");
        let before = fs::read_to_string(&plan).unwrap();

        // A dash with no plan at its own address.
        fs::remove_file(&plan).unwrap();
        let err = step_start("refuse-dash", 1, 2).unwrap_err();
        assert!(err.contains("has no plan at"), "{err}");
        fs::write(&plan, &before).unwrap();

        // An anchor the ledger does not carry.
        let err = step_start("refuse-dash", 9, 2).unwrap_err();
        assert!(err.contains("no ledger row for #step-9"), "{err}");

        // A finished row refuses to be started again, naming its status.
        step_start("refuse-dash", 1, 2).unwrap();
        step_done("refuse-dash", 1, Some("abc1234")).unwrap();
        let err = step_start("refuse-dash", 1, 2).unwrap_err();
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

        // The seeded plan is not in the worktree at all, so the undeclared dash
        // derives `created`: nothing has been worked yet.
        let fresh = status_in(&root, "status-dash").unwrap();
        assert_eq!(fresh.stage, "created");
        assert!(fresh.step_current.is_none());
        assert!(
            fresh.documents.plan.is_some(),
            "the seeded plan is at the dash's own address"
        );

        step_start("status-dash", 1, 2).unwrap();
        let stepping = status_in(&root, "status-dash").unwrap();
        assert_eq!(stepping.stage, "implementing");
        assert_eq!(
            (stepping.step_current, stepping.step_total),
            (Some(1), Some(2))
        );
        assert_eq!(
            stepping.documents.plan.as_deref(),
            Some(&*plan_file(&root, "status-dash").to_string_lossy())
        );

        mark("status-dash", MarkStage::Built, None).unwrap();
        let built = status_in(&root, "status-dash").unwrap();
        assert_eq!(built.stage, "built");
        // The step fields outlive the mark, so a display can still say how far.
        assert_eq!(built.step_current, Some(1));

        mark("status-dash", MarkStage::Audited, Some("good shape")).unwrap();
        assert_eq!(status_in(&root, "status-dash").unwrap().stage, "audited");

        // A follow-up step range demotes the dash back to implementing.
        step_start("status-dash", 2, 2).unwrap();
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

        // A plain dash derives what it always did. `created`, not `working`:
        // the plan is at the dash's own address, outside the worktree, so
        // seeding it leaves no dirt behind.
        let plain = dash_detail_entries_in(&root);
        let entry = plain.iter().find(|d| d.name == "feed-dash").unwrap();
        assert_eq!(entry.stage, "created");
        assert!(entry.step_current.is_none() && entry.step_total.is_none());

        step_start("feed-dash", 1, 2).unwrap();
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

    /// The arc rides the same composition, **beside** the derived stage rather
    /// than inside it — the property that lets a face say `implementing` and
    /// `arc stopped in review` at once, which is exactly what a stopped arc is.
    #[serial]
    #[test]
    fn detail_entries_carry_the_arc_beside_the_derived_stage() {
        let (_temp, root) = stepped_dash("arc-dash");

        // A hand-driven dash has no arc, and says so by absence.
        let plain = dash_detail_entries_in(&root);
        let entry = plain.iter().find(|d| d.name == "arc-dash").unwrap();
        assert!(entry.arc.is_none(), "no arc lines, nothing to say");

        crate::arc::append_arc_start(&root, "arc-dash", "dash/arc-dash-brief.md").unwrap();
        crate::arc::append_arc_stage(
            &root,
            "arc-dash",
            crate::arc::ArcStage::Review,
            "claude-b",
            Some("opus"),
        )
        .unwrap();
        let running = dash_detail_entries_in(&root);
        let entry = running.iter().find(|d| d.name == "arc-dash").unwrap();
        let arc = entry.arc.as_ref().expect("the arc composes");
        assert_eq!(arc.stage.as_deref(), Some("review"));
        assert!(arc.stopped.is_none() && !arc.done);
        assert!(
            arc.note.is_none(),
            "an arc that has said nothing carries no note"
        );

        // The latest note is what the placard shows — the newest, not the
        // first, so a second act replaces what the first one said.
        crate::arc::append_arc_note(&root, "arc-dash", "compacted at 0.73 > 0.60").unwrap();
        crate::arc::append_arc_note(&root, "arc-dash", "compacted at 0.81 > 0.60").unwrap();
        let noted = dash_detail_entries_in(&root);
        let entry = noted.iter().find(|d| d.name == "arc-dash").unwrap();
        assert_eq!(
            entry.arc.as_ref().and_then(|a| a.note.as_deref()),
            Some("compacted at 0.81 > 0.60")
        );

        crate::arc::append_arc_stop(
            &root,
            "arc-dash",
            crate::arc::ArcStage::Review,
            crate::arc::ArcStopReason::Lint,
        )
        .unwrap();
        let stopped = dash_detail_entries_in(&root);
        let entry = stopped.iter().find(|d| d.name == "arc-dash").unwrap();
        let arc = entry.arc.as_ref().expect("a stopped arc still composes");
        assert_eq!(arc.stopped.as_deref(), Some("lint"));
        assert_eq!(arc.stopped_stage.as_deref(), Some("review"));
        assert_eq!(
            entry.stage, "created",
            "the git stage is untouched by the arc's — both readings stand"
        );
    }

    /// The verbs drive the plan where it lives, and the worktree never sees it:
    /// a run's whole ledger walk leaves the dash's tree byte-for-byte clean.
    #[serial]
    #[test]
    fn step_verbs_drive_the_plan_in_the_dash_directory() {
        let (_temp, root) = stepped_dash("home-dash");
        let worktree = worktree_path(&root, "home-dash");
        let porcelain = || git_stdout(&worktree, &["status", "--porcelain"]).unwrap();
        assert_eq!(porcelain(), "", "the seeded plan is not in the worktree");

        let started = step_start("home-dash", 1, 2).unwrap();
        assert_eq!(
            started.plan,
            plan_file(&root, "home-dash").display().to_string()
        );
        assert_eq!(porcelain(), "");

        let tip = git_stdout(&root, &["rev-parse", "--short", "tugdash/home-dash"]).unwrap();
        step_done("home-dash", 1, None).unwrap();
        let row = ledger_row(&root, "home-dash", "step-1");
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some(tip.as_str()));
        assert_eq!(porcelain(), "", "and the ledger write left no dirt behind");
    }

    /// Every tracked edit in a dash worktree is work in flight now that the plan
    /// is not one of them.
    #[test]
    fn join_ready_counts_every_tracked_worktree_edit() {
        assert!(crate::dash::unfinished_tracked_dirt(&["a.rs".to_string()]));
        assert!(!crate::dash::unfinished_tracked_dirt(&[]));
    }

    /// The dash's documents ride the same composition, so a card bound to a
    /// dash can resolve the plan it is implementing without a shell round-trip.
    #[serial]
    #[test]
    fn detail_entries_carry_the_dash_documents() {
        let (_temp, root) = stepped_dash("plan-path-dash");

        let entries = dash_detail_entries_in(&root);
        let entry = entries.iter().find(|d| d.name == "plan-path-dash").unwrap();
        // The plan is there from the moment it is written — nothing has to
        // record it, so no step verb has to have run first.
        assert_eq!(
            entry.documents.plan.as_deref(),
            Some(&*plan_file(&root, "plan-path-dash").to_string_lossy())
        );
        // Absolute, because the deck composes nothing: it is handed the path.
        assert!(entry.documents.plan.as_deref().unwrap().starts_with('/'));
        assert!(entry.documents.brief.is_none());

        // A dash with no documents at all carries none.
        create("bare-dash", None, false, None).unwrap();
        let entries = dash_detail_entries_in(&root);
        let bare = entries.iter().find(|d| d.name == "bare-dash").unwrap();
        assert!(bare.documents.is_empty());
    }

    /// The divergence a join would only reveal at merge time, said on every
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
            overlap_paths(&entry.base_overlap),
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
            entry.stage, "created",
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
        step_start("resume-dash", 1, 2).unwrap();
        let interrupted = fs::read_to_string(plan_file(&root, "resume-dash")).unwrap();

        step_start("resume-dash", 1, 2).expect("a resumed run re-enters its own step");
        let after = fs::read_to_string(plan_file(&root, "resume-dash")).unwrap();
        assert_eq!(after, interrupted, "re-entry moves no byte of the plan");
    }

    #[serial]
    #[test]
    fn step_withdraw_closes_the_row_with_no_commit() {
        let (_temp, root) = stepped_dash("withdraw-dash");
        step_start("withdraw-dash", 1, 2).unwrap();

        let outcome = step_withdraw("withdraw-dash", 1).unwrap();
        assert_eq!(outcome.status, "withdrawn");
        assert_eq!(outcome.commit, None);
        assert_eq!(
            outcome.through,
            Some(2),
            "a withdrawal inherits the run's declared selection"
        );

        let row = ledger_row(&root, "withdraw-dash", "step-1");
        assert_eq!(row.status, "withdrawn");
        assert_eq!(row.commit, None, "no round was made, so none is recorded");

        // The log carries the step's title, the grammar a start writes, since
        // there is no sha to name.
        let log_path = tugutil_core::project_state_dir(&root).join("dash-log.md");
        let log = fs::read_to_string(&log_path).unwrap();
        assert!(
            log.lines()
                .any(|l| l.contains("step-withdrawn") && l.contains("1/2 Step 1:")),
            "{log}"
        );
        assert_eq!(
            crate::dash::read_declarations(&root, "withdraw-dash").latest,
            Some(crate::dash::DashDeclaration::Step {
                current: 1,
                total: 2
            })
        );
    }

    #[serial]
    #[test]
    fn step_withdraw_refuses_a_done_row() {
        let (_temp, root) = stepped_dash("withdraw-done-dash");
        step_start("withdraw-done-dash", 1, 2).unwrap();
        step_done("withdraw-done-dash", 1, Some("abc1234")).unwrap();
        let before = fs::read_to_string(plan_file(&root, "withdraw-done-dash")).unwrap();

        let err = step_withdraw("withdraw-done-dash", 1).unwrap_err();
        assert!(err.contains("is 'done'"), "{err}");
        assert!(err.contains("#step-1"), "{err}");
        assert!(err.contains("plan.md"), "the refusal names the plan: {err}");

        let after = fs::read_to_string(plan_file(&root, "withdraw-done-dash")).unwrap();
        assert_eq!(after, before, "a refusal moves no byte of the plan");
    }

    #[serial]
    #[test]
    fn a_withdrawn_step_can_be_taken_up_again() {
        let (_temp, root) = stepped_dash("reopen-dash");
        step_withdraw("reopen-dash", 1).unwrap();
        step_start("reopen-dash", 1, 2).expect("changing your mind needs no hand-edit");
        assert_eq!(
            ledger_row(&root, "reopen-dash", "step-1").status,
            "in progress"
        );
    }

    /// The wedge [P02] exists to prevent: a run whose final selected step is
    /// withdrawn is finished, and so joinable.
    #[serial]
    #[test]
    fn withdrawing_the_final_selected_step_completes_the_run() {
        let (_temp, root) = stepped_dash("armed-dash");
        step_start("armed-dash", 1, 2).unwrap();
        step_done("armed-dash", 1, Some("abc1234")).unwrap();
        step_withdraw("armed-dash", 2).unwrap();

        let found = crate::dash::read_declarations(&root, "armed-dash");
        assert!(found.run_complete, "the declared selection is finished");
        assert!(!found.step_in_flight);
    }

    #[serial]
    #[test]
    fn preflight_leaves_ordinary_base_dirt_wording_alone() {
        let (_temp, root) = plain_dash("plainly-dash");
        let worktree = worktree_path(&root, "plainly-dash");
        fs::write(worktree.join("README.md"), "# Dash\n").unwrap();
        commit("plainly-dash", "touch readme", None).unwrap();
        fs::write(root.join("README.md"), "# Local\n").unwrap();

        let blockers = join_preflight_in(&root, "plainly-dash").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert!(dirt.detail.contains("README.md"), "{:?}", dirt);
        assert!(
            dirt.detail.contains("differs from this dash"),
            "the sentence states the fact and names no act it cannot perform: {}",
            dirt.detail
        );
    }

    /// An untracked base file at a path the dash changed is what `git merge
    /// --squash` refuses outright — previously a clean preview and a failing
    /// join. It is a blocker now, and only when it actually intersects.
    #[serial]
    #[test]
    fn preflight_blocks_untracked_base_files_the_dash_would_overwrite() {
        let (_temp, root) = plain_dash("overwrite-dash");
        let worktree = worktree_path(&root, "overwrite-dash");
        fs::create_dir_all(worktree.join("roadmap")).unwrap();
        fs::write(worktree.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        commit("overwrite-dash", "add the plan", None).unwrap();

        // A disjoint untracked file does not block.
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        let clean = join_preflight_in(&root, "overwrite-dash").unwrap();
        assert!(clean.iter().all(|b| b.kind != "base-dirt"), "{clean:?}");

        // The same path the dash added does — when it is other content. An
        // untracked base file holding what the dash adds byte for byte is the
        // dash's own work sitting on the base, and is dropped rather than
        // refused over, the same as its tracked twin.
        fs::create_dir_all(root.join("roadmap")).unwrap();
        fs::write(root.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        let echo = join_preflight_in(&root, "overwrite-dash").unwrap();
        assert!(
            echo.iter().all(|b| b.kind != "base-dirt"),
            "an identical untracked copy is the dash's own bytes: {echo:?}"
        );

        fs::write(root.join("roadmap/plan.md"), "somebody else's plan\n").unwrap();
        let blockers = join_preflight_in(&root, "overwrite-dash").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert_eq!(dirt.paths, vec!["roadmap/plan.md".to_string()]);
        assert!(dirt.detail.contains("would be overwritten"), "{:?}", dirt);

        // The execute path refuses with the same sentence, rather than a clean
        // preview followed by a squash that fails on the untracked file.
        let err = join("overwrite-dash", mechanics()).unwrap_err();
        assert_eq!(err, dirt.detail);
        assert!(branch_present(&root, "tugdash/overwrite-dash"));
    }

    #[serial]
    #[test]
    fn discard_ends_an_arc_that_never_made_a_dash() {
        let (_temp, root) = repo_for_create();
        crate::arc::append_arc_start(&root, "arc-only", "dash/idea.md").unwrap();
        assert!(crate::arc::read_arc(&root, "arc-only").is_some());

        let out = discard("arc-only", Some("cli"), false).unwrap();
        assert_eq!(out.documents_kept, None);
        assert!(out.work_restored.is_empty());
        assert_eq!(out.warnings.len(), 1, "it says what it ended");
        assert_eq!(crate::arc::read_arc(&root, "arc-only"), None);
        // With the record ended there is nothing left under the name.
        assert!(discard("arc-only", Some("cli"), false).is_err());
    }

    /// A repo with no dash yet.
    fn repo_for_create() -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    /// A repo with one plain dash and no documents anywhere.
    fn plain_dash(name: &str) -> (TempDir, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create(name, None, false, None).unwrap();
        let root = fs::canonicalize(&repo).unwrap();
        (temp, root)
    }

    fn dirt_entry<'a>(out: &'a CreateOutcome, path: &str) -> &'a BaseDirtPath {
        out.base_dirt
            .iter()
            .find(|d| d.path == path)
            .unwrap_or_else(|| panic!("{path} not censused: {:?}", out.base_dirt))
    }

    /// A repository with no `.gitignore` at all, which is what makes the
    /// exclusion in `create` load-bearing rather than incidental.
    fn bare_repo_beside_state(temp: &TempDir) -> std::path::PathBuf {
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .output()
                .unwrap();
        }
        fs::create_dir_all(repo.join(".tugtool")).unwrap();
        fs::write(repo.join(".tugtool/.keep"), "").unwrap();
        fs::write(repo.join("README.md"), "# Test\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(&repo).unwrap();
        repo
    }

    /// The whole point of moving the documents out of the tree: what a join
    /// lands is the work, and the paperwork is not in it.
    #[serial]
    #[test]
    fn a_planned_dash_lands_a_commit_whose_tree_holds_no_document() {
        let temp = TempDir::new().unwrap();
        let repo = bare_repo_beside_state(&temp);
        create("landing", None, false, None).unwrap();
        let root = fs::canonicalize(&repo).unwrap();

        let documents = documents_dir(&root, "landing");
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("brief.md"), "# The brief\n").unwrap();
        fs::write(documents.join("plan.md"), TWO_STEP_PLAN).unwrap();

        let worktree = worktree_path(&root, "landing");
        fs::write(worktree.join("feature.txt"), "the work\n").unwrap();
        commit("landing", "add the feature", None).unwrap();

        // Even without a `.gitignore`, `create` kept `.tug/` out of git.
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]).unwrap(), "");

        let out = join("landing", mechanics()).unwrap();
        let tree = git_stdout(&root, &["ls-tree", "-r", "HEAD", "--name-only"]).unwrap();
        assert!(tree.contains("feature.txt"), "{tree}");
        assert!(
            !tree.lines().any(|line| line.starts_with(".tug/")),
            "the landed tree holds no document: {tree}"
        );
        assert!(
            !documents.exists(),
            "the join removed the documents directory"
        );
        assert!(
            out.warnings
                .iter()
                .any(|w| w == "removed .tug/dashes/landing/"),
            "the receipt names the removal: {:?}",
            out.warnings
        );
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]).unwrap(), "");
    }

    /// The inverse: a discarded dash's decisions are the only trace the user
    /// may want back, so they stay and the receipt says where ([P11]).
    #[serial]
    #[test]
    fn a_discarded_dash_keeps_its_documents_and_says_so() {
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
        assert!(!branch_present(&root, "tugdash/kept"));
    }

    #[serial]
    #[test]
    fn create_over_a_clean_base_reports_nothing() {
        let (_temp, _root) = repo_for_create();
        let out = create("tidy", None, false, None).unwrap();
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
        let (_temp, root) = repo_for_create();
        create("newborn", None, false, None).unwrap();

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
    /// carried into a dash, committed there as a round, given an authored draft
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
        let landed = join("walk", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(&root, &["log", "-1", "--format=%B", &sha]).unwrap();

        assert_eq!(
            committed,
            with_dash_trailers(
                &root,
                "walk",
                "tugdash/walk",
                &format!("tugdash(walk): {draft}"),
                None
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
        fs::write(worktree.join("typed.txt"), "written in the dash\n").unwrap();
        fs::write(worktree.join("README.md"), "# edited in the dash\n").unwrap();

        let out = discard("typed", None, false).unwrap();
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
    /// rather than being destroyed to complete a discard, and the refusal comes
    /// before anything has moved.
    #[serial]
    #[test]
    fn discard_refuses_rather_than_overwrite_a_conflicting_base_edit() {
        let (_temp, root) = repo_for_create();
        create("clash", None, false, None).unwrap();
        let worktree = worktree_path(&root, "clash");
        fs::write(worktree.join("README.md"), "# the dash's words\n").unwrap();
        fs::write(root.join("README.md"), "# the user's words\n").unwrap();

        let err = discard("clash", None, false).unwrap_err();
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
    fn discard_of_a_clean_worktree_behaves_exactly_as_before() {
        let (_temp, root) = repo_for_create();
        create("spotless", None, false, None).unwrap();
        let out = discard("spotless", None, false).unwrap();
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

    /// Apply-all-before-clean-any is what makes tearing the dash down a safe
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

        let err = create("doomed-carry", None, true, None).unwrap_err();
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

        let err = create("unmerged", None, true, None).unwrap_err();
        assert!(err.contains("unmerged"), "{err}");
        assert!(err.contains("clash.txt"), "{err}");
        assert!(!branch_present(&root, "tugdash/unmerged"));
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

    // --- dash verbs inside a scoped repo universe ---------------------------
    //
    // These tests set `TUG_REPO_UNIVERSE` for their own process. That is safe
    // because the workspace runs under `cargo nextest`, which executes one
    // process per test, and because every test here is `#[serial]` besides —
    // the same regime `redirect_state_dir` already relies on.

    /// Pin the repo universe for the rest of this test's process.
    fn set_universe(path: &Path) {
        // SAFETY: serial test under nextest; see redirect_state_dir.
        unsafe {
            std::env::set_var(tugutil_core::REPO_UNIVERSE_ENV, path);
        }
    }

    /// A scratch base checkout on `main` plus a linked worktree on `feature`
    /// that is itself the universe — the shape an app-test run has, where the
    /// worktree is the project the instance under test has open.
    ///
    /// Returns `(base, universe)`, both canonicalized so they compare equal to
    /// what the resolver returns, with the cwd left on the universe.
    fn base_with_universe(temp: &TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = temp.path().join("base");
        fs::create_dir_all(&base).unwrap();
        init_git_repo(&base);
        redirect_state_dir(&temp.path().join("state"));
        let universe = temp.path().join("universe");
        run_git(
            &base,
            &[
                "worktree",
                "add",
                universe.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        set_universe(&universe);
        std::env::set_current_dir(&universe).unwrap();
        (
            fs::canonicalize(&base).unwrap(),
            fs::canonicalize(&universe).unwrap(),
        )
    }

    /// A dash created from inside a universe is born there: its worktree lives
    /// under the universe, it forks from the branch the universe has out, and
    /// the checkout that merely owns the common dir is left alone ([P01],
    /// [P03], [P07] — refs stay shared, paths do not).
    #[serial]
    #[test]
    fn test_universe_create_stays_inside_the_universe() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);

        // Content that exists only on the universe's branch, so a dash forked
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
            "the dash worktree is born inside the universe, not beside the base"
        );
        assert_eq!(rev_parse_at(&universe, "tugdash/scoped"), feature_tip);
        assert!(
            Path::new(&created.worktree).join("scoped.txt").exists(),
            "the dash holds the universe's content"
        );

        // The base checkout is untouched: no worktree home, no dash-log, clean.
        assert!(!base.join(".tug").exists(), "no worktree home under base");
        assert!(
            !dash_log_path(&temp.path().join("state"), &base).exists(),
            "the base's project state records nothing"
        );
        let dirt = Command::new("git")
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

    /// The read verbs answer about the universe: a caller standing in it is
    /// told about its dashes, with worktree paths under it.
    #[serial]
    #[test]
    fn test_universe_detail_entries_resolve_to_the_universe() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);
        create("listed", None, false, Some("feature")).unwrap();

        let entries = dash_detail_entries_in(&universe);
        let entry = entries
            .iter()
            .find(|d| d.name == "listed")
            .expect("the universe lists its own dash");
        assert_eq!(entry.base, "feature");
        assert!(
            Path::new(&entry.worktree_abs).starts_with(&universe),
            "worktree_abs under the universe, got {}",
            entry.worktree_abs
        );
        assert!(
            !Path::new(&entry.worktree_abs).starts_with(&base),
            "and never under the checkout that owns the common dir"
        );
    }

    /// The join narrates its beats, in the order the code performs them.
    ///
    /// The join takes real seconds and used to say nothing for all of them:
    /// the press landed and the next word was the durable commit message,
    /// however long later. These beats are what fills that silence — a
    /// liveness hint, never the carrier of truth.
    ///
    /// The order asserted here is the code's own, and it is not the order the
    /// beat names suggest: `record` is the dash-log line, which is written
    /// *last*, after the worktree is gone and the branch is deleted, because it
    /// is the terminal record of a join that already happened.
    #[serial]
    #[test]
    fn test_a_join_narrates_its_beats_and_a_preview_narrates_nothing() {
        let temp = TempDir::new().unwrap();
        let (_base, universe) = base_with_universe(&temp);

        create("narrator", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/narrator");
        fs::write(worktree.join("landed.txt"), "from the dash\n").unwrap();
        commit("narrator", "r1", None).unwrap();

        // A preview mutates nothing, so it has nothing to narrate.
        let previewed = std::cell::RefCell::new(Vec::<String>::new());
        join_in_with_progress(
            &universe,
            "narrator",
            JoinOptions {
                preview: true,
                ..Default::default()
            },
            |beat, status| previewed.borrow_mut().push(format!("{beat}:{status}")),
        )
        .unwrap();
        assert!(
            previewed.borrow().is_empty(),
            "a preview emits no beats: {:?}",
            previewed.borrow()
        );

        let beats = std::cell::RefCell::new(Vec::<String>::new());
        let outcome = join_in_with_progress(&universe, "narrator", mechanics(), |beat, status| {
            beats.borrow_mut().push(format!("{beat}:{status}"))
        })
        .unwrap();
        assert!(outcome.commit_hash.is_some(), "the squash landed");

        assert_eq!(
            beats.borrow().as_slice(),
            [
                "squash:start",
                "squash:done",
                "teardown:start",
                "teardown:done",
                "release:start",
                "release:done",
                "record:start",
                "record:done",
            ],
            "every beat, paired, in the order the join performs them"
        );
    }

    /// The whole join runs inside the universe: the preflight reads the
    /// universe's checked-out branch, and the squash lands on it — the base
    /// checkout's HEAD never moves (#landing-mechanics).
    #[serial]
    #[test]
    fn test_universe_join_lands_on_the_universe_branch() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);
        let base_head_before = rev_parse_at(&base, "HEAD");

        create("lander", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/lander");
        fs::write(worktree.join("landed.txt"), "from the dash\n").unwrap();
        commit("lander", "r1", None).unwrap();

        let blockers = join_preflight_in(&universe, "lander").unwrap();
        assert!(
            blockers.is_empty(),
            "a coherent universe has nothing to refuse over: {blockers:?}"
        );

        let outcome = join_in(&universe, "lander", mechanics()).unwrap();
        assert!(outcome.commit_hash.is_some(), "the squash landed");
        assert_eq!(
            fs::read_to_string(universe.join("landed.txt")).unwrap(),
            "from the dash\n",
            "the universe's working tree carries the landed content"
        );
        assert!(!worktree.exists(), "dash worktree torn down");
        assert!(!branch_present(&universe, "tugdash/lander"));

        assert_eq!(
            rev_parse_at(&base, "HEAD"),
            base_head_before,
            "the base checkout's HEAD never moved"
        );
        let dlog =
            fs::read_to_string(dash_log_path(&temp.path().join("state"), &universe)).unwrap();
        assert!(
            dlog.contains("joined"),
            "the universe's dash-log records it"
        );
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
        assert!(!branch_present(&universe, "tugdash/goner"), "branch gone");
        assert!(!base.join(".tug").exists());
    }

    /// The commit a revision names, as a full sha.
    fn rev_parse_at(repo: &Path, rev: &str) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", rev])
            .output()
            .unwrap();
        assert!(out.status.success(), "git rev-parse {rev} failed");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// An explicit base forks the dash from that branch and records it, so a
    /// checkout parked off the default branch makes a dash that holds the
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
        assert_eq!(dash_base(repo, "based").unwrap(), "feature");
        assert_eq!(rev_parse_at(repo, "tugdash/based"), feature_tip);
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

        let err = create("nobase", None, false, Some("no-such-branch")).unwrap_err();
        assert!(
            err.contains("no-such-branch"),
            "the refusal must name the branch: {err}"
        );
        assert!(!branch_present(repo, "tugdash/nobase"));
        assert!(!worktree_path(repo, "nobase").exists());
        assert!(config_get(repo, "branch.tugdash/nobase.tugbase").is_none());
    }

    /// A dash's base is set at birth: a revisit reports the recorded base and
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
        assert_eq!(dash_base(repo, "settled").unwrap(), "main");
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

        let first = create("id-dash", None, false, None).unwrap();
        let id = first.id.clone().expect("create mints an id");
        assert!(id.starts_with("tugdash/id-dash#"), "owner key shape: {id}");

        // The idempotent revisit reports the same identity, not a fresh mint.
        let second = create("id-dash", None, false, None).unwrap();
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

    /// The stage precedence table ([P03]): a join outranks a declaration, a
    /// declaration outranks a draft, a draft outranks activity, activity
    /// outranks a fresh dash.
    #[test]
    fn stage_derivation_follows_its_precedence() {
        // An undeclared dash derives exactly what it always did.
        assert_eq!(derive_stage(0, false, false, false, None, false), "created");
        assert_eq!(derive_stage(1, false, false, false, None, false), "working");
        assert_eq!(derive_stage(0, true, false, false, None, false), "working");
        assert_eq!(
            derive_stage(2, true, true, false, None, false),
            "draft-ready"
        );
        // A draft with no work yet is still draft-ready — the draft is the
        // stronger signal.
        assert_eq!(
            derive_stage(0, false, true, false, None, false),
            "draft-ready"
        );
        // A join in flight outranks everything below it.
        assert_eq!(derive_stage(3, true, true, true, None, false), "joining");
        assert_eq!(derive_stage(0, false, false, true, None, false), "joining");

        let stepping = Some(DashDeclaration::Step {
            current: 3,
            total: 9,
        });
        // Declarations outrank a draft — a planned run writes its draft before
        // the audit, so a draft that won would hide `built` and `audited`.
        assert_eq!(
            derive_stage(2, true, true, false, stepping, false),
            "implementing"
        );
        assert_eq!(
            derive_stage(2, true, true, false, Some(DashDeclaration::Built), false),
            "built"
        );
        assert_eq!(
            derive_stage(2, true, true, false, Some(DashDeclaration::Audited), false),
            "audited"
        );
        // …and a join still outranks a declaration.
        assert_eq!(
            derive_stage(2, true, true, true, stepping, false),
            "joining"
        );

        // A finished run's latest declaration is still a step, so `ready` must
        // outrank `implementing` or a completed selection reads as step three
        // of nine forever ([P07]).
        assert_eq!(
            derive_stage(2, false, false, false, stepping, true),
            "ready"
        );
        // A dash somebody marked keeps its own word, ready or not.
        assert_eq!(
            derive_stage(2, false, false, false, Some(DashDeclaration::Built), true),
            "built"
        );
        assert_eq!(
            derive_stage(2, false, false, false, Some(DashDeclaration::Audited), true),
            "audited"
        );
        // And a plan-less ready dash reads `ready` rather than `working`.
        assert_eq!(derive_stage(1, false, false, false, None, true), "ready");
    }

    /// Table T01 — what arms and what stays dark, one assertion per row.
    #[test]
    fn join_readiness_follows_the_arming_matrix() {
        use crate::dash::{DashDeclarations, join_ready};

        let run =
            |through: Option<u32>, complete: bool, step: Option<(u32, u32)>| DashDeclarations {
                latest: step.map(|(current, total)| DashDeclaration::Step { current, total }),
                step,
                run_through: through,
                run_complete: complete,
                ..DashDeclarations::default()
            };
        let marked = |stage: DashDeclaration| DashDeclarations {
            latest: Some(stage),
            step: Some((8, 15)),
            ..DashDeclarations::default()
        };

        // A declared selection that finished.
        assert!(join_ready(
            3,
            false,
            false,
            &run(Some(8), true, Some((8, 15))),
            true
        ));
        // …and one that stopped short of its declared end.
        assert!(!join_ready(
            3,
            false,
            false,
            &run(Some(8), false, Some((7, 15))),
            true
        ));
        // A step still open is never ready, whatever the arithmetic says.
        assert!(!join_ready(
            3,
            false,
            false,
            &run(Some(8), false, Some((8, 15))),
            true
        ));
        // A mark arms on its own — the manual and legacy path ([P03]).
        assert!(join_ready(
            3,
            false,
            false,
            &marked(DashDeclaration::Built),
            true
        ));
        assert!(join_ready(
            3,
            false,
            false,
            &marked(DashDeclaration::Audited),
            true
        ));
        // A plan-less generation arms on every round ([P02])…
        assert!(join_ready(
            1,
            false,
            false,
            &DashDeclarations::default(),
            false
        ));
        // …but not while its tracked work is uncommitted.
        assert!(!join_ready(
            1,
            true,
            false,
            &DashDeclarations::default(),
            false
        ));
        // A dash that adopted a plan and has declared no step is a run that
        // has not started: its one round is the adoption, and the arc that
        // cancelled here must not read as ready to join.
        assert!(!join_ready(
            1,
            false,
            false,
            &DashDeclarations::default(),
            true
        ));
        // A legacy plan dash — steps declared, no run — stays dark until marked.
        assert!(!join_ready(
            3,
            false,
            false,
            &run(None, false, Some((8, 15))),
            true
        ));
        // A join in flight is landing, not ready; and nothing to join is not
        // ready either.
        assert!(!join_ready(
            1,
            false,
            true,
            &DashDeclarations::default(),
            false
        ));
        assert!(!join_ready(
            0,
            false,
            false,
            &DashDeclarations::default(),
            false
        ));
    }

    /// `status` walks a dash's whole lifecycle: fresh → a round → an authored
    /// draft → an interrupted join (Spec S05, [P06]).
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

        let created = create("status-dash", Some("Test".to_string()), false, None).unwrap();
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

        // A committed round on a plan-less dash is a finished unit of asked
        // work, so the dash is offerable the moment its worktree is clean
        // ([P02]) — no mark, no build, nothing declared.
        commit("status-dash", "Add f", None).unwrap();
        let after_round = status("status-dash").unwrap();
        assert_eq!(after_round.stage, "ready");
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
        // The draft is recorded, but `ready` outranks `draft-ready`: a dash the
        // machine will offer says so, and the draft becomes the message that
        // offer carries rather than a stage of its own.
        let drafted = status("status-dash").unwrap();
        assert_eq!(drafted.stage, "ready");
        assert!(drafted.draft);

        // An interrupted join leaves an open record carrying its phase, and
        // outranks the draft. Seeded against the canonical repo path, which is
        // what `find_repo_root` (and so `status`) resolves — the state-dir
        // slug must agree.
        seed_interrupted_join(
            repo,
            "status-dash",
            crate::oplog::JoinPhase::WorktreeRemoved,
            "abc1234",
        );
        let joining = status("status-dash").unwrap();
        assert_eq!(joining.stage, "joining");
        assert_eq!(
            joining.join_journal_phase.as_deref(),
            Some("WorktreeRemoved")
        );

        // No sessions.db with a binding, so the dash reads as unbound ([P08]).
        assert!(joining.bound_sessions.is_empty());

        assert!(status("no-such-dash").is_err());

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }
    }

    /// `bound_sessions` counts **live** sessions only, so a dash whose only
    /// bound card has closed reads as unbound ([P08]) — the CLI-side face of
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

        let owner_key = create("unbound-dash", None, false, None)
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
            status("unbound-dash").unwrap().bound_sessions,
            vec!["sess-live".to_string()],
            "a closed session's row is never reported as a mating"
        );

        // With the last live session closed, the dash is unbound.
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute("UPDATE sessions SET state = 'closed'", [])
                .unwrap();
        }
        assert!(status("unbound-dash").unwrap().bound_sessions.is_empty());

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

        let result = create("test-dash", Some("desc".to_string()), false, None);
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

        create("test-dash", Some("first".to_string()), false, None).unwrap();
        // Second create returns the existing dash without error.
        let result = create("test-dash", Some("second".to_string()), false, None);
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
    fn test_dash_create_failing_hook_rolls_back() {
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
        assert!(!branch_present(repo, "tugdash/doomed"));

        // A retry (with a passing hook) then succeeds cleanly.
        write_config(repo, &[]);
        let retry = create("doomed", None, false, None);
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

        create("test-dash", Some("Test".to_string()), false, None).unwrap();

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

        create("test-dash", Some("Test".to_string()), false, None).unwrap();

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

        create("test-dash", None, false, None).unwrap();
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

        create("test-dash", Some("Test".to_string()), false, None).unwrap();

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

        create("dash1", None, false, None).unwrap();
        create("dash2", None, false, None).unwrap();

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

        create("test-dash", Some("Test dash".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("feature.txt"), "new feature\n").unwrap();
        commit("test-dash", "Add feature", None).unwrap();

        let result = join(
            "test-dash",
            JoinOptions {
                message: Some("Add new feature".to_string()),
                ..mechanics()
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

    /// The route that asked for a join is recorded in the dash-log’s
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

        create("routed", None, false, None).unwrap();
        fs::write(repo.join(".tug/worktrees/routed/f.txt"), "work\n").unwrap();
        commit("routed", "Add f", None).unwrap();

        join(
            "routed",
            JoinOptions {
                origin: Some("card".to_string()),
                ..mechanics()
            },
        )
        .unwrap();

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("joined via card"),
            "dash-log should name the route: {dlog}"
        );
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

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("discarded  via cli"),
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

        create("draft-dash", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/draft-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("draft-dash", "Add f", None).unwrap();

        // Preview first (`/join`'s beat 1): in-memory, clean, mutates nothing.
        let preview = join(
            "draft-dash",
            JoinOptions {
                preview: true,
                ..mechanics()
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
        join("draft-dash", mechanics()).unwrap();

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

        let created = create("id-draft-dash", Some("Test".to_string()), false, None).unwrap();
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

        join("id-draft-dash", mechanics()).unwrap();

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

    /// A round commit made from inside an arc stage cites the **line**, not
    /// the segment ([P13]): the line's callsign, the line's eight characters
    /// inside the parentheses, and the segment's own uuid in
    /// `Tug-Session-Id`, which is what pins the transcript the commit was
    /// made in.
    #[serial]
    #[test]
    fn a_round_commit_from_a_stage_cites_the_line() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        // A line of two segments: the root, and the stage a rotation seated.
        // The commit is made from the stage.
        let line_id = "7f3d2c18-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
        let stage = "aa11bb22-cc33-4d44-8e55-ff6677889900";
        let sessions_db = temp.path().join("sessions.db");
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE lines (
                    line_id       TEXT PRIMARY KEY,
                    tag           TEXT NOT NULL UNIQUE,
                    name          TEXT,
                    name_user_set INTEGER NOT NULL DEFAULT 0,
                    card_id       TEXT,
                    project_dir   TEXT NOT NULL,
                    created_at    INTEGER NOT NULL,
                    last_used_at  INTEGER NOT NULL
                 );
                 CREATE TABLE sessions (
                    session_id   TEXT PRIMARY KEY,
                    line_id      TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                    project_dir, created_at, last_used_at)
                 VALUES (?1, 'heroic-mule', 'dash+join-xp', 1, 'card-1', '/proj', 1, 1)",
                rusqlite::params![line_id],
            )
            .unwrap();
            for segment in ["5b4b5867-1111-4222-8333-444455556666", stage] {
                conn.execute(
                    "INSERT INTO sessions (session_id, line_id) VALUES (?1, ?2)",
                    rusqlite::params![segment, line_id],
                )
                .unwrap();
            }
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var(tugcore::instance::ENV_SESSIONS_DB, &sessions_db);
            std::env::set_var("TUG_SESSION_ID", stage);
        }

        create("cite-dash", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/cite-dash");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("cite-dash", "Add f", None).unwrap();

        let round = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let round = String::from_utf8_lossy(&round.stdout);

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var(tugcore::instance::ENV_SESSIONS_DB);
            std::env::remove_var("TUG_SESSION_ID");
        }

        assert!(
            round.contains("Tug-Session: heroic-mule (7f3d2c18)"),
            "the citation is the line's callsign and the line's short id: {round}"
        );
        assert!(
            round.contains(&format!("Tug-Session-Id: {stage}")),
            "the machine id pins the segment the commit was made in: {round}"
        );
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

        create("trailer-dash", Some("Test".to_string()), false, None).unwrap();
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
                ..mechanics()
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

    /// The join the CARD presses is executed by tugcast, which is nobody's
    /// session and exports no `TUG_SESSION_ID` — so the id travels in
    /// [`JoinOptions::session_id`] and the squash commit names both the session
    /// and the dash. Two trailers, which is the two pills a joined commit's
    /// History row shows ([P10], Spec S03).
    ///
    /// The env is deliberately EMPTY here: this is the server's situation, and
    /// a test that let the env answer would pass without the argument ever
    /// being read.
    #[serial]
    #[test]
    fn a_card_join_cites_the_session_the_request_names() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        let line_id = "3c2b1a09-8877-4665-9443-221100ffeedd";
        let session = "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b";
        let sessions_db = temp.path().join("sessions.db");
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE lines (
                    line_id       TEXT PRIMARY KEY,
                    tag           TEXT NOT NULL UNIQUE,
                    name          TEXT,
                    name_user_set INTEGER NOT NULL DEFAULT 0,
                    card_id       TEXT,
                    project_dir   TEXT NOT NULL,
                    created_at    INTEGER NOT NULL,
                    last_used_at  INTEGER NOT NULL
                 );
                 CREATE TABLE sessions (
                    session_id   TEXT PRIMARY KEY,
                    line_id      TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                    project_dir, created_at, last_used_at)
                 VALUES (?1, 'lean-radio', NULL, 0, 'card-1', '/proj', 1, 1)",
                rusqlite::params![line_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (session_id, line_id) VALUES (?1, ?2)",
                rusqlite::params![session, line_id],
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var(tugcore::instance::ENV_SESSIONS_DB, &sessions_db);
            std::env::remove_var("TUG_SESSION_ID");
        }

        create("card-join", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/card-join");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("card-join", "Add f", None).unwrap();

        join(
            "card-join",
            JoinOptions {
                message: Some("Land it".to_string()),
                session_id: Some(session.to_string()),
                ..mechanics()
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

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var(tugcore::instance::ENV_SESSIONS_DB);
        }

        assert!(
            squash.contains("Tug-Session: lean-radio (3c2b1a09)"),
            "the squash cites the session the request named: {squash}"
        );
        assert!(
            squash.contains(&format!("Tug-Session-Id: {session}")),
            "the machine id travels with the citation: {squash}"
        );
        assert!(
            squash.contains("Tug-Dash: tugdash/card-join onto "),
            "and still names the dash: {squash}"
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

        create("cand", None, false, None).unwrap();
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
                ..mechanics()
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

    /// The join's preconditions are what the execution enforces, and nothing
    /// else: a candidate rides along when one stands, the merge either applies
    /// or does not, and no verdict is consulted anywhere.
    ///
    /// This pins the deletion rather than the deleted thing. A stale verdict
    /// left on a live branch by an older build must not resurface as a
    /// refusal, and a dash that was never reconciled must not be stranded — a
    /// gate whose escape hatch also went away would be worse than the gate.
    #[serial]
    #[test]
    fn a_join_consults_no_verdict_and_a_stale_one_does_not_block_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("unverified", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/unverified");
        fs::write(worktree.join("new.txt"), "clean\n").unwrap();
        commit("unverified", "r1", None).unwrap();

        // The residue an older build would have left: a red verdict, in the
        // branch config, naming this dash. Nothing reads it.
        run_git(
            repo,
            &[
                "config",
                "--replace-all",
                "branch.tugdash/unverified.tugjoinverified",
                "aaa:bbb:red:unrun",
            ],
        );

        // A preview touches nothing and answers a different question.
        let previewed = join(
            "unverified",
            JoinOptions {
                preview: true,
                ..Default::default()
            },
        )
        .expect("a preview is not a join");
        assert!(previewed.previewed);
        assert!(previewed.commit_hash.is_none());

        let landed = join("unverified", JoinOptions::default())
            .expect("a reconcile-clean dash joins with no verdict anywhere");
        assert!(landed.commit_hash.is_some());
        assert!(!worktree.exists(), "the join really ran");
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

        create("cand", None, false, None).unwrap();
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
                ..mechanics()
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

        create("test-dash", None, false, None).unwrap();
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
        create("isect", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/isect");
        fs::write(worktree.join("shared.txt"), "base\ndash change\n").unwrap();
        commit("isect", "touch shared", None).unwrap();

        // Base dirt on the SAME file the dash changed → refuses, naming it.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let blocked = join("isect", mechanics());
        assert!(blocked.is_err());
        let err = blocked.unwrap_err();
        assert!(err.contains("differs from this dash"), "{err}");
        assert!(err.contains("shared.txt"), "{err}");
        assert!(branch_present(repo, "tugdash/isect"));

        // Move the base dirt to a DISJOINT file → the join now succeeds.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        let ok = join("isect", mechanics()).unwrap();
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
        create(name, None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees").join(name);
        fs::write(worktree.join("shared.txt"), "base\ndash change\n").unwrap();
        commit(name, "touch shared", None).unwrap();
    }

    fn preview(name: &str) -> JoinOutcome {
        join(
            name,
            JoinOptions {
                preview: true,
                ..mechanics()
            },
        )
        .unwrap()
    }

    fn blocker<'a>(outcome: &'a JoinOutcome, kind: &str) -> Option<&'a JoinBlocker> {
        outcome.blockers.iter().find(|b| b.kind == kind)
    }

    /// Every join op recorded for `name`, read from the canonical repo root the
    /// state dir is slugged from.
    fn ops_for(repo: &Path, name: &str) -> Vec<crate::oplog::OpPayload> {
        let root = std::fs::canonicalize(repo).unwrap();
        crate::oplog::list_ops(&root)
            .into_iter()
            .filter(|op| op.dash == name && op.verb == crate::oplog::OpVerb::Join)
            .collect()
    }

    /// A join that conflicts leaves the base exactly as it found it, so the
    /// record it opened is dropped rather than left open forever. An op that
    /// survived would name a join that did not happen — and once an incomplete
    /// join op *means* a teardown to resume, it would refuse every later join
    /// of this dash with a `--continue` that has nothing to continue.
    #[serial]
    #[test]
    fn a_conflicted_join_records_no_op() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "clash");
        let repo = temp.path();

        // The base edits the same file the dash did, so the squash conflicts.
        fs::write(repo.join("shared.txt"), "base\nbase edit\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base touches shared"]).unwrap();

        let out = join("clash", mechanics()).unwrap();
        assert_eq!(out.conflicts, vec!["shared.txt".to_string()]);
        assert!(out.commit_hash.is_none(), "nothing landed");

        assert!(
            ops_for(repo, "clash").is_empty(),
            "a join that landed nothing records nothing"
        );
        let root = std::fs::canonicalize(repo).unwrap();
        let err = crate::oplog::undo_in(&root, Some("clash")).unwrap_err();
        assert!(
            err.starts_with("nothing-to-undo:"),
            "and undo says so plainly rather than reporting a phantom: {err}"
        );
    }

    /// The same rule on the refusal side: a candidate the base has moved past
    /// never touches the base, so its record goes too.
    #[serial]
    #[test]
    fn a_stale_candidate_refusal_records_no_op() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("f.txt"), "A\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "seed f"]);

        create("stale", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/stale");
        fs::write(worktree.join("f.txt"), "B\n").unwrap();
        commit("stale", "r1", None).unwrap();
        fs::write(worktree.join("f.txt"), "C\n").unwrap();
        commit("stale", "r2", None).unwrap();
        fs::write(repo.join("f.txt"), "B\n").unwrap();
        run_git(repo, &["commit", "-am", "main to B"]);

        let candidate = crate::resolve::resolve_conflicts(repo, "stale", None)
            .unwrap()
            .candidate_commit
            .expect("candidate");

        fs::write(repo.join("other.txt"), "z\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "base advances again"]);

        let err = join(
            "stale",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .unwrap_err();
        assert!(err.contains("stale candidate"), "got: {err}");
        assert!(
            ops_for(repo, "stale").is_empty(),
            "and no record survives it"
        );
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
    fn undo_of_a_join_restores_the_base_the_branch_and_its_config() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "undome");
        let repo = temp.path();
        git_output(
            repo,
            &[
                "config",
                "branch.tugdash/undome.description",
                "a description",
            ],
        )
        .unwrap();
        let dash_tip = git_stdout(repo, &["rev-parse", "tugdash/undome"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        let tugid = config_get(repo, &tugid_config_key("undome"));

        join("undome", mechanics()).unwrap();
        assert_ne!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), base_tip);

        let out = crate::oplog::undo_in(repo, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Join);
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), base_tip);
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugdash/undome"]).unwrap(),
            dash_tip,
            "the branch is back at the tip the join consumed"
        );
        assert!(
            worktree_path(repo, "undome").exists(),
            "and its worktree with it"
        );
        // `branch -D` took the whole config section; the undo puts every fact
        // back, or the restored dash has forgotten what it is.
        assert_eq!(dash_base(repo, "undome").unwrap(), "main");
        assert_eq!(
            config_get(repo, &description_config_key("undome")).as_deref(),
            Some("a description")
        );
        assert_eq!(config_get(repo, &tugid_config_key("undome")), tugid);
        assert!(out.restored_unbound, "rebinding is the user's gesture");
    }

    #[serial]
    #[test]
    fn undo_refuses_when_the_base_moved_since_the_join() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "raced");
        let repo = temp.path();
        join("raced", mechanics()).unwrap();

        // Somebody committed on the base after the join. Resetting now would
        // destroy it, so the undo must decline rather than force.
        fs::write(repo.join("after.txt"), "landed later\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::undo_in(repo, None).unwrap_err();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            tip_now,
            "a refused undo changes nothing"
        );
        assert!(!branch_exists(repo, "tugdash/raced"));
    }

    #[serial]
    #[test]
    fn undo_is_offered_once_and_says_so_the_second_time() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "twice");
        let repo = temp.path();
        join("twice", mechanics()).unwrap();

        crate::oplog::undo_in(repo, None).unwrap();
        let err = crate::oplog::undo_in(repo, Some("twice")).unwrap_err();
        assert!(err.starts_with("already-undone:"), "{err}");
    }

    #[serial]
    #[test]
    fn undo_refuses_an_operation_that_never_finished() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "halfway");
        let repo = temp.path();
        let before = crate::oplog::capture_before(repo, "halfway").unwrap();
        let tips = crate::oplog::tips_of(&before);
        crate::oplog::record_begin(repo, crate::oplog::OpVerb::Join, "halfway", before, &tips)
            .unwrap();

        let err = crate::oplog::undo_in(repo, Some("halfway")).unwrap_err();
        assert!(err.starts_with("incomplete-op:"), "{err}");
    }

    #[serial]
    #[test]
    fn undo_of_a_discard_rebuilds_the_dash_and_leaves_handed_back_work_alone() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("backagain", None, true, None).unwrap();
        let dash_tip = git_stdout(&root, &["rev-parse", "tugdash/backagain"]).unwrap();
        discard("backagain", None, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );

        let out = crate::oplog::undo_in(&root, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Discard);
        assert_eq!(
            git_stdout(&root, &["rev-parse", "tugdash/backagain"]).unwrap(),
            dash_tip
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

    /// Park a real conflict chain on `name` by making the base and the dash
    /// edit the same line, then running the ladder until it gives up.
    ///
    /// Real rather than synthetic because `read_conflict` parses the record out
    /// of the root commit's message: a hand-made ref is not a chain.
    fn park_conflict(repo: &Path, name: &str) -> String {
        let worktree = worktree_path(repo, name);
        fs::write(worktree.join("shared.txt"), "base\ndash side\n").unwrap();
        commit(name, "dash edits shared", None).unwrap();
        fs::write(repo.join("shared.txt"), "base\nbase side\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base edits shared"]).unwrap();

        let outcome = crate::resolve::resolve_conflicts(repo, name, None).unwrap();
        assert_eq!(
            outcome.unresolved,
            vec!["shared.txt".to_string()],
            "the fixture must actually conflict"
        );
        crate::resolve::read_conflict(repo, name)
            .expect("a chain stands")
            .tip
    }

    /// Carry a parked conflict to the state a join actually meets: a resolver
    /// has committed a checkpoint and settled the file, so a candidate stands
    /// and the chain holds work worth keeping. Returns the chain tip.
    fn resolve_parked_conflict(repo: &Path, name: &str) -> (String, String) {
        let ws = crate::workshop::Workshop::open_conflict(repo, name).unwrap();
        fs::write(ws.path().join("shared.txt"), "base\nboth sides\n").unwrap();
        ws.checkpoint("resolve shared.txt")
            .expect("the checkpoint lands");
        let tip = crate::resolve::read_conflict(repo, name)
            .expect("the chain advanced")
            .tip;
        // `Workshop::commit` builds the candidate; anchoring it and recording
        // which dash head it was resolved against is what makes the join see
        // it, and both are the resolver's job in the live flow.
        let candidate = ws.commit("resolved").expect("the candidate commits");
        crate::resolve::write_candidate_ref(repo, name, &candidate).unwrap();
        let dash_head = git_stdout(repo, &["rev-parse", &branch_name(name)]).unwrap();
        git_output(
            repo,
            &[
                "config",
                &crate::resolve::join_source_config_key(name),
                &dash_head,
            ],
        )
        .unwrap();
        (tip, candidate)
    }

    // ---- the resolve lease ([P03], [P04]) ----

    /// A chain a resolver has opened but not finished — the state a second
    /// process must be able to read.
    fn lease_a_parked_conflict(repo: &Path, name: &str) -> String {
        park_conflict(repo, name);
        crate::resolve::mark_resolve_begun(repo, name).expect("the begin marker lands")
    }

    #[serial]
    #[test]
    fn a_join_over_a_live_chain_is_refused_by_name_and_touches_nothing() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "leased");
        let repo = temp.path();
        let marker = lease_a_parked_conflict(repo, "leased");

        // Dirt the sweep would commit, so a refusal below it would be visible.
        let worktree = worktree_path(repo, "leased");
        fs::write(worktree.join("late.txt"), "not yet committed\n").unwrap();
        let dash_tip = git_stdout(repo, &["rev-parse", "tugdash/leased"]).unwrap();
        let ops_before = crate::oplog::list_ops(repo).len();

        let err = join("leased", mechanics()).unwrap_err();
        assert!(err.contains("A resolve may still be running"), "{err}");
        assert!(err.contains("--break-lease"), "{err}");
        assert!(err.contains("resolve again"), "{err}");

        assert_eq!(
            crate::resolve::read_conflict(repo, "leased").unwrap().tip,
            marker,
            "a refused join leaves the chain exactly as it found it"
        );
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugdash/leased"]).unwrap(),
            dash_tip,
            "the refusal is above the dirt sweep, so no round was committed"
        );
        assert_eq!(
            crate::oplog::list_ops(repo).len(),
            ops_before,
            "and nothing was recorded"
        );
        assert!(branch_exists(repo, "tugdash/leased"));
    }

    #[serial]
    #[test]
    fn a_discard_over_a_live_chain_is_refused_the_same_way() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "leased");
        let repo = temp.path();
        let marker = lease_a_parked_conflict(repo, "leased");
        let ops_before = crate::oplog::list_ops(repo).len();

        let err = discard("leased", None, false).unwrap_err();
        assert!(err.contains("A resolve may still be running"), "{err}");
        assert!(err.contains("to discard anyway"), "{err}");

        assert_eq!(
            crate::resolve::read_conflict(repo, "leased").unwrap().tip,
            marker
        );
        assert!(branch_exists(repo, "tugdash/leased"), "the dash stands");
        assert!(worktree_path(repo, "leased").exists());
        assert_eq!(crate::oplog::list_ops(repo).len(), ops_before);
    }

    #[serial]
    #[test]
    fn a_preview_lists_live_resolve_as_a_blocker() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "leased");
        let repo = temp.path();
        lease_a_parked_conflict(repo, "leased");

        let blockers = join_preflight_in(repo, "leased").unwrap();
        let blocker = blockers
            .iter()
            .find(|b| b.kind == "live-resolve")
            .expect("the preview names the lease");
        assert!(
            blocker.detail.contains("A resolve may still be running"),
            "{}",
            blocker.detail
        );
    }

    #[serial]
    #[test]
    fn an_ended_lease_does_not_refuse() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "released");
        let repo = temp.path();
        park_conflict(repo, "released");
        crate::resolve::mark_resolve_begun(repo, "released").unwrap();
        crate::resolve::mark_resolve_ended(repo, "released").unwrap();

        let (_, candidate) = resolve_parked_conflict(repo, "released");
        let landed = join(
            "released",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .expect("a released lease refuses nothing");
        assert!(landed.commit_hash.is_some());
    }

    /// A resolve that died without its end marker stops refusing when its tip
    /// ages past the window — the crash case, and the reason the window is the
    /// resolver's own deadline rather than a guessed number.
    ///
    /// The ops path reads `SystemTime::now()` and cannot be handed a clock, and
    /// `git_output` carries no environment, so the marker is backdated at the
    /// point it is written instead.
    #[serial]
    #[test]
    fn an_aged_out_lease_does_not_refuse() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "stale");
        let repo = temp.path();
        park_conflict(repo, "stale");

        let tip = crate::resolve::read_conflict(repo, "stale").unwrap().tip;
        let long_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 3 * 60 * 60;
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "commit-tree",
                &format!("{tip}^{{tree}}"),
                "-p",
                &tip,
                "-m",
                "tugresolve(stale): begin",
            ])
            .env("GIT_COMMITTER_DATE", format!("{long_ago} +0000"))
            .output()
            .unwrap();
        assert!(out.status.success());
        let backdated = String::from_utf8_lossy(&out.stdout).trim().to_string();
        crate::resolve::advance_conflict_ref(repo, "stale", &backdated).unwrap();
        assert!(
            crate::resolve::resolve_lease(repo, "stale", std::time::SystemTime::now()).is_none(),
            "three hours is past the two-hour window"
        );

        let (_, candidate) = resolve_parked_conflict(repo, "stale");
        let landed = join(
            "stale",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .expect("an aged-out lease refuses nothing");
        assert!(landed.commit_hash.is_some());
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
        seed_dash_with_a_round(&temp, "broken");
        let repo = temp.path();
        park_conflict(repo, "broken");
        crate::resolve::mark_resolve_begun(repo, "broken").unwrap();

        // The crashed resolver's committed work, above the begin marker.
        let ws = crate::workshop::Workshop::open_conflict(repo, "broken").unwrap();
        fs::write(ws.path().join("shared.txt"), "base\nboth sides\n").unwrap();
        ws.checkpoint("tugresolve(broken): checkpoint").unwrap();
        let chain_tip = crate::resolve::read_conflict(repo, "broken").unwrap().tip;
        assert!(crate::resolve::resolve_lease(repo, "broken", SystemTime::now()).is_some());

        let out = discard("broken", Some("cli"), true).expect("the break tears the dash down");
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

    /// The same flag on the join: a chain whose resolver died, on a dash that
    /// now merges cleanly because the base moved on without it.
    #[serial]
    #[test]
    fn breaking_the_lease_lets_a_join_through() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "forced");
        let repo = temp.path();
        park_conflict(repo, "forced");
        crate::resolve::mark_resolve_begun(repo, "forced").unwrap();

        // The base takes its own edit back, so nothing is left to merge around
        // — the chain is stale, but the lease reads the tip, not validity.
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base backs its edit out"]).unwrap();
        assert!(crate::resolve::resolve_lease(repo, "forced", SystemTime::now()).is_some());

        let refused = join("forced", mechanics()).unwrap_err();
        assert!(
            refused.contains("A resolve may still be running"),
            "{refused}"
        );

        let landed = join(
            "forced",
            JoinOptions {
                break_lease: true,
                ..mechanics()
            },
        )
        .expect("the break lands the join");
        assert!(landed.commit_hash.is_some());
        assert!(
            landed
                .warnings
                .iter()
                .any(|w| w.contains("Broke the resolve lease")),
            "{:?}",
            landed.warnings
        );
    }

    #[serial]
    #[test]
    fn a_join_keeps_the_conflict_chain_alive_and_undo_puts_the_ref_back() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "chained");
        let repo = temp.path();
        park_conflict(repo, "chained");
        let (chain_tip, candidate) = resolve_parked_conflict(repo, "chained");

        // The join tears the dash down, and `clear_candidate` takes the
        // conflict ref with it.
        let landed = join(
            "chained",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .unwrap();
        assert!(
            landed.commit_hash.is_some(),
            "the join must land: {landed:?}"
        );
        assert!(
            crate::resolve::read_conflict(repo, "chained").is_none(),
            "the teardown cleared the ref"
        );

        // The op's keepalive is now the only thing holding the chain.
        let alive = git_output(
            repo,
            &["cat-file", "-e", &format!("{chain_tip}^{{commit}}")],
        )
        .unwrap()
        .status
        .success();
        assert!(alive, "the resolve work outlived the teardown");

        let out = crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(out.verb, crate::oplog::OpVerb::Join);
        assert_eq!(
            crate::resolve::read_conflict(repo, "chained").map(|c| c.tip),
            Some(chain_tip),
            "and the undo put the ref back where the teardown found it"
        );
    }

    #[serial]
    #[test]
    fn undo_of_a_discard_restores_the_conflict_ref_too() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "tossed");
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

    /// Never over newer work: a fresh resolve between the join and its undo
    /// owns the ref, and restoring the older chain would destroy it.
    #[serial]
    #[test]
    fn undo_leaves_a_newer_conflict_chain_alone_and_says_both_tips() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "raced2");
        let repo = temp.path();
        park_conflict(repo, "raced2");
        let (old_tip, candidate) = resolve_parked_conflict(repo, "raced2");

        join(
            "raced2",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .unwrap();

        // Somebody's newer resolve parked its own chain at the same ref.
        let newer = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        git_output(repo, &["update-ref", "refs/tug/conflict/raced2", &newer]).unwrap();

        let out = crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "refs/tug/conflict/raced2"]).unwrap(),
            newer,
            "the newer chain is untouched"
        );
        let warning = out
            .warnings
            .iter()
            .find(|w| w.contains("newer conflict"))
            .unwrap_or_else(|| panic!("the skip must be reported: {:?}", out.warnings));
        assert!(warning.contains(&newer[..9]), "{warning}");
        assert!(warning.contains(&old_tip[..9]), "{warning}");
    }

    /// The whole round, on one dash, in one pass — every leg asserted rather
    /// than eyeballed.
    ///
    /// A setext-underlined markdown file and a source file both conflict; a
    /// resolver checkpoints one; the base moves, invalidating the chain; the
    /// re-resolve salvages the checkpointed file and settles the rest; the join
    /// lands and its teardown clears the refs; undo puts everything back; redo
    /// takes it away again. The markdown file is the point: under the old
    /// prefix predicate its underline made it permanently unresolvable, so this
    /// drill could not have reached its second line.
    #[serial]
    #[test]
    fn the_whole_arc_runs_on_one_dash() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("doc.md"), "Heading\n=======\n\norig\n").unwrap();
        fs::write(repo.join("code.rs"), "fn main() { orig() }\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create("arc", None, false, None).unwrap();

        let worktree = repo.join(".tug/worktrees").join("arc");
        fs::write(worktree.join("doc.md"), "Heading\n=======\n\ndash\n").unwrap();
        fs::write(worktree.join("code.rs"), "fn main() { dash() }\n").unwrap();
        commit("arc", "dash edits both", None).unwrap();

        fs::write(repo.join("doc.md"), "Heading\n=======\n\nbase\n").unwrap();
        fs::write(repo.join("code.rs"), "fn main() { base() }\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base edits both"]).unwrap();

        // Both conflict, and the markdown file is one of them — which the old
        // predicate would have made permanently unresolvable.
        let first = crate::resolve::resolve_conflicts(repo, "arc", None).unwrap();
        assert_eq!(
            first.unresolved,
            vec!["code.rs".to_string(), "doc.md".to_string()]
        );

        // A resolver settles the markdown file, underline intact, and commits
        // the checkpoint.
        {
            let ws = crate::workshop::Workshop::open_conflict(repo, "arc").unwrap();
            fs::write(ws.path().join("doc.md"), "Heading\n=======\n\nboth\n").unwrap();
            assert_eq!(
                ws.unresolved().unwrap(),
                vec!["code.rs".to_string()],
                "the setext file reads settled"
            );
            ws.checkpoint("resolve doc.md").expect("checkpoint accepts");
        }

        // Base motion invalidates the chain without touching either stage.
        fs::write(repo.join("elsewhere.txt"), "unrelated\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "unrelated base work"]).unwrap();

        // The re-resolve salvages the checkpointed file.
        let second = crate::resolve::resolve_conflicts(repo, "arc", None).unwrap();
        assert!(
            second
                .resolved
                .iter()
                .any(|r| r.path == "doc.md"
                    && r.resolved_by == crate::resolve::ResolvedBy::Salvage),
            "doc.md must arrive salvaged: {:?}",
            second.resolved
        );
        assert_eq!(second.unresolved, vec!["code.rs".to_string()]);

        // Finish the remainder and land.
        let (chain_tip, candidate) = {
            let ws = crate::workshop::Workshop::open_conflict(repo, "arc").unwrap();
            fs::write(ws.path().join("code.rs"), "fn main() { both() }\n").unwrap();
            ws.checkpoint("resolve code.rs").unwrap();
            let tip = crate::resolve::read_conflict(repo, "arc").unwrap().tip;
            let candidate = ws.commit("resolved").unwrap();
            crate::resolve::write_candidate_ref(repo, "arc", &candidate).unwrap();
            let dash_head = git_stdout(repo, &["rev-parse", "tugdash/arc"]).unwrap();
            git_output(
                repo,
                &[
                    "config",
                    &crate::resolve::join_source_config_key("arc"),
                    &dash_head,
                ],
            )
            .unwrap();
            (tip, candidate)
        };
        let dash_tip = git_stdout(repo, &["rev-parse", "tugdash/arc"]).unwrap();
        let base_before = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        join(
            "arc",
            JoinOptions {
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        assert_ne!(landed, base_before);
        assert!(!branch_exists(repo, "tugdash/arc"));
        assert_eq!(
            fs::read_to_string(repo.join("doc.md")).unwrap(),
            "Heading\n=======\n\nboth\n",
            "the resolved bytes landed, underline and all"
        );
        // The teardown cleared the chain, and only the keepalive holds it.
        assert!(crate::resolve::read_conflict(repo, "arc").is_none());
        assert!(
            git_output(
                repo,
                &["cat-file", "-e", &format!("{chain_tip}^{{commit}}")]
            )
            .unwrap()
            .status
            .success(),
            "the resolve work outlived the teardown"
        );

        // Undo restores everything the teardown took.
        crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugdash/arc"]).unwrap(),
            dash_tip
        );
        assert_eq!(
            crate::resolve::read_conflict(repo, "arc").map(|c| c.tip),
            Some(chain_tip),
            "including the conflict chain"
        );

        // Redo takes it away again.
        crate::oplog::redo_in(repo, None).unwrap();
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), landed);
        assert!(!branch_exists(repo, "tugdash/arc"));

        // And the log reads as a coherent history.
        let ops = crate::oplog::list_ops(repo);
        let verbs: Vec<&str> = ops.iter().map(|o| o.verb.as_str()).collect();
        assert_eq!(
            verbs,
            vec!["redo", "undo", "join"],
            "newest first, one of each"
        );
        assert!(
            ops.iter()
                .find(|o| o.verb == crate::oplog::OpVerb::Join)
                .unwrap()
                .is_undoable(),
            "the join is undoable once more, so a further press means it"
        );
    }

    // ---- redo ----

    /// The full cycle, with the bookkeeping asserted at every stage: a redo
    /// re-applies what the undo took away and hands candidacy back to the
    /// original, so the next `undo` press means the join again rather than
    /// descending into the reversal records.
    #[serial]
    #[test]
    fn a_join_undone_is_redone_and_undone_again() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "cycle");
        let repo = temp.path();
        let dash_tip = git_stdout(repo, &["rev-parse", "tugdash/cycle"]).unwrap();
        let base_before = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        join("cycle", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let undone = crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert!(branch_exists(repo, "tugdash/cycle"));

        let redone = crate::oplog::redo_in(repo, None).unwrap();

        assert_eq!(redone.verb, crate::oplog::OpVerb::Join);
        assert_eq!(redone.original_seq, undone.seq);
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            landed,
            "the base is back at what the join landed"
        );
        assert!(
            !branch_exists(repo, "tugdash/cycle"),
            "and the dash is torn down again"
        );
        assert!(!worktree_path(repo, "cycle").exists());
        assert_eq!(config_get(repo, &base_config_key("cycle")), None);

        // The original is undoable again; the undo is not, because it was
        // redone rather than undone.
        let ops = crate::oplog::list_ops(repo);
        let original = ops.iter().find(|o| o.seq == undone.seq).unwrap();
        assert!(original.undone_by.is_none(), "candidacy handed back");
        let undo_op = ops.iter().find(|o| o.seq == undone.recorded_as).unwrap();
        assert_eq!(undo_op.undone_by, Some(redone.recorded_as));
        assert_eq!(undo_op.reverses, Some(undone.seq));
        let redo_op = ops.iter().find(|o| o.seq == redone.recorded_as).unwrap();
        assert_eq!(redo_op.reverses, Some(undone.recorded_as));
        assert!(
            !redo_op.is_undoable(),
            "a redo record is never an undo candidate"
        );

        // A second undo press means the join, not the bookkeeping.
        let again = crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(again.seq, undone.seq, "the same operation, once more");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugdash/cycle"]).unwrap(),
            dash_tip
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
        assert!(branch_exists(&root, "tugdash/backandgone"));

        let out = crate::oplog::redo_in(&root, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Discard);
        assert!(!branch_exists(&root, "tugdash/backandgone"));
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

    /// [L23]: a redo tears the worktree down, so uncommitted work started in
    /// the dash between the undo and the redo would be destroyed. It refuses
    /// and names the paths instead — and changes nothing on the way out.
    #[serial]
    #[test]
    fn redo_refuses_over_a_dirty_restored_worktree() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "dirty");
        let repo = temp.path();
        join("dirty", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();
        let base_after_undo = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        assert_ne!(base_after_undo, landed);

        // The user started working in the dash the undo gave back.
        let worktree = worktree_path(repo, "dirty");
        fs::write(worktree.join("in-progress.txt"), "half a thought\n").unwrap();

        let err = crate::oplog::redo_in(repo, None).unwrap_err();

        assert!(err.starts_with("worktree-dirty:"), "{err}");
        assert!(
            err.contains("in-progress.txt"),
            "the paths are named: {err}"
        );
        assert!(
            worktree.join("in-progress.txt").exists(),
            "and the work is still there"
        );
        assert!(branch_exists(repo, "tugdash/dirty"));
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_after_undo,
            "a refused redo moves nothing"
        );
        // The refused redo left no half-written record behind.
        assert!(
            !crate::oplog::list_ops(repo)
                .iter()
                .any(|o| o.verb == crate::oplog::OpVerb::Redo),
            "the redo record was abandoned, not left incomplete"
        );
    }

    #[serial]
    #[test]
    fn redo_refuses_when_the_base_moved_since_the_undo() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "moved");
        let repo = temp.path();
        join("moved", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();

        fs::write(repo.join("later.txt"), "landed after the undo\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::redo_in(repo, None).unwrap_err();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), tip_now);
    }

    #[serial]
    #[test]
    fn redo_refuses_when_a_newer_operation_ran_on_the_dash() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "busy");
        let repo = temp.path();
        join("busy", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();

        // A discard on the restored dash is newer work the redo would trample.
        discard("busy", None, false).unwrap();

        let err = crate::oplog::redo_in(repo, Some("busy")).unwrap_err();
        assert!(err.starts_with("superseded:"), "{err}");
    }

    #[serial]
    #[test]
    fn redo_with_nothing_to_redo_says_so() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "fresh");
        let repo = temp.path();

        let err = crate::oplog::redo_in(repo, None).unwrap_err();
        assert!(err.starts_with("nothing-to-redo:"), "{err}");

        // And once an undo has been redone, there is nothing left to redo.
        join("fresh", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();
        crate::oplog::redo_in(repo, None).unwrap();
        let err = crate::oplog::redo_in(repo, None).unwrap_err();
        assert!(err.starts_with("already-redone:"), "{err}");
    }

    /// The reachability claim redo rests on, made falsifiable: the undo records
    /// itself *before* it acts, so its keepalive parents the join's landed
    /// commit — which is why that commit survives its own undo.
    #[serial]
    #[test]
    fn the_landed_commit_survives_its_undo_through_the_undos_own_keepalive() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "reach");
        let repo = temp.path();
        join("reach", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        crate::oplog::undo_in(repo, None).unwrap();
        assert_ne!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), landed);

        let alive = git_output(repo, &["cat-file", "-e", &format!("{landed}^{{commit}}")])
            .unwrap()
            .status
            .success();
        assert!(
            alive,
            "no branch points at it, but the undo's keepalive does"
        );

        crate::oplog::redo_in(repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            landed,
            "so the redo can put it back"
        );
    }

    #[serial]
    #[test]
    fn undo_with_nothing_recorded_says_so() {
        let (_temp, root) = repo_for_create();
        let err = crate::oplog::undo_in(&root, None).unwrap_err();
        assert!(err.starts_with("nothing-to-undo:"), "{err}");
    }

    #[serial]
    #[test]
    fn a_join_records_an_operation_that_outlives_the_branch_it_deleted() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "recorded");
        let repo = temp.path();
        let dash_tip = git_stdout(repo, &["rev-parse", "tugdash/recorded"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let landed = join("recorded", mechanics()).unwrap();

        let op = crate::oplog::list_ops(repo)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded an operation");
        assert_eq!(op.dash, "recorded");
        assert_eq!(op.before.dash_tip, dash_tip);
        assert_eq!(op.before.base_tip, base_tip);
        assert_eq!(op.before.base_branch, "main");
        assert_eq!(op.before.config.tugbase.as_deref(), Some("main"));
        let after = op.after.clone().expect("a completed join has an after");
        assert_eq!(after.landed_commit, landed.commit_hash);
        assert!(op.is_undoable());

        // The teardown deleted the branch, and the keepalive is now the only
        // thing holding its rounds. This is the property the whole log exists
        // for: without it the rounds are reachable only from a reflog on a
        // clock.
        assert!(
            !branch_exists(repo, "tugdash/recorded"),
            "the join tore the branch down"
        );
        assert!(
            git_output(repo, &["cat-file", "-e", &format!("{dash_tip}^{{commit}}")])
                .unwrap()
                .status
                .success(),
            "the pre-join dash head is still reachable"
        );
    }

    #[serial]
    #[test]
    fn a_join_records_the_dash_tip_including_the_dirt_it_swept() {
        // The join sweeps outstanding worktree changes into a commit before it
        // integrates. A `before` captured any earlier would name the commit
        // below that sweep, and an undo would faithfully restore a dash missing
        // the swept work.
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "sweeper");
        let repo = temp.path();
        let before_sweep = git_stdout(repo, &["rev-parse", "tugdash/sweeper"]).unwrap();
        let worktree = repo.join(".tug/worktrees/sweeper");
        fs::write(worktree.join("late.txt"), "typed after the round\n").unwrap();

        join("sweeper", mechanics()).unwrap();

        let op = crate::oplog::list_ops(repo)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded an operation");
        assert_ne!(
            op.before.dash_tip, before_sweep,
            "the recorded tip is past the round, because the sweep committed"
        );
        let swept = git_stdout(
            repo,
            &["show", "--name-only", "--format=", &op.before.dash_tip],
        )
        .unwrap();
        assert!(
            swept.contains("late.txt"),
            "the recorded tip is the sweep commit itself: {swept}"
        );
    }

    #[serial]
    #[test]
    fn a_discard_records_what_it_handed_back() {
        let (_temp, root) = repo_for_create();
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        create("recorder", None, true, None).unwrap();
        let dash_tip = git_stdout(&root, &["rev-parse", "tugdash/recorder"]).unwrap();

        discard("recorder", None, false).unwrap();

        let op = crate::oplog::list_ops(&root)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Discard)
            .expect("the discard recorded an operation");
        assert_eq!(op.before.dash_tip, dash_tip);
        let after = op.after.expect("a completed discard has an after");
        assert_eq!(
            after.handed_back,
            vec!["scratch.txt".to_string()],
            "the handed-back paths are named, because an undo cannot claw them back"
        );
        assert!(
            git_output(
                &root,
                &["cat-file", "-e", &format!("{dash_tip}^{{commit}}")]
            )
            .unwrap()
            .status
            .success(),
            "the discarded dash's tip survives its branch"
        );
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
                ..mechanics()
            },
        )
        .unwrap();
        // The receipt's body is the message the commit actually carries —
        // `integrate_message`'s composition, trailer and all, not the raw
        // override the caller passed. The two are read off one join rather
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

    /// The precedence a join walks silently, said out loud ([P05], Spec S03).
    #[serial]
    #[test]
    fn the_landing_preview_names_where_its_words_came_from() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "prov");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        // Neither a draft nor a description: the generic stand-in, and the
        // preview says so rather than letting it pass as authored.
        let (message, source) = landing_message_preview(repo, "prov", "tugdash/prov");
        assert_eq!(message, "tugdash(prov): Dash work");
        assert_eq!(source, LandingMessageSource::Fallback);

        git_output(
            repo,
            &[
                "config",
                "branch.tugdash/prov.description",
                "Teach the imposer to breathe",
            ],
        )
        .unwrap();
        let (message, source) = landing_message_preview(repo, "prov", "tugdash/prov");
        assert_eq!(message, "tugdash(prov): Teach the imposer to breathe");
        assert_eq!(source, LandingMessageSource::Description);

        // An authored draft outranks the description, and wears this dash's
        // scope exactly once even though the draft carried a foreign one.
        seed_draft_row(
            &db,
            &dash_draft_key(repo, "prov").owner_id,
            &canonical(repo),
            "tugdash(elsewhere): The words the author chose",
        );
        let (message, source) = landing_message_preview(repo, "prov", "tugdash/prov");
        assert_eq!(message, "tugdash(prov): The words the author chose");
        assert_eq!(source, LandingMessageSource::Draft);

        // And the preview is what the join would land, minus the trailers the
        // landing composes against its round set.
        let landed = integrate_message(repo, "prov", "tugdash/prov", None, None);
        assert!(landed.starts_with(&message), "{landed}");
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

    /// The read side keys on the **gateway** spelling ([L29]) — the same form
    /// the writer stores — so a base root handed in under any other spelling
    /// still finds its dash's authored draft. This is the lands-as lie's path
    /// half: a prompt composed against a spelling that missed the row
    /// announced "no draft was written" while the join landed with one.
    ///
    /// The firmlink divergence that made the two disagree in the field
    /// (`/Users/…` vs the `realpath(3)` form `/System/Volumes/Data/Users/…`)
    /// cannot be constructed in-process — it needs `synthetic.conf` or an APFS
    /// firmlink, both machine state. The gateway's own firmlink behavior is
    /// pinned in `tugcore::pathform`; what this pins is that the lookup routes
    /// through it, so the two sides cannot drift apart again.
    #[serial]
    #[test]
    fn a_gateway_keyed_row_is_found_from_another_spelling_of_the_root() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "spelled");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        // Keyed exactly as `apply_draft_request` keys it.
        let gateway = tugcore::pathform::resolve_to_claude_form(repo);
        seed_draft_row(
            &db,
            &dash_owner_key(repo, "spelled"),
            &gateway,
            "the words the author chose",
        );

        // The canonical spelling the read probes IS the gateway's form.
        assert_eq!(
            project_spellings(repo).first().map(String::as_str),
            Some(gateway.to_string_lossy().as_ref())
        );

        // A second spelling of the same root — here a symlink — reads the row.
        let elsewhere = TempDir::new().unwrap();
        let link = elsewhere.path().join("root-by-another-name");
        std::os::unix::fs::symlink(repo, &link).unwrap();
        assert_eq!(
            dash_draft_message(&link, "tugdash/spelled").as_deref(),
            Some("the words the author chose")
        );
    }

    /// A body may already open with this dash's scope — a draft authored in the
    /// conventional voice is the common case, and the doubled subject on the
    /// first real join is what the un-idempotent wrap looked like in the
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
            None,
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
            None,
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
        let out = integrate_message(repo, "inner", "tugdash/inner", Some(body.to_string()), None);
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
                None,
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
            None,
        );
        assert!(out.starts_with("tugdash(plain): a plain subject"), "{out}");

        // No override, no draft row (the ledger is an empty tempdir path), and
        // no branch description — the bare fallback, still wrapped once.
        let fallback = integrate_message(repo, "plain", "tugdash/plain", None, None);
        assert!(
            fallback.starts_with("tugdash(plain): Dash work"),
            "{fallback}"
        );
    }

    /// The contract the whole draft feature exists to honor, at the layer that
    /// lands it: when a maintained draft exists and no override is given, the
    /// squash commit's message is the authored draft, prefixed once, plus
    /// exactly the trailers — nothing added, reordered, or regenerated. The
    /// first real dash join is what this looks like broken, and a string
    /// equality is what makes any future writer or reader drift fail loudly
    /// instead of committing someone else's words.
    #[serial]
    #[test]
    fn the_join_commits_the_authored_draft_byte_for_byte() {
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

        let landed = join("pinned", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        let expected = with_dash_trailers(
            repo,
            "pinned",
            "tugdash/pinned",
            &format!("tugdash(pinned): {draft}"),
            None,
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

        let landed = join("once", mechanics()).unwrap();
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
    /// so a dash mid-teardown previews with a blocker instead of erroring.
    #[serial]
    #[test]
    fn preview_reports_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "journalled");
        let repo = temp.path();

        // The record's state dir is slugged from the repo's *canonical* path,
        // which on macOS is `/private/var/…` where a TempDir reads `/var/…`.
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(
            repo,
            "journalled",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );

        let out = preview("journalled");
        let b = blocker(&out, "stale-journal").expect("stale-journal blocker");
        assert!(b.detail.contains("--continue"), "{}", b.detail);
        assert!(
            !b.detail.contains("tugdash join"),
            "the detail must name the real verb: {}",
            b.detail
        );
    }

    /// A join in flight opens the record itself, so an open record alone cannot
    /// mean "a previous join is incomplete" — for the whole squash-to-record
    /// window it means the opposite. The holder is what tells the two apart,
    /// and the blocked sentence is false in every clause while a join runs.
    #[serial]
    #[test]
    fn a_live_join_is_not_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "inflight");
        let repo = temp.path();

        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(repo, "inflight", crate::oplog::JoinPhase::Integrated, &head);

        let detail = dash_detail_entry_in(repo, "inflight").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        let unheld = join_blockers_from_detail(repo, &detail, &current, None, &BTreeMap::new());
        assert!(
            unheld.iter().any(|b| b.kind == "stale-journal"),
            "a teardown nobody holds is stale and must refuse: {:?}",
            unheld.iter().map(|b| &b.kind).collect::<Vec<_>>()
        );

        let held =
            join_blockers_from_detail(repo, &detail, &current, Some("join"), &BTreeMap::new());
        assert!(
            !held.iter().any(|b| b.kind == "stale-journal"),
            "a join holding the dash opened that record: {:?}",
            held.iter().map(|b| &b.kind).collect::<Vec<_>>()
        );

        // A *resolve* holder does not excuse it: it would be running over a
        // crashed join's leavings, and the refusal is still right.
        let resolving =
            join_blockers_from_detail(repo, &detail, &current, Some("resolve"), &BTreeMap::new());
        assert!(
            resolving.iter().any(|b| b.kind == "stale-journal"),
            "{:?}",
            resolving.iter().map(|b| &b.kind).collect::<Vec<_>>()
        );
        assert_eq!(
            held.iter().map(|b| &b.kind).collect::<Vec<_>>(),
            unheld
                .iter()
                .filter(|b| b.kind != "stale-journal")
                .map(|b| &b.kind)
                .collect::<Vec<_>>(),
            "only the stale-journal blocker moves; every other refusal still stands"
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
        create("hollow", None, false, None).unwrap();

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
            let err = join("agree", mechanics()).unwrap_err();
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
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let seq = seed_interrupted_join(repo, "agree", crate::oplog::JoinPhase::Integrated, &head);
        assert_agrees("stale-journal");
        crate::oplog::abandon(&root, seq);

        // empty — a dash of its own, since the one above has a round.
        create("agree2", None, false, None).unwrap();
        let out = preview("agree2");
        let b = blocker(&out, "empty").expect("empty blocker");
        let err = join("agree2", mechanics()).unwrap_err();
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

        create("test-dash", Some("Test".to_string()), false, None).unwrap();
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["checkout", "-b", "feature"])
            .output()
            .unwrap();

        let result = join("test-dash", mechanics());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("on branch 'feature'"));
        assert!(err.contains("Check out 'main' first"));
        assert_eq!(current_branch(repo), "feature");
    }

    #[serial]
    #[test]
    fn test_dash_discard_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-dash", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        let result = discard("test-dash", None, false);
        assert!(result.is_ok());

        assert!(!worktree.exists());
        assert!(!branch_present(repo, "tugdash/test-dash"));

        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("discarded"),
            "dash-log should record discard: {dlog}"
        );
    }

    #[serial]
    #[test]
    fn test_dash_discard_nonexistent_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let result = discard("nonexistent", None, false);
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

        create("test-dash", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-dash");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();
        commit("test-dash", "Add test", None).unwrap();
        join("test-dash", mechanics()).unwrap();

        // Joining again fails: the branch no longer exists.
        let result = join("test-dash", mechanics());
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
        create(name, None, false, None).unwrap();
        let worktree = repo.join(format!(".tug/worktrees/{name}"));
        fs::write(worktree.join("f.txt"), "dash\n").unwrap();
        commit(name, &format!("{name}-only"), None).unwrap();
        (temp, repo)
    }

    // --- the join's plan sweep ---------------------------------------------

    #[serial]
    #[test]
    fn test_join_merge_strategy_makes_a_merge_commit() {
        let (_temp, repo) = repo_with_committed_dash("mrg");
        let out = join(
            "mrg",
            JoinOptions {
                strategy: JoinStrategy::Merge,
                ..mechanics()
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

    /// A join riding a candidate lands **one** commit, carrying the composed
    /// message — even when the candidate is a chain of rounds.
    ///
    /// The candidate is the resolved *bytes*; the strategy is the shape. Landing
    /// it with `merge --ff-only` conflated the two, so the ladder's internal
    /// shape decided what the base's history looked like: a multi-round dash
    /// arrived on the base as N round commits with the authored draft dropped on
    /// the floor, because a fast-forward has no commit to put a message in. The
    /// candidate here is deliberately the dash branch tip — the exact shape rung
    /// 1 hands back — so this fails on the old code no matter what the ladder
    /// decides.
    #[serial]
    #[test]
    fn test_join_squashes_a_multi_commit_candidate_into_one_commit() {
        let (_temp, repo) = repo_with_committed_dash("cand");
        let worktree = repo.join(".tug/worktrees/cand");
        fs::write(worktree.join("g.txt"), "second\n").unwrap();
        commit("cand", "cand-round-2", None).unwrap();

        let before = git_stdout(&repo, &["rev-parse", "HEAD"]).unwrap();
        let candidate = git_stdout(&repo, &["rev-parse", "tugdash/cand"]).unwrap();
        let rounds = git_stdout(&repo, &["rev-list", "--count", "main..tugdash/cand"]).unwrap();
        assert_eq!(rounds, "2", "the candidate really is a chain");

        let out = join(
            "cand",
            JoinOptions {
                strategy: JoinStrategy::Squash,
                candidate: Some(candidate),
                message: Some("the authored subject".to_string()),
                ..mechanics()
            },
        )
        .unwrap();
        assert!(out.commit_hash.is_some());

        let landed =
            git_stdout(&repo, &["rev-list", "--count", &format!("{before}..HEAD")]).unwrap();
        assert_eq!(landed, "1", "one commit on the base, never the chain");

        let subject = git_stdout(&repo, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, "tugdash(cand): the authored subject");

        // Both rounds' bytes are present — squashing the shape never drops work.
        for (rel, want) in [("f.txt", "dash"), ("g.txt", "second")] {
            let blob = git_stdout(&repo, &["show", &format!("HEAD:{rel}")]).unwrap();
            assert_eq!(blob, want, "{rel} landed");
        }
    }

    /// The one strategy that asks for the candidate's own history keeps it —
    /// `rebase` is an explicit opt-in to a linear land, and the fix above must
    /// not quietly take it away.
    #[serial]
    #[test]
    fn test_join_rebase_keeps_a_candidates_own_commits() {
        let (_temp, repo) = repo_with_committed_dash("candrb");
        let worktree = repo.join(".tug/worktrees/candrb");
        fs::write(worktree.join("g.txt"), "second\n").unwrap();
        commit("candrb", "candrb-round-2", None).unwrap();

        let before = git_stdout(&repo, &["rev-parse", "HEAD"]).unwrap();
        let candidate = git_stdout(&repo, &["rev-parse", "tugdash/candrb"]).unwrap();
        join(
            "candrb",
            JoinOptions {
                strategy: JoinStrategy::Rebase,
                candidate: Some(candidate),
                ..mechanics()
            },
        )
        .unwrap();

        let landed =
            git_stdout(&repo, &["rev-list", "--count", &format!("{before}..HEAD")]).unwrap();
        assert_eq!(landed, "2", "the rounds stand");
        let subject = git_stdout(&repo, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, "candrb-round-2", "and keep their own messages");
    }

    #[serial]
    #[test]
    fn test_join_rebase_strategy_is_linear() {
        let (_temp, repo) = repo_with_committed_dash("rb");
        join(
            "rb",
            JoinOptions {
                strategy: JoinStrategy::Rebase,
                ..mechanics()
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

        create("pv", None, false, None).unwrap();
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
                ..mechanics()
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
        // Simulate a crash right after the integrate commit: an open join
        // record at phase `Integrated` with the worktree + branch still
        // present. `--continue` must finish the teardown (remove worktree,
        // delete branch, dash-log).
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("resume", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/resume");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("resume", "add f", None).unwrap();

        // Do the integrate by hand, then record it as if we crashed next.
        git_output(repo, &["merge", "--squash", "tugdash/resume"]).unwrap();
        git_output(repo, &["commit", "-m", "tugdash(resume): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        // `join` resolves the repo via `find_repo_root` (canonical), so the
        // record must be written to the canonical state dir to be found.
        let canon = fs::canonicalize(repo).unwrap();
        let seq = seed_interrupted_join(repo, "resume", crate::oplog::JoinPhase::Integrated, &head);
        assert!(worktree.exists());
        assert!(branch_present(repo, "tugdash/resume"));

        // A plain join now refuses (a join is in flight); --continue resumes.
        assert!(join("resume", mechanics()).is_err());
        let out = join(
            "resume",
            JoinOptions {
                continue_join: true,
                ..mechanics()
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
            crate::oplog::join_in_flight(&canon, "resume").is_none(),
            "the record is complete, so nothing is in flight"
        );
        let op = crate::oplog::read_op(&canon, seq).expect("the record is still there");
        assert!(
            op.after.is_some(),
            "and it completed rather than being dropped"
        );
        assert_eq!(
            op.join.unwrap().phase,
            crate::oplog::JoinPhase::BranchDeleted,
            "the finished record still says how far the teardown got"
        );
        let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"), "dash-log records the join: {dlog}");
    }

    /// The resumability guarantee, one phase at a time: entering the teardown
    /// at any of its three states finishes the join and finishes it once.
    #[serial]
    #[test]
    fn continue_resumes_from_each_phase() {
        for phase in [
            crate::oplog::JoinPhase::Integrated,
            crate::oplog::JoinPhase::WorktreeRemoved,
            crate::oplog::JoinPhase::BranchDeleted,
        ] {
            let temp = TempDir::new().unwrap();
            let repo = temp.path();
            let home = temp.path().join("state");
            init_git_repo(repo);
            redirect_state_dir(&home);
            std::env::set_current_dir(repo).unwrap();

            create("phased", None, false, None).unwrap();
            let worktree = repo.join(".tug/worktrees/phased");
            fs::write(worktree.join("f.txt"), "x\n").unwrap();
            commit("phased", "add f", None).unwrap();

            // The integrate by hand, then the git state each phase implies —
            // the record says what has already happened, so the tree must
            // agree with it or the test would be resuming a fiction.
            git_output(repo, &["merge", "--squash", "tugdash/phased"]).unwrap();
            git_output(repo, &["commit", "-m", "tugdash(phased): add f"]).unwrap();
            let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
            let seq = seed_interrupted_join(repo, "phased", phase, &head);
            let canon = fs::canonicalize(repo).unwrap();
            if phase != crate::oplog::JoinPhase::Integrated {
                let mut warnings = Vec::new();
                remove_dash_worktree(repo, "tugdash/phased", &worktree, &mut warnings);
            }
            if phase == crate::oplog::JoinPhase::BranchDeleted {
                git_output(repo, &["branch", "-D", "tugdash/phased"]).unwrap();
            }

            let out = join(
                "phased",
                JoinOptions {
                    continue_join: true,
                    ..mechanics()
                },
            )
            .unwrap_or_else(|e| panic!("{phase:?}: {e}"));

            assert_eq!(out.commit_hash.as_deref(), Some(head.as_str()), "{phase:?}");
            assert_eq!(
                out.base_branch, "main",
                "{phase:?}: from the record's before"
            );
            assert!(!worktree.exists(), "{phase:?}: worktree removed");
            assert!(
                !branch_present(repo, "tugdash/phased"),
                "{phase:?}: branch gone"
            );
            let dlog = fs::read_to_string(dash_log_path(&home, repo)).unwrap();
            assert!(dlog.contains("joined"), "{phase:?}: dash-log records it");
            let op = crate::oplog::read_op(&canon, seq).expect("the record");
            assert_eq!(
                op.after.unwrap().landed_commit.as_deref(),
                Some(head.as_str())
            );
            assert_eq!(
                op.join.unwrap().phase,
                crate::oplog::JoinPhase::BranchDeleted,
                "{phase:?}: and it ended at the last phase"
            );
        }
    }

    /// Once a join is finished there is nothing in flight, so the second press
    /// is refused by name rather than re-running a teardown over a dash that no
    /// longer exists.
    #[serial]
    #[test]
    fn continue_twice_is_a_named_refusal() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "twice");

        join("twice", mechanics()).unwrap();
        let err = join(
            "twice",
            JoinOptions {
                continue_join: true,
                ..mechanics()
            },
        )
        .unwrap_err();
        assert_eq!(err, "No interrupted join to continue for dash 'twice'.");
    }

    /// The record the journal never was: after a clean join, how the teardown
    /// went is still readable beside what it landed.
    #[serial]
    #[test]
    fn a_finished_join_keeps_its_progress_on_the_record() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "receipt");
        let repo = temp.path();
        let canon = fs::canonicalize(repo).unwrap();

        let out = join("receipt", mechanics()).unwrap();
        let op = crate::oplog::list_ops(&canon)
            .into_iter()
            .find(|op| op.dash == "receipt" && op.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded itself");
        assert!(op.after.is_some(), "and completed");
        let progress = op.join.expect("with its progress still on it");
        assert_eq!(progress.phase, crate::oplog::JoinPhase::BranchDeleted);
        assert_eq!(Some(progress.commit_hash), out.commit_hash);
        assert_eq!(progress.strategy, "squash");
        assert!(
            crate::oplog::join_in_flight(&canon, "receipt").is_none(),
            "a completed record is not a teardown to resume"
        );
    }

    /// Undo's refusal is a property of the payload, and the fold leaves it
    /// exactly where it was: an operation mid-teardown has no `after`, so it is
    /// refused by name until `--continue` gives it one.
    #[serial]
    #[test]
    fn undo_refuses_a_join_mid_teardown_then_reverses_it_once_continued() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("halfway", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/halfway");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("halfway", "add f", None).unwrap();

        git_output(repo, &["merge", "--squash", "tugdash/halfway"]).unwrap();
        git_output(repo, &["commit", "-m", "tugdash(halfway): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(repo, "halfway", crate::oplog::JoinPhase::Integrated, &head);
        let canon = fs::canonicalize(repo).unwrap();

        let err = crate::oplog::undo_in(&canon, Some("halfway")).unwrap_err();
        assert!(err.starts_with("incomplete-op:"), "got {err}");

        join(
            "halfway",
            JoinOptions {
                continue_join: true,
                ..mechanics()
            },
        )
        .unwrap();
        let undone = crate::oplog::undo_in(&canon, Some("halfway")).expect("now it reverses");
        assert_eq!(undone.verb, crate::oplog::OpVerb::Join);
        assert!(branch_present(repo, "tugdash/halfway"), "the dash is back");
    }

    /// Every blocker kind, asserted identical between the composed path the
    /// card uses and the preflight the CLI uses — the anti-drift pin. Two
    /// definitions of "what refuses a join" is how the card and the terminal
    /// came to disagree in the first place.
    #[serial]
    #[test]
    fn composed_blockers_match_the_preflight_for_every_kind() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "kinds");
        let repo = temp.path();

        let composed = || {
            let detail = dash_detail_entry_in(repo, "kinds").expect("detail");
            let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
            join_blockers_from_detail(repo, &detail, &current, None, &BTreeMap::new())
        };
        let same = |label: &str| {
            let a = composed();
            let b = join_preflight_in(repo, "kinds").unwrap();
            assert_eq!(
                a.iter().map(|x| &x.kind).collect::<Vec<_>>(),
                b.iter().map(|x| &x.kind).collect::<Vec<_>>(),
                "{label}: kinds agree"
            );
            assert_eq!(
                a.iter().map(|x| &x.detail).collect::<Vec<_>>(),
                b.iter().map(|x| &x.detail).collect::<Vec<_>>(),
                "{label}: sentences agree byte for byte"
            );
            assert_eq!(
                a.iter().map(|x| &x.paths).collect::<Vec<_>>(),
                b.iter().map(|x| &x.paths).collect::<Vec<_>>(),
                "{label}: paths agree"
            );
            a
        };

        assert!(same("clean").is_empty());

        // base-dirt, tracked.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        assert!(same("tracked dirt").iter().any(|b| b.kind == "base-dirt"));
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();

        // base-dirt, untracked: the dash must also change that path, so it is
        // the untracked *overwrite* case rather than unrelated base dirt.
        let worktree = repo.join(".tug/worktrees/kinds");
        fs::write(worktree.join("fresh.txt"), "from the dash\n").unwrap();
        commit("kinds", "add fresh", None).unwrap();
        fs::write(repo.join("fresh.txt"), "untracked on base\n").unwrap();
        assert!(
            same("untracked overlap")
                .iter()
                .any(|b| b.kind == "base-dirt")
        );
        fs::remove_file(repo.join("fresh.txt")).unwrap();

        // off-base.
        git_output(repo, &["checkout", "-b", "scratch"]).unwrap();
        assert!(same("off base").iter().any(|b| b.kind == "off-base"));
        git_output(repo, &["checkout", "main"]).unwrap();

        // stale-journal.
        let seq = seed_interrupted_join(
            repo,
            "kinds",
            crate::oplog::JoinPhase::Integrated,
            "deadbeef",
        );
        assert!(
            same("stale journal")
                .iter()
                .any(|b| b.kind == "stale-journal")
        );
        crate::oplog::abandon(&fs::canonicalize(repo).unwrap(), seq);

        // empty: a dash with no rounds and no tracked worktree dirt.
        create("hollow", None, false, None).unwrap();
        let hollow_detail = dash_detail_entry_in(repo, "hollow").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(
            join_blockers_from_detail(repo, &hollow_detail, &current, None, &BTreeMap::new())
                .iter()
                .map(|b| &b.kind)
                .collect::<Vec<_>>(),
            join_preflight_in(repo, "hollow")
                .unwrap()
                .iter()
                .map(|b| &b.kind)
                .collect::<Vec<_>>(),
        );
        assert!(
            join_preflight_in(repo, "hollow")
                .unwrap()
                .iter()
                .any(|b| b.kind == "empty")
        );
    }

    /// Blockers answer to working-tree state, which moves without either head
    /// moving. This is the exact defect a `(base_sha, dash_head_sha)` cache
    /// would hide: both SHAs are unchanged across the whole test, and the right
    /// answer changes twice.
    #[serial]
    #[test]
    fn blockers_track_dirt_that_moves_no_sha() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "nosha");
        let repo = temp.path();

        let heads = || {
            (
                git_stdout(repo, &["rev-parse", "main"]).unwrap(),
                git_stdout(repo, &["rev-parse", "tugdash/nosha"]).unwrap(),
            )
        };
        let before = heads();
        assert!(join_preflight_in(repo, "nosha").unwrap().is_empty());

        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let dirty = join_preflight_in(repo, "nosha").unwrap();
        assert!(
            dirty.iter().any(|b| b.kind == "base-dirt"),
            "dirt on an overlapping path blocks"
        );
        assert_eq!(before, heads(), "no SHA moved");

        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        assert!(
            join_preflight_in(repo, "nosha").unwrap().is_empty(),
            "cleaning the checkout clears the blocker"
        );
        assert_eq!(before, heads(), "still no SHA moved");
    }

    /// The overlap says **what** the base's uncommitted bytes are, not only
    /// that they are there. A base copy holding exactly what the dash carries
    /// is `identical`, and everything downstream turns on that being read from
    /// the objects rather than assumed from the fact of the dirt.
    #[serial]
    #[test]
    fn an_overlap_says_whether_the_base_copy_is_the_dashs_own_bytes() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "relation");
        let repo = temp.path();

        // The base's copy IS the dash's version, to the byte — the shape a
        // note written on main from the dash's own work leaves behind.
        fs::write(repo.join("shared.txt"), "base\ndash change\n").unwrap();
        let detail = dash_detail_entry_in(repo, "relation").expect("detail");
        assert_eq!(overlap_paths(&detail.base_overlap), vec!["shared.txt"]);
        assert_eq!(
            detail.base_overlap[0].relation, OVERLAP_IDENTICAL,
            "the same bytes the dash carries"
        );

        // A byte apart is other work, and the reading says so.
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let detail = dash_detail_entry_in(repo, "relation").expect("detail");
        assert_eq!(detail.base_overlap[0].relation, OVERLAP_DIVERGENT);

        // And it rides the blocker, which is where every surface reads it.
        let blockers = join_preflight_in(repo, "relation").unwrap();
        let dirt = blockers
            .iter()
            .find(|b| b.kind == "base-dirt")
            .expect("base-dirt");
        assert_eq!(dirt.overlap[0].path, "shared.txt");
        assert_eq!(dirt.overlap[0].relation, OVERLAP_DIVERGENT);
    }

    /// A base copy the dash already carries is not a refusal — it is the
    /// dash's own edit sitting on the base, and the join drops it and lands
    /// the same bytes. The blocker never appears, the join runs, and what was
    /// dropped is reported rather than done quietly.
    #[serial]
    #[test]
    fn an_identical_base_copy_does_not_block_the_join() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "echo");
        let repo = temp.path();

        // Main holds, uncommitted, exactly what the dash committed.
        fs::write(repo.join("shared.txt"), "base\ndash change\n").unwrap();
        assert!(
            join_preflight_in(repo, "echo")
                .unwrap()
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the dash's own bytes on the base refuse nothing"
        );

        let outcome = join("echo", mechanics()).expect("the join runs over its own echo");
        assert!(outcome.commit_hash.is_some(), "it landed");
        assert!(
            outcome.warnings.iter().any(|w| w.contains("shared.txt")),
            "the drop is reported: {:?}",
            outcome.warnings
        );
        // The bytes are on the base, and the checkout is clean.
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\ndash change\n"
        );
        assert!(
            dirty_tracked_paths(repo).is_empty(),
            "nothing left uncommitted"
        );
    }

    /// The other half of the same rule: a base copy that is somebody's *work*
    /// still refuses, and refuses having touched nothing.
    #[serial]
    #[test]
    fn a_divergent_base_copy_still_blocks_and_moves_nothing() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "otherwork");
        let repo = temp.path();

        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let err = join("otherwork", mechanics()).unwrap_err();
        assert!(err.contains("shared.txt"), "{err}");
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nsomebody else\n",
            "a refusal touches nothing"
        );
    }

    /// A divergent overlap another live session holds is not the user's to
    /// move, and the refusal says whose turn it is instead of offering an act
    /// that would take a half-written edit out from under somebody.
    #[serial]
    #[test]
    fn a_foreign_hand_on_the_overlap_names_its_holder() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "contended");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();

        let detail = dash_detail_entry_in(repo, "contended").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        // With no attribution view — a person at a terminal — it reads as the
        // user's own, which is the right default for their own checkout.
        let mine = join_blockers_from_detail(repo, &detail, &current, None, &BTreeMap::new());
        let dirt = mine.iter().find(|b| b.kind == "base-dirt").expect("dirt");
        assert!(dirt.detail.contains("your uncommitted edit"), "{dirt:?}");
        assert!(dirt.overlap[0].holder.is_none());

        // With one, the sentence names the hand that is on it.
        let held = BTreeMap::from([("shared.txt".to_string(), "^ink-anchor".to_string())]);
        let theirs = join_blockers_from_detail(repo, &detail, &current, None, &held);
        let dirt = theirs.iter().find(|b| b.kind == "base-dirt").expect("dirt");
        assert!(dirt.detail.contains("^ink-anchor holds"), "{dirt:?}");
        assert_eq!(dirt.overlap[0].holder.as_deref(), Some("^ink-anchor"));

        // And an identical copy is still nobody's problem, held or not.
        fs::write(repo.join("shared.txt"), "base\ndash change\n").unwrap();
        let detail = dash_detail_entry_in(repo, "contended").expect("detail");
        assert!(
            join_blockers_from_detail(repo, &detail, &current, None, &held)
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the dash's own bytes refuse nothing, whoever last wrote them"
        );
    }

    /// The fold: a divergent base edit of the user's own becomes one commit on
    /// the base, and the join is no longer blocked. From that commit forward
    /// the two sides are ordinary history, which is what puts a collision in
    /// front of the resolution ladder instead of in front of the user.
    #[serial]
    #[test]
    fn resolve_base_folds_the_users_own_edit_onto_the_base() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "fold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nmy own edit\n").unwrap();

        assert!(
            join_preflight_in(repo, "fold")
                .unwrap()
                .iter()
                .any(|b| b.kind == "base-dirt"),
            "blocked to begin with"
        );

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let outcome = resolve_base_in(repo, "fold", &BTreeMap::new()).expect("resolves");
        assert_eq!(outcome.folded, vec!["shared.txt"]);
        assert!(outcome.committed.is_some(), "it made a commit of its own");
        assert!(outcome.dropped.is_empty());

        // The block is gone and the checkout is clean.
        assert!(
            join_preflight_in(repo, "fold")
                .unwrap()
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the base no longer refuses"
        );
        assert!(dirty_tracked_paths(repo).is_empty());
        // And the edit is still theirs, on the base, byte for byte.
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nmy own edit\n"
        );
        assert_ne!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            before_tip
        );

        // Undo puts it back the way they had it: same content, uncommitted.
        crate::oplog::undo_in(repo, Some("fold")).expect("undo");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            before_tip
        );
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nmy own edit\n",
            "undo restores the work, it does not destroy it"
        );
        assert_eq!(dirty_tracked_paths(repo), vec!["shared.txt"]);
    }

    /// A resolve never moves another session's work, and refuses having
    /// touched nothing.
    #[serial]
    #[test]
    fn resolve_base_refuses_another_sessions_edit() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "notmine");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let held = BTreeMap::from([("shared.txt".to_string(), "^ink-anchor".to_string())]);

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let err = resolve_base_in(repo, "notmine", &held).unwrap_err();
        assert!(err.contains("^ink-anchor holds"), "{err}");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            before_tip
        );
        assert_eq!(dirty_tracked_paths(repo), vec!["shared.txt"]);
    }

    /// An overlap that is all the dash's own bytes needs no commit — dropping
    /// is the whole of the job, and the outcome says so rather than inventing
    /// a commit to report.
    #[serial]
    #[test]
    fn resolve_base_drops_an_echo_without_committing() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "echofold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\ndash change\n").unwrap();

        let outcome = resolve_base_in(repo, "echofold", &BTreeMap::new()).expect("resolves");
        assert_eq!(outcome.dropped, vec!["shared.txt"]);
        assert!(outcome.folded.is_empty());
        assert!(outcome.committed.is_none(), "nothing to commit");
        assert!(dirty_tracked_paths(repo).is_empty());
    }

    /// The dash's uncommitted work counts toward the overlap, because the
    /// join's preamble commits it before joining. The detail walk's warning and
    /// the preflight's refusal are the same set.
    #[serial]
    #[test]
    fn worktree_dirt_counts_toward_the_overlap_the_join_will_hit() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "wtdirt");
        let repo = temp.path();

        // A path the dash has NOT committed, only dirtied in its worktree.
        let worktree = repo.join(".tug/worktrees/wtdirt");
        fs::write(worktree.join("other.txt"), "dash uncommitted\n").unwrap();
        git_output(&worktree, &["add", "other.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base uncommitted\n").unwrap();
        git_output(repo, &["add", "other.txt"]).unwrap();

        let detail = dash_detail_entry_in(repo, "wtdirt").expect("detail");
        assert!(
            overlap_paths(&detail.base_overlap).contains(&"other.txt".to_string()),
            "the detail's warning sees it: {:?}",
            detail.base_overlap
        );
        let blockers = join_preflight_in(repo, "wtdirt").unwrap();
        assert!(
            blockers
                .iter()
                .any(|b| b.kind == "base-dirt" && b.paths.contains(&"other.txt".to_string())),
            "and the preflight refuses on it: {blockers:?}"
        );
    }

    #[serial]
    #[test]
    fn join_conflicts_in_reports_what_the_preview_reports() {
        let temp = TempDir::new().unwrap();
        seed_dash_with_a_round(&temp, "probe");
        let repo = temp.path();

        // Make the base conflict with the dash on the same path.
        fs::write(repo.join("shared.txt"), "base\nbase change\n").unwrap();
        git_output(repo, &["commit", "-am", "base moves shared"]).unwrap();

        let probe = join_conflicts_in(repo, "probe").unwrap();
        let previewed = preview("probe");
        assert_eq!(probe.conflicts, previewed.conflicts);
        assert_eq!(
            probe.archaeology.len(),
            previewed.archaeology.len(),
            "the same archaeology rides both paths"
        );
        assert!(!probe.conflicts.is_empty(), "the fixture really conflicts");
        assert_eq!(
            probe.base_sha,
            git_stdout(repo, &["rev-parse", "main"]).unwrap()
        );
        assert_eq!(
            probe.dash_sha,
            git_stdout(repo, &["rev-parse", "tugdash/probe"]).unwrap()
        );
    }
}
