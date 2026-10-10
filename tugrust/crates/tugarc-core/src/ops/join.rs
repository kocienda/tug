//! Landing an arc on its base: the preflight and its blockers, the integrate and
//! its teardown, the progress beats, the landing message, and `resolve-base`.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::{
    ArcDetail, BRANCH_PREFIX, arc_base, arc_detail_entry_in, arc_owner_key, branch_exists,
    branch_name, commit_worktree_dirt, config_get, current_branch, dirty_tracked_paths,
    documents_dir, fit_fact, git_output, git_paths_or_empty, git_stdout, git_write,
    git_write_on_the_merits, listing_error, main_repo_root, reconcile_branches,
    remove_arc_worktree, retry_past_index_lock, untracked_paths, with_arc_trailers, worktree_path,
};
use crate::error::ArcError;
use crate::log::{FitFact, append_arc_log, read_declarations};

/// How [`join`] integrates an arc into its base branch ([P14]).
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
    /// instead of merging the arc branch: the candidate supplies the resolved
    /// **bytes**, `strategy` still decides the **shape**, and the normal
    /// recorded teardown follows. Staleness-guarded by ancestry, the same test
    /// [`crate::resolve::candidate_status`] applies.
    ///
    /// The candidate's own internal shape — one commit on the base, or a chain
    /// of replayed rounds — is an implementation detail of the ladder and never
    /// decides what the base's history looks like.
    pub candidate: Option<String>,
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
    /// shows one pill for work that had a session behind it. `None` falls back
    /// to the running process's own id, which is what the CLI wants.
    pub session_id: Option<String>,
    /// Proceed past the `live-resolve` refusal, tearing down a conflict chain
    /// the lease says somebody may still be working on.
    ///
    /// Consent, not capability: the teardown is unchanged, and the op log's
    /// keepalive already holds the chain so `tugtool arc undo` puts it back.
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
pub fn join_in_flight(repo: &Path, name: &str) -> bool {
    crate::oplog::join_in_flight(&main_repo_root(repo), name).is_some()
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
/// machine-global changes ledger (`tugcore::instance::changes_db_path()`,
/// `TUG_CHANGES_DB` overridable) — drafts are machine-global like the working
/// tree they describe.
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
pub(crate) fn arc_draft_message(repo: &Path, branch: &str) -> Option<String> {
    let db = tugcore::instance::changes_db_path();
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
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
/// as `tugarc(<name>): …`. Shared by the strategy integrate and the resolution
/// ladder's candidate commit so both speak the same voice.
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
    // Subject stays `tugarc(<name>): …`; the trailers ride the body ([P08]).
    with_arc_trailers(repo, name, branch, &subject, session)
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
    repo: &Path,
    name: &str,
    branch: &str,
) -> (String, LandingMessageSource) {
    let (body, source) = match arc_draft_message(repo, branch) {
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

/// The receipt a broken lease leaves in the verb's warnings.
pub(super) fn broke_lease_warning(
    name: &str,
    lease: &crate::resolve::ResolveLease,
    seq: u64,
) -> String {
    format!(
        "Broke the resolve lease on '{}' (chain tip {} old); the resolver's checkpoints are kept at op #{} — tugtool arc undo restores them.",
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
        "A resolve may still be running for arc '{}': its conflict chain was last advanced {} ago, inside the {} lease. Wait for it to finish, resolve again to start a fresh one, or pass `--break-lease` to {} anyway — the resolver's checkpoints are kept by the op log and `tugtool arc undo` puts them back.",
        name,
        human_age(lease.age),
        human_age(crate::resolve::RESOLVE_LEASE),
        verb
    )
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

fn live_resolve_blocker(name: &str, lease: &crate::resolve::ResolveLease) -> JoinBlocker {
    plain_blocker(
        "live-resolve",
        "A resolve is running",
        live_resolve_detail(name, lease, "join"),
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
pub fn join_preflight_in(repo_root: &Path, name: &str) -> Result<Vec<JoinBlocker>, ArcError> {
    let repo_root = &main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    let detail = arc_detail_entry_in(repo_root, name).ok_or_else(|| ArcError::NotFound {
        name: name.to_string(),
    })?;
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
    let mut cleared_strand = match crate::oplog::stranded_join(&repo_root, name) {
        Some(op) => {
            clear_stranded_join(&repo_root, &op, &mut warnings)?;
            true
        }
        None => false,
    };

    // An operation that began and never finished — a verb killed mid-flight —
    // says nothing an undo can read. With no half-done integrate standing on
    // the base there is nothing of it left to clear but the record itself.
    if standing_integrate_markers(&repo_root).is_empty() {
        for op in crate::oplog::list_ops(&repo_root).into_iter().filter(|op| {
            op.arc == name && op.after.is_none() && op.join.is_none() && op.stranded.is_none()
        }) {
            crate::oplog::abandon(&repo_root, op.seq);
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
            crate::oplog::abandon(&repo_root, op_seq);
        } else {
            let _ = crate::oplog::record_complete(
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
    if held != Some("join") && crate::oplog::join_in_flight(repo_root, name).is_some() {
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

    // Only when nobody in this process holds the arc: the in-process registry
    // is exact and instant, and the lease is the two-hour derived answer for
    // the case it cannot see — another process entirely.
    if held.is_none()
        && let Some(lease) = crate::resolve::resolve_lease(repo_root, name, SystemTime::now())
    {
        blockers.push(live_resolve_blocker(name, &lease));
    }

    // Empty is a *finding* on the preview path, not a refusal: the card's answer
    // to it is the discard affordance. The execute path auto-commits worktree
    // dirt before testing `ahead`, so dirt makes an arc non-empty here too.
    if detail.rounds == 0 && !detail.worktree_dirty_tracked {
        blockers.push(empty_blocker(name, base_branch));
    }

    blockers
}

/// The conflict half of a join preview: what `merge-tree` says, plus the base
/// archaeology behind it, plus the two heads the answer was computed from.
#[derive(Debug, Clone)]
pub struct JoinConflicts {
    pub conflicts: Vec<String>,
    pub archaeology: Vec<ConflictHistory>,
    pub base_sha: String,
    pub arc_sha: String,
}

/// Probe an arc's conflict set without touching anything.
///
/// **This half is cacheable**, and it is the expensive one: `merge-tree` plus a
/// `git log` per conflicted path. It is a pure function of the two heads it
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
    let archaeology = conflict_archaeology(repo_root, &base_branch, &branch, &conflicts);
    Ok(JoinConflicts {
        conflicts,
        archaeology,
        base_sha: git_stdout(repo_root, &["rev-parse", &base_branch])?,
        arc_sha: git_stdout(repo_root, &["rev-parse", &branch])?,
    })
}

/// Like [`join`], but against an explicit repo root instead of discovering it
/// from the process cwd — for callers such as tugcast that serve many projects
/// and must never depend on `current_dir`.
pub fn join_in(repo_root: &Path, name: &str, opts: JoinOptions) -> Result<JoinOutcome, ArcError> {
    join_in_with_progress(repo_root, name, opts, |_, _| {})
}

/// [`join_in`], narrating itself as it goes.
///
/// `on_beat(beat, status)` fires around each of the join's real boundaries,
/// with `status` one of `start` / `done`:
///
/// | Beat | What it surrounds |
/// |---|---|
/// | `squash` | the integrate — squash-merge and commit, of the arc branch or of a resolved candidate, per `strategy` |
/// | `teardown` | removing the arc worktree |
/// | `release` | dropping the candidate ref, removing the workshop, deleting the branch |
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
    repo_root: &Path,
    name: &str,
    opts: JoinOptions,
    on_beat: impl Fn(&str, &str),
) -> Result<JoinOutcome, ArcError> {
    let repo_root = main_repo_root(repo_root);
    let mut warnings = Vec::new();
    reconcile_branches(&repo_root, &mut warnings);
    // A journal an older build left behind becomes an op record here, where
    // every path below can see it — and an unreadable one is named rather than
    // ignored, because ignoring it would let a plain join run over an arc that
    // is half torn down.
    crate::oplog::fold_legacy_join_journal(&repo_root, name)?;
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
        let op = crate::oplog::join_in_flight(&repo_root, name).ok_or_else(|| {
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
        return Err(ArcError::Blocked(vec![stale_journal_blocker(name)]));
    }

    // A prior join that could not prove it left the base untouched stands
    // until `resolve-base` clears it; joining over it would stack a second
    // integrate on a state nothing recorded.
    if let Some(op) = crate::oplog::stranded_join(&repo_root, name) {
        return Err(ArcError::Refused(crate::oplog::stranded_detail(&op)));
    }

    // Must run from the base worktree, not inside the arc worktree. Deliberately
    // absent from `join_preflight_in`: it reads the *process* cwd, which from
    // tugcast is the server's and has nothing to do with the calling card.

    let current_dir = std::env::current_dir()
        .map_err(|e| ArcError::io("failed to get current directory", ".", e))?;
    if current_dir.starts_with(&worktree) {
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

    // A resolve another process may still be running holds the arc, and the
    // teardown below would take its workshop out from under it. Above the dirt
    // sweep on purpose: every refusal to this point has touched nothing, and a
    // refusal that had first committed a round would be a mutation on a
    // refusal path ([L28]).
    let broke_lease = match crate::resolve::resolve_lease(&repo_root, name, SystemTime::now()) {
        Some(lease) if !opts.break_lease => {
            return Err(ArcError::Blocked(vec![live_resolve_blocker(name, &lease)]));
        }
        Some(lease) => Some(lease),
        None => None,
    };

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

    // The last refusal is behind us, so the base's stale copies of this arc's
    // own bytes can go. Git would refuse the merge over them otherwise, even
    // though it is about to write those exact bytes. Inside the record, so a
    // drop that could not be taken back is on what an undo reads: the record
    // goes only when the base is as the join found it.
    if let Err(failure) = drop_identical_base_copies(&repo_root, &branch, &droppable, &mut warnings)
    {
        if failure.left_dropped.is_empty() {
            crate::oplog::abandon(&repo_root, op_seq);
        } else {
            let _ = crate::oplog::record_stranded(
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
            crate::oplog::abandon(&repo_root, op_seq);
            return None;
        }
        let stranded = base_after.difference_from(&base_before);
        let tail = format!(
            " — and the base checkout could not be proven untouched ({}). The join is recorded as operation {op_seq}; clear it with: tugtool arc resolve-base {name}",
            stranded.found
        );
        let _ = crate::oplog::record_stranded(&repo_root, op_seq, stranded);
        Some(tail)
    };
    let integration = match integrate_join(&repo_root, name, &branch, &base_branch, &opts) {
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
    crate::oplog::abandon(repo_root, op.seq);
    warnings.push(format!(
        "Cleared the base state a failed join of '{}' left behind (operation {}).",
        op.arc, op.seq
    ));
    Ok(())
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
/// Three landing shapes read together: a pre-built candidate from the
/// resolution ladder, and the strategy match for a plain join, which is the
/// same three strategies over the arc branch itself. Every exit that does not
/// land — a conflict, a stale candidate, a failed merge or commit — leaves the
/// base as it was, which is what lets the caller drop the record it opened.
fn integrate_join(
    repo_root: &Path,
    name: &str,
    branch: &str,
    base_branch: &str,
    opts: &JoinOptions,
) -> Result<Integration, ArcError> {
    // Land a pre-built candidate from the resolution ladder ([P31]) instead of
    // merging the arc branch. The candidate is the resolved bytes; `strategy`
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
            return Err(ArcError::Refused(format!(
                "stale candidate: base '{}' advanced since the conflicts were resolved; re-resolve and try again",
                base_branch
            )));
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
            // The candidate is a descendant of the base head, so its tree *is*
            // the join's result; the commit built on it is what the draft was
            // written for — one parent for a squash, the candidate as the
            // second for a merge.
            JoinStrategy::Squash | JoinStrategy::Merge => {
                let tree = git_stdout(repo_root, &["rev-parse", &format!("{candidate}^{{tree}}")])?;
                let mut parents = vec![base_head.as_str()];
                if matches!(opts.strategy, JoinStrategy::Merge) {
                    parents.push(&candidate);
                }
                land_side_built_commit(repo_root, &tree, &parents, &final_msg)?
            }
            // The one strategy that asks for the candidate's own history on the
            // base, and therefore the one that keeps its own messages.
            JoinStrategy::Rebase => {
                let what =
                    format!("failed to fast-forward '{base_branch}' onto the resolved candidate");
                if let Some(stderr) =
                    git_write_on_the_merits(repo_root, &["merge", "--ff-only", &candidate], &what)?
                {
                    return Err(ArcError::git(
                        what,
                        &["merge", "--ff-only", &candidate],
                        stderr,
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
        repo_root,
        branch,
        &arc_base(repo_root, name).unwrap_or_default(),
        &read_declarations(repo_root, name),
    );
    if progress.phase == crate::oplog::JoinPhase::Integrated {
        on_beat("teardown", "start");
        remove_arc_worktree(repo_root, branch, worktree, &mut warnings);
        progress.phase = crate::oplog::JoinPhase::WorktreeRemoved;
        crate::oplog::record_join_progress(repo_root, op_seq, progress.clone())?;
        on_beat("teardown", "done");
    }

    if progress.phase == crate::oplog::JoinPhase::WorktreeRemoved {
        on_beat("release", "start");
        // The branch config section dies with the branch, but a loose ref does
        // not — so the candidate is dropped explicitly, on every join path,
        // rather than being left to outlive the arc it described.
        crate::resolve::clear_candidate(repo_root, name);
        // The workshop outlives every resolve on purpose; it does not outlive
        // the arc. A `tugworkshop/*` ref standing past its arc is a leak.
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
        crate::oplog::record_join_progress(repo_root, op_seq, progress.clone())?;
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
    append_arc_log(repo_root, name, &short, &note).map_err(|e| ArcError::arc_log(repo_root, e))?;

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
/// re-derived: by the time a `--continue` runs, the arc branch may already be
/// deleted and `arc_base` would fall back to the repository's default branch,
/// which is a guess.
fn base_branch_of(repo_root: &Path, op_seq: u64, name: &str) -> String {
    crate::oplog::read_op(repo_root, op_seq)
        .map(|op| op.before.base_branch)
        .or_else(|| arc_base(repo_root, name).ok())
        .unwrap_or_else(|| "main".to_string())
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

    #[serial]
    #[test]
    fn preflight_leaves_ordinary_base_dirt_wording_alone() {
        let (_temp, root) = plain_arc("plainly-arc");
        let worktree = worktree_path(&root, "plainly-arc");
        fs::write(worktree.join("README.md"), "# Arc\n").unwrap();
        commit("plainly-arc", "touch readme", None).unwrap();
        fs::write(root.join("README.md"), "# Local\n").unwrap();

        let blockers = join_preflight_in(&root, "plainly-arc").unwrap();
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
    #[serial]
    #[test]
    fn preflight_blocks_untracked_base_files_the_arc_would_overwrite() {
        let (_temp, root) = plain_arc("overwrite-arc");
        let worktree = worktree_path(&root, "overwrite-arc");
        fs::create_dir_all(worktree.join("roadmap")).unwrap();
        fs::write(worktree.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        commit("overwrite-arc", "add the plan", None).unwrap();

        // A disjoint untracked file does not block.
        fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        let clean = join_preflight_in(&root, "overwrite-arc").unwrap();
        assert!(clean.iter().all(|b| b.kind != "base-dirt"), "{clean:?}");

        // The same path the arc added does — when it is other content. An
        // untracked base file holding what the arc adds byte for byte is the
        // arc's own work sitting on the base, and is dropped rather than
        // refused over, the same as its tracked twin.
        fs::create_dir_all(root.join("roadmap")).unwrap();
        fs::write(root.join("roadmap/plan.md"), TWO_STEP_PLAN).unwrap();
        let echo = join_preflight_in(&root, "overwrite-arc").unwrap();
        assert!(
            echo.iter().all(|b| b.kind != "base-dirt"),
            "an identical untracked copy is the arc's own bytes: {echo:?}"
        );

        fs::write(root.join("roadmap/plan.md"), "somebody else's plan\n").unwrap();
        let blockers = join_preflight_in(&root, "overwrite-arc").unwrap();
        let dirt = blockers.iter().find(|b| b.kind == "base-dirt").unwrap();
        assert_eq!(dirt.paths, vec!["roadmap/plan.md".to_string()]);
        assert!(dirt.detail.contains("would be overwritten"), "{:?}", dirt);

        // The execute path refuses with the same sentence, rather than a clean
        // preview followed by a squash that fails on the untracked file.
        let err = join("overwrite-arc", mechanics()).unwrap_err().to_string();
        assert_eq!(err, dirt.detail);
        assert!(branch_present(&root, "tugarc/overwrite-arc"));
    }

    /// The whole point of moving the documents out of the tree: what a join
    /// lands is the work, and the paperwork is not in it.
    #[serial]
    #[test]
    fn a_planned_arc_lands_a_commit_whose_tree_holds_no_document() {
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
    // process per test, and because every test here is `#[serial]` besides —
    // the same regime `redirect_state_dir` already relies on.

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
    #[serial]
    #[test]
    fn test_a_join_narrates_its_beats_and_a_preview_narrates_nothing() {
        let temp = TempDir::new().unwrap();
        let (_base, universe) = base_with_universe(&temp);

        create("narrator", None, false, Some("feature")).unwrap();
        let worktree = universe.join(".tug/worktrees/narrator");
        fs::write(worktree.join("landed.txt"), "from the arc\n").unwrap();
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
        fs::write(worktree.join("landed.txt"), "from the arc\n").unwrap();
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

    #[serial]
    #[test]
    fn test_arc_join_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test arc".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("feature.txt"), "new feature\n").unwrap();
        commit("test-arc", "Add feature", None).unwrap();

        let result = join(
            "test-arc",
            JoinOptions {
                message: Some("Add new feature".to_string()),
                ..mechanics()
            },
        );
        assert!(result.is_ok());

        // Squash commit on base, worktree + branch gone.
        let log = tugcore::git_command()
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
    #[serial]
    #[test]
    fn test_arc_join_uses_changes_ledger_draft_message() {
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
                 VALUES ('arc', 'tugarc/draft-arc', ?1, 'fp', 'Land the drafted work', 1, 1)",
                rusqlite::params![project],
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", &changes_db);
        }

        create("draft-arc", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/draft-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("draft-arc", "Add f", None).unwrap();

        // Preview first (`/join`'s beat 1): in-memory, clean, mutates nothing.
        let preview = join(
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
        join("draft-arc", mechanics()).unwrap();

        // SAFETY: serial test; clear before the next test resolves the path.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }

        let log = tugcore::git_command()
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
    /// ([P08], Spec S02). With no `TUG_SESSION_ID` in the environment the
    /// `Tug-Session:` trailer is omitted (no error).
    /// A join reaches the arc's draft under the id-qualified owner key — the
    /// key writers use once an arc has a creation id ([P01], [P03], Spec S02).
    /// Same fixture as the legacy-key case above; only the key differs.
    #[serial]
    #[test]
    fn test_arc_join_uses_id_keyed_draft_message() {
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

        let created = create("id-draft-arc", Some("Test".to_string()), false, None).unwrap();
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
        commit("id-draft-arc", "Add f", None).unwrap();

        join("id-draft-arc", mechanics()).unwrap();

        let log = tugcore::git_command()
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

    /// The join the CARD presses is executed by tugcast, which is nobody's
    /// session and exports no `TUG_SESSION_ID` — so the id travels in
    /// [`JoinOptions::session_id`] and the squash commit names both the session
    /// and the arc. Two trailers, which is the two pills a joined commit's
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
        let squash = tugcore::git_command()
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
            squash.contains("Tug-Arc: tugarc/card-join onto "),
            "and still names the arc: {squash}"
        );
    }

    /// The resolution ladder builds a candidate off to the side; `join_in` with
    /// `candidate` fast-forwards the base onto it and tears the arc down
    /// ([P31]). Uses the replay scenario: base advanced to the arc's first
    /// round, so the squash conflicts but replay is clean.
    #[serial]
    #[test]
    fn test_arc_join_lands_resolved_candidate() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();
        // Baseline file the arc and main both evolve.
        fs::write(repo.join("f.txt"), "A\n").unwrap();
        run_git(repo, &["add", "-A"]);
        run_git(repo, &["commit", "-m", "seed f"]);

        create("cand", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/cand");
        fs::write(worktree.join("f.txt"), "B\n").unwrap();
        commit("cand", "r1", None).unwrap();
        fs::write(worktree.join("f.txt"), "C\n").unwrap();
        commit("cand", "r2", None).unwrap();

        // Main independently advances to the arc's first-round state.
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
        assert!(!branch_present(repo, "tugarc/cand"), "branch deleted");
        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"));
    }

    /// The join's preconditions are what the execution enforces, and nothing
    /// else: a candidate rides along when one stands, the merge either applies
    /// or does not, and no verdict is consulted anywhere.
    ///
    /// This pins the deletion rather than the deleted thing. A stale verdict
    /// left on a live branch by an older build must not resurface as a
    /// refusal, and an arc that was never reconciled must not be stranded — a
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
        // branch config, naming this arc. Nothing reads it.
        run_git(
            repo,
            &[
                "config",
                "--replace-all",
                "branch.tugarc/unverified.tugjoinverified",
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
            .expect("a reconcile-clean arc joins with no verdict anywhere");
        assert!(landed.commit_hash.is_some());
        assert!(!worktree.exists(), "the join really ran");
    }

    /// A candidate built against a base head that has since moved must refuse to
    /// land — git's own `--ff-only` is the staleness guard ([P31]).
    #[serial]
    #[test]
    fn test_arc_join_stale_candidate_refused() {
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
        .unwrap_err()
        .to_string();
        assert!(err.contains("stale candidate"), "got: {err}");
        // Nothing torn down — the arc survives for a re-resolve.
        assert!(worktree.exists(), "worktree intact after refusal");
        assert!(branch_present(repo, "tugarc/cand"));
    }

    /// Intersection preflight ([P14]): base dirt blocks a join only when it
    /// touches a file the arc also changed; disjoint base dirt joins fine.
    #[serial]
    #[test]
    fn test_arc_join_intersecting_base_dirt_fails_but_disjoint_joins() {
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

        // An arc that changes shared.txt.
        create("isect", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/isect");
        fs::write(worktree.join("shared.txt"), "base\narc change\n").unwrap();
        commit("isect", "touch shared", None).unwrap();

        // Base dirt on the SAME file the arc changed → refuses, naming it.
        fs::write(repo.join("shared.txt"), "base\nlocal edit\n").unwrap();
        let blocked = join("isect", mechanics());
        assert!(blocked.is_err());
        let err = blocked.unwrap_err().to_string();
        assert!(err.contains("differs from this arc"), "{err}");
        assert!(err.contains("shared.txt"), "{err}");
        assert!(branch_present(repo, "tugarc/isect"));

        // Move the base dirt to a DISJOINT file → the join now succeeds.
        git_output(repo, &["checkout", "--", "shared.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base\nlocal edit\n").unwrap();
        let ok = join("isect", mechanics()).unwrap();
        assert!(ok.commit_hash.is_some());
        assert!(!branch_present(repo, "tugarc/isect"));
    }

    /// A join that conflicts leaves the base exactly as it found it, so the
    /// record it opened is dropped rather than left open forever. An op that
    /// survived would name a join that did not happen — and once an incomplete
    /// join op *means* a teardown to resume, it would refuse every later join
    /// of this arc with a `--continue` that has nothing to continue.
    #[serial]
    #[test]
    fn a_conflicted_join_records_no_op() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "clash");
        let repo = temp.path();

        // The base edits the same file the arc did, so the squash conflicts.
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
        let err = crate::oplog::undo_in(&root, Some("clash"))
            .unwrap_err()
            .to_string();
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
        .unwrap_err()
        .to_string();
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
        seed_arc_with_a_round(&temp, "offbase");
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
        seed_arc_with_a_round(&temp, "undome");
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

        join("undome", mechanics()).unwrap();
        assert_ne!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), base_tip);

        let out = crate::oplog::undo_in(repo, None).unwrap();

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

    #[serial]
    #[test]
    fn undo_refuses_when_the_base_moved_since_the_join() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "raced");
        let repo = temp.path();
        join("raced", mechanics()).unwrap();

        // Somebody committed on the base after the join. Resetting now would
        // destroy it, so the undo must decline rather than force.
        fs::write(repo.join("after.txt"), "landed later\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::undo_in(repo, None).unwrap_err().to_string();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            tip_now,
            "a refused undo changes nothing"
        );
        assert!(!branch_exists(repo, "tugarc/raced"));
    }

    #[serial]
    #[test]
    fn undo_is_offered_once_and_says_so_the_second_time() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "twice");
        let repo = temp.path();
        join("twice", mechanics()).unwrap();

        crate::oplog::undo_in(repo, None).unwrap();
        let err = crate::oplog::undo_in(repo, Some("twice"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("already-undone:"), "{err}");
    }

    #[serial]
    #[test]
    fn undo_refuses_an_operation_that_never_finished() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "halfway");
        let repo = temp.path();
        let before = crate::oplog::capture_before(repo, "halfway").unwrap();
        let tips = crate::oplog::tips_of(&before);
        crate::oplog::record_begin(repo, crate::oplog::OpVerb::Join, "halfway", before, &tips)
            .unwrap();

        let err = crate::oplog::undo_in(repo, Some("halfway"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("incomplete-op:"), "{err}");
    }

    #[serial]
    #[test]
    fn a_join_over_a_live_chain_is_refused_by_name_and_touches_nothing() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "leased");
        let repo = temp.path();
        let marker = lease_a_parked_conflict(repo, "leased");

        // Dirt the sweep would commit, so a refusal below it would be visible.
        let worktree = worktree_path(repo, "leased");
        fs::write(worktree.join("late.txt"), "not yet committed\n").unwrap();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/leased"]).unwrap();
        let ops_before = crate::oplog::list_ops(repo).len();

        let err = join("leased", mechanics()).unwrap_err().to_string();
        assert!(err.contains("A resolve may still be running"), "{err}");
        assert!(err.contains("--break-lease"), "{err}");
        assert!(err.contains("resolve again"), "{err}");

        assert_eq!(
            crate::resolve::read_conflict(repo, "leased").unwrap().tip,
            marker,
            "a refused join leaves the chain exactly as it found it"
        );
        assert_eq!(
            git_stdout(repo, &["rev-parse", "tugarc/leased"]).unwrap(),
            arc_tip,
            "the refusal is above the dirt sweep, so no round was committed"
        );
        assert_eq!(
            crate::oplog::list_ops(repo).len(),
            ops_before,
            "and nothing was recorded"
        );
        assert!(branch_exists(repo, "tugarc/leased"));
    }

    #[serial]
    #[test]
    fn a_preview_lists_live_resolve_as_a_blocker() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "leased");
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
        seed_arc_with_a_round(&temp, "released");
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
        seed_arc_with_a_round(&temp, "stale");
        let repo = temp.path();
        park_conflict(repo, "stale");

        let tip = crate::resolve::read_conflict(repo, "stale").unwrap().tip;
        let long_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 3 * 60 * 60;
        let out = tugcore::git_command()
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

    /// The same flag on the join: a chain whose resolver died, on an arc that
    /// now merges cleanly because the base moved on without it.
    #[serial]
    #[test]
    fn breaking_the_lease_lets_a_join_through() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "forced");
        let repo = temp.path();
        park_conflict(repo, "forced");
        crate::resolve::mark_resolve_begun(repo, "forced").unwrap();

        // The base takes its own edit back, so nothing is left to merge around
        // — the chain is stale, but the lease reads the tip, not validity.
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "base backs its edit out"]).unwrap();
        assert!(crate::resolve::resolve_lease(repo, "forced", SystemTime::now()).is_some());

        let refused = join("forced", mechanics()).unwrap_err().to_string();
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
        seed_arc_with_a_round(&temp, "chained");
        let repo = temp.path();
        park_conflict(repo, "chained");
        let (chain_tip, candidate) = resolve_parked_conflict(repo, "chained");

        // The join tears the arc down, and `clear_candidate` takes the
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

    /// Never over newer work: a fresh resolve between the join and its undo
    /// owns the ref, and restoring the older chain would destroy it.
    #[serial]
    #[test]
    fn undo_leaves_a_newer_conflict_chain_alone_and_says_both_tips() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "raced2");
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

    /// The whole round, on one arc, in one pass — every leg asserted rather
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
    fn the_whole_arc_runs_on_one_arc() {
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
        fs::write(worktree.join("doc.md"), "Heading\n=======\n\narc\n").unwrap();
        fs::write(worktree.join("code.rs"), "fn main() { arc() }\n").unwrap();
        commit("arc", "arc edits both", None).unwrap();

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
            let arc_head = git_stdout(repo, &["rev-parse", "tugarc/arc"]).unwrap();
            git_output(
                repo,
                &[
                    "config",
                    &crate::resolve::join_source_config_key("arc"),
                    &arc_head,
                ],
            )
            .unwrap();
            (tip, candidate)
        };
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/arc"]).unwrap();
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
        assert!(!branch_exists(repo, "tugarc/arc"));
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
            git_stdout(repo, &["rev-parse", "tugarc/arc"]).unwrap(),
            arc_tip
        );
        assert_eq!(
            crate::resolve::read_conflict(repo, "arc").map(|c| c.tip),
            Some(chain_tip),
            "including the conflict chain"
        );

        // Redo takes it away again.
        crate::oplog::redo_in(repo, None).unwrap();
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), landed);
        assert!(!branch_exists(repo, "tugarc/arc"));

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
        seed_arc_with_a_round(&temp, "cycle");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/cycle"]).unwrap();
        let base_before = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        join("cycle", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let undone = crate::oplog::undo_in(repo, None).unwrap();
        assert_eq!(
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            base_before
        );
        assert!(branch_exists(repo, "tugarc/cycle"));

        let redone = crate::oplog::redo_in(repo, None).unwrap();

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
            git_stdout(repo, &["rev-parse", "tugarc/cycle"]).unwrap(),
            arc_tip
        );
    }

    /// [L23]: a redo tears the worktree down, so uncommitted work started in
    /// the arc between the undo and the redo would be destroyed. It refuses
    /// and names the paths instead — and changes nothing on the way out.
    #[serial]
    #[test]
    fn redo_refuses_over_a_dirty_restored_worktree() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "dirty");
        let repo = temp.path();
        join("dirty", mechanics()).unwrap();
        let landed = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();
        let base_after_undo = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        assert_ne!(base_after_undo, landed);

        // The user started working in the arc the undo gave back.
        let worktree = worktree_path(repo, "dirty");
        fs::write(worktree.join("in-progress.txt"), "half a thought\n").unwrap();

        let err = crate::oplog::redo_in(repo, None).unwrap_err().to_string();

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
        seed_arc_with_a_round(&temp, "moved");
        let repo = temp.path();
        join("moved", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();

        fs::write(repo.join("later.txt"), "landed after the undo\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "later work"]).unwrap();
        let tip_now = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let err = crate::oplog::redo_in(repo, None).unwrap_err().to_string();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(git_stdout(repo, &["rev-parse", "main"]).unwrap(), tip_now);
    }

    #[serial]
    #[test]
    fn redo_refuses_when_a_newer_operation_ran_on_the_arc() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "busy");
        let repo = temp.path();
        join("busy", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();

        // A discard on the restored arc is newer work the redo would trample.
        discard("busy", None, false).unwrap();

        let err = crate::oplog::redo_in(repo, Some("busy"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("superseded:"), "{err}");
    }

    #[serial]
    #[test]
    fn redo_with_nothing_to_redo_says_so() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "fresh");
        let repo = temp.path();

        let err = crate::oplog::redo_in(repo, None).unwrap_err().to_string();
        assert!(err.starts_with("nothing-to-redo:"), "{err}");

        // And once an undo has been redone, there is nothing left to redo.
        join("fresh", mechanics()).unwrap();
        crate::oplog::undo_in(repo, None).unwrap();
        crate::oplog::redo_in(repo, None).unwrap();
        let err = crate::oplog::redo_in(repo, None).unwrap_err().to_string();
        assert!(err.starts_with("already-redone:"), "{err}");
    }

    /// The reachability claim redo rests on, made falsifiable: the undo records
    /// itself *before* it acts, so its keepalive parents the join's landed
    /// commit — which is why that commit survives its own undo.
    #[serial]
    #[test]
    fn the_landed_commit_survives_its_undo_through_the_undos_own_keepalive() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "reach");
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
        let err = crate::oplog::undo_in(&root, None).unwrap_err().to_string();
        assert!(err.starts_with("nothing-to-undo:"), "{err}");
    }

    #[serial]
    #[test]
    fn a_join_records_an_operation_that_outlives_the_branch_it_deleted() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "recorded");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", "tugarc/recorded"]).unwrap();
        let base_tip = git_stdout(repo, &["rev-parse", "main"]).unwrap();

        let landed = join("recorded", mechanics()).unwrap();

        let op = crate::oplog::list_ops(repo)
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

    #[serial]
    #[test]
    fn a_join_records_the_arc_tip_including_the_dirt_it_swept() {
        // The join sweeps outstanding worktree changes into a commit before it
        // integrates. A `before` captured any earlier would name the commit
        // below that sweep, and an undo would faithfully restore an arc missing
        // the swept work.
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "sweeper");
        let repo = temp.path();
        let before_sweep = git_stdout(repo, &["rev-parse", "tugarc/sweeper"]).unwrap();
        let worktree = repo.join(".tug/worktrees/sweeper");
        fs::write(worktree.join("late.txt"), "typed after the round\n").unwrap();

        join("sweeper", mechanics()).unwrap();

        let op = crate::oplog::list_ops(repo)
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

    #[serial]
    #[test]
    fn join_outcome_carries_the_message_it_committed() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "msg");
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

    /// The precedence a join walks silently, said out loud ([P05], Spec S03).
    #[serial]
    #[test]
    fn the_landing_preview_names_where_its_words_came_from() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "prov");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        // Neither a draft nor a description: the generic stand-in, and the
        // preview says so rather than letting it pass as authored.
        let (message, source) = landing_message_preview(repo, "prov", "tugarc/prov");
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
        let (message, source) = landing_message_preview(repo, "prov", "tugarc/prov");
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
        let (message, source) = landing_message_preview(repo, "prov", "tugarc/prov");
        assert_eq!(message, "tugarc(prov): The words the author chose");
        assert_eq!(source, LandingMessageSource::Draft);

        // And the preview is what the join would land, minus the trailers the
        // landing composes against its round set.
        let landed = integrate_message(repo, "prov", "tugarc/prov", None, None);
        assert!(landed.starts_with(&message), "{landed}");
    }

    #[serial]
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
    #[serial]
    #[test]
    fn a_worktree_keyed_row_is_still_found() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "legacy");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &arc_owner_key(repo, "legacy"),
            &canonical(&repo.join(".tug/worktrees/legacy")),
            "the draft nobody could read",
        );
        assert_eq!(
            arc_draft_message(repo, "tugarc/legacy").as_deref(),
            Some("the draft nobody could read")
        );
    }

    #[serial]
    #[test]
    fn the_base_root_row_wins_over_a_worktree_row() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "both");
        isolate_changes_db(&temp);
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
            arc_draft_message(repo, "tugarc/both").as_deref(),
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
    #[serial]
    #[test]
    fn a_gateway_keyed_row_is_found_from_another_spelling_of_the_root() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "spelled");
        isolate_changes_db(&temp);
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
            arc_draft_message(&link, "tugarc/spelled").as_deref(),
            Some("the words the author chose")
        );
    }

    /// A body may already open with this arc's scope — a draft authored in the
    /// conventional voice is the common case, and the doubled subject on the
    /// first real join is what the un-idempotent wrap looked like in the
    /// commit log.
    #[serial]
    #[test]
    fn integrate_message_does_not_double_this_arcs_own_prefix() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "idem");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
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
    #[serial]
    #[test]
    fn integrate_message_strips_a_foreign_scope() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "mine");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
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
    #[serial]
    #[test]
    fn integrate_message_leaves_an_inner_mention_alone() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "inner");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let body = "teach the linter about tugarc(name): prefixes";
        let out = integrate_message(repo, "inner", "tugarc/inner", Some(body.to_string()), None);
        assert!(out.starts_with(&format!("tugarc(inner): {body}")), "{out}");
    }

    /// A body that opens with the spelling but is not a scope — no closing
    /// paren, or no `: ` after it — is left whole rather than half-eaten.
    #[serial]
    #[test]
    fn integrate_message_leaves_a_malformed_scope_whole() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "malformed");
        isolate_changes_db(&temp);
        let repo = temp.path();

        for body in ["tugarc(unclosed work", "tugarc(x) no colon"] {
            let out = integrate_message(
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

    #[serial]
    #[test]
    fn integrate_message_wraps_an_unprefixed_body_and_the_bare_fallback() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "plain");
        isolate_changes_db(&temp);
        let repo = temp.path();

        let out = integrate_message(
            repo,
            "plain",
            "tugarc/plain",
            Some("a plain subject".to_string()),
            None,
        );
        assert!(out.starts_with("tugarc(plain): a plain subject"), "{out}");

        // No override, no draft row (the ledger is an empty tempdir path), and
        // no branch description — the bare fallback, still wrapped once.
        let fallback = integrate_message(repo, "plain", "tugarc/plain", None, None);
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
    #[serial]
    #[test]
    fn the_join_commits_the_authored_draft_byte_for_byte() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "pinned");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        let draft = "the subject the author wrote\n\nA body paragraph that must survive intact,\nincluding its own line breaks.";
        seed_draft_row(&db, &arc_owner_key(repo, "pinned"), &canonical(repo), draft);

        let landed = join("pinned", mechanics()).unwrap();
        let sha = landed.commit_hash.expect("a landed join has a commit");
        let committed = git_stdout(repo, &["log", "-1", "--format=%B", &sha]).unwrap();

        let expected = with_arc_trailers(
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
    #[serial]
    #[test]
    fn a_draft_that_already_carries_the_prefix_lands_it_once() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "once");
        isolate_changes_db(&temp);
        let repo = temp.path();
        let db = temp.path().join("changes.db");

        seed_draft_row(
            &db,
            &arc_owner_key(repo, "once"),
            &canonical(repo),
            "tugarc(once): the authored subject",
        );

        let landed = join("once", mechanics()).unwrap();
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

    #[serial]
    #[test]
    fn preflight_asked_from_a_linked_worktree_answers_about_the_main_root() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "linked");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/linked");

        // The arc's own worktree is checked out on `tugarc/linked`, which is
        // not the base. Asking from there must still answer about the
        // repository — a card whose project *is* a worktree would otherwise
        // read every arc as off-base while the CLI beside it reports clean.
        let from_worktree = join_preflight_in(&worktree, "linked").unwrap();
        assert!(from_worktree.is_empty(), "{from_worktree:?}");
        assert!(join_preflight_in(repo, "linked").unwrap().is_empty());
    }

    #[serial]
    #[test]
    fn preview_reports_intersecting_base_dirt_and_names_the_paths() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "dirt");
        let repo = temp.path();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "second"]).unwrap();

        // Dirt on a file the arc also changed → blocked, and named.
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
        seed_arc_with_a_round(&temp, "digs");
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
        seed_arc_with_a_round(&temp, "deep");
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
    /// so an arc mid-teardown previews with a blocker instead of erroring.
    #[serial]
    #[test]
    fn preview_reports_a_stale_journal() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "journalled");
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
            !b.detail.contains("tugarc join"),
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
        seed_arc_with_a_round(&temp, "inflight");
        let repo = temp.path();

        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(repo, "inflight", crate::oplog::JoinPhase::Integrated, &head);

        let detail = arc_detail_entry_in(repo, "inflight").expect("detail");
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
            "a join holding the arc opened that record: {:?}",
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
    fn preview_reports_empty_for_a_arc_with_no_rounds() {
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
    fn a_clean_arc_previews_with_no_blockers() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "clean");
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
        seed_arc_with_a_round(&temp, "agree");
        let repo = temp.path();

        let assert_agrees = |kind: &str| {
            let out = preview("agree");
            let b = blocker(&out, kind).unwrap_or_else(|| panic!("expected a {kind} blocker"));
            let err = join("agree", mechanics()).unwrap_err().to_string();
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

        // empty — an arc of its own, since the one above has a round.
        create("agree2", None, false, None).unwrap();
        let out = preview("agree2");
        let b = blocker(&out, "empty").expect("empty blocker");
        let err = join("agree2", mechanics()).unwrap_err().to_string();
        assert_eq!(err, b.detail);
    }

    #[serial]
    #[test]
    fn test_arc_join_wrong_branch_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test".to_string()), false, None).unwrap();
        tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["checkout", "-b", "feature"])
            .output()
            .unwrap();

        let result = join("test-arc", mechanics());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("on branch 'feature'"));
        assert!(err.contains("Check out 'main' first"));
        assert_eq!(checked_out_branch(repo), "feature");
    }

    #[serial]
    #[test]
    fn test_arc_join_already_gone_fails() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();
        commit("test-arc", "Add test", None).unwrap();
        join("test-arc", mechanics()).unwrap();

        // Joining again fails: the branch no longer exists.
        let result = join("test-arc", mechanics());
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

    #[serial]
    #[test]
    fn test_join_merge_strategy_makes_a_merge_commit() {
        let (_temp, repo) = repo_with_committed_arc("mrg");
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
    /// shape decided what the base's history looked like: a multi-round arc
    /// arrived on the base as N round commits with the authored draft dropped on
    /// the floor, because a fast-forward has no commit to put a message in. The
    /// candidate here is deliberately the arc branch tip — the exact shape rung
    /// 1 hands back — so this fails on the old code no matter what the ladder
    /// decides.
    #[serial]
    #[test]
    fn test_join_squashes_a_multi_commit_candidate_into_one_commit() {
        let (_temp, repo) = repo_with_committed_arc("cand");
        let worktree = repo.join(".tug/worktrees/cand");
        fs::write(worktree.join("g.txt"), "second\n").unwrap();
        commit("cand", "cand-round-2", None).unwrap();

        let before = git_stdout(&repo, &["rev-parse", "HEAD"]).unwrap();
        let candidate = git_stdout(&repo, &["rev-parse", "tugarc/cand"]).unwrap();
        let rounds = git_stdout(&repo, &["rev-list", "--count", "main..tugarc/cand"]).unwrap();
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
        assert_eq!(subject, "tugarc(cand): the authored subject");

        // Both rounds' bytes are present — squashing the shape never drops work.
        for (rel, want) in [("f.txt", "arc"), ("g.txt", "second")] {
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
        let (_temp, repo) = repo_with_committed_arc("candrb");
        let worktree = repo.join(".tug/worktrees/candrb");
        fs::write(worktree.join("g.txt"), "second\n").unwrap();
        commit("candrb", "candrb-round-2", None).unwrap();

        let before = git_stdout(&repo, &["rev-parse", "HEAD"]).unwrap();
        let candidate = git_stdout(&repo, &["rev-parse", "tugarc/candrb"]).unwrap();
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
        let (_temp, repo) = repo_with_committed_arc("rb");
        join(
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
        fs::write(worktree.join("conflict.txt"), "arc line\n").unwrap();
        commit("pv", "arc edit", None).unwrap();

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
        assert!(branch_present(repo, "tugarc/pv"));
        assert!(worktree.exists());
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), base_head);
    }

    #[serial]
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
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("resume", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/resume");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("resume", "add f", None).unwrap();

        // Do the integrate by hand, then record it as if we crashed next.
        git_output(repo, &["merge", "--squash", "tugarc/resume"]).unwrap();
        git_output(repo, &["commit", "-m", "tugarc(resume): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        // `join` resolves the repo via `find_repo_root` (canonical), so the
        // record must be written to the canonical state dir to be found.
        let canon = fs::canonicalize(repo).unwrap();
        let seq = seed_interrupted_join(repo, "resume", crate::oplog::JoinPhase::Integrated, &head);
        assert!(worktree.exists());
        assert!(branch_present(repo, "tugarc/resume"));

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
            !branch_present(repo, "tugarc/resume"),
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
        let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(dlog.contains("joined"), "arc log records the join: {dlog}");
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
            git_output(repo, &["merge", "--squash", "tugarc/phased"]).unwrap();
            git_output(repo, &["commit", "-m", "tugarc(phased): add f"]).unwrap();
            let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
            let seq = seed_interrupted_join(repo, "phased", phase, &head);
            let canon = fs::canonicalize(repo).unwrap();
            if phase != crate::oplog::JoinPhase::Integrated {
                let mut warnings = Vec::new();
                remove_arc_worktree(repo, "tugarc/phased", &worktree, &mut warnings);
            }
            if phase == crate::oplog::JoinPhase::BranchDeleted {
                git_output(repo, &["branch", "-D", "tugarc/phased"]).unwrap();
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
                !branch_present(repo, "tugarc/phased"),
                "{phase:?}: branch gone"
            );
            let dlog = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
            assert!(dlog.contains("joined"), "{phase:?}: arc log records it");
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
    /// is refused by name rather than re-running a teardown over an arc that no
    /// longer exists.
    #[serial]
    #[test]
    fn continue_twice_is_a_named_refusal() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "twice");

        join("twice", mechanics()).unwrap();
        let err = join(
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
    #[serial]
    #[test]
    fn a_finished_join_keeps_its_progress_on_the_record() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "receipt");
        let repo = temp.path();
        let canon = fs::canonicalize(repo).unwrap();

        let out = join("receipt", mechanics()).unwrap();
        let op = crate::oplog::list_ops(&canon)
            .into_iter()
            .find(|op| op.arc == "receipt" && op.verb == crate::oplog::OpVerb::Join)
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

        git_output(repo, &["merge", "--squash", "tugarc/halfway"]).unwrap();
        git_output(repo, &["commit", "-m", "tugarc(halfway): add f"]).unwrap();
        let head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        seed_interrupted_join(repo, "halfway", crate::oplog::JoinPhase::Integrated, &head);
        let canon = fs::canonicalize(repo).unwrap();

        let err = crate::oplog::undo_in(&canon, Some("halfway"))
            .unwrap_err()
            .to_string();
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
        assert!(branch_present(repo, "tugarc/halfway"), "the arc is back");
    }

    /// Every blocker kind, asserted identical between the composed path the
    /// card uses and the preflight the CLI uses — the anti-drift pin. Two
    /// definitions of "what refuses a join" is how the card and the terminal
    /// came to disagree in the first place.
    #[serial]
    #[test]
    fn composed_blockers_match_the_preflight_for_every_kind() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "kinds");
        let repo = temp.path();

        let composed = || {
            let detail = arc_detail_entry_in(repo, "kinds").expect("detail");
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

        // base-dirt, untracked: the arc must also change that path, so it is
        // the untracked *overwrite* case rather than unrelated base dirt.
        let worktree = repo.join(".tug/worktrees/kinds");
        fs::write(worktree.join("fresh.txt"), "from the arc\n").unwrap();
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

        // empty: an arc with no rounds and no tracked worktree dirt.
        create("hollow", None, false, None).unwrap();
        let hollow_detail = arc_detail_entry_in(repo, "hollow").expect("detail");
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
    /// moving. This is the exact defect a `(base_sha, arc_head_sha)` cache
    /// would hide: both SHAs are unchanged across the whole test, and the right
    /// answer changes twice.
    #[serial]
    #[test]
    fn blockers_track_dirt_that_moves_no_sha() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "nosha");
        let repo = temp.path();

        let heads = || {
            (
                git_stdout(repo, &["rev-parse", "main"]).unwrap(),
                git_stdout(repo, &["rev-parse", "tugarc/nosha"]).unwrap(),
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
    /// that they are there. A base copy holding exactly what the arc carries
    /// is `identical`, and everything downstream turns on that being read from
    /// the objects rather than assumed from the fact of the dirt.
    #[serial]
    #[test]
    fn an_overlap_says_whether_the_base_copy_is_the_arcs_own_bytes() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "relation");
        let repo = temp.path();

        // The base's copy IS the arc's version, to the byte — the shape a
        // note written on main from the arc's own work leaves behind.
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        let detail = arc_detail_entry_in(repo, "relation").expect("detail");
        assert_eq!(overlap_paths(&detail.base_overlap), vec!["shared.txt"]);
        assert_eq!(
            detail.base_overlap[0].relation, OVERLAP_IDENTICAL,
            "the same bytes the arc carries"
        );

        // A byte apart is other work, and the reading says so.
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let detail = arc_detail_entry_in(repo, "relation").expect("detail");
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

    /// A base copy the arc already carries is not a refusal — it is the
    /// arc's own edit sitting on the base, and the join drops it and lands
    /// the same bytes. The blocker never appears, the join runs, and what was
    /// dropped is reported rather than done quietly.
    #[serial]
    #[test]
    fn an_identical_base_copy_does_not_block_the_join() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "echo");
        let repo = temp.path();

        // Main holds, uncommitted, exactly what the arc committed.
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();
        assert!(
            join_preflight_in(repo, "echo")
                .unwrap()
                .iter()
                .all(|b| b.kind != "base-dirt"),
            "the arc's own bytes on the base refuse nothing"
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
            "base\narc change\n"
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
        seed_arc_with_a_round(&temp, "otherwork");
        let repo = temp.path();

        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let err = join("otherwork", mechanics()).unwrap_err().to_string();
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
    #[serial]
    #[test]
    fn a_foreign_hand_on_the_overlap_names_its_holder() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "contended");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();

        let detail = arc_detail_entry_in(repo, "contended").expect("detail");
        let current = git_stdout(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        // With no attribution view — a person at a terminal — it reads as the
        // user's own, which is the right default for their own checkout.
        let mine = join_blockers_from_detail(repo, &detail, &current, None, &BTreeMap::new());
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
        let theirs = join_blockers_from_detail(repo, &detail, &current, None, &held);
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
        let detail = arc_detail_entry_in(repo, "contended").expect("detail");
        assert!(
            join_blockers_from_detail(repo, &detail, &current, None, &held)
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
    #[serial]
    #[test]
    fn resolve_base_folds_the_users_own_edit_onto_the_base() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "fold");
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

        // The op records what it folded, which is what makes the receipt
        // durable: every surface that reports the act reads it back from here
        // rather than from the frame that announced it.
        let recorded = crate::oplog::list_ops(repo)
            .into_iter()
            .find(|op| op.verb == crate::oplog::OpVerb::ResolveBase)
            .expect("the fold recorded an op");
        let after = recorded.after.expect("it completed");
        assert_eq!(after.folded, vec!["shared.txt".to_string()]);
        assert!(after.dropped.is_empty());
        assert!(after.folded_from.is_empty(), "nobody else held it");

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

    /// A resolve folds another session's work with the rest — committing it
    /// preserves it — and both the commit's message and the outcome say whose
    /// it was, so the holder can be told.
    #[serial]
    #[test]
    fn resolve_base_folds_another_sessions_edit_and_names_it() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "notmine");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nsomebody else\n").unwrap();
        let held = BTreeMap::from([("shared.txt".to_string(), "^ink-anchor".to_string())]);

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        let outcome = resolve_base_in(repo, "notmine", &held).expect("folds");
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
    #[serial]
    #[test]
    fn resolve_base_drops_an_echo_without_committing() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "echofold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\narc change\n").unwrap();

        let outcome = resolve_base_in(repo, "echofold", &BTreeMap::new()).expect("resolves");
        assert_eq!(outcome.dropped, vec!["shared.txt"]);
        assert!(outcome.folded.is_empty());
        assert!(outcome.committed.is_none(), "nothing to commit");
        assert!(dirty_tracked_paths(repo).is_empty());
    }

    /// A landing that loses the base's index lock to a writer about to finish
    /// retries and lands.
    #[serial]
    #[test]
    fn a_join_whose_landing_loses_the_lock_retries_and_lands() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "contendedbase");
        let repo = temp.path();

        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * 3);
        let outcome = join("contendedbase", mechanics()).expect("lands past the lock");
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
    #[serial]
    #[test]
    fn a_lock_held_past_the_window_leaves_the_base_untouched() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "lockedbase");
        let repo = temp.path();
        fs::write(repo.join("notes.txt"), "committed\n").unwrap();
        git_output(repo, &["add", "notes.txt"]).unwrap();
        git_output(repo, &["commit", "-m", "notes"]).unwrap();
        fs::write(repo.join("notes.txt"), "the user's own edit\n").unwrap();

        let files = ["shared.txt", "notes.txt"];
        let before = base_snapshot(repo, &files);
        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * (INDEX_LOCK_ATTEMPTS * 2));
        let err = join("lockedbase", mechanics()).unwrap_err().to_string();
        let after = base_snapshot(repo, &files);
        held.join().unwrap();

        assert!(err.contains("index.lock"), "git's own message: {err}");
        assert_eq!(before, after, "the base is byte-identical");
        assert!(!after.4, "no SQUASH_MSG");
        assert!(
            ops_for(repo, "lockedbase").is_empty(),
            "and nothing is recorded"
        );

        let outcome = join("lockedbase", mechanics()).expect("lands once the lock is gone");
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
    #[serial]
    #[test]
    fn a_rebase_whose_fast_forward_loses_the_lock_still_fast_forwards() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "lockedff");
        let repo = temp.path();
        let arc_tip = git_stdout(repo, &["rev-parse", &branch_name("lockedff")]).unwrap();

        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * 3);
        let outcome = join(
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
    #[serial]
    #[test]
    fn squash_and_merge_land_the_same_tree_and_message_shape() {
        for (name, strategy, parent_count) in [
            ("shapesquash", JoinStrategy::Squash, 1),
            ("shapemerge", JoinStrategy::Merge, 2),
        ] {
            let temp = TempDir::new().unwrap();
            seed_arc_with_a_round(&temp, name);
            let repo = temp.path();
            let branch = branch_name(name);
            let base_head = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
            let arc_tip = git_stdout(repo, &["rev-parse", &branch]).unwrap();
            let arc_tree = git_stdout(repo, &["rev-parse", &format!("{branch}^{{tree}}")]).unwrap();

            join(
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
            let body = tugcore::git_command()
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
    #[serial]
    #[test]
    fn a_failed_abort_is_recorded_as_a_stranded_base_and_resolve_base_clears_it() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "strand");
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
        let err = join("strand", rebase()).unwrap_err().to_string();
        assert!(err.contains("could not be proven untouched"), "{err}");
        assert!(err.contains("CHERRY_PICK_HEAD is standing"), "{err}");
        assert!(err.contains("tugtool arc resolve-base strand"), "{err}");

        let root = std::fs::canonicalize(repo).unwrap();
        let op = crate::oplog::stranded_join(&root, "strand").expect("the record is kept");
        assert!(op.after.is_none(), "it landed nothing");
        assert_eq!(op.before.base_tip, base_tip);

        // Every other door reads the record rather than guessing.
        let again = join("strand", rebase()).unwrap_err().to_string();
        assert!(again.starts_with("stranded-base:"), "{again}");
        let undo = crate::oplog::undo_in(repo, Some("strand"))
            .unwrap_err()
            .to_string();
        assert!(undo.starts_with("stranded-base:"), "{undo}");

        // The lock's holder is gone; resolve-base re-runs the abort.
        fs::remove_file(Path::new(&git_dir).join("index.lock")).unwrap();
        let outcome = resolve_base_in(repo, "strand", &BTreeMap::new()).expect("clears");
        assert!(
            outcome.warnings.iter().any(|w| w.contains("Cleared")),
            "{:?}",
            outcome.warnings
        );
        assert!(crate::oplog::stranded_join(&root, "strand").is_none());
        assert!(standing_integrate_markers(repo).is_empty());
        assert_eq!(git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(), base_tip);
        assert!(dirty_tracked_paths(repo).is_empty());

        // And the join is a join again: with the driver gone it reports the
        // conflict, the base untouched and nothing recorded.
        git_output(repo, &["config", "--unset", "merge.strand.driver"]).unwrap();
        let outcome = join("strand", rebase()).expect("runs");
        assert_eq!(outcome.conflicts, vec!["shared.txt"]);
        assert!(ops_for(repo, "strand").is_empty());
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
    #[serial]
    #[test]
    fn the_doctor_names_a_squash_stranded_on_the_base() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "leftstaged");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/leftstaged");
        for n in 0..10 {
            fs::write(worktree.join(format!("file{n}.txt")), format!("arc {n}\n")).unwrap();
        }
        commit("leftstaged", "add ten files", None).unwrap();
        let root = std::fs::canonicalize(repo).unwrap();
        assert!(crate::doctor::diagnose(&root, "leftstaged").healthy());

        let merged = git_output(repo, &["merge", "--squash", &branch_name("leftstaged")]).unwrap();
        assert!(merged.status.success());
        git_output(repo, &["checkout", "HEAD", "--", "shared.txt"]).unwrap();

        let diagnosis = crate::doctor::diagnose(&root, "leftstaged");
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

        resolve_base_in(repo, "leftstaged", &BTreeMap::new()).expect("one call clears it");
        let diagnosis = crate::doctor::diagnose(&root, "leftstaged");
        assert!(diagnosis.healthy(), "{:?}", diagnosis.findings);
        assert!(standing_integrate_markers(repo).is_empty());
    }

    /// Somebody's own `git merge --squash` of some other branch is theirs: the
    /// doctor reads the base for *this arc's* marks and reports none.
    #[serial]
    #[test]
    fn a_squash_msg_that_is_not_this_arcs_is_not_a_finding() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "bystander");
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
        let diagnosis = crate::doctor::diagnose(&root, "bystander");
        assert!(diagnosis.healthy(), "{:?}", diagnosis.findings);
    }

    /// The other two marks: the stranded record and an operation with no
    /// `after`, each named with the verb that clears it, and each cleared.
    #[serial]
    #[test]
    fn the_doctor_names_a_stranded_record_and_an_unfinished_operation() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "records");
        let repo = temp.path();
        let root = std::fs::canonicalize(repo).unwrap();
        let open = |verb| {
            let before = crate::oplog::capture_before(&root, "records").unwrap();
            let tips = crate::oplog::tips_of(&before);
            crate::oplog::record_begin(&root, verb, "records", before, &tips).unwrap()
        };
        let stranded = open(crate::oplog::OpVerb::Join);
        crate::oplog::record_stranded(
            &root,
            stranded,
            crate::oplog::StrandedBase {
                paths: vec!["shared.txt".to_string()],
                found: "SQUASH_MSG is standing".to_string(),
            },
        )
        .unwrap();
        open(crate::oplog::OpVerb::ResolveBase);

        let diagnosis = crate::doctor::diagnose(&root, "records");
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

        resolve_base_in(repo, "records", &BTreeMap::new()).expect("clears both");
        assert!(crate::doctor::diagnose(&root, "records").healthy());
    }

    /// A base copy *staged as new* is in the index and absent from HEAD, so
    /// `checkout HEAD --` has nothing to restore it to. The drop takes the
    /// index entry with the file, and the join lands over it.
    #[serial]
    #[test]
    fn a_join_lands_over_an_identical_staged_new_base_copy() {
        let temp = TempDir::new().unwrap();
        seed_arc_that_adds_files(&temp, "stagednew");
        let repo = temp.path();
        fs::write(repo.join("added.txt"), "new in the arc\n").unwrap();
        git_output(repo, &["add", "added.txt"]).unwrap();

        let outcome = join("stagednew", mechanics()).expect("the join runs over a staged-new echo");
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
    #[serial]
    #[test]
    fn resolve_base_clears_a_whole_staged_squash_in_one_call() {
        let temp = TempDir::new().unwrap();
        seed_arc_that_adds_files(&temp, "stranded");
        let repo = temp.path();
        let merged = git_output(repo, &["merge", "--squash", &branch_name("stranded")]).unwrap();
        assert!(merged.status.success(), "the squash staged");

        let outcome = resolve_base_in(repo, "stranded", &BTreeMap::new()).expect("resolves");
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
    #[serial]
    #[test]
    fn a_drop_that_fails_midway_leaves_the_base_as_it_was() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        seed_arc_that_adds_files(&temp, "halfdrop");
        let repo = temp.path();
        // An executable file the arc adds: the one shape whose mode no index
        // entry records, since the base's copy of it is untracked.
        let worktree = repo.join(".tug/worktrees/halfdrop");
        fs::write(worktree.join("alpha.sh"), "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(worktree.join("alpha.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        commit("halfdrop", "add a script", None).unwrap();
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
        let err = resolve_base_in(repo, "halfdrop", &BTreeMap::new())
            .unwrap_err()
            .to_string();
        let after = snapshot();
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o755)).unwrap();

        assert!(err.contains("nested/extra.txt"), "{err}");
        assert!(err.contains("left as it was"), "{err}");
        assert_eq!(before, after, "index and files are byte-identical");
        let root = std::fs::canonicalize(repo).unwrap();
        assert!(
            crate::oplog::list_ops(&root)
                .iter()
                .all(|op| op.after.is_some() || op.verb != crate::oplog::OpVerb::ResolveBase),
            "no resolve-base payload is left without an `after`"
        );

        // The same failure on the join path drops the record it opened too.
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o555)).unwrap();
        let err = join("halfdrop", mechanics()).unwrap_err().to_string();
        let after = snapshot();
        fs::set_permissions(repo.join("nested"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("left as it was"), "{err}");
        assert_eq!(before, after, "the join's failed drop moved nothing either");
        assert!(
            ops_for(repo, "halfdrop").is_empty(),
            "and left no join record"
        );
    }

    /// Undo beside the receipt puts the edit back where it was: the base at
    /// its pre-fold tip and the file dirty again, which is the whole of what
    /// the button promises.
    ///
    /// These two live here rather than in `oplog.rs` because a real fold needs
    /// a real arc, and `seed_arc_with_a_round` is the fixture that builds one.
    #[serial]
    #[test]
    fn undo_resolve_base_in_reverses_a_standing_fold() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "undofold");
        let repo = temp.path();
        fs::write(repo.join("shared.txt"), "base\nmy own edit\n").unwrap();

        let before_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();
        resolve_base_in(repo, "undofold", &BTreeMap::new()).expect("folds");
        assert!(dirty_tracked_paths(repo).is_empty(), "the fold cleared it");

        crate::oplog::undo_resolve_base_in(repo, "undofold").expect("undoes");

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
    #[serial]
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
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();
        fs::write(repo.join("shared.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        git_output(repo, &["add", "."]).unwrap();
        git_output(repo, &["commit", "-m", "seed"]).unwrap();
        create("foldjoin", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/foldjoin");
        fs::write(worktree.join("shared.txt"), "TOP\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        commit("foldjoin", "touch the top", None).unwrap();
        fs::write(repo.join("shared.txt"), "1\n2\n3\n4\n5\n6\n7\nBOTTOM\n").unwrap();

        resolve_base_in(repo, "foldjoin", &BTreeMap::new()).expect("folds");
        let joined = join_in(repo, "foldjoin", mechanics()).expect("joins");
        assert!(joined.commit_hash.is_some(), "the join landed: {joined:?}");
        let joined_tip = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        let err = crate::oplog::undo_resolve_base_in(repo, "foldjoin")
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
    #[serial]
    #[test]
    fn worktree_dirt_counts_toward_the_overlap_the_join_will_hit() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "wtdirt");
        let repo = temp.path();

        // A path the arc has NOT committed, only dirtied in its worktree.
        let worktree = repo.join(".tug/worktrees/wtdirt");
        fs::write(worktree.join("other.txt"), "arc uncommitted\n").unwrap();
        git_output(&worktree, &["add", "other.txt"]).unwrap();
        fs::write(repo.join("other.txt"), "base uncommitted\n").unwrap();
        git_output(repo, &["add", "other.txt"]).unwrap();

        let detail = arc_detail_entry_in(repo, "wtdirt").expect("detail");
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
        seed_arc_with_a_round(&temp, "probe");
        let repo = temp.path();

        // Make the base conflict with the arc on the same path.
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
            probe.arc_sha,
            git_stdout(repo, &["rev-parse", "tugarc/probe"]).unwrap()
        );
    }
}
