//! The `changes` operation — "which files did this session change?"
//!
//! Reads the session's `file_events` attribution rows from the read-only ledger
//! ([`crate::ledger`]), joins them against the current `git status` so
//! committed/reverted files drop out, dedups per repo-relative path (latest
//! live event wins op/origin), and — with `--diff` — attaches each file's
//! unified diff. Ported from `tugtool/src/commands/changes.rs`.
//!
//! **Invariant ([P01]): a dirty file is never invisible.** `git status
//! --untracked-files=all` is the universe of the shared resolution
//! ([`resolve_changes`]); the ledger *annotates* that universe, it does not
//! *filter* it. Every dirty path is classified into one of three buckets —
//! `attributed` (this session's live rows), `foreign` (only other sessions'
//! live rows), or `unattributed` (no live rows anywhere) — so a capture gap can
//! narrow *attribution* but can never drop a file from `context`. The
//! `changes()` op itself keeps its legacy event-scoped wire contract (only
//! `files`); the buckets surface through `context` ([Q01]).
//!
//! Two per-file rules govern classification:
//!
//! - **Row liveness.** A ledger row is live only while it postdates the last
//!   commit that touched its path ([`min_live_at_ms`]) — a commit *spends* the
//!   rows it absorbs, so a spent row neither attributes nor contends when the
//!   file goes dirty again later. Ties break toward spent, degrading to
//!   `unattributed` — visible, never falsely claimed.
//! - **Contention is computed here at read time, per region.** An attributed
//!   path that other sessions also hold live rows for names them in
//!   `sessions`; it is `shared` only when the owners' claimed regions actually
//!   overlap ([`crate::contention`], [P12]) — and an owner whose evidence
//!   cannot say where it wrote claims the whole file, which reproduces the
//!   file-level answer exactly. Capture never records a cross-session
//!   judgment, and wall-clock overlap between sessions is never evidence.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::contention;
use crate::git::{self, repo_root_for};
use crate::hunks;
use crate::ledger;

/// Options for [`changes`]. `session` defaults from `$TUG_SESSION_ID`; `project`
/// defaults to cwd; `all` keeps committed/reverted files; `diff` attaches each
/// file's unified diff.
#[derive(Debug, Clone, Default)]
pub struct ChangesOptions {
    pub session: Option<String>,
    pub project: Option<PathBuf>,
    pub all: bool,
    pub diff: bool,
}

/// One changed file (Spec S01). `git_status` is the two-char porcelain-v1 code
/// (`" M"`, `"M "`, `"??"`, …), empty for an `--all` row no longer dirty.
/// `sessions` names the other live proof owners of the path; `shared` marks
/// genuine contention among them — true when the owners' claimed *regions*
/// overlap ([P12]), so two sessions editing disjoint parts of one file are
/// co-owners without being contended. An owner that recorded no regions
/// claims the whole file, which is how the file-level answer survives for
/// evidence that cannot say more. `diff` is present only when requested.
#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub path: String,
    pub op: String,
    pub origin: String,
    pub shared: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
    pub git_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// A dirty file with live claims only from *other* sessions (Spec S01). It is
/// never this session's to commit by default; `sessions` lists the claiming
/// `tug_session_id`s so the agent can see whose work it is. `diff` is present
/// only when requested (`context` always requests it).
#[derive(Debug, Clone, Serialize)]
pub struct ForeignChange {
    pub path: String,
    pub git_status: String,
    pub sessions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// The `changes` result (Spec S01 payload). `known` is the
/// unknown-session-with-no-events signal for the CLI's exit-code mapping — it is
/// not serialized (not part of the wire contract).
///
/// `files` is the attributed bucket. `unattributed` and `foreign` are the other
/// two buckets `resolve_changes` classifies every dirty path into; they are
/// carried here so a JSON caller can read the whole classification rather than
/// re-deriving it from `git status`. Both serialize unconditionally — a caller
/// distinguishes "no such files" from "this build does not report them" by the
/// key being present and empty.
#[derive(Debug, Clone, Serialize)]
pub struct ChangesReport {
    pub session: String,
    pub project: String,
    pub files: Vec<Change>,
    pub unattributed: Vec<Change>,
    pub foreign: Vec<ForeignChange>,
    #[serde(skip)]
    pub known: bool,
}

impl ChangesReport {
    /// Carry a classified working tree onto the wire shape. `files` is the
    /// attributed bucket; the other two ride along under their own keys.
    pub(crate) fn from_resolved(resolved: ResolvedChanges) -> Self {
        Self {
            session: resolved.session,
            project: resolved.repo_root.to_string_lossy().into_owned(),
            files: resolved.files,
            unattributed: resolved.unattributed,
            foreign: resolved.foreign,
            known: resolved.known,
        }
    }
}

/// The exit-code-bearing outcome of a `changes`/`context` call. The three
/// `Exit2` variants are the ledger's "can't resolve the session" cases the CLI
/// maps to `ExitCode::from(2)`; `Other` is a real error mapped to exit 1 ([F5]).
/// A stringly `Err` would collapse the 0/2 distinction the original `changes` query drew.
#[derive(Debug, Clone)]
pub enum ChangesError {
    /// No session id (neither `--session` nor `$TUG_SESSION_ID`) — exit 2.
    NoSessionId,
    /// No changes ledger on disk — the session can't be known — exit 2.
    NoLedger { session: String },
    /// The session id is unknown to the ledger (no `sessions` row, no events) — exit 2.
    UnknownSession { session: String },
    /// A real error (git/sqlite/io) — exit 1.
    Other(String),
}

impl ChangesError {
    /// Whether this outcome maps to `ExitCode::from(2)` (a ledger-resolution
    /// case) rather than exit 1 (a real error).
    pub fn is_exit_two(&self) -> bool {
        !matches!(self, ChangesError::Other(_))
    }
}

impl fmt::Display for ChangesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChangesError::NoSessionId => write!(
                f,
                "no session id — run inside a Session-card session (which sets \
                 $TUG_SESSION_ID) or pass --session <id>"
            ),
            ChangesError::NoLedger { session } => {
                write!(f, "session '{session}' unknown (no session ledger found)")
            }
            ChangesError::UnknownSession { session } => {
                write!(f, "session '{session}' unknown to the ledger")
            }
            ChangesError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<String> for ChangesError {
    fn from(msg: String) -> Self {
        ChangesError::Other(msg)
    }
}

/// The shared resolution both `changes` and `context`/`commit` build on: the
/// resolved session, repo root, and the three dirty-file buckets ([P02]) plus
/// whether the session is known. `files` is the `attributed` bucket (this
/// session's rows); `unattributed` and `foreign` complete the working-tree
/// universe so nothing dirty is invisible ([P01]).
pub(crate) struct ResolvedChanges {
    pub session: String,
    pub repo_root: PathBuf,
    pub files: Vec<Change>,
    pub unattributed: Vec<Change>,
    pub foreign: Vec<ForeignChange>,
    pub known: bool,
}

/// The classified working tree ([P02]): every dirty path lands in exactly one
/// bucket. `attributed` is this session's rows (today's `Change` shape),
/// `unattributed` has no rows anywhere, `foreign` is claimed only by other
/// sessions on the same repo.
pub(crate) struct Buckets {
    pub attributed: Vec<Change>,
    pub unattributed: Vec<Change>,
    pub foreign: Vec<ForeignChange>,
}

/// Resolve the session, open the ledger, and compute the changed-file set —
/// the core `changes` pipeline, shared by `context` and `commit`. `diff`
/// attaches per-file unified diffs. Returns the exit-2 outcomes as typed
/// [`ChangesError`] variants.
pub(crate) fn resolve_changes(opts: &ChangesOptions) -> Result<ResolvedChanges, ChangesError> {
    let session = opts
        .session
        .clone()
        .or_else(|| std::env::var("TUG_SESSION_ID").ok())
        .filter(|s| !s.is_empty())
        .ok_or(ChangesError::NoSessionId)?;

    let project_dir = match &opts.project {
        Some(p) => p.clone(),
        None => std::env::current_dir()
            .map_err(|e| ChangesError::Other(format!("cannot resolve cwd: {e}")))?,
    };
    let repo_root = repo_root_for(&project_dir);

    // The machine-global changes ledger ([D112]) holds every instance's
    // `file_events`; the per-instance `sessions.db` contributes only the
    // "known session" test. A session recorded by another instance is known
    // through its rows alone.
    let changes_db = ledger::resolve_changes_db_path();
    if !changes_db.exists() {
        return Err(ChangesError::NoLedger { session });
    }
    let conn = ledger::open_readonly(&changes_db)?;
    // Kept open past the known-session test: `sessions.state` is also where a
    // co-owner's liveness comes from, and a dead owner's evidence that no
    // longer places retires from contention ([P03]). No sessions.db at all is
    // no answer, and every owner stays live — today's exact behavior.
    let sessions_conn = ledger::resolve_sessions_db_path()
        .filter(|p| p.exists())
        .and_then(|p| ledger::open_readonly(&p).ok());
    let sessions_known = sessions_conn
        .as_ref()
        .map(|c| ledger::session_exists(c, &session).unwrap_or(false))
        .unwrap_or(false);
    // The self set is the whole **line** of work ([P01]): `$TUG_SESSION_ID`
    // is frozen in the agent's environment at spawn, so after an id rotation
    // (relaunch-resume, rewind-fork) it names an older segment — the rows
    // written under every segment of the same line are still this session's.
    // With no sessions.db (or a pre-lines one), the set is the bare id.
    let mut selves: Vec<String> = vec![session.clone()];
    if let Some(sessions) = sessions_conn.as_ref() {
        for id in ledger::line_segments(sessions, &session) {
            if !selves.contains(&id) {
                selves.push(id);
            }
        }
    }
    let known = sessions_known || ledger::session_has_events(&conn, &selves)?;

    let Buckets {
        mut attributed,
        mut unattributed,
        mut foreign,
    } = compute_changes(&conn, sessions_conn.as_ref(), &repo_root, &selves, opts.all)?;

    // Exit-2 session resolution is unchanged and fires before the buckets are
    // trusted: an unknown id (no rows anywhere, no `sessions` row) is a
    // resolution error regardless of a dirty tree. A *known* session with no
    // attributed files but a dirty tree is not an error — it yields empty
    // `files` + populated `unattributed` ([P01]).
    if attributed.is_empty() && !known {
        return Err(ChangesError::UnknownSession { session });
    }

    if opts.diff {
        for change in &mut attributed {
            change.diff = Some(file_diff(&repo_root, &change.path, &change.git_status));
        }
        for change in &mut unattributed {
            change.diff = Some(file_diff(&repo_root, &change.path, &change.git_status));
        }
        for change in &mut foreign {
            change.diff = Some(file_diff(&repo_root, &change.path, &change.git_status));
        }
    }

    Ok(ResolvedChanges {
        session,
        repo_root,
        files: attributed,
        unattributed,
        foreign,
        known,
    })
}

/// Run the `changes` operation (Spec S01).
pub fn changes(opts: ChangesOptions) -> Result<ChangesReport, ChangesError> {
    Ok(ChangesReport::from_resolved(resolve_changes(&opts)?))
}

/// Invert the join ([P01]): `git status` is the universe, the ledger annotates
/// it. Classify **every dirty path** into one of three buckets ([P02]) over
/// **live** rows (the row-liveness rule, [`min_live_at_ms`]), with **proof
/// rows** (`exact`/`replay` — the tool input named the file) the only evidence
/// that decides ownership, for any session including this one ([D112]):
///
/// - This session has a live proof row → `attributed`; `shared` iff another
///   session also has a live proof row (genuine same-file contention).
/// - No self proof row, but another session has a live proof row → the file
///   is that session's; `foreign`. This session's `bash`/`turn` rows are
///   ignored — a whole-tree fingerprint delta is contaminated by concurrent
///   saves and build churn, so it never overrides a real owner.
/// - No proof owner anywhere → `unattributed`, always. A live self
///   `bash`/`turn` row does NOT auto-attribute: the same delta that sweeps up
///   another session's save also sweeps up the **user's own hand-save** made
///   while the command ran, and the user's editor has no session to claim it
///   back. The bracket row instead becomes a *hint* on the unattributed entry
///   (its `op`/`origin` carry through, e.g. `modified`/`bash`) — "likely this
///   session's" — and inclusion stays an explicit disposition
///   (`--include-unattributed`/`--paths`), exactly like every other
///   unattributed file.
///
/// `all` additionally keeps this session's committed/reverted files (an event
/// row but no longer dirty) in `attributed` — a history view, so liveness does
/// not apply there.
/// Whether this session's work on `path` actually collides with the other
/// owners' — the hunk-aware reading of SHARED ([P12], [P14]).
///
/// Called only for a path that already has two or more live proof owners, so
/// the cost it adds is bounded by contention, not by the dirty set (Risk R09).
/// It short-circuits twice more before spending anything on git: with no live
/// spans at all every owner claims the whole file, which is the answer the
/// pre-spans engine gave; and a diff that will not read leaves the same
/// answer. `true` is the conservative verdict everywhere, so a failure here
/// costs an over-warning, never a false sole claim.
fn paths_contend(
    conn: &Connection,
    sessions_conn: Option<&Connection>,
    repo_root: &Path,
    path: &str,
    selves: &[String],
    foreign: &[String],
    min_live: i64,
) -> Result<bool, String> {
    let spans = ledger::spans_for_path(conn, path)?;
    // Same repo-scoping rule as the owner queries: a span from a checkout
    // that canonicalizes elsewhere is another repo's evidence. A parent dir
    // that fails to canonicalize scopes nothing in — the row degrades out,
    // which at worst widens.
    let canon_root = std::fs::canonicalize(repo_root).ok();
    let mut canon_cache: HashMap<&str, bool> = HashMap::new();
    let mut by_session: HashMap<&str, Vec<contention::Anchor>> = HashMap::new();
    for row in &spans {
        if row.at < min_live {
            continue;
        }
        let same_repo = *canon_cache
            .entry(row.project_dir.as_str())
            .or_insert_with(|| {
                canon_root.as_deref().is_some_and(|root| {
                    std::fs::canonicalize(&row.project_dir).is_ok_and(|p| p == root)
                })
            });
        if !same_repo {
            continue;
        }
        by_session
            .entry(row.session.as_str())
            .or_default()
            .push(contention::Anchor::from_span(&row.kind, &row.anchor));
    }
    if by_session.is_empty() {
        return Ok(true);
    }
    let hunks = match hunks::file_hunks(repo_root, path) {
        Ok(hunks) if !hunks.is_empty() => hunks,
        // No readable hunks (an untracked file's diff is empty, git refused):
        // nothing to place the anchors against.
        _ => return Ok(true),
    };
    // The asking session is running by construction — it is executing this
    // command. Every other owner's liveness comes from `sessions.state`; with
    // no sessions.db to ask, nobody is answered and everybody stays live.
    let states = match sessions_conn {
        Some(sessions) => {
            let ids: Vec<&str> = foreign.iter().map(String::as_str).collect();
            ledger::session_states(sessions, &ids)?
        }
        None => HashMap::new(),
    };
    // The asking line is ONE owner: its segments' anchors pool under the
    // incoming id, so evidence written before an id rotation still narrows
    // the same conversation's claim ([P01]).
    let self_id = selves.first().map(String::as_str).unwrap_or_default();
    let self_anchors: Vec<contention::Anchor> = selves
        .iter()
        .filter_map(|id| by_session.get(id.as_str()))
        .flatten()
        .cloned()
        .collect();
    let owners: Vec<contention::OwnerAnchors> = std::iter::once(contention::OwnerAnchors {
        session: self_id.to_owned(),
        anchors: self_anchors,
        live: true,
    })
    .chain(foreign.iter().map(|id| contention::OwnerAnchors {
        session: id.clone(),
        anchors: by_session.get(id.as_str()).cloned().unwrap_or_default(),
        live: states.get(id.as_str()).copied().unwrap_or(true),
    }))
    .collect();
    // The strong test a `WholeFile` anchor answers. Unreadable answers
    // nothing, which widens.
    let current_file_hash = std::fs::read_to_string(repo_root.join(path))
        .ok()
        .map(|text| hunks::content_hash(&text));
    Ok(contention::classify_contention(&hunks, &owners, current_file_hash.as_deref()).shared)
}

fn compute_changes(
    conn: &Connection,
    sessions_conn: Option<&Connection>,
    repo_root: &Path,
    selves: &[String],
    all: bool,
) -> Result<Buckets, String> {
    let events = ledger::query_events(conn, selves)?;
    let status = git::parse_status_porcelain_v2(&status_output(repo_root));
    let status_map = status.v1_status_map();
    // A renamed path's former name, straight from git. Rows earned under the
    // old name are the file's own history — without this join a `git mv`
    // severs every proof row a session ever wrote for the file, and it lands in
    // `unattributed` under its new name. One hop only: git reports a single
    // `orig_path` per uncommitted rename, and a commit spends both names' rows.
    let orig_by_path: HashMap<&str, &str> = status
        .entries
        .iter()
        .filter(|e| e.renamed)
        .filter_map(|e| e.orig_path.as_deref().map(|orig| (e.path.as_str(), orig)))
        .collect();

    // This session's events grouped per repo-relative path, oldest-first.
    let mut events_by_path: HashMap<String, Vec<ledger::EventRow>> = HashMap::new();
    for ev in events {
        let rel = repo_relative(repo_root, &ev.file_path);
        events_by_path.entry(rel).or_default().push(ev);
    }

    // Walk the working-tree universe in a deterministic order.
    let mut dirty_paths: Vec<String> = status_map.keys().cloned().collect();
    dirty_paths.sort();

    let mut attributed: Vec<Change> = Vec::new();
    let mut unattributed: Vec<Change> = Vec::new();
    let mut foreign: Vec<ForeignChange> = Vec::new();

    for path in &dirty_paths {
        let git_status = status_map.get(path).cloned().unwrap_or_default();
        let self_events = events_by_path.remove(path).unwrap_or_default();
        let orig = orig_by_path.get(path.as_str()).copied();
        let orig_events = orig
            .and_then(|o| events_by_path.remove(o))
            .unwrap_or_default();

        // Cheap SQL probe first; the liveness cut (one `git log` per path)
        // runs only when some row actually claims the path.
        let has_any_claim = !self_events.is_empty()
            || !orig_events.is_empty()
            || !ledger::sessions_for_path(conn, path, selves)?.is_empty()
            || match orig {
                Some(o) => !ledger::sessions_for_path(conn, o, selves)?.is_empty(),
                None => false,
            };
        if !has_any_claim {
            unattributed.push(unattributed_change(path, git_status));
            continue;
        }

        let min_live = min_live_at_ms(repo_root, path);
        let mut live_self: Vec<&ledger::EventRow> =
            self_events.iter().filter(|ev| ev.at >= min_live).collect();
        let mut foreign_proof =
            ledger::foreign_proof_sessions_for_path(conn, path, selves, repo_root, min_live)?;
        if let Some(o) = orig {
            // Each name carries its own liveness cut — the old name's history
            // ends where the file stopped being called that.
            let min_live_orig = min_live_at_ms(repo_root, o);
            live_self.extend(orig_events.iter().filter(|ev| ev.at >= min_live_orig));
            live_self.sort_by_key(|ev| ev.at);
            for claimant in
                ledger::foreign_proof_sessions_for_path(conn, o, selves, repo_root, min_live_orig)?
            {
                if !foreign_proof.contains(&claimant) {
                    foreign_proof.push(claimant);
                }
            }
        }
        let latest_self_proof = live_self
            .iter()
            .rfind(|ev| ledger::origin_is_proof(&ev.origin));

        if let Some(latest) = latest_self_proof {
            // This session provably edited the file. Contention requires
            // another session's *proof* row — bracket rows never mark shared —
            // and, where both sides recorded where they wrote, that their
            // regions actually overlap ([P12]).
            let shared = !foreign_proof.is_empty()
                && paths_contend(
                    conn,
                    sessions_conn,
                    repo_root,
                    path,
                    selves,
                    &foreign_proof,
                    min_live,
                )?;
            attributed.push(Change {
                path: path.clone(),
                op: latest.op.clone(),
                origin: latest.origin.clone(),
                shared,
                sessions: foreign_proof,
                git_status,
                diff: None,
            });
        } else if !foreign_proof.is_empty() {
            // Another session proof-owns the file; this session at most
            // bracket-grabbed it (contamination). It is theirs — foreign.
            foreign.push(ForeignChange {
                path: path.clone(),
                git_status,
                sessions: foreign_proof,
                diff: None,
            });
        } else if let Some(latest) = live_self.last() {
            // Only this session's bracket row claims the path. Correlation
            // never decides — not even for self: the same whole-tree delta
            // that sweeps up other sessions' saves sweeps up the user's own
            // hand-save during the command, and the user's editor has no
            // session to claim it back. The row survives as a hint on the
            // unattributed entry (op/origin carried through), and inclusion
            // stays an explicit disposition.
            unattributed.push(Change {
                path: path.clone(),
                op: latest.op.clone(),
                origin: latest.origin.clone(),
                shared: false,
                sessions: Vec::new(),
                git_status,
                diff: None,
            });
        } else {
            // No live claim of any kind (or only other sessions' bracket
            // contamination) — unattributed: visible, never falsely claimed.
            unattributed.push(unattributed_change(path, git_status));
        }
    }

    // `--all`: also keep this session's no-longer-dirty files (committed or
    // reverted since the event) — they weren't in the status universe above.
    if all {
        let mut leftover: Vec<Change> = events_by_path
            .into_iter()
            .map(|(path, evs)| {
                let latest = evs.last().expect("grouped paths hold at least one event");
                Change {
                    path,
                    op: latest.op.clone(),
                    origin: latest.origin.clone(),
                    shared: false,
                    sessions: Vec::new(),
                    git_status: String::new(),
                    diff: None,
                }
            })
            .collect();
        leftover.sort_by(|a, b| a.path.cmp(&b.path));
        attributed.extend(leftover);
    }

    attributed.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Buckets {
        attributed,
        unattributed,
        foreign,
    })
}

/// The sentinel `Change` for a dirty path no live row claims.
fn unattributed_change(path: &str, git_status: String) -> Change {
    Change {
        path: path.to_owned(),
        op: "unknown".to_string(),
        origin: "none".to_string(),
        shared: false,
        sessions: Vec::new(),
        git_status,
        diff: None,
    }
}

/// The row-liveness cut for `path` (epoch ms): a row is live iff
/// `row.at >= min_live_at_ms`. Derived from the last commit that touched the
/// path (`git log -1 --format=%ct -- <path>`), with the whole commit second
/// treated as spent so ties break toward spent (degrading to `unattributed` —
/// visible, never falsely claimed). A path with no commit history (a
/// new/untracked file) returns 0: nothing was ever absorbed, every row is
/// live.
fn min_live_at_ms(repo_root: &Path, path: &str) -> i64 {
    let out =
        git::git_stdout(repo_root, &["log", "-1", "--format=%ct", "--", path]).unwrap_or_default();
    match out.trim().parse::<i64>() {
        Ok(commit_secs) => (commit_secs + 1) * 1000,
        Err(_) => 0,
    }
}

/// Run `git status --porcelain=v2 --untracked-files=all` at `repo_root`,
/// returning empty on any failure (non-repo, git error). `--untracked-files=all`
/// expands a fully-untracked directory into its individual files ([P06]/G5) so a
/// new file inside one joins as itself, never collapsing to a `? dir/` line the
/// ledger can't match.
fn status_output(repo_root: &Path) -> String {
    git::git_stdout(
        repo_root,
        &["status", "--porcelain=v2", "--untracked-files=all"],
    )
    .unwrap_or_default()
}

/// The per-file unified diff for a `--diff`/`context` change (any bucket).
/// Tracked files use `git diff -- <path>` (working tree); an **untracked** file
/// (`git_status == "??"`, where `git diff` is silent) gets a synthesized
/// add-diff via `git diff --no-index -- /dev/null <path>` (which exits 1 with
/// output when the files differ — the normal case — so its output is used
/// regardless of exit).
fn file_diff(repo_root: &Path, path: &str, git_status: &str) -> String {
    if git_status == "??" {
        match git::git_output(
            repo_root,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", path],
        ) {
            Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
            Err(_) => String::new(),
        }
    } else {
        git::git_stdout(repo_root, &["diff", "--no-color", "--", path]).unwrap_or_default()
    }
}

/// Project an absolute event `file_path` to a repo-relative string. Falls back
/// to the raw path when it doesn't live under `repo_root` (a same-repo session
/// won't hit this; never panics). Already-relative paths pass through.
fn repo_relative(repo_root: &Path, file_path: &str) -> String {
    if !file_path.starts_with('/') {
        return file_path.to_string();
    }
    let p = Path::new(file_path);
    match p.strip_prefix(repo_root) {
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => file_path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git repo with one committed (clean) file and, for each name in
    /// `untracked`, an untracked (dirty) file.
    fn init_repo(untracked: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("clean.rs"), "clean\n").unwrap();
        git(&["add", "clean.rs"]);
        git(&["commit", "-q", "-m", "init"]);
        for name in untracked {
            std::fs::write(root.join(name), "dirty\n").unwrap();
        }
        dir
    }

    /// A sessions.db seeded with one session row plus events
    /// `(file_path, op, origin, ambiguous, at)`.
    fn seed_db(session: &str, events: &[(String, &str, &str, bool, i64)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        conn.execute("INSERT INTO sessions (session_id) VALUES (?1)", [session])
            .unwrap();
        for (i, (path, op, origin, amb, at)) in events.iter().enumerate() {
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', ?4, ?5, ?6, '/p', ?7)",
                rusqlite::params![session, format!("tu-{i}"), path, op, origin, i64::from(*amb), at],
            )
            .unwrap();
        }
        dir
    }

    #[test]
    fn changeset_joins_git_status_and_drops_committed_files() {
        let repo = init_repo(&["dirty.rs"]);
        let root = repo.path();
        let events = vec![
            (
                root.join("dirty.rs").to_string_lossy().into_owned(),
                "write",
                "exact",
                false,
                2,
            ),
            (
                root.join("clean.rs").to_string_lossy().into_owned(),
                "edit",
                "exact",
                false,
                1,
            ),
        ];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();

        let buckets = compute_changes(&conn, None, root, &["s1".to_owned()], false).unwrap();
        let files = buckets.attributed;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "dirty.rs");
        assert_eq!(files[0].op, "write");
        assert_eq!(files[0].git_status, "??");

        let all_files = compute_changes(&conn, None, root, &["s1".to_owned()], true)
            .unwrap()
            .attributed;
        let paths: Vec<&str> = all_files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["clean.rs", "dirty.rs"]);
        let clean = all_files.iter().find(|f| f.path == "clean.rs").unwrap();
        assert_eq!(clean.git_status, "");
    }

    #[test]
    fn diff_on_untracked_file_yields_nonempty_add_diff() {
        let repo = init_repo(&["fresh.rs"]);
        let root = repo.path();
        let events = vec![(
            root.join("fresh.rs").to_string_lossy().into_owned(),
            "created",
            "exact",
            false,
            1,
        )];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();
        let files = compute_changes(&conn, None, root, &["s1".to_owned()], false)
            .unwrap()
            .attributed;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].git_status, "??");

        // The add-diff must be non-empty even though `git diff` alone is silent
        // for a new file (the F2 gap).
        let diff = file_diff(root, &files[0].path, &files[0].git_status);
        assert!(diff.contains("fresh.rs"), "add-diff names the file: {diff}");
        assert!(
            diff.contains("+dirty"),
            "add-diff carries the new content: {diff}"
        );
    }

    /// Current epoch ms — a realistic `at` for a live row (a tracked file's
    /// liveness cut sits at its last commit, made moments ago in these tests).
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn diff_on_tracked_modified_file_is_nonempty() {
        let repo = init_repo(&[]);
        let root = repo.path();
        std::fs::write(root.join("clean.rs"), "clean\nmore\n").unwrap();
        // The edit postdates the init commit → the row is live.
        let events = vec![(
            root.join("clean.rs").to_string_lossy().into_owned(),
            "edit",
            "exact",
            false,
            now_ms() + 2_000,
        )];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();
        let files = compute_changes(&conn, None, root, &["s1".to_owned()], false)
            .unwrap()
            .attributed;
        assert_eq!(files.len(), 1);
        let diff = file_diff(root, &files[0].path, &files[0].git_status);
        assert!(
            diff.contains("+more"),
            "tracked diff carries the edit: {diff}"
        );
    }

    #[test]
    fn spent_rows_never_reclaim_a_redirtied_file() {
        // The row-liveness rule: a session edited `clean.rs` long ago (row at
        // epoch ~0), the file was committed since (init_repo's commit), and now
        // someone re-dirties it. The fossil row must neither attribute nor
        // contend — the file degrades to `unattributed`, visible.
        let repo = init_repo(&[]);
        let root = repo.path();
        std::fs::write(root.join("clean.rs"), "clean\nlater\n").unwrap();
        let events = vec![(
            root.join("clean.rs").to_string_lossy().into_owned(),
            "edit",
            "exact",
            false,
            1,
        )];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();
        let buckets = compute_changes(&conn, None, root, &["s1".to_owned()], false).unwrap();
        assert!(
            buckets.attributed.is_empty(),
            "the spent row does not attribute"
        );
        assert!(buckets.foreign.is_empty());
        assert_eq!(buckets.unattributed.len(), 1);
        assert_eq!(buckets.unattributed[0].path, "clean.rs");
    }

    #[test]
    fn unknown_session_is_unknown_valid_empty_is_known() {
        // The "known" test now lives in `resolve_changes` over the two ledger
        // helpers: a `sessions` row (this instance) or any `file_events` row
        // (any instance, via the shared changes ledger) makes a session known.
        let repo = init_repo(&[]);
        let db = seed_db("s1", &[("x.rs".to_owned(), "write", "exact", false, 1)]);
        let db_path = db.path().join("sessions.db");
        let conn = ledger::open_readonly(&db_path).unwrap();

        assert!(!ledger::session_exists(&conn, "ghost").unwrap());
        assert!(!ledger::session_has_events(&conn, &["ghost".to_owned()]).unwrap());
        let ghost =
            compute_changes(&conn, None, repo.path(), &["ghost".to_owned()], false).unwrap();
        assert!(ghost.attributed.is_empty());

        // Valid session: known via its `sessions` row AND via its rows.
        assert!(ledger::session_exists(&conn, "s1").unwrap());
        assert!(ledger::session_has_events(&conn, &["s1".to_owned()]).unwrap());
    }

    /// Contract test (R04): a hand-built `sessions.db` with today's schema
    /// yields the expected changed files — guards the raw-SQL coupling. The
    /// legacy `ambiguous` column (poisoned to 1 on one row) is ignored
    /// outright: it never surfaces, never excludes, never marks anything.
    #[test]
    fn schema_coupling_contract_ignores_legacy_ambiguous_column() {
        let repo = init_repo(&["a.rs", "amb.rs"]);
        let root = repo.path();
        let events = vec![
            (
                root.join("a.rs").to_string_lossy().into_owned(),
                "write",
                "exact",
                false,
                1,
            ),
            (
                root.join("amb.rs").to_string_lossy().into_owned(),
                "modified",
                "bash",
                true,
                2,
            ),
        ];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();
        let buckets = compute_changes(&conn, None, root, &["s1".to_owned()], false).unwrap();
        assert_eq!(buckets.attributed.len(), 1);
        assert_eq!(buckets.attributed[0].path, "a.rs");
        let hinted = buckets
            .unattributed
            .iter()
            .find(|f| f.path == "amb.rs")
            .unwrap();
        assert_eq!(hinted.origin, "bash", "the bracket hint carries through");
        assert!(
            !hinted.shared && hinted.sessions.is_empty(),
            "a poisoned legacy ambiguous=1 row has no effect on classification"
        );
    }

    #[test]
    fn attributed_provenance_comes_from_the_latest_proof_row() {
        // A path with both a proof row and a later bracket row attributes with
        // the PROOF row's op/origin — a correlation row never overwrites the
        // provenance the read-out shows.
        let repo = init_repo(&["a.rs"]);
        let root = repo.path();
        let p = root.join("a.rs").to_string_lossy().into_owned();
        let events = vec![
            (p.clone(), "write", "exact", false, 1),
            (p.clone(), "modified", "bash", true, 2),
        ];
        let db = seed_db("s1", &events);
        let conn = ledger::open_readonly(&db.path().join("sessions.db")).unwrap();
        let files = compute_changes(&conn, None, root, &["s1".to_owned()], false)
            .unwrap()
            .attributed;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].op, "write");
        assert_eq!(files[0].origin, "exact");
        assert!(!files[0].shared, "a lone session's file is never shared");
    }

    /// Seed a db from `(tug_session_id, repo_relative_path, project_dir)` rows,
    /// registering a `sessions` row for each distinct session — the multi-session
    /// fixture the bucket tests need (the single-session `seed_db` hardcodes an
    /// off-repo `project_dir`, so it can't stand in for a foreign claimant).
    fn seed_sessions(rows: &[(&str, &str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        let mut seen: Vec<String> = Vec::new();
        for (i, (session, file_path, project_dir)) in rows.iter().enumerate() {
            if !seen.iter().any(|s| s == session) {
                conn.execute("INSERT INTO sessions (session_id) VALUES (?1)", [session])
                    .unwrap();
                seen.push(session.to_string());
            }
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', 'edit', 'exact', 0, ?4, ?5)",
                rusqlite::params![session, format!("tu-{i}"), file_path, project_dir, i as i64],
            )
            .unwrap();
        }
        dir
    }

    /// Like [`seed_sessions`] but with an explicit `origin` per row — the
    /// fixture the exact-vs-bracket authorship tests need.
    /// `seed_sessions_origin` with an explicit `at` per row — needed whenever
    /// the path has commit history, since the liveness cut then sits at the
    /// commit's wall-clock second rather than at zero.
    fn seed_sessions_origin_at(rows: &[(&str, &str, &str, &str, i64)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        let mut seen: Vec<String> = Vec::new();
        for (i, (session, file_path, origin, project_dir, at)) in rows.iter().enumerate() {
            if !seen.iter().any(|s| s == session) {
                conn.execute("INSERT INTO sessions (session_id) VALUES (?1)", [session])
                    .unwrap();
                seen.push(session.to_string());
            }
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', 'edit', ?4, 0, ?5, ?6)",
                rusqlite::params![session, format!("tu-{i}"), file_path, origin, project_dir, at],
            )
            .unwrap();
        }
        dir
    }

    /// Wall clock in epoch ms, a few seconds ahead — past the liveness cut of a
    /// commit made during the test.
    fn just_now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            + 5_000
    }

    /// A repo with `tracked.rs` committed, then renamed to `moved.rs` — an
    /// uncommitted rename, which is when the old name's rows still matter.
    fn init_renamed_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("tracked.rs"), "body\n").unwrap();
        git(&["add", "tracked.rs"]);
        git(&["commit", "-q", "-m", "init"]);
        git(&["mv", "tracked.rs", "moved.rs"]);
        dir
    }

    #[test]
    fn a_renamed_path_inherits_proof_written_under_its_old_name() {
        let repo = init_renamed_repo();
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        // The session proof-edited the file before moving it: no row names
        // `moved.rs` at all.
        let db = seed_sessions_origin_at(&[("me", "tracked.rs", "exact", &rootstr, just_now_ms())]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(
            buckets.unattributed.is_empty(),
            "the rename must not strand the file: {:?}",
            buckets.unattributed
        );
        assert_eq!(buckets.attributed.len(), 1);
        assert_eq!(buckets.attributed[0].path, "moved.rs");
        assert_eq!(buckets.attributed[0].origin, "exact");
    }

    #[test]
    fn a_renamed_path_is_foreign_when_the_old_name_was_another_sessions() {
        let repo = init_renamed_repo();
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db =
            seed_sessions_origin_at(&[("theirs", "tracked.rs", "exact", &rootstr, just_now_ms())]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(buckets.attributed.is_empty());
        assert_eq!(buckets.foreign.len(), 1);
        assert_eq!(buckets.foreign[0].path, "moved.rs");
        assert_eq!(buckets.foreign[0].sessions, vec!["theirs".to_string()]);
    }

    #[test]
    fn a_spent_old_name_row_does_not_survive_the_rename() {
        // The old name's rows carry the old name's own liveness cut: a row from
        // before the commit that created `tracked.rs` was already spent, and
        // the rename must not resurrect it.
        let repo = init_renamed_repo();
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin_at(&[("me", "tracked.rs", "exact", &rootstr, 1)]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(
            buckets.attributed.is_empty(),
            "a spent row never attributes"
        );
        assert_eq!(buckets.unattributed.len(), 1);
        assert_eq!(buckets.unattributed[0].path, "moved.rs");
    }

    fn seed_sessions_origin(rows: &[(&str, &str, &str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        let mut seen: Vec<String> = Vec::new();
        for (i, (session, file_path, origin, project_dir)) in rows.iter().enumerate() {
            if !seen.iter().any(|s| s == session) {
                conn.execute("INSERT INTO sessions (session_id) VALUES (?1)", [session])
                    .unwrap();
                seen.push(session.to_string());
            }
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', 'edit', ?4, 0, ?5, ?6)",
                rusqlite::params![session, format!("tu-{i}"), file_path, origin, project_dir, i as i64],
            )
            .unwrap();
        }
        dir
    }

    fn open(db: &tempfile::TempDir) -> Connection {
        ledger::open_readonly(&db.path().join("sessions.db")).unwrap()
    }

    #[test]
    fn dirty_file_with_no_rows_is_unattributed() {
        let repo = init_repo(&["orphan.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        // `mine` exists but only touched a non-dirty file, so it has no claim on
        // the dirty `orphan.rs`.
        let db = seed_sessions(&[("mine", "clean.rs", &rootstr)]);
        let buckets = compute_changes(&open(&db), None, root, &["mine".to_owned()], false).unwrap();

        assert!(buckets.attributed.is_empty());
        assert!(buckets.foreign.is_empty());
        assert_eq!(buckets.unattributed.len(), 1);
        let u = &buckets.unattributed[0];
        assert_eq!(u.path, "orphan.rs");
        assert_eq!(u.op, "unknown");
        assert_eq!(u.origin, "none");
        assert_eq!(u.git_status, "??");
    }

    #[test]
    fn file_claimed_only_by_another_session_is_foreign() {
        let repo = init_repo(&["shared.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions(&[
            ("mine", "clean.rs", &rootstr),
            ("theirs", "shared.rs", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["mine".to_owned()], false).unwrap();

        assert!(buckets.attributed.is_empty());
        assert!(buckets.unattributed.is_empty());
        assert_eq!(buckets.foreign.len(), 1);
        let f = &buckets.foreign[0];
        assert_eq!(f.path, "shared.rs");
        assert_eq!(f.sessions, vec!["theirs".to_string()]);
        assert_eq!(f.git_status, "??");
    }

    /// The wire shape carries the whole classification, not just this
    /// session's share of it. One file per bucket, then the report `changes()`
    /// builds from them.
    #[test]
    fn report_carries_all_three_buckets_onto_the_wire() {
        let repo = init_repo(&["mine.rs", "theirs.rs", "nobodys.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions(&[
            ("mine", "mine.rs", &rootstr),
            ("theirs", "theirs.rs", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["mine".to_owned()], false).unwrap();

        let report = ChangesReport::from_resolved(ResolvedChanges {
            session: "mine".to_string(),
            repo_root: root.to_path_buf(),
            files: buckets.attributed,
            unattributed: buckets.unattributed,
            foreign: buckets.foreign,
            known: true,
        });

        let paths = |c: &[Change]| -> Vec<String> { c.iter().map(|f| f.path.clone()).collect() };
        assert_eq!(paths(&report.files), vec!["mine.rs".to_string()]);
        assert_eq!(paths(&report.unattributed), vec!["nobodys.rs".to_string()]);
        assert_eq!(
            report
                .foreign
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>(),
            vec!["theirs.rs".to_string()]
        );

        let json: serde_json::Value = serde_json::to_value(&report).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["files", "foreign", "project", "session", "unattributed"]
        );
        assert_eq!(json["unattributed"][0]["path"], "nobodys.rs");
        assert_eq!(json["foreign"][0]["path"], "theirs.rs");
        assert_eq!(json["foreign"][0]["sessions"][0], "theirs");
    }

    #[test]
    fn file_touched_by_both_sessions_is_attributed_and_shared() {
        let repo = init_repo(&["shared.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions(&[
            ("mine", "shared.rs", &rootstr),
            ("theirs", "shared.rs", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["mine".to_owned()], false).unwrap();

        assert_eq!(buckets.attributed.len(), 1);
        let mine = &buckets.attributed[0];
        assert_eq!(mine.path, "shared.rs");
        assert!(mine.shared, "a live foreign claim marks the file shared");
        assert_eq!(mine.sessions, vec!["theirs".to_string()]);
        assert!(buckets.foreign.is_empty());
        assert!(buckets.unattributed.is_empty());
    }

    /// A row on a *tracked* file must postdate the commit that created it, or
    /// the liveness cut spends it before contention is ever asked about.
    fn now_millis() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// A repo with one tracked 60-line file, dirtied in two regions far
    /// enough apart that git keeps them as separate hunks.
    fn init_two_region_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(root)
                    .output()
                    .expect("git")
                    .status
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        let original: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
        std::fs::write(root.join("both.rs"), &original).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "init"]);
        let edited = original
            .replace("line005\n", "TOP-EDIT\n")
            .replace("line050\n", "BOTTOM-EDIT\n");
        std::fs::write(root.join("both.rs"), &edited).unwrap();
        let rootstr = root.to_string_lossy().into_owned();
        (dir, rootstr)
    }

    /// Seed two proof rows on one path, each with one `insert` anchor naming
    /// the text that session wrote.
    fn seed_two_owners_with_anchors(
        project_dir: &str,
        path: &str,
        owners: &[(&str, &str)],
    ) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        for (i, (session, written)) in owners.iter().enumerate() {
            conn.execute("INSERT INTO sessions (session_id) VALUES (?1)", [session])
                .unwrap();
            let tool_use_id = format!("tu-{i}");
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Edit', 'edit', 'exact', 0, ?4, ?5)",
                rusqlite::params![session, tool_use_id, path, project_dir, now_millis() + 2_000 + i as i64],
            )
            .unwrap();
            let anchor = serde_json::json!({
                "new_hash": crate::hunks::content_hash(written),
                "new_head": written,
                "new_len": written.len(),
            })
            .to_string();
            conn.execute(
                "INSERT INTO file_event_spans
                    (tug_session_id, tool_use_id, file_path, seq, kind, anchor)
                 VALUES (?1, ?2, ?3, 0, 'insert', ?4)",
                rusqlite::params![session, tool_use_id, path, anchor],
            )
            .unwrap();
        }
        dir
    }

    /// The point of M03: two sessions in one file, each with anchors placing
    /// it in a different hunk, are co-owners without contending.
    #[test]
    fn disjoint_regions_of_one_file_are_not_shared() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_two_owners_with_anchors(
            &rootstr,
            "both.rs",
            &[("mine", "TOP-EDIT"), ("theirs", "BOTTOM-EDIT")],
        );

        let mine =
            compute_changes(&open(&db), None, repo.path(), &["mine".to_owned()], false).unwrap();
        assert_eq!(mine.attributed.len(), 1);
        assert!(
            !mine.attributed[0].shared,
            "disjoint regions do not contend"
        );
        assert_eq!(
            mine.attributed[0].sessions,
            vec!["theirs".to_string()],
            "the co-owner is still named"
        );

        // The same read from the other side — the verdict is symmetric.
        let theirs =
            compute_changes(&open(&db), None, repo.path(), &["theirs".to_owned()], false).unwrap();
        assert_eq!(theirs.attributed.len(), 1);
        assert!(!theirs.attributed[0].shared);
    }

    /// Two checkouts can hold the same relative path; a span recorded under
    /// another repo's `project_dir` is that repo's evidence and must not
    /// shape a claim here.
    #[test]
    fn a_span_from_another_repo_does_not_feed_the_verdict() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_two_owners_with_anchors(
            &rootstr,
            "both.rs",
            &[("mine", "TOP-EDIT"), ("theirs", "BOTTOM-EDIT")],
        );
        {
            // In a *different* repo, `theirs` wrote the same text `mine`
            // wrote here. Unfiltered, that anchor would land `theirs` in
            // `mine`'s hunk and turn disjoint work SHARED.
            let elsewhere = tempfile::tempdir().expect("tempdir");
            let conn = Connection::open(db.path().join("sessions.db")).unwrap();
            let anchor = serde_json::json!({
                "new_hash": crate::hunks::content_hash("TOP-EDIT"),
                "new_head": "TOP-EDIT",
                "new_len": "TOP-EDIT".len(),
            })
            .to_string();
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES ('theirs', 'tu-elsewhere', 'both.rs', 'Edit', 'edit', 'exact', 0, ?1, ?2)",
                rusqlite::params![
                    elsewhere.path().to_string_lossy().into_owned(),
                    now_millis() + 2_020
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_event_spans
                    (tug_session_id, tool_use_id, file_path, seq, kind, anchor)
                 VALUES ('theirs', 'tu-elsewhere', 'both.rs', 0, 'insert', ?1)",
                rusqlite::params![anchor],
            )
            .unwrap();
        }
        let mine =
            compute_changes(&open(&db), None, repo.path(), &["mine".to_owned()], false).unwrap();
        assert_eq!(mine.attributed.len(), 1);
        assert!(
            !mine.attributed[0].shared,
            "another repo's anchor must not contend here"
        );
    }

    #[test]
    fn the_same_region_edited_by_both_is_still_shared() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_two_owners_with_anchors(
            &rootstr,
            "both.rs",
            &[("mine", "TOP-EDIT"), ("theirs", "TOP-EDIT")],
        );
        let mine =
            compute_changes(&open(&db), None, repo.path(), &["mine".to_owned()], false).unwrap();
        assert_eq!(mine.attributed.len(), 1);
        assert!(mine.attributed[0].shared, "one region, two owners");
    }

    /// Seed the two-owner shape with a `state` on each `sessions` row, and an
    /// anchor for `theirs` that names text nothing in the file carries — the
    /// ghost claim. Returns the db dir; `state` is what the test varies.
    fn seed_ghost_co_owner(project_dir: &str, their_state: &str) -> tempfile::TempDir {
        let dir = seed_two_owners_with_anchors(
            project_dir,
            "both.rs",
            &[("mine", "TOP-EDIT"), ("theirs", "SINCE-OVERWRITTEN")],
        );
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN state TEXT")
            .unwrap();
        conn.execute(
            "UPDATE sessions SET state = 'live' WHERE session_id = 'mine'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE sessions SET state = ?1 WHERE session_id = 'theirs'",
            [their_state],
        )
        .unwrap();
        dir
    }

    /// The plan's headline at the sync engine: a closed co-owner whose
    /// evidence places nowhere stops making my file SHARED.
    #[test]
    fn a_dead_co_owner_whose_evidence_places_nowhere_retires() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_ghost_co_owner(&rootstr, "closed");
        let mine = compute_changes(
            &open(&db),
            Some(&open(&db)),
            repo.path(),
            &["mine".to_owned()],
            false,
        )
        .unwrap();
        assert_eq!(mine.attributed.len(), 1);
        assert!(!mine.attributed[0].shared, "the ghost claim retired");
    }

    /// The live floor on the identical fixture: while the co-owner is running
    /// its unplaceable evidence still widens.
    #[test]
    fn the_same_co_owner_still_running_keeps_the_file_shared() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_ghost_co_owner(&rootstr, "live");
        let mine = compute_changes(
            &open(&db),
            Some(&open(&db)),
            repo.path(),
            &["mine".to_owned()],
            false,
        )
        .unwrap();
        assert!(mine.attributed[0].shared, "a live session may be mid-work");
    }

    /// No sessions.db is no answer about anybody, and no answer widens —
    /// today's exact behavior, pinned so it cannot drift into retirement.
    #[test]
    fn with_no_sessions_db_every_owner_stays_live() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_ghost_co_owner(&rootstr, "closed");
        let mine =
            compute_changes(&open(&db), None, repo.path(), &["mine".to_owned()], false).unwrap();
        assert!(
            mine.attributed[0].shared,
            "unconsulted liveness must not retire anything"
        );
    }

    /// The pre-spans world must survive intact: an owner that recorded no
    /// regions claims the whole file, so the file-level answer stands ([P12]).
    #[test]
    fn a_span_less_co_owner_still_contends_at_file_level() {
        let (repo, rootstr) = init_two_region_repo();
        let db = seed_two_owners_with_anchors(&rootstr, "both.rs", &[("mine", "TOP-EDIT")]);
        {
            // `legacy` holds a proof row with no spans at all.
            let conn = Connection::open(db.path().join("sessions.db")).unwrap();
            conn.execute("INSERT INTO sessions (session_id) VALUES ('legacy')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES ('legacy', 'tu-legacy', 'both.rs', 'Bash', 'modified', 'cmd', 0, ?1, ?2)",
                rusqlite::params![rootstr, now_millis() + 2_010],
            )
            .unwrap();
        }
        let mine =
            compute_changes(&open(&db), None, repo.path(), &["mine".to_owned()], false).unwrap();
        assert_eq!(mine.attributed.len(), 1);
        assert!(
            mine.attributed[0].shared,
            "evidence that cannot say where widens to the whole file"
        );
    }

    #[test]
    fn a_bracket_grab_by_another_session_never_marks_my_file_shared() {
        // The pinned regression (meek-sheep): I exact-edited `mine.rs`. Another
        // session's `cargo test` / `git status` bracket swept it up (a whole-
        // tree delta contaminated by my concurrent save) — a `bash` row. That
        // bracket row must NOT make my file `shared`: only an exact row is
        // authorship.
        let repo = init_repo(&["mine.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[
            ("me", "mine.rs", "exact", &rootstr),
            ("bracketer", "mine.rs", "bash", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert_eq!(buckets.attributed.len(), 1);
        let mine = &buckets.attributed[0];
        assert_eq!(mine.path, "mine.rs");
        assert!(
            !mine.shared && mine.sessions.is_empty(),
            "a foreign bracket grab is not contention: {mine:?}"
        );
        assert!(buckets.foreign.is_empty());
    }

    #[test]
    fn a_file_i_only_bracket_grabbed_is_foreign_to_its_exact_owner() {
        // The symmetric case: `theirs.rs` is another session's exact work; my
        // Bash command's bracket grabbed it (I never opened it). It is theirs —
        // foreign to me — and my contaminated bracket row is ignored.
        let repo = init_repo(&["theirs.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[
            ("owner", "theirs.rs", "exact", &rootstr),
            ("me", "theirs.rs", "turn", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(
            buckets.attributed.is_empty(),
            "my bracket grab does not attribute another's file: {:?}",
            buckets.attributed
        );
        assert_eq!(buckets.foreign.len(), 1);
        assert_eq!(buckets.foreign[0].path, "theirs.rs");
        assert_eq!(buckets.foreign[0].sessions, vec!["owner".to_string()]);
    }

    #[test]
    fn a_hand_save_during_my_bash_bracket_is_never_auto_attributed() {
        // The pinned regression for the un-modeled actor: the USER saves a
        // file in their editor while this session's `cargo build` bracket is
        // open. The bracket sweeps it up — a self `bash` row — but the user's
        // editor has no session to claim it back, so correlation must never
        // decide, not even for self. The file surfaces as `unattributed` with
        // the bracket's op/origin as a hint; inclusion is an explicit
        // disposition. (A genuine sed/perl/git-mv edit lands here too — same
        // hint, same one-flag election.)
        let repo = init_repo(&["sed.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[("me", "sed.rs", "bash", &rootstr)]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(
            buckets.attributed.is_empty(),
            "a bracket-only self claim never auto-attributes: {:?}",
            buckets.attributed
        );
        assert!(buckets.foreign.is_empty());
        assert_eq!(buckets.unattributed.len(), 1);
        let hinted = &buckets.unattributed[0];
        assert_eq!(hinted.path, "sed.rs");
        assert_eq!(hinted.origin, "bash", "the hint names the bracket origin");
    }

    #[test]
    fn a_claim_promotes_a_bracket_hint_into_the_session() {
        // The intentional counterpart to the hand-save case above: a file this
        // session only bracket-grabbed (a `perl`/`sed` edit) stays unattributed
        // UNTIL the session claims it. A `claim` row is proof — it moves the
        // file out of the "likely" bucket into the session's attributed set.
        let repo = init_repo(&["sed.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[
            ("me", "sed.rs", "bash", &rootstr),
            ("me", "sed.rs", "claim", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(buckets.unattributed.is_empty(), "the claim clears the hint");
        assert!(buckets.foreign.is_empty());
        assert_eq!(buckets.attributed.len(), 1);
        let claimed = &buckets.attributed[0];
        assert_eq!(claimed.path, "sed.rs");
        assert_eq!(claimed.origin, "claim", "the latest proof is the claim");
        assert!(!claimed.shared, "a self-claim never marks contention");
    }

    #[test]
    fn a_replay_row_attributes_like_an_exact_row() {
        // Replay is exact-tool backfill — proof, not correlation. A session
        // resumed from JSONL keeps ownership of its files.
        let repo = init_repo(&["resumed.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[("me", "resumed.rs", "replay", &rootstr)]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert_eq!(buckets.attributed.len(), 1);
        assert_eq!(buckets.attributed[0].path, "resumed.rs");
        assert_eq!(buckets.attributed[0].origin, "replay");
    }

    #[test]
    fn a_cmd_row_attributes_and_makes_another_session_foreign() {
        // A command that literally named the file is proof, on the same footing
        // as an exact edit — for its own session and, seen from elsewhere, for
        // the other one.
        let repo = init_repo(&["named.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[("me", "named.rs", "cmd", &rootstr)]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();
        assert_eq!(buckets.attributed.len(), 1);
        assert_eq!(buckets.attributed[0].path, "named.rs");
        assert_eq!(buckets.attributed[0].origin, "cmd");

        let theirs = compute_changes(&open(&db), None, root, &["other".to_owned()], false).unwrap();
        assert!(theirs.attributed.is_empty());
        assert_eq!(theirs.foreign.len(), 1, "a cmd row owns the path");
        assert_eq!(theirs.foreign[0].sessions, vec!["me".to_string()]);
    }

    #[test]
    fn a_file_only_others_bracket_grabbed_degrades_to_unattributed() {
        // Only another session's bracket row touches the path (no exact owner
        // anywhere, and I have no row) — unreliable, so it degrades to
        // unattributed: visible, never falsely foreign.
        let repo = init_repo(&["churn.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions_origin(&[
            ("me", "unrelated.rs", "exact", &rootstr),
            ("bracketer", "churn.rs", "bash", &rootstr),
        ]);
        let buckets = compute_changes(&open(&db), None, root, &["me".to_owned()], false).unwrap();

        assert!(buckets.foreign.is_empty(), "bracket-only is never foreign");
        assert_eq!(buckets.unattributed.len(), 1);
        assert_eq!(buckets.unattributed[0].path, "churn.rs");
    }

    #[test]
    fn file_in_untracked_directory_joins_as_itself_not_the_dir() {
        let repo = init_repo(&[]);
        let root = repo.path();
        std::fs::create_dir(root.join("newdir")).unwrap();
        std::fs::write(root.join("newdir/inner.rs"), "dirty\n").unwrap();
        let rootstr = root.to_string_lossy().into_owned();

        // Event row present → attributed, keyed by the FILE (proves -uall/G5:
        // plain porcelain would collapse to `newdir/` and the row would match
        // nothing).
        let db = seed_sessions(&[("mine", "newdir/inner.rs", &rootstr)]);
        let attributed = compute_changes(&open(&db), None, root, &["mine".to_owned()], false)
            .unwrap()
            .attributed;
        assert_eq!(attributed.len(), 1);
        assert_eq!(attributed[0].path, "newdir/inner.rs");
        assert_eq!(attributed[0].git_status, "??");

        // No row → unattributed listing the file path, never `newdir/`.
        let db2 = seed_sessions(&[("mine", "clean.rs", &rootstr)]);
        let unattributed = compute_changes(&open(&db2), None, root, &["mine".to_owned()], false)
            .unwrap()
            .unattributed;
        let paths: Vec<&str> = unattributed.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["newdir/inner.rs"]);
        assert!(!paths.iter().any(|p| p.ends_with('/')));
    }

    #[test]
    fn diff_attaches_to_an_unattributed_untracked_file() {
        let repo = init_repo(&["orphan.rs"]);
        let root = repo.path();
        let rootstr = root.to_string_lossy().into_owned();
        let db = seed_sessions(&[("mine", "clean.rs", &rootstr)]);
        let buckets = compute_changes(&open(&db), None, root, &["mine".to_owned()], false).unwrap();
        assert_eq!(buckets.unattributed.len(), 1);
        let u = &buckets.unattributed[0];
        let diff = file_diff(root, &u.path, &u.git_status);
        assert!(
            diff.contains("orphan.rs"),
            "add-diff names the file: {diff}"
        );
        assert!(
            diff.contains("+dirty"),
            "add-diff carries the content: {diff}"
        );
    }
}
