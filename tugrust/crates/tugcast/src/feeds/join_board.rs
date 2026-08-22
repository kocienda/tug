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
    DashConflictCommit, DashConflictHistory, DashJoinBlocker, DashJoinPrompt, DashJoinPromptOption,
    DashJoinQuestion, DashJoinReport, DashJoinState, DashResolvedFile,
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

/// Collect workshops whose dash is gone ([P07]).
///
/// `.tug/workshops/` is a directory of second checkouts with warm build outputs
/// in them, and until now nothing swept it: a workshop was removed by the dash
/// verbs that knew about it, and anything that slipped past them — a join that
/// tore one down while a straggling task re-created it, a discard that raced a
/// resolve — stayed on disk with its branch, forever, invisible to every
/// surface. This is the sweeper the directory never had.
///
/// Safe because occupancy is checked first: a workshop whose dash is gone but
/// whose name still holds a live run is left alone, and the run's own exit
/// takes it. Removing a checkout out from under a working resolver would turn
/// a leaked directory into a lost run.
pub fn sweep_workshops(repo_root: &Path, live_dashes: &[String]) {
    let live: Vec<String> = live_dashes
        .iter()
        .map(|name| tugdash_core::workshop::workshop_branch(name))
        .collect();

    for name in tugdash_core::workshop::existing(repo_root) {
        let branch = tugdash_core::workshop::workshop_branch(&name);
        if live.contains(&branch) {
            continue;
        }
        let owner_key = tugdash_core::ops::dash_owner_key(repo_root, &name);
        if crate::feeds::join_occupancy::run_kind(&owner_key).is_some() {
            continue;
        }
        // A join removes its own workshop as one phase of a journaled
        // teardown, and the dash leaves the feed's list before that teardown
        // finishes. Sweeping in that window would run a second `git worktree
        // remove`/`prune` in the same `.git/worktrees` as the one the join is
        // running. The journal is the "a join owns this dash right now" fact,
        // and it outlives the dash's presence on the feed by design.
        if tugdash_core::ops::join_in_flight(repo_root, &name) {
            continue;
        }
        let mut warnings = Vec::new();
        tugdash_core::workshop::remove(repo_root, &name, &mut warnings);
        for warning in warnings {
            tracing::warn!(workshop = %name, %warning, "dash-join: orphaned workshop");
        }
        tracing::info!(workshop = %name, "dash-join: swept an orphaned workshop");
    }
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
    // Uncached and uncacheable: what is running on this dash right now. The
    // registry is in-process, so this is the one fact here that answers to the
    // moment rather than to a pair of commits (Spec S01).
    let run = crate::feeds::join_occupancy::run_kind(&detail.owner_key).map(|k| k.to_string());

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
            // Reported either way, but only *cleared* between runs. Clearing it
            // mid-resolve pulls the candidate out from under the run that is
            // building on it, and the sentence that surfaces — "the build
            // verdict went missing before the exam" — names none of the real
            // cause. A base that genuinely moved during a run demotes the
            // candidate on the next recompute instead: the ordinary staleness
            // path, at the ordinary time.
            if run.is_none() {
                resolve::clear_candidate(repo_root, name);
            }
            stale_note = Some(note);
        }
        CandidateStatus::None => {}
    }

    if !blockers.is_empty() {
        // The question is read before the stuck line, always: an orphaned
        // question *becomes* a stuck line, and reading the two the other way
        // round would withhold the conversion until the next recompute.
        let question = standing_question(repo_root, detail);
        let stuck = standing_stuck(repo_root, detail);
        // The probe's answer would not be displayed, so it is not paid for.
        return DashJoinState {
            phase: "blocked".to_string(),
            blockers,
            conflicts: Vec::new(),
            archaeology: Vec::new(),
            candidate,
            resolved: Vec::new(),
            stale_note,
            report: None,
            stuck,
            question,
            run,
            // A blocked dash is not waiting on a decision — it is waiting on an
            // act, elsewhere, that each blocker names.
            prompt: None,
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

    let report = candidate
        .as_deref()
        .and_then(|sha| standing_report(repo_root, name, sha));
    let question = standing_question(repo_root, detail);
    let stuck = standing_stuck(repo_root, detail);
    let prompt = standing_prompt(
        repo_root,
        detail,
        candidate.is_some() && run.is_none() && question.is_none() && stuck.is_none(),
    );

    DashJoinState {
        phase: phase.to_string(),
        blockers,
        conflicts,
        archaeology,
        candidate,
        resolved,
        stale_note,
        report,
        stuck,
        question,
        run,
        prompt,
    }
}

/// The three answers the prompt offers ([P06]).
///
/// Composed here rather than in the deck so the durable fact and the rendered
/// one are the same bytes — the same reason the landing receipt is
/// server-formatted. A label that drifted between the two would make an answer
/// unmatchable against the ask it came from.
fn prompt_options() -> Vec<DashJoinPromptOption> {
    vec![
        DashJoinPromptOption {
            label: "Join now".to_string(),
            description: "Squash the dash into its base with its standing message.".to_string(),
        },
        DashJoinPromptOption {
            label: "Review first".to_string(),
            description: "Open the join message in the composer without landing.".to_string(),
        },
        DashJoinPromptOption {
            label: "Not yet".to_string(),
            description: "Leave the dash where it is. You will be asked again only if the \
                          decision changes."
                .to_string(),
        },
    ]
}

/// The decision the arc is waiting on a person for, if it is waiting on one
/// (Spec S04, [P06], [P07]).
///
/// Everything this reads is already computed by the caller, with one exception:
/// the two head shas, which cost a `rev-parse` each. They are paid for only in
/// the narrow branch that is actually going to ask — a dash that is join-ready,
/// with a candidate, with nothing running and nothing else standing in the way
/// — and `cached_probe` has already paid the same two on the path that reaches
/// here, so in practice the answers are warm. The dash head is read one gate
/// earlier than the base sha, because the dismissal is keyed on it.
///
/// **Reconcile-clean is the whole gate.** The ask used to wait on a settled
/// verdict over the candidate's tree, which put a build between the user and
/// the dialog. The run's ending verifies the tree that lands, so a candidate
/// standing on a ready dash is a question, immediately.
///
/// **The re-ask policy is the last gate, deliberately** ([P07]). The prompt is
/// re-derived from durable state on every recompute, so what stops a dismissed
/// ask from reappearing on the very next one is the mark comparison here — and
/// it compares the *dash head*, which is what makes an ordinary base move
/// silent while a new round still interrupts. Declining the ask at one
/// milestone therefore says nothing about the next one.
fn standing_prompt(repo_root: &Path, detail: &DashDetail, quiet: bool) -> Option<DashJoinPrompt> {
    // The arc's decision belongs at the end of the arc. A dash that has not
    // finished the work somebody asked it for is still being worked, and there
    // is nothing to decide about. Readiness is derived rather than declared
    // ([D147]) — see `join_pilot`'s module docstring for why the `built` mark
    // stopped being the gate.
    if !detail.join_ready || !quiet {
        return None;
    }
    let name = detail.name.as_str();
    let dash_head = ops::rev_parse(repo_root, &detail.branch).ok()?;
    // The dismissal is about the dash head, so this is where a dismissed ask
    // stays dismissed — through any number of base moves — and where a new
    // round brings it back.
    if verify::read_prompt_mark(repo_root, name).as_deref() == Some(dash_head.as_str()) {
        return None;
    }
    let base_sha = ops::rev_parse(repo_root, &detail.base).ok()?;
    // Readiness and reconciliation, and nothing about a build: a dash arms from
    // a finished selection or a landed round, and what the joined tree does was
    // asked at the end of the run.
    let question = format!(
        "{name} is ready and reconciled with {} — join it?",
        detail.base
    );
    // What the join would land with, read on the ask branch only ([P05]) — one
    // config read and one draft lookup, paid where a person is about to be
    // shown the answer.
    let (message, message_source) = ops::landing_message_preview(repo_root, name, &detail.branch);
    Some(DashJoinPrompt {
        // The three facts the ask is about, joined. Stable across recomputes
        // because every one of them is, which is what lets an answer given
        // several seconds after the ask still match it — and distinct the
        // moment any of them moves, which is what stops an answer to the old
        // question from resolving the new one.
        request_id: format!("{name}:{base_sha}:{dash_head}"),
        base_sha,
        dash_head,
        question,
        message,
        message_source: message_source.as_str().to_string(),
        options: prompt_options(),
    })
}

/// The escalation a resolve is blocked on, while it still describes the dash
/// head it was raised against.
///
/// Read on every recompute rather than held in memory, because the whole point
/// of persisting it is that a reload — a fresh process, an empty memory — must
/// still render the question the resolver is waiting on.
/// A question with no live run is nobody's question — it is converted here
/// into a stuck line quoting what was asked, and the fact is dropped.
///
/// The registry is in-process, so a tugcast restart is exactly the event that
/// orphans a resolve *and* the event that empties the registry. That makes this
/// read the self-heal: the first recompute after a restart finds a question the
/// resolver that raised it can no longer be given, and says so. Left alone it
/// rendered as a live wizard whose answer the supervisor would refuse, which is
/// the [L31] silence in its purest form — a control that does nothing.
fn standing_question(repo_root: &Path, detail: &DashDetail) -> Option<DashJoinQuestion> {
    let name = detail.name.as_str();

    // A resolve that is still running owns its question, and matches it against
    // the head it started on: a round landing on the dash mid-question must not
    // vanish the wizard the user is answering.
    if let Some(head) = crate::feeds::join_occupancy::run_head(&detail.owner_key) {
        let json = resolve::read_question(repo_root, name, &head)?;
        return serde_json::from_str(&json).ok();
    }

    let head = ops::rev_parse(repo_root, &detail.branch).ok()?;
    let json = resolve::read_question(repo_root, name, &head)?;

    if crate::feeds::join_occupancy::run_kind(&detail.owner_key).is_none() {
        let asked = serde_json::from_str::<DashJoinQuestion>(&json)
            .map(|q| q.question)
            .unwrap_or_else(|_| "an intent question".to_string());
        resolve::clear_question(repo_root, name);
        resolve::write_stuck(
            repo_root,
            name,
            &head,
            &format!("tugcast restarted while the resolver waited on: {asked}"),
        );
        return None;
    }

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

    /// A question nobody is waiting on becomes a stuck line quoting what was
    /// asked, and the question fact is gone afterwards.
    ///
    /// This is the restart self-heal. A tugcast restart empties the occupancy
    /// registry and kills the resolver that raised the question — but the
    /// question is durable, so it kept rendering as a live wizard whose answer
    /// the supervisor would then refuse. A control that cannot do anything is
    /// the silence [L31] forbids; this converts it into a sentence.
    #[test]
    fn an_orphaned_question_becomes_a_stuck_line() {
        let temp = fixture();
        let repo = temp.path();
        let head = ops::rev_parse(repo, "tugdash/demo").unwrap();

        tugdash_core::resolve::write_question(
            repo,
            "demo",
            &head,
            r#"{"request_id":"join-demo-1","question":"Which side owns the timeout?","options":[{"label":"the dash","description":""},{"label":"the base","description":""}]}"#,
        );

        let state = compose(repo);
        assert!(
            state.question.is_none(),
            "no live run means no live question"
        );
        let stuck = state.stuck.expect("the question converted to a stuck line");
        assert!(stuck.contains("tugcast restarted"), "{stuck}");
        assert!(
            stuck.contains("Which side owns the timeout?"),
            "the stuck line quotes what was asked: {stuck}"
        );
        assert!(
            tugdash_core::resolve::read_question(repo, "demo", &head).is_none(),
            "the converted fact is gone, so this happens once"
        );
    }

    /// A question raised by a live run survives a round landing on the dash.
    ///
    /// The question is keyed by the head it was raised against, so without the
    /// run's own snapshot a mid-question dash commit makes the wizard vanish
    /// while the resolver is still waiting for its answer.
    #[test]
    fn a_live_runs_question_survives_the_dash_head_moving() {
        let temp = fixture();
        let repo = temp.path();
        let detail = detail_for(repo);
        let head = ops::rev_parse(repo, "tugdash/demo").unwrap();

        let _held = crate::feeds::join_occupancy::acquire(
            &detail.owner_key,
            crate::feeds::join_occupancy::JoinRunKind::Resolve,
            Some(head.clone()),
        )
        .expect("the dash is free");

        tugdash_core::resolve::write_question(
            repo,
            "demo",
            &head,
            r#"{"request_id":"join-demo-2","question":"Keep the new flag?","options":[{"label":"yes","description":""},{"label":"no","description":""}]}"#,
        );

        // A round lands on the dash while the resolver waits.
        git(repo, &["switch", "-q", "tugdash/demo"]);
        std::fs::write(repo.join("late.txt"), "another round\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "r2"]);
        git(repo, &["switch", "-q", "main"]);
        assert_ne!(ops::rev_parse(repo, "tugdash/demo").unwrap(), head);

        let state = compose(repo);
        let question = state.question.expect("the question the user is answering");
        assert_eq!(question.question, "Keep the new flag?");
        assert_eq!(state.run.as_deref(), Some("resolve"));
    }

    /// A candidate that went stale under a live run is reported, not cleared.
    ///
    /// Clearing it mid-run pulls the tree out from under the resolve that is
    /// building on it; the sentence that surfaced — "the build verdict went
    /// missing before the exam" — named none of the real cause. After the run
    /// releases, the ordinary demotion runs at the ordinary time.
    #[test]
    fn a_stale_candidate_is_pinned_while_a_run_holds_the_dash() {
        let temp = fixture();
        let repo = temp.path();
        let detail = detail_for(repo);

        tugdash_core::resolve::resolve_conflicts(repo, "demo", None).unwrap();
        assert!(compose(repo).candidate.is_some());

        // The base moves, which is what makes the candidate stale.
        std::fs::write(repo.join("other.txt"), "later\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "main moves on"]);

        let held = crate::feeds::join_occupancy::acquire(
            &detail.owner_key,
            crate::feeds::join_occupancy::JoinRunKind::Resolve,
            None,
        )
        .expect("the dash is free");

        let during = compose(repo);
        assert!(during.candidate.is_none(), "a stale candidate is not shown");
        assert!(during.stale_note.is_some(), "and the note says why");
        assert!(
            tugdash_core::resolve::read_candidate(repo, "demo").is_some(),
            "but the ref still stands under the live run"
        );

        drop(held);
        let after = compose(repo);
        assert!(after.stale_note.is_some());
        assert_eq!(
            tugdash_core::resolve::read_candidate(repo, "demo"),
            None,
            "released, the ordinary demotion collects it"
        );
    }

    /// A workshop whose dash is gone is collected; one with a live run is not
    /// ([P07]).
    ///
    /// Nothing swept `.tug/workshops/` before this. A workshop was torn down by
    /// the dash verbs that knew about it, and anything that slipped past them
    /// — a join racing a straggling task, a discard racing a resolve — stayed
    /// on disk with its branch forever, invisible to every surface.
    #[test]
    fn an_orphaned_workshop_is_swept_and_an_occupied_one_is_not() {
        let temp = fixture();
        let repo = temp.path();

        tugdash_core::workshop::Workshop::open_merge(repo, "demo").expect("a live dash");
        let workshop = tugdash_core::workshop::workshop_path(repo, "demo");
        assert!(workshop.exists());

        // Still live: the sweep leaves it alone, which is the whole reason the
        // workshop is stable in the first place.
        sweep_workshops(repo, &["demo".to_string()]);
        assert!(workshop.exists(), "a live dash keeps its workshop");

        // The dash goes, and the workshop is left behind — the leak.
        git(repo, &["branch", "-D", "tugdash/demo"]);

        // But a run still holds it, so it is not the sweeper's to take:
        // removing a checkout out from under a working resolver would turn a
        // leaked directory into a lost run.
        let owner_key = tugdash_core::ops::dash_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::Resolve,
            None,
        )
        .expect("the dash is free");
        sweep_workshops(repo, &[]);
        assert!(workshop.exists(), "an occupied workshop survives its dash");

        drop(held);
        sweep_workshops(repo, &[]);
        assert!(!workshop.exists(), "released, the orphan is collected");
        assert!(
            !tugdash_core::workshop::existing(repo)
                .iter()
                .any(|n| n == "demo"),
            "branch and directory both"
        );
    }

    // ── The join prompt (Spec S04, [P06], [P07]) ────────────────────────────

    /// Take the fixture's dash all the way to a settled verdict — the only
    /// state the arc asks a question in.
    ///
    /// **Nothing is declared here.** The dash is a plan-less generation with a
    /// landed round and a clean worktree, which is the whole arming fact
    /// ([P02]) — this helper appended a `built` mark until [D147], and its
    /// removal is the Rust-level pin that the endgame no longer waits on a
    /// skill to say a word.
    ///
    /// The dash-log carries the stage and lives under the data dir, so it is
    /// redirected here. nextest runs one process per test, which is what makes
    /// that safe.
    fn reconciled(repo: &Path) -> String {
        let data = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        // SAFETY: single-threaded setup, and this process runs one test.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", data.path());
        }
        let outcome = tugdash_core::resolve::resolve_conflicts(repo, "demo", None).unwrap();
        outcome.candidate_commit.clone().expect("candidate")
    }

    #[test]
    fn the_prompt_arrives_once_the_machine_is_out_of_work_and_not_before() {
        let temp = fixture();
        let repo = temp.path();

        // Conflicted, nothing built: the machine still has work, so there is
        // nothing to decide about.
        assert!(
            compose(repo).prompt.is_none(),
            "a conflicted dash asks nothing"
        );

        reconciled(repo);
        let asked = compose(repo)
            .prompt
            .expect("a reconciled ready dash asks — with no mark anywhere");
        assert!(
            asked.question.contains("demo") && asked.question.contains("main"),
            "the question names the dash and its base: {}",
            asked.question
        );
        assert_eq!(
            asked.options.len(),
            3,
            "join now / review first / not yet — composed server-side so the \
             durable fact and the rendered one are the same bytes"
        );

        // Stable across recomputes. The prompt is re-derived every time, so an
        // id that moved would invalidate the answer the user is in the middle
        // of giving.
        assert_eq!(
            compose(repo).prompt.expect("still asked").request_id,
            asked.request_id,
            "the same ask, re-derived"
        );
    }

    /// The two cases the old decision-keyed mark collapsed into one: a base
    /// move is the same work reconciled again, and a new round is work the
    /// user has never been asked about ([P02]).
    #[test]
    fn a_dismissal_declines_one_head_not_the_dash() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        let asked = compose(repo).prompt.expect("asked once");

        // "Not yet" records the dash head it declined.
        verify::write_prompt_mark(repo, "demo", &asked.dash_head).unwrap();
        assert!(
            compose(repo).prompt.is_none(),
            "the same state does not ask twice — this is what stops the \
             dialog from being trained into a reflex"
        );

        // The base moves and the dash reconciles again. Nothing about the work
        // changed, so nothing is asked — the objection the old docstring
        // raised, still honored.
        std::fs::write(repo.join("f.txt"), "D\n").unwrap();
        git(repo, &["commit", "-am", "main to D"]);
        reconciled(repo);
        assert!(
            compose(repo).prompt.is_none(),
            "a push to the base is not a new question"
        );

        // A new round on the dash is. This is the milestone case the field
        // report found: declining at one milestone silenced every later one.
        git(repo, &["switch", "-q", "tugdash/demo"]);
        std::fs::write(repo.join("g.txt"), "r2\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "r2"]);
        git(repo, &["switch", "-q", "main"]);
        reconciled(repo);
        let again = compose(repo).prompt.expect("a new round asks again");
        assert_ne!(again.dash_head, asked.dash_head);
        assert_ne!(
            again.request_id, asked.request_id,
            "a different state is a different ask, so an answer to the old \
             one cannot resolve it"
        );

        // Engagement clears the mark, and the next state is fresh.
        verify::write_prompt_mark(repo, "demo", &again.dash_head).unwrap();
        assert!(compose(repo).prompt.is_none());
        verify::clear_prompt_mark(repo, "demo");
        assert!(compose(repo).prompt.is_some());
    }

    #[test]
    fn a_run_in_flight_holds_the_question() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        assert!(compose(repo).prompt.is_some(), "precondition: it would ask");

        let owner_key = ops::dash_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::Resolve,
            None,
        )
        .expect("the dash is free");
        assert!(
            compose(repo).prompt.is_none(),
            "a dash with work in flight is not waiting on a person"
        );
        drop(held);
        assert!(compose(repo).prompt.is_some(), "and asks again once it is");
    }

    /// The ask carries the words it would land, and says where they came from
    /// ([P05], Spec S03).
    ///
    /// The precedence is silent by construction — a forgotten draft lands the
    /// branch description and nobody is told — so the whole point of the pair
    /// of fields is that the prompt can name the arm it fell through to.
    #[test]
    fn the_ask_carries_its_landing_message_and_names_the_source() {
        let temp = fixture();
        let repo = temp.path();
        // `reconciled` redirects the data dir; the drafts ledger
        // goes with it, so nothing here reads the developer's own.
        reconciled(repo);
        let db = temp.path().join("changes.db");
        // SAFETY: single-threaded setup, and nextest runs one test per process.
        unsafe {
            std::env::set_var("TUG_CHANGES_DB", &db);
        }

        // Neither draft nor description: the stand-in, declared as one rather
        // than passed off as somebody's words.
        let bare = compose(repo).prompt.expect("asked");
        assert_eq!(bare.message, "tugdash(demo): Dash work");
        assert_eq!(bare.message_source, "fallback");

        git(
            repo,
            &[
                "config",
                "branch.tugdash/demo.description",
                "Teach the imposer to breathe",
            ],
        );
        let described = compose(repo).prompt.expect("asked");
        assert_eq!(
            described.message,
            "tugdash(demo): Teach the imposer to breathe"
        );
        assert_eq!(described.message_source, "description");

        // An authored draft outranks it — and the ask keeps its identity, so
        // editing the draft while the dialog stands cannot orphan the answer
        // the user is in the middle of giving.
        seed_draft_row(&db, "tugdash/demo", repo, "The words the author chose");
        let drafted = compose(repo).prompt.expect("asked");
        assert_eq!(drafted.message, "tugdash(demo): The words the author chose");
        assert_eq!(drafted.message_source, "draft");
        assert_eq!(
            drafted.request_id, described.request_id,
            "the message is display, not identity"
        );
    }

    /// Seed a draft row the way every writer bootstraps the table.
    fn seed_draft_row(db: &Path, owner_id: &str, project: &Path, message: &str) {
        let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
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
}
