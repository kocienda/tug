//! The operation log — what every mutating dash verb was about to change,
//! recorded before it acts.
//!
//! A dash verb that lands, moves, or deletes a branch has always been a
//! one-way door: `join` deletes `tugdash/<name>` at teardown, `replay` moves it
//! out from under its old rounds, `discard` removes both branch and worktree.
//! Git keeps those commits alive in a reflog on a clock, which is archaeology
//! rather than a feature. This module is the record that makes them
//! *recoverable*, and it has two halves per operation:
//!
//! - A **keepalive ref**, `refs/tug/oplog/<seq>`, pointing at a synthetic
//!   commit whose parents are every tip the operation is about to move or
//!   delete. This is the half that makes undo possible at all: once it exists,
//!   `branch -D` and `reset` can no longer strand the rounds, because the
//!   commits are reachable from a ref nothing sweeps.
//! - A **payload**, `oplog-<seq>.json` in `project_state_dir`, holding the
//!   verb, the dash, and the before/after values. It is written twice — once before the verb acts and once when it
//!   completes — which is why it is a file rather than the keepalive's commit
//!   message: a message is immutable, and the second write is the whole point.
//!
//! The two halves store different facts, never the same one. The ref carries
//! reachability; the payload carries the record.
//!
//! **A join's forward state lives on the same record as its reverse state.**
//! The payload's [`JoinProgress`] says how far the teardown got, which is what
//! `join --continue` resumes from and what every "a join is in flight" reader
//! consults; the operation it hangs on is the one an undo would reverse. There
//! is no second journal for the two to disagree about. The rule that keeps the
//! meaning honest is that a join which lands nothing records nothing: the
//! integrate's non-landing exits [`abandon`] the record they opened.
//!
//! **A payload with no `after` is an operation that died mid-flight**, and that
//! is a state the log reports rather than hides — [`undo_in`] refuses it by
//! name rather than guessing what half of it happened.
//!
//! Retention is [`OPLOG_CAP`] operations per repository, pruned oldest-first by
//! the writer. There is no daemon and no lock file. Pruning drops both halves, and dropping the keepalive is
//! what finally lets `git gc` collect the commits — which is the honest meaning
//! of "this operation is no longer undoable".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tugutil_core::paths::project_state_dir;
use tugutil_core::sanitize_branch_name;
use tugutil_core::session::now_iso8601;

use crate::dash::refuse_unredirected_temp_repo;
use crate::ops::{
    base_config_key, branch_name, config_get, dash_base, description_config_key, git_output,
    git_stdout, tugid_config_key, worktree_path, write_atomic,
};

/// How many operations a repository keeps.
///
/// Weeks of real dash traffic at a size that bounds how much history the
/// keepalive refs pin against `git gc`. Deliberately a constant rather than
/// config: a tuning knob nobody has asked for is a surface with no reader.
pub const OPLOG_CAP: usize = 50;

/// How many times [`record_begin`] retries a lost sequence-allocation race.
const SEQ_ATTEMPTS: u32 = 10;

/// Which verb an operation records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpVerb {
    Join,
    Replay,
    Discard,
    ResolveBase,
    Undo,
    Redo,
}

impl OpVerb {
    pub fn as_str(self) -> &'static str {
        match self {
            OpVerb::Join => "join",
            OpVerb::Replay => "replay",
            OpVerb::Discard => "discard",
            OpVerb::ResolveBase => "resolve-base",
            OpVerb::Undo => "undo",
            OpVerb::Redo => "redo",
        }
    }

    /// Whether this verb is bookkeeping over another operation rather than work
    /// of its own.
    ///
    /// The one spelling of the rule. It used to live twice — in
    /// [`OpPayload::is_undoable`] and again as a hand-written filter in
    /// [`undo_in`] — and two copies of a rule is how a redo record becomes an
    /// undo candidate.
    pub fn is_reversal(self) -> bool {
        matches!(self, OpVerb::Undo | OpVerb::Redo)
    }
}

/// The branch-config facts a dash carries, captured before a verb runs so an
/// undo can put them back.
///
/// `git branch -D` takes the whole `branch.<name>.*` section with it, so
/// recreating the branch alone would restore a dash that had forgotten its own
/// base, description, and id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tugbase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tugid: Option<String>,
}

/// The world as the verb found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpBefore {
    pub base_branch: String,
    pub base_tip: String,
    pub dash_tip: String,
    pub worktree: String,
    #[serde(default)]
    pub config: OpConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    /// The tip of `refs/tug/conflict/<name>` at capture, read **without** the
    /// validity gate.
    ///
    /// Validity answers "may this chain be opened?"; the keepalive answers
    /// "may this work be collected?", and the second question has the broader
    /// yes. An invalidated chain still holds every checkpoint a resolver
    /// committed, and those are the most expensive commits in the system — AI
    /// and human turns — so they are exactly what a keepalive is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// How old the conflict chain's tip was, in seconds, when this verb broke a
    /// resolve lease to proceed — `None` when no lease stood or none was
    /// broken.
    ///
    /// The teardown is recorded either way by `conflict` above; this records
    /// that somebody was told a resolve might still be running and said go
    /// anyway. Never a silent destruction ([L23]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broke_lease: Option<u64>,
}

/// The world as the verb left it.
///
/// `dash_tip` is read back with `rev-parse` at completion and never
/// reconstructed from what the verb computed on the way. The reason is
/// specific: [`crate::replay`]'s clean arm moves the branch to the replayed
/// head and *then* may land a further bookkeeping round on it, so the tip a
/// replay actually leaves is one commit past the last entry of `mapping`
/// whenever the plan ledger had cells to rewrite. An undo that compared against
/// the mapping's tail would refuse the ordinary case.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpAfter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_tip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash_tip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landed_commit: Option<String>,
    /// `(original round, rebuilt commit)` — replay only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mapping: Vec<(String, String)>,
    /// Paths copied back to the base checkout — discard only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handed_back: Vec<String>,
}

/// How far a join's teardown has got.
///
/// The three states are read as guards, not as a counter: each is "everything
/// below this line is done", so re-entering at any of them repeats nothing and
/// skips nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JoinPhase {
    /// The integrate commit landed on base; worktree + branch still present.
    Integrated,
    /// Worktree removed; branch still present.
    WorktreeRemoved,
    /// Branch deleted; only the dash-log line and the completion remain.
    BranchDeleted,
}

/// A join between its integrate and its end — the forward record, on the same
/// payload as the reverse one.
///
/// `before` is the world the verb found and `after` is the world it left; this
/// is the *during*, and it exists only while the join is in flight. It stays on
/// the payload after completion, where it is the receipt of how the join went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinProgress {
    pub phase: JoinPhase,
    /// The integrate commit on the base branch.
    pub commit_hash: String,
    /// `JoinStrategy::as_str()`, stored as text — the enum is private to
    /// `ops`, and this module only carries the word.
    pub strategy: String,
    /// The message the integrate committed with, carried so a `--continue`
    /// finishing the teardown can still report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One operation's record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpPayload {
    #[serde(default = "payload_version")]
    pub version: u32,
    pub seq: u64,
    pub verb: OpVerb,
    pub dash: String,
    pub recorded_at: String,
    pub before: OpBefore,
    /// Absent until the verb completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<OpAfter>,
    /// The sequence number of the undo that reversed this operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_by: Option<u64>,
    /// How far a join's teardown has got — present from the moment the
    /// integrate lands until the record is dropped, and left in place after
    /// completion as the receipt of the teardown.
    ///
    /// An incomplete Join payload carrying this is what "a join is in flight"
    /// means; one without it is a join that died before it landed anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<JoinProgress>,
    /// Which operation this one reverses — set on an Undo (the operation it
    /// undid) and on a Redo (the undo it reversed).
    ///
    /// The pairing stated in the record rather than derived by searching
    /// `undone_by` backlinks, so a redo can find its original directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverses: Option<u64>,
}

fn payload_version() -> u32 {
    1
}

impl OpPayload {
    /// Whether this operation is a candidate for [`undo_in`]: it finished,
    /// nothing has reversed it yet, and it is not itself an undo.
    ///
    /// **An undo is recorded but never undoable.** It belongs in the log — it
    /// moved refs, and its keepalive holds what it moved — but offering to
    /// reverse it would make `undo` a redo on alternate presses, which is a
    /// different feature wearing this one's name. Excluding it here rather than
    /// refusing it later is what keeps [`undo_in`]'s selection landing on the
    /// join or replay underneath, so a second press reports `already-undone`
    /// about the real operation instead of complaining about the undo.
    pub fn is_undoable(&self) -> bool {
        self.after.is_some() && self.undone_by.is_none() && !self.verb.is_reversal()
    }

    /// Whether this operation is a candidate for [`redo_in`]: it is an undo
    /// that finished and that nothing has itself reversed.
    ///
    /// **Only an undo is redoable, and that is what keeps the stack flat.**
    /// Undoing an undo would build a linked list somebody has to walk;
    /// *redoing* one restores exactly what that undo took away and clears the
    /// original's `undone_by`, so the original becomes undoable again. A second
    /// `undo` press then means the original once more, and `undo, redo, undo`
    /// toggles one operation rather than descending through bookkeeping.
    pub fn is_redoable(&self) -> bool {
        self.after.is_some() && self.undone_by.is_none() && self.verb == OpVerb::Undo
    }
}

// ---------------------------------------------------------------------------
// paths and refs
// ---------------------------------------------------------------------------

/// `refs/tug/oplog/<seq>`, zero-padded so `for-each-ref`'s lexical order is
/// numeric order.
pub fn oplog_ref_name(seq: u64) -> String {
    format!("refs/tug/oplog/{:06}", seq)
}

fn payload_path(repo: &Path, seq: u64) -> PathBuf {
    project_state_dir(repo).join(format!("oplog-{:06}.json", seq))
}

/// Every sequence number this repository currently has a keepalive ref for.
fn ref_seqs(repo: &Path) -> Vec<u64> {
    let out = git_stdout(
        repo,
        &["for-each-ref", "--format=%(refname)", "refs/tug/oplog/"],
    )
    .unwrap_or_default();
    let mut seqs: Vec<u64> = out
        .lines()
        .filter_map(|l| l.trim().rsplit('/').next())
        .filter_map(|s| s.parse().ok())
        .collect();
    seqs.sort_unstable();
    seqs
}

/// The empty tree's object id, asked of git rather than hard-coded — the SHA-1
/// constant is wrong in a SHA-256 repository.
fn empty_tree(repo: &Path) -> Result<String, String> {
    let out = git_output(repo, &["hash-object", "-t", "tree", "/dev/null"])?;
    if !out.status.success() {
        return Err(format!(
            "oplog: cannot resolve the empty tree: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Build the keepalive commit: an empty tree parented on every tip the
/// operation is about to move or delete.
fn keepalive_commit(
    repo: &Path,
    verb: OpVerb,
    dash: &str,
    seq: u64,
    tips: &[String],
) -> Result<String, String> {
    let tree = empty_tree(repo)?;
    let message = format!("tug oplog {} {} {}", seq, verb.as_str(), dash);

    // A tip that does not resolve is dropped rather than fatal: the keepalive
    // is a reachability favour, and refusing to record an operation because one
    // of its tips was already gone would turn a missing safety net into a
    // blocked verb.
    let mut parents: Vec<String> = Vec::new();
    for tip in tips {
        let resolved = match git_stdout(repo, &["rev-parse", &format!("{}^{{commit}}", tip)]) {
            Ok(sha) => sha,
            Err(_) => continue,
        };
        if !parents.contains(&resolved) {
            parents.push(resolved);
        }
    }

    let mut args: Vec<String> = vec!["commit-tree".to_string(), tree];
    for parent in &parents {
        args.push("-p".to_string());
        args.push(parent.clone());
    }
    args.push("-m".to_string());
    args.push(message);

    let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = git_output(repo, &borrowed)?;
    if !out.status.success() {
        return Err(format!(
            "oplog: commit-tree failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/// Read the world as it stands, for a verb about to change it.
///
/// **Call this at the moment the verb is about to act, not at its entry.** The
/// join sweeps the dash worktree's dirt into a commit before it integrates, and
/// a `dash_tip` read before that sweep would name the commit *below* the swept
/// work — so an undo would faithfully restore a dash missing everything the
/// sweep captured. `resolve.rs` learned the same lesson about `tugjoinsource`,
/// where reading before the sweep made every candidate stale at birth.
pub fn capture_before(repo: &Path, name: &str) -> Result<OpBefore, String> {
    let branch = branch_name(name);
    let base_branch = dash_base(repo, name)?;
    Ok(OpBefore {
        base_tip: git_stdout(repo, &["rev-parse", &base_branch]).unwrap_or_default(),
        dash_tip: git_stdout(repo, &["rev-parse", &branch]).unwrap_or_default(),
        base_branch,
        worktree: worktree_path(repo, name).to_string_lossy().into_owned(),
        config: OpConfig {
            tugbase: config_get(repo, &base_config_key(name)),
            description: config_get(repo, &description_config_key(name)),
            tugid: config_get(repo, &tugid_config_key(name)),
        },
        candidate: crate::resolve::read_candidate(repo, name),
        conflict: crate::resolve::read_conflict(repo, name).map(|c| c.tip),
        broke_lease: None,
    })
}

/// The tips a verb's keepalive must hold: the dash head, the base tip, a
/// standing candidate, and the conflict chain.
pub(crate) fn tips_of(before: &OpBefore) -> Vec<String> {
    let mut tips = vec![before.dash_tip.clone(), before.base_tip.clone()];
    if let Some(candidate) = &before.candidate {
        tips.push(candidate.clone());
    }
    if let Some(conflict) = &before.conflict {
        tips.push(conflict.clone());
    }
    tips.retain(|t| !t.is_empty());
    tips
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

/// Record what `verb` is about to do to `dash`, before it does it.
///
/// `tips` are the commits that must survive the operation — the dash head, the
/// base tip, a standing candidate. They become the keepalive commit's parents.
///
/// Returns the sequence number the caller passes to [`record_complete`].
///
/// **Sequence allocation is a create-only ref write in a retry loop.** Two
/// verbs recording at once — the CLI and tugcast, the pair the occupancy work
/// already documents — must not share a number, and git's own ref transaction
/// is the only lock this engine uses anywhere. A write that loses the race
/// fails rather than clobbering, and the loop re-reads and tries again.
pub fn record_begin(
    repo: &Path,
    verb: OpVerb,
    dash: &str,
    before: OpBefore,
    tips: &[String],
) -> Result<u64, String> {
    refuse_unredirected_temp_repo(repo);
    let dir = project_state_dir(repo);
    std::fs::create_dir_all(&dir).map_err(|e| format!("oplog: cannot create {dir:?}: {e}"))?;

    let mut last_err = String::new();
    for _ in 0..SEQ_ATTEMPTS {
        let seq = ref_seqs(repo).last().copied().unwrap_or(0) + 1;
        let keepalive = keepalive_commit(repo, verb, dash, seq, tips)?;
        // The empty old-value is git's "this ref must not exist" — so a lost
        // race is an error here rather than a silently shared sequence number.
        let out = git_output(repo, &["update-ref", &oplog_ref_name(seq), &keepalive, ""])?;
        if !out.status.success() {
            last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            continue;
        }

        let payload = OpPayload {
            version: payload_version(),
            seq,
            verb,
            dash: dash.to_string(),
            recorded_at: now_iso8601(),
            before,
            after: None,
            join: None,
            undone_by: None,
            reverses: None,
        };
        write_payload(repo, &payload)?;
        prune(repo);
        return Ok(seq);
    }
    Err(format!(
        "oplog: could not allocate a sequence number after {SEQ_ATTEMPTS} attempts: {last_err}"
    ))
}

/// Attach the after-state to a recorded operation, marking it complete.
pub fn record_complete(repo: &Path, seq: u64, after: OpAfter) -> Result<(), String> {
    let mut payload =
        read_op(repo, seq).ok_or_else(|| format!("oplog: no operation {seq} to complete"))?;
    payload.after = Some(after);
    write_payload(repo, &payload)
}

/// Mark `seq` as reversed by the undo operation `by`.
pub fn record_undone_by(repo: &Path, seq: u64, by: Option<u64>) -> Result<(), String> {
    let mut payload =
        read_op(repo, seq).ok_or_else(|| format!("oplog: no operation {seq} to mark undone"))?;
    payload.undone_by = by;
    write_payload(repo, &payload)
}

/// Record which operation `seq` reverses.
pub fn record_reverses(repo: &Path, seq: u64, reverses: u64) -> Result<(), String> {
    let mut payload =
        read_op(repo, seq).ok_or_else(|| format!("oplog: no operation {seq} to pair"))?;
    payload.reverses = Some(reverses);
    write_payload(repo, &payload)
}

/// Attach or advance a join's teardown progress on its record.
///
/// The write is the same rename-into-place every other payload write uses, and
/// it happens *before* the phase's actions are treated as done — so a crash
/// leaves a record claiming less than was achieved, which the idempotent
/// teardown repeats harmlessly, rather than more than was achieved, which it
/// would skip.
pub fn record_join_progress(repo: &Path, seq: u64, progress: JoinProgress) -> Result<(), String> {
    let mut payload = read_op(repo, seq)
        .ok_or_else(|| format!("oplog: no operation {seq} to record join progress on"))?;
    payload.join = Some(progress);
    write_payload(repo, &payload)
}

/// Every sequence number with a payload on disk, newest first, from the state
/// directory alone.
///
/// Deliberately not [`ref_seqs`]: that spawns `git for-each-ref`, and the one
/// caller here — "is a join in flight?" — sits on the join board's uncached
/// path, recomputed per dash per recompute. The keepalive answers whether the
/// work can still be collected; in-flight-ness is a property of the payload, so
/// the refs have nothing to say about it.
fn payload_seqs_desc(repo: &Path) -> Vec<u64> {
    let mut seqs: Vec<u64> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(project_state_dir(repo)) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(rest) = name.strip_prefix("oplog-") {
                if let Some(num) = rest.strip_suffix(".json") {
                    if let Ok(seq) = num.parse::<u64>() {
                        seqs.push(seq);
                    }
                }
            }
        }
    }
    seqs.sort_unstable();
    seqs.reverse();
    seqs
}

/// The join of `dash` that is between its integrate and its end, if there is
/// one — the record `--continue` resumes and every "a join is in flight" reader
/// consults.
///
/// **The whole predicate is tested all the way back, never short-circuited on
/// "the newest op for this dash".** [`undo_in`] skips an incomplete operation
/// rather than stopping at it, so `dash undo` during an interrupted join
/// records an Undo *above* the join it could not reverse. A scan that stopped
/// at the first record naming the dash would then report no join in flight for
/// a dash that is half torn down.
pub fn join_in_flight(repo: &Path, dash: &str) -> Option<OpPayload> {
    let _ = fold_legacy_join_journal(repo, dash);
    payload_seqs_desc(repo)
        .into_iter()
        .filter_map(|seq| read_op(repo, seq))
        .find(|op| {
            op.dash == dash && op.verb == OpVerb::Join && op.after.is_none() && op.join.is_some()
        })
}

/// The retired join-journal file, as it was written.
///
/// The one place the old format is still spelled, and it is spelled as the
/// artifact being read out of existence.
#[derive(Debug, Clone, Deserialize)]
struct LegacyJoinJournal {
    #[allow(dead_code)]
    name: String,
    base_branch: String,
    strategy: String,
    commit_hash: String,
    phase: JoinPhase,
    #[serde(default)]
    message: Option<String>,
}

fn legacy_journal_path(repo: &Path, dash: &str) -> PathBuf {
    project_state_dir(repo).join(format!("join-journal-{}.json", sanitize_branch_name(dash)))
}

/// Fold a join journal left on disk by an older build onto the operation log,
/// and delete it.
///
/// Read-time and idempotent, the shape `migrate_worktrees` already established:
/// there is no upgrade command because the reader is the thing that runs. The
/// progress attaches to the dash's open join record when there is one, and
/// otherwise records one — a journal can outlive its op, either because the op
/// was pruned or because the join predates the log — so that `--continue` has
/// something to finish and `undo` has something to answer about.
///
/// The file is removed **only after** the payload write returns `Ok`. A crash
/// in between re-enters here and folds again onto the same open record.
pub fn fold_legacy_join_journal(repo: &Path, dash: &str) -> Result<Option<u64>, String> {
    let path = legacy_journal_path(repo, dash);
    let txt = match std::fs::read_to_string(&path) {
        Ok(txt) => txt,
        Err(_) => return Ok(None),
    };
    let journal: LegacyJoinJournal = serde_json::from_str(&txt).map_err(|e| {
        format!(
            "legacy-join-journal-unreadable: {}: {e}",
            path.to_string_lossy()
        )
    })?;

    let seq = match newest_incomplete(repo, dash, OpVerb::Join) {
        Some(op) => op.seq,
        None => {
            // `capture_before` does not fail once the branch is gone: it falls
            // back to the repository's default branch and reads empty tips. So
            // the base branch it reports at phase `BranchDeleted` is a guess,
            // and the journal recorded the real one — the journal wins.
            let mut before = capture_before(repo, dash).unwrap_or(OpBefore {
                base_branch: journal.base_branch.clone(),
                base_tip: String::new(),
                dash_tip: String::new(),
                worktree: String::new(),
                config: OpConfig::default(),
                candidate: None,
                conflict: None,
                broke_lease: None,
            });
            before.base_branch = journal.base_branch.clone();
            let tips = tips_of(&before);
            record_begin(repo, OpVerb::Join, dash, before, &tips)?
        }
    };

    record_join_progress(
        repo,
        seq,
        JoinProgress {
            phase: journal.phase,
            commit_hash: journal.commit_hash,
            strategy: journal.strategy,
            message: journal.message,
        },
    )?;
    let _ = std::fs::remove_file(&path);
    Ok(Some(seq))
}
/// Drop a record whose verb turned out to touch nothing, both halves.
///
/// A verb that opens a record and then refuses — a replay whose compare-and-swap
/// finds the tip moved — did not happen, and the log must not claim it did.
/// Deleting is the honest ending rather than marking it complete-and-empty: an
/// empty record is indistinguishable from a verb that ran and changed nothing,
/// and only one of those is real. The sequence number is spent and not reused;
/// gaps are ordinary here, since pruning makes them too.
pub fn abandon(repo: &Path, seq: u64) {
    let _ = git_output(repo, &["update-ref", "-d", &oplog_ref_name(seq)]);
    let _ = std::fs::remove_file(payload_path(repo, seq));
}

fn write_payload(repo: &Path, payload: &OpPayload) -> Result<(), String> {
    refuse_unredirected_temp_repo(repo);
    let body = serde_json::to_string_pretty(payload)
        .map_err(|e| format!("oplog: cannot encode operation {}: {e}", payload.seq))?;
    write_atomic(&payload_path(repo, payload.seq), &body)
}

/// Read one operation's payload, if it is there.
pub fn read_op(repo: &Path, seq: u64) -> Option<OpPayload> {
    let txt = std::fs::read_to_string(payload_path(repo, seq)).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Every recorded operation, newest first.
///
/// Tolerant of a half-present record in either direction — a payload whose ref
/// was hand-deleted, or a ref whose payload was. The log is a recovery aid, and
/// one that panicked on a repository somebody had poked at by hand would be
/// worthless exactly when it is needed.
pub fn list_ops(repo: &Path) -> Vec<OpPayload> {
    let mut seqs = ref_seqs(repo);
    // A payload can outlive its ref; include those too, so the list still
    // reports the operation (as un-undoable — its keepalive is gone).
    if let Ok(entries) = std::fs::read_dir(project_state_dir(repo)) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(rest) = name.strip_prefix("oplog-") {
                if let Some(num) = rest.strip_suffix(".json") {
                    if let Ok(seq) = num.parse::<u64>() {
                        if !seqs.contains(&seq) {
                            seqs.push(seq);
                        }
                    }
                }
            }
        }
    }
    seqs.sort_unstable();
    seqs.reverse();
    seqs.into_iter()
        .filter_map(|seq| read_op(repo, seq))
        .collect()
}

/// The newest completed, not-yet-undone operation, optionally for one dash.
pub fn newest_undoable(repo: &Path, dash: Option<&str>) -> Option<OpPayload> {
    list_ops(repo)
        .into_iter()
        .filter(|op| dash.is_none_or(|d| op.dash == d))
        .find(|op| op.is_undoable())
}

/// The newest operation for `dash` that began and never completed — how a
/// resumed verb finds the record it opened before it was interrupted.
///
/// [`fold_legacy_join_journal`] is the caller this exists for: a journal an
/// older build left behind belongs on the record that join already opened, and
/// the file carries no sequence number to find it by.
pub fn newest_incomplete(repo: &Path, dash: &str, verb: OpVerb) -> Option<OpPayload> {
    list_ops(repo)
        .into_iter()
        .find(|op| op.dash == dash && op.verb == verb && op.after.is_none())
}

/// Drop everything past [`OPLOG_CAP`], oldest first — both halves.
fn prune(repo: &Path) {
    let seqs = ref_seqs(repo);
    if seqs.len() <= OPLOG_CAP {
        return;
    }
    for seq in &seqs[..seqs.len() - OPLOG_CAP] {
        let _ = git_output(repo, &["update-ref", "-d", &oplog_ref_name(*seq)]);
        let _ = std::fs::remove_file(payload_path(repo, *seq));
    }
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

/// What an undo did, or the fact that it declined.
#[derive(Debug, Clone, Serialize)]
pub struct UndoOutcome {
    /// The operation that was reversed.
    pub seq: u64,
    pub verb: OpVerb,
    pub dash: String,
    /// The sequence number this undo was itself recorded under.
    pub recorded_as: u64,
    /// Restored branch tip, when the undo put a branch back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dash_tip: Option<String>,
    /// Restored base tip, when the undo moved the base branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_tip: Option<String>,
    /// Paths a discard copied into the base checkout, which an undo does not
    /// claw back — named so the state is announced rather than discovered.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub handed_back_left_in_place: Vec<String>,
    /// Whether the restored dash reads as unbound — it always does; rebinding
    /// is the user's gesture.
    pub restored_unbound: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Reverse the newest completed operation, optionally for one named dash.
///
/// **Every undo is a compare-and-swap and never a force.** It verifies the
/// world still matches what the operation left before it moves anything, and
/// refuses by name otherwise — the same discipline `replay::cas_reset`
/// established, for the same reason: an undo that overwrote whatever arrived
/// after the operation would destroy work to complete a convenience.
///
/// What it restores is git state only. Session bindings live in a per-instance
/// ledger and are live-sessions-only by design, so a restored dash reads as
/// unbound and rebinding is the user's gesture.
pub fn undo_in(repo: &Path, dash: Option<&str>) -> Result<UndoOutcome, String> {
    let repo = crate::ops::main_repo_root(repo);
    let repo = repo.as_path();

    // Reversal records — undos and redos — are skipped wholesale, not refused:
    // the operation a second press means is the join or replay beneath them
    // ([`OpPayload::is_undoable`]). The verb test is asked once, of
    // `OpVerb::is_reversal`, rather than spelled out again here.
    let candidates: Vec<OpPayload> = list_ops(repo)
        .into_iter()
        .filter(|op| dash.is_none_or(|d| op.dash == d))
        .filter(|op| !op.verb.is_reversal())
        .collect();

    let op = match candidates.iter().find(|op| op.is_undoable()) {
        Some(op) => op.clone(),
        None => {
            // Say which of the three "nothing to undo" states this is: an
            // operation already reversed and one that died mid-flight are
            // different facts, and a single blank refusal hides both.
            if let Some(op) = candidates.first() {
                if let Some(undone_by) = op.undone_by {
                    return Err(format!(
                        "already-undone: operation {} ({} of '{}') was reversed by operation {}",
                        op.seq,
                        op.verb.as_str(),
                        op.dash,
                        undone_by
                    ));
                }
                if op.after.is_none() {
                    return Err(format!(
                        "incomplete-op: operation {} ({} of '{}') never finished, so what it \
                         changed is unknown; it cannot be undone automatically",
                        op.seq,
                        op.verb.as_str(),
                        op.dash
                    ));
                }
            }
            return Err(match dash {
                Some(d) => format!("nothing-to-undo: no completed operation recorded for '{d}'"),
                None => "nothing-to-undo: no completed operation is recorded".to_string(),
            });
        }
    };

    let after = op
        .after
        .clone()
        .ok_or_else(|| format!("incomplete-op: operation {} never finished", op.seq))?;

    let mut warnings = Vec::new();
    let name = op.dash.clone();

    // Record the undo before it acts, exactly as any other mutating verb does.
    let undo_before = capture_before(repo, &name).unwrap_or(OpBefore {
        base_branch: op.before.base_branch.clone(),
        base_tip: git_stdout(repo, &["rev-parse", &op.before.base_branch]).unwrap_or_default(),
        dash_tip: String::new(),
        worktree: op.before.worktree.clone(),
        config: OpConfig::default(),
        candidate: None,
        conflict: None,
        broke_lease: None,
    });
    let tips = tips_of(&undo_before);
    let undo_seq = record_begin(repo, OpVerb::Undo, &name, undo_before, &tips)?;

    let outcome = match op.verb {
        OpVerb::Join => undo_join(repo, &op, &after, &mut warnings),
        OpVerb::Replay => undo_replay(repo, &op, &after),
        OpVerb::Discard => undo_discard(repo, &op, &mut warnings),
        OpVerb::ResolveBase => undo_resolve_base(repo, &op, &after),
        OpVerb::Undo | OpVerb::Redo => {
            unreachable!("reversal records are filtered out of the candidates")
        }
    };

    let (dash_tip, base_tip) = match outcome {
        Ok(pair) => pair,
        Err(e) => {
            // The undo declined, so it did not happen.
            abandon(repo, undo_seq);
            return Err(e);
        }
    };

    record_complete(
        repo,
        undo_seq,
        OpAfter {
            base_tip: base_tip.clone(),
            dash_tip: dash_tip.clone(),
            ..Default::default()
        },
    )?;
    record_undone_by(repo, op.seq, Some(undo_seq))?;
    record_reverses(repo, undo_seq, op.seq)?;

    let _ = crate::dash::append_dash_log(
        repo,
        &name,
        "undone",
        &format!("reversed {} (operation {})", op.verb.as_str(), op.seq),
    );

    Ok(UndoOutcome {
        seq: op.seq,
        verb: op.verb,
        dash: name,
        recorded_as: undo_seq,
        dash_tip,
        base_tip,
        handed_back_left_in_place: after.handed_back.clone(),
        restored_unbound: matches!(op.verb, OpVerb::Join | OpVerb::Discard),
        warnings,
    })
}

/// What a redo did.
#[derive(Debug, Clone, Serialize)]
pub struct RedoOutcome {
    /// The undo that was reversed.
    pub seq: u64,
    /// The original operation the undo had reversed, and this redo re-applied.
    pub original_seq: u64,
    /// The original operation's verb — what was re-applied.
    pub verb: OpVerb,
    pub dash: String,
    /// The sequence number this redo was itself recorded under.
    pub recorded_as: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dash_tip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_tip: Option<String>,
    /// Paths the original discard copied into the base checkout, which a redo
    /// does not re-copy or remove — named for the same reason undo names them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub handed_back_left_in_place: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Re-apply the operation the most recent undo reversed.
///
/// **Redo is always materially possible while the undo's record stands**, and
/// the reason is worth stating because it is what makes the refusals below
/// about consent rather than capability: an undo records itself *before* it
/// acts, so its own keepalive parents the original operation's after-tips. The
/// landed join commit survives its own undo because the undo recorded it.
///
/// Every re-application is a compare-and-swap against the recorded tips, with
/// the same refusal vocabulary undo established. Nothing forces.
pub fn redo_in(repo: &Path, dash: Option<&str>) -> Result<RedoOutcome, String> {
    let repo = crate::ops::main_repo_root(repo);
    let repo = repo.as_path();

    let all = list_ops(repo);
    let candidates: Vec<&OpPayload> = all
        .iter()
        .filter(|op| dash.is_none_or(|d| op.dash == d))
        .collect();

    let undo = match candidates.iter().find(|op| op.is_redoable()) {
        Some(op) => (*op).clone(),
        None => {
            // The same three-state care `undo_in` takes: an undo already
            // redone and one that died mid-flight are different facts.
            if let Some(op) = candidates.iter().find(|op| op.verb == OpVerb::Undo) {
                if let Some(by) = op.undone_by {
                    return Err(format!(
                        "already-redone: undo {} (of '{}') was reversed by operation {by}",
                        op.seq, op.dash
                    ));
                }
                if op.after.is_none() {
                    return Err(format!(
                        "incomplete-op: undo {} (of '{}') never finished, so what it changed is \
                         unknown; it cannot be redone automatically",
                        op.seq, op.dash
                    ));
                }
            }
            return Err(match dash {
                Some(d) => format!("nothing-to-redo: no undo is recorded for '{d}'"),
                None => "nothing-to-redo: no undo is recorded".to_string(),
            });
        }
    };

    // The operation the undo reversed, named by the record. The backlink search
    // is the fallback for payloads written before `reverses` existed.
    let original = undo
        .reverses
        .and_then(|seq| all.iter().find(|op| op.seq == seq))
        .or_else(|| all.iter().find(|op| op.undone_by == Some(undo.seq)))
        .cloned()
        .ok_or_else(|| {
            format!(
                "incomplete-op: undo {} does not name the operation it reversed",
                undo.seq
            )
        })?;
    let original_after = original.after.clone().ok_or_else(|| {
        format!(
            "incomplete-op: operation {} never recorded what it did",
            original.seq
        )
    })?;

    // **`superseded` is the legible guard, not the load-bearing one.** It
    // catches the common shape — the dash was worked on after the undo — while
    // the per-verb compare-and-swap below covers what a per-dash scan cannot,
    // such as another dash landing on the same base in the meantime.
    if let Some(newer) = all
        .iter()
        .find(|op| op.dash == original.dash && op.seq > undo.seq && !op.verb.is_reversal())
    {
        return Err(format!(
            "superseded: operation {} ({} of '{}') has run since the undo, so re-applying it \
             would trample newer work",
            newer.seq,
            newer.verb.as_str(),
            newer.dash
        ));
    }

    let mut warnings = Vec::new();
    let name = original.dash.clone();

    let redo_before = capture_before(repo, &name).unwrap_or(OpBefore {
        base_branch: original.before.base_branch.clone(),
        base_tip: git_stdout(repo, &["rev-parse", &original.before.base_branch])
            .unwrap_or_default(),
        dash_tip: String::new(),
        worktree: original.before.worktree.clone(),
        config: OpConfig::default(),
        candidate: None,
        conflict: None,
        broke_lease: None,
    });
    let tips = tips_of(&redo_before);
    let redo_seq = record_begin(repo, OpVerb::Redo, &name, redo_before, &tips)?;

    let outcome = match original.verb {
        OpVerb::Join => redo_join(repo, &original, &original_after, &mut warnings),
        // Re-committing is the fold's own act, and the fold is the one that
        // knows which paths it took. Redo therefore replays the base tip
        // rather than re-deriving the commit — the object is still there, and
        // `--keep` refuses over local changes that would be lost.
        OpVerb::ResolveBase => redo_resolve_base(repo, &original_after),
        OpVerb::Replay => redo_replay(repo, &original, &original_after),
        OpVerb::Discard => redo_discard(repo, &original, &mut warnings),
        OpVerb::Undo | OpVerb::Redo => {
            unreachable!("a reversal is never the operation an undo reversed")
        }
    };

    let (dash_tip, base_tip) = match outcome {
        Ok(pair) => pair,
        Err(e) => {
            abandon(repo, redo_seq);
            return Err(e);
        }
    };

    record_complete(
        repo,
        redo_seq,
        OpAfter {
            base_tip: base_tip.clone(),
            dash_tip: dash_tip.clone(),
            ..Default::default()
        },
    )?;
    record_reverses(repo, redo_seq, undo.seq)?;
    // The undo is now itself reversed, and the original is undoable again —
    // which is what makes a following `undo` press mean the original rather
    // than descending into bookkeeping.
    record_undone_by(repo, undo.seq, Some(redo_seq))?;
    record_undone_by(repo, original.seq, None)?;

    let _ = crate::dash::append_dash_log(
        repo,
        &name,
        "redone",
        &format!(
            "re-applied {} (operation {})",
            original.verb.as_str(),
            original.seq
        ),
    );

    Ok(RedoOutcome {
        seq: undo.seq,
        original_seq: original.seq,
        verb: original.verb,
        dash: name,
        recorded_as: redo_seq,
        dash_tip,
        base_tip,
        handed_back_left_in_place: original_after.handed_back.clone(),
        warnings,
    })
}

/// Refuse rather than delete over uncommitted work in a dash the undo gave
/// back.
///
/// `discard` hands such work to the base checkout instead of refusing, but that
/// is a teardown the user asked for while looking at it. A redo is an
/// undo-of-an-undo, where a surprise costs more than a second gesture — and
/// moving somebody's files as a side effect of bookkeeping is what this engine
/// does not do.
fn refuse_dirty_worktree(op: &OpPayload) -> Result<(), String> {
    let worktree = PathBuf::from(&op.before.worktree);
    if !worktree.exists() {
        return Ok(());
    }
    let dirt = git_stdout(&worktree, &["status", "--porcelain"]).unwrap_or_default();
    let paths: Vec<&str> = dirt
        .lines()
        .filter_map(|l| l.get(3..))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    Err(format!(
        "worktree-dirty: '{}' has uncommitted work in {}; redoing would delete it, so commit or \
         discard those changes first",
        op.before.worktree,
        paths.join(", ")
    ))
}

/// Re-apply a folded base edit: move the base back to the commit the fold made.
///
/// The commit object survives the undo — nothing deletes it — so redo is the
/// tip move and nothing else. `--keep` rather than `--hard` for the reason it
/// is used everywhere else here: it refuses over tracked changes that would be
/// lost instead of discarding them, so a redo over work done since the undo
/// stops rather than eating it.
fn redo_resolve_base(
    repo: &Path,
    after: &OpAfter,
) -> Result<(Option<String>, Option<String>), String> {
    let tip = after
        .base_tip
        .as_deref()
        .ok_or("incomplete-op: the resolve recorded no resulting base tip")?;
    git_stdout(repo, &["reset", "--keep", tip])?;
    Ok((None, Some(tip.to_string())))
}

/// Re-land the join: move the base back to what it landed, then tear the dash
/// down again.
fn redo_join(
    repo: &Path,
    op: &OpPayload,
    after: &OpAfter,
    warnings: &mut Vec<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let base_branch = &op.before.base_branch;
    let landed = after
        .base_tip
        .as_deref()
        .ok_or("incomplete-op: the join recorded no resulting base tip")?;

    // The world must still look like what the undo left.
    let current = git_stdout(repo, &["rev-parse", base_branch])?;
    if current != op.before.base_tip {
        return Err(format!(
            "tip-moved: '{base_branch}' is at {} but the undo left it at {}; something has landed \
             since, so re-applying the join would destroy it",
            &current[..current.len().min(9)],
            &op.before.base_tip[..op.before.base_tip.len().min(9)]
        ));
    }
    let branch = crate::ops::branch_name(&op.dash);
    if crate::ops::branch_exists(repo, &branch) {
        let dash_now = git_stdout(repo, &["rev-parse", &branch])?;
        if dash_now != op.before.dash_tip {
            return Err(format!(
                "tip-moved: '{branch}' is at {} but the join consumed {}; the dash has moved since \
                 the undo restored it",
                &dash_now[..dash_now.len().min(9)],
                &op.before.dash_tip[..op.before.dash_tip.len().min(9)]
            ));
        }
    }
    refuse_dirty_worktree(op)?;

    // `--keep` for the same reason the undo uses it: it refuses over tracked
    // changes rather than discarding them.
    let reset = git_output(repo, &["reset", "--keep", landed])?;
    if !reset.status.success() {
        return Err(format!(
            "base-dirty: git refused to move '{base_branch}' forward: {}",
            String::from_utf8_lossy(&reset.stderr).trim()
        ));
    }

    teardown_dash(repo, op, warnings);
    Ok((None, Some(landed.to_string())))
}

/// Re-apply the replay: move the dash branch forward to the tip it left.
///
/// **A compare-and-swap and nothing else.** In particular no ledger reconcile:
/// the plan's commit cells are committed content on the branch, so moving the
/// branch moves them — which is why `undo_replay` does no ledger work either,
/// and the two directions stay symmetric. A forward reconcile would be worse
/// than redundant, because it can land a bookkeeping commit that leaves the tip
/// *past* the recorded one and makes the next undo's CAS refuse `tip-moved`.
fn redo_replay(
    repo: &Path,
    op: &OpPayload,
    after: &OpAfter,
) -> Result<(Option<String>, Option<String>), String> {
    let worktree = PathBuf::from(&op.before.worktree);
    if !worktree.exists() {
        return Err(format!(
            "no-worktree: '{}' is gone, and the branch move happens from inside it",
            op.before.worktree
        ));
    }
    let target = after
        .dash_tip
        .as_deref()
        .ok_or("incomplete-op: the replay recorded no resulting dash tip")?;

    match crate::replay::cas_reset(&worktree, &op.before.dash_tip, target)? {
        None => {
            // The forward half of the undo's reversal: the cells move with the
            // branch only because something moves them.
            crate::replay::remap_ledger_cells(repo, &op.dash, &after.mapping);
            Ok((Some(target.to_string()), None))
        }
        Some(crate::replay::ReplayOutcome::Deferred { reason, detail }) => {
            Err(format!("{reason}: {detail}"))
        }
        Some(other) => Err(format!("the branch could not be moved forward: {other:?}")),
    }
}

/// Re-apply the discard: take the dash back down.
///
/// The hand-back is **not** repeated. Those files were copied into the base
/// checkout by the original discard and are still there; copying them again, or
/// pulling them back out, are both things this engine does not do to somebody's
/// checkout. The outcome names them instead.
fn redo_discard(
    repo: &Path,
    op: &OpPayload,
    warnings: &mut Vec<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let branch = crate::ops::branch_name(&op.dash);
    if crate::ops::branch_exists(repo, &branch) {
        let dash_now = git_stdout(repo, &["rev-parse", &branch])?;
        if dash_now != op.before.dash_tip {
            return Err(format!(
                "tip-moved: '{branch}' is at {} but the discard removed {}; the dash has moved \
                 since the undo restored it",
                &dash_now[..dash_now.len().min(9)],
                &op.before.dash_tip[..op.before.dash_tip.len().min(9)]
            ));
        }
    }
    refuse_dirty_worktree(op)?;
    teardown_dash(repo, op, warnings);
    Ok((None, None))
}

/// Remove the worktree, the branch, and the branch-config facts — the teardown
/// both join and discard perform, re-performed.
fn teardown_dash(repo: &Path, op: &OpPayload, warnings: &mut Vec<String>) {
    let worktree = PathBuf::from(&op.before.worktree);
    if worktree.exists() {
        let out = git_output(
            repo,
            &["worktree", "remove", "--force", &op.before.worktree],
        );
        if !out.as_ref().is_ok_and(|o| o.status.success()) {
            warnings.push(format!(
                "The worktree at {} could not be removed; the branch was still taken down.",
                op.before.worktree
            ));
        }
    }
    let branch = crate::ops::branch_name(&op.dash);
    if crate::ops::branch_exists(repo, &branch) {
        let out = git_output(repo, &["branch", "-D", &branch]);
        if !out.as_ref().is_ok_and(|o| o.status.success()) {
            warnings.push(format!("The branch '{branch}' could not be removed."));
        }
    }
    crate::resolve::clear_candidate(repo, &op.dash);
}

/// Put the base branch back, then rebuild the dash the join tore down.
fn undo_join(
    repo: &Path,
    op: &OpPayload,
    after: &OpAfter,
    warnings: &mut Vec<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let base_branch = &op.before.base_branch;
    let expected = after
        .base_tip
        .as_deref()
        .ok_or("incomplete-op: the join recorded no resulting base tip")?;
    let current = git_stdout(repo, &["rev-parse", base_branch])?;
    if current != expected {
        return Err(format!(
            "tip-moved: '{base_branch}' is at {} but the join left it at {}; something landed \
             since, so undoing would destroy it",
            &current[..current.len().min(9)],
            &expected[..expected.len().min(9)]
        ));
    }

    let branch = crate::ops::branch_name(&op.dash);
    if crate::ops::branch_exists(repo, &branch) {
        return Err(format!(
            "branch-exists: '{branch}' is already here, so the dash this join tore down has \
             since been rebuilt; undoing would overwrite it"
        ));
    }

    // `reset --keep` rather than `--hard`: it refuses over tracked-file changes
    // that would be lost instead of discarding them, which is the whole
    // difference between an undo and a wipe.
    let reset = git_output(repo, &["reset", "--keep", &op.before.base_tip])?;
    if !reset.status.success() {
        return Err(format!(
            "base-dirty: git refused to move '{base_branch}' back: {}",
            String::from_utf8_lossy(&reset.stderr).trim()
        ));
    }

    restore_dash(repo, op, warnings)?;
    restore_conflict_ref(repo, op, warnings);
    Ok((
        Some(op.before.dash_tip.clone()),
        Some(op.before.base_tip.clone()),
    ))
}

/// Put `refs/tug/conflict/<name>` back where the teardown found it.
///
/// Only for the two verbs whose teardown deletes it — join and discard, both
/// through `clear_candidate`, which folds `clear_conflict`. A replay never
/// touches the ref, and restoring the dash tip is itself what re-validates the
/// chain under the head-equality test.
///
/// **Never over a newer chain.** Between the join and its undo a fresh resolve
/// may have parked its own conflict at the same ref; overwriting that would
/// destroy newer work to restore older. When the ref stands somewhere else the
/// restore is skipped and both tips are named — the recorded chain stays
/// reachable through this operation's keepalive either way, so nothing is lost
/// by declining.
fn restore_conflict_ref(repo: &Path, op: &OpPayload, warnings: &mut Vec<String>) {
    let Some(recorded) = op.before.conflict.as_deref() else {
        return;
    };
    // The question is whether the *ref* stands, not whether what it points at
    // parses as a chain. A ref somebody else wrote is theirs either way, and a
    // restore that clobbered an unparseable one would be the same destruction
    // wearing a technicality.
    let ref_name = crate::resolve::conflict_ref_name(&op.dash);
    if let Ok(standing) = git_stdout(repo, &["rev-parse", "--verify", &ref_name]) {
        if standing != recorded {
            warnings.push(format!(
                "A newer conflict for '{}' stands at {}, so the one this operation recorded ({}) \
                 was left where it is; it stays reachable through the operation log.",
                op.dash,
                &standing[..standing.len().min(9)],
                &recorded[..recorded.len().min(9)]
            ));
        }
        return;
    }
    if let Err(e) = crate::resolve::advance_conflict_ref(repo, &op.dash, recorded) {
        warnings.push(format!("The conflict chain could not be restored: {e}"));
    }
}

/// Put a folded base edit back the way it was: uncommitted, on the base.
///
/// `reset --mixed` is the whole of it, and it is the right reset because it is
/// the exact inverse of what the fold did. The fold took working-tree content
/// and made it a commit; `--mixed` moves the branch back and leaves the index
/// and the working tree alone, so the same content is sitting there
/// uncommitted again — which is where the user had it. `--hard` would delete
/// their work and `--soft` would leave it staged, neither of which is what
/// they had.
///
/// The compare-and-swap is [`undo_join`]'s, for the same reason: a base that
/// has moved since is a base carrying somebody's work past this point, and
/// winding it back would take that with it.
fn undo_resolve_base(
    repo: &Path,
    op: &OpPayload,
    after: &OpAfter,
) -> Result<(Option<String>, Option<String>), String> {
    let base_branch = &op.before.base_branch;
    let expected = after
        .base_tip
        .as_deref()
        .ok_or("incomplete-op: the resolve recorded no resulting base tip")?;
    let current = git_stdout(repo, &["rev-parse", base_branch])?;
    if current != expected {
        return Err(format!(
            "tip-moved: '{base_branch}' is at {} but the resolve left it at {}; something landed \
             since, so undoing would destroy it",
            &current[..current.len().min(9)],
            &expected[..expected.len().min(9)]
        ));
    }
    git_stdout(repo, &["reset", "--mixed", &op.before.base_tip])?;
    Ok((None, Some(op.before.base_tip.clone())))
}

/// Move the dash branch back to the tip it had before the replay.
///
/// **No conflict-ref work, deliberately.** A replay never deletes the chain, so
/// there is nothing to restore — and moving the dash tip back is itself what
/// re-validates it: validity is head equality, and the heads the chain names
/// are the ones this reset just reinstated.
fn undo_replay(
    repo: &Path,
    op: &OpPayload,
    after: &OpAfter,
) -> Result<(Option<String>, Option<String>), String> {
    let worktree = PathBuf::from(&op.before.worktree);
    if !worktree.exists() {
        return Err(format!(
            "no-worktree: '{}' is gone, and the branch move happens from inside it",
            op.before.worktree
        ));
    }
    let expected = after
        .dash_tip
        .as_deref()
        .ok_or("incomplete-op: the replay recorded no resulting dash tip")?;

    // The same compare-and-swap the replay itself used, in the other
    // direction. Its refusals are outcomes rather than errors, so they are
    // translated into this module's vocabulary rather than dropped.
    match crate::replay::cas_reset(&worktree, expected, &op.before.dash_tip)? {
        None => {
            // The ledger lives outside every tree git watches, so moving the
            // branch back does not move its commit cells back with it. The
            // replay's own mapping, read in reverse, is the exact answer.
            let reversed: Vec<(String, String)> = after
                .mapping
                .iter()
                .map(|(old, new)| (new.clone(), old.clone()))
                .collect();
            crate::replay::remap_ledger_cells(repo, &op.dash, &reversed);
            Ok((Some(op.before.dash_tip.clone()), None))
        }
        Some(crate::replay::ReplayOutcome::Deferred { reason, detail }) => {
            Err(format!("{reason}: {detail}"))
        }
        Some(other) => Err(format!("the branch could not be moved back: {other:?}")),
    }
}

/// Rebuild a discarded dash. Handed-back files stay where the discard put them.
fn undo_discard(
    repo: &Path,
    op: &OpPayload,
    warnings: &mut Vec<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let branch = crate::ops::branch_name(&op.dash);
    if crate::ops::branch_exists(repo, &branch) {
        return Err(format!(
            "branch-exists: '{branch}' is already here; the dash was rebuilt since the discard"
        ));
    }
    restore_dash(repo, op, warnings)?;
    restore_conflict_ref(repo, op, warnings);
    Ok((Some(op.before.dash_tip.clone()), None))
}

/// Recreate a dash's branch, worktree, and branch-config facts.
///
/// Hydration failure is a warning rather than a rollback: the branch and its
/// history are the irreplaceable half, and refusing to restore them because
/// `bun install` failed would trade the whole recovery for a re-runnable
/// chore.
fn restore_dash(repo: &Path, op: &OpPayload, warnings: &mut Vec<String>) -> Result<(), String> {
    let branch = crate::ops::branch_name(&op.dash);
    let create = git_output(repo, &["branch", &branch, &op.before.dash_tip])?;
    if !create.status.success() {
        return Err(format!(
            "cannot recreate '{branch}': {}",
            String::from_utf8_lossy(&create.stderr).trim()
        ));
    }

    let worktree = PathBuf::from(&op.before.worktree);
    if !worktree.exists() {
        let add = git_output(repo, &["worktree", "add", &op.before.worktree, &branch])?;
        if !add.status.success() {
            warnings.push(format!(
                "The branch is back but its worktree could not be recreated: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
            return Ok(());
        }
        if let Err(e) = crate::ops::run_post_create(repo, &worktree) {
            warnings.push(format!("The worktree is back but its hooks failed: {e}"));
        }
    }

    // `branch -D` took the whole `branch.<name>.*` section with it, so a
    // recreated branch has forgotten its base, description, and id.
    let facts = [
        (
            crate::ops::base_config_key(&op.dash),
            &op.before.config.tugbase,
        ),
        (
            crate::ops::description_config_key(&op.dash),
            &op.before.config.description,
        ),
        (
            crate::ops::tugid_config_key(&op.dash),
            &op.before.config.tugid,
        ),
    ];
    for (key, value) in facts {
        if let Some(value) = value {
            let out = git_output(repo, &["config", &key, value])?;
            if !out.status.success() {
                warnings.push(format!("Failed to restore {key}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    struct Fixture {
        repo: tempfile::TempDir,
        _home: tempfile::TempDir,
    }

    impl Fixture {
        fn path(&self) -> &Path {
            self.repo.path()
        }
        fn tip(&self, rev: &str) -> String {
            git_stdout(self.path(), &["rev-parse", rev]).unwrap()
        }
        fn commit(&self, rel: &str, content: &str, msg: &str) -> String {
            std::fs::write(self.path().join(rel), content).unwrap();
            git(self.path(), &["add", "-A"]);
            git(self.path(), &["commit", "-m", msg]);
            self.tip("HEAD")
        }
    }

    /// `TUG_DATA_DIR` redirects `project_state_dir` into the fixture, which is
    /// also what keeps `refuse_unredirected_temp_repo` from firing. Every test
    /// here is `#[serial]` for that reason.
    fn init() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: every test in this module is #[serial]; no other thread reads
        // the environment while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        Fixture {
            repo: temp,
            _home: home,
        }
    }

    fn before(f: &Fixture) -> OpBefore {
        OpBefore {
            base_branch: "main".to_string(),
            base_tip: f.tip("HEAD"),
            dash_tip: f.tip("HEAD"),
            worktree: "/nowhere".to_string(),
            config: OpConfig {
                tugbase: Some("main".to_string()),
                description: Some("d".to_string()),
                tugid: Some("id".to_string()),
            },
            candidate: None,
            conflict: None,
            broke_lease: None,
        }
    }

    #[test]
    #[serial]
    fn a_payload_round_trips_through_json() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        let read = read_op(f.path(), seq).expect("the payload is on disk");
        assert_eq!(read.seq, seq);
        assert_eq!(read.verb, OpVerb::Join);
        assert_eq!(read.dash, "demo");
        // Per-verb fields absent on a fresh record, and absent from the JSON.
        assert!(read.after.is_none());
        assert!(read.undone_by.is_none());
        let raw = std::fs::read_to_string(payload_path(f.path(), seq)).unwrap();
        assert!(!raw.contains("handed_back"), "empty vectors are omitted");
        assert!(!raw.contains("\"after\""), "an unfinished op has no after");
    }

    #[test]
    #[serial]
    fn completing_an_op_attaches_the_after_state() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Replay, "demo", before(&f), &[]).unwrap();
        record_complete(
            f.path(),
            seq,
            OpAfter {
                dash_tip: Some("deadbeef".to_string()),
                mapping: vec![("old".to_string(), "new".to_string())],
                ..Default::default()
            },
        )
        .unwrap();
        let read = read_op(f.path(), seq).unwrap();
        let after = read.after.clone().expect("after is attached");
        assert_eq!(after.dash_tip.as_deref(), Some("deadbeef"));
        assert_eq!(after.mapping, vec![("old".to_string(), "new".to_string())]);
        assert!(read.is_undoable());
    }

    #[test]
    #[serial]
    fn the_keepalive_holds_a_tip_whose_branch_is_deleted() {
        let f = init();
        git(f.path(), &["branch", "doomed"]);
        let doomed = f.commit("g.txt", "G\n", "on main");
        git(f.path(), &["branch", "-f", "doomed", &doomed]);
        git(f.path(), &["reset", "--hard", "HEAD~1"]);

        record_begin(
            f.path(),
            OpVerb::Discard,
            "demo",
            before(&f),
            std::slice::from_ref(&doomed),
        )
        .unwrap();
        git(f.path(), &["branch", "-D", "doomed"]);

        // Nothing but the keepalive refers to it now.
        let alive = git_output(
            f.path(),
            &["cat-file", "-e", &format!("{doomed}^{{commit}}")],
        )
        .unwrap()
        .status
        .success();
        assert!(
            alive,
            "the keepalive ref keeps the deleted branch's tip reachable"
        );
    }

    /// A payload written before the conflict field existed must still parse —
    /// the log is append-only and old records outlive schema changes.
    #[test]
    #[serial]
    fn an_old_payload_without_the_conflict_field_still_parses() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        let path = payload_path(f.path(), seq);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("conflict"),
            "an absent chain is omitted from the JSON entirely"
        );
        let read = read_op(f.path(), seq).expect("it parses");
        assert!(read.before.conflict.is_none());

        // And a recorded one round-trips.
        let mut with = before(&f);
        with.conflict = Some(f.tip("HEAD"));
        let seq = record_begin(f.path(), OpVerb::Join, "demo", with, &[]).unwrap();
        assert_eq!(
            read_op(f.path(), seq).unwrap().before.conflict.as_deref(),
            Some(f.tip("HEAD").as_str())
        );
    }

    /// The keepalive's whole job, applied to the one commit family the landed
    /// round left outside it: a checkpoint the resolver committed must survive
    /// the teardown that deletes the conflict ref.
    #[test]
    #[serial]
    fn the_keepalive_holds_a_conflict_chain_whose_ref_is_deleted() {
        let f = init();
        git(f.path(), &["checkout", "-q", "-b", "chain"]);
        let checkpoint = f.commit("f.txt", "resolver got this far\n", "checkpoint");
        git(f.path(), &["checkout", "-q", "main"]);
        git(
            f.path(),
            &["update-ref", "refs/tug/conflict/demo", &checkpoint],
        );

        let mut b = before(&f);
        b.conflict = Some(checkpoint.clone());
        let tips = tips_of(&b);
        assert!(tips.contains(&checkpoint), "and the keepalive parents it");

        record_begin(f.path(), OpVerb::Join, "demo", b, &tips).unwrap();

        // The teardown: the ref goes, the branch goes, nothing else refers to it.
        crate::resolve::clear_conflict(f.path(), "demo");
        git(f.path(), &["branch", "-D", "chain"]);

        let alive = git_output(
            f.path(),
            &["cat-file", "-e", &format!("{checkpoint}^{{commit}}")],
        )
        .unwrap()
        .status
        .success();
        assert!(alive, "the resolver's checkpoint is still reachable");
    }

    #[test]
    #[serial]
    fn a_taken_sequence_number_is_not_reused() {
        let f = init();
        // Pre-create the ref the first allocation would claim, exactly as a
        // racing writer would have.
        let squatter = f.tip("HEAD");
        git(f.path(), &["update-ref", &oplog_ref_name(1), &squatter]);

        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        assert_eq!(seq, 2, "the allocation stepped over the taken number");
        assert_eq!(
            git_stdout(f.path(), &["rev-parse", &oplog_ref_name(1)]).unwrap(),
            squatter,
            "the squatter's ref is untouched"
        );
    }

    #[test]
    #[serial]
    fn recording_past_the_cap_prunes_the_oldest() {
        let f = init();
        for _ in 0..OPLOG_CAP {
            record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        }
        assert!(
            read_op(f.path(), 1).is_some(),
            "op 1 is still here at the cap"
        );

        record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();

        assert!(read_op(f.path(), 1).is_none(), "op 1's payload is pruned");
        assert!(
            git_stdout(f.path(), &["rev-parse", "--verify", &oplog_ref_name(1)]).is_err(),
            "op 1's keepalive ref is pruned — which is what lets gc collect it"
        );
        assert!(read_op(f.path(), 2).is_some(), "op 2 survives");
        assert_eq!(ref_seqs(f.path()).len(), OPLOG_CAP);
    }

    #[test]
    #[serial]
    fn the_list_is_newest_first_and_survives_a_hand_deleted_ref() {
        let f = init();
        let first = record_begin(f.path(), OpVerb::Join, "a", before(&f), &[]).unwrap();
        let second = record_begin(f.path(), OpVerb::Discard, "b", before(&f), &[]).unwrap();
        git(f.path(), &["update-ref", "-d", &oplog_ref_name(first)]);

        let ops = list_ops(f.path());
        assert_eq!(
            ops.len(),
            2,
            "the payload outliving its ref is still listed"
        );
        assert_eq!(ops[0].seq, second, "newest first");
        assert_eq!(ops[1].seq, first);
    }

    #[test]
    #[serial]
    fn newest_undoable_skips_the_unfinished_and_the_already_undone() {
        let f = init();
        let done = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_complete(f.path(), done, OpAfter::default()).unwrap();
        // A later op that never completed must not shadow the finished one.
        record_begin(f.path(), OpVerb::Replay, "demo", before(&f), &[]).unwrap();

        assert_eq!(newest_undoable(f.path(), None).unwrap().seq, done);
        assert_eq!(newest_undoable(f.path(), Some("demo")).unwrap().seq, done);
        assert!(newest_undoable(f.path(), Some("other")).is_none());

        record_undone_by(f.path(), done, Some(99)).unwrap();
        assert!(
            newest_undoable(f.path(), None).is_none(),
            "an undone op is no longer offered"
        );
    }

    #[test]
    #[serial]
    fn newest_incomplete_finds_the_op_a_resumed_verb_opened() {
        let f = init();
        let finished = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_complete(f.path(), finished, OpAfter::default()).unwrap();
        let open = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();

        let found = newest_incomplete(f.path(), "demo", OpVerb::Join).expect("the open op");
        assert_eq!(found.seq, open);
        assert!(newest_incomplete(f.path(), "demo", OpVerb::Discard).is_none());
    }

    fn progress(phase: JoinPhase, commit: &str) -> JoinProgress {
        JoinProgress {
            phase,
            commit_hash: commit.to_string(),
            strategy: "squash".to_string(),
            message: Some("landed it".to_string()),
        }
    }

    /// Writing a legacy journal the way the retired code did — plain
    /// `serde_json` over the old field set — so the fold is tested against the
    /// artifact rather than against a reconstruction of it.
    fn write_legacy_journal(f: &Fixture, dash: &str, phase: &str, base_branch: &str) {
        let dir = project_state_dir(f.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("join-journal-{dash}.json")),
            format!(
                r#"{{"name":"{dash}","base_branch":"{base_branch}","strategy":"squash",
                     "commit_hash":"deadbeef","phase":"{phase}","message":"from the journal"}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    #[serial]
    fn a_payload_with_join_progress_round_trips() {
        let f = init();
        for phase in [
            JoinPhase::Integrated,
            JoinPhase::WorktreeRemoved,
            JoinPhase::BranchDeleted,
        ] {
            let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
            record_join_progress(f.path(), seq, progress(phase, "abc123")).unwrap();
            let read = read_op(f.path(), seq).expect("it parses");
            let join = read.join.expect("progress is on the record");
            assert_eq!(join.phase, phase);
            assert_eq!(join.commit_hash, "abc123");
            assert_eq!(join.strategy, "squash");
            assert_eq!(join.message.as_deref(), Some("landed it"));
        }
    }

    #[test]
    #[serial]
    fn an_old_payload_without_the_join_field_still_parses() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        let raw = std::fs::read_to_string(payload_path(f.path(), seq)).unwrap();
        assert!(
            !raw.contains("\"join\":"),
            "a join that has not integrated yet omits the field entirely"
        );
        assert!(read_op(f.path(), seq).expect("it parses").join.is_none());
    }

    #[test]
    #[serial]
    fn join_in_flight_needs_both_an_open_op_and_progress() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        assert!(
            join_in_flight(f.path(), "demo").is_none(),
            "an op that never integrated is not a teardown to resume"
        );

        record_join_progress(f.path(), seq, progress(JoinPhase::Integrated, "abc123")).unwrap();
        assert_eq!(join_in_flight(f.path(), "demo").unwrap().seq, seq);
        assert!(
            join_in_flight(f.path(), "other").is_none(),
            "and it answers per dash"
        );

        record_complete(f.path(), seq, OpAfter::default()).unwrap();
        assert!(
            join_in_flight(f.path(), "demo").is_none(),
            "a completed join is not in flight"
        );

        // A verb other than Join carrying progress is impossible in practice;
        // the predicate names the verb anyway, so assert it cheaply.
        let other = record_begin(f.path(), OpVerb::Discard, "demo", before(&f), &[]).unwrap();
        record_join_progress(f.path(), other, progress(JoinPhase::Integrated, "abc123")).unwrap();
        assert!(join_in_flight(f.path(), "demo").is_none());
    }

    /// `undo_in` skips an incomplete operation rather than stopping at it, so an
    /// undo record can sit above a join that is half torn down. The scan must
    /// read past it.
    #[test]
    #[serial]
    fn an_undo_recorded_above_an_in_flight_join_does_not_hide_it() {
        let f = init();
        let join = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_join_progress(
            f.path(),
            join,
            progress(JoinPhase::WorktreeRemoved, "abc123"),
        )
        .unwrap();

        let undo = record_begin(f.path(), OpVerb::Undo, "demo", before(&f), &[]).unwrap();
        record_complete(f.path(), undo, OpAfter::default()).unwrap();
        assert!(undo > join, "the undo is the newer record");

        let found = join_in_flight(f.path(), "demo").expect("the join is still in flight");
        assert_eq!(found.seq, join);
        assert_eq!(found.join.unwrap().phase, JoinPhase::WorktreeRemoved);
    }

    /// The executable form of "no `for-each-ref`": with every keepalive gone,
    /// a ref-dependent read finds nothing and this one still answers.
    #[test]
    #[serial]
    fn the_in_flight_read_touches_no_refs() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_join_progress(f.path(), seq, progress(JoinPhase::Integrated, "abc123")).unwrap();
        git(f.path(), &["update-ref", "-d", &oplog_ref_name(seq)]);
        assert!(ref_seqs(f.path()).is_empty(), "the keepalive is gone");

        assert_eq!(join_in_flight(f.path(), "demo").unwrap().seq, seq);
    }

    #[test]
    #[serial]
    fn an_open_join_with_progress_is_refused_by_undo_as_incomplete() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_join_progress(
            f.path(),
            seq,
            progress(JoinPhase::WorktreeRemoved, "abc123"),
        )
        .unwrap();
        let err = undo_in(f.path(), Some("demo")).unwrap_err();
        assert!(err.starts_with("incomplete-op:"), "got {err}");
    }

    #[test]
    #[serial]
    fn abandon_drops_the_progress_with_the_payload() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "demo", before(&f), &[]).unwrap();
        record_join_progress(f.path(), seq, progress(JoinPhase::Integrated, "abc123")).unwrap();

        abandon(f.path(), seq);
        assert!(read_op(f.path(), seq).is_none(), "the payload is gone");
        assert!(ref_seqs(f.path()).is_empty(), "and so is the keepalive");
        assert!(join_in_flight(f.path(), "demo").is_none());
    }

    #[test]
    #[serial]
    fn a_legacy_journal_attaches_to_the_open_op_and_is_deleted() {
        let f = init();
        let seq = record_begin(f.path(), OpVerb::Join, "resume", before(&f), &[]).unwrap();
        write_legacy_journal(&f, "resume", "WorktreeRemoved", "main");

        let folded = fold_legacy_join_journal(f.path(), "resume").unwrap();
        assert_eq!(
            folded,
            Some(seq),
            "it attaches rather than recording a second"
        );
        let join = read_op(f.path(), seq)
            .unwrap()
            .join
            .expect("progress attached");
        assert_eq!(join.phase, JoinPhase::WorktreeRemoved);
        assert_eq!(join.commit_hash, "deadbeef");
        assert_eq!(join.message.as_deref(), Some("from the journal"));
        assert!(!legacy_journal_path(f.path(), "resume").exists());

        // Idempotent: a second fold finds nothing left to do.
        assert_eq!(fold_legacy_join_journal(f.path(), "resume").unwrap(), None);
        assert_eq!(join_in_flight(f.path(), "resume").unwrap().seq, seq);
    }

    #[test]
    #[serial]
    fn a_legacy_journal_with_no_open_op_records_one() {
        let f = init();
        write_legacy_journal(&f, "orphan", "BranchDeleted", "trunk");

        let seq = fold_legacy_join_journal(f.path(), "orphan")
            .unwrap()
            .expect("a record was created for it");
        let op = read_op(f.path(), seq).expect("the payload is on disk");
        assert_eq!(op.verb, OpVerb::Join);
        assert_eq!(op.dash, "orphan");
        assert!(
            op.after.is_none(),
            "and it is open, so --continue can finish it"
        );
        assert_eq!(
            op.before.base_branch, "trunk",
            "the journal's base branch wins over what capture_before guesses"
        );
        assert_eq!(op.join.unwrap().phase, JoinPhase::BranchDeleted);
        assert!(!legacy_journal_path(f.path(), "orphan").exists());
    }

    #[test]
    #[serial]
    fn an_unreadable_legacy_journal_is_left_in_place_and_named() {
        let f = init();
        let dir = project_state_dir(f.path());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("join-journal-broken.json");
        std::fs::write(&path, "{ not json at all").unwrap();

        let err = fold_legacy_join_journal(f.path(), "broken").unwrap_err();
        assert!(
            err.starts_with("legacy-join-journal-unreadable:"),
            "got {err}"
        );
        assert!(path.exists(), "a file nobody could read is never deleted");
        assert!(
            join_in_flight(f.path(), "broken").is_none(),
            "and the predicate says no rather than guessing"
        );
    }
}
