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
//! - A **payload**, `oplog-<seq>.json` beside the join journal in
//!   `project_state_dir`, holding the verb, the dash, and the before/after
//!   values. It is written twice — once before the verb acts and once when it
//!   completes — which is why it is a file rather than the keepalive's commit
//!   message: a message is immutable, and the second write is the whole point.
//!
//! The two halves store different facts, never the same one. The ref carries
//! reachability; the payload carries the record.
//!
//! **A payload with no `after` is an operation that died mid-flight**, and that
//! is a state the log reports rather than hides — [`undo_in`] refuses it by
//! name rather than guessing what half of it happened.
//!
//! Retention is [`OPLOG_CAP`] operations per repository, pruned oldest-first by
//! the writer. There is no daemon and no lock file; the same discipline the
//! join journal uses. Pruning drops both halves, and dropping the keepalive is
//! what finally lets `git gc` collect the commits — which is the honest meaning
//! of "this operation is no longer undoable".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tugutil_core::paths::project_state_dir;
use tugutil_core::session::now_iso8601;

use crate::dash::refuse_unredirected_temp_repo;
use crate::ops::{
    base_config_key, branch_name, config_get, dash_base, description_config_key, git_output,
    git_stdout, plan_config_key, tugid_config_key, worktree_path, write_atomic,
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
    Undo,
}

impl OpVerb {
    pub fn as_str(self) -> &'static str {
        match self {
            OpVerb::Join => "join",
            OpVerb::Replay => "replay",
            OpVerb::Discard => "discard",
            OpVerb::Undo => "undo",
        }
    }
}

/// The branch-config facts a dash carries, captured before a verb runs so an
/// undo can put them back.
///
/// `git branch -D` takes the whole `branch.<name>.*` section with it, so
/// recreating the branch alone would restore a dash that had forgotten its own
/// base, description, id, and plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tugbase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tugid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
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
        self.after.is_some() && self.undone_by.is_none() && self.verb != OpVerb::Undo
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
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/tug/oplog/",
        ],
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
            plan: config_get(repo, &plan_config_key(name)),
        },
        candidate: crate::resolve::read_candidate(repo, name),
    })
}

/// The tips a verb's keepalive must hold: the dash head, the base tip, and a
/// standing candidate.
pub(crate) fn tips_of(before: &OpBefore) -> Vec<String> {
    let mut tips = vec![before.dash_tip.clone(), before.base_tip.clone()];
    if let Some(candidate) = &before.candidate {
        tips.push(candidate.clone());
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
            undone_by: None,
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
    let mut payload = read_op(repo, seq)
        .ok_or_else(|| format!("oplog: no operation {seq} to complete"))?;
    payload.after = Some(after);
    write_payload(repo, &payload)
}

/// Mark `seq` as reversed by the undo operation `by`.
pub fn record_undone_by(repo: &Path, seq: u64, by: u64) -> Result<(), String> {
    let mut payload =
        read_op(repo, seq).ok_or_else(|| format!("oplog: no operation {seq} to mark undone"))?;
    payload.undone_by = Some(by);
    write_payload(repo, &payload)
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
    seqs.into_iter().filter_map(|seq| read_op(repo, seq)).collect()
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
/// `finish_join_teardown` is the caller this exists for: it receives the join
/// journal and nothing else, and it is also the `--continue` entry point, so
/// there is no sequence number to hand it.
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

    // Undo records are skipped wholesale, not refused: the operation a second
    // press means is the join or replay beneath them ([`OpPayload::is_undoable`]).
    let candidates: Vec<OpPayload> = list_ops(repo)
        .into_iter()
        .filter(|op| dash.is_none_or(|d| op.dash == d))
        .filter(|op| op.verb != OpVerb::Undo)
        .collect();

    let op = match candidates.iter().find(|op| op.is_undoable()) {
        Some(op) => op.clone(),
        None => {
            // Say which of the three "nothing to undo" states this is: an
            // operation already reversed and one that died mid-flight are
            // different facts, and a single blank refusal hides both.
            if let Some(op) = candidates.first() {
                if op.undone_by.is_some() {
                    return Err(format!(
                        "already-undone: operation {} ({} of '{}') was reversed by operation {}",
                        op.seq,
                        op.verb.as_str(),
                        op.dash,
                        op.undone_by.unwrap()
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
    });
    let tips = tips_of(&undo_before);
    let undo_seq = record_begin(repo, OpVerb::Undo, &name, undo_before, &tips)?;

    let outcome = match op.verb {
        OpVerb::Join => undo_join(repo, &op, &after, &mut warnings),
        OpVerb::Replay => undo_replay(&op, &after),
        OpVerb::Discard => undo_discard(repo, &op, &mut warnings),
        OpVerb::Undo => unreachable!("undo records are filtered out of the candidates"),
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
    record_undone_by(repo, op.seq, undo_seq)?;

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
    Ok((
        Some(op.before.dash_tip.clone()),
        Some(op.before.base_tip.clone()),
    ))
}

/// Move the dash branch back to the tip it had before the replay.
fn undo_replay(
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
        None => Ok((Some(op.before.dash_tip.clone()), None)),
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
        let add = git_output(
            repo,
            &["worktree", "add", &op.before.worktree, &branch],
        )?;
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
    // recreated branch has forgotten its base, description, id, and plan.
    let facts = [
        (crate::ops::base_config_key(&op.dash), &op.before.config.tugbase),
        (
            crate::ops::description_config_key(&op.dash),
            &op.before.config.description,
        ),
        (crate::ops::tugid_config_key(&op.dash), &op.before.config.tugid),
        (crate::ops::plan_config_key(&op.dash), &op.before.config.plan),
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
                plan: Some("dash/p.md".to_string()),
            },
            candidate: None,
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
        assert_eq!(read.before.config.plan.as_deref(), Some("dash/p.md"));
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
            &[doomed.clone()],
        )
        .unwrap();
        git(f.path(), &["branch", "-D", "doomed"]);

        // Nothing but the keepalive refers to it now.
        let alive = git_output(f.path(), &["cat-file", "-e", &format!("{doomed}^{{commit}}")])
            .unwrap()
            .status
            .success();
        assert!(alive, "the keepalive ref keeps the deleted branch's tip reachable");
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
        assert!(read_op(f.path(), 1).is_some(), "op 1 is still here at the cap");

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
        assert_eq!(ops.len(), 2, "the payload outliving its ref is still listed");
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

        record_undone_by(f.path(), done, 99).unwrap();
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
}
