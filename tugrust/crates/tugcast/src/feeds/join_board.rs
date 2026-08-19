//! Eager join facts for the dash feed entries ([P01], [P04], Spec S03).
//!
//! Every dash entry the changeset feed composes carries the join pipeline's
//! entire durable state, computed here. The client holds no durable copy: it
//! renders what this says.
//!
//! # What is cached, and what is deliberately not
//!
//! This split is the whole of this module, and getting it backwards would
//! rebuild the bug the feature exists to remove.
//!
//! **Cached, keyed by `(base_sha, dash_head_sha)`** — the `merge-tree` conflict
//! probe, the archaeology behind it, and the candidate's per-file diffs. Each is
//! a pure function of those two commits, so a hit is sound and a miss costs one
//! probe per actual movement.
//!
//! **Never cached** — the blockers, and every ref and config read. Blockers
//! answer to working-tree dirt, to which branch the base checkout has out, and
//! to a journal file; none of those move a SHA. A blocker set cached against
//! the two heads would keep refusing a join whose real answer changed the
//! moment the user cleaned their checkout — a face that lies, which is exactly
//! what this whole seam was built to stop.
//!
//! The expensive half is also skipped when it would not be shown: while
//! blockers stand, the state is `blocked` and no conflict list is rendered, so
//! the probe does not run at all.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use tugcast_core::types::{
    DashConflictCommit, DashConflictHistory, DashJoinBlocker, DashJoinQuestion, DashJoinReport,
    DashJoinState, DashJoinVerification, DashResolvedFile,
};
use tugdash_core::ops::{self, DashDetail};
use tugdash_core::resolve::{self, CandidateStatus};
use tugdash_core::verify;

/// The cacheable half of one dash's join facts, and the head pair it describes.
#[derive(Clone)]
struct CachedProbe {
    base_sha: String,
    dash_sha: String,
    conflicts: Vec<String>,
    archaeology: Vec<DashConflictHistory>,
    /// Keyed by candidate sha, because a re-resolve against the same heads can
    /// produce a different candidate and its diffs must not be inherited.
    diffs: HashMap<String, Vec<DashResolvedFile>>,
}

#[derive(Default)]
pub struct JoinBoard {
    by_dash: Mutex<HashMap<String, CachedProbe>>,
}

static BOARD: OnceLock<Arc<JoinBoard>> = OnceLock::new();

/// How many times the expensive probe has actually run.
///
/// A cache whose only evidence is "the answer looks right" is untested: the
/// wrong-but-plausible implementation returns the same answer while paying the
/// cost every time. Counting the probes is what lets a test tell a hit from a
/// miss, and what lets one assert the blocked path skips the probe entirely.
static PROBE_RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The probe counter's current value.
#[cfg(test)]
pub fn probe_runs() -> u64 {
    PROBE_RUNS.load(std::sync::atomic::Ordering::Relaxed)
}

fn board() -> Arc<JoinBoard> {
    Arc::clone(BOARD.get_or_init(|| Arc::new(JoinBoard::default())))
}

/// Drop cache entries for dashes that no longer exist.
pub fn sweep(live_owner_keys: &[String]) {
    let board = board();
    let mut map = board.by_dash.lock().expect("join board mutex");
    map.retain(|key, _| live_owner_keys.iter().any(|k| k == key));
}

/// Compose one dash's join state.
///
/// `current_branch` is read once per recompute by the caller and passed in,
/// rather than read once per dash: it is a property of the repository, not of
/// the dash, and the feed may be holding many.
pub fn join_state_for(
    repo_root: &Path,
    detail: &DashDetail,
    current_branch: &str,
) -> DashJoinState {
    // Uncached, always: what would refuse a join right now.
    let blockers: Vec<DashJoinBlocker> =
        ops::join_blockers_from_detail(repo_root, detail, current_branch)
            .into_iter()
            .map(|b| DashJoinBlocker {
                kind: b.kind,
                detail: b.detail,
                paths: b.paths,
            })
            .collect();

    // Uncached, always: the candidate ref and its marks. A candidate that no
    // longer describes the current heads is dropped here rather than reported,
    // so the state demotes itself instead of standing as a lie.
    let name = detail.name.as_str();
    let status = resolve::candidate_status(repo_root, name, &detail.base);
    let mut stale_note = None;
    let mut candidate = None;
    match status {
        CandidateStatus::Valid(sha) => candidate = Some(sha),
        CandidateStatus::Stale(note) => {
            resolve::clear_candidate(repo_root, name);
            stale_note = Some(note);
        }
        CandidateStatus::None => {}
    }

    if !blockers.is_empty() {
        // The probe's answer would not be displayed, so it is not paid for.
        return DashJoinState {
            phase: "blocked".to_string(),
            blockers,
            conflicts: Vec::new(),
            archaeology: Vec::new(),
            candidate,
            resolved: Vec::new(),
            stale_note,
            verification: None,
            report: None,
            stuck: standing_stuck(repo_root, detail),
            question: standing_question(repo_root, detail),
        };
    }

    let probe = cached_probe(repo_root, detail);
    let (conflicts, archaeology) = match &probe {
        Some(p) => (p.conflicts.clone(), p.archaeology.clone()),
        None => (Vec::new(), Vec::new()),
    };

    let resolved = match &candidate {
        Some(sha) => candidate_files(repo_root, detail, sha, probe.as_ref()),
        None => Vec::new(),
    };

    let phase = if candidate.is_some() {
        "resolved"
    } else if !conflicts.is_empty() {
        "conflicted"
    } else {
        "previewed"
    };

    let verification = standing_verification(repo_root, detail, candidate.as_deref());
    let report = candidate
        .as_deref()
        .and_then(|sha| standing_report(repo_root, name, sha));
    let stuck = standing_stuck(repo_root, detail);
    let question = standing_question(repo_root, detail);

    DashJoinState {
        phase: phase.to_string(),
        blockers,
        conflicts,
        archaeology,
        candidate,
        resolved,
        stale_note,
        verification,
        report,
        stuck,
        question,
    }
}

/// The escalation a resolve is blocked on, while it still describes the dash
/// head it was raised against.
///
/// Read on every recompute rather than held in memory, because the whole point
/// of persisting it is that a reload — a fresh process, an empty memory — must
/// still render the question the resolver is waiting on.
fn standing_question(repo_root: &Path, detail: &DashDetail) -> Option<DashJoinQuestion> {
    let head = ops::rev_parse(repo_root, &detail.branch).ok()?;
    let json = resolve::read_question(repo_root, detail.name.as_str(), &head)?;
    serde_json::from_str(&json).ok()
}

/// The resolver's account of the candidate that stands.
///
/// Anchored to the candidate sha, so a report about a superseded resolution is
/// simply not found — the same self-demotion the verdict beside it gets, and
/// for the same reason: a report describing a tree that is no longer the
/// candidate would be read as describing the one that is.
fn standing_report(repo_root: &Path, name: &str, candidate: &str) -> Option<DashJoinReport> {
    let json = resolve::read_report(repo_root, name, candidate)?;
    serde_json::from_str(&json).ok()
}

/// Why the last resolve stopped short, while it still describes the dash head
/// it ran on.
///
/// A new round on the dash means the refusal was about a state that no longer
/// exists, so it stops being reported — but unlike the candidate facts it is
/// not *cleared* here. A resolve clears it when it starts, which is the moment
/// it stops being true; clearing it on a recompute would erase the account of a
/// failure nobody had read yet.
fn standing_stuck(repo_root: &Path, detail: &DashDetail) -> Option<String> {
    let head = ops::rev_parse(repo_root, &detail.branch).ok()?;
    resolve::read_stuck(repo_root, detail.name.as_str(), &head)
}

/// The candidate's verdict, but only while it still describes these two heads.
///
/// A verdict is a pure function of `(base_sha, candidate_sha)`, so it caches
/// against that pair — and the instant either moves it stops being stale data
/// and becomes a green about a tree nobody built. It is therefore *cleared*
/// here rather than merely withheld, exactly as a stale candidate is: a fact
/// the board will not report is a fact that must not survive to be read by
/// something else.
fn standing_verification(
    repo_root: &Path,
    detail: &DashDetail,
    candidate: Option<&str>,
) -> Option<DashJoinVerification> {
    let name = detail.name.as_str();
    let fact = verify::read_verification(repo_root, name)?;
    let base_sha = ops::rev_parse(repo_root, &detail.base).ok()?;
    let Some(candidate) = candidate else {
        verify::clear_verification(repo_root, name);
        return None;
    };
    if !fact.describes(&base_sha, candidate) {
        verify::clear_verification(repo_root, name);
        return None;
    }
    Some(DashJoinVerification {
        tier0: fact.tier0.as_str().to_string(),
        tier1: fact.tier1.as_str().to_string(),
        failures: fact.failures,
        notes: fact.notes,
        base_sha: fact.base_sha,
        candidate_sha: fact.candidate_sha,
    })
}

/// The conflict probe, from cache when the head pair is unmoved.
fn cached_probe(repo_root: &Path, detail: &DashDetail) -> Option<CachedProbe> {
    let key = detail.owner_key.clone();
    let board = board();

    // A cheap pair of reads decides whether the expensive probe is needed.
    let base_sha = ops::rev_parse(repo_root, &detail.base).ok()?;
    let dash_sha = ops::rev_parse(repo_root, &detail.branch).ok()?;

    {
        let map = board.by_dash.lock().expect("join board mutex");
        if let Some(hit) = map.get(&key) {
            if hit.base_sha == base_sha && hit.dash_sha == dash_sha {
                return Some(hit.clone());
            }
        }
    }

    PROBE_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let probed = ops::join_conflicts_in(repo_root, &detail.name).ok()?;
    let fresh = CachedProbe {
        base_sha: probed.base_sha,
        dash_sha: probed.dash_sha,
        conflicts: probed.conflicts,
        archaeology: probed
            .archaeology
            .into_iter()
            .map(|h| DashConflictHistory {
                path: h.path,
                commits: h
                    .commits
                    .into_iter()
                    .map(|c| DashConflictCommit {
                        sha: c.sha,
                        subject: c.subject,
                    })
                    .collect(),
                total: h.total,
            })
            .collect(),
        diffs: HashMap::new(),
    };
    board
        .by_dash
        .lock()
        .expect("join board mutex")
        .insert(key, fresh.clone());
    Some(fresh)
}

/// The review payload for a valid candidate: diffs recomputed from git, rungs
/// read back from where the ladder persisted them.
///
/// The two halves come from different places on purpose. The diffs are a pure
/// function of `(base_head, candidate, path)`, so recomputing them means the
/// feed's copy and the commit cannot drift. The rung is not recorded anywhere
/// in git — the candidate holds the resolved bytes and says nothing about which
/// rung chose them — so it is read from the config the ladder wrote. A path
/// whose rung cannot be recovered still renders, as `unknown`: a resolution
/// nobody can attribute is still one that has to be reviewed.
fn candidate_files(
    repo_root: &Path,
    detail: &DashDetail,
    candidate: &str,
    probe: Option<&CachedProbe>,
) -> Vec<DashResolvedFile> {
    let name = detail.name.as_str();

    if let Some(p) = probe {
        if let Some(hit) = p.diffs.get(candidate) {
            return hit.clone();
        }
    }

    let rungs = resolve::read_resolved_rungs(repo_root, name);
    let files: Vec<DashResolvedFile> = rungs
        .iter()
        .map(|(path, by)| {
            let d = resolve::candidate_path_diff(repo_root, &detail.base, candidate, path);
            DashResolvedFile {
                path: path.clone(),
                resolved_by: by.as_str().to_string(),
                added: d.as_ref().and_then(|d| d.added),
                removed: d.as_ref().and_then(|d| d.removed),
                diff: d.map(|d| d.text),
            }
        })
        .collect();

    if probe.is_some() {
        let board = board();
        let mut map = board.by_dash.lock().expect("join board mutex");
        if let Some(entry) = map.get_mut(&detail.owner_key) {
            entry.diffs.insert(candidate.to_string(), files.clone());
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
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

    /// A repo on `main` with a conflicting dash and a stub merge driver, so the
    /// ladder reaches a candidate without the AI rung.
    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);
        git(repo, &["switch", "-q", "tugdash/demo"]);
        std::fs::write(repo.join("f.txt"), "B\n").unwrap();
        git(repo, &["commit", "-am", "r1"]);
        git(repo, &["switch", "-q", "main"]);
        std::fs::write(repo.join("f.txt"), "C\n").unwrap();
        git(repo, &["commit", "-am", "main to C"]);

        let stub = repo.join("stub-driver.sh");
        std::fs::write(&stub, "#!/bin/sh\nprintf 'RESOLVED\\n' > \"$4\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(
            repo,
            &["config", "tugdash.mergedriver", &stub.to_string_lossy()],
        );
        temp
    }

    fn detail_for(repo: &Path) -> DashDetail {
        ops::dash_detail_entry_in(repo, "demo").expect("detail")
    }

    fn compose(repo: &Path) -> DashJoinState {
        let detail = detail_for(repo);
        let branch = ops::current_branch(repo).unwrap();
        join_state_for(repo, &detail, &branch)
    }

    #[test]
    fn conflicted_then_resolved_then_stale_across_the_candidate_lifecycle() {
        let temp = fixture();
        let repo = temp.path();

        let conflicted = compose(repo);
        assert_eq!(conflicted.phase, "conflicted");
        assert_eq!(conflicted.conflicts, vec!["f.txt".to_string()]);
        assert!(conflicted.candidate.is_none());

        // The ladder builds and anchors a candidate.
        let outcome = tugdash_core::resolve::resolve_conflicts(repo, "demo", None).unwrap();
        let candidate = outcome.candidate_commit.clone().expect("candidate");

        let resolved = compose(repo);
        assert_eq!(resolved.phase, "resolved");
        assert_eq!(resolved.candidate.as_deref(), Some(candidate.as_str()));
        assert_eq!(resolved.resolved.len(), 1, "the review payload rides along");
        assert_eq!(resolved.resolved[0].path, "f.txt");
        assert_eq!(
            resolved.resolved[0].resolved_by, "driver",
            "the rung the ladder used, read back from where it was persisted"
        );
        assert!(
            resolved.resolved[0].diff.is_some(),
            "and its diff, recomputed from git"
        );

        // The base advances past the candidate → the state demotes itself and
        // says why, and the stale ref is gone rather than left standing.
        std::fs::write(repo.join("other.txt"), "later\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "main moves on"]);
        let stale = compose(repo);
        assert!(
            stale.candidate.is_none(),
            "the stale candidate is not shown"
        );
        assert!(
            stale.stale_note.is_some(),
            "and the demotion carries a sentence"
        );
        assert_eq!(tugdash_core::resolve::read_candidate(repo, "demo"), None);
    }

    #[test]
    fn the_probe_is_cached_by_the_head_pair_but_blockers_are_not() {
        let temp = fixture();
        let repo = temp.path();

        let before = probe_runs();
        let first = compose(repo);
        let after_first = probe_runs();
        assert_eq!(after_first, before + 1, "the first compose probes");
        assert_eq!(first.phase, "conflicted");

        let second = compose(repo);
        assert_eq!(
            probe_runs(),
            after_first,
            "an unmoved head pair is a cache hit"
        );
        assert_eq!(second.conflicts, first.conflicts);

        // Now dirty the base over a path the dash also changes. NO sha moves —
        // and the blockers must change anyway. This is the exact case a
        // blocker cache keyed by the head pair would get wrong.
        let heads = |r: &Path| {
            (
                ops::rev_parse(r, "main").unwrap(),
                ops::rev_parse(r, "tugdash/demo").unwrap(),
            )
        };
        let pinned = heads(repo);
        std::fs::write(repo.join("f.txt"), "C\nlocal edit\n").unwrap();

        let blocked = compose(repo);
        assert_eq!(pinned, heads(repo), "precondition: no sha moved");
        assert_eq!(blocked.phase, "blocked");
        assert!(
            blocked.blockers.iter().any(|b| b.kind == "base-dirt"),
            "the live refusal reaches the face: {:?}",
            blocked.blockers
        );
        assert!(
            blocked.conflicts.is_empty(),
            "a blocked dash shows no conflict list"
        );

        // Cleaning it clears the blocker, again with no sha movement.
        git(repo, &["checkout", "--", "f.txt"]);
        let cleared = compose(repo);
        assert_eq!(pinned, heads(repo), "still no sha moved");
        assert!(cleared.blockers.is_empty(), "the refusal lifts");
        assert_eq!(cleared.phase, "conflicted");
    }

    #[test]
    fn a_blocked_dash_never_pays_for_the_probe() {
        let temp = fixture();
        let repo = temp.path();

        // Block it before anything has been probed for this dash.
        git(repo, &["switch", "-q", "-c", "scratch"]);

        let before = probe_runs();
        let blocked = compose(repo);
        assert_eq!(blocked.phase, "blocked");
        assert!(blocked.blockers.iter().any(|b| b.kind == "off-base"));
        assert_eq!(
            probe_runs(),
            before,
            "the expensive half is skipped when its answer would not be shown"
        );

        // Clearing the blocker makes the conflicts appear on the next compose.
        git(repo, &["switch", "-q", "main"]);
        let conflicted = compose(repo);
        assert_eq!(conflicted.phase, "conflicted");
        assert!(!conflicted.conflicts.is_empty());
        assert!(probe_runs() > before, "and the probe runs then");
    }

    /// The verification verdict rides the join block while it describes these
    /// two heads, and is **cleared** the moment either moves.
    ///
    /// Withholding a stale verdict would not be enough. It is a green about a
    /// tree nobody built, and something else reading it back later — a face
    /// after a reload, a gate — would believe it. The board drops it for the
    /// same reason it drops a stale candidate.
    #[test]
    fn a_verdict_rides_the_join_block_until_a_head_moves() {
        let temp = fixture();
        let repo = temp.path();

        // Resolve to a candidate the verdict can describe.
        let resolved = tugdash_core::resolve::resolve_conflicts(repo, "demo", None).unwrap();
        let candidate = resolved
            .candidate_commit
            .expect("the stub driver resolves it");
        let base_sha = ops::rev_parse(repo, "main").unwrap();

        verify::write_verification(
            repo,
            "demo",
            &verify::Verification {
                base_sha: base_sha.clone(),
                candidate_sha: candidate.clone(),
                tier0: verify::TierStatus::Green,
                tier1: verify::TierStatus::Red,
                failures: vec!["just app-test x.test.ts: 1 file failed".to_string()],
                notes: vec!["1 test skipped as @foreground".to_string()],
            },
        )
        .unwrap();

        let state = compose(repo);
        let v = state.verification.expect("the verdict rides the block");
        assert_eq!(v.tier0, "green");
        assert_eq!(v.tier1, "red");
        assert_eq!(v.failures.len(), 1);
        assert_eq!(v.notes.len(), 1);
        assert_eq!(v.candidate_sha, candidate);

        // Move the base. The candidate goes stale, and so does the verdict.
        std::fs::write(repo.join("other.txt"), "moved\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base moves"]);

        let after = compose(repo);
        assert!(
            after.verification.is_none(),
            "a verdict about the old heads must not survive"
        );
        assert!(
            verify::read_verification(repo, "demo").is_none(),
            "and it is cleared, not merely withheld"
        );
    }
}
