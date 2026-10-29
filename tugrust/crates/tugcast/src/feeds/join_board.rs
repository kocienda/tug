//! Eager join facts for the arc feed entries ([P01], [P04], Spec S03).
//!
//! Every arc entry the changeset feed composes carries the join pipeline's
//! entire durable state, computed here. The client holds no durable copy: it
//! renders what this says.
//!
//! # What is cached, and what is deliberately not
//!
//! This split is the whole of this module, and getting it backwards would
//! rebuild the bug the feature exists to remove.
//!
//! **Cached, keyed by `(base_sha, arc_head_sha)`** — the `merge-tree` conflict
//! probe and the archaeology behind it. Each is
//! a pure function of those two commits, so a hit is sound and a miss costs one
//! probe per actual movement.
//!
//! **Never cached** — the blockers, and every ref and config read. Blockers
//! answer to working-tree dirt, to which branch the base checkout has out, and
//! to whether a teardown is under way; none of those move a SHA. A blocker set cached against
//! the two heads would keep refusing a join whose real answer changed the
//! moment the user cleaned their checkout — a face that lies, which is exactly
//! what this whole seam was built to stop.
//!
//! The expensive half is also skipped when it would not be shown: while
//! blockers stand, the state is `blocked` and no conflict list is rendered, so
//! the probe does not run at all.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tugcore::instance::Paths;

use tugarc_core::ops::{self, ArcDetail};
use tugcast_core::types::{
    ArcConflictCommit, ArcConflictHistory, ArcJoinAttention, ArcJoinBlocker, ArcJoinOffer,
    ArcJoinState, ArcResolvedBase,
};

/// The cacheable half of one arc's join facts, and the head pair it describes.
#[derive(Clone)]
struct CachedProbe {
    base_sha: String,
    arc_sha: String,
    conflicts: Vec<String>,
    archaeology: Vec<ArcConflictHistory>,
}

#[derive(Default)]
pub struct JoinBoard {
    by_arc: Mutex<HashMap<String, CachedProbe>>,
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

/// Drop cache entries for arcs that no longer exist.
pub fn sweep(live_owner_keys: &[String]) {
    let board = board();
    let mut map = board.by_arc.lock();
    map.retain(|key, _| live_owner_keys.iter().any(|k| k == key));
}

/// Collect workshops whose arc is gone ([P07]).
///
/// `.tug/workshops/` is a directory of second checkouts with warm build outputs
/// in them, and until now nothing swept it: a workshop was removed by the arc
/// verbs that knew about it, and anything that slipped past them — a join that
/// tore one down while a straggling task re-created it, a discard that raced a
/// resolve — stayed on disk with its branch, forever, invisible to every
/// surface. This is the sweeper the directory never had.
///
/// Safe because occupancy is checked first: a workshop whose arc is gone but
/// whose name still holds a live run is left alone, and the run's own exit
/// takes it. Removing a checkout out from under a working resolver would turn
/// a leaked directory into a lost run.
pub fn sweep_workshops(repo_root: &Path, live_arcs: &[String]) {
    let live: Vec<String> = live_arcs
        .iter()
        .map(|name| tugarc_core::workshop::workshop_branch(name))
        .collect();

    for name in tugarc_core::workshop::existing(repo_root) {
        let branch = tugarc_core::workshop::workshop_branch(&name);
        if live.contains(&branch) {
            continue;
        }
        let owner_key = tugarc_core::ops::arc_owner_key(repo_root, &name);
        if crate::feeds::join_occupancy::run_kind(&owner_key).is_some() {
            continue;
        }
        // A join removes its own workshop as one phase of a recorded
        // teardown, and the arc leaves the feed's list before that teardown
        // finishes. Sweeping in that window would run a second `git worktree
        // remove`/`prune` in the same `.git/worktrees` as the one the join is
        // running. The open join record is the "a join owns this arc right
        // now" fact, and it outlives the arc's presence on the feed by design.
        if tugarc_core::ops::join_in_flight(&Paths::from_env(), repo_root, &name) {
            continue;
        }
        let mut warnings = Vec::new();
        tugarc_core::workshop::remove(repo_root, &name, &mut warnings);
        for warning in warnings {
            tracing::warn!(workshop = %name, %warning, "arc-join: orphaned workshop");
        }
        tracing::info!(workshop = %name, "arc-join: swept an orphaned workshop");
    }
}

/// Compose one arc's join state.
///
/// `current_branch` is read once per recompute by the caller and passed in,
/// rather than read once per arc: it is a property of the repository, not of
/// the arc, and the feed may be holding many.
///
/// `receipts` follows the same rule for the same reason — see
/// [`standing_resolve_receipts`], which is one eager walk of the op log and so
/// belongs to the recompute rather than to the arc.
///
/// **A ready arc's join is a squash and a land.** Readiness is derived from
/// the audited pair: an arc reads ready only while its audit stands on the
/// live base, so its fit was verified against exactly the tree the join
/// lands. There is no candidate to build and nothing to resolve at the join;
/// the offer stands whenever the arc is ready and nothing refuses or occupies
/// it.
pub fn join_state_for(
    repo_root: &Path,
    detail: &ArcDetail,
    current_branch: &str,
    live_dirt: &std::collections::BTreeMap<String, String>,
    receipts: &std::collections::BTreeMap<String, ArcResolvedBase>,
) -> ArcJoinState {
    // Uncached and uncacheable: what is running on this arc right now. The
    // registry is in-process, so this is the one fact here that answers to the
    // moment rather than to a pair of commits (Spec S01).
    let run_kind = crate::feeds::join_occupancy::run_kind(&detail.owner_key);
    let run = run_kind.map(|k| k.to_string());

    // Uncached, always: what would refuse a join right now.
    let blockers: Vec<ArcJoinBlocker> = ops::join_blockers_from_detail(
        &Paths::from_env(),
        repo_root,
        detail,
        current_branch,
        run_kind,
        live_dirt,
    )
    .into_iter()
    .map(|b| ArcJoinBlocker {
        kind: b.kind,
        title: b.title,
        detail: b.detail,
        paths: b.paths,
        remedy: b
            .remedy
            .map(|r| tugcast_core::types::ArcJoinRemedy { explain: r.explain }),
    })
    .collect();

    let name = detail.name.as_str();
    if !blockers.is_empty() {
        offer_receipt(detail, Some("blocked"));
        // The probe's answer would not be displayed, so it is not paid for.
        return ArcJoinState {
            phase: "blocked".to_string(),
            blockers,
            conflicts: Vec::new(),
            archaeology: Vec::new(),
            run,
            // A blocked arc has nothing to offer — it is waiting on an act,
            // elsewhere, that each blocker names.
            offer: None,
            attention: None,
            // Reported on this arm too: a fold that cleared one blocker and
            // left another standing still happened, and the receipt is how the
            // user checks what it did to their base.
            resolved_base: receipts.get(name).cloned(),
        };
    }

    let probe = cached_probe(repo_root, detail);
    let (conflicts, archaeology) = match probe {
        Some(p) => (p.conflicts, p.archaeology),
        None => (Vec::new(), Vec::new()),
    };
    let phase = if conflicts.is_empty() {
        "previewed"
    } else {
        "conflicted"
    };

    // The first reason the offer is withheld, named rather than folded into
    // one flag so the log can say which one held a ready arc's room shut. A
    // conflict on a ready arc is the base having moved past its audit faster
    // than the readiness read caught up; the re-audit answers it.
    let withheld = if run.is_some() {
        Some("run-held")
    } else if !conflicts.is_empty() {
        Some("conflicted")
    } else {
        None
    };
    let offer = standing_offer(repo_root, detail, withheld.is_none());
    let attention = offer.as_ref().map(|_| ArcJoinAttention {
        kind: "offer".to_string(),
        key: format!("{}:offer", detail.work_id),
    });
    offer_receipt(
        detail,
        match (&offer, withheld) {
            (Some(_), _) => None,
            (None, Some(reason)) => Some(reason),
            // Quiet, and still nothing: a head that would not read.
            (None, None) => Some("unreadable"),
        },
    );

    ArcJoinState {
        phase: phase.to_string(),
        blockers,
        conflicts,
        archaeology,
        run,
        offer,
        attention,
        resolved_base: receipts.get(name).cloned(),
    }
}
/// Every arc's standing fold receipt, from one walk of the op log.
///
/// **One walk per recompute, not one per arc.** `list_ops` is eager — a git
/// subprocess for the refs, then every payload under `.tug/ops/` read and
/// parsed before it returns a `Vec` — so taking `.next()` off it saves
/// nothing, and `arc_entries` composes every arc in a loop. This is the same
/// rule [`join_state_for`]'s own docblock states for `current_branch`: a fact
/// that is a property of the repository rather than of the arc is read once by
/// the caller and handed in.
///
/// **The newest op an arc has wins, whatever it is.** Not the newest *fold* —
/// that would keep answering with a fold a later join or discard has already
/// made irrelevant, and a receipt naming a commit on a base the arc has since
/// landed onto is worse than no receipt at all. So the walk records each arc's
/// newest op once and never looks further back for it, keeping the entry only
/// when that op is a completed, un-undone `ResolveBase`.
pub fn standing_resolve_receipts(
    repo_root: &Path,
) -> std::collections::BTreeMap<String, ArcResolvedBase> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut receipts = std::collections::BTreeMap::new();
    // Newest first, which is what makes "the first op for an arc" its newest.
    for op in tugarc_core::oplog::list_ops(&Paths::from_env(), repo_root) {
        // An undo and a redo are records *about* another op rather than acts on
        // the arc's own account, and the `undone_by` link they set is what this
        // reads instead — so they are stepped over rather than taken for the
        // arc's newest word.
        if matches!(
            op.verb,
            tugarc_core::oplog::OpVerb::Undo | tugarc_core::oplog::OpVerb::Redo
        ) {
            continue;
        }
        if !seen.insert(op.arc.clone()) {
            continue;
        }
        if op.verb != tugarc_core::oplog::OpVerb::ResolveBase || op.undone_by.is_some() {
            continue;
        }
        let Some(after) = op.after else { continue };
        receipts.insert(
            op.arc,
            ArcResolvedBase {
                seq: op.seq,
                // A fold that only dropped copies the arc already carried made
                // no commit, and says so by having none.
                commit: if after.folded.is_empty() {
                    None
                } else {
                    after.base_tip.clone()
                },
                base: op.before.base_branch.clone(),
                folded: after.folded,
                dropped: after.dropped,
                folded_from: after.folded_from,
            },
        );
    }
    receipts
}

/// What was last said about each ready arc's offer, so it is said once per
/// change ([B05]).
///
/// The feed recomposes on every movement anywhere in the workspace, so a line
/// per recompute would bury the one that matters. A line per *change* is the
/// log a person reads after "the shade did not reveal": which reason held the
/// offer, and when it stopped holding.
#[derive(Default)]
pub(crate) struct SaidOnce {
    last: HashMap<String, &'static str>,
}

impl SaidOnce {
    /// Record `word` for `key`; true when it differs from what was last said.
    /// `None` forgets the key, so the next word is said whatever it is.
    pub(crate) fn say(&mut self, key: &str, word: Option<&'static str>) -> bool {
        match word {
            None => {
                self.last.remove(key);
                false
            }
            Some(word) => self.last.insert(key.to_string(), word) != Some(word),
        }
    }
}

fn said_once() -> &'static Mutex<SaidOnce> {
    static SAID: OnceLock<Mutex<SaidOnce>> = OnceLock::new();
    SAID.get_or_init(|| Mutex::new(SaidOnce::default()))
}

/// Log why a ready arc's offer stands or is withheld, once per change.
///
/// Only a ready arc is spoken of: one still being worked has no offer to
/// withhold. `withheld` is `None` when the offer stands.
fn offer_receipt(detail: &ArcDetail, withheld: Option<&'static str>) {
    let key = format!("offer:{}", detail.owner_key);
    let word = detail.join_ready.then_some(withheld.unwrap_or("offered"));
    if !said_once().lock().say(&key, word) {
        return;
    }
    match withheld {
        None => tracing::info!(arc = %detail.name, verdict = "offered", "offer-receipt"),
        Some(reason) => {
            tracing::info!(arc = %detail.name, verdict = "withheld", reason, "offer-receipt")
        }
    }
}

/// The join this arc is ready for, if it is ready for one.
///
/// Everything this reads is already computed by the caller, with one exception:
/// the two head shas, which cost a `rev-parse` each. They are paid for only in
/// the narrow branch that is actually going to offer — an arc that is
/// join-ready, with nothing running and nothing else standing in the way —
/// and `cached_probe` has already paid the same two on the path that reaches
/// here, so in practice the answers are warm.
///
/// **Readiness is the whole gate.** A ready arc's audit verified the fit of
/// exactly the tree the join lands, so a ready arc is an offer, immediately,
/// with no build between the user and the decision.
///
/// **There is no dismissal gate, and that is the design.** The offer is a
/// standing fact about the arc, not an ask somebody can decline: the surface
/// that renders it is the Changes shade, which the user closes for free and
/// reopens at will. A durable mark recording that a dialog had been dismissed
/// only ever existed to stop a modal from re-raising itself, and a surface that
/// never raises itself uninvited needs no such record.
fn standing_offer(repo_root: &Path, detail: &ArcDetail, quiet: bool) -> Option<ArcJoinOffer> {
    // The arc's decision belongs at the end of the arc. An arc that has not
    // finished the work somebody asked it for is still being worked, and there
    // is nothing to decide about. Readiness is derived rather than declared
    // ([D147]) — see `join_pilot`'s module docstring for why the `built` mark
    // stopped being the gate.
    if !detail.join_ready || !quiet {
        return None;
    }
    let name = detail.name.as_str();
    let arc_head = ops::rev_parse(repo_root, &detail.branch).ok()?;
    let base_sha = ops::rev_parse(repo_root, &detail.base).ok()?;
    // What the join would land with, read on the offer branch only — one config
    // read and one draft lookup, paid where a person is about to be shown the
    // answer.
    let (message, message_source) =
        ops::landing_message_preview(&Paths::from_env(), repo_root, name, &detail.branch);
    Some(ArcJoinOffer {
        // The three facts the offer is about, joined. Stable across recomputes
        // because every one of them is, and distinct the moment any of them
        // moves — including a base-motion replay, which rewrites the head. A
        // surface that reveals once per piece of work keys on `work_id` instead.
        request_id: format!("{name}:{base_sha}:{arc_head}"),
        base_sha,
        arc_head,
        // What a surface keys "already shown" on. The three facts above all
        // move when a replay rewrites the rounds onto a new base; this does not.
        work_id: detail.work_id.clone(),
        message,
        message_source: message_source.as_str().to_string(),
    })
}

/// The conflict probe, from cache when the head pair is unmoved.
fn cached_probe(repo_root: &Path, detail: &ArcDetail) -> Option<CachedProbe> {
    let key = detail.owner_key.clone();
    let board = board();

    // A cheap pair of reads decides whether the expensive probe is needed.
    let base_sha = ops::rev_parse(repo_root, &detail.base).ok()?;
    let arc_sha = ops::rev_parse(repo_root, &detail.branch).ok()?;

    {
        let map = board.by_arc.lock();
        if let Some(hit) = map.get(&key) {
            if hit.base_sha == base_sha && hit.arc_sha == arc_sha {
                return Some(hit.clone());
            }
        }
    }

    PROBE_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let probed = ops::join_conflicts_in(repo_root, &detail.name).ok()?;
    let fresh = CachedProbe {
        base_sha: probed.base_sha,
        arc_sha: probed.arc_sha,
        conflicts: probed.conflicts,
        archaeology: probed
            .archaeology
            .into_iter()
            .map(|h| ArcConflictHistory {
                path: h.path,
                commits: h
                    .commits
                    .into_iter()
                    .map(|c| ArcConflictCommit {
                        sha: c.sha,
                        subject: c.subject,
                    })
                    .collect(),
                total: h.total,
            })
            .collect(),
    };
    board.by_arc.lock().insert(key, fresh.clone());
    Some(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    use tugcore::test_fixtures::git::{GitFixture, git};

    /// A repo on `main` with a conflicting arc, and a stub merge driver for the
    /// core ladder a join or a test may still run.
    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        GitFixture::init(repo);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugarc/demo"]);
        git(repo, &["config", "branch.tugarc/demo.tugbase", "main"]);
        git(repo, &["switch", "-q", "tugarc/demo"]);
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
            &["config", "tugarc.mergedriver", &stub.to_string_lossy()],
        );
        temp
    }

    /// A reason is said when it changes and not on the recomputes between;
    /// forgetting a key lets the next word be said whatever it is.
    #[test]
    fn a_withheld_reason_is_said_once_per_change() {
        let mut said = SaidOnce::default();
        assert!(
            said.say("offer:a", Some("conflicted")),
            "the first word is said"
        );
        assert!(
            !said.say("offer:a", Some("conflicted")),
            "a recompute is not a change"
        );
        assert!(
            said.say("offer:a", Some("offered")),
            "the offer standing is"
        );
        assert!(
            said.say("offer:b", Some("offered")),
            "each arc keeps its own"
        );
        assert!(!said.say("offer:a", None), "forgetting says nothing");
        assert!(
            said.say("offer:a", Some("offered")),
            "and the next word is said again"
        );
    }

    fn detail_for(repo: &Path) -> ArcDetail {
        ops::arc_detail_entry_in(&Paths::from_env(), repo, "demo").expect("detail")
    }

    fn compose(repo: &Path) -> ArcJoinState {
        let detail = detail_for(repo);
        let branch = ops::current_branch(repo).unwrap();
        join_state_for(
            repo,
            &detail,
            &branch,
            &std::collections::BTreeMap::new(),
            &standing_resolve_receipts(repo),
        )
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

        // Now dirty the base over a path the arc also changes. NO sha moves —
        // and the blockers must change anyway. This is the exact case a
        // blocker cache keyed by the head pair would get wrong.
        let heads = |r: &Path| {
            (
                ops::rev_parse(r, "main").unwrap(),
                ops::rev_parse(r, "tugarc/demo").unwrap(),
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
            "a blocked arc shows no conflict list"
        );

        // Cleaning it clears the blocker, again with no sha movement.
        git(repo, &["checkout", "--", "f.txt"]);
        let cleared = compose(repo);
        assert_eq!(pinned, heads(repo), "still no sha moved");
        assert!(cleared.blockers.is_empty(), "the refusal lifts");
        assert_eq!(cleared.phase, "conflicted");
    }

    #[test]
    fn a_blocked_arc_never_pays_for_the_probe() {
        let temp = fixture();
        let repo = temp.path();

        // Block it before anything has been probed for this arc.
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

    /// A workshop whose arc is gone is collected; one with a live run is not
    /// ([P07]).
    ///
    /// Nothing swept `.tug/workshops/` before this. A workshop was torn down by
    /// the arc verbs that knew about it, and anything that slipped past them
    /// — a join racing a straggling task, a discard racing a resolve — stayed
    /// on disk with its branch forever, invisible to every surface.
    #[test]
    fn an_orphaned_workshop_is_swept_and_an_occupied_one_is_not() {
        let temp = fixture();
        let repo = temp.path();

        tugarc_core::workshop::Workshop::open_existing(repo, "demo").expect("a live arc");
        let workshop = tugarc_core::workshop::workshop_path(repo, "demo");
        assert!(workshop.exists());

        // Still live: the sweep leaves it alone, which is the whole reason the
        // workshop is stable in the first place.
        sweep_workshops(repo, &["demo".to_string()]);
        assert!(workshop.exists(), "a live arc keeps its workshop");

        // The arc goes, and the workshop is left behind — the leak.
        git(repo, &["branch", "-D", "tugarc/demo"]);

        // But a run still holds it, so it is not the sweeper's to take:
        // removing a checkout out from under a working resolver would turn a
        // leaked directory into a lost run.
        let owner_key = tugarc_core::ops::arc_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
        )
        .expect("the arc is free");
        sweep_workshops(repo, &[]);
        assert!(workshop.exists(), "an occupied workshop survives its arc");

        drop(held);
        sweep_workshops(repo, &[]);
        assert!(!workshop.exists(), "released, the orphan is collected");
        assert!(
            !tugarc_core::workshop::existing(repo)
                .iter()
                .any(|n| n == "demo"),
            "branch and directory both"
        );
    }

    // ── The join offer ──────────────────────────────────────────────────────

    /// Clear the fixture's conflict — the base takes the arc's side of
    /// `f.txt` — so the arc is a ready arc with a clean merge, the only state
    /// it offers a join in.
    ///
    /// **Nothing is declared here.** The arc is a plan-less generation with a
    /// landed round and a clean worktree, which is the whole arming fact. The
    /// arc log lives under the data dir, so it is redirected here; nextest
    /// runs one process per test, which is what makes that safe.
    fn reconciled(repo: &Path) {
        let data = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        // SAFETY: single-threaded setup, and this process runs one test.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", data.path());
        }
        std::fs::write(repo.join("f.txt"), "B\n").unwrap();
        git(
            repo,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-am",
                "main takes the arc's side",
            ],
        );
    }
    #[test]
    fn the_offer_arrives_once_the_machine_is_out_of_work_and_not_before() {
        let temp = fixture();
        let repo = temp.path();

        // Conflicted: the base moved past the arc, so there is nothing to
        // offer.
        assert!(
            compose(repo).offer.is_none(),
            "a conflicted arc offers nothing: its audit has not seen this base"
        );

        reconciled(repo);
        let offer = compose(repo)
            .offer
            .expect("a clean ready arc offers its join");

        // Stable across recomputes. The offer is re-derived every time, so an
        // id that moved would re-summon the shade on every recompute.
        assert_eq!(
            compose(repo).offer.expect("still offered").request_id,
            offer.request_id,
            "the same offer, re-derived"
        );
    }

    /// New work mints a new offer and a new work id; a base move keeps the id.
    ///
    /// The work id is what a surface reveals itself once per, so a base move
    /// must not move it — the same work reconciled again is the same work —
    /// while a round the user has never seen must. That a replay of the rounds
    /// keeps it too is `replay`'s own test, over the real replay.
    #[test]
    fn a_new_round_mints_a_new_offer_and_a_base_move_does_not() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        let first = compose(repo).offer.expect("offered once");
        assert_eq!(
            first.work_id,
            detail_for(repo).work_id,
            "the offer carries the arc's own work id"
        );

        // The base moves and the arc reconciles again. The base sha is part
        // of the identity, so this is a distinct offer — but it describes the
        // same arc head, which is the fact a surface keys its "same work"
        // reading on.
        std::fs::write(repo.join("f.txt"), "D\n").unwrap();
        git(repo, &["commit", "-am", "main to D"]);
        reconciled(repo);
        let moved = compose(repo).offer.expect("still offered");
        assert_eq!(
            moved.arc_head, first.arc_head,
            "a push to the base is not new work on the arc"
        );
        assert_eq!(moved.work_id, first.work_id, "nor does it move the work id");

        // A new round is.
        git(repo, &["switch", "-q", "tugarc/demo"]);
        std::fs::write(repo.join("g.txt"), "r2\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "r2"]);
        git(repo, &["switch", "-q", "main"]);
        reconciled(repo);
        let again = compose(repo).offer.expect("a new round offers again");
        assert_ne!(again.arc_head, first.arc_head);
        assert_ne!(again.work_id, first.work_id, "a new round is new work");
        assert_ne!(
            again.request_id, first.request_id,
            "new work is a new offer, so a surface that has already shown the \
             old one shows this one too"
        );
    }

    #[test]
    fn a_run_in_flight_holds_the_offer() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        assert!(
            compose(repo).offer.is_some(),
            "precondition: it would offer"
        );

        let owner_key = ops::arc_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
        )
        .expect("the arc is free");
        assert!(
            compose(repo).offer.is_none(),
            "an arc with work in flight has nothing settled to offer"
        );
        drop(held);
        assert!(compose(repo).offer.is_some(), "and offers again once it is");
    }

    /// The attention fact is the offer's: a ready arc whose offer stands needs
    /// the user, under a key that names the work; a conflicted arc and an arc
    /// with a run in flight need nobody.
    #[test]
    fn attention_follows_the_offer() {
        let temp = fixture();
        let repo = temp.path();
        assert!(
            compose(repo).attention.is_none(),
            "a conflicted arc offers nothing, so needs nobody"
        );

        reconciled(repo);
        let work = detail_for(repo).work_id.clone();
        let offered = compose(repo).attention.expect("an offer is attention");
        assert_eq!(offered.kind, "offer");
        assert_eq!(offered.key, format!("{work}:offer"));
        assert_eq!(
            compose(repo).attention.expect("still").key,
            offered.key,
            "re-derived, the same key"
        );

        let owner_key = ops::arc_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
        )
        .expect("the arc is free");
        assert!(
            compose(repo).attention.is_none(),
            "a machine still working needs nobody"
        );
        drop(held);
    }

    /// Redirect the arc state dir at a scratch path, so a tempdir repo's ops
    /// are never written into the developer's own data directory.
    ///
    /// nextest runs one process per test, which is what makes the process-wide
    /// set safe.
    fn redirect_state(temp: &tempfile::TempDir) {
        // SAFETY: single-threaded setup, and this process runs one test.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", temp.path().join("state"));
        }
    }

    /// A fold stands as a receipt until something retires it.
    ///
    /// The receipt is durable by construction — it *is* the op — so what this
    /// pins is the reading: the entry carries what the fold did, and the entry
    /// stops carrying it the moment the op is reversed. Nothing has to remember
    /// to take it down, which is the property a receipt on a live surface has
    /// to have.
    #[test]
    fn a_fold_stands_as_a_receipt_until_it_is_undone() {
        let temp = fixture();
        let repo = temp.path();
        redirect_state(&temp);
        // The overlap a fold exists to clear: the user's own divergent work on
        // a path the arc also changed.
        std::fs::write(repo.join("f.txt"), "C\nmy own edit\n").unwrap();
        assert!(
            compose(repo).resolved_base.is_none(),
            "precondition: no fold has happened"
        );

        let outcome = ops::resolve_base_in(
            &Paths::from_env(),
            repo,
            "demo",
            &std::collections::BTreeMap::new(),
        )
        .expect("the fold runs");
        assert_eq!(outcome.folded, vec!["f.txt".to_string()]);

        let receipt = compose(repo).resolved_base.expect("the receipt stands");
        assert_eq!(
            receipt.commit.as_deref(),
            Some(ops::rev_parse(repo, "main").unwrap().as_str()),
            "it names the commit the fold made"
        );
        assert_eq!(receipt.base, "main");
        assert_eq!(receipt.folded, vec!["f.txt".to_string()]);

        tugarc_core::oplog::undo_in(&Paths::from_env(), repo, Some("demo")).expect("undo");
        assert!(
            compose(repo).resolved_base.is_none(),
            "a reversed fold is not a standing receipt"
        );
    }

    /// A join lands the arc, and the fold beneath it stops being news.
    ///
    /// This is the case the newest-op rule exists for. Looking for the newest
    /// *fold* would walk straight past the join to the fold under it and keep
    /// reporting a commit on a base the arc has since landed onto — a receipt
    /// that is worse than none, because it invites an Undo of an act the join
    /// has already built on.
    #[test]
    fn a_join_after_a_fold_retires_the_receipt() {
        let temp = fixture();
        let repo = temp.path();
        redirect_state(&temp);
        std::fs::write(repo.join("f.txt"), "C\nmy own edit\n").unwrap();
        ops::resolve_base_in(
            &Paths::from_env(),
            repo,
            "demo",
            &std::collections::BTreeMap::new(),
        )
        .expect("the fold runs");
        assert!(
            standing_resolve_receipts(repo).contains_key("demo"),
            "precondition: the fold is the newest thing that happened"
        );

        // The arc lands. Its fold is still in the log, and still un-undone.
        let candidate =
            tugarc_core::resolve::resolve_conflicts(&Paths::from_env(), repo, "demo", None)
                .expect("reconciled")
                .candidate_commit;
        let joined = ops::join_in(
            &Paths::from_env(),
            repo,
            "demo",
            ops::JoinOptions {
                preview: false,
                candidate,
                ..Default::default()
            },
        )
        .expect("joined");
        assert!(
            joined.blockers.is_empty(),
            "precondition: the join actually landed: {:?}",
            joined.blockers
        );

        assert!(
            !standing_resolve_receipts(repo).contains_key("demo"),
            "the newest op is the join, so the fold is no longer the arc's word"
        );
    }

    /// A fold in flight reads as `resolve-base` on the feed, beside the blocker
    /// it is clearing.
    ///
    /// Pinned where the entry is composed, because that is the one place the
    /// two facts meet: the register's fold sentence and the join store's
    /// acknowledgement both key on `run` naming the act while `blockers` still
    /// carries the `base-dirt` row. A hold nobody composes into the entry is a
    /// hold no surface can see.
    #[test]
    fn a_held_fold_reads_as_resolve_base_on_the_feed() {
        let temp = fixture();
        let repo = temp.path();
        // Dirty the base over a path the arc also changes — the situation a
        // fold exists to clear, and the one the press is made from.
        std::fs::write(repo.join("f.txt"), "C\nlocal edit\n").unwrap();
        let before = compose(repo);
        assert_eq!(before.phase, "blocked");
        assert_eq!(before.run, None, "precondition: nothing running");

        let owner_key = ops::arc_owner_key(repo, "demo");
        let held = crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
        )
        .expect("the arc is free");

        let running = compose(repo);
        assert_eq!(running.run.as_deref(), Some("resolve-base"));
        assert!(
            running.blockers.iter().any(|b| b.kind == "base-dirt"),
            "the blocker stands while the fold clearing it runs: {:?}",
            running.blockers
        );

        drop(held);
        assert_eq!(compose(repo).run, None, "and the fact goes with the hold");
    }

    /// The offer carries the words it would land, and says where they came
    /// from.
    ///
    /// The precedence is silent by construction — a forgotten draft lands the
    /// branch description and nobody is told — so the whole point of the pair
    /// of fields is that the surface can name the arm it fell through to.
    #[test]
    fn the_offer_carries_its_landing_message_and_names_the_source() {
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
        let bare = compose(repo).offer.expect("offered");
        assert_eq!(bare.message, "tugarc(demo): Arc work");
        assert_eq!(bare.message_source, "fallback");

        git(
            repo,
            &[
                "config",
                "branch.tugarc/demo.description",
                "Teach the imposer to breathe",
            ],
        );
        let described = compose(repo).offer.expect("offered");
        assert_eq!(
            described.message,
            "tugarc(demo): Teach the imposer to breathe"
        );
        assert_eq!(described.message_source, "description");

        // An authored draft outranks it — and the offer keeps its identity, so
        // editing the draft while the offer stands does not mint a new one and
        // re-summon the surface. What carries a mid-offer draft write this far
        // is the feed bump `draft_handler` fires: without it the composition
        // below is correct and never runs.
        seed_draft_row(&db, "tugarc/demo", repo, "The words the author chose");
        let drafted = compose(repo).offer.expect("offered");
        assert_eq!(drafted.message, "tugarc(demo): The words the author chose");
        assert_eq!(drafted.message_source, "draft");
        assert_eq!(
            drafted.request_id, described.request_id,
            "the message is display, not identity"
        );
    }

    /// Seed a draft row the way every writer bootstraps the table — keyed
    /// through the [L29] gateway, which is what `apply_draft_request` writes
    /// and what the draft lookup now probes.
    fn seed_draft_row(db: &Path, owner_id: &str, project: &Path, message: &str) {
        let project = tugcore::pathform::resolve_to_claude_form(project);
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
             VALUES ('arc', ?1, ?2, '', ?3, 0, 1)",
            rusqlite::params![owner_id, project.to_string_lossy(), message],
        )
        .unwrap();
    }
}
