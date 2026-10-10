//! Reading arcs back: `list`, `show`, `status`, the per-arc detail entries every
//! surface renders, the derived stage, and the rounds an arc branch carries.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

use super::commit::SWEEP_TRAILER_KEY;
use super::documents::{ArcDocuments, document_arcs};
use super::git::{config_get, git_stdout};
use super::identity::{
    BRANCH_PREFIX, arc_base, arc_owner_key, branch_exists, branch_name, description_config_key,
    laid_by_config_key, reconcile_branches, worktree_path,
};
use super::listing::has_uncommitted;
use super::{
    BaseOverlapPath, arc_draft_message, dirty_tracked_paths, intersect_base_dirt, main_repo_root,
    untracked_paths,
};
use crate::error::ArcError;
use crate::log::{ArcDeclaration, ArcDeclarations, FitFact, read_declarations};

/// One entry in the [`list`] outcome.
///
/// Two populations wear this one shape, told apart by `status`. An `active`
/// item is a `tugarc/*` branch: it has a base, a round count, and (unless it
/// was pruned) a worktree. A `paperwork` item is an arc that exists only as
/// documents under `.tug/arcs/<name>/` — the front half of an arc, before any
/// branch — so it carries `documents` and no `base_branch`, `worktree`, or
/// rounds. Listing only the first population is what let the CLI and the Arcs
/// card read as though they disagreed.
#[derive(Debug, Clone, Serialize)]
pub struct ArcListItem {
    pub name: String,
    /// The arc's owner key ([P01]); the legacy branch ref for an id-less arc.
    pub id: Option<String>,
    pub description: Option<String>,
    /// `"active"` for a branched arc, `"paperwork"` for a documents-only one.
    pub status: String,
    pub round_count: i64,
    pub worktree: Option<String>,
    /// The branch this arc forked from. `None` on a `paperwork` item, which
    /// has no branch to have forked anything — never `""`, which would make a
    /// branchless arc structurally indistinguishable from a branched one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// Which of the arc's documents exist, present on a `paperwork` item.
    /// This is what says briefed from planned without inventing a phase: a
    /// branched arc's live documents are in its worktree, so the field stays
    /// `None` there rather than reporting the frozen base copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documents: Option<ArcDocuments>,
    /// The arc's *recorded* kind ([B01]): `"plain"` | `"planned"`. Absent
    /// means the log never said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc_kind: Option<String>,
    /// Who laid this arc, when it was not a person — `<kind>/<name>` for an
    /// agent's staged work ([P15]). `None` on every hand-made arc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub laid_by: Option<String>,
}

/// Outcome of [`show`].
#[derive(Debug, Clone, Serialize)]
pub struct ShowOutcome {
    pub name: String,
    /// The arc's owner key ([P01]); the legacy branch ref for an id-less arc.
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

/// List every arc — both halves of the lifecycle, in one enumeration.
///
/// First every **active** arc (each `tugarc/*` branch), with round count and
/// worktree. Then every **paperwork** arc: a directory under `.tug/arcs/`
/// holding a brief, a plan, or a task list, with no `tugarc/<name>` branch
/// yet. That second population is the front half of an arc — the span between
/// the `/arc` door and the worktree its implement stage takes — and it is
/// where every plain arc begins.
///
/// Reporting only the branched half is what let this verb and the Arcs card
/// read as though they disagreed: the card lists paperwork rows beside live
/// arcs by design, so a name on screen and absent here looked like drift when
/// it was a subset nothing declared. The filter is the same one the card's
/// producer applies — an arc-named directory with at least one document and no
/// branch — so the two cannot diverge on membership. The card additionally
/// lists an *empty* directory a session is bound to, which is a door mid-act
/// and only a caller holding the bindings can identify; this verb has no
/// ledger, so it keeps [`document_arcs`]'s decision.
///
/// Live work outranks waiting paperwork, so the order is branched arcs first,
/// then paperwork, each sorted as its own scan yields it.
pub(crate) fn list_in(repo_root: &Path) -> Result<Vec<ArcListItem>, ArcError> {
    reconcile_branches(repo_root, &mut Vec::new());

    // Every tugarc/* branch is an active arc ([P02]).
    let branches = git_stdout(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/heads/{BRANCH_PREFIX}"),
        ],
    )?;

    let mut items = Vec::new();
    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches(BRANCH_PREFIX).to_string();
        let base = arc_base(repo_root, &name)?;
        let round_count = arc_rounds(repo_root, &base, branch).len() as i64;
        let worktree = worktree_path(repo_root, &name);
        let description = config_get(repo_root, &description_config_key(&name));
        let laid_by = config_get(repo_root, &laid_by_config_key(&name));

        items.push(ArcListItem {
            id: Some(arc_owner_key(repo_root, &name)),
            name,
            description,
            status: "active".to_string(),
            round_count,
            worktree: worktree
                .exists()
                .then(|| worktree.to_string_lossy().into_owned()),
            base_branch: Some(base),
            documents: None,
            arc_kind: None,
            laid_by,
        });
    }

    // The paperwork half: documents with no branch. A directory whose branch
    // exists is already above, so the branch check is what keeps one arc from
    // being listed twice — an arc keeps its base copy of the documents for its
    // whole life, so presence in `.tug/arcs/` says nothing on its own.
    for name in document_arcs(repo_root) {
        if branch_exists(repo_root, &format!("{BRANCH_PREFIX}{name}")) {
            continue;
        }
        let documents = ArcDocuments::read(repo_root, &name);
        let arc_kind = crate::arc::read_arc(repo_root, &name)
            .and_then(|r| r.kind)
            .map(|k| k.as_str().to_owned());
        items.push(ArcListItem {
            id: Some(arc_owner_key(repo_root, &name)),
            description: config_get(repo_root, &description_config_key(&name)),
            laid_by: config_get(repo_root, &laid_by_config_key(&name)),
            name,
            status: "paperwork".to_string(),
            round_count: 0,
            worktree: None,
            base_branch: None,
            documents: Some(documents),
            arc_kind,
        });
    }

    Ok(items)
}

/// Whether an arc's branch is still there, against an explicit repo root.
///
/// The branch is the arc ([P02]): a worktree can be pruned and an arc still
/// stands, but a deleted branch is an arc that is gone. Read by callers
/// deciding whether staged work is still waiting on somebody.
pub fn arc_exists_in(repo_root: &Path, name: &str) -> bool {
    branch_exists(&main_repo_root(repo_root), &branch_name(name))
}

/// How many rounds an arc carries — commits its branch has past its base.
///
/// Zero means nobody wrote in the worktree, which is the whole of the
/// tip-vs-base question a caller tearing an unused arc down is asking. Takes
/// its repo root explicitly, for callers such as tugcast.
pub fn round_count_in(repo_root: &Path, name: &str) -> usize {
    let repo_root = main_repo_root(repo_root);
    let branch = branch_name(name);
    if !branch_exists(&repo_root, &branch) {
        return 0;
    }
    let Ok(base) = arc_base(&repo_root, name) else {
        return 0;
    };
    arc_rounds(&repo_root, &base, &branch).len()
}

/// How many rounds a [`create_in`] revisit would destroy, if it were called
/// now.
///
/// `create_in` is idempotent only where the branch *and* the worktree both
/// stand. With the worktree gone and the branch left behind, its repair path
/// is `git branch -D` followed by a fresh `worktree add` from the base — the
/// right answer for a half-built arc nobody wrote in, and a silent
/// destruction of the work for one somebody did. That was tolerable while
/// the only caller was a person typing `tugtool arc create`; the wheel's
/// dispatch now makes the seat before every implement and audit prompt, so
/// the question has to be asked before the call rather than regretted after
/// it.
///
/// Non-zero means "do not make this seat" — the caller stops the arc and
/// says so, which is the same judgment `doctor`'s `seat-missing` finding
/// makes when it declines to offer a repair. Zero means a revisit is safe:
/// either everything stands, or there is nothing on the branch to lose.
pub fn rounds_a_rebuild_would_lose(repo_root: &Path, name: &str) -> usize {
    let repo_root = main_repo_root(repo_root);
    if !branch_exists(&repo_root, &branch_name(name)) {
        return 0;
    }
    if worktree_path(&repo_root, name).exists() {
        return 0;
    }
    round_count_in(&repo_root, name)
}

/// Show one arc's metadata + rounds (commits ahead of base) + worktree dirt.
pub(crate) fn show_in(repo_root: &Path, name: &str) -> Result<ShowOutcome, ArcError> {
    reconcile_branches(repo_root, &mut Vec::new());
    let branch = branch_name(name);

    if !branch_exists(repo_root, &branch) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }

    let base = arc_base(repo_root, name)?;
    let description = config_get(repo_root, &format!("branch.{}.description", branch));
    let worktree = worktree_path(repo_root, name);

    // Commits ahead of base are this arc's rounds ([P02]) — minus the join
    // arc's preflight sweeps, which are plumbing rather than authored work
    // (Spec S03).
    let rounds: Vec<RoundItem> = arc_rounds(repo_root, &base, &branch)
        .into_iter()
        .map(|r| RoundItem {
            commit_hash: r.hash,
            summary: r.subject,
            started_at: r.committed_at,
        })
        .collect();

    // Uncommitted changes in the worktree, if it is present.
    let uncommitted_changes = if worktree.exists() {
        has_uncommitted(&worktree).ok()
    } else {
        None
    };

    Ok(ShowOutcome {
        name: name.to_string(),
        id: Some(arc_owner_key(repo_root, name)),
        description,
        branch,
        worktree: worktree.to_string_lossy().into_owned(),
        base_branch: base,
        status: "active".to_string(),
        rounds,
        uncommitted_changes,
    })
}

/// One file in an arc's `base...branch` diff, as `git diff --name-status`
/// reports it, with the line counts `--numstat` reports for the same range.
/// The caller maps this into its own file row.
#[derive(Debug, Clone, Serialize)]
pub struct ArcDetailFile {
    /// Path relative to the repository root. A rename reports its destination.
    pub path: String,
    /// The name-status letter (`A`, `M`, `D`, `R`, …).
    pub status: String,
    /// Lines added, `None` for a binary file or when the numstat read failed.
    pub added: Option<u32>,
    /// Lines deleted, on the same terms.
    pub deleted: Option<u32>,
}

/// What a server-driven run ([P01]) is doing on this arc, when one is working
/// it at all — `None` for every arc created by hand.
///
/// Reported **beside** [`ArcDetail::stage`] and never folded into it.
/// [`derive_stage`] answers "what is this arc doing in git"; this answers
/// "which stage of the arc is driving it". The two disagree routinely and both
/// readings are true: an arc whose git stage reads `working` may be sitting on
/// an arc that stopped in `review`, and a surface that collapsed them would
/// have no way to say so.
#[derive(Debug, Clone, Serialize)]
pub struct ArcRunState {
    /// The stage last rotated, or `None` before the first rotation lands.
    pub stage: Option<String>,
    /// Why the arc stopped, when it did ([P11]). Cleared by the next rotation,
    /// because resuming a stopped arc *is* rotating it again.
    pub stopped: Option<String>,
    /// The stage it stopped *in*, which is not necessarily [`Self::stage`]: a
    /// refused rotation stops in the stage it was trying to leave.
    pub stopped_stage: Option<String>,
    /// The stop's own sentence — [`ArcStopReason::sentence`] for the word in
    /// [`Self::stopped`], as the tail of "the arc stopped … because …".
    ///
    /// Composed here so a face never keeps a second table of a vocabulary the
    /// compiler already closes ([B06]): the wire carries the log's word *and*
    /// the English for it, and a display picks whichever register it speaks
    /// in. `None` for a word an older record wrote that no variant claims.
    pub stopped_why: Option<String>,
    /// Whether the arc reached its terminal line.
    pub done: bool,
    /// The arc's most recent note — what it last did, in its own words.
    pub note: Option<String>,
}

/// Everything a display needs about one arc, composed from git in one place.
///
/// This is the shared composition [`arc_detail_entries_in`] returns — the
/// single implementation the CLI and the Changes card's snapshot both read, so
/// the two can no longer drift on what an arc's base, worktree, or round count
/// is.
#[derive(Debug, Clone, Serialize)]
pub struct ArcDetail {
    pub name: String,
    /// The owner key ([P01]) — the identity every ledger row keys by.
    pub owner_key: String,
    /// The git ref (`tugarc/<name>`). Anything that needs a *ref* reads this
    /// and never `owner_key` ([P09]).
    pub branch: String,
    pub base: String,
    pub rounds: u32,
    /// Worktree path relative to the **main** repository root — the root this
    /// composition normalizes to, which is not necessarily the root the caller
    /// asked from. For display by a human who is standing in the repository;
    /// never join it against a caller-held root.
    pub worktree_rel: String,
    /// The arc's worktree, absolute. Resolved here because this is where the
    /// main repository root is known; every consumer that needs a filesystem
    /// path reads this one and composes nothing.
    pub worktree_abs: String,
    pub worktree_dirty: bool,
    pub files: Vec<ArcDetailFile>,
    /// Round commit subjects, newest first; empty when the arc has no rounds.
    pub round_subjects: Vec<String>,
    /// Derived stage ([P03]); `joining` requires a join in flight, so callers
    /// that can also see a draft recompute with [`derive_stage`].
    pub stage: String,
    /// How far a stepped run has got, from the latest step declaration.
    pub step_current: Option<u32>,
    pub step_total: Option<u32>,
    /// What `step_current` *is* — the latest `step-start` declaration's title.
    pub step_title: Option<String>,
    /// Which of this arc's documents exist, with absolute paths ([P01]).
    /// Read from `<repo>/.tug/arcs/<name>/` on every composition — there is
    /// no record of where a plan is, because there is no choice to record.
    pub documents: ArcDocuments,
    /// Commits the base branch has gained past this arc's merge-base — 0 when
    /// the arc already contains the base tip.
    pub base_ahead: u32,
    /// Base-checkout dirty tracked paths that this arc also changes. The join
    /// preflight computes the same intersection at join time; this says it
    /// the moment the overlap appears, which is usually hours earlier. A
    /// warning, never a trigger — uncommitted work on the base is the user's.
    ///
    /// Literally the same set, from the same function: the arc's changed set
    /// is its committed diff **plus** its worktree's uncommitted tracked paths,
    /// because the join's preamble commits that dirt before joining and it
    /// therefore blocks exactly as a committed change would.
    ///
    /// Each path carries its relation, because the blockers composed from this
    /// turn on it: an identical copy is the arc's own bytes and refuses
    /// nothing ([`overlap_relation`]).
    pub base_overlap: Vec<BaseOverlapPath>,
    /// The untracked half of the same intersection — base-checkout files git
    /// does not track yet, which this arc would overwrite on joining.
    pub base_overlap_untracked: Vec<BaseOverlapPath>,
    /// Whether the worktree holds uncommitted changes to **tracked** files.
    ///
    /// Narrower than [`Self::worktree_dirty`], which counts untracked files
    /// too, and the distinction decides a blocker: the join's preamble commits
    /// tracked dirt, so an arc with no rounds but dirty tracked files is not
    /// empty, while one whose only dirt is an untracked scratch file is.
    pub worktree_dirty_tracked: bool,
    /// Whether this arc has finished the work somebody asked it for, derived
    /// by [`crate::log::join_ready`] ([P04]). The join pilot and the standing
    /// prompt both act on this and nothing else, so what a face says and what
    /// the arc does cannot disagree.
    pub join_ready: bool,
    /// The final step of the run's declared selection ([P01]), for display and
    /// for tests. `None` for a generation that declared no run.
    pub run_through: Option<u32>,
    /// Whether that declared selection finished.
    pub run_complete: bool,
    /// How far through the *declared run* this arc has got, from
    /// [`crate::log::run_fraction`] — position within the selection somebody
    /// asked for, which is what every glanceable counter shows.
    ///
    /// Distinct from [`Self::step_current`]/[`Self::step_total`], which stay
    /// plan-absolute: a run of steps 5–7 reports `run_position` 2 while
    /// `step_current` is 6. The ring draws the plan from the latter and lights
    /// this span across it. Both `None` for a generation that declared no run.
    pub run_position: Option<u32>,
    pub run_length: Option<u32>,
    /// The note of the arc log's most recent `replayed` line — the settled
    /// mark's text. `None` when this arc has never been replayed.
    pub last_replay: Option<String>,
    /// What the last green verify said about the tree a join would land.
    /// `None` when nothing has verified this arc. It says; it gates nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitFact>,
    /// When this arc was last touched: the timestamp of the newest arc log
    /// line for its current generation, ISO-8601 UTC. `None` for an arc created
    /// before creation wrote a birth record and never logged anything since.
    pub last_activity: Option<String>,
    /// The run driving this arc ([P01]), when one is. See [`ArcRunState`] for
    /// why it sits beside [`Self::stage`] rather than inside it.
    pub arc: Option<ArcRunState>,
    /// The arc's *recorded* kind ([B01]) — plain or planned, as the arc log
    /// wrote it when the arc opened. `None` is a pre-kind arc: the record does
    /// not say, and nothing here guesses. No document sniff runs on this side.
    pub kind: Option<crate::arc::ArcKind>,
}

/// Read `git diff --name-status -z` records. A rename or copy reports the
/// destination path.
///
/// The records are the door's ([B01]): the status letter is its own record
/// with its score fused to it (`R079`), and the path — or, for a rename, the
/// two paths in `old`, `new` order — follows.
fn name_status_files(records: &[String]) -> Vec<ArcDetailFile> {
    let mut files = Vec::new();
    let mut i = 0;
    while i < records.len() {
        let status = &records[i];
        let Some(letter) = status.chars().next() else {
            i += 1;
            continue;
        };
        i += 1;
        let path = if letter == 'R' || letter == 'C' {
            let dest = records.get(i + 1);
            i += 2;
            dest
        } else {
            let dest = records.get(i);
            i += 1;
            dest
        };
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            files.push(ArcDetailFile {
                path: path.clone(),
                status: status.clone(),
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
fn with_numstat(
    mut files: Vec<ArcDetailFile>,
    numstat: &[tugchanges_core::NumstatEntry],
) -> Vec<ArcDetailFile> {
    let counts: BTreeMap<String, (Option<u32>, Option<u32>)> = numstat
        .iter()
        .map(|e| (e.path.clone(), (e.added, e.deleted)))
        .collect();
    for file in &mut files {
        if let Some((added, deleted)) = counts.get(&file.path) {
            file.added = *added;
            file.deleted = *deleted;
        }
    }
    files
}

/// The arc's `base...branch` file list with its line counts: two reads of
/// one range, joined on path. Either read failing degrades — no status read
/// is an empty list, no numstat read is a list without counts.
fn arc_range_files(repo_root: &Path, base: &str, branch: &str) -> Vec<ArcDetailFile> {
    let range = format!("{base}...{branch}");
    let files = tugchanges_core::listing(repo_root, &["diff", "--name-status", &range])
        .ok()
        .map(|records| name_status_files(&records))
        .unwrap_or_default();
    match tugchanges_core::read_numstat(repo_root, &["diff", "--numstat", &range]).ok() {
        Some(numstat) => with_numstat(files, &numstat),
        None => files,
    }
}

/// The paths a `git diff --name-status -z` listing names, renames reported at
/// their destination.
pub(crate) fn name_status_paths(records: &[String]) -> Vec<String> {
    name_status_files(records)
        .into_iter()
        .map(|file| file.path)
        .collect()
}

/// Every active arc in `repo_root`, with the per-arc detail a display needs.
///
/// The `_in` variant of [`list`] with detail: explicit repo root (the feed
/// composing a snapshot has one and is not cwd-relative), the full
/// `base...branch` file list, round subjects, and worktree dirt.
///
/// A **pure read path** — it resolves each arc's owner key with
/// [`arc_owner_key`] and never mints ([P02]). tugcast's `compose_snapshot`
/// calls this on every recompute, and a read that wrote git config would be a
/// side-effecting read and a multi-process race.
pub fn arc_detail_entries_in(repo_root: &Path) -> Vec<ArcDetail> {
    // The same normalization the join verbs do: a card whose project is a
    // linked worktree must be told about the repository's arcs, keyed the
    // way every other reader keys them — the derived `joining` stage reads the
    // op log out of the main root's state dir.
    let repo_root = &main_repo_root(repo_root);
    let Ok(branches) = git_stdout(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/heads/{BRANCH_PREFIX}"),
        ],
    ) else {
        return Vec::new();
    };

    // One read for the whole repository, hoisted above the per-arc loop: this
    // runs on every aggregate recompute and already spends several git
    // invocations per arc, and the base's dirty set is the same answer for all
    // of them.
    let base_dirt = dirty_tracked_paths(repo_root);
    let base_untracked = untracked_paths(repo_root);

    let mut entries = Vec::new();
    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches(BRANCH_PREFIX);
        // `arc_base`'s detection fallback, deliberately, rather than the bare
        // `"main"` default the feed's duplicate used: a repo whose default
        // branch is not `main` was silently mis-based there.
        let Ok(base) = arc_base(repo_root, name) else {
            continue;
        };

        // One read serves both the count and the subjects, so the two cannot
        // disagree about what a round is (Spec S03).
        let authored = arc_rounds(repo_root, &base, branch);
        let rounds = authored.len() as u32;

        let worktree_abs = worktree_path(repo_root, name);
        let worktree_rel = worktree_abs
            .strip_prefix(repo_root)
            .unwrap_or(&worktree_abs)
            .to_string_lossy()
            .into_owned();
        let worktree_dirty =
            worktree_abs.exists() && has_uncommitted(&worktree_abs).unwrap_or(false);
        let worktree_dirt_tracked = if worktree_abs.exists() {
            dirty_tracked_paths(&worktree_abs)
        } else {
            Vec::new()
        };
        let worktree_dirty_tracked = !worktree_dirt_tracked.is_empty();

        let files = arc_range_files(repo_root, &base, branch);

        // Round subjects, newest first — what the discard preflight
        // lists ([P14]). Empty when the arc has no rounds.
        let round_subjects: Vec<String> = authored.into_iter().map(|r| r.subject).collect();

        // How far the base has run ahead of this arc, and which of the base
        // checkout's uncommitted edits land on files the arc also changed —
        // the divergence a join would otherwise only reveal at merge time.
        let base_ahead = git_stdout(
            repo_root,
            &["rev-list", "--count", &format!("{branch}..{base}")],
        )
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
        // The arc's changed set is what it has committed plus what its
        // worktree holds uncommitted — the join's preamble commits the latter,
        // so it blocks exactly as a committed change does. Composed through the
        // same intersection the preflight uses, so the two cannot drift.
        let mut arc_changed: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        arc_changed.extend(worktree_dirt_tracked.iter().cloned());
        let overlap =
            intersect_base_dirt(repo_root, branch, &base_dirt, &base_untracked, &arc_changed);

        // Two arc log reads per arc per recompute — the declarations and the
        // arc record, each folding the same small append-only file through its
        // own typed reader. No plan markdown is read here ([P01]): the
        // declarations are the record this path derives from.
        let declarations = read_declarations(repo_root, name);
        let arc_record = crate::arc::read_arc(repo_root, name);
        // The recorded kind, taken from the read this block already performs
        // ([F01]) — it used to be dropped here, which is why the deck had
        // nothing to read and the track sniffed documents instead.
        let arc_kind = arc_record.as_ref().and_then(|record| record.kind);
        // Read off the record this block already holds, so the gate costs the
        // recompute's hot path nothing ([P04]).
        let wheel = crate::log::WheelReading::of(arc_record.as_ref());
        let arc = arc_record.map(|record| ArcRunState {
            stage: record.current_stage().map(|s| s.as_str().to_owned()),
            stopped_stage: record
                .stopped
                .as_ref()
                .map(|(stage, _)| stage.as_str().to_owned()),
            stopped: record.stopped.as_ref().map(|(_, reason)| reason.clone()),
            stopped_why: record.stopped.as_ref().and_then(|(_, reason)| {
                crate::arc::ArcStopReason::parse(reason).map(|r| r.sentence().to_owned())
            }),
            done: record.done,
            note: record.notes.last().cloned(),
        });
        let run_span = crate::log::run_fraction(&declarations);
        // The other reading of a join in flight, and deliberately the wide
        // one: any teardown under way — live or left by a crash — means this
        // arc is not joinable right now, so readiness stands down either way. The blocker
        // set makes the opposite call for the opposite reason; see
        // `join_blockers_from_detail`.
        let joining = crate::oplog::join_in_flight(repo_root, name).is_some();
        let documents = ArcDocuments::read(repo_root, name);
        // Every input is already in hand from this arc's own composition, so
        // readiness costs no extra git call on the recompute's hot path ([P04]).
        let join_ready = crate::log::join_ready(
            rounds,
            crate::log::unfinished_tracked_dirt(&worktree_dirt_tracked),
            joining,
            &declarations,
            documents.plan.is_some(),
            wheel,
        );

        entries.push(ArcDetail {
            owner_key: arc_owner_key(repo_root, name),
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
            kind: arc_kind,
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

/// One arc's detail, composed exactly as [`arc_detail_entries_in`] composes
/// every arc's.
///
/// Shares that walk rather than reimplementing it, so a caller asking about one
/// arc and a caller asking about all of them cannot get different answers about
/// the same arc. Returns `None` when the arc has no branch.
pub fn arc_detail_entry_in(repo_root: &Path, name: &str) -> Option<ArcDetail> {
    let repo_root = &main_repo_root(repo_root);
    arc_detail_entries_in(repo_root)
        .into_iter()
        .find(|d| d.name == name)
}

/// The fit fact an arc's declarations carry, with its currency resolved
/// against the live tips.
///
/// Both endpoints are compared, because a base that moved invalidates a
/// verified head just as surely as a new round does. An unparseable note
/// yields `None` rather than a fact with half its pair.
pub(crate) fn fit_fact(
    repo: &Path,
    branch: &str,
    base_branch: &str,
    declarations: &ArcDeclarations,
) -> Option<FitFact> {
    let note = declarations.last_verified.as_deref()?;
    let (head, base) = crate::log::parse_verified_note(note)?;
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
/// One arc's lifecycle readout (Spec S05) — the machine-readable answer to
/// "where is this arc?".
#[derive(Debug, Clone, Serialize)]
pub struct ArcStatus {
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
    /// The live session mated to this arc ([P08]) — one arc, one card. Absent
    /// when unresolvable, when the binding column has not migrated in yet, or
    /// when the bound card has closed, which is how *unbound* reads.
    pub bound_session: Option<String>,
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
    /// Which of this arc's documents exist, with absolute paths ([P01]).
    pub documents: ArcDocuments,
    /// When this arc was last touched — the newest arc log line's timestamp
    /// for the current generation, ISO-8601 UTC.
    pub last_activity: Option<String>,
    /// What the last green verify said about the tree a join would land, and
    /// whether it still stands. Absent when nothing has verified this arc —
    /// which is the honest record of "not verified". It gates nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitFact>,
    /// The standing conflict, when this arc has one.
    ///
    /// Derived at read time from `refs/tug/conflict/<name>` and absent — not
    /// zeroed — when no *valid* chain stands, so the field's presence is the
    /// answer to "is this arc conflicted" and a stale chain can never
    /// masquerade as a live one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictSummary>,
    /// Where this arc's five records disagree, one sentence each — the
    /// read-only core of `arc doctor`, run on every status call.
    ///
    /// A status that answers from one side of a disagreement is exactly how
    /// a desync goes unnoticed: join-arming derives from the arc log while
    /// the arc's resume pointer derives from the markdown table, so a status
    /// composed from the log alone reads perfectly confident about an arc
    /// whose next step is not where it says. Empty when the records agree,
    /// which is the ordinary case and costs a status call one document parse.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disagreements: Vec<String>,
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

/// Summarize an arc's standing conflict, or `None` when none does.
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

/// The stage an arc is in, from what git derives and what the arc declared.
///
/// Precedence is
/// `joining > built|audited > ready > implementing > draft-ready > working >
/// created` ([P03], [P07]): a join in flight outranks everything; otherwise a
/// declared mark wins, because the last thing a run said about itself is the
/// truest current answer; an arc the machine derives as joinable reads `ready`;
/// only an undeclared arc falls through to the derived chain, where an
/// authored draft outranks mere activity and any round or worktree dirt
/// outranks a freshly created arc.
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
    declared: Option<ArcDeclaration>,
    join_ready: bool,
) -> &'static str {
    if joining {
        "joining"
    } else if matches!(declared, Some(ArcDeclaration::Built)) {
        "built"
    } else if matches!(declared, Some(ArcDeclaration::Audited)) {
        "audited"
    } else if join_ready {
        // Above the step arm: a finished run's latest declaration is a
        // `step-done`, which would otherwise read `implementing` forever. Below
        // `built`/`audited` so an arc somebody marked keeps its own word ([P07]).
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

/// One `sessions` row read by arc, in whatever state it is in.
///
/// [`bound_session_for`] answers "is anybody seated" and is defined over live
/// rows alone; this answers the question that begins where that one ends —
/// *the arc has a seat and it is not live, so what became of it?* A demote
/// keeps `arc_id` (it closes the process, not the session) while a deliberate
/// close clears it, so a row still naming the arc while reading `closed` is
/// the startup-demote corpse and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatRow {
    /// The segment the binding sits on.
    pub session_id: String,
    /// The ledger's own word: `live`, `closed`, …
    pub state: String,
    /// `closed` by the startup demote rather than by a person.
    pub demoted: bool,
    /// The card the segment is seated in, when it is seated in one.
    pub card_id: Option<String>,
}

/// The seat `owner_key`'s arc is bound to, live or not.
///
/// A live row wins over a dead one — a card that rotated leaves the old
/// segment behind, and the arc's seat is whichever segment is live now — so a
/// reading here is quiet on every healthy arc and answers only where there is
/// no live row to prefer. Best-effort on the same terms as
/// [`bound_session_for`]: no db, no table, no `demoted` column all read as
/// absent.
pub(crate) fn seat_row_for(owner_key: &str) -> Option<SeatRow> {
    let db = sessions_db_file()?;
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return None;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, state, demoted, card_id FROM sessions \
         WHERE arc_id = ?1 \
         ORDER BY (state = 'live') DESC, last_used_at DESC LIMIT 1",
    ) else {
        return None;
    };
    stmt.query_map(rusqlite::params![owner_key], |row| {
        Ok(SeatRow {
            session_id: row.get(0)?,
            state: row.get(1)?,
            demoted: row.get::<_, i64>(2)? != 0,
            card_id: row
                .get::<_, Option<String>>(3)?
                .filter(|card| !card.is_empty()),
        })
    })
    .ok()
    .and_then(|mut rows| rows.next().and_then(Result::ok))
}

/// The live session bound to `owner_key`, read read-only from the per-instance
/// `sessions.db` ([P08], [Q02] — this instance's view only).
///
/// **Live sessions only**, under the same predicate the tugcast-side query
/// uses: bound-ness is defined over live sessions, so a row that outlived its
/// card is never reported and an arc whose cards have all closed reads as
/// unbound. Best-effort throughout — no db, no table, no `arc_id` column (an
/// unmigrated ledger) all read as absent.
pub(crate) fn bound_session_for(owner_key: &str) -> Option<String> {
    let db = sessions_db_file()?;
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return None;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id FROM sessions \
         WHERE arc_id = ?1 AND state = 'live' ORDER BY last_used_at DESC LIMIT 1",
    ) else {
        return None;
    };
    stmt.query_map(rusqlite::params![owner_key], |row| row.get::<_, String>(0))
        .ok()
        .and_then(|mut rows| rows.next().and_then(Result::ok))
}

/// One arc's lifecycle readout against `repo_root` (Spec S05).
///
/// A pure read path: it resolves the owner key without minting ([P02]).
pub fn status_in(repo_root: &Path, name: &str) -> Result<ArcStatus, ArcError> {
    let branch = branch_name(name);
    if !branch_exists(repo_root, &branch) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }

    let base_branch = arc_base(repo_root, name)?;
    let id = arc_owner_key(repo_root, name);
    let rounds = arc_rounds(repo_root, &base_branch, &branch).len() as i64;

    let worktree = worktree_path(repo_root, name);
    let worktree_dirty = worktree.exists() && has_uncommitted(&worktree).unwrap_or(false);

    // Readiness is measured over tracked dirt only ([P04]), which the porcelain
    // read above cannot answer — an untracked scratch file makes `worktree_dirty`
    // true and must not make the arc unready, or `arc status` would disagree
    // with the feed about the same arc. This is the CLI path, not the
    // recompute, so the extra git call costs the hot path nothing.
    let worktree_dirt_tracked = if worktree.exists() {
        dirty_tracked_paths(&worktree)
    } else {
        Vec::new()
    };
    let documents = ArcDocuments::read(repo_root, name);

    let draft = arc_draft_message(repo_root, &branch).is_some();
    let join_journal_phase = crate::oplog::join_in_flight(repo_root, name)
        .and_then(|op| op.join)
        .map(|progress| format!("{:?}", progress.phase));
    let bound_session = bound_session_for(&id);
    let declarations = read_declarations(repo_root, name);
    let run_span = crate::log::run_fraction(&declarations);
    let fit = fit_fact(repo_root, &branch, &base_branch, &declarations);
    // The read this path does not otherwise make. `arc status` must not
    // disagree with the feed about the same arc, and the feed derives this
    // from the record — so this path reads the record too. It is the CLI, not
    // the recompute, so one more fold of a small append-only file is free.
    let wheel = crate::log::WheelReading::of(crate::arc::read_arc(repo_root, name).as_ref());
    let join_ready = crate::log::join_ready(
        rounds.max(0) as u32,
        crate::log::unfinished_tracked_dirt(&worktree_dirt_tracked),
        join_journal_phase.is_some(),
        &declarations,
        documents.plan.is_some(),
        wheel,
    );

    Ok(ArcStatus {
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
        bound_session,
        step_current: declarations.step.map(|(current, _)| current as i64),
        step_total: declarations.step.map(|(_, total)| total as i64),
        run_position: run_span.map(|(position, _)| position as i64),
        run_length: run_span.map(|(_, length)| length as i64),
        step_title: declarations.step_title.clone(),
        documents,
        last_activity: declarations.last_activity.clone(),
        fit,
        conflict: conflict_summary(repo_root, name),
        disagreements: crate::doctor::diagnose(repo_root, name).sentences(),
    })
}

/// The arc worktree's uncommitted tracked paths, or empty when it has no
/// worktree ([P08]).
///
/// What a resumed stage cannot learn from its own transcript: a stop
/// terminates the claude mid-edit and the bytes stay on disk, so a rotated
/// session inherits a tree whose changes nothing has explained to it. This is
/// the read the prompt's dirty clause names.
///
/// The same `git diff --name-only HEAD` [`dirty_tracked_paths`] already makes
/// per arc — no new git invocation shape, which is what [D171] is about. An
/// absent worktree is empty rather than an error: there is nothing to explain
/// about a tree that does not exist.
pub fn worktree_dirt(repo_root: &Path, name: &str) -> Vec<String> {
    let worktree = worktree_path(repo_root, name);
    if !worktree.exists() {
        return Vec::new();
    }
    dirty_tracked_paths(&worktree)
}

/// The arc's maintained draft ([P23], Spec S09) — the default join message
/// when the caller supplies none. Read-only from `sessions.db`; any absence
/// (no db, no table, no row) falls through to `None`.
/// Resolve the `sessions.db` path — the running instance's, else the
/// platform default. Read-only callers only.
pub(super) fn sessions_db_file() -> Option<std::path::PathBuf> {
    tugcore::instance::resolve_sessions_db_path()
}

/// One authored round on an arc branch.
#[derive(Debug, Clone)]
pub(crate) struct ArcRound {
    pub hash: String,
    pub subject: String,
    pub committed_at: String,
}

/// An arc's rounds — every commit ahead of its base **except** the join's
/// preflight sweeps (Spec S03). Newest first, as git logs them.
///
/// This is the one reader. `rounds` was four separate `rev-list --count`s
/// before, which meant the sweep counted as authored work in four places at
/// once — including the round count this phase's own join receipt prints, and
/// the number `join_ready` and `derive_stage` read to decide whether an arc
/// has done anything worth joining. An arc whose only commit is a sweep now
/// reports zero rounds, which is the truth: nothing was authored.
///
/// Sweeps written before the trailer existed carry no mark and still count.
/// They are not rewritten — history is not edited to make a count prettier —
/// and they age out as their arcs join or are discarded.
pub(crate) fn arc_rounds(repo_root: &Path, base: &str, branch: &str) -> Vec<ArcRound> {
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
            Some(ArcRound {
                hash,
                subject,
                committed_at,
            })
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::log::{MarkStage, append_arc_log};
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// The numstat fold keys on the destination path a rename reports, so the
    /// two reads of one range meet; a binary file's `-` stays `None`; a path
    /// the numstat does not name is left uncounted rather than zeroed.
    ///
    /// Both sides are `-z` records ([B01]), so a rename arrives as its status
    /// letter and two path records on the name-status side and as an empty
    /// path field followed by two path records on the numstat side. A path
    /// that git would have C-quoted is in the fixture because that is the
    /// whole point of reading records rather than lines.
    #[test]
    fn numstat_folds_onto_name_status_by_destination_path() {
        let records: Vec<String> = [
            "M", "a.rs", "R100", "olł.rs", "neł.rs", "A", "pic.png", "D", "gone.rs",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        let files = name_status_files(&records);
        let numstat_records: Vec<String> =
            ["3\t1\ta.rs", "0\t0\t", "olł.rs", "neł.rs", "-\t-\tpic.png"]
                .iter()
                .map(|s| (*s).to_string())
                .collect();
        let numstat = tugchanges_core::parse_numstat_records(&numstat_records);
        let folded = with_numstat(files, &numstat);
        let got: Vec<(&str, Option<u32>, Option<u32>)> = folded
            .iter()
            .map(|f| (f.path.as_str(), f.added, f.deleted))
            .collect();
        assert_eq!(
            got,
            vec![
                ("a.rs", Some(3), Some(1)),
                ("neł.rs", Some(0), Some(0)),
                ("pic.png", None, None),
                ("gone.rs", None, None),
            ]
        );
    }

    /// The regression the Arcs card exposed: an arc that exists only as
    /// documents was invisible to `arc list`, so a name on screen had no
    /// answer here and read as drift between two surfaces.
    #[test]
    #[serial]
    fn list_reports_the_paperwork_half_beside_the_branched_one() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("branched", None, false, None).unwrap();
        let root = fs::canonicalize(&repo).unwrap();

        // Paperwork: a brief and a task list, no branch.
        let dir = documents_dir(&root, "waiting");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("brief.md"), "# Waiting\n").unwrap();
        fs::write(dir.join("tasks.md"), "# Tasks\n").unwrap();
        // Litter: an arc-named directory holding nothing is not an arc.
        fs::create_dir_all(documents_dir(&root, "abandoned")).unwrap();

        let items = list().unwrap();
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["branched", "waiting"],
            "live work first, then paperwork, and never the empty directory"
        );

        let branched = &items[0];
        assert_eq!(branched.status, "active");
        assert!(branched.base_branch.is_some(), "a branched arc has a base");
        assert!(
            branched.documents.is_none(),
            "a branched arc's live documents are in its worktree, not here"
        );

        let waiting = &items[1];
        assert_eq!(waiting.status, "paperwork");
        assert!(
            waiting.base_branch.is_none() && waiting.worktree.is_none(),
            "a branchless arc must not report a base or a worktree"
        );
        assert_eq!(waiting.round_count, 0);
        let documents = waiting.documents.as_ref().expect("documents reported");
        assert!(documents.brief.is_some() && documents.tasks.is_some());
        assert!(documents.plan.is_none());
    }

    /// The double-listing the branch filter prevents: adoption leaves the base
    /// copy of the documents exactly where it was, so an arc mid-implement has
    /// both a branch and a `.tug/arcs/<name>/` directory for its whole life.
    #[test]
    #[serial]
    fn list_never_reports_one_arc_as_both_active_and_paperwork() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("adopted", None, false, None).unwrap();
        let dir = documents_dir(&fs::canonicalize(&repo).unwrap(), "adopted");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plan.md"), "# Adopted\n").unwrap();

        let items = list().unwrap();
        assert_eq!(items.len(), 1, "one arc, one row");
        assert_eq!(items[0].status, "active");
    }

    // -----------------------------------------------------------------------
    // The sweep is marked, and is not a round (Spec S03)
    // -----------------------------------------------------------------------

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

        let detail = arc_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "swept-count")
            .expect("the arc is listed");
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
    fn a_arc_whose_only_commit_is_a_sweep_has_no_rounds() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("sweep-only", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "sweep-only");
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "sweep-only").unwrap();

        let detail = arc_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "sweep-only")
            .expect("the arc is listed");
        // Nothing was authored, so there is nothing to join — and `join_ready`
        // refuses on `rounds < 1` even with the run declared complete.
        assert_eq!(detail.rounds, 0);
        let decls = crate::log::ArcDeclarations {
            run_complete: true,
            ..Default::default()
        };
        assert!(!crate::log::join_ready(
            detail.rounds,
            false,
            false,
            &decls,
            true,
            crate::log::WheelReading::Off
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
        tugcore::git_command()
            .arg("-C")
            .arg(&worktree)
            .args(["add", "-A"])
            .output()
            .unwrap();
        tugcore::git_command()
            .arg("-C")
            .arg(&worktree)
            .args(["commit", "-q", "-m", "join: commit outstanding changes"])
            .output()
            .unwrap();

        let detail = arc_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "legacy-sweep")
            .expect("the arc is listed");
        // The filter keys on the trailer, never on the subject. A sweep written
        // before the marker existed keeps counting rather than having its
        // history rewritten under it.
        assert_eq!(detail.rounds, 1);
    }

    #[serial]
    #[test]
    fn every_round_reader_agrees_about_a_swept_arc() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("agreeing", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "agreeing");
        author_round(&worktree, 1);
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "agreeing").unwrap();

        let detail = arc_detail_entries_in(&repo)
            .into_iter()
            .find(|d| d.name == "agreeing")
            .expect("the arc is listed");
        let status = status_in(&repo, "agreeing").unwrap();
        let shown = show("agreeing").unwrap();
        let listed = list()
            .unwrap()
            .into_iter()
            .find(|d| d.name == "agreeing")
            .expect("the arc is listed");
        // Four readers, one definition of a round.
        assert_eq!(detail.rounds, 1);
        assert_eq!(status.rounds, 1);
        assert_eq!(shown.rounds.len(), 1);
        assert_eq!(listed.round_count, 1);
    }

    // ── the audit's gate, over a real arc log ───────────────────────────

    /// **The offer waits for the audit.** A finished run under a live wheel
    /// is recorded and not yet offered; `built` does not offer it; `audited`
    /// does. A stop is not an escape from this (see the test below), only
    /// the unaudited join is, and that is the user's act.
    #[serial]
    #[test]
    fn a_live_wheel_holds_the_offer_until_the_audit() {
        let (_temp, root) = wheeled_arc("audit-gate-arc");
        let detail = arc_detail_entry_in(&root, "audit-gate-arc").unwrap();
        assert!(
            detail.run_complete,
            "the run finished, and the record says so"
        );
        assert!(
            !detail.join_ready,
            "but the audit may still commit rounds, so nothing is offered yet"
        );

        mark("audit-gate-arc", MarkStage::Built, None).unwrap();
        assert!(
            !arc_detail_entry_in(&root, "audit-gate-arc")
                .unwrap()
                .join_ready,
            "`built` is the implement stage's own word and does not arm the join"
        );

        mark("audit-gate-arc", MarkStage::Audited, None).unwrap();
        assert!(
            arc_detail_entry_in(&root, "audit-gate-arc")
                .unwrap()
                .join_ready,
            "the audit's declaration is the one that arms it"
        );
    }

    /// **A stopped wheel holds the offer until the audit marks.** An arc
    /// stopped *before* its audit is the same fact as one stopped in it: the
    /// audit did not mark. A wheel that broke cannot leave finished work
    /// unlandable — `arc join` lands the unaudited branch — but the offer is
    /// never called ready over a tree nothing audited.
    #[serial]
    #[test]
    fn a_stopped_wheel_holds_the_offer_until_the_audit_marks() {
        let (_temp, root) = wheeled_arc("audit-stop-arc");
        mark("audit-stop-arc", MarkStage::Built, None).unwrap();
        assert!(
            !arc_detail_entry_in(&root, "audit-stop-arc")
                .unwrap()
                .join_ready
        );

        crate::arc::append_arc_stop(
            &root,
            "audit-stop-arc",
            crate::arc::ArcStage::Implement,
            crate::arc::ArcStopReason::Stalled,
        )
        .unwrap();
        let feed = arc_detail_entry_in(&root, "audit-stop-arc").unwrap();
        assert!(feed.run_complete, "the implement stage closed every step");
        assert!(
            !feed.join_ready,
            "a wheel that broke before the audit is an arc nothing audited, and is not ready"
        );
        let cli = status_in(&root, "audit-stop-arc").unwrap();
        assert_eq!(
            cli.stage, feed.stage,
            "the CLI reads the same arc the same way"
        );
        assert_ne!(cli.stage, "ready");

        mark("audit-stop-arc", MarkStage::Audited, None).unwrap();
        assert!(
            arc_detail_entry_in(&root, "audit-stop-arc")
                .unwrap()
                .join_ready,
            "the audit's own declaration is the one thing that arms it"
        );
    }

    /// **A stop in the audit is not the escape.** The stop means the audit
    /// did not mark, and an offer wearing `ready` over an unaudited tree is
    /// the thing the gate exists to refuse — whether the wheel stalled or a
    /// person stopped it. The branch stays landable; it is never called
    /// ready. Both readers of the record agree.
    #[serial]
    #[test]
    fn a_stopped_audit_is_not_offered_over_a_real_log() {
        let (_temp, root) = wheeled_arc("audit-unmarked-arc");
        crate::arc::append_arc_stage(
            &root,
            "audit-unmarked-arc",
            crate::arc::ArcStage::Audit,
            "sess-2",
            None,
        )
        .unwrap();
        crate::arc::append_arc_stop(
            &root,
            "audit-unmarked-arc",
            crate::arc::ArcStage::Audit,
            crate::arc::ArcStopReason::Stalled,
        )
        .unwrap();
        let feed = arc_detail_entry_in(&root, "audit-unmarked-arc").unwrap();
        assert!(feed.run_complete, "the implement stage closed every step");
        assert!(
            !feed.join_ready,
            "and the audit stopped without marking, so nothing is ready"
        );
        let cli = status_in(&root, "audit-unmarked-arc").unwrap();
        assert_eq!(
            cli.stage, feed.stage,
            "the CLI reads the same arc the same way"
        );
        assert_ne!(cli.stage, "ready");

        mark("audit-unmarked-arc", MarkStage::Audited, None).unwrap();
        assert!(
            arc_detail_entry_in(&root, "audit-unmarked-arc")
                .unwrap()
                .join_ready,
            "the audit's own declaration is the one thing that arms it"
        );
    }

    /// **`arc status` and the feed answer the same question the same way.**
    /// The two paths read the record separately — the feed from one it already
    /// holds, the CLI from a read it makes for this — through one
    /// `WheelReading::of`, and a divergence would mean the card and the
    /// terminal disagree about one arc.
    ///
    /// `ArcStatus` carries no `join_ready` field, so readiness reaches a user
    /// through the derived stage word alone — which makes that word the whole
    /// of the observable disagreement [R03] is about. The undeclared run is
    /// the case that discriminates: a `status_in` that skipped the gate would
    /// say `ready` here while the feed said `implementing`.
    #[serial]
    #[test]
    fn status_and_the_feed_agree_mid_audit() {
        let (_temp, root) = wheeled_arc("audit-agree-arc");
        let feed = arc_detail_entry_in(&root, "audit-agree-arc").unwrap();
        let cli = status_in(&root, "audit-agree-arc").unwrap();
        assert_eq!(
            cli.stage, feed.stage,
            "the CLI and the feed read one arc the same way"
        );
        assert_eq!(cli.stage, "implementing", "and both are behind the gate");

        // And both move together when the audit declares.
        mark("audit-agree-arc", MarkStage::Audited, None).unwrap();
        let feed = arc_detail_entry_in(&root, "audit-agree-arc").unwrap();
        let cli = status_in(&root, "audit-agree-arc").unwrap();
        assert!(feed.join_ready);
        assert_eq!(cli.stage, feed.stage);
        assert_eq!(cli.stage, "audited");
    }

    /// **The gate reaches the derived word, and only for an undeclared run.**
    /// `derive_stage` consumes `join_ready` and spends it on the `ready` arm,
    /// so an arc armed only by `run_complete` now derives `implementing` mid-
    /// audit where it derived `ready` before. That is the truer word — a stage
    /// is still running — but it must be pinned rather than discovered,
    /// because `implementing` is not in the deck's `JOINABLE_STAGES`.
    #[serial]
    #[test]
    fn the_gate_moves_the_derived_word_only_for_an_undeclared_run() {
        let (_temp, root) = wheeled_arc("audit-word-arc");
        assert_eq!(
            arc_detail_entry_in(&root, "audit-word-arc").unwrap().stage,
            "implementing",
            "a run armed only by `run_complete` reads as the stage still running"
        );

        // A declared `built` outranks the `join_ready` arm, so the word a
        // wheel's own implement stage produces is unchanged by the gate.
        mark("audit-word-arc", MarkStage::Built, None).unwrap();
        assert_eq!(
            arc_detail_entry_in(&root, "audit-word-arc").unwrap().stage,
            "built"
        );
    }

    /// The incident's shape, inverted: an arc driven only by the verbs a run
    /// cannot skip is offerable without anybody declaring anything ([P01]–[P04]).
    #[serial]
    #[test]
    fn a_finished_run_reads_ready_without_a_mark() {
        let (_temp, root) = stepped_arc("ready-arc");
        let worktree = worktree_path(&root, "ready-arc");

        step_start("ready-arc", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("ready-arc", "r1", None).unwrap();

        // Mid-run: a step is open and the selection is unfinished.
        let detail = arc_detail_entry_in(&root, "ready-arc").unwrap();
        assert!(!detail.join_ready);
        assert_eq!(detail.stage, "implementing");
        assert_eq!(detail.run_through, Some(2));

        step_done("ready-arc", 1, None).unwrap();
        // Still short of the declared end.
        let detail = arc_detail_entry_in(&root, "ready-arc").unwrap();
        assert!(!detail.join_ready);
        assert!(!detail.run_complete);

        step_start("ready-arc", 2, 2).unwrap();
        fs::write(worktree.join("two.txt"), "second\n").unwrap();
        commit("ready-arc", "r2", None).unwrap();
        step_done("ready-arc", 2, None).unwrap();

        let detail = arc_detail_entry_in(&root, "ready-arc").unwrap();
        assert!(detail.run_complete);
        assert!(detail.join_ready, "the declared selection finished");
        assert_eq!(detail.stage, "ready");
        // And the CLI's own composition agrees with the feed's.
        assert_eq!(status_in(&root, "ready-arc").unwrap().stage, "ready");

        // An untracked scratch file does not unready the arc — the join's
        // preamble would not commit it, so it is not the run's unfinished work.
        fs::write(worktree.join("scratch.tmp"), "notes\n").unwrap();
        let detail = arc_detail_entry_in(&root, "ready-arc").unwrap();
        assert!(detail.join_ready, "untracked dirt is not unfinished work");
        assert_eq!(status_in(&root, "ready-arc").unwrap().stage, "ready");

        // A tracked edit does: that is work the join would sweep in.
        fs::write(worktree.join("one.txt"), "edited\n").unwrap();
        let detail = arc_detail_entry_in(&root, "ready-arc").unwrap();
        assert!(!detail.join_ready);
        assert_eq!(status_in(&root, "ready-arc").unwrap().stage, "implementing");
    }

    /// The two pairs answer different questions and both reach the callers:
    /// the run's counts the selection, the plan's counts the document.
    #[serial]
    #[test]
    fn the_run_pair_counts_the_selection_and_the_plan_pair_the_document() {
        let (_temp, root) = stepped_arc("span-arc");
        let worktree = worktree_path(&root, "span-arc");

        // A run of just step 1 against a two-row plan: the numbers diverge.
        step_start("span-arc", 1, 1).unwrap();
        let detail = arc_detail_entry_in(&root, "span-arc").unwrap();
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
        let status = status_in(&root, "span-arc").unwrap();
        assert_eq!((status.run_position, status.run_length), (Some(1), Some(1)));

        // Finishing that selection holds the full fraction.
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("span-arc", "r1", None).unwrap();
        step_done("span-arc", 1, None).unwrap();
        let detail = arc_detail_entry_in(&root, "span-arc").unwrap();
        assert!(detail.run_complete);
        assert_eq!((detail.run_position, detail.run_length), (Some(1), Some(1)));

        // A second selection re-declares, and the run pair follows it rather
        // than the plan — step 2 of the document is step 1 of this run.
        step_start("span-arc", 2, 2).unwrap();
        let detail = arc_detail_entry_in(&root, "span-arc").unwrap();
        assert_eq!((detail.step_current, detail.step_total), (Some(2), Some(2)));
        assert_eq!((detail.run_position, detail.run_length), (Some(1), Some(1)));
    }

    /// An arc that declared no run reports no run pair, so its displays fall
    /// back to the plan's counters exactly as they did before ([P05]).
    #[serial]
    #[test]
    fn an_undeclared_run_reports_no_run_pair() {
        let (_temp, root) = stepped_arc("plain-arc");
        let worktree = worktree_path(&root, "plain-arc");
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("plain-arc", "r1", None).unwrap();

        let detail = arc_detail_entry_in(&root, "plain-arc").unwrap();
        assert_eq!((detail.run_position, detail.run_length), (None, None));
        let status = status_in(&root, "plain-arc").unwrap();
        assert_eq!((status.run_position, status.run_length), (None, None));
    }

    /// A stepped arc reports its declared stage, its progress, and the plan it
    /// is driving; a mark moves the stage; a later step moves it back ([P03]).
    #[serial]
    #[test]
    fn status_reports_declared_stage_step_and_plan() {
        let (_temp, root) = stepped_arc("status-arc");

        // The seeded plan is not in the worktree at all, so the undeclared arc
        // derives `created`: nothing has been worked yet.
        let fresh = status_in(&root, "status-arc").unwrap();
        assert_eq!(fresh.stage, "created");
        assert!(fresh.step_current.is_none());
        assert!(
            fresh.documents.plan.is_some(),
            "the seeded plan is at the arc's own address"
        );

        step_start("status-arc", 1, 2).unwrap();
        let stepping = status_in(&root, "status-arc").unwrap();
        assert_eq!(stepping.stage, "implementing");
        assert_eq!(
            (stepping.step_current, stepping.step_total),
            (Some(1), Some(2))
        );
        assert_eq!(
            stepping.documents.plan.as_deref(),
            Some(&*plan_file(&root, "status-arc").to_string_lossy())
        );

        mark("status-arc", MarkStage::Built, None).unwrap();
        let built = status_in(&root, "status-arc").unwrap();
        assert_eq!(built.stage, "built");
        // The step fields outlive the mark, so a display can still say how far.
        assert_eq!(built.step_current, Some(1));

        mark("status-arc", MarkStage::Audited, Some("good shape")).unwrap();
        assert_eq!(status_in(&root, "status-arc").unwrap().stage, "audited");

        // A follow-up step range demotes the arc back to implementing.
        step_start("status-arc", 2, 2).unwrap();
        let again = status_in(&root, "status-arc").unwrap();
        assert_eq!(again.stage, "implementing");
        assert_eq!(again.step_current, Some(2));
    }

    /// The feed's shared composition carries the same declared stage and step
    /// progress `status` reports — which is what lights up the Arcs card
    /// and the Changes arc lane with no frontend change ([P01]).
    #[serial]
    #[test]
    fn detail_entries_carry_declared_stage_and_step() {
        let (_temp, root) = stepped_arc("feed-arc");

        // A plain arc derives what it always did. `created`, not `working`:
        // the plan is at the arc's own address, outside the worktree, so
        // seeding it leaves no dirt behind.
        let plain = arc_detail_entries_in(&root);
        let entry = plain.iter().find(|d| d.name == "feed-arc").unwrap();
        assert_eq!(entry.stage, "created");
        assert!(entry.step_current.is_none() && entry.step_total.is_none());

        step_start("feed-arc", 1, 2).unwrap();
        let stepped = arc_detail_entries_in(&root);
        let entry = stepped.iter().find(|d| d.name == "feed-arc").unwrap();
        assert_eq!(entry.stage, "implementing");
        assert_eq!((entry.step_current, entry.step_total), (Some(1), Some(2)));

        mark("feed-arc", MarkStage::Built, None).unwrap();
        let built = arc_detail_entries_in(&root);
        let entry = built.iter().find(|d| d.name == "feed-arc").unwrap();
        assert_eq!(entry.stage, "built");
        assert_eq!(entry.step_current, Some(1));
    }

    /// The arc rides the same composition, **beside** the derived stage rather
    /// than inside it — the property that lets a face say `implementing` and
    /// `arc stopped in review` at once, which is exactly what a stopped arc is.
    #[serial]
    #[test]
    fn detail_entries_carry_the_arc_beside_the_derived_stage() {
        let (_temp, root) = stepped_arc("arc-run");

        // A hand-driven arc has no arc, and says so by absence.
        let plain = arc_detail_entries_in(&root);
        let entry = plain.iter().find(|d| d.name == "arc-run").unwrap();
        assert!(entry.arc.is_none(), "no arc lines, nothing to say");

        crate::arc::append_arc_start(&root, "arc-run", "arc/arc-run-brief.md").unwrap();
        crate::arc::append_arc_stage(
            &root,
            "arc-run",
            crate::arc::ArcStage::Review,
            "claude-b",
            Some("opus"),
        )
        .unwrap();
        let running = arc_detail_entries_in(&root);
        let entry = running.iter().find(|d| d.name == "arc-run").unwrap();
        let arc = entry.arc.as_ref().expect("the arc composes");
        assert_eq!(arc.stage.as_deref(), Some("review"));
        assert!(arc.stopped.is_none() && !arc.done);
        assert!(
            arc.note.is_none(),
            "an arc that has said nothing carries no note"
        );

        // The latest note is what the placard shows — the newest, not the
        // first, so a second act replaces what the first one said.
        crate::arc::append_arc_note(&root, "arc-run", "compacted at 0.73 > 0.60").unwrap();
        crate::arc::append_arc_note(&root, "arc-run", "compacted at 0.81 > 0.60").unwrap();
        let noted = arc_detail_entries_in(&root);
        let entry = noted.iter().find(|d| d.name == "arc-run").unwrap();
        assert_eq!(
            entry.arc.as_ref().and_then(|a| a.note.as_deref()),
            Some("compacted at 0.81 > 0.60")
        );

        crate::arc::append_arc_stop(
            &root,
            "arc-run",
            crate::arc::ArcStage::Review,
            crate::arc::ArcStopReason::Lint,
        )
        .unwrap();
        let stopped = arc_detail_entries_in(&root);
        let entry = stopped.iter().find(|d| d.name == "arc-run").unwrap();
        let arc = entry.arc.as_ref().expect("a stopped arc still composes");
        assert_eq!(arc.stopped.as_deref(), Some("lint"));
        assert_eq!(arc.stopped_stage.as_deref(), Some("review"));
        // The log's word and the English for it, both on the wire ([B06]): a
        // face reads whichever register it speaks in and keeps no table of
        // its own.
        assert_eq!(
            arc.stopped_why.as_deref(),
            Some(crate::arc::ArcStopReason::Lint.sentence())
        );
        let wire = serde_json::to_value(arc).expect("the arc serializes");
        assert_eq!(wire["stopped"], "lint");
        assert_eq!(wire["stopped_why"], "the plan does not lint");
        assert_eq!(
            entry.stage, "created",
            "the git stage is untouched by the arc's — both readings stand"
        );
    }

    /// Every tracked edit in an arc worktree is work in flight now that the plan
    /// is not one of them.
    #[test]
    fn join_ready_counts_every_tracked_worktree_edit() {
        assert!(crate::log::unfinished_tracked_dirt(&["a.rs".to_string()]));
        assert!(!crate::log::unfinished_tracked_dirt(&[]));
    }

    /// The arc's documents ride the same composition, so a card bound to an
    /// arc can resolve the plan it is implementing without a shell round-trip.
    #[serial]
    #[test]
    fn detail_entries_carry_the_arc_documents() {
        let (_temp, root) = stepped_arc("plan-path-arc");

        let entries = arc_detail_entries_in(&root);
        let entry = entries.iter().find(|d| d.name == "plan-path-arc").unwrap();
        // The plan is there from the moment it is written — nothing has to
        // record it, so no step verb has to have run first.
        assert_eq!(
            entry.documents.plan.as_deref(),
            Some(&*plan_file(&root, "plan-path-arc").to_string_lossy())
        );
        // Absolute, because the deck composes nothing: it is handed the path.
        assert!(entry.documents.plan.as_deref().unwrap().starts_with('/'));
        assert!(entry.documents.brief.is_none());

        // An arc with no documents at all carries none.
        create("bare-arc", None, false, None).unwrap();
        let entries = arc_detail_entries_in(&root);
        let bare = entries.iter().find(|d| d.name == "bare-arc").unwrap();
        assert!(bare.documents.is_empty());
    }

    /// The divergence a join would only reveal at merge time, said on every
    /// recompute instead: how far the base has run ahead, and which of its
    /// uncommitted edits land on files this arc also changed.
    #[serial]
    #[test]
    fn detail_entries_carry_base_divergence() {
        let (_temp, root) = stepped_arc("divergence-arc");
        let worktree = worktree_path(&root, "divergence-arc");

        // A round on the arc, touching `shared.txt`.
        fs::write(worktree.join("shared.txt"), "arc\n").unwrap();
        git_output(&worktree, &["add", "-A"]).unwrap();
        git_output(&worktree, &["commit", "-m", "the arc's round"]).unwrap();

        let quiet = arc_detail_entries_in(&root);
        let entry = quiet.iter().find(|d| d.name == "divergence-arc").unwrap();
        assert_eq!(entry.base_ahead, 0, "the base has not moved");
        assert!(entry.base_overlap.is_empty());
        assert!(entry.last_replay.is_none());

        // The base gains a commit, then an uncommitted edit — one to a file the
        // arc also changed, one to a file it does not touch.
        fs::write(root.join("elsewhere.txt"), "base\n").unwrap();
        git_output(&root, &["add", "elsewhere.txt"]).unwrap();
        git_output(&root, &["commit", "-m", "the base moves"]).unwrap();
        fs::write(root.join("shared.txt"), "base edits it too\n").unwrap();
        git_output(&root, &["add", "shared.txt"]).unwrap();
        fs::write(root.join("elsewhere.txt"), "and this\n").unwrap();

        let moved = arc_detail_entries_in(&root);
        let entry = moved.iter().find(|d| d.name == "divergence-arc").unwrap();
        assert_eq!(entry.base_ahead, 1);
        assert_eq!(
            overlap_paths(&entry.base_overlap),
            vec!["shared.txt".to_string()],
            "only the intersection with the arc's own files is a warning"
        );
    }

    /// A replay's arc log line reaches the snapshot as the settled mark's text
    /// without disturbing the derived stage.
    #[serial]
    #[test]
    fn detail_entries_carry_the_last_replay_note() {
        let (_temp, root) = stepped_arc("replay-note-arc");
        append_arc_log(&root, "replay-note-arc", "replayed", "onto abc123456: d->e").unwrap();

        let entries = arc_detail_entries_in(&root);
        let entry = entries
            .iter()
            .find(|d| d.name == "replay-note-arc")
            .unwrap();
        assert_eq!(entry.last_replay.as_deref(), Some("onto abc123456: d->e"));
        assert_eq!(
            entry.stage, "created",
            "a replay records history, it does not move the stage"
        );
    }

    /// The tip-vs-base question the wire's cleanup turns on: a worktree
    /// nobody wrote in has no rounds, and one round is one commit.
    #[serial]
    #[test]
    fn round_count_reads_the_branch_against_its_base() {
        let (_temp, root) = repo_for_create();
        create_in(&root, "counted", None, false, None).unwrap();
        assert_eq!(round_count_in(&root, "counted"), 0);
        assert_eq!(
            round_count_in(&root, "never-created"),
            0,
            "an arc that does not exist has no rounds rather than an error"
        );

        let worktree = worktree_path(&root, "counted");
        fs::write(worktree.join("touched.txt"), "x").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-m", "a round"]] {
            let out = git_output(&worktree, &args).unwrap();
            assert!(out.status.success(), "{args:?}");
        }
        assert_eq!(round_count_in(&root, "counted"), 1);
    }

    /// The read verbs answer about the universe: a caller standing in it is
    /// told about its arcs, with worktree paths under it.
    #[serial]
    #[test]
    fn test_universe_detail_entries_resolve_to_the_universe() {
        let temp = TempDir::new().unwrap();
        let (base, universe) = base_with_universe(&temp);
        create("listed", None, false, Some("feature")).unwrap();

        let entries = arc_detail_entries_in(&universe);
        let entry = entries
            .iter()
            .find(|d| d.name == "listed")
            .expect("the universe lists its own arc");
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

    /// The stage precedence table ([P03]): a join outranks a declaration, a
    /// declaration outranks a draft, a draft outranks activity, activity
    /// outranks a fresh arc.
    #[test]
    fn stage_derivation_follows_its_precedence() {
        // An undeclared arc derives exactly what it always did.
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

        let stepping = Some(ArcDeclaration::Step {
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
            derive_stage(2, true, true, false, Some(ArcDeclaration::Built), false),
            "built"
        );
        assert_eq!(
            derive_stage(2, true, true, false, Some(ArcDeclaration::Audited), false),
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
        // An arc somebody marked keeps its own word, ready or not.
        assert_eq!(
            derive_stage(2, false, false, false, Some(ArcDeclaration::Built), true),
            "built"
        );
        assert_eq!(
            derive_stage(2, false, false, false, Some(ArcDeclaration::Audited), true),
            "audited"
        );
        // And a plan-less ready arc reads `ready` rather than `working`.
        assert_eq!(derive_stage(1, false, false, false, None, true), "ready");
    }

    /// Table T01 — what arms and what stays dark, one assertion per row.
    #[test]
    fn join_readiness_follows_the_arming_matrix() {
        use crate::log::{ArcDeclarations, join_ready};

        let run =
            |through: Option<u32>, complete: bool, step: Option<(u32, u32)>| ArcDeclarations {
                latest: step.map(|(current, total)| ArcDeclaration::Step { current, total }),
                step,
                run_through: through,
                run_complete: complete,
                ..ArcDeclarations::default()
            };
        let marked = |stage: ArcDeclaration| ArcDeclarations {
            latest: Some(stage),
            step: Some((8, 15)),
            ..ArcDeclarations::default()
        };
        // Every row of this matrix is the **wheel-absent** case — a
        // hand-driven arc, or an arc that reached its terminal line or is
        // stopped. That is what the last argument says, and it is why these
        // answers are unchanged by the audit gate: the gate applies only
        // while a wheel is live, and the live-wheel matrix is `log.rs`'s.
        fn stopped_wheel(
            rounds: u32,
            dirty: bool,
            joining: bool,
            decls: &ArcDeclarations,
            has_plan: bool,
        ) -> bool {
            join_ready(
                rounds,
                dirty,
                joining,
                decls,
                has_plan,
                crate::log::WheelReading::Off,
            )
        }

        // A declared selection that finished.
        assert!(stopped_wheel(
            3,
            false,
            false,
            &run(Some(8), true, Some((8, 15))),
            true
        ));
        // …and one that stopped short of its declared end.
        assert!(!stopped_wheel(
            3,
            false,
            false,
            &run(Some(8), false, Some((7, 15))),
            true
        ));
        // A step still open is never ready, whatever the arithmetic says.
        assert!(!stopped_wheel(
            3,
            false,
            false,
            &run(Some(8), false, Some((8, 15))),
            true
        ));
        // A mark arms on its own — the manual and legacy path ([P03]).
        assert!(stopped_wheel(
            3,
            false,
            false,
            &marked(ArcDeclaration::Built),
            true
        ));
        assert!(stopped_wheel(
            3,
            false,
            false,
            &marked(ArcDeclaration::Audited),
            true
        ));
        // A plan-less generation arms on every round ([P02])…
        assert!(stopped_wheel(
            1,
            false,
            false,
            &ArcDeclarations::default(),
            false
        ));
        // …but not while its tracked work is uncommitted.
        assert!(!stopped_wheel(
            1,
            true,
            false,
            &ArcDeclarations::default(),
            false
        ));
        // An arc that adopted a plan and has declared no step is a run that
        // has not started: its one round is the adoption, and the arc that
        // cancelled here must not read as ready to join.
        assert!(!stopped_wheel(
            1,
            false,
            false,
            &ArcDeclarations::default(),
            true
        ));
        // A legacy plan arc — steps declared, no run — stays dark until marked.
        assert!(!stopped_wheel(
            3,
            false,
            false,
            &run(None, false, Some((8, 15))),
            true
        ));
        // A join in flight is landing, not ready; and nothing to join is not
        // ready either.
        assert!(!stopped_wheel(
            1,
            false,
            true,
            &ArcDeclarations::default(),
            false
        ));
        assert!(!stopped_wheel(
            0,
            false,
            false,
            &ArcDeclarations::default(),
            false
        ));
    }

    /// `status` walks an arc's whole lifecycle: fresh → a round → an authored
    /// draft → an interrupted join (Spec S05, [P06]).
    #[serial]
    #[test]
    fn test_arc_status_reports_each_stage() {
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

        let created = create("status-arc", Some("Test".to_string()), false, None).unwrap();
        let owner_key = created.id.clone().unwrap();

        let fresh = status("status-arc").unwrap();
        assert_eq!(fresh.stage, "created");
        assert_eq!(fresh.id, owner_key);
        assert_eq!(fresh.branch, "tugarc/status-arc");
        assert_eq!(fresh.base_branch, "main");
        assert_eq!(fresh.rounds, 0);
        assert!(!fresh.draft);
        assert!(fresh.join_journal_phase.is_none());
        // Phase 3's slots stay empty here ([P06]).
        assert!(fresh.step_current.is_none() && fresh.step_total.is_none());

        // Uncommitted work is already `working`.
        let worktree = repo.join(".tug/worktrees/status-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        let dirty = status("status-arc").unwrap();
        assert_eq!(dirty.stage, "working");
        assert!(dirty.worktree_dirty);

        // A committed round on a plan-less arc is a finished unit of asked
        // work, so the arc is offerable the moment its worktree is clean
        // ([P02]) — no mark, no build, nothing declared.
        commit("status-arc", "Add f", None).unwrap();
        let after_round = status("status-arc").unwrap();
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
                 VALUES ('arc', ?1, ?2, 'fp', 'Land the work', 1, 1)",
                rusqlite::params![owner_key, project],
            )
            .unwrap();
        }
        // The draft is recorded, but `ready` outranks `draft-ready`: an arc the
        // machine will offer says so, and the draft becomes the message that
        // offer carries rather than a stage of its own.
        let drafted = status("status-arc").unwrap();
        assert_eq!(drafted.stage, "ready");
        assert!(drafted.draft);

        // An interrupted join leaves an open record carrying its phase, and
        // outranks the draft. Seeded against the canonical repo path, which is
        // what `find_repo_root` (and so `status`) resolves — the state-dir
        // slug must agree.
        seed_interrupted_join(
            repo,
            "status-arc",
            crate::oplog::JoinPhase::WorktreeRemoved,
            "abc1234",
        );
        let joining = status("status-arc").unwrap();
        assert_eq!(joining.stage, "joining");
        assert_eq!(
            joining.join_journal_phase.as_deref(),
            Some("WorktreeRemoved")
        );

        // No sessions.db with a binding, so the arc reads as unbound ([P08]).
        assert!(joining.bound_session.is_none());

        assert!(status("no-such-arc").is_err());

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_CHANGES_DB");
        }
    }

    /// `bound_session` names a **live** session only, so an arc whose bound
    /// card has closed reads as unbound ([P08]) — the CLI-side face of the
    /// [L27] pin.
    #[serial]
    #[test]
    fn test_arc_status_bound_session_is_live_only() {
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
                    arc_id      TEXT
                );",
            )
            .unwrap();
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var("TUG_SESSIONS_DB", &sessions_db);
        }

        let owner_key = create("unbound-arc", None, false, None)
            .unwrap()
            .id
            .unwrap();
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute(
                "INSERT INTO sessions (session_id, state, last_used_at, arc_id)
                 VALUES ('sess-live', 'live', 2, ?1), ('sess-closed', 'closed', 1, ?1)",
                rusqlite::params![owner_key],
            )
            .unwrap();
        }

        assert_eq!(
            status("unbound-arc").unwrap().bound_session.as_deref(),
            Some("sess-live"),
            "a closed session's row is never reported as a mating"
        );

        // With the last live session closed, the arc is unbound.
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute("UPDATE sessions SET state = 'closed'", [])
                .unwrap();
        }
        assert!(status("unbound-arc").unwrap().bound_session.is_none());

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var("TUG_SESSIONS_DB");
        }
    }

    #[serial]
    #[test]
    fn test_arc_list_and_show() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("arc1", None, false, None).unwrap();
        create("arc2", None, false, None).unwrap();

        assert_eq!(list().unwrap().len(), 2);
        assert!(show("arc1").is_ok());
        assert!(show("nonexistent").is_err());
    }

    /// The same class of bug one field over: `worktree_rel` is stripped against
    /// the *main* root this composition normalizes to, so a consumer that joins
    /// it against the root it asked from gets a path that does not exist — and
    /// every consumer of that path degrades silently. `worktree_abs` is the
    /// answer that does not depend on which root the question came from.
    #[serial]
    #[test]
    fn arc_detail_asked_from_a_linked_worktree_reports_an_absolute_worktree() {
        let temp = TempDir::new().unwrap();
        seed_arc_with_a_round(&temp, "abs");
        let repo = temp.path();
        let worktree = repo.join(".tug/worktrees/abs");

        let from_worktree = arc_detail_entries_in(&worktree);
        let from_root = arc_detail_entries_in(repo);
        let asked_there = from_worktree
            .iter()
            .find(|d| d.name == "abs")
            .expect("the arc is visible from its own worktree");
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
}
