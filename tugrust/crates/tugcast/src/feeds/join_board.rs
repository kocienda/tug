//! Eager join facts for the arc feed entries ([P01], [P04], Spec S03).
//!
//! Every arc entry the changeset feed composes carries the join pipeline's
//! entire durable state, computed here. The client holds no durable copy: it
//! renders what this says.
//!
//! # One authority for readiness
//!
//! The board reads readiness and runs no derivation of its own. Whether the
//! join is offered is `tugarc-core`'s `join_ready`, carried on the detail, and
//! what refuses it is `join_blockers_from_detail`, read live on every
//! recompute. A ready arc's audit verified the fit against exactly this base,
//! so there is no conflict probe here: a second, weaker answer to a settled
//! question would only be one more thing that could disagree with it. The
//! race between a base move and the next recompute is closed at press time,
//! where the join compares the audited pair before it lands.
//!
//! **Nothing here is cached.** Blockers answer to working-tree dirt, to which
//! branch the base checkout has out, and to whether a teardown is under way;
//! none of those move a SHA, so a blocker set cached against the two heads
//! would keep refusing a join whose real answer changed the moment the user
//! cleaned their checkout.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use tugcore::instance::Paths;

use tugarc_core::ops::{self, ArcDetail};
use tugcast_core::types::{
    ArcJoinAttention, ArcJoinBlocker, ArcJoinOffer, ArcJoinState, ArcResolvedBase,
};

/// The repositories this process has already swept for the retired join
/// pipeline's residue.
static RESIDUE_SWEPT: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> =
    OnceLock::new();

/// Collect what the retired join pipeline left in this repository — `tugjoin*`
/// keys on live arcs, join and conflict refs, workshop checkouts — once per
/// repository per process. A teardown forgets its own arc's residue; this is
/// for the live arcs no teardown will reach soon, and for the workshops of
/// arcs long gone.
pub fn sweep_residue_once(repo_root: &Path) {
    let swept = RESIDUE_SWEPT.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    if !swept.lock().insert(repo_root.to_path_buf()) {
        return;
    }
    for warning in tugarc_core::sweep_join_residue(repo_root) {
        tracing::warn!(repo = %repo_root.display(), %warning, "arc residue sweep");
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
    let mut blockers: Vec<ArcJoinBlocker> = ops::join_blockers_from_detail(
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
    if let Some(blocker) = replay_conflict_blocker(detail) {
        blockers.push(blocker);
    }
    if !blockers.is_empty() {
        offer_receipt(detail, Some("blocked"));
        // The probe's answer would not be displayed, so it is not paid for.
        return ArcJoinState {
            phase: "blocked".to_string(),
            blockers,
            conflicts: Vec::new(),
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

    // The first reason the offer is withheld, named rather than folded into
    // one flag so the log can say which one held the room shut. An arc the
    // derivation does not call ready is withheld here as well as by its
    // blocker, because a hand arc that is not ready carries no blocker.
    let withheld = if run.is_some() {
        Some("run-held")
    } else if !detail.join_ready {
        Some("not-ready")
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
        phase: "previewed".to_string(),
        blockers,
        // The audit verified the fit, so a standing offer has no conflicts to
        // show; the field stays on the wire for the join's own answer.
        conflicts: Vec::new(),
        run,
        offer,
        attention,
        resolved_base: receipts.get(name).cloned(),
    }
}

/// What refuses a hand arc whose last replay onto the base conflicted.
///
/// A Wheel arc needs nothing here: a conflicted replay seats its audit, so the
/// derivation already reads it not ready and the readiness blocker says why.
/// A hand arc has no audit to go stale, so before the board read the
/// derivation alone it would offer a join the press then failed with a
/// conflict. The engine knows the replay conflicted ([`conflict_paths_for`]),
/// and it clears the paths on the next clean replay, so the blocker stands
/// exactly as long as the conflict does.
///
/// [`conflict_paths_for`]: crate::feeds::base_motion::conflict_paths_for
fn replay_conflict_blocker(detail: &ArcDetail) -> Option<ArcJoinBlocker> {
    if detail.arc.is_some() {
        return None;
    }
    let paths = crate::feeds::base_motion::conflict_paths_for(&detail.owner_key);
    if paths.is_empty() {
        return None;
    }
    let (name, base) = (detail.name.as_str(), detail.base.as_str());
    let count = paths.len();
    let noun = if count == 1 { "path" } else { "paths" };
    Some(ArcJoinBlocker {
        kind: "conflicted".to_string(),
        title: "The arc conflicts with its base".to_string(),
        detail: format!(
            "Cannot join: arc '{name}' conflicts with '{base}' in {count} {noun}; replay it in its worktree with `tugtool arc replay {name}` and resolve them as a round."
        ),
        paths,
        remedy: None,
    })
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
/// join-ready, with nothing running and nothing else standing in the way.
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
    // ([D147]), and `quiet` already folds it in.
    if !quiet {
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
        temp
    }

    /// A reason is said when it changes and not on the recomputes between;
    /// forgetting a key lets the next word be said whatever it is.
    #[test]
    fn a_withheld_reason_is_said_once_per_change() {
        let mut said = SaidOnce::default();
        assert!(
            said.say("offer:a", Some("run-held")),
            "the first word is said"
        );
        assert!(
            !said.say("offer:a", Some("run-held")),
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
        compose_with(repo, &detail_for(repo))
    }

    fn compose_with(repo: &Path, detail: &ArcDetail) -> ArcJoinState {
        let branch = ops::current_branch(repo).unwrap();
        join_state_for(
            repo,
            detail,
            &branch,
            &std::collections::BTreeMap::new(),
            &standing_resolve_receipts(repo),
        )
    }

    /// The detail as the derivation would read it on an arc it does not call
    /// ready, whatever the fixture's own reading.
    fn not_ready(repo: &Path) -> ArcDetail {
        let mut detail = detail_for(repo);
        detail.join_ready = false;
        detail
    }

    /// The board shows the base as it is, with no conflict probe of its own:
    /// the fixture's arc and base disagree over `f.txt`, and the face says
    /// nothing about it, because the audit is what verified the fit.
    #[test]
    fn the_board_runs_no_conflict_probe() {
        let temp = fixture();
        let repo = temp.path();
        let state = compose(repo);
        assert_eq!(state.phase, "previewed");
        assert!(state.conflicts.is_empty(), "{:?}", state.conflicts);
    }

    /// A hand arc whose last replay conflicted is blocked, not offered: no
    /// audit stands over it to go stale, so the engine's conflict is the only
    /// thing that can keep the press from failing on it.
    #[test]
    fn a_hand_arc_whose_replay_conflicted_is_blocked_until_it_replays_clean() {
        let temp = fixture();
        let repo = temp.path();
        let detail = detail_for(repo);
        assert!(detail.arc.is_none(), "precondition: a hand arc");

        crate::feeds::base_motion::publish_conflicts_for_test(
            &detail.owner_key,
            vec!["f.txt".to_string()],
        );
        let blocked = compose_with(repo, &detail);
        assert_eq!(blocked.phase, "blocked");
        assert!(blocked.offer.is_none(), "a conflicted arc offers nothing");
        let conflict = blocked
            .blockers
            .iter()
            .find(|b| b.kind == "conflicted")
            .expect("the conflict is the blocker");
        assert_eq!(conflict.paths, vec!["f.txt".to_string()]);
        assert!(
            conflict.detail.contains("tugtool arc replay demo"),
            "{}",
            conflict.detail
        );

        crate::feeds::base_motion::publish_conflicts_for_test(&detail.owner_key, Vec::new());
        assert!(
            compose_with(repo, &detail).offer.is_some(),
            "a clean replay clears it"
        );
    }

    /// Readiness is the derivation's: an arc it does not call ready offers
    /// nothing and needs nobody, and the same arc read ready offers.
    #[test]
    fn the_offer_is_withheld_while_the_derivation_says_not_ready() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        let withheld = compose_with(repo, &not_ready(repo));
        assert!(withheld.offer.is_none(), "not ready, so nothing is offered");
        assert!(withheld.attention.is_none(), "and nobody is needed");
        assert!(
            compose(repo).offer.is_some(),
            "the same arc, read ready, offers"
        );
    }

    #[test]
    fn blockers_are_read_live_on_every_compose() {
        let temp = fixture();
        let repo = temp.path();
        assert!(compose(repo).blockers.is_empty(), "precondition: unblocked");

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
        assert_eq!(cleared.phase, "previewed");

        // And a base checkout on another branch blocks the same way.
        git(repo, &["switch", "-q", "-c", "scratch"]);
        let off_base = compose(repo);
        assert_eq!(off_base.phase, "blocked");
        assert!(off_base.blockers.iter().any(|b| b.kind == "off-base"));
        assert!(off_base.offer.is_none(), "a blocked arc offers nothing");
    }

    // ── The join offer ──────────────────────────────────────────────────────

    /// Clear the fixture's overlap — the base takes the arc's side of
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

        reconciled(repo);
        assert!(
            compose_with(repo, &not_ready(repo)).offer.is_none(),
            "an arc still being worked offers nothing"
        );
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
    /// the user, under a key that names the work; an arc that is not ready and
    /// an arc with a run in flight need nobody.
    #[test]
    fn attention_follows_the_offer() {
        let temp = fixture();
        let repo = temp.path();
        reconciled(repo);
        assert!(
            compose_with(repo, &not_ready(repo)).attention.is_none(),
            "an arc that is not ready offers nothing, so needs nobody"
        );
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

        // The fold put the user's own edit on the base over the arc's file,
        // so the arc meets it the way any arc meets a moved base: it takes
        // the base in and resolves on its own branch — the audit's work —
        // and then joins clean.
        git(repo, &["switch", "-q", "tugarc/demo"]);
        git(repo, &["merge", "-q", "--no-edit", "-X", "ours", "main"]);
        git(repo, &["switch", "-q", "main"]);

        // The arc lands. Its fold is still in the log, and still un-undone.
        let joined = ops::join_in(
            &Paths::from_env(),
            repo,
            "demo",
            ops::JoinOptions {
                preview: false,
                ..Default::default()
            },
        )
        .expect("joined");
        assert!(
            joined.blockers.is_empty() && joined.conflicts.is_empty(),
            "precondition: the join actually landed: {:?} {:?}",
            joined.blockers,
            joined.conflicts
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
