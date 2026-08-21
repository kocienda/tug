//! The join pilot — the machine reconciles before it asks.
//!
//! A dash that has finished the work somebody asked it for wants machine work
//! before it can land: reconcile with a base that moved, and ask the project
//! whether the merged tree still builds. Both used to wait for the user to open
//! the Changes shade and press a button, which is the arc inverted — the person
//! came to land a finished dash and was handed a chore.
//!
//! # Finished is derived, never declared
//!
//! The trigger is `DashDetail.join_ready` — a fact `tugdash_core` derives from
//! the dash's own recorded telemetry: a declared step selection reaching its
//! final step, a plan-less round landing on a clean worktree, or a `built` /
//! `audited` mark ([D147]). It was once the `built` mark alone, and that made
//! the whole arc wait on a skill remembering a chore: a run that walked every
//! step, committed every round and wrote its draft still left the arc dark,
//! because nothing had *said* the word. Skills narrate; verbs record; the
//! server derives. `mark built` still arms — it is the hand-driven override and
//! the unblock for dashes older than the derivation — but nothing gates on it.
//!
//! This module is the predicate that decides whether a dash wants that work.
//! The dispatch that performs it lives beside the changeset recompute in
//! [`super::changeset`]; the split matters, and the two rules below are the
//! non-obvious parts a later reader will try to simplify away.
//!
//! # The predicate reads nothing it would have to fetch
//!
//! [`pilot_action`] is pure over facts the recompute already holds — the
//! derived readiness bool, whether any live session is bound to the dash, and
//! the `DashJoinState` the board just computed. That is deliberate: the caller
//! sits on a path that already does a blocking git walk, once per dash.
//! `DashDetail` carries no head sha, and
//! `resolve::candidate_status` returns early *before* its `rev-parse` calls
//! when no candidate ref exists — so asking the predicate about shas would cost
//! two new git subprocesses per dash per recompute, on exactly the dashes the
//! pilot most wants to act on.
//!
//! # The attempt mark is not the predicate's business
//!
//! The mark that stops a re-kick (`branch.tugdash/<name>.tugjoinpilot`, a
//! `<base_sha>:<dash_head>` pair) is read and written by the dispatch, under the
//! occupancy guard. Reading it here would be both expensive (above) and racy:
//! a mark checked on the recompute and acted on a scheduling hop later is a
//! time-of-check/time-of-use window that a second recompute walks straight
//! through, and two recomputes would produce two runs.
//!
//! # Why the two marks are keyed differently
//!
//! The pilot's attempt mark is keyed on the **head pair**: either head moving
//! is new work, so the mark stops matching and the pilot runs again. The
//! prompt's dismissal mark (`…tugjoinprompted`) is keyed on the **decision** —
//! `clean` or `red` — so a base move that reconciles to the same answer
//! re-reconciles silently and asks nothing. Merging them breaks both: keyed on
//! the pair, a dismissal would expire on every push to the base and the same
//! question would be asked forever; keyed on the decision, the pilot would
//! never re-run after the base moved. Both live in `tugdash_core::verify`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use async_trait::async_trait;

use tugcast_core::types::DashJoinState;

use super::join_occupancy::{self, JoinOccupancy, JoinRunKind};

/// What the pilot should do about a dash, when it should do anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PilotAction {
    /// Run the full resolution ladder — there is no candidate to check.
    Reconcile,
    /// A candidate stands but nobody has asked whether it builds.
    CheckTier0,
}

/// What the pilot should consider doing about this dash, if anything.
///
/// Pure over state the recompute already has — no shas, no marks, no I/O — for
/// the reasons in the module docstring. The rules are applied in order and the
/// first that matches wins:
///
/// 1. Not ready — the pilot acts on a finished selection, a plan-less round, or
///    a declared mark, and on nothing else.
/// 2. Unbound — the ask can only be raised on a card whose session is bound to
///    the dash, so an eager verdict on an unbound dash is spent on nobody.
///    This also bounds the cost: readiness is derived, so the population is
///    every dash with a landed round rather than the few somebody declared, and
///    Tier 0 is a full workspace build. Binding a card re-enters the dash on
///    the next recompute; `/join <name>` verifies on demand regardless.
/// 3. A run holds the dash — occupancy would refuse anyway.
/// 4. Blockers — a blocked dash needs an act that lives elsewhere.
/// 5. A standing question or stuck line — waiting on a person, or a refusal
///    already stated; either way the machine has said its piece.
/// 6. No candidate — reconcile.
/// 7. A candidate whose Tier 0 verdict is absent or `unrun` — check it.
/// 8. Otherwise nothing: the verdict stands, and the decision is the user's.
pub fn pilot_action(join_ready: bool, bound: bool, state: &DashJoinState) -> Option<PilotAction> {
    if !join_ready || !bound {
        return None;
    }
    if state.run.is_some() {
        return None;
    }
    if !state.blockers.is_empty() {
        return None;
    }
    if state.question.is_some() || state.stuck.is_some() {
        return None;
    }
    if state.candidate.is_none() {
        return Some(PilotAction::Reconcile);
    }
    match state.verification.as_ref() {
        None => Some(PilotAction::CheckTier0),
        Some(v) if v.tier0 == "unrun" => Some(PilotAction::CheckTier0),
        Some(_) => None,
    }
}

/// What actually performs a pilot action.
///
/// The recompute has no route back to the supervisor — it is a cache, and the
/// scribe context and the CONTROL sender live on the supervisor — so the
/// supervisor registers itself here once at startup. The same shape
/// [`super::join_occupancy`] uses, and for the same reason.
#[async_trait]
pub trait PilotRunner: Send + Sync {
    /// Run the full resolution ladder, exactly as a `changeset_join_resolve`
    /// press would.
    async fn reconcile(&self, project_dir: &str, dash: &str, occupancy: JoinOccupancy);
    /// Ask the project whether the candidate's tree builds.
    async fn check_tier0(&self, project_dir: &str, dash: &str, occupancy: JoinOccupancy);
}

static RUNNER: OnceLock<Box<dyn PilotRunner>> = OnceLock::new();

/// Install the pilot's runner. Called once, from startup.
///
/// A second call is ignored rather than fatal: two runners would be two
/// ladders, and the first one installed is the process's.
pub fn register_runner(runner: Box<dyn PilotRunner>) {
    let _ = RUNNER.set(runner);
}

/// Dispatch the pilot's work for one dash, off the recompute (Spec S06).
///
/// Returns immediately: the run happens on a spawned task so the changeset
/// frame goes out without waiting on a ladder that may take minutes.
pub fn dispatch(repo_root: &Path, dash: &str, action: PilotAction) {
    let Some(runner) = RUNNER.get() else {
        // No runner registered — a harness composing snapshots without a
        // supervisor. Nothing to do, and nothing wrong.
        return;
    };
    let repo_root = repo_root.to_path_buf();
    let dash = dash.to_string();
    tokio::spawn(async move {
        run_dispatch(runner.as_ref(), repo_root, dash, action).await;
    });
}

/// The dispatch's body — admission, the mark, then the work (Spec S06).
///
/// The order is the whole race argument. Occupancy comes first, so two
/// recomputes racing the same dash produce exactly one run. The head pair is
/// read and the mark compared *inside* that hold, which closes the
/// time-of-check/time-of-use window a recompute-side check would leave open.
/// And the mark is written **before** the run rather than after, so a crash
/// mid-ladder does not license a retry loop on the next restart.
async fn run_dispatch(
    runner: &dyn PilotRunner,
    repo_root: PathBuf,
    dash: String,
    action: PilotAction,
) {
    let owner_key = tugdash_core::ops::dash_owner_key(&repo_root, &dash);
    let kind = match action {
        PilotAction::Reconcile => JoinRunKind::Resolve,
        PilotAction::CheckTier0 => JoinRunKind::Verify,
    };

    let probe_root = repo_root.clone();
    let probe_dash = dash.clone();
    let heads = tokio::task::spawn_blocking(move || head_pair(&probe_root, &probe_dash)).await;
    let Ok(Some((head_pair, dash_head))) = heads else {
        tracing::debug!(dash = %dash, "join-pilot: no head pair; skipping");
        return;
    };

    let occupancy = match join_occupancy::acquire(&owner_key, kind, Some(dash_head)) {
        Ok(guard) => guard,
        Err(detail) => {
            // Busy is not an error: the next recompute reconsiders.
            tracing::debug!(dash = %dash, detail = %detail, "join-pilot: dash is busy");
            return;
        }
    };

    let mark_root = repo_root.clone();
    let mark_dash = dash.clone();
    let mark_pair = head_pair.clone();
    let claimed = tokio::task::spawn_blocking(move || {
        if tugdash_core::verify::read_pilot_mark(&mark_root, &mark_dash).as_deref()
            == Some(mark_pair.as_str())
        {
            return false;
        }
        // Written before the run, deliberately (Risk R01).
        let _ = tugdash_core::verify::write_pilot_mark(&mark_root, &mark_dash, &mark_pair);
        true
    })
    .await;

    if !matches!(claimed, Ok(true)) {
        return;
    }

    let project_dir = repo_root.to_string_lossy().to_string();
    tracing::info!(
        dash = %dash,
        action = ?action,
        head_pair = %head_pair,
        "join-pilot: running"
    );
    match action {
        PilotAction::Reconcile => runner.reconcile(&project_dir, &dash, occupancy).await,
        PilotAction::CheckTier0 => runner.check_tier0(&project_dir, &dash, occupancy).await,
    }
}

/// `(<base_sha>:<dash_head>, dash_head)` for a dash, or `None` when either side
/// will not resolve.
fn head_pair(repo_root: &Path, dash: &str) -> Option<(String, String)> {
    let detail = tugdash_core::ops::dash_detail_entry_in(repo_root, dash)?;
    let base = tugdash_core::ops::rev_parse(repo_root, &detail.base).ok()?;
    let head = tugdash_core::ops::rev_parse(repo_root, &detail.branch).ok()?;
    Some((format!("{base}:{head}"), head))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcast_core::types::{
        DashJoinBlocker, DashJoinQuestion, DashJoinState, DashJoinVerification,
    };

    /// A dash with nothing standing in the way and no candidate — the state a
    /// freshly built, conflicted dash arrives in.
    fn bare() -> DashJoinState {
        DashJoinState {
            phase: "conflicted".to_string(),
            blockers: Vec::new(),
            conflicts: Vec::new(),
            archaeology: Vec::new(),
            candidate: None,
            resolved: Vec::new(),
            stale_note: None,
            verification: None,
            report: None,
            stuck: None,
            question: None,
            run: None,
            override_for: None,
            prompt: None,
        }
    }

    fn verdict(tier0: &str) -> DashJoinVerification {
        DashJoinVerification {
            tier0: tier0.to_string(),
            tier1: "unrun".to_string(),
            failures: Vec::new(),
            notes: Vec::new(),
            base_sha: "base".to_string(),
            candidate_sha: "cand".to_string(),
        }
    }

    #[test]
    fn only_a_ready_bound_dash_is_piloted() {
        // A dash still being worked wants nothing from the pilot, whatever else
        // is true of it.
        let mut working = bare();
        working.candidate = Some("cand".to_string());
        for state in [bare(), working] {
            assert_eq!(pilot_action(false, true, &state), None);
        }
        // Ready but unbound: the ask can only be raised on a bound card, so an
        // eager Tier 0 here would spend a workspace build on nobody ([P08]).
        assert_eq!(
            pilot_action(true, false, &bare()),
            None,
            "an unbound dash is left alone"
        );
        assert_eq!(
            pilot_action(true, true, &bare()),
            Some(PilotAction::Reconcile),
            "ready with no candidate reconciles"
        );
    }

    #[test]
    fn a_held_dash_is_left_alone() {
        let mut state = bare();
        state.run = Some("resolve".to_string());
        assert_eq!(pilot_action(true, true, &state), None);
    }

    #[test]
    fn blockers_stop_the_pilot() {
        let mut state = bare();
        state.blockers.push(DashJoinBlocker {
            kind: "dirty-base".to_string(),
            detail: "commit or stash the base first".to_string(),
            paths: Vec::new(),
        });
        assert_eq!(pilot_action(true, true, &state), None);
    }

    #[test]
    fn a_question_or_a_stuck_line_stops_the_pilot() {
        let mut asked = bare();
        asked.question = Some(DashJoinQuestion {
            request_id: "r1".to_string(),
            question: "which side wins?".to_string(),
            options: Vec::new(),
        });
        assert_eq!(pilot_action(true, true, &asked), None, "waiting on a person");

        let mut stuck = bare();
        stuck.stuck = Some("the resolver exhausted its budget".to_string());
        assert_eq!(
            pilot_action(true, true, &stuck),
            None,
            "a refusal already stated is not re-attempted"
        );
    }

    #[test]
    fn a_candidate_with_no_verdict_is_checked() {
        let mut state = bare();
        state.candidate = Some("cand".to_string());
        state.phase = "resolved".to_string();
        assert_eq!(
            pilot_action(true, true, &state),
            Some(PilotAction::CheckTier0),
            "absent is not green"
        );

        state.verification = Some(verdict("unrun"));
        assert_eq!(pilot_action(true, true, &state), Some(PilotAction::CheckTier0));
    }

    // ── The dispatch (Spec S06) ──────────────────────────────────────────

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Counts what it was asked to do and drops the hold, which is the whole
    /// contract the dispatch has with a runner.
    struct CountingRunner {
        reconciles: Arc<AtomicUsize>,
        checks: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl PilotRunner for CountingRunner {
        async fn reconcile(&self, _project_dir: &str, _dash: &str, occupancy: JoinOccupancy) {
            drop(occupancy);
            self.reconciles.fetch_add(1, Ordering::SeqCst);
        }
        async fn check_tier0(&self, _project_dir: &str, _dash: &str, occupancy: JoinOccupancy) {
            drop(occupancy);
            self.checks.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// A repo with one commit on `main` and one `tugdash/<name>` branch — the
    /// shape `dash_detail_entry_in` reads a base and a head off.
    fn repo_with_dash(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        git_in(&root, &["init", "-b", "main"]);
        git_in(&root, &["config", "user.name", "t"]);
        git_in(&root, &["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git_in(&root, &["add", "-A"]);
        git_in(&root, &["commit", "-m", "base"]);
        git_in(&root, &["branch", &format!("tugdash/{name}")]);
        (dir, root)
    }

    fn counting() -> (CountingRunner, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let reconciles = Arc::new(AtomicUsize::new(0));
        let checks = Arc::new(AtomicUsize::new(0));
        (
            CountingRunner {
                reconciles: Arc::clone(&reconciles),
                checks: Arc::clone(&checks),
            },
            reconciles,
            checks,
        )
    }

    /// The mark is what stops the loop: the pilot's own run bumps the
    /// recompute, which re-derives the same predicate a moment later. Without
    /// the mark, a ladder that produces no candidate re-qualifies forever.
    #[tokio::test]
    async fn the_pilot_runs_once_per_head_pair() {
        let (_dir, root) = repo_with_dash("once");
        let (runner, reconciles, _checks) = counting();

        run_dispatch(
            &runner,
            root.clone(),
            "once".to_string(),
            PilotAction::Reconcile,
        )
        .await;
        assert_eq!(reconciles.load(Ordering::SeqCst), 1, "the first pass runs");

        run_dispatch(
            &runner,
            root.clone(),
            "once".to_string(),
            PilotAction::Reconcile,
        )
        .await;
        assert_eq!(
            reconciles.load(Ordering::SeqCst),
            1,
            "an unchanged head pair does not re-kick"
        );

        // A moved base is new work, so the mark stops matching.
        std::fs::write(root.join("a.txt"), "moved\n").unwrap();
        git_in(&root, &["add", "-A"]);
        git_in(&root, &["commit", "-m", "base moved"]);
        run_dispatch(
            &runner,
            root.clone(),
            "once".to_string(),
            PilotAction::Reconcile,
        )
        .await;
        assert_eq!(
            reconciles.load(Ordering::SeqCst),
            2,
            "either head moving is a fresh pair"
        );
    }

    /// A dash somebody else holds is left alone — busy is not an error, and
    /// the next recompute reconsiders.
    #[tokio::test]
    async fn a_busy_dash_is_not_dispatched() {
        let (_dir, root) = repo_with_dash("busy");
        let (runner, reconciles, _checks) = counting();

        let owner_key = tugdash_core::ops::dash_owner_key(&root, "busy");
        let held = join_occupancy::acquire(&owner_key, JoinRunKind::Resolve, None).unwrap();

        run_dispatch(
            &runner,
            root.clone(),
            "busy".to_string(),
            PilotAction::Reconcile,
        )
        .await;
        assert_eq!(reconciles.load(Ordering::SeqCst), 0);
        assert!(
            tugdash_core::verify::read_pilot_mark(&root, "busy").is_none(),
            "a dispatch that never ran must not claim the pair"
        );

        drop(held);
        run_dispatch(
            &runner,
            root.clone(),
            "busy".to_string(),
            PilotAction::Reconcile,
        )
        .await;
        assert_eq!(reconciles.load(Ordering::SeqCst), 1, "released, then run");
    }

    /// The mark is written **before** the run, not after.
    ///
    /// A run that dies mid-ladder — a panic, a killed process, a tugcast
    /// restart — must not license a retry on the same pair. Writing the mark
    /// afterwards would mean exactly that: the crash loop the mark exists to
    /// prevent, restarting every time the process does.
    #[tokio::test]
    async fn the_mark_is_claimed_before_the_run() {
        struct FailingRunner {
            saw_mark: Arc<std::sync::Mutex<Option<String>>>,
            root: PathBuf,
        }

        #[async_trait]
        impl PilotRunner for FailingRunner {
            async fn reconcile(&self, _project_dir: &str, dash: &str, occupancy: JoinOccupancy) {
                // What the mark says *while the run is in flight* is the fact
                // under test.
                *self.saw_mark.lock().unwrap() =
                    tugdash_core::verify::read_pilot_mark(&self.root, dash);
                drop(occupancy);
            }
            async fn check_tier0(&self, _project_dir: &str, _dash: &str, _occ: JoinOccupancy) {}
        }

        let (_dir, root) = repo_with_dash("crashy");
        let saw_mark = Arc::new(std::sync::Mutex::new(None));
        let runner = FailingRunner {
            saw_mark: Arc::clone(&saw_mark),
            root: root.clone(),
        };

        run_dispatch(
            &runner,
            root.clone(),
            "crashy".to_string(),
            PilotAction::Reconcile,
        )
        .await;

        let expected = head_pair(&root, "crashy").unwrap().0;
        assert_eq!(
            saw_mark.lock().unwrap().as_deref(),
            Some(expected.as_str()),
            "the pair is claimed before the ladder starts"
        );
    }

    #[test]
    fn a_settled_verdict_ends_the_pilots_work() {
        let mut state = bare();
        state.candidate = Some("cand".to_string());
        state.phase = "resolved".to_string();
        for tier0 in ["green", "red", "running"] {
            state.verification = Some(verdict(tier0));
            assert_eq!(
                pilot_action(true, true, &state),
                None,
                "tier0 {tier0} leaves the decision to the user"
            );
        }
    }
}
