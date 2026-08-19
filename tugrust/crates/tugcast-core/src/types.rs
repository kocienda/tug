//! Data types for filesystem and git feeds
//!
//! This module provides the core data structures for snapshot feeds,
//! serialized as JSON payloads in WebSocket frames.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Filesystem event types
///
/// Represents changes detected by the filesystem watcher.
/// Serialized with serde's `tag` attribute to produce tagged JSON
/// format: `{"kind": "Created", "path": "..."}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FsEvent {
    /// File or directory was created
    Created {
        /// Relative path from the watched directory
        path: String,
    },
    /// File or directory was modified
    Modified {
        /// Relative path from the watched directory
        path: String,
    },
    /// File or directory was removed
    Removed {
        /// Relative path from the watched directory
        path: String,
    },
    /// File or directory was renamed
    Renamed {
        /// Original path before rename
        from: String,
        /// New path after rename
        to: String,
    },
}

/// Git repository status snapshot
///
/// Represents the current state of a git repository, including branch info,
/// tracking status, and working tree changes. Serialized as JSON with
/// snake_case field names to match git porcelain output conventions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitStatus {
    /// Current branch name, or "(detached)" if HEAD is detached
    pub branch: String,
    /// Number of commits ahead of upstream
    pub ahead: u32,
    /// Number of commits behind upstream
    pub behind: u32,
    /// Files staged for commit
    pub staged: Vec<FileStatus>,
    /// Files with unstaged changes
    pub unstaged: Vec<FileStatus>,
    /// Untracked files
    pub untracked: Vec<String>,
    /// SHA of HEAD commit
    pub head_sha: String,
    /// Subject line of HEAD commit
    pub head_message: String,
}

/// File status entry for git staging area
///
/// Represents a single file's status in the git working tree or index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileStatus {
    /// Relative path from repository root
    pub path: String,
    /// Git status code (M=modified, A=added, D=deleted, R=renamed, etc.)
    pub status: String,
}

/// How a file changed, relative to `HEAD`, in a `git diff` payload.
///
/// Serialized lowercase (`"added"`, `"modified"`, `"deleted"`, `"renamed"`)
/// so the tugdeck `/diff` accordion can label each file's trigger directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffFileStatus {
    /// New file (`new file mode` in the diff header).
    Added,
    /// Content (or mode) changed in place.
    Modified,
    /// File removed (`deleted file mode`).
    Deleted,
    /// Tracked-path rename (`rename from` / `rename to`), possibly with edits.
    Renamed,
}

/// One changed file within a `git diff HEAD` payload.
///
/// `unified` is that file's complete unified-diff chunk, verbatim from git
/// (the `diff --git` / `index` preamble through the last hunk line). The
/// tugdeck client feeds it straight to `DiffBlock` as `{source:"unified"}` —
/// the parser skips every line before the first `@@`, so the preamble is
/// harmless and the chunk stays the faithful single-file diff.
///
/// `added` / `removed` count the `+` / `-` body lines (not the `+++` / `---`
/// headers); for a binary file both are `0` and `binary` is `true`.
///
/// `hunks` carries the content-hash id of each hunk of `unified`, in hunk
/// order, so a client can key a per-hunk control without deriving identity
/// itself — the ids are computed in Rust only. It is empty for files no hunk
/// election can address (binary files, and created files, whose diff is
/// synthesized rather than parsed from the index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitDiffFile {
    /// Path relative to the repo root (the rename *destination* when renamed).
    pub path: String,
    /// Original path for a rename; `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// How the file changed.
    pub status: GitDiffFileStatus,
    /// Count of added (`+`) body lines.
    pub added: u32,
    /// Count of removed (`-`) body lines.
    pub removed: u32,
    /// True when git reported a binary file (no textual hunks).
    pub binary: bool,
    /// The file's complete unified-diff chunk, verbatim from git.
    pub unified: String,
    /// Content-hash id per hunk of `unified`, in hunk order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hunks: Vec<String>,
}

/// A single-shot `git diff HEAD` payload, delivered on the GIT_DIFF feed
/// (0x21) in response to a GIT_DIFF_QUERY (0x22).
///
/// `request_id` echoes the query's correlation id and `workspace_key`
/// identifies the project dir the diff was computed in (the dir behind the
/// Z4B GIT-status chip), so the client can match the response to the card
/// that asked. `base` is the ref the working tree was compared against
/// (`"HEAD"`). The `total_*` / `file_count` summary mirrors Claude Code's
/// "N files changed +X −Y" header and equals the sum across `files`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitDiffSnapshot {
    /// Correlation id echoed from the request.
    pub request_id: String,
    /// Canonical key of the workspace the diff was computed in.
    pub workspace_key: String,
    /// The ref the working tree was diffed against (currently `"HEAD"`).
    pub base: String,
    /// True when the project dir is **not** inside a git working tree — so the
    /// client can say "not a git repository" rather than misreport a clean
    /// tree. `files` is empty in that case.
    #[serde(default)]
    pub no_repo: bool,
    /// Number of changed files (`files.len()`).
    pub file_count: u32,
    /// Total added lines across all files.
    pub total_added: u32,
    /// Total removed lines across all files.
    pub total_removed: u32,
    /// One entry per changed file, in git's output order.
    pub files: Vec<GitDiffFile>,
}

/// A single commit in a [`GitLogSnapshot`]. The wire carries structured fields
/// so the client can format them and later hang per-commit affordances off the
/// full `sha` without a wire change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitLogCommit {
    /// Full 40-char commit hash. Clients shorten for display.
    pub sha: String,
    /// The commit subject line (`%s`).
    pub subject: String,
    /// The commit message body (`%b`) — everything after the subject, verbatim,
    /// with trailing whitespace trimmed. Empty for a subject-only commit. A
    /// History row reveals it on expand.
    #[serde(default)]
    pub body: String,
    /// Author name (`%an`) — the compact identity shown on the collapsed row.
    pub author: String,
    /// Author date, `--date=short` (`YYYY-MM-DD`) — the compact date on the row.
    pub date: String,
    /// Committer name (`%cn`) — the full identity a History row reveals on
    /// expand (usually equal to `author`; differs for a rebase / cherry-pick).
    #[serde(default)]
    pub committer: String,
    /// Committer email (`%ce`) — shown beside the committer name on expand.
    #[serde(default)]
    pub committer_email: String,
    /// Committer date, strict ISO 8601 (`%cI`) — the complete timestamp the
    /// expanded row formats for display. Independent of the `--date` flag.
    #[serde(default)]
    pub committer_date: String,
    /// The `Tug-Dash:` trailer value (`tugdash/<name> onto <base>`) when the
    /// commit landed as a dash join — the History join badge ([P09]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tug_dash: Option<String>,
    /// The `Tug-Session:` trailer value — the human citation, raw ([P10],
    /// Spec S03). New-form commits carry `<tag> (<shortid8>)`; legacy commits
    /// carry `<display> (<full-uuid>)`, and both must parse, since legacy
    /// commits live in history forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tug_session: Option<String>,
    /// The `Tug-Session-Id:` trailer value — the full tug session uuid, the
    /// exact ledger join. Machine-only; never displayed. Absent on every
    /// legacy commit, which resolve through the parenthesized token in
    /// `tug_session` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tug_session_id: Option<String>,
    /// The commit's changed paths (`--name-only`), repo-relative. Paths ONLY —
    /// the per-file statuses and line counts stay on the `GIT_COMMIT_FILES`
    /// route the expanded row asks for. They ride the log so the History
    /// filter can match a commit by the files it touched without a fan-out of
    /// one request per row. Empty for a merge commit (`--name-only` states no
    /// files for one) and for an empty commit.
    #[serde(default)]
    pub files: Vec<String>,
}

/// A HEAD-moved signal, broadcast on the GIT_HEAD feed (0x27) whenever a
/// workspace's HEAD changes (a commit, checkout, reset, merge, rebase — from
/// any source, detected by watching the git dir). It carries no log payload:
/// a git-log consumer scoped to `workspace_key` re-requests the log on receipt.
/// `head` is the new HEAD sha (or `""` for an unborn/`no_repo` state) so a
/// consumer can dedup redundant signals.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitHeadSignal {
    /// Canonical key of the workspace whose HEAD moved.
    pub workspace_key: String,
    /// The new HEAD sha, or `""` when unborn / not a repo.
    pub head: String,
}

/// A single-shot recent-commits payload, delivered on the GIT_LOG feed (0x25)
/// in response to a GIT_LOG_QUERY (0x26).
///
/// `request_id` echoes the query's correlation id and `workspace_key`
/// identifies the project dir the log was read in, so the client can match the
/// broadcast response to the request that asked. `branch` is the current
/// branch (`git branch --show-current`), `"(detached)"` when detached, and
/// `""` when `no_repo`. `commits` is most-recent-first, capped at the request's
/// `limit`.
///
/// The log is paged: `offset` echoes how many commits the request skipped and
/// `has_more` says whether the walk continued past this page, which is what a
/// load-on-scroll client needs to decide whether to ask for another one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitLogSnapshot {
    /// Correlation id echoed from the request.
    pub request_id: String,
    /// Canonical key of the workspace the log was read in.
    pub workspace_key: String,
    /// Current branch (`git branch --show-current`), `"(detached)"` when
    /// detached, `""` when `no_repo`.
    pub branch: String,
    /// True when the project dir is **not** inside a git working tree — so the
    /// client can say "not a git repository". `commits` is empty in that case.
    #[serde(default)]
    pub no_repo: bool,
    /// How many commits this page skipped, echoed from the request. `0` is the
    /// first page; a client appends any higher offset to what it already holds
    /// rather than replacing it.
    #[serde(default)]
    pub offset: u32,
    /// True when at least one commit exists past this page — the walk was cut
    /// by `limit`, not by the end of history. `false` means the client has
    /// reached the root commit and must stop asking.
    #[serde(default)]
    pub has_more: bool,
    /// Most-recent-first commits, at most the request's `limit`.
    pub commits: Vec<GitLogCommit>,
}

/// One changed file in a [`GitCommitFilesSnapshot`] — a commit's name-status
/// entry joined with its numstat counts. `status` ∈
/// `created|modified|deleted|renamed`; `added`/`removed` are `0` for a binary
/// file. Mirrors the `/commit` receipt's frozen file record so the History
/// row's expanded list reuses the same client component.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitCommitFile {
    /// Path relative to the repo root (the rename destination when renamed).
    pub path: String,
    /// Name-status word: `created` | `modified` | `deleted` | `renamed`.
    pub status: String,
    /// Added (`+`) line count; `0` for a binary file.
    pub added: u32,
    /// Removed (`−`) line count; `0` for a binary file.
    pub removed: u32,
}

/// A single-shot changed-files payload for one commit, delivered on the
/// GIT_COMMIT_FILES feed (0x28) in response to a GIT_COMMIT_FILES_QUERY (0x29).
///
/// `request_id` echoes the query's correlation id; `sha` is the commit the
/// files belong to; `workspace_key` identifies the project dir the commit was
/// read in. A missing sha (rebase, gc) or a non-git dir yields empty `files`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitCommitFilesSnapshot {
    /// Correlation id echoed from the request.
    pub request_id: String,
    /// Canonical key of the workspace the commit was read in.
    pub workspace_key: String,
    /// The commit sha whose files these are.
    pub sha: String,
    /// True when the project dir is **not** inside a git working tree.
    #[serde(default)]
    pub no_repo: bool,
    /// The commit's subject line (`%s`). Empty when the sha resolves to
    /// nothing, and on payloads written before the field existed — a reader
    /// shows what it has rather than asserting an empty commit message.
    #[serde(default)]
    pub subject: String,
    /// Author name (`%an`), for the same reason and with the same default.
    #[serde(default)]
    pub author: String,
    /// Author date, `--date=short` (`YYYY-MM-DD`).
    #[serde(default)]
    pub date: String,
    /// One entry per changed file, in git's output order.
    pub files: Vec<GitCommitFile>,
}

/// One file inside a changeset entry on the CHANGESET feed (0x23).
///
/// `git_status` is the porcelain-v2 XY pair for working-tree files, or the
/// name-status letter for a dash's `base..branch` files. `op` / `origin`
/// carry the attribution provenance recorded in `file_events`; `shared`
/// marks files owned by more than one changeset (per-file contention, the
/// only cross-session signal) — excluded from the card's default commit
/// selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangesetFile {
    /// Path relative to the repository root.
    pub path: String,
    /// Porcelain-v2 XY status (working tree) or name-status letter (dash).
    pub git_status: String,
    /// Attribution operation: write | edit | notebook | created | modified |
    /// deleted | renamed.
    pub op: String,
    /// Attribution origin: exact | bash | turn | replay | dash.
    pub origin: String,
    /// True when more than one changeset owns this file **and** their claimed
    /// regions overlap ([P12]). Two sessions editing disjoint parts of one
    /// file are co-owners without contending.
    pub shared: bool,
    /// Epoch milliseconds of the most recent attribution event for this file.
    pub last_touched: i64,
    /// The hunks this owner's evidence places it in, by [P06] id. Absent
    /// (empty) means file-level: either nobody else owns the path, or this
    /// owner's evidence cannot say where it wrote and claims the file whole.
    /// Additive — an older deck ignores it and behaves exactly as before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub own_hunks: Vec<String>,
    /// The hunks another owner claims too — where the contention actually is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contested_hunks: Vec<String>,
    /// Who else is claiming this file, when `shared` ([P06]). The badge
    /// carries its own evidence: naming the co-owner turns an inexplicable
    /// SHARED into a recognizable one, and a row whose co-owners are all
    /// closed is one the user can release. Absent on non-shared files and
    /// from pre-plan servers — an older deck ignores it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_with: Vec<SharedOwner>,
}

/// One co-owner named on a shared file's badge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SharedOwner {
    /// The co-owning session's id.
    pub id: String,
    /// Its display name, the same one its own changeset entry carries.
    pub name: String,
    /// Whether that session is still running. All-dead co-owners are what
    /// make the row releasable by hand.
    pub live: bool,
}

/// A file the attribution engine has no owner for (hand edits, detached
/// background writes). Rendered in the card's unattributed section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnattributedFile {
    /// Path relative to the repository root.
    pub path: String,
    /// Porcelain-v2 XY status pair.
    pub git_status: String,
    /// Sessions whose live bracket rows saw the path change ([P13]) —
    /// correlation-only holders compose used to strip silently. A hint for
    /// the disposition decision, never an attribution: the file stays
    /// unattributed and default-unselected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hinted_by: Vec<String>,
}

/// A file owned only by non-live ("dead") sessions — a closed session keeps
/// its proof rows ([D120]), so its dirty files stay attributed, but no live
/// card surfaces another session's entry, leaving these files invisible. The
/// orphaned bucket lifts them out so a live session can reclaim them; a proof
/// row a live session still holds keeps the file in that session's entry
/// instead, so a file lands here only when EVERY owner of it is dead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrphanedFile {
    /// Path relative to the repository root.
    pub path: String,
    /// Porcelain-v2 XY status pair.
    pub git_status: String,
    /// Attribution operation carried over from the dead owner's proof row.
    pub op: String,
    /// Attribution origin carried over from the dead owner's proof row.
    pub origin: String,
    /// The dead session that last proof-owned this file (its display name),
    /// shown so the reclaim reads as "orphaned from <name>".
    pub prior_owner_name: String,
    /// The dead session's tug id — the row a claim severs so the originator
    /// can't silently re-own the file on re-open.
    pub prior_owner_id: String,
    /// Epoch milliseconds of the most recent attribution event for this file.
    pub last_touched: i64,
}

/// The maintained commit-message draft for a changeset entry (Spec S10), the
/// artifact the draft engine keeps current so Commit is one click. Rides the
/// aggregate snapshot when present; absent while an entry has no draft yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangesetDraft {
    /// Hash of the entry's scoped content the draft was generated for
    /// (Spec S11) — lets the client tell a fresh draft from a stale one.
    pub fingerprint: String,
    /// The maintained commit message (subject + terse bullets); its body
    /// doubles as the summary.
    pub message: String,
    /// Epoch milliseconds of the last regeneration.
    pub updated_at: i64,
    /// True once a human has touched the message — an edited draft is never
    /// machine-clobbered.
    #[serde(default)]
    pub edited: bool,
    /// The persisted selection, carried verbatim.
    ///
    /// The column is free-form and the client is its only interpreter: the
    /// deck writes path-level `include`/`exclude` lists and per-file hunk
    /// elections into the same object, and reads the shape back through its
    /// own validator. Rust must **not** narrow this to a struct — serde drops
    /// unknown fields, so a typed projection silently deletes any key the
    /// struct does not name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<serde_json::Value>,
}

/// One owner's slice of the workspace's dirty state on the CHANGESET feed.
///
/// Internally tagged on `kind` (`"session"` | `"dash"`) so the client can
/// discriminate without a separate field check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
// `Dash` carries more fields than `Session`, so the variants differ in size.
// Boxing would put the wire shape behind an indirection for a type that is
// built once per owner per snapshot and immediately serialized.
#[allow(clippy::large_enum_variant)]
pub enum ChangesetEntry {
    /// Files attributed to one Claude session's `file_events` rows.
    Session {
        /// The tug session id that owns these files.
        owner_id: String,
        /// Session display name (`name` when user-set, else the id hash).
        display_name: String,
        /// True when the session has a live relay right now.
        live: bool,
        /// The session's attributed dirty files.
        files: Vec<ChangesetFile>,
        /// The maintained commit-message draft, when one exists (Spec S10).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft: Option<ChangesetDraft>,
    },
    /// A dash worktree branch (`refs/heads/tugdash/…`) and its accumulated
    /// `base..branch` changes.
    Dash {
        /// The dash's **owner key** ([P01]) and its identity:
        /// `tugdash/<name>#<tugid>`, or the bare branch ref for a dash created
        /// before ids existed. Draft rows, session binding rows, and the deck's
        /// `(workspace_key, owner_kind, owner_id)` draft-overlay key are all
        /// this string, so entry, row, and overlay agree by construction.
        ///
        /// **Opaque — never a git ref.** Display uses `display_name`; anything
        /// that needs a ref reads `branch` ([P09]).
        owner_id: String,
        /// The dash's short name (branch name without the `tugdash/` prefix).
        display_name: String,
        /// The git ref (`tugdash/<name>`) — the one field a consumer may hand
        /// to git ([P09]). Optional for wire compatibility with older senders;
        /// absent means fall back to `tugdash/<display_name>`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        /// Derived lifecycle stage ([P06]): `created` | `working` |
        /// `draft-ready` | `landing`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        /// Live sessions mated to this dash ([P08]) — this instance's view
        /// ([Q02]). Empty is how *unbound* reads.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        bound_sessions: Vec<String>,
        /// Declared step counters, from the latest step declaration ([P06]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_current: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_total: Option<u32>,
        /// What `step_current` *is* — the latest `step-start` declaration's
        /// title, so a display can say more than a counter.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_title: Option<String>,
        /// When the dash was last touched: the newest dash-log line's timestamp
        /// for its current generation, ISO-8601 UTC. Absent for a dash whose
        /// generation has logged nothing — which for a dash created before
        /// creation wrote a birth record is the ordinary case.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_activity: Option<String>,
        /// The plan this dash is driving, relative to its **worktree** — the
        /// copy a run edits and whose ledger the step verbs rewrite, which is
        /// what makes it the copy a review of a bound dash has to read. Compose
        /// an absolute path as `worktree` / `plan_path`, and nothing else.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_path: Option<String>,
        /// What that plan's Review Record says about the document on disk now:
        /// `reviewed` | `stale` | `never-reviewed`, `tugutil_core::plan::
        /// ReviewState::as_str` verbatim. Absent when the dash records no plan,
        /// when the file cannot be read, or when it does not parse as a plan —
        /// absence is "nothing to say", never an accusation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        review: Option<String>,
        /// The base branch the dash was created from.
        base: String,
        /// Number of commits on the dash branch past its base.
        rounds: u32,
        /// The dash worktree's **absolute** path, resolved against the main
        /// repository root — which the sender knows and the receiver does not,
        /// since a project directory may itself be a linked worktree. No
        /// consumer composes it with anything.
        worktree: String,
        /// True when the dash worktree has uncommitted changes.
        worktree_dirty: bool,
        /// `base..branch` name-status files.
        files: Vec<ChangesetFile>,
        /// Round commit subjects, newest first (`git log base..branch`) —
        /// what the release discard preflight lists ([P14]).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        round_subjects: Vec<String>,
        /// The maintained draft — the dash's eventual squash/join message
        /// ([P23], Spec S10) — when one exists.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft: Option<ChangesetDraft>,
        /// Commits the base branch has gained past this dash's merge-base.
        /// Absent (0) means the dash already contains the base tip.
        #[serde(default, skip_serializing_if = "is_zero")]
        base_ahead: u32,
        /// Base-checkout uncommitted paths this dash also changes — the
        /// landing's `base-dirt` refusal, said the moment it becomes true
        /// rather than at the join.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        base_overlap: Vec<String>,
        /// Where this dash's rounds went the last time its base moved under it
        /// — the settled mark's text, from the dash-log's `replayed` line.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_replay: Option<String>,
        /// Paths a replay stopped on, when the last attempt conflicted. Held by
        /// the engine rather than derived from git, because the answer is about
        /// an attempt rather than about a state.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        replay_conflict_paths: Vec<String>,
        /// The join pipeline's entire durable state for this dash — blockers,
        /// conflicts, the verified candidate, and whether it has been reviewed.
        ///
        /// This is the join arc's single source of truth ([P01]); the client
        /// holds no durable copy of any of it. Absent from an older server,
        /// which reads as "nothing to say" and leaves the face where it was.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        join: Option<DashJoinState>,
    },
}

/// The join pipeline's state for one dash — the single durable source every
/// client reads ([P01] of the join-pipeline plan).
///
/// Before this block existed, the join arc's truth was assembled at render time
/// from four separate client stores stitched together by string equality, and
/// every missed stitch rendered as nothing happening at all. The server already
/// knew each of these facts; publishing what it knows is what makes the
/// mismatch class unrepresentable rather than merely fixed.
///
/// Additive on the wire: an older deck ignores the block and behaves exactly as
/// it did, and an older server sends none, which parses as "nothing to say".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashJoinState {
    /// `blocked` | `previewed` | `conflicted` | `resolved`.
    ///
    /// **Derived on every recompute, never stored.** The board reads git and
    /// assembles; there is no state machine holding a phase that reality could
    /// drift away from.
    pub phase: String,
    /// What would refuse a join right now. Non-empty means `phase` is
    /// `blocked`.
    ///
    /// Never cached server-side: every one of these answers to working-tree
    /// state, which moves without moving a commit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<DashJoinBlocker>,
    /// Conflicted paths from the in-memory merge probe.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
    /// What the base did to each conflicted path since the two sides parted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archaeology: Vec<DashConflictHistory>,
    /// The resolved candidate commit, present only when it still verifies
    /// against the current base and dash heads. Present means `phase` is
    /// `resolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    /// The ladder's per-file results, for the review panel.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved: Vec<DashResolvedFile>,
    /// Whether the user has read what the ladder decided **for this candidate**.
    /// Pinned to a sha server-side, so reviewing one candidate never blesses
    /// the next one.
    #[serde(default)]
    pub reviewed: bool,
    /// A candidate existed but no longer describes the current heads: the
    /// sentence names which side moved. The board drops the stale candidate
    /// when it says this, so the state demotes itself rather than lying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_note: Option<String>,
    /// What the project's own checks said about the joined tree ([P04]).
    ///
    /// Anchored to `(base_sha, candidate_sha)`, so it caches soundly and
    /// self-demotes the moment either head moves — absent means nobody has
    /// asked about *this* candidate, which is not the same as green.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<DashJoinVerification>,
}

/// A candidate's verification verdict, as the face reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashJoinVerification {
    /// `unrun` | `running` | `green` | `red` — the build tier.
    pub tier0: String,
    /// `unrun` | `running` | `green` | `red` — the test tier.
    pub tier1: String,
    /// The failing commands, as sentences. A red that cannot say why is the
    /// silence the face exists to prevent, so these ride with the verdict.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<String>,
    /// What qualifies the verdict — "project declares no verification", a
    /// selector exit that forced a fallback, tests skipped as `@foreground`.
    /// A green with notes is a green with exclusions, and says so.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// The two commits this verdict describes.
    pub base_sha: String,
    pub candidate_sha: String,
}

/// One reason a landing would be refused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashJoinBlocker {
    /// `off-base` | `base-dirt` | `stale-journal` | `empty`.
    pub kind: String,
    /// The human sentence — the same one the CLI's execute path returns.
    pub detail: String,
    /// The offending paths, for `base-dirt`; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

/// What the base did to one conflicted path since the two sides parted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashConflictHistory {
    pub path: String,
    /// The most recent base commits that touched it, newest first, capped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commits: Vec<DashConflictCommit>,
    /// How many touched it in total — `commits.len()` unless the cap bit.
    pub total: u32,
}

/// One base commit behind a conflicted path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashConflictCommit {
    pub sha: String,
    pub subject: String,
}

/// One file the resolution ladder resolved, as the review panel reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashResolvedFile {
    pub path: String,
    /// Which rung decided it: `replay` | `rerere` | `merge-file` | `driver` |
    /// `ai`, or `unknown` when the provenance could not be read back.
    ///
    /// This is the reason the review exists. Every rung above the replay probe
    /// is a machine decision the user never saw, and the candidate commit
    /// records the resolved bytes without recording which rung chose them — so
    /// this half is persisted rather than recomputed, and an entry whose rung
    /// cannot be recovered still renders, because a resolution nobody can
    /// attribute is still one that has to be reviewed.
    pub resolved_by: String,
    /// The unified diff this resolution lands on the base, capped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// Lines added and removed as **git** counts them — never as anything
    /// counts the capped `diff` above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

/// `skip_serializing_if` for a count whose zero means "nothing to say".
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// The workspace-scoped changeset snapshot, delivered on the CHANGESET feed
/// (0x23).
///
/// Embeds the branch / ahead-behind / HEAD header (the retired git card's
/// data) plus every owner's attributed files and the unattributed remainder.
/// Composition rules live with the feed; this is the wire contract, mirrored
/// in `tugdeck/src/lib/changeset-types.ts` and guarded by the shared golden
/// fixture `tugdeck/src/__tests__/fixtures/changeset-snapshot.golden.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangesetSnapshot {
    /// Canonical key of the workspace the snapshot was computed in.
    /// Serialized like every other snapshot feed's spliced key.
    #[serde(default)]
    pub workspace_key: String,
    /// Current branch name, or "(detached)" if HEAD is detached.
    pub branch: String,
    /// Number of commits ahead of upstream.
    pub ahead: u32,
    /// Number of commits behind upstream.
    pub behind: u32,
    /// SHA of HEAD commit.
    pub head_sha: String,
    /// Subject line of HEAD commit.
    pub head_message: String,
    /// One entry per owner (session or dash) with attributed files.
    pub changesets: Vec<ChangesetEntry>,
    /// Dirty files no owner claims.
    pub unattributed: Vec<UnattributedFile>,
    /// Dirty files owned only by non-live sessions — claimable orphans
    /// ([D120]). Empty in the common case; populated when a closed session's
    /// proof-owned files are still dirty and no live session shares them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orphaned: Vec<OrphanedFile>,
}

/// One project's slice of the account-global aggregate changeset snapshot.
///
/// Carries the project's identity (`project_dir` — the absolute checkout root,
/// also the client's clickable-link base — plus `display_name` and
/// `workspace_key`) and, flattened alongside, the per-project
/// [`ChangesetSnapshot`] payload. When `no_repo` is true the project dir is not
/// inside a git working tree: the flattened snapshot fields are empty/zero and
/// the card renders an "Initialize git" affordance instead of changeset rows.
///
/// The flatten keeps the wire shape flat (Spec S06) — `workspace_key` comes
/// from the embedded snapshot, so it is not repeated here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectChangeset {
    /// Absolute checkout root; also the base for the card's clickable links.
    pub project_dir: String,
    /// Basename of `project_dir`, shown as the section title.
    pub display_name: String,
    /// True when `project_dir` is not inside a git working tree.
    pub no_repo: bool,
    /// The per-project changeset payload (branch header + changesets +
    /// unattributed), flattened so the wire shape stays flat. Empty/zero
    /// when `no_repo` is true.
    #[serde(flatten)]
    pub snapshot: ChangesetSnapshot,
    /// The maintained draft for this project's unattributed bucket (Spec
    /// S10), when one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unattributed_draft: Option<ChangesetDraft>,
}

/// The account-global aggregate changeset snapshot, delivered process-level on
/// the CHANGESET_ALL feed (0x24) — one frame carrying every open project.
///
/// Composed by the aggregate feed over the current `WorkspaceRegistry` entries
/// (one per open session card, plus the bootstrap project); mirrored in
/// `tugdeck/src/lib/changeset-types.ts` and guarded by the shared golden
/// fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspacesChangesetSnapshot {
    /// One entry per open project, in registry-enumeration order.
    pub projects: Vec<ProjectChangeset>,
    /// True once any ledger statement in this process has hit database
    /// corruption — the deck must present claims as *unavailable*, never
    /// as an empty "no session claims these" result.
    #[serde(default)]
    pub ledger_degraded: bool,
}

/// A single-shot subscription-usage payload, delivered on the USAGE feed
/// (0x90) in response to a USAGE_QUERY (0x91).
///
/// Carries the verbatim text `claude -p "/usage"` prints — the same panel the
/// terminal shows (limit gauges, reset times, and the "what's contributing"
/// breakdown). The deck parses `text` into its graphical shape. `request_id`
/// echoes the query's correlation id; `ok` is false (with `error` set) when the
/// `claude` invocation failed or the user is logged out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageSnapshot {
    /// Correlation id echoed from the request.
    pub request_id: String,
    /// True when `claude -p "/usage"` exited successfully.
    pub ok: bool,
    /// Verbatim stdout of `claude -p "/usage"` (may be empty on failure).
    pub text: String,
    /// Human-readable failure reason when `ok` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A single scored result from fuzzy file matching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredResult {
    /// Relative path for indexed queries; absolute path for off-board queries [D10].
    pub path: String,
    /// Fuzzy match score (higher = better). 0 for off-board results.
    pub score: i32,
    /// Byte-offset ranges `[start, end)` of matched characters for highlighting.
    /// Empty for off-board results.
    pub matches: Vec<(usize, usize)>,
    /// True when the entry is a directory. Directory paths also carry a
    /// trailing `/`, but this flag is the contract — clients must not
    /// parse the path shape.
    #[serde(default)]
    pub is_dir: bool,
}

/// File tree query response.
///
/// Delivered by the FILETREE feed (0x11) in response to a FILETREE_QUERY (0x12).
/// Contains the top-N scored results for the query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeSnapshot {
    /// Echo of the query that produced these results (for staleness detection).
    pub query: String,
    /// Top-N results sorted by descending score.
    pub results: Vec<ScoredResult>,
    /// True if the file index exceeded the 50,000 cap.
    pub truncated: bool,
}

/// Aggregate stats snapshot combining all collector outputs
///
/// Each collector produces a JSON value that is stored in the collectors map
/// under the collector's name. The timestamp indicates when this snapshot
/// was assembled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatSnapshot {
    /// Map of collector name to collector output (heterogeneous JSON values)
    pub collectors: HashMap<String, serde_json::Value>,
    /// ISO 8601 timestamp of snapshot assembly
    pub timestamp: String,
}

// MARK: - Overview

/// Who wrote a Overview post. The channel has exactly three authors and no
/// mechanism for a fourth, so this is an enum rather than a string: an
/// unknown author is a parse failure at the edge instead of a row nobody
/// renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverviewAuthor {
    /// The summarizer, posting digests of session work as it happens.
    Observer,
    /// The question-answering agent. Speaks only when spoken to.
    Operator,
    /// The human, asking through the card's composer.
    User,
}

impl OverviewAuthor {
    /// The wire/storage spelling — what the `author` column holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Observer => "observer",
            Self::Operator => "operator",
            Self::User => "user",
        }
    }

    /// Parse a stored/wire author. Unknown spellings are `None` rather than a
    /// default, so a drifted writer surfaces as a skipped row instead of a
    /// post silently attributed to the wrong voice.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "observer" => Some(Self::Observer),
            "operator" => Some(Self::Operator),
            "user" => Some(Self::User),
            _ => None,
        }
    }
}

/// What a ref points at. The card renders each kind as a different chip
/// action, so an unrecognized kind has no behavior to offer and is dropped
/// at parse rather than rendered inert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverviewRefKind {
    /// A session id — raises that Session card.
    Session,
    /// A repo-relative file path.
    File,
    /// A commit sha.
    Commit,
    /// A plan document under the roadmap.
    Plan,
    /// A brief document under the roadmap.
    Brief,
}

impl OverviewRefKind {
    /// The wire/storage spelling — what the `refs` JSON holds, and what a
    /// diagnostic prints when it names the kind of a ref it kept or dropped.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::File => "file",
            Self::Commit => "commit",
            Self::Plan => "plan",
            Self::Brief => "brief",
        }
    }
}

/// One clickable provenance chip on a post.
///
/// `target` is carried verbatim from the model's envelope and is validated
/// against the buffered context before it is ever persisted — a path or sha
/// that never appeared in the frames the model was shown cannot be linked,
/// so it is dropped rather than rendered as a chip that goes nowhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverviewRef {
    pub kind: OverviewRefKind,
    pub target: String,
}

/// One image a user attached to a question, as it rests after the question
/// was asked: a file on disk plus the media type it was decoded as.
///
/// The bytes do NOT live in the ledger. A downsampled screenshot is a
/// megabyte of base64, the channel is permanent history that nothing prunes,
/// and the deck already has a route that streams a file by absolute path
/// (`/api/fs/blob`, the viewer cards' own). So the row holds the path and the
/// bytes rest beside the ledger under `overview-attachments/`, which is also
/// what lets the same file be handed to the model as an image block without a
/// second copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverviewAttachment {
    /// Absolute path to the stored image.
    pub path: String,
    /// The media type the deck decoded it as — `image/png`, `image/jpeg`, …
    pub media_type: String,
}

/// One post on the Overview channel, as it travels on `FeedId::OVERVIEW` and
/// as the CONTROL tail read returns it.
///
/// `id` is the ledger rowid, absent on a transient post — an Operator error
/// that is broadcast so the card can stop waiting but never written to the
/// ledger, because an infrastructure hiccup is not history. `request_id` is
/// present only on an Operator post answering a specific question, and is
/// what the card matches to clear its pending state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverviewPost {
    /// Ledger rowid. `None` on a transient post ([P08]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub at_ms: i64,
    pub author: OverviewAuthor,
    /// The session a Observer digest narrates. `None` for Operator answers
    /// and user questions, which belong to the channel rather than a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Which structural moment woke the Observer. `None` for the other authors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_reason: Option<String>,
    pub body: String,
    #[serde(default)]
    pub refs: Vec<OverviewRef>,
    /// How long the agent turn that wrote this post took, in milliseconds.
    ///
    /// The post's own cost, the way a session turn's elapsed is that turn's:
    /// clocked around the agent run by whoever ran it, not derived afterwards
    /// from two timestamps. `None` on a post no agent wrote (a user's
    /// question) and on rows written before the column existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<i64>,
    /// The project directory the post's refs are spelled relative to — the
    /// narrated session's for a Observer post, the bootstrap workspace's for
    /// an Operator answer (its verbs' own default repo). A ref target is a
    /// verbatim quote from session activity, so this is the only root it can
    /// honestly resolve against; the deck stats/indexes under it before a
    /// chip becomes clickable. `None` on a user's question (no refs to
    /// resolve) and on rows written before the column existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    /// Images the user attached to this question, in the order they were
    /// composed. Empty on every post nobody attached anything to, which is
    /// every post the Observer and the Operator write.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<OverviewAttachment>,
    /// Correlation id, on an Operator post answering a question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// True on a broadcast-but-never-persisted post. Defaults false so a
    /// persisted row deserializes without carrying the flag.
    #[serde(default, skip_serializing_if = "is_false")]
    pub transient: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fsevent_created_json() {
        let event = FsEvent::Created {
            path: "src/main.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"kind":"Created","path":"src/main.rs"}"#);
    }

    #[test]
    fn test_fsevent_modified_json() {
        let event = FsEvent::Modified {
            path: "src/lib.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"kind":"Modified","path":"src/lib.rs"}"#);
    }

    #[test]
    fn test_fsevent_removed_json() {
        let event = FsEvent::Removed {
            path: "old_file.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"kind":"Removed","path":"old_file.rs"}"#);
    }

    #[test]
    fn test_fsevent_renamed_json() {
        let event = FsEvent::Renamed {
            from: "old.rs".to_string(),
            to: "new.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""kind":"Renamed""#));
        assert!(json.contains(r#""from":"old.rs""#));
        assert!(json.contains(r#""to":"new.rs""#));
    }

    #[test]
    fn test_fsevent_round_trip() {
        let events = vec![
            FsEvent::Created {
                path: "test.rs".to_string(),
            },
            FsEvent::Modified {
                path: "src/main.rs".to_string(),
            },
            FsEvent::Removed {
                path: "old.rs".to_string(),
            },
            FsEvent::Renamed {
                from: "a.rs".to_string(),
                to: "b.rs".to_string(),
            },
        ];

        for event in events {
            let json = serde_json::to_string(&event).unwrap();
            let decoded: FsEvent = serde_json::from_str(&json).unwrap();
            let json2 = serde_json::to_string(&decoded).unwrap();
            assert_eq!(json, json2);
        }
    }

    #[test]
    fn test_git_diff_file_status_lowercase() {
        assert_eq!(
            serde_json::to_string(&GitDiffFileStatus::Added).unwrap(),
            r#""added""#
        );
        assert_eq!(
            serde_json::to_string(&GitDiffFileStatus::Modified).unwrap(),
            r#""modified""#
        );
        assert_eq!(
            serde_json::to_string(&GitDiffFileStatus::Deleted).unwrap(),
            r#""deleted""#
        );
        assert_eq!(
            serde_json::to_string(&GitDiffFileStatus::Renamed).unwrap(),
            r#""renamed""#
        );
    }

    #[test]
    fn test_git_diff_file_omits_old_path_when_absent() {
        let file = GitDiffFile {
            path: "src/main.rs".to_string(),
            old_path: None,
            status: GitDiffFileStatus::Modified,
            added: 3,
            removed: 1,
            binary: false,
            unified: "@@ -1 +1,3 @@\n a\n+b\n+c\n".to_string(),
            hunks: Vec::new(),
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(
            !json.contains("old_path"),
            "absent old_path must be omitted"
        );
        assert!(
            !json.contains("hunks"),
            "an empty hunk list must be omitted"
        );
        let decoded: GitDiffFile = serde_json::from_str(&json).unwrap();
        assert_eq!(file, decoded);
    }

    #[test]
    fn test_git_diff_snapshot_round_trip() {
        let snapshot = GitDiffSnapshot {
            request_id: "req-1".to_string(),
            workspace_key: "/work/repo".to_string(),
            base: "HEAD".to_string(),
            no_repo: false,
            file_count: 2,
            total_added: 12,
            total_removed: 3,
            files: vec![
                GitDiffFile {
                    path: "renamed.rs".to_string(),
                    old_path: Some("old.rs".to_string()),
                    status: GitDiffFileStatus::Renamed,
                    added: 2,
                    removed: 1,
                    binary: false,
                    unified: "diff --git a/old.rs b/renamed.rs\n".to_string(),
                    hunks: vec!["a1b2c3d4e5f60718".to_string()],
                },
                GitDiffFile {
                    path: "img.png".to_string(),
                    old_path: None,
                    status: GitDiffFileStatus::Modified,
                    added: 0,
                    removed: 0,
                    binary: true,
                    unified: "Binary files a/img.png and b/img.png differ\n".to_string(),
                    hunks: Vec::new(),
                },
            ],
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: GitDiffSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_git_log_snapshot_round_trip() {
        let snapshot = GitLogSnapshot {
            request_id: "gl-1".to_string(),
            workspace_key: "/work/repo".to_string(),
            branch: "main".to_string(),
            no_repo: false,
            offset: 20,
            has_more: true,
            commits: vec![
                GitLogCommit {
                    sha: "0123456789abcdef0123456789abcdef01234567".to_string(),
                    subject: "add feature".to_string(),
                    body: "A longer explanation\nover two lines.".to_string(),
                    author: "Ada Lovelace".to_string(),
                    date: "2026-07-15".to_string(),
                    committer: "Ada Lovelace".to_string(),
                    committer_email: "ada@example.com".to_string(),
                    committer_date: "2026-07-15T09:30:00-07:00".to_string(),
                    tug_dash: Some("tugdash/feature onto main".to_string()),
                    tug_session: Some("stocky-pixie (f6e43925)".to_string()),
                    tug_session_id: Some("f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f".to_string()),
                    files: vec!["src/lib.rs".to_string(), "src/main.rs".to_string()],
                },
                GitLogCommit {
                    sha: "89abcdef0123456789abcdef0123456789abcdef".to_string(),
                    subject: "initial".to_string(),
                    body: String::new(),
                    author: "Grace Hopper".to_string(),
                    date: "2026-07-14".to_string(),
                    committer: "Grace Hopper".to_string(),
                    committer_email: "grace@example.com".to_string(),
                    committer_date: "2026-07-14T12:00:00-07:00".to_string(),
                    tug_dash: None,
                    tug_session: None,
                    tug_session_id: None,
                    files: Vec::new(),
                },
            ],
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: GitLogSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_git_commit_files_snapshot_round_trip() {
        let snapshot = GitCommitFilesSnapshot {
            request_id: "gcf-1".to_string(),
            workspace_key: "/work/repo".to_string(),
            sha: "0123456789abcdef0123456789abcdef01234567".to_string(),
            no_repo: false,
            subject: "overview(ref-annotation): summarize commits on hover".to_string(),
            author: "Ken Kocienda".to_string(),
            date: "2026-08-12".to_string(),
            files: vec![
                GitCommitFile {
                    path: "src/lib.rs".to_string(),
                    status: "modified".to_string(),
                    added: 16,
                    removed: 1,
                },
                GitCommitFile {
                    path: "assets/logo.png".to_string(),
                    status: "created".to_string(),
                    added: 0,
                    removed: 0,
                },
            ],
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: GitCommitFilesSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_git_head_signal_round_trip() {
        let sig = GitHeadSignal {
            workspace_key: "/work/repo".to_string(),
            head: "0123456789abcdef0123456789abcdef01234567".to_string(),
        };
        let json = serde_json::to_string(&sig).unwrap();
        let decoded: GitHeadSignal = serde_json::from_str(&json).unwrap();
        assert_eq!(sig, decoded);
    }

    #[test]
    fn test_git_log_snapshot_no_repo_defaults() {
        // A payload with no `no_repo` / paging fields decodes to the first
        // page of a non-repo: nothing skipped, nothing more to ask for.
        let json = r#"{"request_id":"gl-2","workspace_key":"ws","branch":"","commits":[]}"#;
        let decoded: GitLogSnapshot = serde_json::from_str(json).unwrap();
        assert!(!decoded.no_repo);
        assert_eq!(decoded.offset, 0);
        assert!(!decoded.has_more);
        assert!(decoded.commits.is_empty());
    }

    #[test]
    fn test_git_log_commit_files_default_to_empty() {
        // A commit record with no `files` key decodes to an empty roster.
        let json = r#"{"sha":"abc","subject":"s","author":"a","date":"2026-07-24"}"#;
        let decoded: GitLogCommit = serde_json::from_str(json).unwrap();
        assert!(decoded.files.is_empty());
    }

    #[test]
    fn test_git_status_json_round_trip() {
        let status = GitStatus {
            branch: "main".to_string(),
            ahead: 2,
            behind: 1,
            staged: vec![
                FileStatus {
                    path: "src/main.rs".to_string(),
                    status: "M".to_string(),
                },
                FileStatus {
                    path: "src/lib.rs".to_string(),
                    status: "A".to_string(),
                },
            ],
            unstaged: vec![FileStatus {
                path: "README.md".to_string(),
                status: "M".to_string(),
            }],
            untracked: vec!["temp.txt".to_string()],
            head_sha: "abc123".to_string(),
            head_message: "Initial commit".to_string(),
        };

        let json = serde_json::to_string(&status).unwrap();
        let decoded: GitStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, decoded);
    }

    #[test]
    fn test_git_status_partial_eq_equal() {
        let status1 = GitStatus {
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "abc".to_string(),
            head_message: "test".to_string(),
        };

        let status2 = GitStatus {
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "abc".to_string(),
            head_message: "test".to_string(),
        };

        assert_eq!(status1, status2);
    }

    #[test]
    fn test_git_status_partial_eq_different() {
        let status1 = GitStatus {
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "abc".to_string(),
            head_message: "test".to_string(),
        };

        let status2 = GitStatus {
            branch: "develop".to_string(),
            ahead: 1,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "def".to_string(),
            head_message: "different".to_string(),
        };

        assert_ne!(status1, status2);
    }

    #[test]
    fn test_file_status_json_round_trip() {
        let file_status = FileStatus {
            path: "src/main.rs".to_string(),
            status: "M".to_string(),
        };

        let json = serde_json::to_string(&file_status).unwrap();
        let decoded: FileStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(file_status, decoded);
    }

    #[test]
    fn test_golden_fsevent_created() {
        let event = FsEvent::Created {
            path: "src/main.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"kind":"Created","path":"src/main.rs"}"#);
    }

    #[test]
    fn test_golden_fsevent_renamed() {
        let event = FsEvent::Renamed {
            from: "old.rs".to_string(),
            to: "new.rs".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"kind":"Renamed","from":"old.rs","to":"new.rs"}"#);
    }

    #[test]
    fn test_stat_snapshot_json_round_trip() {
        let mut collectors = HashMap::new();
        collectors.insert(
            "process_info".to_string(),
            serde_json::json!({"pid": 12345, "cpu_percent": 12.5}),
        );
        collectors.insert(
            "token_usage".to_string(),
            serde_json::json!({"total_tokens": 23000}),
        );

        let snapshot = StatSnapshot {
            collectors,
            timestamp: "2026-02-15T10:30:05Z".to_string(),
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: StatSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_stat_snapshot_empty_collectors() {
        let snapshot = StatSnapshot {
            collectors: HashMap::new(),
            timestamp: "2026-02-15T10:30:05Z".to_string(),
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: StatSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
        assert_eq!(decoded.collectors.len(), 0);
    }

    /// The shared wire-contract fixture, also validated by the tugdeck bun
    /// test suite — drift on either side of the mirror fails one of the two.
    const CHANGESET_GOLDEN: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tugdeck/src/__tests__/fixtures/changeset-snapshot.golden.json"
    ));

    #[test]
    fn test_changeset_snapshot_golden_fixture() {
        let snapshot: ChangesetSnapshot = serde_json::from_str(CHANGESET_GOLDEN).unwrap();
        assert_eq!(snapshot.branch, "main");
        assert_eq!(snapshot.ahead, 2);
        assert_eq!(snapshot.changesets.len(), 2);
        assert_eq!(snapshot.unattributed.len(), 1);

        match &snapshot.changesets[0] {
            ChangesetEntry::Session {
                owner_id,
                live,
                files,
                ..
            } => {
                assert!(owner_id.starts_with("sess-"));
                assert!(live);
                assert_eq!(files.len(), 2);
                assert!(files[1].shared);
            }
            other => panic!("expected session entry, got {other:?}"),
        }
        match &snapshot.changesets[1] {
            ChangesetEntry::Dash {
                owner_id,
                base,
                rounds,
                worktree_dirty,
                files,
                join,
                ..
            } => {
                assert_eq!(owner_id, "tugdash/fix-join");
                assert_eq!(base, "main");
                assert_eq!(*rounds, 3);
                assert!(!worktree_dirty);
                assert_eq!(files.len(), 1);
                // The verification verdict is the same bytes the tugdeck suite
                // reads off this fixture — drift on either side of the mirror
                // fails one of the two.
                let v = join
                    .as_ref()
                    .and_then(|j| j.verification.as_ref())
                    .expect("the golden dash carries a verification verdict");
                assert_eq!(v.tier0, "green");
                assert_eq!(v.tier1, "red");
                assert_eq!(v.failures.len(), 1);
                assert!(v.notes[0].contains("@foreground"));
                assert_eq!(
                    Some(&v.candidate_sha),
                    join.as_ref().and_then(|j| j.candidate.as_ref())
                );
            }
            other => panic!("expected dash entry, got {other:?}"),
        }
    }

    #[test]
    fn test_changeset_snapshot_round_trip() {
        let snapshot: ChangesetSnapshot = serde_json::from_str(CHANGESET_GOLDEN).unwrap();
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: ChangesetSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_changeset_entry_kind_tags() {
        let session = ChangesetEntry::Session {
            owner_id: "sess-1".to_string(),
            display_name: "s".to_string(),
            live: false,
            files: vec![],
            draft: None,
        };
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains(r#""kind":"session""#));
        // An absent draft is skipped on the wire.
        assert!(!json.contains("draft"));

        let dash = ChangesetEntry::Dash {
            owner_id: "tugdash/x#1723500000000-a1b2c3".to_string(),
            display_name: "x".to_string(),
            branch: Some("tugdash/x".to_string()),
            stage: Some("working".to_string()),
            bound_sessions: vec!["sess-1".to_string()],
            step_current: None,
            step_total: None,
            step_title: None,
            last_activity: None,
            plan_path: None,
            review: None,
            base: "main".to_string(),
            rounds: 0,
            worktree: "/repo/.tug/worktrees/tugdash__x".to_string(),
            worktree_dirty: true,
            files: vec![],
            round_subjects: vec![],
            draft: Some(ChangesetDraft {
                fingerprint: "fp".to_string(),
                message: "Do the thing".to_string(),
                updated_at: 5,
                edited: false,
                selection: None,
            }),
            base_ahead: 0,
            base_overlap: vec![],
            last_replay: None,
            replay_conflict_paths: vec![],
            join: None,
        };
        let json = serde_json::to_string(&dash).unwrap();
        assert!(json.contains(r#""kind":"dash""#));
        // A dash with nothing to say about joining spends no bytes on it.
        assert!(!json.contains("\"join\""));
        // A current dash spends no wire bytes on its divergence fields.
        assert!(!json.contains("base_ahead"));
        assert!(!json.contains("base_overlap"));
        // A present draft rides the wire.
        assert!(json.contains(r#""message":"Do the thing""#));
        // The identity is the owner key; the ref travels separately ([P09]).
        assert!(json.contains(r#""owner_id":"tugdash/x#1723500000000-a1b2c3""#));
        assert!(json.contains(r#""branch":"tugdash/x""#));
        assert!(json.contains(r#""stage":"working""#));
        assert!(json.contains(r#""bound_sessions":["sess-1"]"#));
        // Phase 3's slots stay off the wire while they are empty.
        assert!(!json.contains("step_current"));
        // …and so do the plan path and its review state, which most dashes
        // never record. Absence is "nothing to say" on both.
        assert!(!json.contains("plan_path"));
        assert!(!json.contains("review"));
        // A dash whose generation has logged nothing has no date to send.
        assert!(!json.contains("last_activity"));

        // And one that has been touched sends when.
        let mut dated = dash;
        if let ChangesetEntry::Dash { last_activity, .. } = &mut dated {
            *last_activity = Some("2026-08-14T12:00:00Z".to_string());
        }
        assert!(
            serde_json::to_string(&dated)
                .unwrap()
                .contains(r#""last_activity":"2026-08-14T12:00:00Z""#)
        );

        // An older sender's entry — no new fields at all — still decodes.
        let legacy = r#"{"kind":"dash","owner_id":"tugdash/y","display_name":"y",
            "base":"main","rounds":0,"worktree":".tug/worktrees/y",
            "worktree_dirty":false,"files":[]}"#;
        let decoded: ChangesetEntry = serde_json::from_str(legacy).unwrap();
        match decoded {
            ChangesetEntry::Dash {
                owner_id,
                branch,
                stage,
                bound_sessions,
                ..
            } => {
                assert_eq!(owner_id, "tugdash/y");
                assert!(branch.is_none() && stage.is_none());
                assert!(bound_sessions.is_empty());
            }
            _ => panic!("expected a dash entry"),
        }
    }

    /// The draft's selection is opaque: every key the client wrote survives
    /// a round trip through the Rust type, including ones no Rust type
    /// names. A typed projection here would silently delete them — which is
    /// how the hunk elections were written to the ledger and then dropped on
    /// the way back out.
    #[test]
    fn test_changeset_draft_selection_survives_unknown_keys() {
        let stored = r#"{"include":["a.rs"],"exclude":["b.rs"],"hunks":{"f.txt":["abc123"]}}"#;
        let draft = ChangesetDraft {
            fingerprint: "fp".to_string(),
            message: "m".to_string(),
            updated_at: 1,
            edited: false,
            selection: Some(serde_json::from_str(stored).unwrap()),
        };

        let round_tripped: ChangesetDraft =
            serde_json::from_str(&serde_json::to_string(&draft).unwrap()).unwrap();
        let selection = round_tripped.selection.expect("selection rides the wire");

        assert_eq!(selection["include"], serde_json::json!(["a.rs"]));
        assert_eq!(selection["exclude"], serde_json::json!(["b.rs"]));
        assert_eq!(
            selection["hunks"],
            serde_json::json!({"f.txt": ["abc123"]}),
            "a key the Rust side does not name must still round-trip"
        );
    }

    #[test]
    fn test_changeset_snapshot_workspace_key_defaults_empty() {
        let json = r#"{"branch":"main","ahead":0,"behind":0,"head_sha":"","head_message":"","changesets":[],"unattributed":[]}"#;
        let snapshot: ChangesetSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snapshot.workspace_key, "");
    }

    /// The shared aggregate wire-contract fixture, also validated by the
    /// tugdeck bun suite — drift on either side of the mirror fails one.
    const WORKSPACES_CHANGESET_GOLDEN: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json"
    ));

    #[test]
    fn test_workspaces_changeset_snapshot_golden_fixture() {
        let snapshot: WorkspacesChangesetSnapshot =
            serde_json::from_str(WORKSPACES_CHANGESET_GOLDEN).unwrap();
        assert_eq!(snapshot.projects.len(), 2);

        let repo = &snapshot.projects[0];
        assert_eq!(repo.display_name, "tugtool");
        assert!(!repo.no_repo);
        // Flattened snapshot fields decode onto the embedded ChangesetSnapshot.
        assert_eq!(repo.snapshot.branch, "main");
        assert_eq!(repo.snapshot.workspace_key, "a1b2c3d4e5f60718");
        assert_eq!(repo.snapshot.changesets.len(), 2);
        assert_eq!(repo.snapshot.unattributed.len(), 1);
        assert_eq!(repo.snapshot.orphaned.len(), 1);
        assert_eq!(repo.snapshot.orphaned[0].path, "notes/orphan.md");
        assert_eq!(repo.snapshot.orphaned[0].prior_owner_name, "ghost work");

        let non_repo = &snapshot.projects[1];
        assert_eq!(non_repo.display_name, "scratchpad");
        assert!(non_repo.no_repo);
        assert_eq!(non_repo.snapshot.branch, "");
        assert!(non_repo.snapshot.changesets.is_empty());
        assert!(non_repo.snapshot.unattributed.is_empty());
    }

    #[test]
    fn test_workspaces_changeset_snapshot_round_trip() {
        let snapshot: WorkspacesChangesetSnapshot =
            serde_json::from_str(WORKSPACES_CHANGESET_GOLDEN).unwrap();
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: WorkspacesChangesetSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, decoded);
    }

    #[test]
    fn test_project_changeset_flattens_snapshot_fields() {
        // The flatten keeps the wire shape flat: project identity and the
        // snapshot header sit at the same object level, workspace_key not
        // duplicated.
        let project = ProjectChangeset {
            project_dir: "/tmp/proj".to_string(),
            display_name: "proj".to_string(),
            no_repo: false,
            snapshot: ChangesetSnapshot {
                workspace_key: "deadbeef".to_string(),
                branch: "main".to_string(),
                ahead: 0,
                behind: 0,
                head_sha: "abc".to_string(),
                head_message: "msg".to_string(),
                changesets: vec![],
                unattributed: vec![],
                orphaned: vec![],
            },
            unattributed_draft: None,
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains(r#""project_dir":"/tmp/proj""#));
        assert!(json.contains(r#""workspace_key":"deadbeef""#));
        assert!(json.contains(r#""branch":"main""#));
        // Exactly one workspace_key in the flattened output.
        assert_eq!(json.matches("workspace_key").count(), 1);
    }
}
