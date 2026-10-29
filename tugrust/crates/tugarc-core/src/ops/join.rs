//! Landing an arc on its base: the preflight and its blockers, the integrate and
//! its teardown, the progress beats, the landing message, and `resolve-base`.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tugcore::instance::Paths;

use super::{
    ArcDetail, BRANCH_PREFIX, arc_base, arc_detail_entry_in, arc_owner_key, arc_tips,
    branch_exists, branch_name, commit_worktree_dirt, config_get, current_branch,
    dirty_tracked_paths, documents_dir, fit_fact, git_output, git_paths_or_empty, git_stdout,
    git_write, git_write_on_the_merits, listing_error, main_repo_root, reconcile_branches,
    remove_arc_worktree, retry_past_index_lock, untracked_paths, with_arc_trailers, worktree_path,
};
use crate::error::ArcError;
use crate::log::{FitFact, append_arc_log, read_declarations};

/// How [`join_in`] integrates an arc into its base branch ([P14]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JoinStrategy {
    /// One squash commit on the base (default — preserves today's behaviour).
    #[default]
    Squash,
    /// A `--no-ff` merge commit, preserving the arc's individual rounds.
    Merge,
    /// Replay the arc's commits onto the base (fast-forward when possible,
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

/// Options for [`join_in`] ([P14]).
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
    /// Which route asked for this join — `cli` or `card`. Recorded in the
    /// arc log's terminal note so a join is attributable after the fact;
    /// `None` writes the bare note the log carried before routes were recorded.
    pub origin: Option<String>,
    /// The session that asked for this join, when the caller knows it — the
    /// pressing card's tug session id, which the CONTROL request already
    /// carries for its receipt ([P06]).
    ///
    /// It is here because the join is executed by **tugcast**, not by the
    /// session: the server exports no `TUG_SESSION_ID`, so without this the
    /// squash commit can name the arc and nothing else, and the History row
    /// shows one pill for work that had a session behind it. `None` writes no
    /// session trailers; the CLI fills it from its own `TUG_SESSION_ID`.
    pub session_id: Option<String>,
    /// The directory the caller is standing in, when it stands anywhere: the
    /// CLI passes its own cwd so a join run from inside the arc worktree is
    /// refused. `None` skips that check — tugcast's process cwd is the
    /// server's and says nothing about the card that asked.
    pub caller_cwd: Option<std::path::PathBuf>,
}

/// Outcome of [`join_in`].
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
    /// captured before teardown, because the branch and the arc log line it
    /// derives from are both gone by the time the outcome is read. Additive:
    /// absent from the JSON when the arc carried no fit fact.
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
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConflictHistory {
    /// The conflicted path, as `conflicts` spells it.
    pub path: String,
    /// The most recent base commits that touched it, newest first, capped.
    pub commits: Vec<ConflictCommit>,
    /// How many touched it in total — `commits.len()` unless the cap bit.
    pub total: u32,
}

/// One base commit behind a conflicted path.
#[derive(Debug, Clone, PartialEq, Serialize)]
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
/// word. And a remedy is always pressable ([L31]): a problem stated beside a
/// control that refuses to work is the worst shape a report can take, so a
/// blocker either carries an act or carries no remedy at all — the kinds
/// nothing at this card can clear, an off-base checkout, a teardown left by a
/// crash, which still say what they are.
///
/// It also does not restate `detail`. The two run one line apart under a
/// register already fronting the detail, so a remedy that named the paths
/// again said the same thing three times over.
#[derive(Debug, Clone, Serialize)]
pub struct JoinRemedy {
    /// What Resolve will do, as one sentence.
    pub explain: String,
}

/// Whether a join of `name` is between its integrate and its end — the bool
/// face of [`crate::oplog::join_in_flight`], for callers that only need to know
/// whether to stand down.
///
/// `main_repo_root` is a filesystem walk, so a caller holding a worktree path
/// reads the right state directory without paying for a git process.
pub fn join_in_flight(paths: &Paths, repo: &Path, name: &str) -> bool {
    crate::oplog::join_in_flight(paths, &main_repo_root(repo), name).is_some()
}

/// Whether `git` here supports `git merge-tree --write-tree` (git ≥ 2.38).
///
/// Asked through `tugcore::host_tools`, never by running `git --version` here
/// — see `resolve::git_supports_merge_base_flag`.
pub(crate) fn git_supports_merge_tree() -> bool {
    tugcore::host_tools::git_version_at_least(2, 38)
}

/// The conflicted (unmerged) paths after a failed merge/cherry-pick.
fn conflicted_paths(repo: &Path) -> Vec<String> {
    git_paths_or_empty(repo, &["diff", "--name-only", "--diff-filter=U"])
}

/// In-memory conflict preview via `git merge-tree --write-tree` (git ≥ 2.38):
/// returns the conflicted paths without touching any worktree, index, or ref.
/// How many base commits a conflicted path shows before the face elides.
const ARCHAEOLOGY_CAP: usize = 5;

/// What the base did to each conflicted path since the two sides parted.
///
/// A conflict names a file and stops; the question it raises is what the base
/// did to that file while the arc was away, and that answer is one `git log`
/// per path. Capped, and computed only on the preview path, so the cost is
/// bounded by the number of conflicts rather than by the size of the divergence
/// (R02).
///
/// Any git failure yields no history rather than an error: archaeology is
/// context for a conflict, and losing it must never cost the caller the
/// conflict report itself.
pub(crate) fn conflict_archaeology(
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

fn merge_tree_conflicts(repo: &Path, base: &str, branch: &str) -> Result<Vec<String>, ArcError> {
    Ok(match merge_tree(repo, base, branch)? {
        MergedTree::Clean(_) => vec![],
        MergedTree::Conflicted(conflicts) => conflicts,
    })
}

/// What merging two commits in memory came to.
enum MergedTree {
    /// The result tree's object id.
    Clean(String),
    /// The paths that conflict.
    Conflicted(Vec<String>),
}

/// Merge `branch` into `base` with `git merge-tree --write-tree` (git ≥ 2.38):
/// objects only, no worktree, index, or ref touched.
fn merge_tree(repo: &Path, base: &str, branch: &str) -> Result<MergedTree, ArcError> {
    // `-z` is spelled here rather than added by the door, because merge-tree
    // refuses the flag after its revision operands. Records: the toplevel tree
    // OID first; then, on a conflict, the conflicted paths, **one empty record
    // as a separator**, and informational records. The conflicted paths are
    // the whole reason this reads `-z` — without it git C-quotes them, and a
    // join preflight that names a path nobody has is worse than none.
    let (records, status) = tugchanges_core::listing_with_status(
        repo,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            base,
            branch,
        ],
    )
    .map_err(|e| {
        listing_error(
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "-z",
                base,
                branch,
            ],
            e,
        )
        .context("git merge-tree failed")
    })?;
    let tree_oid = records.first().cloned().unwrap_or_default();
    match status.code() {
        Some(0) if !tree_oid.is_empty() => Ok(MergedTree::Clean(tree_oid)),
        // Exit 1 ⇒ conflicts.
        Some(1) => Ok(MergedTree::Conflicted(
            records
                .iter()
                .skip(1)
                .take_while(|record| !record.is_empty())
                .cloned()
                .collect(),
        )),
        // Anything else is git failing to merge at all — a git too old for
        // `--write-tree` among them — and it says so rather than reading as
        // a clean merge of nothing. Git's own words arrived as the door's
        // error when it had any, so this is the silent-failure case.
        _ => Err(ArcError::git(
            "",
            &["merge-tree", "--write-tree", base, branch],
            "git merge-tree failed",
        )),
    }
}

/// A commit message as `git commit -m` would have stored it: trailing
/// whitespace stripped from each line, runs of blank lines collapsed, blank
/// lines at either end removed, one final newline. `git commit-tree` stores
/// its message verbatim, so a commit built off to the side cleans its own.
fn cleaned_commit_message(message: &str) -> String {
    let mut out = String::new();
    let mut pending_blank = false;
    for line in message.lines().map(str::trim_end) {
        if line.is_empty() {
            pending_blank = !out.is_empty();
            continue;
        }
        if pending_blank {
            out.push('\n');
            pending_blank = false;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Build a commit of `tree` on `parents` off to the side, then land it on the
/// checked-out base by fast-forward.
///
/// **Nothing is ever staged on the base.** `commit-tree` needs no index, so
/// the commit exists in full before the base is touched, and the one act that
/// touches it — `merge --ff-only` — refuses before writing anything when it
/// loses the index lock or when local changes overlap, and leaves disjoint
/// dirt alone. There is no half-landed state, so there is nothing to roll
/// back. The landing retries past a held `index.lock` with every other index
/// write ([`retry_past_index_lock`]).
///
/// `parents[0]` must be the base's head, which is what makes the landing a
/// fast-forward.
fn land_side_built_commit(
    repo_root: &Path,
    tree: &str,
    parents: &[&str],
    message: &str,
) -> Result<String, ArcError> {
    let message = cleaned_commit_message(message);
    let mut args = vec!["commit-tree", tree];
    for parent in parents {
        args.extend(["-p", parent]);
    }
    args.extend(["-m", &message]);
    let commit =
        git_stdout(repo_root, &args).map_err(|e| e.context("failed to build the join commit"))?;
    retry_past_index_lock(|| {
        git_write(
            repo_root,
            &["merge", "--ff-only", "--quiet", &commit],
            "failed to land the join commit",
        )
    })?;
    Ok(commit)
}

/// The one sanctioned shape of an arc draft row's identity: the id-qualified
/// owner key crossed with the arc's **base repository root** as the project.
///
/// Every surface that reads or writes an arc draft obtains this pair from
/// [`arc_draft_key`] rather than assembling it inline. That is the whole point
/// of the type: each probe axis this territory carries — id key vs bare branch
/// ref, canonical vs raw spelling, base root vs worktree — exists because some
/// surface built a key by hand and drifted from the others. A key that only
/// ever comes from one resolver cannot acquire a seventh axis.
///
/// `legacy_owner_id` is the bare branch ref, present only when the arc has a
/// `tugid` (so the two actually differ) — a read-side fallback for rows written
/// before the id-qualified key existed.
///
/// Spellings are not this type's business. It answers *which directory and
/// which owner*; reconciling how a directory is spelled remains the server's,
/// through the [L29] gateway.
#[derive(Debug, Clone)]
pub struct ArcDraftKey {
    pub owner_id: String,
    pub legacy_owner_id: Option<String>,
    pub project: PathBuf,
}

/// Resolve the canonical draft key for `name` in `repo_root`, which must be the
/// arc's **base repository root** — never a linked worktree. A read path, so
/// it resolves the owner key without minting a `tugid` ([P02]).
pub fn arc_draft_key(repo_root: &Path, name: &str) -> ArcDraftKey {
    let branch = branch_name(name);
    let owner_id = arc_owner_key(repo_root, name);
    let legacy_owner_id = (owner_id != branch).then_some(branch);
    ArcDraftKey {
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
/// `synthetic.conf` alias would read as a different project and the arc's
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

/// The maintained join draft for an arc, read read-only from the
/// machine-global changes ledger (`paths.changes_db`, which the caller's edge
/// resolved with `TUG_CHANGES_DB` honoured) — drafts are machine-global like
/// the working tree they describe.
///
/// The primary probe is [`arc_draft_key`]'s pair. Everything after it is a
/// **migration bridge**, not a reconciliation layer, and each rung is a row
/// shape some earlier writer produced:
///
/// - the bare branch ref as owner, for rows predating the `tugid` key;
/// - the raw spelling of a project directory, for rows a non-canonicalizing
///   writer stored;
/// - the arc **worktree** as project, for rows written by a `tugtool draft
///   set` that ran from inside the worktree and keyed by its cwd — the defect
///   this contract exists to close.
///
/// Base-root rows are probed before worktree rows so a current row always beats
/// a legacy one. The bridge decays: every authored write supersedes the legacy
/// rows for its arc, and the axes come out once no pre-fix arc rows remain in
/// the machine ledger.
///
/// Note that `worktree_path` probes the filesystem (the `.tug/worktrees/` home,
/// then the legacy `.tugtree/` one, else the new form), so for a **discarded**
/// arc it answers the default spelling rather than where the worktree actually
/// stood. That is acceptable for a best-effort legacy probe, and is said here so
/// it is not later read as a bug.
pub(crate) fn arc_draft_message(paths: &Paths, repo: &Path, branch: &str) -> Option<String> {
    let db = paths.changes_db.as_path();
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let read = |owner_id: &str, project: &str| -> Option<String> {
        conn.query_row(
            "SELECT message FROM changeset_drafts \
             WHERE owner_kind = 'arc' AND owner_id = ?1 AND project_dir = ?2",
            rusqlite::params![owner_id, project],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|m| !m.trim().is_empty())
    };

    let name = branch.trim_start_matches(BRANCH_PREFIX);
    let key = arc_draft_key(repo, name);
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
/// arc draft ([P23]) → the arc description → a bare fallback, always wrapped
/// as `tugarc(<name>): …`, for every strategy's integrate.
///
/// Every body source may legitimately already open with an arc scope — a draft
/// authored in the conventional voice, a description written by hand, an
/// override composed from a previous message. So the wrap is idempotent: **any**
/// leading `tugarc(…): ` is stripped before the subject is composed, whatever
/// name it carries.
///
/// Not only this arc's own name. A foreign scope used to pass through, on the
/// reasoning that it was content rather than an accident of composition — and
/// it produced `tugarc(close-backend): tugarc(backend): …`, which is not a
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
    paths: &Paths,
    repo: &Path,
    name: &str,
    branch: &str,
    override_msg: Option<String>,
    session: Option<&str>,
) -> String {
    let subject = match override_msg {
        Some(body) => compose_landing_subject(name, &body),
        None => landing_message_preview(paths, repo, name, branch).0,
    };
    // Subject stays `tugarc(<name>): …`; the trailers ride the body ([P08]).
    with_arc_trailers(paths, repo, name, branch, &subject, session)
}

/// Where a landing message's words came from ([P05]).
///
/// The precedence itself is silent — a forgotten draft lands the branch
/// description, and an arc with neither lands `Arc work` — so the source
/// travels beside the text and the prompt says which one it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandingMessageSource {
    /// The arc's authored join draft.
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

/// Scope-strip a body and wear this arc's own scope — the one composition
/// [`integrate_message`] and [`landing_message_preview`] share, so what the
/// prompt shows and what the join lands cannot drift.
fn compose_landing_subject(name: &str, body: &str) -> String {
    format!("tugarc({}): {}", name, strip_arc_scope(body))
}

/// The message a join would land with right now, and where it came from ([P05]).
///
/// Trailers are omitted: they are composed against the round set at landing
/// time, and a preview that carried them would be showing the user provenance
/// they cannot act on. The subject and body are byte-identical to what
/// [`integrate_message`] would produce with no override.
pub fn landing_message_preview(
    paths: &Paths,
    repo: &Path,
    name: &str,
    branch: &str,
) -> (String, LandingMessageSource) {
    let (body, source) = match arc_draft_message(paths, repo, branch) {
        Some(draft) => (draft, LandingMessageSource::Draft),
        None => match config_get(repo, &format!("branch.{}.description", branch)) {
            Some(description) => (description, LandingMessageSource::Description),
            None => ("Arc work".to_string(), LandingMessageSource::Fallback),
        },
    };
    (compose_landing_subject(name, &body), source)
}

/// Strip one leading `tugarc(<anything>): ` or `tugdash(<anything>): `, or
/// return the body unchanged.
///
/// Matched by hand rather than by pattern so a body whose text merely *contains*
/// `tugarc(` later on is untouched: the opener has to be at position 0, and the
/// closing paren is the first one after it.
///
/// The retired `tugdash(` spelling stays readable for life. A draft authored
/// before this build — by an older engine, or by a stage on an in-flight arc —
/// already wears it, and the wrap has to be idempotent over what is actually
/// on disk rather than over what this build would have written.
fn strip_arc_scope(body: &str) -> &str {
    for opener in ["tugarc(", "tugdash("] {
        let Some(rest) = body.strip_prefix(opener) else {
            continue;
        };
        let Some(close) = rest.find(')') else {
            return body;
        };
        return rest[close + 1..].strip_prefix(": ").unwrap_or(body);
    }
    body
}

fn stale_journal_detail(name: &str) -> String {
    format!(
        "A previous join of arc '{}' is incomplete. Resume it with: tugtool arc join {} --continue",
        name, name
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

fn off_base_detail(current_branch: &str, base_branch: &str) -> String {
    format!(
        "Cannot join: repo root worktree is on branch '{}' but arc targets '{}'. Check out '{}' first.",
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
        "Cannot join: your uncommitted edit to {} on the base differs from this arc's version of it.",
        paths.join(", "),
    )
}

/// The same fact when the edit belongs to another live session.
///
/// The remedy beside it is the same fold the user's own dirt earns, because
/// committing work preserves it — the sentence names whose the edit is, and
/// the remedy says what the fold does about that.
fn foreign_dirt_detail(holder: &str, paths: &[String]) -> String {
    format!(
        "Cannot join: {} holds an uncommitted edit to {} that this arc also changed.",
        holder,
        paths.join(", "),
    )
}

/// Untracked base files the integration would have to write over. `git merge
/// --squash` refuses these outright, so without this they read as a clean
/// preview followed by a failing join.
fn untracked_overwrite_detail(paths: &[String]) -> String {
    format!(
        "Cannot join: untracked files at the repo root would be overwritten by this arc ({}). Move them aside first.",
        paths.join(", "),
    )
}

fn empty_detail(name: &str, base_branch: &str) -> String {
    format!(
        "Nothing to join: arc '{}' has no commits past '{}'. Discard it instead.",
        name, base_branch
    )
}

/// A blocker with no paths and no remedy — the shape of every kind but base
/// dirt. One constructor per kind, so the preview that reports a blocker and
/// the execute path that refuses with it say the same title and sentence.
fn plain_blocker(kind: &str, title: &str, detail: String) -> JoinBlocker {
    JoinBlocker {
        kind: kind.to_string(),
        title: title.to_string(),
        detail,
        paths: vec![],
        overlap: vec![],
        remedy: None,
    }
}

fn stale_journal_blocker(name: &str) -> JoinBlocker {
    plain_blocker(
        "stale-journal",
        "A join left a teardown behind",
        stale_journal_detail(name),
    )
}

fn off_base_blocker(current_branch: &str, base_branch: &str) -> JoinBlocker {
    plain_blocker(
        "off-base",
        "The base is on another branch",
        off_base_detail(current_branch, base_branch),
    )
}

fn empty_blocker(name: &str, base_branch: &str) -> JoinBlocker {
    plain_blocker("empty", "Nothing to join", empty_detail(name, base_branch))
}

/// One base path an arc also changed, and what its uncommitted bytes are.
///
/// The relation is the fact everything downstream turns on, and it is worth
/// stating what it means rather than only how it is spelled: `identical` says
/// the base's working copy is **byte for byte the version the arc carries**,
/// which makes restoring it from HEAD lossless — those bytes are on the arc
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
    /// arc. Present means the edit is somebody else's in-progress work, which
    /// nothing here may move: folding a half-written edit into a join would
    /// take it out from under the session writing it. Absent means the user's
    /// own, which a resolve may act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
}

/// The base copy is the arc's own bytes; dropping it loses nothing.
pub const OVERLAP_IDENTICAL: &str = "identical";
/// The base copy is other work, and only a person or a merge may decide it.
pub const OVERLAP_DIVERGENT: &str = "divergent";

/// Which of the two a path is, read off the object database.
///
/// Both sides are reduced to a blob id before they are compared — the base's
/// working file through `hash-object`, which applies the same clean filters
/// git applied to what it stored, and the arc's through `rev-parse`. Comparing
/// ids rather than bytes is exact, is one read per side, and gets the filter
/// question right for free; comparing the file's raw bytes against a stored
/// blob would call every filtered file divergent.
///
/// A path absent from **both** sides is identical: the base deleted a file the
/// arc also deleted, and the join's result is the deletion either way.
fn overlap_relation(repo_root: &Path, branch: &str, path: &str) -> String {
    let base_blob = if repo_root.join(path).exists() {
        git_stdout(repo_root, &["hash-object", "--path", path, "--", path]).ok()
    } else {
        None
    };
    let arc_blob = git_stdout(
        repo_root,
        &["rev-parse", "--verify", &format!("{branch}:{path}")],
    )
    .ok();
    if base_blob == arc_blob {
        OVERLAP_IDENTICAL.to_string()
    } else {
        OVERLAP_DIVERGENT.to_string()
    }
}

/// Just the paths, for the sentences and the wire fields that take them.
pub(super) fn overlap_paths(overlap: &[BaseOverlapPath]) -> Vec<String> {
    overlap.iter().map(|o| o.path.clone()).collect()
}

/// Put the base's identical copies back the way HEAD has them, so the merge
/// may write the paths it owns.
///
/// **This is why the relation is read from the objects.** Every path here holds
/// exactly what the arc branch carries, so the restore destroys nothing: the
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
///
/// **Every path is classified before any is touched, and the drop is all or
/// nothing.** The `tracked` bucket is "dirty against HEAD", which holds two
/// index states git treats differently: a path HEAD knows restores with
/// `checkout HEAD --`, and a path *staged as new* — in the index, absent from
/// HEAD — has nothing there to restore to, so its index entry goes with its
/// file ([`carry_working_set_in`]'s `"staged-new"` arm is the model). A failure
/// part-way puts back every copy already dropped, from `<branch>:<path>` —
/// the same guarantee that licensed the drop — with the index entry each path
/// held, so the base reads as it did before the call.
fn drop_identical_base_copies(
    repo_root: &Path,
    branch: &str,
    droppable: &BlockingBasePaths,
    warnings: &mut Vec<String>,
) -> Result<(), DropFailure> {
    let copies: Vec<BaseCopy> = droppable
        .tracked
        .iter()
        .map(|o| BaseCopy::read(repo_root, &o.path, true))
        .chain(
            droppable
                .untracked
                .iter()
                .map(|o| BaseCopy::read(repo_root, &o.path, false)),
        )
        .collect();

    for (i, copy) in copies.iter().enumerate() {
        if let Err(e) = copy.drop_from(repo_root) {
            let error = e.context(format!("failed to drop the base's copy of {}", copy.path));
            // The failing path is put back with the rest: a drop that failed
            // may still have done half of what it does, and the put-back is
            // idempotent over a path that was never touched.
            let left_dropped: Vec<String> = copies[..=i]
                .iter()
                .filter(|c| c.put_back(repo_root, branch).is_err())
                .map(|c| c.path.clone())
                .collect();
            return Err(DropFailure {
                error,
                left_dropped,
            });
        }
    }
    let dropped = [
        overlap_paths(&droppable.tracked),
        overlap_paths(&droppable.untracked),
    ]
    .concat();
    if !dropped.is_empty() {
        warnings.push(format!(
            "Dropped the base checkout's uncommitted copy of {} — this arc carries the same bytes, and lands them.",
            dropped.join(", ")
        ));
    }
    Ok(())
}

/// A drop that did not finish, and what it could not take back.
///
/// `left_dropped` empty means the base is as the drop found it, so the caller
/// may treat the verb as not having happened. Anything named there is a path
/// the put-back could not restore — the bytes are still at `<branch>:<path>`,
/// and the caller owes the record and the user that fact.
#[derive(Debug)]
struct DropFailure {
    error: ArcError,
    left_dropped: Vec<String>,
}

impl DropFailure {
    /// The error the verb returns: the drop's own, with what it left behind.
    fn sentence(self, branch: &str) -> ArcError {
        if self.left_dropped.is_empty() {
            self.error
                .with_tail(" — the base checkout was left as it was.")
        } else {
            let tail = format!(
                " — and the base's copy of {} could not be put back; the same bytes are on '{branch}'.",
                self.left_dropped.join(", ")
            );
            self.error.with_tail(tail)
        }
    }
}

/// Which of the three states a droppable base copy is in — the one fact that
/// decides how it is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaseCopyState {
    /// HEAD has the path; the copy restores from it.
    TrackedDirty,
    /// In the index and absent from HEAD: nothing to restore to.
    StagedNew,
    /// Not in the index at all.
    Untracked,
}

/// One droppable base copy, read before anything is touched: how to drop it,
/// and what putting it back has to reproduce.
#[derive(Debug)]
struct BaseCopy {
    path: String,
    state: BaseCopyState,
    /// The index entry the path held, `(mode, blob)` — `None` for a path the
    /// index did not have (untracked, or a staged deletion).
    index_entry: Option<(String, String)>,
    /// Whether the file was on disk. A deletion both sides made is
    /// `identical` too, and putting that back means removing the file again.
    on_disk: bool,
    /// The working file's permission bits, so a put-back restores the file
    /// the base had rather than one that merely holds the same bytes. The
    /// index entry answers this for a tracked path and for nothing else: an
    /// executable *untracked* copy has no entry to read a mode off.
    #[cfg(unix)]
    mode: Option<u32>,
}

impl BaseCopy {
    fn read(repo_root: &Path, path: &str, tracked: bool) -> BaseCopy {
        // One record per entry, `<mode> <sha> <stage>\tpath` — the mode and sha
        // are what this reads, and the path operand is a real name only
        // because the listing that produced it was one ([B01]).
        let index_entry = tugchanges_core::listing(repo_root, &["ls-files", "--stage", "--", path])
            .ok()
            .and_then(|records| {
                let line = records.first()?;
                let mut fields = line.split_whitespace();
                Some((fields.next()?.to_string(), fields.next()?.to_string()))
            });
        let in_head = git_output(repo_root, &["cat-file", "-e", &format!("HEAD:{path}")])
            .map(|o| o.status.success())
            .unwrap_or(false);
        let state = match (tracked, in_head) {
            (false, _) => BaseCopyState::Untracked,
            (true, true) => BaseCopyState::TrackedDirty,
            (true, false) => BaseCopyState::StagedNew,
        };
        BaseCopy {
            path: path.to_string(),
            state,
            index_entry,
            on_disk: repo_root.join(path).exists(),
            #[cfg(unix)]
            mode: {
                use std::os::unix::fs::PermissionsExt;
                std::fs::metadata(repo_root.join(path))
                    .ok()
                    .map(|m| m.permissions().mode() & 0o7777)
            },
        }
    }

    fn drop_from(&self, repo_root: &Path) -> Result<(), ArcError> {
        match self.state {
            BaseCopyState::TrackedDirty => {
                git_stdout(repo_root, &["checkout", "HEAD", "--", &self.path]).map(|_| ())
            }
            BaseCopyState::StagedNew => git_stdout(
                repo_root,
                &[
                    "rm",
                    "--force",
                    "--quiet",
                    "--ignore-unmatch",
                    "--",
                    &self.path,
                ],
            )
            .map(|_| ()),
            BaseCopyState::Untracked => {
                let copy = repo_root.join(&self.path);
                std::fs::remove_file(&copy).map_err(|e| ArcError::io("", &copy, e))
            }
        }
    }

    /// Restore the working file from the arc branch and the index entry from
    /// what was read, whatever the drop did or did not get to.
    fn put_back(&self, repo_root: &Path, branch: &str) -> Result<(), ArcError> {
        let file = repo_root.join(&self.path);
        if self.on_disk {
            // `--filters` is the smudged, worktree form of the blob — what a
            // checkout of the path would have written.
            let out = git_output(
                repo_root,
                &["cat-file", "--filters", &format!("{branch}:{}", self.path)],
            )?;
            if !out.status.success() {
                return Err(ArcError::git(
                    "",
                    &["cat-file", "--filters", &format!("{branch}:{}", self.path)],
                    String::from_utf8_lossy(&out.stderr).trim(),
                ));
            }
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| ArcError::io("", dir, e))?;
            }
            std::fs::write(&file, &out.stdout).map_err(|e| ArcError::io("", &file, e))?;
            #[cfg(unix)]
            if let Some(mode) = self.mode {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode))
                    .map_err(|e| ArcError::io("", &file, e))?;
            }
        } else if file.exists() {
            std::fs::remove_file(&file).map_err(|e| ArcError::io("", &file, e))?;
        }
        match &self.index_entry {
            Some((mode, blob)) => git_stdout(
                repo_root,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{mode},{blob},{}", self.path),
                ],
            )
            .map(|_| ()),
            None if self.state == BaseCopyState::Untracked => Ok(()),
            None => git_stdout(
                repo_root,
                &["update-index", "--force-remove", "--", &self.path],
            )
            .map(|_| ()),
        }
    }
}

/// The base paths that would block a join, split by why they block.
#[derive(Debug, Clone, Default)]
pub(super) struct BlockingBasePaths {
    /// Tracked paths with uncommitted changes.
    pub(super) tracked: Vec<BaseOverlapPath>,
    /// Untracked paths the integration would have to write over.
    pub(super) untracked: Vec<BaseOverlapPath>,
}

impl BlockingBasePaths {
    fn is_empty(&self) -> bool {
        self.tracked.is_empty() && self.untracked.is_empty()
    }

    /// Partition on the one question that decides what the join does: whether
    /// the base's copy is bytes the arc already carries. The first half still
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

/// The base state that would block a join of `branch`: the base's dirty tracked
/// paths and its untracked paths, each intersected with the arc's changed set
/// (`base...branch` ∪ the arc worktree's own dirt). Disjoint base dirt is fine
/// — the integration only writes the arc's files.
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
    let mut arc_changed: Vec<String> = git_paths_or_empty(
        repo_root,
        &[
            "diff",
            "--name-only",
            &format!("{}...{}", base_branch, branch),
        ],
    );
    if worktree.exists() {
        arc_changed.extend(dirty_tracked_paths(worktree));
    }
    intersect_base_dirt(repo_root, branch, &base_dirt, &base_untracked, &arc_changed)
}

/// The intersection itself, over sets the caller has already read.
///
/// Split out so the per-arc detail walk — which has hoisted the base's dirty
/// set above its loop, and already holds each arc's changed file list — can
/// reach the same answer without re-running the reads, and, more importantly,
/// without a second definition of what "blocking" means. The card's early
/// warning and the join's refusal are the same set because they are the same
/// function.
///
/// Each surviving path is read for its relation ([`overlap_relation`]) — two
/// object reads on a set that is empty in the ordinary case, and small in
/// every other, because it is already an intersection.
pub(super) fn intersect_base_dirt(
    repo_root: &Path,
    branch: &str,
    base_dirt: &[String],
    base_untracked: &[String],
    arc_changed: &[String],
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
            .filter(|p| arc_changed.contains(p))
            .map(read)
            .collect(),
        untracked: base_untracked
            .iter()
            .filter(|p| arc_changed.contains(p))
            .map(read)
            .collect(),
    }
}

/// What would refuse a join of `name` right now ([P02]) — the preflight the
/// execute path checks inline, reported rather than returned as an `Err` so a
/// `--preview` can show every blocker at once and name the act that clears it.
///
/// The cwd guard is deliberately not here ([R02]): it reads the process cwd,
/// which is the server's when the call comes from tugcast.
pub fn join_preflight_in(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
) -> Result<Vec<JoinBlocker>, ArcError> {
    let repo_root = &main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    let detail = arc_detail_entry_in(paths, repo_root, name).ok_or_else(|| ArcError::NotFound {
        name: name.to_string(),
    })?;
    let current = current_branch(repo_root)?;
    // No occupancy view from a CLI process, and none wanted: a join in flight
    // refuses a join started from here whether or not the server is mid-join.
    // Which is exactly why the resolve lease exists — the one occupancy fact a
    // second process can still read, because it is written in git.
    Ok(join_blockers_from_detail(
        paths,
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
    /// The branch the fold committed onto — carried rather than re-derived,
    /// because the caller that tells a holder what happened needs to name it
    /// and the fold is the half that already read it.
    pub base_branch: String,
    /// The commit the fold made on the base, when there was divergent work to
    /// fold. Absent when every overlapping path was the arc's own bytes and
    /// dropping them was the whole of the job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed: Option<String>,
    /// Paths folded into that commit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<String>,
    /// Paths dropped as the arc's own bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dropped: Vec<String>,
    /// Folded paths that were another live session's work in progress, mapped
    /// to that session's display name — the fold preserved them, and this is
    /// how the caller knows which sessions to tell.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub folded_from: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}

/// Clear the base-side work that is refusing this arc's join.
///
/// **It clears the block and stops.** Landing stays the user's own gesture —
/// which is why the control that runs this reads `Resolve` and not `Resolve and
/// join`, and why nothing here calls [`join_in`].
///
/// Two things happen, in the order that makes a refusal cost nothing. Paths the
/// arc already carries byte for byte are dropped ([`drop_identical_base_copies`]).
/// Paths that are the user's own divergent work are **committed onto the base
/// as their own commit**, which is the whole of the fold: from that commit
/// forward the two sides are ordinary git history, so a collision between the
/// user's edit and the arc's is an ordinary base-versus-arc conflict and
/// reaches the resolution ladder that every join conflict already reaches. No
/// new merge machinery, and no third side for the ladder to learn.
///
/// It is one commit, with its own message naming what it is, and it is
/// op-logged: `tugtool arc undo` resets the base back and leaves the same
/// content uncommitted, exactly where the user had it.
///
/// A path another live session holds folds with the rest rather than
/// refusing, because the fold *preserves* that work: the holder's files do
/// not change on disk, their session keeps editing on top of the new commit,
/// and undo returns the content uncommitted exactly as it does for the
/// user's own. The commit's message and the outcome's `folded_from` name
/// whose work rode along — `live_dirt`, the caller's attribution on the same
/// terms as [`join_blockers_from_detail`]'s, is what names it — and the
/// caller owes each named holder the news ([L31]'s other half): tugcast
/// sends their session a notice.
pub fn resolve_base_in(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    live_dirt: &BTreeMap<String, String>,
) -> Result<ResolveBaseOutcome, ArcError> {
    let repo_root = main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(&repo_root, &branch) {
        return Err(ArcError::Refused(format!("no such arc: '{name}'")));
    }
    let base_branch = arc_base(&repo_root, name)?;
    let current_branch = git_stdout(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch != base_branch {
        return Err(ArcError::Refused(off_base_detail(
            &current_branch,
            &base_branch,
        )));
    }
    let worktree = worktree_path(&repo_root, name);

    // A join that stranded the base is cleared first: what it left is not
    // "uncommitted work" the partition below knows how to read, and the record
    // that names it goes only once the base is back where that join found it.
    let mut warnings = Vec::new();
    let mut cleared_strand = match crate::oplog::stranded_join(paths, &repo_root, name) {
        Some(op) => {
            clear_stranded_join(paths, &repo_root, &op, &mut warnings)?;
            true
        }
        None => false,
    };

    // An operation that began and never finished — a verb killed mid-flight —
    // says nothing an undo can read. With no half-done integrate standing on
    // the base there is nothing of it left to clear but the record itself.
    if standing_integrate_markers(&repo_root).is_empty() {
        for op in crate::oplog::list_ops(paths, &repo_root)
            .into_iter()
            .filter(|op| {
                op.arc == name && op.after.is_none() && op.join.is_none() && op.stranded.is_none()
            })
        {
            crate::oplog::abandon(paths, &repo_root, op.seq);
            warnings.push(format!(
                "Dropped operation {} ({} of '{name}'), which began and never finished.",
                op.seq,
                op.verb.as_str()
            ));
            cleared_strand = true;
        }
    }

    // A `SQUASH_MSG` naming this arc's rounds is the other half of a squash
    // staged on the base and never committed. The staged bytes are the
    // droppable set below; the message file goes with them, or the base keeps
    // offering a dead squash's text to the user's next commit.
    if read_base_checkout(&repo_root, name).is_some_and(|base| base.squash_standing) {
        if let Ok(git_dir) = git_stdout(&repo_root, &["rev-parse", "--absolute-git-dir"]) {
            let _ = std::fs::remove_file(Path::new(&git_dir).join("SQUASH_MSG"));
        }
        warnings.push(format!(
            "Removed the SQUASH_MSG an uncommitted squash of '{name}' left on '{base_branch}'."
        ));
        cleared_strand = true;
    }

    let (blocking, droppable) =
        blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch).split_on_relation();

    // Whose work rides in the fold, kept beside it so the commit can
    // attribute each holder's paths and the caller can tell them what
    // happened.
    let folded_from: BTreeMap<String, String> = blocking
        .tracked
        .iter()
        .chain(blocking.untracked.iter())
        .filter_map(|o| {
            live_dirt
                .get(&o.path)
                .map(|holder| (o.path.clone(), holder.clone()))
        })
        .collect();
    if blocking.is_empty() && droppable.is_empty() {
        // Clearing the strand was the whole of the job.
        if cleared_strand {
            return Ok(ResolveBaseOutcome {
                name: name.to_string(),
                base_branch,
                committed: None,
                folded: vec![],
                dropped: vec![],
                folded_from,
                warnings,
            });
        }
        return Err(ArcError::Refused(format!(
            "Nothing to resolve: no uncommitted work on '{base_branch}' touches what arc '{name}' changed."
        )));
    }

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
        paths,
        &repo_root,
        crate::oplog::OpVerb::ResolveBase,
        name,
        op_before,
        &op_tips,
    )?;

    // Every failure from here closes the record it opened: abandoned when the
    // base is as the verb found it, completed with what actually moved when it
    // is not. A bare `before` is a record nothing can read.
    let close_failed = |left_dropped: &[String]| {
        if left_dropped.is_empty() {
            crate::oplog::abandon(paths, &repo_root, op_seq);
        } else {
            let _ = crate::oplog::record_complete(
                paths,
                &repo_root,
                op_seq,
                crate::oplog::OpAfter {
                    base_tip: git_stdout(&repo_root, &["rev-parse", &base_branch]).ok(),
                    dropped: left_dropped.to_vec(),
                    ..Default::default()
                },
            );
        }
    };

    if let Err(failure) = drop_identical_base_copies(&repo_root, &branch, &droppable, &mut warnings)
    {
        close_failed(&failure.left_dropped);
        return Err(failure.sentence(&branch));
    }

    let fold = || -> Result<Option<String>, ArcError> {
        if folded.is_empty() {
            return Ok(None);
        }
        let message = fold_commit_message(name, &folded, &folded_from);
        // Untracked paths are not in the index, and a pathspec commit refuses
        // a pathspec git does not know. Staging first covers the add/add case
        // — the base created a file the arc also creates — which is a real
        // shape of this blocker and not an edge.
        let mut add = vec!["add", "--"];
        add.extend(folded.iter().map(String::as_str));
        git_stdout(&repo_root, &add)
            .map_err(|e| e.context("failed to stage the base's work in progress"))?;
        let mut args = vec!["commit", "-m", &message, "--"];
        args.extend(folded.iter().map(String::as_str));
        git_stdout(&repo_root, &args)
            .map_err(|e| e.context("failed to commit the base's work in progress"))?;
        Ok(Some(git_stdout(&repo_root, &["rev-parse", "HEAD"])?))
    };
    let committed = match fold() {
        Ok(committed) => committed,
        // The fold did not commit, so the base tip has not moved; what did
        // happen is the drop, and the record says so rather than nothing.
        Err(e) => {
            close_failed(&dropped);
            return Err(e);
        }
    };

    crate::oplog::record_complete(
        paths,
        &repo_root,
        op_seq,
        crate::oplog::OpAfter {
            base_tip: Some(git_stdout(&repo_root, &["rev-parse", &base_branch])?),
            // The receipt, written where it survives: a reload and a second
            // deck both read the fold from here, and the frame that announced
            // it reaches neither.
            folded: folded.clone(),
            dropped: dropped.clone(),
            folded_from: folded_from.clone(),
            ..Default::default()
        },
    )?;

    Ok(ResolveBaseOutcome {
        name: name.to_string(),
        base_branch,
        committed,
        folded,
        dropped,
        folded_from,
        warnings,
    })
}

/// The subject line the fold's commit carries — shared with the remedy
/// sentence, so the thing the button promises and the thing the log records
/// are one string rather than two that agree today.
fn fold_commit_subject(arc: &str) -> String {
    format!("Commit base work in progress to unblock the join of {arc}")
}

/// The message the fold's commit carries.
///
/// It says what the commit is and stops. A machine writing prose about work it
/// did not do is the thing to avoid here, so it does not describe the change —
/// it describes the *act*, which is the part the machine actually performed,
/// and names the paths — each with whose work in progress it was, when it was
/// another session's — so the log reads without the op record beside it.
fn fold_commit_message(
    arc: &str,
    paths: &[String],
    folded_from: &BTreeMap<String, String>,
) -> String {
    format!(
        "{}\n\n{}\n\nThis commit was made by `tugtool arc resolve-base` to clear a join blocked by uncommitted work on these paths. `tugtool arc undo` reverses it and leaves the same content uncommitted.\n",
        fold_commit_subject(arc),
        paths
            .iter()
            .map(|p| match folded_from.get(p) {
                Some(holder) => format!("- {p} — work in progress from {holder}"),
                None => format!("- {p}"),
            })
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
/// arc — a session mated to it is no stranger to its files, and its dirt is
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

/// The remedy sentence, composed from the blocker's own facts ([P10]).
///
/// It is a **fact sheet**, not a slogan: how many files, whose they are, where
/// they are going, under what subject, that nothing on disk moves, and that
/// the way back is right here. That is the same set the discard preflight
/// already states, and it is stated for the same reason — the act commits
/// somebody's uncommitted work, so weighing it needs the facts before the
/// press rather than a receipt after it.
///
/// No CLI verb appears in it. Every fact it names is reachable from the
/// surface the sentence is rendered on, and naming a command the reader would
/// have to leave for is what the whole seam was built to stop.
fn remedy_explain(arc: &str, base: &str, count: usize, holder: Option<&str>) -> String {
    // "these 1 file" is what a format string with a bare plural produces, and
    // it is the first thing the sentence says — a fact sheet that cannot count
    // is read as one that cannot be trusted about the rest either.
    let files = if count == 1 {
        format!("this {count} file")
    } else {
        format!("these {count} files")
    };
    let subject = fold_commit_subject(arc);
    match holder {
        None => format!(
            "Resolve commits {files} — yours — onto {base} as one commit, “{subject}”. Nothing changes on disk, and Undo here puts them back uncommitted."
        ),
        Some(holder) => format!(
            "Resolve commits {files} — {holder}'s work in progress — onto {base} as one commit, “{subject}”. Nothing changes on disk, their session is told, and Undo here puts them back uncommitted."
        ),
    }
}

/// Split what still blocks into the user's own and somebody else's, each
/// carrying the sentence its case earns.
fn base_dirt_blockers(
    arc: &str,
    base: &str,
    blocking: Vec<BaseOverlapPath>,
    untracked: bool,
) -> Vec<JoinBlocker> {
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
                explain: remedy_explain(arc, base, mine.len(), None),
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
                explain: remedy_explain(arc, base, entries.len(), Some(&holder)),
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
/// (which branch is checked out) is per-repository rather than per-arc.
///
/// `held` says which run holds this arc right now — `"join"`, `"resolve"`, or
/// `None` for nobody, exactly what tugcast's in-process occupancy registry
/// answers. It is the one input the caller must supply: see the in-flight note
/// in the body for why the answer cannot be read from disk. A caller with no
/// occupancy view passes `None` and is answered from git alone, which is what
/// the resolve lease below is for.
///
/// `live_dirt` is the second such input, and the second for the same reason:
/// base paths another live session holds, mapped to its display name, already
/// scoped to sessions that are not working this arc ([`attach_holders`]). An
/// empty map reads every overlap as the user's own.
pub fn join_blockers_from_detail(
    paths: &Paths,
    repo_root: &Path,
    detail: &ArcDetail,
    current_branch: &str,
    held: Option<&str>,
    live_dirt: &BTreeMap<String, String>,
) -> Vec<JoinBlocker> {
    let name = detail.name.as_str();
    let base_branch = detail.base.as_str();
    let mut blockers = Vec::new();

    // A join in flight means *a join owns this arc*, and that reading splits
    // on one fact this function cannot see: whether anybody is still running. A
    // join advances its record's phase at each teardown boundary and completes
    // it at the end, so for the whole squash-to-record window the record is
    // open while the join is perfectly healthy. Only a teardown nobody holds is
    // stale.
    //
    // A *resolve* holding the arc does not excuse it: it would be
    // running over a crashed join's leavings, and the refusal is still right.
    //
    // `held` is passed rather than read because the holder registry is
    // in-process and lives a crate away — the same reason `pilot_action` takes
    // its facts rather than fetching them.
    if held != Some("join") && crate::oplog::join_in_flight(paths, repo_root, name).is_some() {
        blockers.push(stale_journal_blocker(name));
    }

    if current_branch != base_branch {
        blockers.push(off_base_blocker(current_branch, base_branch));
    }

    // Only the paths that are somebody's work. A base copy the arc already
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
        name,
        base_branch,
        attach_holders(&tracked_blocking, live_dirt),
        false,
    ));
    blockers.extend(base_dirt_blockers(
        name,
        base_branch,
        attach_holders(&untracked_blocking, live_dirt),
        true,
    ));

    // Empty is a *finding* on the preview path, not a refusal: the card's answer
    // to it is the discard affordance. The execute path auto-commits worktree
    // dirt before testing `ahead`, so dirt makes an arc non-empty here too.
    if detail.rounds == 0 && !detail.worktree_dirty_tracked {
        blockers.push(empty_blocker(name, base_branch));
    }

    blockers
}

/// The conflict half of a join preview: what `merge-tree` says, plus the two
/// heads the answer was computed from.
#[derive(Debug, Clone)]
pub struct JoinConflicts {
    pub conflicts: Vec<String>,
    pub base_sha: String,
    pub arc_sha: String,
}

/// Probe an arc's conflict set without touching anything.
///
/// **This half is cacheable**, and it is the expensive one: a `merge-tree` of
/// the two heads. It is a pure function of the two heads it
/// reports, which is what makes a cache keyed by that pair sound — unlike the
/// blockers ([`join_blockers_from_detail`]), which move without either head
/// moving and must never be cached.
pub fn join_conflicts_in(repo_root: &Path, name: &str) -> Result<JoinConflicts, ArcError> {
    let repo_root = &main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    if !git_supports_merge_tree() {
        return Err(ArcError::Refused(
            "a join preview requires git >= 2.38 (git merge-tree --write-tree).".to_string(),
        ));
    }
    let base_branch = arc_base(repo_root, name)?;
    let conflicts = merge_tree_conflicts(repo_root, &base_branch, &branch)?;
    Ok(JoinConflicts {
        conflicts,
        base_sha: git_stdout(repo_root, &["rev-parse", &base_branch])?,
        arc_sha: git_stdout(repo_root, &["rev-parse", &branch])?,
    })
}

/// Join an arc into its base branch in `repo_root` ([P14]):
/// `--strategy squash|merge|rebase`, a `--preview` (in-memory
/// `git merge-tree`, nothing touched), an intersection-aware preflight (base
/// dirt blocks only when it overlaps the arc's changed set), a clean abort on
/// conflict with the structured conflict list, and a recorded teardown
/// resumable via `--continue`. The default squash/merge message is the
/// maintained arc draft, else the description.
///
/// Never reads the process cwd: the one question that depends on where the
/// caller stands — whether it is inside the arc worktree — is answered from
/// [`JoinOptions::caller_cwd`].
pub fn join_in(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    opts: JoinOptions,
) -> Result<JoinOutcome, ArcError> {
    join_in_with_progress(paths, repo_root, name, opts, |_, _| {})
}

/// [`join_in`], narrating itself as it goes.
///
/// `on_beat(beat, status)` fires around each of the join's real boundaries,
/// with `status` one of `start` / `done`:
///
/// | Beat | What it surrounds |
/// |---|---|
/// | `squash` | the integrate — squash-merge and commit of the arc branch, per `strategy` |
/// | `teardown` | removing the arc worktree |
/// | `release` | forgetting the arc's crossings and residue, deleting the branch |
/// | `record` | the arc log line and closing the op-log record |
///
/// **The order is the code's, not the wire's convenience.** The arc log line
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
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    opts: JoinOptions,
    on_beat: impl Fn(&str, &str),
) -> Result<JoinOutcome, ArcError> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    reconcile_branches(paths, &repo_root, &mut warnings);
    // A journal an older build left behind becomes an op record here, where
    // every path below can see it — and an unreadable one is named rather than
    // ignored, because ignoring it would let a plain join run over an arc that
    // is half torn down.
    crate::oplog::fold_legacy_join_journal(paths, &repo_root, name)?;
    // Pre-feature arcs get rerere enabled here so a recorded resolution
    // replays on this and future joins ([P31]).
    crate::resolve::ensure_rerere_config(&repo_root);
    let branch = branch_name(name);
    let worktree = worktree_path(&repo_root, name);

    // --continue: resume an interrupted teardown from the record it left open.
    //
    // **Above the branch-exists guard, because the last phase of a teardown is
    // the branch being gone.** A join killed after `branch -D` has a worktree
    // to be sure of, an arc log line to append, and a record to close — and the
    // arc it names no longer has a branch, so a guard asking git would refuse
    // the one resume that most needs to run. The record is what says this arc
    // is mid-teardown; git cannot know it.
    if opts.continue_join {
        let op = crate::oplog::join_in_flight(paths, &repo_root, name).ok_or_else(|| {
            ArcError::Refused(format!(
                "No interrupted join to continue for arc '{}'.",
                name
            ))
        })?;
        let progress = op.join.clone().ok_or_else(|| {
            ArcError::Refused(format!(
                "No interrupted join to continue for arc '{}'.",
                name
            ))
        })?;
        return finish_join_teardown(
            paths,
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
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    let base_branch = arc_base(&repo_root, name)?;

    // --preview: report conflicts and blockers in memory; nothing is mutated.
    // This sits above the stale-journal guard because a preview of a journalled
    // arc reports `stale-journal` as a blocker rather than refusing — the
    // execute path below is still what refuses.
    if opts.preview {
        if !git_supports_merge_tree() {
            return Err(ArcError::Refused(
                "tugtool arc join --preview requires git >= 2.38 (git merge-tree --write-tree)."
                    .to_string(),
            ));
        }
        let blockers = join_preflight_in(paths, &repo_root, name)?;
        let probe = join_conflicts_in(&repo_root, name)?;
        // What the base did to each conflicted path, for the CLI's preview
        // report; read here, on demand, rather than on every probe.
        let archaeology = conflict_archaeology(
            &repo_root,
            &base_branch,
            &branch_name(name),
            &probe.conflicts,
        );
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
            archaeology,
            warnings,
        });
    }

    // A join still in flight means a prior one half-finished — require
    // --continue.
    if crate::oplog::join_in_flight(paths, &repo_root, name).is_some() {
        return Err(ArcError::Blocked(vec![stale_journal_blocker(name)]));
    }

    // A prior join that could not prove it left the base untouched stands
    // until `resolve-base` clears it; joining over it would stack a second
    // integrate on a state nothing recorded.
    if let Some(op) = crate::oplog::stranded_join(paths, &repo_root, name) {
        return Err(ArcError::Refused(crate::oplog::stranded_detail(&op)));
    }

    // Must run from the base worktree, not inside the arc worktree. Deliberately
    // absent from `join_preflight_in`: it reads the *caller's* cwd, which only
    // the CLI has — tugcast's is the server's and has nothing to do with the
    // calling card, so it passes none.
    if let Some(caller_cwd) = &opts.caller_cwd
        && caller_cwd.starts_with(&worktree)
    {
        return Err(ArcError::Refused(
            "Cannot join from inside the arc worktree. Run from repo root instead.".to_string(),
        ));
    }

    // Current branch must be the arc's base.
    let current_branch = git_stdout(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch != base_branch {
        return Err(ArcError::Blocked(vec![off_base_blocker(
            &current_branch,
            &base_branch,
        )]));
    }

    // Intersection preflight ([P14]): base dirt blocks only when it touches a
    // file this arc also changed (`base...branch` diff ∪ worktree dirt).
    // Disjoint base dirt is fine — the squash-merge only writes the arc's files.
    //
    // And it blocks only when the base's copy is *other work*. A copy holding
    // byte for byte what this arc carries is the arc's own edit sitting on
    // the base — the shape a note written on main from the arc's work leaves
    // — and refusing over it would be refusing to land bytes on the grounds
    // that they are already there. The drop is below, past every refusal, so
    // nothing is touched on a path that ends in `Err` ([L28]).
    let (blocking, droppable) =
        blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch).split_on_relation();
    if !blocking.is_empty() {
        return Err(ArcError::Blocked(if blocking.tracked.is_empty() {
            base_dirt_blockers(name, &base_branch, blocking.untracked, true)
        } else {
            base_dirt_blockers(name, &base_branch, blocking.tracked, false)
        }));
    }

    // The verification gate stood here. Nothing replaces it: the run's ending
    // replays the arc onto the live base and verifies the tree that lands
    // ([D142]'s successor), so the bytes were checked once, warm, where a
    // failure could still be fixed. What remains between a join and the base
    // is what the execution itself enforces — the preflight above, and a merge
    // that either applies or does not.

    // Auto-commit outstanding arc-worktree changes — FATAL on error now ([P14]).
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
        return Err(ArcError::Blocked(vec![empty_blocker(name, &base_branch)]));
    }

    // Record the operation before the integrate, and after the dirt sweep above
    // — the sweep's commit is work the arc owns, so a `before` read any
    // earlier would describe an arc missing it. Every refusal above this line
    // touched nothing that needs undoing, which is why the record starts here
    // rather than at the verb's entry.
    //
    // The keepalive is what survives the teardown: `branch -D` below would
    // otherwise leave the arc's rounds reachable only from a reflog on a
    // clock.
    let op_before = crate::oplog::capture_before(&repo_root, name)?;
    let op_tips = crate::oplog::tips_of(&op_before);
    let op_seq = crate::oplog::record_begin(
        paths,
        &repo_root,
        crate::oplog::OpVerb::Join,
        name,
        op_before,
        &op_tips,
    )?;

    // The last refusal is behind us, so the base's stale copies of this arc's
    // own bytes can go. Git would refuse the merge over them otherwise, even
    // though it is about to write those exact bytes. Inside the record, so a
    // drop that could not be taken back is on what an undo reads: the record
    // goes only when the base is as the join found it.
    if let Err(failure) = drop_identical_base_copies(&repo_root, &branch, &droppable, &mut warnings)
    {
        if failure.left_dropped.is_empty() {
            crate::oplog::abandon(paths, &repo_root, op_seq);
        } else {
            let _ = crate::oplog::record_stranded(
                paths,
                &repo_root,
                op_seq,
                crate::oplog::StrandedBase {
                    paths: failure.left_dropped.clone(),
                    found: "the base's copies of the arc's own bytes were dropped and could not be put back".to_string(),
                },
            );
        }
        return Err(failure.sentence(&branch));
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
    let arc_paths: Vec<String> = git_paths_or_empty(
        &repo_root,
        &[
            "diff",
            "--name-only",
            &format!("{}...{}", base_branch, branch),
        ],
    );
    let base_before = BaseReading::read(&repo_root, &arc_paths);
    // A record describes an operation that happened. An integrate that did not
    // land is one that did not happen **only if the base is as it was**, so
    // that is checked rather than assumed: equal readings drop the record —
    // jj states the rule as a transaction that is not committed writing no
    // operation, and dropping it is what lets an incomplete join record *mean*
    // a teardown to resume. Unequal readings keep it, marked, and say so.
    //
    // What it returns is the tail a stranded base adds to the failure's own
    // message, or nothing when the base is as the join found it.
    let settle_unlanded = || -> Option<String> {
        let base_after = BaseReading::read(&repo_root, &arc_paths);
        if base_after == base_before {
            crate::oplog::abandon(paths, &repo_root, op_seq);
            return None;
        }
        let stranded = base_after.difference_from(&base_before);
        let tail = format!(
            " — and the base checkout could not be proven untouched ({}). The join is recorded as operation {op_seq}; clear it with: tugtool arc resolve-base {name}",
            stranded.found
        );
        let _ = crate::oplog::record_stranded(paths, &repo_root, op_seq, stranded);
        Some(tail)
    };
    let integration = match integrate_join(paths, &repo_root, name, &branch, &base_branch, &opts) {
        Ok(integration) => integration,
        Err(e) => {
            return Err(match settle_unlanded() {
                Some(tail) => e.with_tail(tail),
                None => e,
            });
        }
    };
    let (commit_hash, message) = match integration {
        Integration::Landed {
            commit_hash,
            message,
        } => (commit_hash, message),
        Integration::Conflicted(conflicts) => {
            if let Some(tail) = settle_unlanded() {
                return Err(ArcError::Conflicted(conflicts).with_tail(tail));
            }
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
    crate::oplog::record_join_progress(paths, &repo_root, op_seq, progress.clone())?;
    on_beat("squash", "done");

    finish_join_teardown(
        paths,
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
/// The files git leaves in its directory while an integrate is half-done.
const INTEGRATE_MARKERS: [&str; 3] = ["SQUASH_MSG", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

/// What the base checkout holds, as far as a join can disturb it: where HEAD
/// is, which half-done-integrate markers stand, and — for each of the arc's
/// paths — the index entry and the working file's blob.
///
/// Read before an integrate and again after one that failed. Equal readings
/// are the proof that lets the join's record be dropped; unequal ones are why
/// it is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BaseReading {
    head: String,
    markers: Vec<&'static str>,
    paths: BTreeMap<String, String>,
}

impl BaseReading {
    fn read(repo_root: &Path, arc_paths: &[String]) -> BaseReading {
        let mut paths: BTreeMap<String, String> = arc_paths
            .iter()
            .map(|p| (p.clone(), String::new()))
            .collect();
        for chunk in arc_paths.chunks(200) {
            let mut staged = vec!["ls-files", "--stage", "--"];
            staged.extend(chunk.iter().map(String::as_str));
            for line in tugchanges_core::listing(repo_root, &staged).unwrap_or_default() {
                if let Some((entry, path)) = line.split_once('\t') {
                    if let Some(reading) = paths.get_mut(path) {
                        reading.push_str(entry);
                    }
                }
            }
            let on_disk: Vec<&str> = chunk
                .iter()
                .map(String::as_str)
                .filter(|p| repo_root.join(p).is_file())
                .collect();
            if on_disk.is_empty() {
                continue;
            }
            let mut hash = vec!["hash-object", "--"];
            hash.extend(on_disk.iter().copied());
            let blobs = git_stdout(repo_root, &hash).unwrap_or_default();
            for (path, blob) in on_disk.iter().zip(blobs.lines()) {
                if let Some(reading) = paths.get_mut(*path) {
                    reading.push_str(" | ");
                    reading.push_str(blob.trim());
                }
            }
        }
        BaseReading {
            head: git_stdout(repo_root, &["rev-parse", "HEAD"]).unwrap_or_default(),
            markers: standing_integrate_markers(repo_root),
            paths,
        }
    }

    /// What differs from `before`, as the stranded record states it.
    fn difference_from(&self, before: &BaseReading) -> crate::oplog::StrandedBase {
        let mut found = Vec::new();
        if self.head != before.head {
            found.push(format!("HEAD moved from {} to {}", before.head, self.head));
        }
        for marker in &self.markers {
            if !before.markers.contains(marker) {
                found.push(format!("{marker} is standing"));
            }
        }
        let paths: Vec<String> = self
            .paths
            .iter()
            .filter(|(path, reading)| before.paths.get(*path) != Some(reading))
            .map(|(path, _)| path.clone())
            .collect();
        if !paths.is_empty() {
            found.push(format!("{} of the arc's paths changed", paths.len()));
        }
        crate::oplog::StrandedBase {
            paths,
            found: found.join("; "),
        }
    }
}

/// What `arc doctor` reads off the base checkout for one arc.
pub(crate) struct BaseCheckoutReading {
    /// Whether a `SQUASH_MSG` naming this arc's rounds is standing.
    pub squash_standing: bool,
    /// Uncommitted base paths holding byte for byte what the arc's tip holds.
    pub echoed: Vec<String>,
}

/// Read the base checkout for the marks a half-landed join of `name` leaves.
///
/// Arc-specific on purpose. A `SQUASH_MSG` is reported only when the rounds it
/// lists are this arc's — a person's own `git merge --squash` is theirs — and
/// the echoed paths are the same set the join itself would drop
/// ([`blocking_base_dirt`] partitioned on relation), so the doctor and the
/// join cannot disagree about what "the arc's own bytes" means. `None` when
/// the arc has no branch, or the base is not the branch checked out.
pub(crate) fn read_base_checkout(repo_root: &Path, name: &str) -> Option<BaseCheckoutReading> {
    let repo_root = main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(&repo_root, &branch) {
        return None;
    }
    let base_branch = arc_base(&repo_root, name).ok()?;
    let current = git_stdout(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if current != base_branch {
        return None;
    }

    let squash_standing = standing_integrate_markers(&repo_root).contains(&"SQUASH_MSG")
        && git_stdout(&repo_root, &["rev-parse", "--absolute-git-dir"])
            .ok()
            .and_then(|dir| std::fs::read_to_string(Path::new(&dir).join("SQUASH_MSG")).ok())
            .is_some_and(|message| {
                let rounds = git_stdout(
                    &repo_root,
                    &["rev-list", &format!("{base_branch}..{branch}")],
                )
                .unwrap_or_default();
                message
                    .lines()
                    .filter_map(|line| line.strip_prefix("commit "))
                    .any(|sha| rounds.lines().any(|round| round == sha.trim()))
            });

    let worktree = worktree_path(&repo_root, name);
    let (_, droppable) =
        blocking_base_dirt(&repo_root, &worktree, &base_branch, &branch).split_on_relation();
    let echoed = [
        overlap_paths(&droppable.tracked),
        overlap_paths(&droppable.untracked),
    ]
    .concat();
    Some(BaseCheckoutReading {
        squash_standing,
        echoed,
    })
}

/// Which of [`INTEGRATE_MARKERS`] exist in the checkout's git directory.
fn standing_integrate_markers(repo_root: &Path) -> Vec<&'static str> {
    let Ok(git_dir) = git_stdout(repo_root, &["rev-parse", "--absolute-git-dir"]) else {
        return Vec::new();
    };
    INTEGRATE_MARKERS
        .into_iter()
        .filter(|marker| Path::new(&git_dir).join(marker).exists())
        .collect()
}

/// Clear what a stranded join left on the base, and drop its record once the
/// base is back where that join found it.
///
/// Only states with one right answer are acted on: a standing cherry-pick or
/// merge is aborted — the abort that failed the first time, re-attempted past
/// the index lock — and a leftover `SQUASH_MSG` is removed. A HEAD that is
/// still not where the join found it is *not* moved: that is history, and the
/// sentence says where it was so a person can decide.
fn clear_stranded_join(
    paths: &Paths,
    repo_root: &Path,
    op: &crate::oplog::OpPayload,
    warnings: &mut Vec<String>,
) -> Result<(), ArcError> {
    let standing = standing_integrate_markers(repo_root);
    for (marker, verb) in [("CHERRY_PICK_HEAD", "cherry-pick"), ("MERGE_HEAD", "merge")] {
        if standing.contains(&marker) {
            retry_past_index_lock(|| {
                git_write(
                    repo_root,
                    &[verb, "--abort"],
                    &format!("failed to abort the stranded {verb}"),
                )
            })?;
        }
    }
    if standing.contains(&"SQUASH_MSG") {
        if let Ok(git_dir) = git_stdout(repo_root, &["rev-parse", "--absolute-git-dir"]) {
            let _ = std::fs::remove_file(Path::new(&git_dir).join("SQUASH_MSG"));
        }
    }
    let head = git_stdout(repo_root, &["rev-parse", "HEAD"])?;
    let left = standing_integrate_markers(repo_root);
    if head != op.before.base_tip || !left.is_empty() {
        return Err(ArcError::Refused(format!(
            "{} — and it could not be cleared: '{}' is at {head}, the join found it at {}{}.",
            crate::oplog::stranded_detail(op),
            op.before.base_branch,
            op.before.base_tip,
            if left.is_empty() {
                String::new()
            } else {
                format!(", and {} still stands", left.join(", "))
            }
        )));
    }
    crate::oplog::abandon(paths, repo_root, op.seq);
    warnings.push(format!(
        "Cleared the base state a failed join of '{}' left behind (operation {}).",
        op.arc, op.seq
    ));
    Ok(())
}

/// Hold the host-wide gate for joins into `base_branch` until the returned
/// file is dropped — closing the descriptor releases the lock.
///
/// An `flock` on a file in the repository's common git dir, one per base: the
/// lock dies with the process that held it, so there is no stale state to
/// recover, and every worktree of the checkout — every tugcast, every CLI join
/// — reaches the same inode. Joins are short, so a second one waits rather than
/// being refused.
fn join_gate(repo_root: &Path, base_branch: &str) -> Result<std::fs::File, ArcError> {
    let common = git_stdout(repo_root, &["rev-parse", "--git-common-dir"])?;
    let common = repo_root.join(common);
    let path = common.join(format!(
        "tug-join-{}.lock",
        tugtool_core::worktree::sanitize_branch_name(base_branch)
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| ArcError::io("cannot open the join gate", &path, e))?;
    // SAFETY: `file.as_raw_fd()` is a valid fd for the lifetime of `file`;
    // `flock` records the lock in the kernel and retains nothing.
    let ret = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) };
    if ret != 0 {
        let e = std::io::Error::last_os_error();
        return Err(ArcError::io("cannot take the join gate", &path, e));
    }
    Ok(file)
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

/// Put the arc's work on the base — the whole integrate, in one place.
///
/// The strategy decides the shape: one squash commit, a merge, or the rounds
/// rebased. Every exit that does not land — a conflict, a failed merge or
/// commit — leaves the base as it was, which is what lets the caller drop the
/// record it opened.
fn integrate_join(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    branch: &str,
    base_branch: &str,
    opts: &JoinOptions,
) -> Result<Integration, ArcError> {
    // Every integrate moves the base, so every one holds the base's gate: two
    // joins reading the base first and landing second is a lost update, one
    // process apart.
    let _gate = join_gate(repo_root, base_branch)?;

    let final_msg = integrate_message(
        paths,
        repo_root,
        name,
        branch,
        opts.message.clone(),
        opts.session_id.as_deref(),
    );

    // Integrate per strategy. A conflict returns the structured conflict list
    // — never a dead end. For a squash and a merge it is found in memory, with
    // the base untouched; the rebase's cherry-pick aborts back to where it was.

    let commit_hash = match opts.strategy {
        JoinStrategy::Squash | JoinStrategy::Merge => {
            let base_head = git_stdout(repo_root, &["rev-parse", base_branch])?;
            let tree = match merge_tree(repo_root, &base_head, branch)? {
                MergedTree::Clean(tree) => tree,
                MergedTree::Conflicted(conflicts) => {
                    return Ok(Integration::Conflicted(conflicts));
                }
            };
            let mut parents = vec![base_head.as_str()];
            if matches!(opts.strategy, JoinStrategy::Merge) {
                parents.push(branch);
            }
            land_side_built_commit(repo_root, &tree, &parents, &final_msg)?
        }
        JoinStrategy::Rebase => {
            // Fast-forward when base is unchanged (linear); else replay the
            // arc's commits onto the current base with cherry-pick. This is
            // the one arm that still writes the base's index, so all three of
            // its writes wait out a held `index.lock` ([B03]): a fast-forward
            // that lost the lock is not a base that moved, a pick that lost it
            // is not a conflict, and an abort that loses it is the strand.
            let ff = git_write_on_the_merits(
                repo_root,
                &["merge", "--ff-only", branch],
                &format!("failed to fast-forward '{base_branch}' onto the arc"),
            )?;
            if ff.is_none() {
                git_stdout(repo_root, &["rev-parse", "HEAD"])?
            } else {
                let pick = git_write_on_the_merits(
                    repo_root,
                    &["cherry-pick", &format!("{}..{}", base_branch, branch)],
                    "failed to replay the arc's rounds onto the base",
                )?;
                if pick.is_some() {
                    let conflicts = conflicted_paths(repo_root);
                    let _ = retry_past_index_lock(|| {
                        git_write(
                            repo_root,
                            &["cherry-pick", "--abort"],
                            "failed to abort the cherry-pick",
                        )
                    });
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

/// What a join's teardown acts on: the repo, the arc, and the git objects
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
/// branch, append the arc log line, complete the record — advancing the
/// record's phase after each step so `--continue` resumes exactly where a
/// crash left off. Idempotent per phase.
///
/// The sequence number is carried in rather than searched for. This is also the
/// `--continue` entry point, and there the caller found the record by asking
/// which join is in flight — so both paths arrive holding the op they are
/// finishing, and a completion can no longer land on the wrong one.
fn finish_join_teardown(
    paths: &Paths,
    target: TeardownTarget<'_>,
    op_seq: u64,
    mut progress: crate::oplog::JoinProgress,
    mut warnings: Vec<String>,
    on_beat: &dyn Fn(&str, &str),
) -> Result<JoinOutcome, ArcError> {
    let TeardownTarget {
        repo_root,
        name,
        branch,
        worktree,
        origin,
    } = target;
    // Captured while the branch still exists and the arc log has not had its
    // terminal line written: both are gone by the time the outcome is read,
    // and a fact read afterwards would be no fact at all.
    let fit = fit_fact(
        &arc_tips(
            repo_root,
            branch,
            &arc_base(repo_root, name).unwrap_or_default(),
        ),
        &read_declarations(paths, repo_root, name),
    );
    if progress.phase == crate::oplog::JoinPhase::Integrated {
        on_beat("teardown", "start");
        remove_arc_worktree(paths, repo_root, branch, worktree, &mut warnings);
        progress.phase = crate::oplog::JoinPhase::WorktreeRemoved;
        crate::oplog::record_join_progress(paths, repo_root, op_seq, progress.clone())?;
        on_beat("teardown", "done");
    }

    if progress.phase == crate::oplog::JoinPhase::WorktreeRemoved {
        on_beat("release", "start");
        crate::crossing::forget_crossings(repo_root, name);
        // The branch config section dies with the branch, but a loose ref and
        // a workshop the retired join pipeline left do not.
        crate::residue::forget_join_residue(repo_root, name, &mut warnings);
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
        // durable record of a joined arc, and the brief and the plan have
        // nothing to add to it. Named in the receipt rather than done quietly,
        // because an `undo` does not bring the directory back.
        let documents = documents_dir(repo_root, name);
        if documents.is_dir() {
            match std::fs::remove_dir_all(&documents) {
                Ok(()) => warnings.push(format!("removed .tug/arcs/{name}/")),
                Err(e) => warnings.push(format!("could not remove {}: {e}", documents.display())),
            }
        }
        progress.phase = crate::oplog::JoinPhase::BranchDeleted;
        crate::oplog::record_join_progress(paths, repo_root, op_seq, progress.clone())?;
        on_beat("release", "done");
    }

    // Record the terminal action in the arc log, then close the record — in
    // that order, so a crash between the two leaves a join that visibly
    // happened and an op `--continue` can still complete.
    on_beat("record", "start");
    let short = git_stdout(repo_root, &["rev-parse", "--short", &progress.commit_hash])
        .unwrap_or_else(|_| progress.commit_hash.clone());
    let note = match origin {
        Some(origin) => format!("joined via {origin}"),
        None => "joined".to_string(),
    };
    append_arc_log(paths, repo_root, name, &short, &note)
        .map_err(|e| ArcError::arc_log(paths, repo_root, e))?;

    let base_branch = base_branch_of(paths, repo_root, op_seq, name);
    let after = crate::oplog::OpAfter {
        base_tip: git_stdout(repo_root, &["rev-parse", &base_branch]).ok(),
        landed_commit: Some(progress.commit_hash.clone()),
        ..Default::default()
    };
    if let Err(e) = crate::oplog::record_complete(paths, repo_root, op_seq, after) {
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
/// re-derived: by the time a `--continue` runs, the arc branch may already be
/// deleted and `arc_base` would fall back to the repository's default branch,
/// which is a guess.
fn base_branch_of(paths: &Paths, repo_root: &Path, op_seq: u64, name: &str) -> String {
    crate::oplog::read_op(paths, repo_root, op_seq)
        .map(|op| op.before.base_branch)
        .or_else(|| arc_base(repo_root, name).ok())
        .unwrap_or_else(|| "main".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn preflight_leaves_ordinary_base_dirt_wording_alone() {
        let (_temp, root, paths) = plain_arc("plainly-arc");
        let worktree = worktree_path(&root, "plainly-arc");
        fs::write(worktree.join("README.md"), "# Arc\n").unwrap();
        commit_in(&paths, &root, "plainly-arc", "touch readme", None, None).unwrap();
        fs::write(root.join("README.md"), "# Local\n").unwrap();

        let blockers = join_preflight_in(&paths, &root, "plainly-arc").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert!(dirt.detail.contains("README.md"), "{:?}", dirt);
        assert!(
            dirt.detail.contains("differs from this arc"),
            "the sentence states the fact and names no act it cannot perform: {}",
            dirt.detail
        );
    }

    /// An untracked base file at a path the arc changed is what `git merge
    /// --squash` refuses outright — previously a clean preview and a failing
    /// join. It is a blocker now, and only when it actually intersects.
    #[test]
    fn preflight_blocks_untracked_base_files_the_arc_would_overwrite() {
        let (_temp, root, paths) = plain_arc("overwrite-arc");
        let worktree = worktree_path(&root, "overwrite-arc");
        fs::create_dir_all(worktree.join("roadmap")).unwrap();
        fs::write(worktree.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        commit_in(&paths, &root, "overwrite-arc", "add the plan", None, None).unwrap();

        // A disjoint untracked file does not block.
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        let clean = join_preflight_in(&paths, &root, "overwrite-arc").unwrap();
        assert!(clean.iter().all(|b| b.kind != "base-dirt"), "{clean:?}");

        // The same path the arc added does — when it is other content. An
        // untracked base file holding what the arc adds byte for byte is the
        // arc's own work sitting on the base, and is dropped rather than
        // refused over, the same as its tracked twin.
        fs::create_dir_all(root.join("roadmap")).unwrap();
        fs::write(root.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        let echo = join_preflight_in(&paths, &root, "overwrite-arc").unwrap();
        assert!(
            echo.iter().all(|b| b.kind != "base-dirt"),
            "an identical untracked copy is the arc's own bytes: {echo:?}"
        );

        fs::write(root.join("roadmap/plan.md"), "somebody else's plan\n").unwrap();
        let blockers = join_preflight_in(&paths, &root, "overwrite-arc").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert_eq!(dirt.paths, vec!["roadmap/plan.md".to_string()]);
        assert!(dirt.detail.contains("would be overwritten"), "{:?}", dirt);

        // The execute path refuses with the same sentence, rather than a clean
        // preview followed by a squash that fails on the untracked file.
        let err = join_in(&paths, &root, "overwrite-arc", mechanics())
            .unwrap_err()
            .to_string();
        assert_eq!(err, dirt.detail);
        assert!(branch_present(&root, "tugarc/overwrite-arc"));
    }

    /// The whole point of moving the documents out of the tree: what a join
    /// lands is the work, and the paperwork is not in it.
    #[test]
    fn a_planned_arc_lands_a_commit_whose_tree_holds_no_document() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = bare_repo_beside_state(&temp);
        create_in(&paths, &repo, "landing", None, false, None).unwrap();
        let root = fs::canonicalize(&repo).unwrap();

        let documents = documents_dir(&root, "landing");
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("brief.md"), "# The brief\n").unwrap();
        fs::write(documents.join("plan.md"), TWO_STEP_PLAN).unwrap();

        let worktree = worktree_path(&root, "landing");
        fs::write(worktree.join("feature.txt"), "the work\n").unwrap();
        commit_in(&paths, &root, "landing", "add the feature", None, None).unwrap();

        // Even without a `.gitignore`, `create` kept `.tug/` out of git.
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]).unwrap(), "");

        let out = join_in(&paths, &root, "landing", mechanics()).unwrap();
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
                .any(|w| w == "removed .tug/arcs/landing/"),
            "the receipt names the removal: {:?}",
            out.warnings
        );
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]).unwrap(), "");
    }

    // --- arc verbs inside a scoped repo universe ---------------------------
    //
    // These tests set `TUG_REPO_UNIVERSE` for their own process. That is safe
    // because the workspace runs under `cargo nextest`, which executes one
    // process per test, and because every test here is
    // `#[serial(tug_repo_universe)]` besides: the universe is the one input
    // the engine still reads from the environment, through the repo-root
    // resolver.

    /// The join narrates its beats, in the order the code performs them.
    ///
    /// The join takes real seconds and used to say nothing for all of them:
    /// the press landed and the next word was the durable commit message,
    /// however long later. These beats are what fills that silence — a
    /// liveness hint, never the carrier of truth.
    ///
    /// The order asserted here is the code's own, and it is not the order the
    /// beat names suggest: `record` is the arc log line, which is written
    /// *last*, after the worktree is gone and the branch is deleted, because it
    /// is the terminal record of a join that already happened.
    #[serial(tug_repo_universe)]
    #[test]
    fn test_a_join_narrates_its_beats_and_a_preview_narrates_nothing() {
        let temp = TempDir::new().unwrap();
        let (_base, universe, _universe, paths) = base_with_universe(&temp);

        create_in(&paths, &universe, "narrator", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/narrator");
        fs::write(worktree.join("landed.txt"), "from the arc\n").unwrap();
        commit_in(&paths, &universe, "narrator", "r1", None, None).unwrap();

        // A preview mutates nothing, so it has nothing to narrate.
        let previewed = std::cell::RefCell::new(Vec::<String>::new());
        join_in_with_progress(
            &paths,
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
        let outcome = join_in_with_progress(
            &paths,
            &universe,
            "narrator",
            mechanics(),
            |beat, status| beats.borrow_mut().push(format!("{beat}:{status}")),
        )
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
    #[serial(tug_repo_universe)]
    #[test]
    fn test_universe_join_lands_on_the_universe_branch() {
        let temp = TempDir::new().unwrap();
        let (base, universe, _universe, paths) = base_with_universe(&temp);
        let base_head_before = rev_parse_at(&base, "HEAD");

        create_in(&paths, &universe, "lander", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/lander");
        fs::write(worktree.join("landed.txt"), "from the arc\n").unwrap();
        commit_in(&paths, &universe, "lander", "r1", None, None).unwrap();

        let blockers = join_preflight_in(&paths, &universe, "lander").unwrap();
        assert!(
            blockers.is_empty(),
            "a coherent universe has nothing to refuse over: {blockers:?}"
        );

        let outcome = join_in(&paths, &universe, "lander", mechanics()).unwrap();
        assert!(outcome.commit_hash.is_some(), "the squash landed");
        assert_eq!(
            fs::read_to_string(universe.join("landed.txt")).unwrap(),
            "from the arc\n",
            "the universe's working tree carries the landed content"
        );
        assert!(!worktree.exists(), "arc worktree torn down");
        assert!(!branch_present(&universe, "tugarc/lander"));

        assert_eq!(
            rev_parse_at(&base, "HEAD"),
            base_head_before,
            "the base checkout's HEAD never moved"
        );
        let dlog = fs::read_to_string(arc_log_path(&temp.path().join("state"), &universe)).unwrap();
        assert!(dlog.contains("joined"), "the universe's arc log records it");
    }

    #[test]
    fn test_arc_join_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test arc".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("feature.txt"), "new feature\n").unwrap();
        commit_in(&paths, repo, "test-arc", "Add feature", None, None).unwrap();

        let result = join_in(
            &paths,
            repo,
            "test-arc",
            JoinOptions {
                message: Some("Add new feature".to_string()),
                ..mechanics()
            },
        );
        assert!(result.is_ok());

        // Squash commit on base, worktree + branch gone.
        let log = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(repo)
            .args(["log", "--oneline", "-1"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("tugarc(test-arc):"));
        assert!(!worktree.exists());
        assert!(!branch_present(repo, "tugarc/test-arc"));

        // arc log records the terminal action.
        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("joined"),
            "arc log should record join: {dlog}"
        );
    }

    /// The route that asked for a join is recorded in the arc log’s
    /// terminal note, so a join is attributable to the CLI or the card after
    /// the fact rather than only to "something".
    #[test]
    fn a_join_records_the_route_that_asked_for_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(&paths, repo, "routed", None, false, None).unwrap();
        fs::write(repo.join(".tug/worktrees/routed/f.txt"), "work\n").unwrap();
        commit_in(&paths, repo, "routed", "Add f", None, None).unwrap();

        join_in(
            &paths,
            repo,
            "routed",
            JoinOptions {
                origin: Some("card".to_string()),
                ..mechanics()
            },
        )
        .unwrap();

        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            dlog.contains("joined via card"),
            "arc log should name the route: {dlog}"
        );
    }

    /// A join with no explicit message uses the arc's maintained draft from
    /// the machine-global changes ledger (`TUG_CHANGES_DB`) as its squash
    /// message — pins `arc_draft_message` reading
    /// `changes.changeset_drafts`, not the legacy per-instance `sessions.db`.
    #[test]
    fn test_arc_join_uses_changes_ledger_draft_message() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let mut paths = redirect_state_dir(&home);

        // Seed the machine-global draft row under the canonical repo
        // spelling (Spec S05 write contract).
        let ledgers = tugcore::test_fixtures::ledgers(temp.path());
        let changes_db = ledgers.changes_db();
        {
            let conn = ledgers.changes();
            let project = fs::canonicalize(repo)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            conn.execute(
                "INSERT INTO changeset_drafts
                    (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
                 VALUES ('arc', 'tugarc/draft-arc', ?1, 'fp', 'Land the drafted work', 1, 1)",
                rusqlite::params![project],
            )
            .unwrap();
        }
        paths.changes_db = changes_db.clone();

        create_in(
            &paths,
            repo,
            "draft-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/draft-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "draft-arc", "Add f", None, None).unwrap();

        // Preview first (`/join`'s beat 1): in-memory, clean, mutates nothing.
        let preview = join_in(
            &paths,
            repo,
            "draft-arc",
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
            worktree.exists() && branch_present(repo, "tugarc/draft-arc"),
            "a preview tears nothing down"
        );

        // Execute: the squash message comes from the ledger draft.
        join_in(&paths, repo, "draft-arc", mechanics()).unwrap();

        let log = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let body = String::from_utf8_lossy(&log.stdout);
        assert!(
            body.contains("tugarc(draft-arc): Land the drafted work"),
            "squash message comes from the changes-ledger draft: {body}"
        );
        assert!(
            body.contains("Tug-Arc: tugarc/draft-arc onto "),
            "the squash carries the Tug-Arc trailer: {body}"
        );
    }

    /// Round commits and the join/squash commit carry the `Tug-Dash:` trailer
    /// ([P08], Spec S02). With no session id given the
    /// `Tug-Session:` trailer is omitted (no error).
    /// A join reaches the arc's draft under the id-qualified owner key — the
    /// key writers use once an arc has a creation id ([P01], [P03], Spec S02).
    /// Same fixture as the legacy-key case above; only the key differs.
    #[test]
    fn test_arc_join_uses_id_keyed_draft_message() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let mut paths = redirect_state_dir(&home);

        let changes_db = tugcore::test_fixtures::ledgers(temp.path()).changes_db();
        paths.changes_db = changes_db.clone();

        let created = create_in(
            &paths,
            repo,
            "id-draft-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let owner_key = created.id.expect("created arc has an owner key");
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
                 VALUES ('arc', ?1, ?2, 'fp', 'Land the id-keyed work', 1, 1)",
                rusqlite::params![owner_key, project],
            )
            .unwrap();
        }

        let worktree = repo.join(".tug/worktrees/id-draft-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "id-draft-arc", "Add f", None, None).unwrap();

        join_in(&paths, repo, "id-draft-arc", mechanics()).unwrap();

        let log = tugcore::test_fixtures::git::command()
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
    }

    /// The join the CARD presses is executed by tugcast, which is nobody's
    /// session and exports no `TUG_SESSION_ID` — so the id travels in
    /// [`JoinOptions::session_id`] and the squash commit names both the session
    /// and the arc. Two trailers, which is the two pills a joined commit's
    /// History row shows ([P10], Spec S03).
    ///
    /// The env is deliberately EMPTY here: this is the server's situation, and
    /// a test that let the env answer would pass without the argument ever
    /// being read.
    #[test]
    fn a_card_join_cites_the_session_the_request_names() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let mut paths = redirect_state_dir(&home);

        let line_id = "3c2b1a09-8877-4665-9443-221100ffeedd";
        let session = "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b";
        let ledgers = tugcore::test_fixtures::ledgers(temp.path());
        let sessions_db = ledgers.sessions_db();
        {
            let conn = ledgers.sessions();
            conn.execute(
                "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                    project_dir, created_at, last_used_at)
                 VALUES (?1, 'lean-radio', NULL, 0, 'card-1', '/proj', 1, 1)",
                rusqlite::params![line_id],
            )
            .unwrap();
            ledgers.add_session(session, line_id);
        }
        paths.sessions_db = sessions_db.clone();

        create_in(
            &paths,
            repo,
            "card-join",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/card-join");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "card-join", "Add f", None, None).unwrap();

        join_in(
            &paths,
            repo,
            "card-join",
            JoinOptions {
                message: Some("Land it".to_string()),
                session_id: Some(session.to_string()),
                ..mechanics()
            },
        )
        .unwrap();
        let squash = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let squash = String::from_utf8_lossy(&squash.stdout);

        assert!(
            squash.contains("Tug-Session: lean-radio (3c2b1a09)"),
            "the squash cites the session the request named: {squash}"
        );
        assert!(
            squash.contains(&format!("Tug-Session-Id: {session}")),
            "the machine id travels with the citation: {squash}"
        );
        assert!(
            squash.contains("Tug-Arc: tugarc/card-join onto "),
            "and still names the arc: {squash}"
        );
    }

    /// The join's preconditions are what the execution enforces, and nothing
    /// else: a candidate rides along when one stands, the merge either applies
    /// or does not, and no verdict is consulted anywhere.
    ///
    /// This pins the deletion rather than the deleted thing. A stale verdict
    /// left on a live branch by an older build must not resurface as a
    /// refusal, and an arc that was never reconciled must not be stranded — a
    /// gate whose escape hatch also went away would be worse than the gate.
    #[test]
    fn a_join_consults_no_verdict_and_a_stale_one_does_not_block_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(&paths, repo, "unverified", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/unverified");
        fs::write(worktree.join("new.txt"), "clean\n").unwrap();
        commit_in(&paths, repo, "unverified", "r1", None, None).unwrap();

        // The residue an older build would have left: a red verdict, in the
        // branch config, naming this arc. Nothing reads it.
        git(
            repo,
            &[
                "config",
                "--replace-all",
                "branch.tugarc/unverified.tugjoinverified",
                "aaa:bbb:red:unrun",
            ],
        );

        // A preview touches nothing and answers a different question.
        let previewed = join_in(
            &paths,
            repo,
            "unverified",
            JoinOptions {
                preview: true,
                ..Default::default()
            },
        )
        .expect("a preview is not a join");
        assert!(previewed.previewed);
        assert!(previewed.commit_hash.is_none());

        let landed = join_in(&paths, repo, "unverified", JoinOptions::default())
            .expect("a reconcile-clean arc joins with no verdict anywhere");
        assert!(landed.commit_hash.is_some());
        assert!(!worktree.exists(), "the join really ran");
    }

    /// Intersection preflight ([P14]): base dirt blocks a join only when it
    /// touches a file the arc also changed; disjoint base dirt joins fine.
    #[test]
    fn test_arc_join_intersecting_base_dirt_fails_but_disjoint_joins() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        // Two tracked files on base.
        for f in ["shared.txt", "other.txt"] {
            fs::write(repo.join(f), "base\n").unwrap();
        }
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();

        // An arc that changes shared.txt.
        create_in(&paths, repo, "isect", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/isect");
        fs::write(worktree.join("shared.txt"), "base\narc change\n").unwrap();
        commit_in(&paths, repo, "isect", "touch shared", None, None).unwrap();

        // Base dirt on the SAME file the arc changed → refuses, naming it.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let blocked = join_in(&paths, repo, "isect", mechanics());
        assert!(blocked.is_err());
        let err = blocked.unwrap_err().to_string();
        assert!(err.contains("differs from this arc"), "{err}");
        assert!(err.contains("shared.txt"), "{err}");
        assert!(branch_present(repo, "tugarc/isect"));

        // Move the base dirt to a DISJOINT file → the join now succeeds.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        let ok = join_in(&paths, repo, "isect", mechanics()).unwrap();
        assert!(ok.commit_hash.is_some());
        assert!(!branch_present(repo, "tugarc/isect"));
    }

    /// A join that conflicts leaves the base exactly as it found it, so the
    /// record it opened is dropped rather than left open forever. An op that
    /// survived would name a join that did not happen — and once an incomplete
    /// join op *means* a teardown to resume, it would refuse every later join
    /// of this arc with a `--continue` that has nothing to continue.
    #[test]
    fn a_conflicted_join_records_no_op() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "clash");
        let repo = temp.path();

        // The base edits the same file the arc did, so the squash conflicts.
        fs::write(repo.join("shared.txt"), "base\nbase edit\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base touches shared"]).unwrap();

        let out = join_in(&paths, repo, "clash", mechanics()).unwrap();
        assert_eq!(out.conflicts, vec!["shared.txt".to_string()]);
        assert!(out.commit_hash.is_none(), "nothing landed");

        assert!(
            ops_for(&paths, repo, "clash").is_empty(),
            "a join that landed nothing records nothing"
        );
        let root = std::fs::canonicalize(repo).unwrap();
        let err = crate::oplog::undo_in(&paths, &root, Some("clash"))
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("nothing-to-undo:"),
            "and undo says so plainly rather than reporting a phantom: {err}"
        );
    }

    #[test]
    fn preview_reports_off_base_when_the_root_is_on_another_branch() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "offbase");
        let repo = temp.path();

        assert!(preview_in(&paths, repo, "offbase").blockers.is_empty());

        git_output(repo, &["checkout", "-b", "scratch"]).unwrap();
        let out = preview_in(&paths, repo, "offbase");
        let b = blocker(&out, "off-base").expect("off-base blocker");
        assert!(b.detail.contains("Check out"), "{}", b.detail);
        assert!(b.paths.is_empty());
    }

    #[test]
    fn undo_of_a_join_restores_the_base_the_branch_and_its_config() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "undome");
        let repo = temp.path();
        git_output(
            repo,
            &[
                "config",
                "branch.tugarc/undome.description",
                "a description",
            ],
        )
        .unwrap();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/undome"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        let tugid = config_get(repo, &tugid_config_key("undome"));

        join_in(&paths, repo, "undome", mechanics()).unwrap();
        assert_ne!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), base_tip);

        let out = crate::oplog::undo_in(&paths, repo, None).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Join);
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), base_tip);
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugarc/undome"]).unwrap(),
            arc_tip,
            "the branch is back at the tip the join consumed"
        );
        assert!(
            worktree_path(repo, "undome").exists(),
            "and its worktree with it"
        );
        // `branch -D` took the whole config section; the undo puts every fact
        // back, or the restored arc has forgotten what it is.
        assert_eq!(arc_base(repo, "undome").unwrap(), "main");
        assert_eq!(
            config_get(repo, &description_config_key("undome")).as_deref(),
            Some("a description")
        );
        assert_eq!(config_get(repo, &tugid_config_key("undome")), tugid);
        assert!(out.restored_unbound, "rebinding is the user's gesture");
    }

    #[test]
    fn undo_refuses_when_the_base_moved_since_the_join() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "raced");
        let repo = temp.path();
        join_in(&paths, repo, "raced", mechanics()).unwrap();

        // Somebody committed on the base after the join. Resetting now would
        // destroy it, so the undo must decline rather than force.
        fs::write(repo.join("after.txt"), "landed later\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::undo_in(&paths, repo, None)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            tip_now,
            "a refused undo changes nothing"
        );
        assert!(!branch_exists(repo, "tugarc/raced"));
    }

    #[test]
    fn undo_is_offered_once_and_says_so_the_second_time() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "twice");
        let repo = temp.path();
        join_in(&paths, repo, "twice", mechanics()).unwrap();

        crate::oplog::undo_in(&paths, repo, None).unwrap();
        let err = crate::oplog::undo_in(&paths, repo, Some("twice"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("already-undone:"), "{err}");
    }

    #[test]
    fn undo_refuses_an_operation_that_never_finished() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "halfway");
        let repo = temp.path();
        let before = crate::oplog::capture_before(repo, "halfway").unwrap();
        let tips = crate::oplog::tips_of(&before);
        crate::oplog::record_begin(
            &paths,
            repo,
            crate::oplog::OpVerb::Join,
            "halfway",
            before,
            &tips,
        )
        .unwrap();

        let err = crate::oplog::undo_in(&paths, repo, Some("halfway"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("incomplete-op:"), "{err}");
    }

    // ---- redo ----

    /// The full cycle, with the bookkeeping asserted at every stage: a redo
    /// re-applies what the undo took away and hands candidacy back to the
    /// original, so the next `undo` press means the join again rather than
    /// descending into the reversal records.
    #[test]
    fn a_join_undone_is_redone_and_undone_again() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "cycle");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/cycle"]).unwrap();
        let base_before = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        join_in(&paths, repo, "cycle", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let undone = crate::oplog::undo_in(&paths, repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert!(branch_exists(repo, "tugarc/cycle"));

        let redone = crate::oplog::redo_in(&paths, repo, None).unwrap();

        assert_eq!(redone.verb, crate::oplog::OpVerb::Join);
        assert_eq!(redone.original_seq, undone.seq);
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            landed,
            "the base is back at what the join landed"
        );
        assert!(
            !branch_exists(repo, "tugarc/cycle"),
            "and the arc is torn down again"
        );
        assert!(!worktree_path(repo, "cycle").exists());
        assert_eq!(config_get(repo, &base_config_key("cycle")), None);

        // The original is undoable again; the undo is not, because it was
        // redone rather than undone.
        let ops = crate::oplog::list_ops(&paths, repo);
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
        let again = crate::oplog::undo_in(&paths, repo, None).unwrap();
        assert_eq!(again.seq, undone.seq, "the same operation, once more");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugarc/cycle"]).unwrap(),
            arc_tip
        );
    }

    /// [L23]: a redo tears the worktree down, so uncommitted work started in
    /// the arc between the undo and the redo would be destroyed. It refuses
    /// and names the paths instead — and changes nothing on the way out.
    #[test]
    fn redo_refuses_over_a_dirty_restored_worktree() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "dirty");
        let repo = temp.path();
        join_in(&paths, repo, "dirty", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        crate::oplog::undo_in(&paths, repo, None).unwrap();
        let base_after_undo = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        assert_ne!(base_after_undo, landed);

        // The user started working in the arc the undo gave back.
        let worktree = worktree_path(repo, "dirty");
        fs::write(worktree.join("in-progress.txt"), "half a thought\n").unwrap();

        let err = crate::oplog::redo_in(&paths, repo, None)
            .unwrap_err()
            .to_string();

        assert!(err.starts_with("worktree-dirty:"), "{err}");
        assert!(
            err.contains("in-progress.txt"),
            "the paths are named: {err}"
        );
        assert!(
            worktree.join("in-progress.txt").exists(),
            "and the work is still there"
        );
        assert!(branch_exists(repo, "tugarc/dirty"));
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_after_undo,
            "a refused redo moves nothing"
        );
        // The refused redo left no half-written record behind.
        assert!(
            !crate::oplog::list_ops(&paths, repo)
                .iter()
                .any(|o| o.verb == crate::oplog::OpVerb::Redo),
            "the redo record was abandoned, not left incomplete"
        );
    }

    #[test]
    fn redo_refuses_when_the_base_moved_since_the_undo() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "moved");
        let repo = temp.path();
        join_in(&paths, repo, "moved", mechanics()).unwrap();
        crate::oplog::undo_in(&paths, repo, None).unwrap();

        fs::write(repo.join("later.txt"), "landed after the undo\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::redo_in(&paths, repo, None)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), tip_now);
    }

    #[test]
    fn redo_refuses_when_a_newer_operation_ran_on_the_arc() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "busy");
        let repo = temp.path();
        join_in(&paths, repo, "busy", mechanics()).unwrap();
        crate::oplog::undo_in(&paths, repo, None).unwrap();

        // A discard on the restored arc is newer work the redo would trample.
        discard_in(&paths, repo, "busy", None).unwrap();

        let err = crate::oplog::redo_in(&paths, repo, Some("busy"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("superseded:"), "{err}");
    }

    #[test]
    fn redo_with_nothing_to_redo_says_so() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "fresh");
        let repo = temp.path();

        let err = crate::oplog::redo_in(&paths, repo, None)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("nothing-to-redo:"), "{err}");

        // And once an undo has been redone, there is nothing left to redo.
        join_in(&paths, repo, "fresh", mechanics()).unwrap();
        crate::oplog::undo_in(&paths, repo, None).unwrap();
        crate::oplog::redo_in(&paths, repo, None).unwrap();
        let err = crate::oplog::redo_in(&paths, repo, None)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("already-redone:"), "{err}");
    }

    /// The reachability claim redo rests on, made falsifiable: the undo records
    /// itself *before* it acts, so its keepalive parents the join's landed
    /// commit — which is why that commit survives its own undo.
    #[test]
    fn the_landed_commit_survives_its_undo_through_the_undos_own_keepalive() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "reach");
        let repo = temp.path();
        join_in(&paths, repo, "reach", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        crate::oplog::undo_in(&paths, repo, None).unwrap();
        assert_ne!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), landed);

        let alive = git_output(repo, &["cat-file", "-e", &format!("{landed}^{{commit}}")])
            .unwrap()
            .status
            .success();
        assert!(
            alive,
            "no branch points at it, but the undo's keepalive does"
        );

        crate::oplog::redo_in(&paths, repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            landed,
            "so the redo can put it back"
        );
    }

    #[test]
    fn undo_with_nothing_recorded_says_so() {
        let (_temp, root, paths) = repo_for_create();
        let err = crate::oplog::undo_in(&paths, &root, None)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("nothing-to-undo:"), "{err}");
    }

    #[test]
    fn a_join_records_an_operation_that_outlives_the_branch_it_deleted() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "recorded");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/recorded"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let landed = join_in(&paths, repo, "recorded", mechanics()).unwrap();

        let op = crate::oplog::list_ops(&paths, repo)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded an operation");
        assert_eq!(op.arc, "recorded");
        assert_eq!(op.before.arc_tip, arc_tip);
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
            !branch_exists(repo, "tugarc/recorded"),
            "the join tore the branch down"
        );
        assert!(
            git_output(repo, &["cat-file", "-e", &format!("{arc_tip}^{{commit}}")])
                .unwrap()
                .status
                .success(),
            "the pre-join arc head is still reachable"
        );
    }

    #[test]
    fn a_join_records_the_arc_tip_including_the_dirt_it_swept() {
        // The join sweeps outstanding worktree changes into a commit before it
        // integrates. A `before` captured any earlier would name the commit
        // below that sweep, and an undo would faithfully restore an arc missing
        // the swept work.
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "sweeper");
        let repo = temp.path();
        let before_sweep = git_stdout(repo, &["rev-parse", "tugarc/sweeper"]).unwrap();
        let worktree = repo.join(".tug/worktrees/sweeper");
        fs::write(worktree.join("late.txt"), "typed after the round\n").unwrap();

        join_in(&paths, repo, "sweeper", mechanics()).unwrap();

        let op = crate::oplog::list_ops(&paths, repo)
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded an operation");
        assert_ne!(
            op.before.arc_tip, before_sweep,
            "the recorded tip is past the round, because the sweep committed"
        );
        let swept = git_stdout(
            repo,
            &["show", "--name-only", "--format=", &op.before.arc_tip],
        )
        .unwrap();
        assert!(
            swept.contains("late.txt"),
            "the recorded tip is the sweep commit itself: {swept}"
        );
    }

    #[test]
    fn join_outcome_carries_the_message_it_committed() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "msg");
        let repo = temp.path();

        let landed = join_in(
            &paths,
            repo,
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

    /// The precedence a join walks silently, said out loud ([P05], Spec S03).
    #[test]
    fn the_landing_preview_names_where_its_words_came_from() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "prov");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        // Neither a draft nor a description: the generic stand-in, and the
        // preview says so rather than letting it pass as authored.
        let (message, source) = landing_message_preview(&paths, repo, "prov", "tugarc/prov");
        assert_eq!(message, "tugarc(prov): Arc work");
        assert_eq!(source, LandingMessageSource::Fallback);

        git_output(
            repo,
            &[
                "config",
                "branch.tugarc/prov.description",
                "Teach the imposer to breathe",
            ],
        )
        .unwrap();
        let (message, source) = landing_message_preview(&paths, repo, "prov", "tugarc/prov");
        assert_eq!(message, "tugarc(prov): Teach the imposer to breathe");
        assert_eq!(source, LandingMessageSource::Description);

        // An authored draft outranks the description, and wears this arc's
        // scope exactly once even though the draft carried a foreign one.
        seed_draft_row(
            &db,
            &arc_draft_key(repo, "prov").owner_id,
            &canonical(repo),
            "tugarc(elsewhere): The words the author chose",
        );
        let (message, source) = landing_message_preview(&paths, repo, "prov", "tugarc/prov");
        assert_eq!(message, "tugarc(prov): The words the author chose");
        assert_eq!(source, LandingMessageSource::Draft);

        // And the preview is what the join would land, minus the trailers the
        // landing composes against its round set.
        let landed = integrate_message(&paths, repo, "prov", "tugarc/prov", None, None);
        assert!(landed.starts_with(&message), "{landed}");
    }

    #[test]
    fn arc_draft_key_is_the_id_qualified_owner_over_the_base_root() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "keyed");
        let repo = temp.path();

        let key = arc_draft_key(repo, "keyed");
        assert!(
            key.owner_id.starts_with("tugarc/keyed#"),
            "{}",
            key.owner_id
        );
        // The bare branch ref is the legacy axis, and appears exactly because
        // `create` minted a tugid that made the two differ.
        assert_eq!(key.legacy_owner_id.as_deref(), Some("tugarc/keyed"));
        assert_eq!(key.project, repo);

        // An arc without a tugid keys under the bare ref, and there is no
        // second owner shape to fall back to.
        git_output(repo, &["config", "--unset", "branch.tugarc/keyed.tugid"]).unwrap();
        let bare = arc_draft_key(repo, "keyed");
        assert_eq!(bare.owner_id, "tugarc/keyed");
        assert_eq!(bare.legacy_owner_id, None);
    }

    /// The pre-fix row shape: `tugtool draft set` ran from inside the worktree
    /// and keyed by its cwd, so the join's base-root probes never matched it.
    /// The bridge finds it until the next authored write supersedes it.
    #[test]
    fn a_worktree_keyed_row_is_still_found() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "legacy");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &arc_owner_key(repo, "legacy"),
            &canonical(&repo.join(".tug/worktrees/legacy")),
            "the draft nobody could read",
        );
        assert_eq!(
            arc_draft_message(&paths, repo, "tugarc/legacy").as_deref(),
            Some("the draft nobody could read")
        );
    }

    #[test]
    fn the_base_root_row_wins_over_a_worktree_row() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "both");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");
        let owner = arc_owner_key(repo, "both");

        seed_draft_row(
            &db,
            &owner,
            &canonical(&repo.join(".tug/worktrees/both")),
            "the stale worktree row",
        );
        seed_draft_row(&db, &owner, &canonical(repo), "the current row");
        assert_eq!(
            arc_draft_message(&paths, repo, "tugarc/both").as_deref(),
            Some("the current row")
        );
    }

    /// The read side keys on the **gateway** spelling ([L29]) — the same form
    /// the writer stores — so a base root handed in under any other spelling
    /// still finds its arc's authored draft. This is the lands-as lie's path
    /// half: a prompt composed against a spelling that missed the row
    /// announced "no draft was written" while the join landed with one.
    ///
    /// The firmlink divergence that made the two disagree in the field
    /// (`/Users/…` vs the `realpath(3)` form `/System/Volumes/Data/Users/…`)
    /// cannot be constructed in-process — it needs `synthetic.conf` or an APFS
    /// firmlink, both machine state. The gateway's own firmlink behavior is
    /// pinned in `tugcore::pathform`; what this pins is that the lookup routes
    /// through it, so the two sides cannot drift apart again.
    #[test]
    fn a_gateway_keyed_row_is_found_from_another_spelling_of_the_root() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "spelled");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        // Keyed exactly as `apply_draft_request` keys it.
        let gateway = tugcore::pathform::resolve_to_claude_form(repo);
        seed_draft_row(
            &db,
            &arc_owner_key(repo, "spelled"),
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
            arc_draft_message(&paths, &link, "tugarc/spelled").as_deref(),
            Some("the words the author chose")
        );
    }

    /// A body may already open with this arc's scope — a draft authored in the
    /// conventional voice is the common case, and the doubled subject on the
    /// first real join is what the un-idempotent wrap looked like in the
    /// commit log.
    #[test]
    fn integrate_message_does_not_double_this_arcs_own_prefix() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "idem");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();

        let out = integrate_message(
            &paths,
            repo,
            "idem",
            "tugarc/idem",
            Some("tugarc(idem): the authored subject".to_string()),
            None,
        );
        assert!(
            out.starts_with("tugarc(idem): the authored subject"),
            "{out}"
        );
        assert_eq!(out.matches("tugarc(idem): ").count(), 1, "{out}");
    }

    /// A foreign scope is stripped too, and this replaces the contract that
    /// used to preserve it. `tugarc(a): tugarc(b): …` was never a good
    /// subject: the composing side owns the scope, so a body arriving with one
    /// is describing the same work rather than naming a second subject.
    #[test]
    fn integrate_message_strips_a_foreign_scope() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "mine");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();

        let out = integrate_message(
            &paths,
            repo,
            "mine",
            "tugarc/mine",
            Some("tugarc(theirs): borrowed work".to_string()),
            None,
        );
        assert!(out.starts_with("tugarc(mine): borrowed work"), "{out}");
        assert_eq!(out.matches("tugarc(").count(), 1, "{out}");
    }

    /// The strip reads a *leading* scope only. A subject that merely mentions
    /// the spelling later keeps every character of it.
    #[test]
    fn integrate_message_leaves_an_inner_mention_alone() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "inner");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();

        let body = "teach the linter about tugarc(name): prefixes";
        let out = integrate_message(
            &paths,
            repo,
            "inner",
            "tugarc/inner",
            Some(body.to_string()),
            None,
        );
        assert!(out.starts_with(&format!("tugarc(inner): {body}")), "{out}");
    }

    /// A body that opens with the spelling but is not a scope — no closing
    /// paren, or no `: ` after it — is left whole rather than half-eaten.
    #[test]
    fn integrate_message_leaves_a_malformed_scope_whole() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "malformed");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();

        for body in ["tugarc(unclosed work", "tugarc(x) no colon"] {
            let out = integrate_message(
                &paths,
                repo,
                "malformed",
                "tugarc/malformed",
                Some(body.to_string()),
                None,
            );
            assert!(
                out.starts_with(&format!("tugarc(malformed): {body}")),
                "{out}"
            );
        }
    }

    #[test]
    fn integrate_message_wraps_an_unprefixed_body_and_the_bare_fallback() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "plain");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();

        let out = integrate_message(
            &paths,
            repo,
            "plain",
            "tugarc/plain",
            Some("a plain subject".to_string()),
            None,
        );
        assert!(out.starts_with("tugarc(plain): a plain subject"), "{out}");

        // No override, no draft row (the ledger is an empty tempdir path), and
        // no branch description — the bare fallback, still wrapped once.
        let fallback = integrate_message(&paths, repo, "plain", "tugarc/plain", None, None);
        assert!(
            fallback.starts_with("tugarc(plain): Arc work"),
            "{fallback}"
        );
    }

    /// The contract the whole draft feature exists to honor, at the layer that
    /// lands it: when a maintained draft exists and no override is given, the
    /// squash commit's message is the authored draft, prefixed once, plus
    /// exactly the trailers — nothing added, reordered, or regenerated. The
    /// first real arc join is what this looks like broken, and a string
    /// equality is what makes any future writer or reader drift fail loudly
    /// instead of committing someone else's words.
    #[test]
    fn the_join_commits_the_authored_draft_byte_for_byte() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "pinned");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        let draft = "the subject the author wrote\n\nA body paragraph that must survive intact,\nincluding its own line breaks.";
        seed_draft_row(&db, &arc_owner_key(repo, "pinned"), &canonical(repo), draft);

        let landed = join_in(&paths, repo, "pinned", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        let expected = with_arc_trailers(
            &paths,
            repo,
            "pinned",
            "tugarc/pinned",
            &format!("tugarc(pinned): {draft}"),
            None,
        );
        assert_eq!(committed, expected);
        assert!(committed.starts_with("tugarc(pinned): the subject the author wrote\n"));
    }

    /// A draft authored in the conventional voice — which is how a skill writes
    /// one — lands with the subject scoped exactly once.
    #[test]
    fn a_draft_that_already_carries_the_prefix_lands_it_once() {
        let temp = TempDir::new().unwrap();
        let mut paths = seed_arc_with_a_round(&temp, "once");
        isolate_changes_db(&mut paths, &temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &arc_owner_key(repo, "once"),
            &canonical(repo),
            "tugarc(once): the authored subject",
        );

        let landed = join_in(&paths, repo, "once", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        assert!(
            committed.starts_with("tugarc(once): the authored subject\n"),
            "{committed}"
        );
        assert_eq!(
            committed.matches("tugarc(once): ").count(),
            1,
            "{committed}"
        );
    }

    #[test]
    fn preflight_asked_from_a_linked_worktree_answers_about_the_main_root() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "linked");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/linked");

        // The arc's own worktree is checked out on `tugarc/linked`, which is
        // not the base. Asking from there must still answer about the
        // repository — a card whose project *is* a worktree would otherwise
        // read every arc as off-base while the CLI beside it reports clean.
        let from_worktree = join_preflight_in(&paths, &worktree, "linked").unwrap();
        assert!(from_worktree.is_empty(), "{from_worktree:?}");
        assert!(
            join_preflight_in(&paths, repo, "linked")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn preview_reports_intersecting_base_dirt_and_names_the_paths() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "dirt");
        let repo = temp.path();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "second"]).unwrap();

        // Dirt on a file the arc also changed → blocked, and named.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let out = preview_in(&paths, repo, "dirt");
        let b = blocker(&out, "base-dirt").expect("base-dirt blocker");
        assert_eq!(b.paths, vec!["shared.txt".to_string()]);
        assert!(b.detail.contains("shared.txt"), "{}", b.detail);

        // Disjoint dirt → no blocker.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        assert!(blocker(&preview_in(&paths, repo, "dirt"), "base-dirt").is_none());
    }

    /// A conflict names a file; the archaeology names what the base did to it.
    /// Only the base commits that touched the conflicted path may appear, and
    /// they appear newest first — a list including the untouching commit would
    /// be worse than none, since the reader would be reading the wrong history.
    #[test]
    fn a_conflicted_preview_names_the_base_commits_behind_each_path() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "digs");
        let repo = temp.path();

        // Two base commits touch the file the arc also changed, and one does
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

        let out = preview_in(&paths, repo, "digs");
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
    #[test]
    fn a_long_base_history_is_capped_but_still_counted() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "deep");
        let repo = temp.path();

        for n in 0..(ARCHAEOLOGY_CAP + 3) {
            fs::write(repo.join("shared.txt"), format!("base\nedit {n}\n")).unwrap();
            git_output(repo, &["add", "."]).unwrap();
            git_output(repo, &["commit", "-m", &format!("base edit {n}")]).unwrap();
        }

        let history = &preview_in(&paths, repo, "deep").archaeology[0];
        assert_eq!(history.commits.len(), ARCHAEOLOGY_CAP);
        assert_eq!(history.total, (ARCHAEOLOGY_CAP + 3) as u32);
        assert_eq!(
            history.commits[0].subject,
            format!("base edit {}", ARCHAEOLOGY_CAP + 2),
            "the cap keeps the newest, not the oldest"
        );
    }

    /// Pins the ordering: the preview arm sits above the stale-journal guard,
    /// so an arc mid-teardown previews with a blocker instead of erroring.
    #[test]
    fn preview_reports_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "journalled");
        let repo = temp.path();

        // The record's state dir is slugged from the repo's *canonical* path,
        // which on macOS is `/private/var/…` where a TempDir reads `/var/…`.
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(
            &paths,
            repo,
            "journalled",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );

        let out = preview_in(&paths, repo, "journalled");
        let b = blocker(&out, "stale-journal").expect("stale-journal blocker");
        assert!(b.detail.contains("--continue"), "{}", b.detail);
        assert!(
            !b.detail.contains("tugarc join"),
            "the detail must name the real verb: {}",
            b.detail
        );
    }

    /// A join in flight opens the record itself, so an open record alone cannot
    /// mean "a previous join is incomplete" — for the whole squash-to-record
    /// window it means the opposite. The holder is what tells the two apart,
    /// and the blocked sentence is false in every clause while a join runs.
    #[test]
    fn a_live_join_is_not_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "inflight");
        let repo = temp.path();

        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(
            &paths,
            repo,
            "inflight",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );

        let detail = arc_detail_entry_in(&paths, repo, "inflight").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        let unheld =
            join_blockers_from_detail(&paths, repo, &detail, &current, None, &BTreeMap::new());
        assert!(
            unheld.iter().any(|b| b.kind == "stale-journal"),
            "a teardown nobody holds is stale and must refuse: {:?}",
            unheld.iter().map(|b| &b.kind).collect::<Vec<_>>()
        );

        let held = join_blockers_from_detail(
            &paths,
            repo,
            &detail,
            &current,
            Some("join"),
            &BTreeMap::new(),
        );
        assert!(
            !held.iter().any(|b| b.kind == "stale-journal"),
            "a join holding the arc opened that record: {:?}",
            held.iter().map(|b| &b.kind).collect::<Vec<_>>()
        );

        // A *resolve* holder does not excuse it: it would be running over a
        // crashed join's leavings, and the refusal is still right.
        let resolving = join_blockers_from_detail(
            &paths,
            repo,
            &detail,
            &current,
            Some("resolve"),
            &BTreeMap::new(),
        );
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

    #[test]
    fn preview_reports_empty_for_a_arc_with_no_rounds() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create_in(&paths, repo, "hollow", None, false, None).unwrap();

        assert!(blocker(&preview_in(&paths, repo, "hollow"), "empty").is_some());

        let worktree = repo.join(".tug/worktrees/hollow");
        fs::write(worktree.join("shared.txt"), "base\nround\n").unwrap();
        commit_in(&paths, repo, "hollow", "a round", None, None).unwrap();
        assert!(blocker(&preview_in(&paths, repo, "hollow"), "empty").is_none());
    }

    #[test]
    fn a_clean_arc_previews_with_no_blockers() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "clean");
        let out = preview_in(&paths, temp.path(), "clean");
        assert!(out.previewed);
        assert!(out.conflicts.is_empty());
        assert!(out.blockers.is_empty(), "{:?}", out.blockers);
    }

    /// Every blocker's `detail` is the sentence the execute path refuses with,
    /// so the preview and the land read identically ([P02]).
    #[test]
    fn preflight_and_the_execute_path_agree() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "agree");
        let repo = temp.path();

        let assert_agrees = |kind: &str| {
            let out = preview_in(&paths, repo, "agree");
            let b = blocker(&out, kind).unwrap_or_else(|| panic!("expected a {kind} blocker"));
            let err = join_in(&paths, repo, "agree", mechanics())
                .unwrap_err()
                .to_string();
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
        let seq = seed_interrupted_join(
            &paths,
            repo,
            "agree",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );
        assert_agrees("stale-journal");
        crate::oplog::abandon(&paths, &root, seq);

        // empty — an arc of its own, since the one above has a round.
        create_in(&paths, &root, "agree2", None, false, None).unwrap();
        let out = preview_in(&paths, &root, "agree2");
        let b = blocker(&out, "empty").expect("empty blocker");
        let err = join_in(&paths, &root, "agree2", mechanics())
            .unwrap_err()
            .to_string();
        assert_eq!(err, b.detail);
    }

    #[test]
    fn test_arc_join_wrong_branch_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        git(repo, &["checkout", "-b", "feature"]);

        let result = join_in(&paths, repo, "test-arc", mechanics());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("on branch 'feature'"));
        assert!(err.contains("Check out 'main' first"));
        assert_eq!(checked_out_branch(repo), "feature");
    }

    #[test]
    fn test_arc_join_already_gone_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();
        commit_in(&paths, repo, "test-arc", "Add test", None, None).unwrap();
        join_in(&paths, repo, "test-arc", mechanics()).unwrap();

        // Joining again fails: the branch no longer exists.
        let result = join_in(&paths, repo, "test-arc", mechanics());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    /// **Either scope is stripped, and only at position 0.**
    ///
    /// The retired spelling is a read for life: a draft an older engine wrote
    /// already wears it, and the wrap has to be idempotent over what is on
    /// disk rather than over what this build would have written.
    #[test]
    fn test_strip_arc_scope_strips_either_scope_at_position_zero() {
        assert_eq!(strip_arc_scope("tugarc(x): the subject"), "the subject");
        assert_eq!(strip_arc_scope("tugdash(x): the subject"), "the subject");

        for body in [
            "a subject mentioning tugarc(x): later on",
            "a subject mentioning tugdash(x): later on",
            "tugarc(unclosed the subject",
            "tugdash(x) no colon",
            "fix(x): another convention entirely",
            "a plain subject",
        ] {
            assert_eq!(strip_arc_scope(body), body, "left alone: {body}");
        }
    }

    // --- the join's plan sweep ---------------------------------------------

    #[test]
    fn test_join_merge_strategy_makes_a_merge_commit() {
        let (_temp, repo, paths) = repo_with_committed_arc("mrg");
        let out = join_in(
            &paths,
            &repo,
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

    #[test]
    fn test_join_rebase_strategy_is_linear() {
        let (_temp, repo, paths) = repo_with_committed_arc("rb");
        join_in(
            &paths,
            &repo,
            "rb",
            JoinOptions {
                strategy: JoinStrategy::Rebase,
                ..mechanics()
            },
        )
        .unwrap();
        // Base fast-forwarded to the arc commit — linear, message preserved.
        let subject = git_stdout(&repo, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, "rb-only");
        let parents = git_stdout(&repo, &["rev-list", "--parents", "-1", "HEAD"]).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            2,
            "single parent = linear history: {parents}"
        );
    }

    #[test]
    fn test_join_preview_reports_conflicts_without_touching_tree() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        // A tracked file both sides will edit on the same line.
        fs::write(repo.join("conflict.txt"), "line1\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();

        create_in(&paths, repo, "pv", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/pv");
        fs::write(worktree.join("conflict.txt"), "arc line\n").unwrap();
        commit_in(&paths, repo, "pv", "arc edit", None, None).unwrap();

        // Base advances with a conflicting edit to the same line.
        fs::write(repo.join("conflict.txt"), "base line\n").unwrap();
        git_output(repo, &["commit", "-am", "base edit"]).unwrap();
        let base_head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        let preview = join_in(
            &paths,
            repo,
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
        assert!(branch_present(repo, "tugarc/pv"));
        assert!(worktree.exists());
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), base_head);
    }

    #[test]
    fn test_join_continue_resumes_teardown() {
        // Simulate a crash right after the integrate commit: an open join
        // record at phase `Integrated` with the worktree + branch still
        // present. `--continue` must finish the teardown (remove worktree,
        // delete branch, arc log).
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(&paths, repo, "resume", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/resume");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "resume", "add f", None, None).unwrap();

        // Do the integrate by hand, then record it as if we crashed next.
        git_output(repo, &["merge", "--squash", "tugarc/resume"]).unwrap();
        git_output(repo, &["commit", "-m", "tugarc(resume): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        // `join` resolves the repo via `find_repo_root` (canonical), so the
        // record must be written to the canonical state dir to be found.
        let canon = fs::canonicalize(repo).unwrap();
        let seq = seed_interrupted_join(
            &paths,
            repo,
            "resume",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );
        assert!(worktree.exists());
        assert!(branch_present(repo, "tugarc/resume"));

        // A plain join now refuses (a join is in flight); --continue resumes.
        assert!(join_in(&paths, repo, "resume", mechanics()).is_err());
        let out = join_in(
            &paths,
            repo,
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
            !branch_present(repo, "tugarc/resume"),
            "branch deleted on continue"
        );
        assert!(
            crate::oplog::join_in_flight(&paths, &canon, "resume").is_none(),
            "the record is complete, so nothing is in flight"
        );
        let op = crate::oplog::read_op(&paths, &canon, seq).expect("the record is still there");
        assert!(
            op.after.is_some(),
            "and it completed rather than being dropped"
        );
        assert_eq!(
            op.join.unwrap().phase,
            crate::oplog::JoinPhase::BranchDeleted,
            "the finished record still says how far the teardown got"
        );
        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"), "arc log records the join: {dlog}");
    }

    /// The resumability guarantee, one phase at a time: entering the teardown
    /// at any of its three states finishes the join and finishes it once.
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
            let paths = redirect_state_dir(&home);

            create_in(&paths, repo, "phased", None, false, None).unwrap();
            let worktree = repo.join(".tug/worktrees/phased");
            fs::write(worktree.join("f.txt"), "x\n").unwrap();
            commit_in(&paths, repo, "phased", "add f", None, None).unwrap();

            // The integrate by hand, then the git state each phase implies —
            // the record says what has already happened, so the tree must
            // agree with it or the test would be resuming a fiction.
            git_output(repo, &["merge", "--squash", "tugarc/phased"]).unwrap();
            git_output(repo, &["commit", "-m", "tugarc(phased): add f"]).unwrap();
            let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
            let seq = seed_interrupted_join(&paths, repo, "phased", phase, &head);
            let canon = fs::canonicalize(repo).unwrap();
            if phase != crate::oplog::JoinPhase::Integrated {
                let mut warnings = Vec::new();
                remove_arc_worktree(&paths, repo, "tugarc/phased", &worktree, &mut warnings);
            }
            if phase == crate::oplog::JoinPhase::BranchDeleted {
                git_output(repo, &["branch", "-D", "tugarc/phased"]).unwrap();
            }

            let out = join_in(
                &paths,
                repo,
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
                !branch_present(repo, "tugarc/phased"),
                "{phase:?}: branch gone"
            );
            let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
            assert!(dlog.contains("joined"), "{phase:?}: arc log records it");
            let op = crate::oplog::read_op(&paths, &canon, seq).expect("the record");
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
    /// is refused by name rather than re-running a teardown over an arc that no
    /// longer exists.
    #[test]
    fn continue_twice_is_a_named_refusal() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "twice");

        join_in(&paths, temp.path(), "twice", mechanics()).unwrap();
        let err = join_in(
            &paths,
            temp.path(),
            "twice",
            JoinOptions {
                continue_join: true,
                ..mechanics()
            },
        )
        .unwrap_err()
        .to_string();
        assert_eq!(err, "No interrupted join to continue for arc 'twice'.");
    }

    /// The record the journal never was: after a clean join, how the teardown
    /// went is still readable beside what it landed.
    #[test]
    fn a_finished_join_keeps_its_progress_on_the_record() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "receipt");
        let repo = temp.path();
        let canon = fs::canonicalize(repo).unwrap();

        let out = join_in(&paths, repo, "receipt", mechanics()).unwrap();
        let op = crate::oplog::list_ops(&paths, &canon)
            .into_iter()
            .find(|op| op.arc == "receipt" && op.verb == crate::oplog::OpVerb::Join)
            .expect("the join recorded itself");
        assert!(op.after.is_some(), "and completed");
        let progress = op.join.expect("with its progress still on it");
        assert_eq!(progress.phase, crate::oplog::JoinPhase::BranchDeleted);
        assert_eq!(Some(progress.commit_hash), out.commit_hash);
        assert_eq!(progress.strategy, "squash");
        assert!(
            crate::oplog::join_in_flight(&paths, &canon, "receipt").is_none(),
            "a completed record is not a teardown to resume"
        );
    }

    /// Undo's refusal is a property of the payload, and the fold leaves it
    /// exactly where it was: an operation mid-teardown has no `after`, so it is
    /// refused by name until `--continue` gives it one.
    #[test]
    fn undo_refuses_a_join_mid_teardown_then_reverses_it_once_continued() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(&paths, repo, "halfway", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/halfway");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "halfway", "add f", None, None).unwrap();

        git_output(repo, &["merge", "--squash", "tugarc/halfway"]).unwrap();
        git_output(repo, &["commit", "-m", "tugarc(halfway): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(
            &paths,
            repo,
            "halfway",
            crate::oplog::JoinPhase::Integrated,
            &head,
        );
        let canon = fs::canonicalize(repo).unwrap();

        let err = crate::oplog::undo_in(&paths, &canon, Some("halfway"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("incomplete-op:"), "got {err}");

        join_in(
            &paths,
            repo,
            "halfway",
            JoinOptions {
                continue_join: true,
                ..mechanics()
            },
        )
        .unwrap();
        let undone =
            crate::oplog::undo_in(&paths, &canon, Some("halfway")).expect("now it reverses");
        assert_eq!(undone.verb, crate::oplog::OpVerb::Join);
        assert!(branch_present(repo, "tugarc/halfway"), "the arc is back");
    }

    /// Every blocker kind, asserted identical between the composed path the
    /// card uses and the preflight the CLI uses — the anti-drift pin. Two
    /// definitions of "what refuses a join" is how the card and the terminal
    /// came to disagree in the first place.
    #[test]
    fn composed_blockers_match_the_preflight_for_every_kind() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "kinds");
        let repo = temp.path();

        let composed = || {
            let detail = arc_detail_entry_in(&paths, repo, "kinds").expect("detail");
            let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
            join_blockers_from_detail(&paths, repo, &detail, &current, None, &BTreeMap::new())
        };
        let same = |label: &str| {
            let a = composed();
            let b = join_preflight_in(&paths, repo, "kinds").unwrap();
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

        // base-dirt, untracked: the arc must also change that path, so it is
        // the untracked *overwrite* case rather than unrelated base dirt.
        let worktree = repo.join(".tug/worktrees/kinds");
        fs::write(worktree.join("fresh.txt"), "from the arc\n").unwrap();
        commit_in(&paths, repo, "kinds", "add fresh", None, None).unwrap();
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
            &paths,
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
        crate::oplog::abandon(&paths, &fs::canonicalize(repo).unwrap(), seq);

        // empty: an arc with no rounds and no tracked worktree dirt.
        create_in(&paths, repo, "hollow", None, false, None).unwrap();
        let hollow_detail = arc_detail_entry_in(&paths, repo, "hollow").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(
            join_blockers_from_detail(
                &paths,
                repo,
                &hollow_detail,
                &current,
                None,
                &BTreeMap::new()
            )
            .iter()
            .map(|b| &b.kind)
            .collect::<Vec<_>>(),
            join_preflight_in(&paths, repo, "hollow")
                .unwrap()
                .iter()
                .map(|b| &b.kind)
                .collect::<Vec<_>>(),
        );
        assert!(
            join_preflight_in(&paths, repo, "hollow")
                .unwrap()
                .iter()
                .any(|b| b.kind == "empty")
        );
    }

    /// Blockers answer to working-tree state, which moves without either head
    /// moving. This is the exact defect a `(base_sha, arc_head_sha)` cache
    /// would hide: both SHAs are unchanged across the whole test, and the right
    /// answer changes twice.
    #[test]
    fn blockers_track_dirt_that_moves_no_sha() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "nosha");
        let repo = temp.path();

        let heads = || {
            (
                git_stdout(repo, &["rev-parse", "main"]).unwrap(),
                git_stdout(repo, &["rev-parse", "tugarc/nosha"]).unwrap(),
            )
        };
        let before = heads();
        assert!(join_preflight_in(&paths, repo, "nosha").unwrap().is_empty());

        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let dirty = join_preflight_in(&paths, repo, "nosha").unwrap();
        assert!(
            dirty.iter().any(|b| b.kind == "base-dirt"),
            "dirt on an overlapping path blocks"
        );
        assert_eq!(before, heads(), "no SHA moved");

        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        assert!(
            join_preflight_in(&paths, repo, "nosha").unwrap().is_empty(),
            "cleaning the checkout clears the blocker"
        );
        assert_eq!(before, heads(), "still no SHA moved");
    }

    /// The overlap says **what** the base's uncommitted bytes are, not only
    /// that they are there. A base copy holding exactly what the arc carries
    /// is `identical`, and everything downstream turns on that being read from
    /// the objects rather than assumed from the fact of the dirt.
    #[test]
    fn an_overlap_says_whether_the_base_copy_is_the_arcs_own_bytes() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "relation");
        let repo = temp.path();

        // The base's copy IS the arc's version, to the byte — the shape a
        // note written on main from the arc's own work leaves behind.
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        let detail = arc_detail_entry_in(&paths, repo, "relation").expect("detail");
        assert_eq!(overlap_paths(&detail.base_overlap), vec!["shared.txt"]);
        assert_eq!(
            detail.base_overlap[0].relation, OVERLAP_IDENTICAL,
            "the same bytes the arc carries"
        );

        // A byte apart is other work, and the reading says so.
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let detail = arc_detail_entry_in(&paths, repo, "relation").expect("detail");
        assert_eq!(detail.base_overlap[0].relation, OVERLAP_DIVERGENT);

        // And it rides the blocker, which is where every surface reads it.
        let blockers = join_preflight_in(&paths, repo, "relation").unwrap();
        let dirt = blockers
            .iter()
            .find(|b| b.kind == "base-dirt")
            .expect("base-dirt");
        assert_eq!(dirt.overlap[0].path, "shared.txt");
        assert_eq!(dirt.overlap[0].relation, OVERLAP_DIVERGENT);
    }

    /// A base copy the arc already carries is not a refusal — it is the
    /// arc's own edit sitting on the base, and the join drops it and lands
    /// the same bytes. The blocker never appears, the join runs, and what was
    /// dropped is reported rather than done quietly.
    #[test]
    fn an_identical_base_copy_does_not_block_the_join() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "echo");
        let repo = temp.path();

        // Main holds, uncommitted, exactly what the arc committed.
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        assert!(
            join_preflight_in(&paths, repo, "echo")
                .unwrap()
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the arc's own bytes on the base refuse nothing"
        );

        let outcome =
            join_in(&paths, repo, "echo", mechanics()).expect("the join runs over its own echo");
        assert!(outcome.commit_hash.is_some(), "it landed");
        assert!(
            outcome.warnings.iter().any(|w| w.contains("shared.txt")),
            "the drop is reported: {:?}",
            outcome.warnings
        );
        // The bytes are on the base, and the checkout is clean.
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\narc change\n"
        );
        assert!(
            dirty_tracked_paths(repo).is_empty(),
            "nothing left uncommitted"
        );
    }

    /// The other half of the same rule: a base copy that is somebody's *work*
    /// still refuses, and refuses having touched nothing.
    #[test]
    fn a_divergent_base_copy_still_blocks_and_moves_nothing() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "otherwork");
        let repo = temp.path();

        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let err = join_in(&paths, repo, "otherwork", mechanics())
            .unwrap_err()
            .to_string();
        assert!(err.contains("shared.txt"), "{err}");
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nsomebody else\n",
            "a refusal touches nothing"
        );
    }

    /// A divergent overlap another live session holds still blocks, and the
    /// blocker names whose hand is on it — with a remedy as pressable as the
    /// user's own, because the fold preserves the work it commits.
    #[test]
    fn a_foreign_hand_on_the_overlap_names_its_holder() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "contended");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();

        let detail = arc_detail_entry_in(&paths, repo, "contended").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        // With no attribution view — a person at a terminal — it reads as the
        // user's own, which is the right default for their own checkout.
        let mine =
            join_blockers_from_detail(&paths, repo, &detail, &current, None, &BTreeMap::new());
        let dirt = mine.iter().find(|b| b.kind == "base-dirt").expect("dirt");
        assert!(dirt.detail.contains("your uncommitted edit"), "{dirt:?}");
        assert!(dirt.overlap[0].holder.is_none());
        // And the act's own sentence is the fact sheet ([P10]): the count, the
        // base it lands on, the subject the commit will carry, that nothing on
        // disk moves, and that the way back is on this same surface.
        let remedy = dirt.remedy.as_ref().expect("their own work has an act");
        for fact in [
            "this 1 file",
            "— yours —",
            "onto main",
            "“Commit base work in progress to unblock the join of contended”",
            "Nothing changes on disk",
            "Undo here",
        ] {
            assert!(
                remedy.explain.contains(fact),
                "the sentence is missing {fact:?}: {remedy:?}"
            );
        }

        // With one, the sentence names the hand that is on it.
        let held = BTreeMap::from([("shared.txt".to_string(), "^ink-anchor".to_string())]);
        let theirs = join_blockers_from_detail(&paths, repo, &detail, &current, None, &held);
        let dirt = theirs.iter().find(|b| b.kind == "base-dirt").expect("dirt");
        assert!(dirt.detail.contains("^ink-anchor holds"), "{dirt:?}");
        assert_eq!(dirt.overlap[0].holder.as_deref(), Some("^ink-anchor"));
        let remedy = dirt
            .remedy
            .as_ref()
            .expect("a foreign hand still has an act");
        assert!(
            remedy.explain.contains("^ink-anchor's work in progress"),
            "the act says whose work it folds: {remedy:?}"
        );
        for fact in [
            "this 1 file",
            "onto main",
            "“Commit base work in progress to unblock the join of contended”",
            "Nothing changes on disk",
            "their session is told",
            "Undo here",
        ] {
            assert!(
                remedy.explain.contains(fact),
                "the sentence is missing {fact:?}: {remedy:?}"
            );
        }

        // And an identical copy is still nobody's problem, held or not.
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        let detail = arc_detail_entry_in(&paths, repo, "contended").expect("detail");
        assert!(
            join_blockers_from_detail(&paths, repo, &detail, &current, None, &held)
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the arc's own bytes refuse nothing, whoever last wrote them"
        );
    }

    /// One file is a file. The count is the first thing the sentence says, so
    /// getting it wrong is the first thing a reader sees — and a fact sheet
    /// that cannot count is not one.
    #[test]
    fn the_remedy_counts_one_file_in_the_singular() {
        assert!(
            remedy_explain("a", "main", 1, None).contains("this 1 file —"),
            "{}",
            remedy_explain("a", "main", 1, None)
        );
        assert!(
            remedy_explain("a", "main", 5, None).contains("these 5 files —"),
            "{}",
            remedy_explain("a", "main", 5, None)
        );
        assert!(
            remedy_explain("a", "main", 1, Some("^ink")).contains("this 1 file —"),
            "{}",
            remedy_explain("a", "main", 1, Some("^ink"))
        );
    }

    /// The fold: a divergent base edit of the user's own becomes one commit on
    /// the base, and the join is no longer blocked. From that commit forward
    /// the two sides are ordinary history, which is what puts a collision in
    /// front of the resolution ladder instead of in front of the user.
    #[test]
    fn resolve_base_folds_the_users_own_edit_onto_the_base() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "fold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nmy own edit\n").unwrap();

        assert!(
            join_preflight_in(&paths, repo, "fold")
                .unwrap()
                .iter()
                .any(|b| b.kind == "base-dirt"),
            "blocked to begin with"
        );

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let outcome = resolve_base_in(&paths, repo, "fold", &BTreeMap::new()).expect("resolves");
        assert_eq!(outcome.folded, vec!["shared.txt"]);
        assert!(outcome.committed.is_some(), "it made a commit of its own");
        assert!(outcome.dropped.is_empty());

        // The block is gone and the checkout is clean.
        assert!(
            join_preflight_in(&paths, repo, "fold")
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

        // The op records what it folded, which is what makes the receipt
        // durable: every surface that reports the act reads it back from here
        // rather than from the frame that announced it.
        let recorded = crate::oplog::list_ops(&paths, repo)
            .into_iter()
            .find(|op| op.verb == crate::oplog::OpVerb::ResolveBase)
            .expect("the fold recorded an op");
        let after = recorded.after.expect("it completed");
        assert_eq!(after.folded, vec!["shared.txt".to_string()]);
        assert!(after.dropped.is_empty());
        assert!(after.folded_from.is_empty(), "nobody else held it");

        // Undo puts it back the way they had it: same content, uncommitted.
        crate::oplog::undo_in(&paths, repo, Some("fold")).expect("undo");
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

    /// A resolve folds another session's work with the rest — committing it
    /// preserves it — and both the commit's message and the outcome say whose
    /// it was, so the holder can be told.
    #[test]
    fn resolve_base_folds_another_sessions_edit_and_names_it() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "notmine");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let held = BTreeMap::from([("shared.txt".to_string(), "^ink-anchor".to_string())]);

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let outcome = resolve_base_in(&paths, repo, "notmine", &held).expect("folds");
        assert_eq!(outcome.folded, vec!["shared.txt"]);
        assert_eq!(
            outcome.folded_from.get("shared.txt").map(String::as_str),
            Some("^ink-anchor"),
            "the outcome names the holder"
        );
        assert_ne!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            before_tip,
            "the fold made a commit"
        );
        let message = git_stdout(repo, &["log", "-1", "--format=%B"]).unwrap();
        assert!(
            message.contains("shared.txt — work in progress from ^ink-anchor"),
            "the commit attributes the work: {message}"
        );
        // Preserved, not taken: same bytes on disk, now committed.
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nsomebody else\n"
        );
        assert!(dirty_tracked_paths(repo).is_empty());
    }

    /// An overlap that is all the arc's own bytes needs no commit — dropping
    /// is the whole of the job, and the outcome says so rather than inventing
    /// a commit to report.
    #[test]
    fn resolve_base_drops_an_echo_without_committing() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "echofold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();

        let outcome =
            resolve_base_in(&paths, repo, "echofold", &BTreeMap::new()).expect("resolves");
        assert_eq!(outcome.dropped, vec!["shared.txt"]);
        assert!(outcome.folded.is_empty());
        assert!(outcome.committed.is_none(), "nothing to commit");
        assert!(dirty_tracked_paths(repo).is_empty());
    }

    /// A landing that loses the base's index lock to a writer about to finish
    /// retries and lands.
    #[test]
    fn a_join_whose_landing_loses_the_lock_retries_and_lands() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "contendedbase");
        let repo = temp.path();

        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * 3);
        let outcome =
            join_in(&paths, repo, "contendedbase", mechanics()).expect("lands past the lock");
        held.join().unwrap();
        assert!(outcome.commit_hash.is_some());
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\narc change\n"
        );
    }

    /// A lock held past the window fails the join with nothing moved: HEAD,
    /// the index, the worktree — the user's disjoint uncommitted edit with
    /// them — and no `SQUASH_MSG`, because nothing was ever staged. The same
    /// join then lands once the lock is gone, over that same edit.
    #[test]
    fn a_lock_held_past_the_window_leaves_the_base_untouched() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "lockedbase");
        let repo = temp.path();
        fs::write(repo.join("notes.txt"), "committed\n").unwrap();
        git_output(repo, &["add", "notes.txt"]).unwrap();
        git_output(repo, &["commit", "-m", "notes"]).unwrap();
        fs::write(repo.join("notes.txt"), "the user's own edit\n").unwrap();

        let files = ["shared.txt", "notes.txt"];
        let before = base_snapshot(repo, &files);
        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * (INDEX_LOCK_ATTEMPTS * 2));
        let err = join_in(&paths, repo, "lockedbase", mechanics())
            .unwrap_err()
            .to_string();
        let after = base_snapshot(repo, &files);
        held.join().unwrap();

        assert!(err.contains("index.lock"), "git's own message: {err}");
        assert_eq!(before, after, "the base is byte-identical");
        assert!(!after.4, "no SQUASH_MSG");
        assert!(
            ops_for(&paths, repo, "lockedbase").is_empty(),
            "and nothing is recorded"
        );

        let outcome =
            join_in(&paths, repo, "lockedbase", mechanics()).expect("lands once the lock is gone");
        assert!(outcome.commit_hash.is_some());
        assert_eq!(
            fs::read_to_string(repo.join("notes.txt")).unwrap(),
            "the user's own edit\n",
            "disjoint dirt rides through the landing"
        );
    }

    /// A rebase's fast-forward that loses the base's index lock is not a base
    /// that moved. Read as one it falls through to the cherry-pick, and the
    /// arc arrives on the base as fresh commits rather than its own — the
    /// join's shape decided by a race. So it waits the lock out instead.
    #[test]
    fn a_rebase_whose_fast_forward_loses_the_lock_still_fast_forwards() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "lockedff");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", &branch_name("lockedff")]).unwrap();

        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * 3);
        let outcome = join_in(
            &paths,
            repo,
            "lockedff",
            JoinOptions {
                strategy: JoinStrategy::Rebase,
                ..mechanics()
            },
        )
        .expect("lands past the lock");
        held.join().unwrap();

        assert_eq!(
            outcome.commit_hash.as_deref(),
            Some(arc_tip.as_str()),
            "the arc's own commit, fast-forwarded rather than picked afresh"
        );
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), arc_tip);
    }

    /// A commit built off the base has the shape the staged one had: the arc's
    /// tree, the composed message as `git commit` would have cleaned it, one
    /// parent for a squash and the arc's tip as the second for a merge.
    #[test]
    fn squash_and_merge_land_the_same_tree_and_message_shape() {
        for (name, strategy, parent_count) in [
            ("shapesquash", JoinStrategy::Squash, 1),
            ("shapemerge", JoinStrategy::Merge, 2),
        ] {
            let temp = TempDir::new().unwrap();
            let paths = seed_arc_with_a_round(&temp, name);
            let repo = temp.path();
            let branch = branch_name(name);
            let base_head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
            let arc_tip = git_stdout(repo, &["rev-parse", &branch]).unwrap();
            let arc_tree = git_stdout(repo, &["rev-parse", &format!("{branch}^{{tree}}")]).unwrap();

            join_in(
                &paths,
                repo,
                name,
                JoinOptions {
                    strategy,
                    message: Some("Land the change  \n\n\n\nThe body.\n\n\n".to_string()),
                    ..mechanics()
                },
            )
            .expect("lands");

            assert_eq!(
                git_stdout(repo, &["rev-parse", "HEAD^{tree}"]).unwrap(),
                arc_tree,
                "{name}: the arc's tree"
            );
            let parents = git_stdout(repo, &["log", "-1", "--format=%P"]).unwrap();
            let parents: Vec<&str> = parents.split_whitespace().collect();
            assert_eq!(parents.len(), parent_count, "{name}: {parents:?}");
            assert_eq!(parents[0], base_head);
            if parent_count == 2 {
                assert_eq!(parents[1], arc_tip);
            }
            let body = tugcore::test_fixtures::git::command()
                .arg("-C")
                .arg(repo)
                .args(["log", "-1", "--format=%B"])
                .output()
                .unwrap();
            let body = String::from_utf8_lossy(&body.stdout).to_string();
            assert!(
                body.contains("Land the change\n\nThe body.\n"),
                "{name}: {body:?}"
            );
            assert!(
                !body.contains("\n\n\n"),
                "{name}: blank runs collapsed: {body:?}"
            );
            assert!(
                dirty_tracked_paths(repo).is_empty(),
                "{name}: checkout clean"
            );
        }
    }

    /// The unprovable case, reached for real: a rebase join conflicts, and the
    /// `cherry-pick --abort` that would put the base back loses the index lock.
    /// The lock is taken by a merge driver git itself runs during the pick —
    /// it waits for the pick to finish and release, then takes the lock, so
    /// the abort is the first writer to meet it.
    ///
    /// The join's record is kept and marked, the error says so in a sentence,
    /// `join` and `undo` both refuse by naming it, and `resolve-base` clears
    /// it: the abort re-run, the base back where the join found it, the
    /// record gone, and the next join free to run.
    #[cfg(unix)]
    #[test]
    fn a_failed_abort_is_recorded_as_a_stranded_base_and_resolve_base_clears_it() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "strand");
        let repo = temp.path();
        // The base moves on the same line, so the rebase cannot fast-forward
        // and its cherry-pick has a content merge to run.
        fs::write(repo.join("shared.txt"), "base\nbase change\n").unwrap();
        git_output(repo, &["commit", "-am", "base moves"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        let git_dir = git_stdout(repo, &["rev-parse", "--absolute-git-dir"]).unwrap();
        let driver = temp.path().join("state").join("take-the-lock.sh");
        fs::write(
            &driver,
            format!(
                "#!/bin/sh\n\
                 (\n  n=0\n  until [ -e '{git_dir}/CHERRY_PICK_HEAD' ] && [ ! -e '{git_dir}/index.lock' ]; do\n    \
                 n=$((n+1)); [ $n -gt 2000000 ] && exit 0\n  done\n  : > '{git_dir}/index.lock'\n\
                 ) >/dev/null 2>&1 &\nexit 1\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&driver, fs::Permissions::from_mode(0o755)).unwrap();
        git_output(
            repo,
            &[
                "config",
                "merge.strand.driver",
                &driver.display().to_string(),
            ],
        )
        .unwrap();
        fs::create_dir_all(Path::new(&git_dir).join("info")).unwrap();
        fs::write(
            Path::new(&git_dir).join("info/attributes"),
            "shared.txt merge=strand\n",
        )
        .unwrap();

        let rebase = || JoinOptions {
            strategy: JoinStrategy::Rebase,
            ..mechanics()
        };
        let err = join_in(&paths, repo, "strand", rebase())
            .unwrap_err()
            .to_string();
        assert!(err.contains("could not be proven untouched"), "{err}");
        assert!(err.contains("CHERRY_PICK_HEAD is standing"), "{err}");
        assert!(err.contains("tugtool arc resolve-base strand"), "{err}");

        let root = std::fs::canonicalize(repo).unwrap();
        let op = crate::oplog::stranded_join(&paths, &root, "strand").expect("the record is kept");
        assert!(op.after.is_none(), "it landed nothing");
        assert_eq!(op.before.base_tip, base_tip);

        // Every other door reads the record rather than guessing.
        let again = join_in(&paths, &root, "strand", rebase())
            .unwrap_err()
            .to_string();
        assert!(again.starts_with("stranded-base:"), "{again}");
        let undo = crate::oplog::undo_in(&paths, repo, Some("strand"))
            .unwrap_err()
            .to_string();
        assert!(undo.starts_with("stranded-base:"), "{undo}");

        // The lock's holder is gone; resolve-base re-runs the abort.
        fs::remove_file(Path::new(&git_dir).join("index.lock")).unwrap();
        let outcome = resolve_base_in(&paths, repo, "strand", &BTreeMap::new()).expect("clears");
        assert!(
            outcome.warnings.iter().any(|w| w.contains("Cleared")),
            "{:?}",
            outcome.warnings
        );
        assert!(crate::oplog::stranded_join(&paths, &root, "strand").is_none());
        assert!(standing_integrate_markers(repo).is_empty());
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), base_tip);
        assert!(dirty_tracked_paths(repo).is_empty());

        // And the join is a join again: with the driver gone it reports the
        // conflict, the base untouched and nothing recorded.
        git_output(repo, &["config", "--unset", "merge.strand.driver"]).unwrap();
        let outcome = join_in(&paths, &root, "strand", rebase()).expect("runs");
        assert_eq!(outcome.conflicts, vec!["shared.txt"]);
        assert!(ops_for(&paths, repo, "strand").is_empty());
    }

    /// A payload written before the stranded field existed still reads.
    #[test]
    fn a_payload_without_the_stranded_field_still_reads() {
        let old = r#"{"version":1,"seq":7,"verb":"join","dash":"x","recorded_at":"t",
            "before":{"base_branch":"main","base_tip":"a","dash_tip":"b","worktree":"w"}}"#;
        let op: crate::oplog::OpPayload = serde_json::from_str(old).expect("reads");
        assert!(op.stranded.is_none());
    }

    /// The 2026-09-21 state, rebuilt: an arc's squash staged on the base and
    /// never committed, one of its files since restored, `SQUASH_MSG` standing.
    /// The five records agree throughout, which is why the doctor reads a
    /// sixth: it names the standing squash and the echoed paths, points at
    /// `resolve-base`, and only says the arc is healthy once that has run.
    #[test]
    fn the_doctor_names_a_squash_stranded_on_the_base() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "leftstaged");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/leftstaged");
        for n in 0..10 {
            fs::write(worktree.join(format!("file{n}.txt")), format!("arc {n}\n")).unwrap();
        }
        commit_in(&paths, repo, "leftstaged", "add ten files", None, None).unwrap();
        let root = std::fs::canonicalize(repo).unwrap();
        assert!(crate::doctor::diagnose(&paths, &root, "leftstaged").healthy());

        let merged = git_output(repo, &["merge", "--squash", &branch_name("leftstaged")]).unwrap();
        assert!(merged.status.success());
        git_output(repo, &["checkout", "HEAD", "--", "shared.txt"]).unwrap();

        let diagnosis = crate::doctor::diagnose(&paths, &root, "leftstaged");
        let find = |code: &str| {
            diagnosis
                .findings
                .iter()
                .find(|f| f.code == code)
                .unwrap_or_else(|| panic!("{code}: {:?}", diagnosis.findings))
        };
        let squash = find("base-squash-standing");
        assert!(
            squash.sentence.contains("SQUASH_MSG"),
            "{}",
            squash.sentence
        );
        assert!(
            squash
                .sentence
                .contains("tugtool arc resolve-base leftstaged")
        );
        let echo = find(crate::doctor::BASE_ECHO_CODE);
        assert!(echo.sentence.contains("10 paths"), "{}", echo.sentence);
        assert!(echo.sentence.contains("file3.txt"), "{}", echo.sentence);
        assert!(
            !echo.sentence.contains("shared.txt"),
            "the restored file is clean"
        );
        assert!(
            echo.sentence
                .contains("tugtool arc resolve-base leftstaged")
        );

        resolve_base_in(&paths, repo, "leftstaged", &BTreeMap::new()).expect("one call clears it");
        let diagnosis = crate::doctor::diagnose(&paths, &root, "leftstaged");
        assert!(diagnosis.healthy(), "{:?}", diagnosis.findings);
        assert!(standing_integrate_markers(repo).is_empty());
    }

    /// Somebody's own `git merge --squash` of some other branch is theirs: the
    /// doctor reads the base for *this arc's* marks and reports none.
    #[test]
    fn a_squash_msg_that_is_not_this_arcs_is_not_a_finding() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "bystander");
        let repo = temp.path();
        git_output(repo, &["checkout", "-q", "-b", "side"]).unwrap();
        fs::write(repo.join("side.txt"), "side\n").unwrap();
        git_output(repo, &["add", "side.txt"]).unwrap();
        git_output(repo, &["commit", "-qm", "side work"]).unwrap();
        git_output(repo, &["checkout", "-q", "-"]).unwrap();
        assert!(
            git_output(repo, &["merge", "--squash", "side"])
                .unwrap()
                .status
                .success()
        );
        assert_eq!(standing_integrate_markers(repo), vec!["SQUASH_MSG"]);

        let root = std::fs::canonicalize(repo).unwrap();
        let diagnosis = crate::doctor::diagnose(&paths, &root, "bystander");
        assert!(diagnosis.healthy(), "{:?}", diagnosis.findings);
    }

    /// The other two marks: the stranded record and an operation with no
    /// `after`, each named with the verb that clears it, and each cleared.
    #[test]
    fn the_doctor_names_a_stranded_record_and_an_unfinished_operation() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "records");
        let repo = temp.path();
        let root = std::fs::canonicalize(repo).unwrap();
        let open = |verb| {
            let before = crate::oplog::capture_before(&root, "records").unwrap();
            let tips = crate::oplog::tips_of(&before);
            crate::oplog::record_begin(&paths, &root, verb, "records", before, &tips).unwrap()
        };
        let stranded = open(crate::oplog::OpVerb::Join);
        crate::oplog::record_stranded(
            &paths,
            &root,
            stranded,
            crate::oplog::StrandedBase {
                paths: vec!["shared.txt".to_string()],
                found: "SQUASH_MSG is standing".to_string(),
            },
        )
        .unwrap();
        open(crate::oplog::OpVerb::ResolveBase);

        let diagnosis = crate::doctor::diagnose(&paths, &root, "records");
        let codes: Vec<&str> = diagnosis.findings.iter().map(|f| f.code.as_str()).collect();
        assert_eq!(codes, vec!["base-stranded", "op-incomplete"]);
        for finding in &diagnosis.findings {
            assert!(
                finding
                    .sentence
                    .contains("tugtool arc resolve-base records"),
                "{}",
                finding.sentence
            );
        }

        resolve_base_in(&paths, repo, "records", &BTreeMap::new()).expect("clears both");
        assert!(crate::doctor::diagnose(&paths, &root, "records").healthy());
    }

    /// A base copy *staged as new* is in the index and absent from HEAD, so
    /// `checkout HEAD --` has nothing to restore it to. The drop takes the
    /// index entry with the file, and the join lands over it.
    #[test]
    fn a_join_lands_over_an_identical_staged_new_base_copy() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_that_adds_files(&temp, "stagednew");
        let repo = temp.path();
        fs::write(repo.join("added.txt"), "new in the arc\n").unwrap();
        git_output(repo, &["add", "added.txt"]).unwrap();

        let outcome = join_in(&paths, repo, "stagednew", mechanics())
            .expect("the join runs over a staged-new echo");
        assert!(outcome.commit_hash.is_some(), "it landed");
        assert!(
            outcome.warnings.iter().any(|w| w.contains("added.txt")),
            "the drop is reported: {:?}",
            outcome.warnings
        );
        assert_eq!(
            fs::read_to_string(repo.join("added.txt")).unwrap(),
            "new in the arc\n"
        );
        assert!(
            dirty_tracked_paths(repo).is_empty(),
            "nothing left uncommitted"
        );
    }

    /// The state a join that lost the index lock leaves: the arc's whole squash
    /// staged on the base, edits and additions together. One `resolve-base`
    /// clears all of it.
    #[test]
    fn resolve_base_clears_a_whole_staged_squash_in_one_call() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_that_adds_files(&temp, "stranded");
        let repo = temp.path();
        let merged = git_output(repo, &["merge", "--squash", &branch_name("stranded")]).unwrap();
        assert!(merged.status.success(), "the squash staged");

        let outcome =
            resolve_base_in(&paths, repo, "stranded", &BTreeMap::new()).expect("resolves");
        let mut dropped = outcome.dropped.clone();
        dropped.sort();
        assert_eq!(dropped, vec!["added.txt", "nested/extra.txt", "shared.txt"]);
        assert!(outcome.committed.is_none(), "nothing to commit");
        assert!(
            dirty_tracked_paths(repo).is_empty(),
            "the index matches HEAD"
        );
        assert!(
            !repo.join("added.txt").exists(),
            "the staged-new file went with its entry"
        );
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\n"
        );
    }

    /// A drop that fails part-way puts back what it had already dropped, in
    /// the index state and the permissions each path held, and closes the
    /// record it opened. The failure is a real one: the last untracked copy
    /// sits in a directory that refuses the unlink, after the two tracked
    /// copies and one executable untracked one have been dropped.
    #[cfg(unix)]
    #[test]
    fn a_drop_that_fails_midway_leaves_the_base_as_it_was() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_that_adds_files(&temp, "halfdrop");
        let repo = temp.path();
        // An executable file the arc adds: the one shape whose mode no index
        // entry records, since the base's copy of it is untracked.
        let worktree = repo.join(".tug/worktrees/halfdrop");
        fs::write(worktree.join("alpha.sh"), "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(worktree.join("alpha.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        commit_in(&paths, repo, "halfdrop", "add a script", None, None).unwrap();
        fs::write(repo.join("alpha.sh"), "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(repo.join("alpha.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        fs::write(repo.join("added.txt"), "new in the arc\n").unwrap();
        git_output(repo, &["add", "shared.txt", "added.txt"]).unwrap();
        fs::create_dir_all(repo.join("nested")).unwrap();
        fs::write(repo.join("nested/extra.txt"), "also new\n").unwrap();
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o555)).unwrap();

        let snapshot = || {
            (
                git_stdout(repo, &["status", "--porcelain"]).unwrap(),
                git_stdout(repo, &["ls-files", "--stage"]).unwrap(),
                fs::read(repo.join("shared.txt")).unwrap(),
                fs::read(repo.join("added.txt")).unwrap(),
                fs::read(repo.join("nested/extra.txt")).unwrap(),
                fs::read(repo.join("alpha.sh")).unwrap(),
                fs::metadata(repo.join("alpha.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
            )
        };
        let before = snapshot();
        let err = resolve_base_in(&paths, repo, "halfdrop", &BTreeMap::new())
            .unwrap_err()
            .to_string();
        let after = snapshot();
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o755)).unwrap();

        assert!(err.contains("nested/extra.txt"), "{err}");
        assert!(err.contains("left as it was"), "{err}");
        assert_eq!(before, after, "index and files are byte-identical");
        let root = std::fs::canonicalize(repo).unwrap();
        assert!(
            crate::oplog::list_ops(&paths, &root)
                .iter()
                .all(|op| op.after.is_some() || op.verb != crate::oplog::OpVerb::ResolveBase),
            "no resolve-base payload is left without an `after`"
        );

        // The same failure on the join path drops the record it opened too.
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o555)).unwrap();
        let err = join_in(&paths, &root, "halfdrop", mechanics())
            .unwrap_err()
            .to_string();
        let after = snapshot();
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("left as it was"), "{err}");
        assert_eq!(before, after, "the join's failed drop moved nothing either");
        assert!(
            ops_for(&paths, repo, "halfdrop").is_empty(),
            "and left no join record"
        );
    }

    /// Undo beside the receipt puts the edit back where it was: the base at
    /// its pre-fold tip and the file dirty again, which is the whole of what
    /// the button promises.
    ///
    /// These two live here rather than in `oplog.rs` because a real fold needs
    /// a real arc, and `seed_arc_with_a_round` is the fixture that builds one.
    #[test]
    fn undo_resolve_base_in_reverses_a_standing_fold() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "undofold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nmy own edit\n").unwrap();

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        resolve_base_in(&paths, repo, "undofold", &BTreeMap::new()).expect("folds");
        assert!(dirty_tracked_paths(repo).is_empty(), "the fold cleared it");

        crate::oplog::undo_resolve_base_in(&paths, repo, "undofold").expect("undoes");

        assert_eq!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            before_tip,
            "the base is back where the fold found it"
        );
        assert_eq!(
            dirty_tracked_paths(repo),
            vec!["shared.txt".to_string()],
            "and the edit is uncommitted again"
        );
        assert_eq!(
            fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "base\nmy own edit\n",
            "byte for byte their own"
        );
    }

    /// The narrowing is the point: once the arc has joined, the newest
    /// operation is that join, the receipt has retired itself, and a press
    /// that reached the general `undo_in` would un-land the join under a
    /// reader who thought they were putting one file back.
    #[test]
    fn undo_resolve_base_in_refuses_when_the_newest_op_is_a_join() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        // The fixture is inline rather than `seed_arc_with_a_round` because
        // this one needs the join to *land*: the helper's arc and its base
        // dirt are the same line of a two-line file, so the join that follows
        // the fold conflicts, aborts, and records no operation at all. Here
        // the arc edits the top and the base edits the bottom, which is the
        // ordinary history the fold exists to produce.
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));
        fs::write(repo.join("shared.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create_in(&paths, repo, "foldjoin", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/foldjoin");
        fs::write(worktree.join("shared.txt"), "TOP\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        commit_in(&paths, repo, "foldjoin", "touch the top", None, None).unwrap();
        fs::write(repo.join("shared.txt"), "1\n2\n3\n4\n5\n6\n7\nBOTTOM\n").unwrap();

        resolve_base_in(&paths, repo, "foldjoin", &BTreeMap::new()).expect("folds");
        let joined = join_in(&paths, repo, "foldjoin", mechanics()).expect("joins");
        assert!(joined.commit_hash.is_some(), "the join landed: {joined:?}");
        let joined_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        let err = crate::oplog::undo_resolve_base_in(&paths, repo, "foldjoin")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a resolve"), "got {err}");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
            joined_tip,
            "and it moved nothing saying so"
        );
    }

    /// The arc's uncommitted work counts toward the overlap, because the
    /// join's preamble commits it before joining. The detail walk's warning and
    /// the preflight's refusal are the same set.
    #[test]
    fn worktree_dirt_counts_toward_the_overlap_the_join_will_hit() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "wtdirt");
        let repo = temp.path();

        // A path the arc has NOT committed, only dirtied in its worktree.
        let worktree = repo.join(".tug/worktrees/wtdirt");
        fs::write(worktree.join("other.txt"), "arc uncommitted\n").unwrap();
        git_output(&worktree, &["add", "other.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base uncommitted\n").unwrap();
        git_output(repo, &["add", "other.txt"]).unwrap();

        let detail = arc_detail_entry_in(&paths, repo, "wtdirt").expect("detail");
        assert!(
            overlap_paths(&detail.base_overlap).contains(&"other.txt".to_string()),
            "the detail's warning sees it: {:?}",
            detail.base_overlap
        );
        let blockers = join_preflight_in(&paths, repo, "wtdirt").unwrap();
        assert!(
            blockers
                .iter()
                .any(|b| b.kind == "base-dirt" && b.paths.contains(&"other.txt".to_string())),
            "and the preflight refuses on it: {blockers:?}"
        );
    }

    #[test]
    fn join_conflicts_in_reports_what_the_preview_reports() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "probe");
        let repo = temp.path();

        // Make the base conflict with the arc on the same path.
        fs::write(repo.join("shared.txt"), "base\nbase change\n").unwrap();
        git_output(repo, &["commit", "-am", "base moves shared"]).unwrap();

        let probe = join_conflicts_in(repo, "probe").unwrap();
        let previewed = preview_in(&paths, repo, "probe");
        assert_eq!(probe.conflicts, previewed.conflicts);
        assert_eq!(
            previewed.archaeology.len(),
            probe.conflicts.len(),
            "the preview reports what the base did to each conflicted path"
        );
        assert!(!probe.conflicts.is_empty(), "the fixture really conflicts");
        assert_eq!(
            probe.base_sha,
            git_stdout(repo, &["rev-parse", "main"]).unwrap()
        );
        assert_eq!(
            probe.arc_sha,
            git_stdout(repo, &["rev-parse", "tugarc/probe"]).unwrap()
        );
    }

    /// The inside-the-worktree refusal reads the cwd the caller names, not the
    /// process's: a caller standing in the arc worktree is refused, and one
    /// that names no cwd — tugcast's case — is not asked where it stands.
    #[test]
    fn join_refuses_a_caller_standing_in_the_arc_worktree() {
        let temp = TempDir::new().unwrap();
        let paths = seed_arc_with_a_round(&temp, "standing");
        let repo = temp.path();
        let worktree = worktree_path(repo, "standing");

        let err = join_in(
            &paths,
            repo,
            "standing",
            JoinOptions {
                caller_cwd: Some(worktree.join("sub")),
                ..mechanics()
            },
        )
        .unwrap_err();
        assert!(
            matches!(&err, ArcError::Refused(msg) if msg.contains("inside the arc worktree")),
            "a caller inside the worktree is refused: {err:?}"
        );
        assert!(worktree.exists(), "the refusal touched nothing");

        let outcome = join_in(&paths, repo, "standing", mechanics()).unwrap();
        assert!(outcome.commit_hash.is_some(), "no cwd named, no refusal");
    }
}
