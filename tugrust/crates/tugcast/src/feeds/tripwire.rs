//! The tripwire engine — what turns a standing tripwire into a firing.
//!
//! One engine per tugcast. Every firing it decides on becomes a row in
//! `tripwires.db`, including the ones it refuses.
//!
//! **A sibling of the Overview, never a part of it.** The Observer's one-way
//! isolation forbids anything in that subsystem acting toward a work session;
//! this engine reads the same facts and posts to the same feed, but it is its
//! own task with its own ledger, so nothing here is reachable from an Observer
//! wake and nothing there gains hands by our being adjacent.
//!
//! **One stream: the landing.** A wire fires when a landing gesture commits
//! onto the base branch the wire names — `/commit` on the main lane, a
//! `/arc-join` on the arc lane — and nothing else reaches this engine
//! ([P01]). The gesture sends a [`LandingEvent`] and returns; the engine
//! assembles the rest on its own task, so nothing the user waits on waits on
//! a tripwire. The event key is `landing:<sha>`, so two instances over one
//! ledger claim a landing once and a landing re-evaluated after a restart is
//! the same firing rather than a second one.
//!
//! **Facts are read at the landing, per lineage session, past a mark.** The
//! predicate is the fact condition alone; what it reads is what the landing's
//! own sessions have done since this wire last looked at each of them
//! ([P05]). A hand-typed `git commit` fires nothing, which is a stated
//! non-goal rather than a gap.
//!
//! **Every refusal is written down.** A `busy` skip, a ceiling queue, a
//! superseded coalesce — each is a `trips` row with a reason. A tripwire that
//! swallowed a hundred firings and a tripwire that never saw one look identical
//! from the outside, and only one of them is working.
//!
//! **The guard half is synchronous, the run half is not — and that split is
//! load-bearing.** `evaluate` decides against an open `rusqlite::Connection`
//! and hands back what is to be run; the model turn happens with no connection
//! in reach, and the settle takes it up again. `&Connection` is not `Send`, so
//! the ledger's no-transaction-across-await rule is enforced by the compiler
//! rather than by care.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tugcast_core::types::{OverviewAuthor, OverviewPost, OverviewRef, OverviewRefKind};
use tugcast_core::{FeedId, Frame};
use tugtool_core::tripwire_ledger::{self as ledger, Claim, TripStatus, Tripwire};
use tugtool_core::tripwire_predicate::{self, FactEvent};

use crate::feeds::tripwire_dossier as dossier;
use crate::feeds::tripwire_session::{
    TripwireSessionOutcome, TripwireSessionRequest, TripwireSessionRunner,
};
use crate::feeds::tripwire_tree::InspectionTrees;
use crate::session_ledger::SessionLedger;

/// How often the engine looks for a queued trip a settle never came back for.
///
/// What drains a queue when the run that would have freed a slot died with
/// another instance. Nothing else waits on it: a landing wakes the engine
/// directly.
const SWEEP_TICK: Duration = Duration::from_secs(5);

/// How many facts one lineage session contributes to one landing's fact set.
///
/// A cap rather than the whole of a session's history, because the marks make
/// the ordinary read small — everything since the wire last looked — and the
/// one read that is not is a wire armed against a session that has been
/// running for days. Bounding it keeps the dossier a dossier.
const LANDING_FACT_CAP: usize = 200;

/// How long a probe may run before the engine stops waiting on it.
///
/// A probe is an arbitrary command from a tripwire row, run unattended, and the two
/// failure modes it has no defence against on its own are the one that blocks
/// on a prompt and the one that never terminates. Neither announces itself:
/// without a deadline the trip stays `running` forever, holding its slot, and
/// the run it is inside never settles. Generous, because `just ci`
/// is the motivating probe and a cold build is slow.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How long a `running` trip may sit before any engine may declare it dead.
///
/// [`ledger::sweep_stale_running`] clears *this* instance's orphans at boot,
/// which is the clean case. It cannot clear another instance's: from here, an
/// instance that crashed and one that is mid-run look identical. But the
/// concurrency count is machine-wide, so rows nobody will ever settle consume
/// the ceiling for every tripwire on the machine — at the default ceiling of two,
/// two orphans stop the facility outright, and nothing recovers, because
/// draining the queue is something a settle triggers and no settle is coming.
/// Age is the only evidence available, so it is set comfortably past the
/// longest run this build can produce: a fifteen-minute probe followed by a
/// twenty-minute session.
const ORPHANED_RUN_AGE: Duration = Duration::from_secs(90 * 60);

/// How long one phase of a run may go before the engine settles it `failed`
/// ([P07]).
///
/// The ceiling and the session's own resolution verb race for the same trip
/// row on every run, and the ledger's compare-and-set is what admits exactly
/// one of them. Set past the session runner's own twenty minutes so an
/// ordinary wedged turn is reported as the timeout it is rather than as a
/// ceiling kill.
const SETTLE_CEILING: Duration = Duration::from_secs(30 * 60);

/// How often a phase re-reads its trip row looking for the resolution verb.
///
/// Polling rather than a notification because the writer is a `tugtool` in
/// another process addressing the machine's one ledger (Spec S02) — there is
/// no channel between them, and the row is the whole of the contract. Two
/// seconds is far below anything a person perceives and far above anything
/// SQLite notices.
const SETTLE_POLL: Duration = Duration::from_secs(2);

/// The permission mode the diagnosis phase is spawned under ([P04]).
///
/// A mode the runtime enforces rather than a posture the prompt asks for: it
/// is fixed at spawn, so the diagnosis session is *unable* to write for the
/// whole of its life. The wire's own `permission_mode` belongs to the
/// authoring phase alone.
const DIAGNOSIS_PERMISSION_MODE: &str = "plan";

/// The channel a hand-fired `tripwire trip` reaches the engine on.
///
/// Process-global rather than threaded through `ActionContext`, the same shape
/// the registry's `workspace_open_tx` uses: one optional consumer, set at boot
/// by whichever engine is running, and a send that is simply skipped in a
/// build without one.
static MANUAL_KICK: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Tell the engine a tripwire was fired by hand. Returns whether anybody was
/// listening — the CLI already wrote the queued row, so a `false` means the
/// row waits for the next engine rather than that the firing was lost.
pub fn kick(tripwire_name: &str) -> bool {
    match MANUAL_KICK.get() {
        Some(tx) => tx.try_send(tripwire_name.to_string()).is_ok(),
        None => false,
    }
}

/// The channel a settled trip's `tripwire_tell` reaches the engine on.
static SETTLE_TELL: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Tell the engine a trip was settled by a verb in another process, so the
/// Tripwires card sees it now rather than on the next tick (Spec S02).
///
/// Distinct from [`kick`] because it is: `kick` is process-local and answers
/// `false` from a CLI, which is exactly why the verb needs a door of its own.
/// A `false` here means no instance was listening, which is the ordinary case
/// for a machine with the app closed — the settle is written either way.
pub fn tell(tripwire_name: &str) -> bool {
    match SETTLE_TELL.get() {
        Some(tx) => tx.try_send(tripwire_name.to_string()).is_ok(),
        None => false,
    }
}

/// Which landing gesture this was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LandingKind {
    /// `/commit` on the main lane.
    Commit,
    /// `/arc-join` on the arc lane.
    Join,
}

impl LandingKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            LandingKind::Commit => "commit",
            LandingKind::Join => "join",
        }
    }
}

/// A landing gesture that committed onto a base branch — the engine's one
/// trigger (Spec S01).
///
/// Everything here is what the landing path already had in hand when it
/// finished. Nothing is computed for the engine's sake, because the send sits
/// on the path the user is waiting on (Risk R01): the dossier the session
/// eventually reads is assembled later, on the engine's own task.
#[derive(Debug, Clone, PartialEq)]
pub struct LandingEvent {
    /// The repository the landing happened in — what a wire's scope is
    /// compared against.
    pub repo_root: String,
    /// The branch the commit landed on. A wire naming another one is not
    /// considered at all.
    pub branch: String,
    /// The landed commit. The claim key and the arc-name seed both derive
    /// from it, so one landing is one firing per wire however many engines
    /// see it.
    pub sha: String,
    pub kind: LandingKind,
    /// The arc a join landed, and the whole of the own-arc guard ([P06]):
    /// a wire never fires on the join of an arc it created itself.
    pub arc: Option<String>,
    /// The lineage behind the landing — the drafting session for a commit,
    /// the arc's bound sessions for a join. The facts the predicate reads
    /// are these sessions' facts and no others.
    pub session_ids: Vec<String>,
}

/// The channel a landing reaches the engine on.
///
/// Process-global for the same reason [`MANUAL_KICK`] is: the two landing
/// gestures live in the supervisor and have no engine handle to be given, and
/// a build with no engine simply has no receiver.
static LANDING_TX: OnceLock<mpsc::Sender<LandingEvent>> = OnceLock::new();

/// Tell the engine a landing happened. Fire-and-forget, and deliberately so:
/// the landing path has finished its work and must not wait on a tripwire, so
/// a full channel or an absent engine drops the event rather than blocking
/// (Risk R01).
pub fn landed(event: LandingEvent) {
    let Some(tx) = LANDING_TX.get() else {
        return;
    };
    if tx.try_send(event).is_err() {
        debug!("tripwire engine: a landing was dropped; no engine, or its queue is full");
    }
}

/// What the engine needs to run.
pub struct TripwireEngineConfig {
    /// The session ledger a landing's lineage facts are read from.
    pub ledger: Arc<SessionLedger>,
    /// Where `tripwires.db` lives. Injected rather than resolved here so a
    /// test drives a real ledger at a temp path.
    pub db_path: PathBuf,
    /// Where the landings' inspection trees live ([P10]). Injected for the
    /// same reason the ledger path is — a test cuts real worktrees under a
    /// temp root rather than in the user's data directory.
    pub trees_root: PathBuf,
    /// Which instance owns the trips this engine claims. The boot sweep reads
    /// it to tell its own orphans from another instance's live runs.
    pub instance: String,
    /// The clock, injected so a trip's timestamps are the test's rather than
    /// the machine's.
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Where a trip's post goes. `None` in a test that is only asserting on
    /// the ledger; the post is skipped rather than faked.
    pub overview_tx: Option<broadcast::Sender<Frame>>,
    /// What runs a firing's sessions ([P04]). `None` leaves a firing at its
    /// floor — the trip is recorded and nothing is asked — which is what a
    /// tugcast with no supervisor to lend, and a test asserting only on the
    /// guard half, both want.
    pub sessions: Option<Arc<dyn TripwireSessionRunner>>,
    pub cancel: CancellationToken,
}

/// The engine's ledger connection.
///
/// Behind a mutex not for contention — one task owns it — but because that is
/// what makes the no-transaction-across-await rule enforceable: a guard is not
/// `Send`, so a lock held across an `await` will not compile. Every write
/// below takes the guard in a scope that closes before the next `.await`.
type Db = Mutex<Connection>;

/// One firing, from the event to the settled row.
///
/// The two halves are visible in the shape: the decision runs under the lock,
/// the model's turn runs with the lock released, and the settle takes it
/// again.
fn work_event(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    trees: &Arc<InspectionTrees>,
    landing: &LandingEvent,
) {
    // Before the guards read it, because the guard this frees is `busy`: a
    // landing that joined an awaiting wire's arc has answered that wire's
    // question, and the same landing should be free to fire it again ([P07]).
    sweep_awaiting(config, db);
    let pending = {
        let conn = db.lock().expect("tripwire ledger mutex");
        evaluate(config, &conn, landing).1
    };
    for run in pending {
        spawn_run(config, db, trees, run);
    }
}

/// Work one claimed firing on a task of its own.
///
/// Off the engine's task, because a run is not a fast thing: a probe may take
/// fifteen minutes and a session twenty, and awaiting that inline meant the
/// `select!` loop stopped reading for the whole of it. Facts survived that —
/// the tail is a rowid and catches up — but `GIT_HEAD` is a broadcast, so
/// commits past the channel's depth were lost outright, and every one of them
/// was a firing that never happened and left no row saying so.
///
/// Unbounded here only in the shape of the code. The trip is already `running`
/// in the ledger before this is called and the ceiling is read against that
/// count, so the number alive at once is exactly what the ceiling permits —
/// and the ceiling only becomes true *within* one instance now that runs are
/// concurrent at all.
fn spawn_run(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    trees: &Arc<InspectionTrees>,
    mut run: PendingRun,
) {
    let config = Arc::clone(config);
    let db = Arc::clone(db);
    let trees = Arc::clone(trees);
    tokio::spawn(async move {
        let settled = run_pending(&config, &db, &trees, &mut run).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            settle(&config, &conn, &run, &settled);
        }
        drain_queue(&config, &db, &trees).await;
    });
}

/// Look for a queued trip to start, on a task of its own. The tick's door into
/// [`drain_queue`], which otherwise only ever runs behind a settle.
fn spawn_drain(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>, trees: &Arc<InspectionTrees>) {
    let config = Arc::clone(config);
    let db = Arc::clone(db);
    let trees = Arc::clone(trees);
    tokio::spawn(async move { drain_queue(&config, &db, &trees).await });
}

/// Start the oldest queued trip now that a slot came free.
///
/// One per settle rather than a loop to empty the queue: each settle frees one
/// slot, so serving more than one would put the machine straight back over its
/// own ceiling.
async fn drain_queue(config: &TripwireEngineConfig, db: &Db, trees: &InspectionTrees) {
    let mut run = {
        let conn = db.lock().expect("tripwire ledger mutex");
        // Another instance's orphans hold the ceiling for everybody, and this
        // is exactly where that bites: the count read below is machine-wide.
        // Swept here rather than at boot alone, because boot only ever reaches
        // this instance's own rows.
        match ledger::sweep_orphaned_running(
            &conn,
            (config.now_ms)() - ORPHANED_RUN_AGE.as_millis() as i64,
        ) {
            Ok(0) | Err(_) => {}
            Ok(n) => info!(count = n, "tripwire engine: failed abandoned running trips"),
        }
        if ledger::running_count(&conn).unwrap_or(0)
            >= ledger::max_concurrent_trips(&conn).unwrap_or(2)
        {
            return;
        }
        let Ok(Some(trip)) = ledger::oldest_queued(&conn) else {
            return;
        };
        let Ok(Some(tripwire)) = tripwire_by_id(&conn, trip.wire_id) else {
            return;
        };
        start_run(
            &conn,
            &tripwire,
            trip.id,
            &trip.event_key,
            trip.event_payload.clone(),
        )
    };
    let settled = run_pending(config, db, trees, &mut run).await;
    let conn = db.lock().expect("tripwire ledger mutex");
    settle(config, &conn, &run, &settled);
}

/// Remove every inspection tree whose landing has no live trip (Risk R04).
///
/// The ledger answers both halves: which landings are still live, and which
/// repository a dead one was cut from. A tree this engine currently holds is
/// never swept — [`InspectionTrees::sweep`] checks its own open set — so a
/// tick landing mid-probe cannot pull the ground out from under it.
async fn sweep_trees(db: &Arc<Db>, trees: &Arc<InspectionTrees>) {
    let (live, repos) = {
        let conn = db.lock().expect("tripwire ledger mutex");
        let live: std::collections::HashSet<String> = ledger::live_event_keys(&conn)
            .unwrap_or_default()
            .iter()
            .filter_map(|key| key.strip_prefix("landing:"))
            .map(str::to_owned)
            .collect();
        // The repository a sha was landed in, read off any trip claimed for
        // it. Gathered under the lock so the sweep itself holds none.
        let repos: std::collections::HashMap<String, PathBuf> = std::fs::read_dir(trees.root())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter_map(|sha| {
                let trip = ledger::any_trip_for_event_key(&conn, &format!("landing:{sha}"))
                    .ok()
                    .flatten()?;
                let repo = dossier::landing_from_payload(&trip.event_payload?).repo_root;
                (!repo.is_empty()).then(|| (sha, PathBuf::from(repo)))
            })
            .collect();
        (live, repos)
    };
    trees.sweep(&live, |sha| repos.get(sha).cloned()).await;
}

/// Settle every `awaiting` trip whose arc is gone ([P07], [Q01]).
///
/// An awaiting trip is a question put to the user, and the thing the user does
/// about one — join the arc or discard it — is itself the answer. So no
/// timeout: the trip holds indefinitely and this is what notices that it has
/// been answered. Run on the tick and ahead of every landing's guards, because
/// what it releases is the wire's one-live-run slot.
///
/// The compare-and-set is not decoration. `tripwire dismiss` settles the same
/// row from another process and discards the same arc, so a sweep arriving
/// mid-dismissal must lose rather than overwrite the dismissal's words.
fn sweep_awaiting(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>) {
    let conn = db.lock().expect("tripwire ledger mutex");
    let Ok(trips) = ledger::awaiting_trips_with_arcs(&conn) else {
        return;
    };
    for trip in trips {
        let Some(arc) = trip.arc.as_deref() else {
            continue;
        };
        let repo_root =
            dossier::landing_from_payload(trip.event_payload.as_deref().unwrap_or("{}")).repo_root;
        if repo_root.is_empty() {
            continue;
        }
        if tugarc_core::ops::arc_exists_in(std::path::Path::new(&repo_root), arc) {
            continue;
        }
        let settled = ledger::settle_if_awaiting(
            &conn,
            trip.id,
            &ledger::Settlement {
                headline: Some(format!(
                    "the arc `{arc}` is gone, so the question is answered"
                )),
                ..ledger::Settlement::default()
            },
            (config.now_ms)(),
        );
        if matches!(settled, Ok(true)) {
            info!(
                trip = trip.id,
                arc, "tripwire: an awaiting trip's arc resolved it"
            );
        }
    }
}

/// A tripwire by its row id — what a queued trip names it by.
fn tripwire_by_id(
    conn: &Connection,
    wire_id: i64,
) -> Result<Option<Tripwire>, ledger::TripwireLedgerError> {
    Ok(ledger::list(conn)?.into_iter().find(|w| w.id == wire_id))
}

/// A claimed trip that passed every guard, carried out of the synchronous
/// decision so its turn can run with no ledger connection in reach.
#[derive(Debug, Clone)]
pub struct PendingRun {
    pub trip_id: i64,
    pub tripwire: String,
    /// The key the claim arbitrated on — the arc's name is derived from it,
    /// so one event's arc is one arc however often the engine restarts.
    pub event_key: String,
    pub model: Option<String>,
    pub brief: String,
    /// The command that decides whether an AI is needed at all ([P10]).
    pub probe: Option<String>,
    /// What the *authoring* session is allowed to do without asking [B09].
    /// The diagnosis session runs under [`DIAGNOSIS_PERMISSION_MODE`] and
    /// never this ([P04]).
    pub permission_mode: String,
    /// The event as the trip row holds it — what the model is shown.
    pub evidence: String,
    /// The refs the engine composed from the event itself — the commit's sha,
    /// the session that produced the fact. Facts the engine wrote rather than
    /// text a model produced, so they are attached directly.
    pub engine_refs: Vec<OverviewRef>,
    /// The project the event happened in, so the post lands on the right
    /// Overview.
    pub project_dir: Option<String>,
    /// The session the event came from, when it came from one.
    pub session_id: Option<String>,
    /// The arc this run staged, once it has one and is keeping it.
    pub arc: Option<String>,
}

impl PendingRun {
    /// The landing this run is about, read off the evidence the trip row
    /// carries — the same place everything else about the landing comes from,
    /// so a trip drained off the queue after a restart names the same tree.
    fn landing_sha(&self) -> String {
        dossier::landing_from_payload(&self.evidence).sha
    }
}

/// Run the engine until cancelled.
///
/// Goes quiet under the app-test harness for the same reason the agent pools
/// do: an app-test must be free, fast and deterministic, and a tripwire that fired
/// during one would spend tokens nobody asked for on a tree nobody kept.
pub async fn run_tripwire_engine(config: TripwireEngineConfig) {
    if crate::shared_agent::app_test_gated() {
        debug!("tripwire engine: quiet under the app-test harness");
        return;
    }

    let conn = match ledger::open_ledger(&config.db_path) {
        Ok(conn) => conn,
        Err(e) => {
            warn!(error = %e, path = %config.db_path.display(),
                  "tripwire engine: cannot open the tripwire ledger; no tripwire will fire");
            return;
        }
    };

    // A row left `running` by a tugcast that died holds a concurrency slot
    // nothing will ever free, so this instance's orphans are failed before the
    // first event is considered. Another instance's `running` rows are its
    // own and are left alone.
    match ledger::sweep_stale_running(&conn, &config.instance, (config.now_ms)()) {
        Ok(0) => {}
        Ok(n) => info!(count = n, "tripwire engine: swept stale running trips"),
        Err(e) => warn!(error = %e, "tripwire engine: boot sweep failed"),
    }
    // Shared rather than owned by the loop, because a run now happens on a task
    // of its own and has to carry the ledger and the pools with it.
    let config = Arc::new(config);
    let db: Arc<Db> = Arc::new(Mutex::new(conn));

    let (kick_tx, mut kick_rx) = mpsc::channel::<String>(16);
    let _ = MANUAL_KICK.set(kick_tx);
    let (tell_tx, mut tell_rx) = mpsc::channel::<String>(16);
    let _ = SETTLE_TELL.set(tell_tx);
    // Bounded, and a full queue drops rather than blocks: the sender is the
    // landing gesture and the landing gesture waits for nothing (Risk R01).
    let (landing_tx, mut landing_rx) = mpsc::channel::<LandingEvent>(64);
    let _ = LANDING_TX.set(landing_tx);

    let mut ticker = tokio::time::interval(SWEEP_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let trees = Arc::new(InspectionTrees::new(config.trees_root.clone()));
    // Whatever an unclean exit left behind, before the first landing adds to
    // it (Risk R04).
    sweep_trees(&db, &trees).await;

    info!(instance = %config.instance, "tripwire engine: watching landings");

    loop {
        tokio::select! {
            _ = config.cancel.cancelled() => {
                debug!("tripwire engine: shutting down");
                return;
            }
            _ = ticker.tick() => {
                // The tick is the only thing that reaches a queue nothing is
                // going to settle behind: a trip queued while the machine was
                // at its ceiling waits for a slot to come free, and the settle
                // that would have freed one may have died with another
                // instance. Without this the queue is drained only by a settle
                // that already happened, which on an idle machine is never.
                spawn_drain(&config, &db, &trees);
                // And the same tick reaches a tree whose trips are over but
                // whose run never got to release it — the shape
                // `sweep_orphaned_running` already uses, applied to disk.
                sweep_trees(&db, &trees).await;
                // And the same tick answers an awaiting trip whose arc the
                // user has since joined or discarded ([P07]).
                sweep_awaiting(&config, &db);
            }
            kicked = kick_rx.recv() => match kicked {
                Some(name) => serve_manual(&config, &db, &trees, name.as_str()),
                None => return,
            },
            told = tell_rx.recv() => match told {
                // A verb in another process settled this wire's trip. The row
                // is already right; what is missing is that anybody was told,
                // so the settle is re-read and republished from here (Spec
                // S02).
                Some(name) => republish_settled(&config, &db, name.as_str()),
                None => return,
            },
            landing = landing_rx.recv() => match landing {
                Some(landing) => work_event(&config, &db, &trees, &landing),
                None => return,
            },
        }
    }
}

/// Serve a hand-fired trip: find the tripwire's queued manual row and work it.
///
/// The CLI wrote the row before this arrived, so there is nothing to claim —
/// the queue already holds the firing, and this is only the nudge that says
/// not to wait for the tick.
///
/// The row is fed a **synthetic landing** (Spec S01) rather than a real one:
/// the wire's own branch, the scope's `HEAD`, no arc, and no lineage. It is
/// the bench-test door, and it goes past the guards by construction — a
/// hand-fired trip that could be swallowed as `busy` or spent by a mark would
/// test nothing.
fn serve_manual(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    trees: &Arc<InspectionTrees>,
    tripwire_name: &str,
) {
    let run = {
        let conn = db.lock().expect("tripwire ledger mutex");
        let Ok(Some(tripwire)) = ledger::get(&conn, tripwire_name) else {
            warn!(tripwire = %tripwire_name, "tripwire engine: kicked for a tripwire that is not there");
            return;
        };
        let Ok(trips) = ledger::trips_for_tripwire(&conn, tripwire.id, 8) else {
            return;
        };
        let Some(queued) = trips
            .iter()
            .find(|t| t.status == TripStatus::Queued.as_str())
        else {
            debug!(tripwire = %tripwire_name, "tripwire engine: kicked with nothing queued");
            return;
        };
        let landing = synthetic_landing(&tripwire);
        let payload = queued
            .event_payload
            .clone()
            .or_else(|| event_payload(&landing, &[]));
        let _ = ledger::record_event_payload(&conn, queued.id, payload.as_deref());
        start_run(&conn, &tripwire, queued.id, &queued.event_key, payload)
    };
    spawn_run(config, db, trees, run);
}

/// The landing a hand-fired trip stands in for: the wire's own branch, its
/// scope, and whatever `HEAD` names there.
///
/// A scope that cannot be read leaves the sha empty rather than refusing —
/// the trip is already claimed and queued by the CLI, and a bench-test door
/// that silently declined to open would be worse than one that opens onto a
/// landing with no commit to name.
fn synthetic_landing(tripwire: &Tripwire) -> LandingEvent {
    let repo_root = tripwire.scope.clone().unwrap_or_default();
    let sha = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    LandingEvent {
        repo_root,
        branch: tripwire.branch.clone(),
        sha,
        kind: LandingKind::Commit,
        arc: None,
        session_ids: Vec::new(),
    }
}

/// The outcome of considering one tripwire against one landing — the whole of what
/// the guard half decides, named so a test can assert on it rather than on
/// whatever rows happened to appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The branch, the scope, or another instance's claim said no, and no row
    /// was written for it.
    NoMatch,
    /// Refused before any work, for the named reason.
    Swallowed(&'static str),
    /// Serviceable, but the machine is busy.
    Queued,
    /// Claimed, past every guard, and handed on to its run.
    Fired,
}

/// Consider every armed tripwire against one landing.
///
/// The tripwires table is re-read per landing rather than cached, which is what
/// makes `pause` and `edit` apply on the next firing with no notification
/// plumbing at all: the next landing reads the row as it now stands.
pub fn evaluate(
    config: &TripwireEngineConfig,
    conn: &Connection,
    landing: &LandingEvent,
) -> (Vec<(String, Decision)>, Vec<PendingRun>) {
    let tripwires = match ledger::armed(conn) {
        Ok(tripwires) => tripwires,
        Err(e) => {
            warn!(error = %e, "tripwire engine: cannot read the tripwires table");
            return (Vec::new(), Vec::new());
        }
    };
    // Session ids rotate, so the landing's own list is the tip of each line
    // and not the whole of it. Expanded once here rather than per wire: the
    // facts the predicate reads are attributed per session id, and a landing
    // evaluated against the tips alone would never see what an earlier
    // segment of the same work recorded. The expanded list is what rides the
    // trip row, so a queued trip drained later reads the same lineage.
    let landing = &LandingEvent {
        session_ids: dossier::expand_lineage(&config.ledger, &landing.session_ids),
        ..landing.clone()
    };
    let mut decisions = Vec::with_capacity(tripwires.len());
    let mut pending = Vec::new();
    for tripwire in &tripwires {
        let (decision, run) = consider(config, conn, tripwire, landing);
        decisions.push((tripwire.name.clone(), decision));
        if let Some(run) = run {
            pending.push(run);
        }
    }
    (decisions, pending)
}

/// One wire against one landing, in the order [P06] fixes: the gates that
/// write nothing, then the claim, then the guards that refuse on the row the
/// claim made, then the evaluation, then the ceiling.
///
/// The claim comes before the guards for the reason it always has — a refusal
/// written by the loser of a race between two instances would name the wrong
/// reason for the right outcome — and the *evaluation* comes after them
/// because a `busy` or `own-arc` skip must advance no mark ([P05]). That is
/// what makes [P06]'s promise true: the next landing after a resolve genuinely
/// re-reads the facts the skip passed over.
fn consider(
    config: &TripwireEngineConfig,
    conn: &Connection,
    tripwire: &Tripwire,
    landing: &LandingEvent,
) -> (Decision, Option<PendingRun>) {
    if tripwire.predicate().is_err() {
        // A trigger this build cannot read belongs to a newer one. The tripwire
        // stays listable and removable; it simply never fires here — and it is
        // refused before the claim, so it costs its own wire and no other.
        return (Decision::NoMatch, None);
    }
    // The branch gate is a column comparison now, not a clause ([P02]). A wire
    // watching `main` is not considered at all for a landing onto anything
    // else, and writes no row saying so — a row per wire per foreign branch
    // would bury the refusals that mean something.
    if tripwire.branch != landing.branch {
        return (Decision::NoMatch, None);
    }
    if !in_scope(tripwire.scope.as_deref(), &landing.repo_root) {
        return (Decision::NoMatch, None);
    }

    let now = (config.now_ms)();
    let key = event_key(landing);

    match ledger::claim_trip(conn, tripwire.id, &key, now, &config.instance, None) {
        // Another instance owns this firing. Stop, silently: saying anything
        // would be two instances narrating one event.
        Ok(Claim::AlreadyClaimed) => (Decision::NoMatch, None),
        Err(e) => {
            warn!(error = %e, tripwire = %tripwire.name, "tripwire engine: claim failed");
            (Decision::NoMatch, None)
        }
        Ok(Claim::Claimed { trip_id }) => {
            // A wire never fires on the join of an arc it created itself
            // ([P06]) — half the anti-loop defense, and exact where the old
            // fact-tail skip was a heuristic.
            if landing
                .arc
                .as_deref()
                .is_some_and(|arc| arc.starts_with(&tripwire_arc_prefix(&tripwire.name)))
            {
                let _ = ledger::set_status(
                    conn,
                    trip_id,
                    TripStatus::Swallowed,
                    Some(ledger::SWALLOW_OWN_ARC),
                );
                return (Decision::Swallowed(ledger::SWALLOW_OWN_ARC), None);
            }
            // The other half: one live run per wire. An `awaiting` trip counts
            // — it holds a question the user has not answered yet.
            if matches!(ledger::live_trip(conn, tripwire.id), Ok(Some(_))) {
                let _ = ledger::set_status(
                    conn,
                    trip_id,
                    TripStatus::Swallowed,
                    Some(ledger::SWALLOW_BUSY),
                );
                return (Decision::Swallowed(ledger::SWALLOW_BUSY), None);
            }

            // Past the guards, so this wire is looking — and looking is what
            // spends the facts it looked at, whether or not any of them
            // matched ([P05]).
            let facts = lineage_facts(config, conn, tripwire, landing);
            let payload = event_payload(landing, &facts);
            let _ = ledger::record_event_payload(conn, trip_id, payload.as_deref());
            if facts.is_empty() {
                let _ = ledger::set_status(
                    conn,
                    trip_id,
                    TripStatus::Swallowed,
                    Some(ledger::SWALLOW_NO_MATCH),
                );
                return (Decision::Swallowed(ledger::SWALLOW_NO_MATCH), None);
            }
            let running = ledger::running_count(conn).unwrap_or(0);
            let ceiling = ledger::max_concurrent_trips(conn).unwrap_or(2);
            if running >= ceiling {
                let _ = ledger::queue_trip(conn, tripwire.id, trip_id);
                return (Decision::Queued, None);
            }
            (
                Decision::Fired,
                Some(start_run(conn, tripwire, trip_id, &key, payload)),
            )
        }
    }
}

/// The landing's fact set for one wire: every lineage session's facts past
/// that session's own mark, filtered by the wire's predicate — and the marks
/// advanced past everything looked at ([P05]).
///
/// Per session, because that is what the mark is keyed by. A session that
/// started before the last landing and lands after it carries facts whose
/// rowids sit below another session's mark, and a single global rowid would
/// spend them without anybody ever evaluating that lineage.
fn lineage_facts(
    config: &TripwireEngineConfig,
    conn: &Connection,
    tripwire: &Tripwire,
    landing: &LandingEvent,
) -> Vec<crate::session_ledger::FactRow> {
    let Ok(predicate) = tripwire.predicate() else {
        return Vec::new();
    };
    let mut matched = Vec::new();
    for session_id in &landing.session_ids {
        let mark = ledger::fact_mark(conn, tripwire.id, session_id)
            .ok()
            .flatten()
            .unwrap_or(0);
        let rows = match config
            .ledger
            .facts_for_session_after(session_id, mark, LANDING_FACT_CAP)
        {
            Ok(rows) => rows,
            Err(e) => {
                // A lineage this instance's ledger cannot read shrinks the
                // fact set rather than failing the landing, and says so where
                // a reader will look ([P03]).
                warn!(error = %e, session_id, tripwire = %tripwire.name,
                      "tripwire engine: a landing's lineage session could not be read");
                continue;
            }
        };
        let Some(high) = rows.last().map(|row| row.id) else {
            continue;
        };
        for row in rows {
            let payload = serde_json::from_str(&row.payload).unwrap_or(serde_json::Value::Null);
            let fact = FactEvent {
                kind: row.kind.clone(),
                payload,
            };
            if tripwire_predicate::matches(&predicate, &fact) {
                matched.push(row);
            }
        }
        let _ = ledger::set_fact_mark(conn, tripwire.id, session_id, high);
    }
    matched
}

/// The prefix every arc this wire creates carries, and the whole of what the
/// own-arc guard compares against ([P06]).
fn tripwire_arc_prefix(tripwire: &str) -> String {
    format!("tripwire-{tripwire}-")
}

/// Mark a trip running and gather everything its turn needs.
///
/// Everything is copied out rather than borrowed, because what happens next is
/// an `await` and the connection cannot come along.
fn start_run(
    conn: &Connection,
    tripwire: &Tripwire,
    trip_id: i64,
    event_key: &str,
    payload: Option<String>,
) -> PendingRun {
    // `running` before the turn, not after: the machine ceiling counts running
    // trips, and a turn that took its slot only once it finished would let
    // every instance start at once.
    let _ = ledger::record_run(conn, trip_id, None, None);
    let evidence = payload.unwrap_or_else(|| "{}".to_string());
    let context = event_context(&evidence);
    PendingRun {
        trip_id,
        tripwire: tripwire.name.clone(),
        event_key: event_key.to_string(),
        model: tripwire.model.clone(),
        brief: tripwire.brief.clone(),
        probe: tripwire.probe.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        engine_refs: context.refs,
        project_dir: context.project_dir,
        session_id: None,
        arc: None,
        evidence,
    }
}

/// Work one pending trip: the run, then the settle.
///
/// Split from `evaluate` because this is the half that awaits. No ledger
/// connection is in scope for the turn itself — the caller holds it and takes
/// it up again at the settle — which is the no-transaction-across-await rule
/// standing on the type system rather than on anybody remembering it.
///
/// One shape of run, now that the tier split is gone ([P04]): the landing's
/// inspection tree, a probe inside it, a diagnosis session that cannot write,
/// and — only if that session asks for one — an arc and an authoring session
/// that can.
pub async fn run_pending(
    config: &TripwireEngineConfig,
    db: &Db,
    trees: &InspectionTrees,
    run: &mut PendingRun,
) -> Settled {
    let Some(sessions) = config.sessions.clone() else {
        // No runner, so nothing can be asked. The firing is a recorded fact
        // about the tripwire and no more; it is not a failure, because the
        // tripwire matched, the guards passed, and nothing claims work was
        // done.
        return Settled::quiet(format!(
            "{} fired, and this instance has no session runner to ask",
            run.tripwire
        ));
    };
    let landing = dossier::landing_from_payload(&run.evidence);
    if landing.repo_root.is_empty() {
        return Settled::failed(
            "the landing named no repository, so there is no checkout to cut its inspection \
             tree from"
                .to_string(),
        );
    }
    // The landing's own repository, not the wire's scope: the scope is the
    // filter that decided this wire cares, and an unscoped wire watches the
    // machine. What a tree is cut from is where the commit actually landed.
    let repo_root = PathBuf::from(&landing.repo_root);

    // The landing's tree, shared with every other wire that fired on it. Held
    // for the whole run and given back on every exit below, including the
    // failing ones — a reference the settle never returns is a tree that lives
    // until the sweep.
    let tree = match trees.acquire(&repo_root, &landing.sha).await {
        Ok(tree) => tree,
        Err(e) => {
            return Settled::failed(format!(
                "the landing's inspection tree could not be made, so nothing could be run \
                 against the commit without standing on the user's checkout: {e}"
            ));
        }
    };
    let settled = run_in_tree(config, db, sessions, run, &repo_root, &tree, landing).await;
    trees.release(&run.landing_sha()).await;
    settled
}

/// The run itself, with the tree already in hand — split out so the release
/// above happens on every path this can leave by.
async fn run_in_tree(
    config: &TripwireEngineConfig,
    db: &Db,
    sessions: Arc<dyn TripwireSessionRunner>,
    run: &mut PendingRun,
    repo_root: &std::path::Path,
    tree: &std::path::Path,
    landing: dossier::Landing,
) -> Settled {
    let mut probe_report = None;

    // The probe, when the tripwire has one, in the landing's tree. Its exit is
    // the whole decision procedure: green means the thing the wire watches for
    // is not wrong here, and no model needs to be asked ([P10]).
    if let Some(command) = run.probe.clone() {
        let probe = run_probe(&command, tree).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            let _ = ledger::record_probe(&conn, run.trip_id, probe.exit, &probe.tail);
        }
        if probe.exit == 0 {
            return Settled::quiet(format!("`{command}` exited 0; nothing to report"));
        }
        probe_report = Some(dossier::ProbeReport {
            command,
            exit: probe.exit,
            tail: probe.tail,
        });
    }

    // Everything the session is told, assembled here rather than reconstructed
    // by it ([P03]).
    let dossier = dossier::Dossier {
        diff_stat: dossier::diff_stat(repo_root, &landing.sha).await,
        facts: dossier::facts_from_payload(&run.evidence),
        lineage: dossier::resolve_lineage(&config.ledger, &landing.session_ids),
        probe: probe_report,
        landing,
    };

    // Phase one: diagnosis, in the disposable tree at the landed sha and under
    // a permission mode the runtime enforces ([P04]). Two independent guards,
    // and the design leans on both — a write that somehow escaped the mode
    // still lands somewhere nobody keeps.
    let diagnosis = run_phase(
        config,
        db,
        sessions.as_ref(),
        TripwireSessionRequest {
            tripwire: run.tripwire.clone(),
            worktree: tree.to_path_buf(),
            permission_mode: DIAGNOSIS_PERMISSION_MODE.to_string(),
            model: run.model.clone(),
            prompt: dossier.prompt(&run.brief, &diagnosis_contract(&run.tripwire)),
        },
        run.trip_id,
    )
    .await;
    if let Some(session_id) = diagnosis.session_id.clone() {
        run.session_id = Some(session_id.clone());
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_run(&conn, run.trip_id, Some(&session_id), None);
    }
    let Some(ask) = diagnosis.settled.author_ask.clone() else {
        return diagnosis.settled;
    };

    // Phase two: authoring. The session creates nothing itself except commits
    // — the arc is cut here, because a name derived from the event key is
    // what makes a re-evaluated landing adopt its own arc rather than a
    // second one.
    let arc = tripwire_arc_name(&run.tripwire, &run.event_key);
    let created = match tokio::task::spawn_blocking({
        let repo_root = repo_root.to_path_buf();
        let arc = arc.clone();
        let tripwire = run.tripwire.clone();
        move || {
            let outcome = tugarc_core::ops::create_in(
                &repo_root,
                &arc,
                Some(format!("tripwire {tripwire}")),
                false,
                None,
            )?;
            tugarc_core::ops::set_laid_by(&repo_root, &arc, &format!("tripwire/{tripwire}"));
            Ok::<_, String>(outcome)
        }
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(e)) => {
            return Settled::failed(format!("the tripwire's arc could not be created: {e}"));
        }
        Err(e) => return Settled::failed(format!("the tripwire's arc could not be created: {e}")),
    };
    let worktree = PathBuf::from(&created.worktree);
    {
        // Back to `running`, which is what re-arms the compare-and-set the
        // authoring session's own resolution will win. The diagnosis settle is
        // spent; this trip is not finished until the second phase says so.
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_run(
            &conn,
            run.trip_id,
            run.session_id.as_deref(),
            Some(arc.as_str()),
        );
    }

    let authoring = run_phase(
        config,
        db,
        sessions.as_ref(),
        TripwireSessionRequest {
            tripwire: run.tripwire.clone(),
            worktree: worktree.clone(),
            permission_mode: run.permission_mode.clone(),
            model: run.model.clone(),
            prompt: dossier.authoring_prompt(
                &run.brief,
                &ask,
                &diagnosis.closing,
                &authoring_contract(&run.tripwire, &arc, &worktree),
            ),
        },
        run.trip_id,
    )
    .await;
    if let Some(session_id) = authoring.session_id.clone() {
        // The trip row names the session a reader would want to open, and once
        // there is an authoring session that is the one ([P04]).
        run.session_id = Some(session_id.clone());
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_run(&conn, run.trip_id, Some(&session_id), Some(arc.as_str()));
    }
    keep_or_discard(run, repo_root, &arc, &authoring.settled).await;
    authoring.settled
}

/// What one phase of a run amounted to.
struct Phase {
    session_id: Option<String>,
    /// The session's last words, for the phase that follows it. Empty when
    /// there was no turn to read.
    closing: String,
    /// What the trip row says now: the resolution the verb wrote, or the
    /// ceiling's own failure when the verb never came.
    settled: Settled,
}

/// Spawn one session and wait for whichever comes first: the resolution verb's
/// row, the turn's end, or the ceiling ([P07]).
///
/// The verb is watched for rather than awaited, because the writer is a
/// `tugtool` in another process (Spec S02) and the trip row is the only thing
/// the two share. A session that resolves and then wedges is therefore
/// released at its settle rather than at the ceiling, which is the whole
/// reason the poll runs beside the turn instead of after it.
///
/// Whatever ends the wait, the phase leaves the row settled — by the verb or
/// by the compare-and-set below, never by both (Risk R03).
async fn run_phase(
    config: &TripwireEngineConfig,
    db: &Db,
    sessions: &dyn TripwireSessionRunner,
    request: TripwireSessionRequest,
    trip_id: i64,
) -> Phase {
    let running = sessions.run(request);
    tokio::pin!(running);
    let deadline = tokio::time::Instant::now() + SETTLE_CEILING;
    let mut ticker = tokio::time::interval(SETTLE_POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut outcome: Option<TripwireSessionOutcome> = None;
    let mut error: Option<String> = None;
    let mut overran = false;
    let resolved = loop {
        tokio::select! {
            biased;
            answered = &mut running, if outcome.is_none() && error.is_none() => {
                match answered {
                    Ok(o) => outcome = Some(o),
                    Err(e) => error = Some(e),
                }
            }
            _ = ticker.tick() => {}
            _ = tokio::time::sleep_until(deadline) => {
                warn!(trip = trip_id, "tripwire: a phase outlived the settle ceiling");
                overran = true;
            }
        }
        let resolved = settled_row(db, trip_id);
        if resolved.is_some() || overran || outcome.is_some() || error.is_some() {
            break resolved;
        }
    };

    let phase = |settled| Phase {
        session_id: outcome.as_ref().map(|o| o.session_id.clone()),
        closing: outcome.as_ref().map(closing_prose).unwrap_or_default(),
        settled,
    };
    if let Some(settled) = resolved {
        return phase(settled);
    }

    // Nobody resolved, so the ceiling does — through the same compare-and-set
    // the verb uses, so a settle that landed in the gap between the read above
    // and this write is not overwritten by it.
    let unresolved = Settled::failed(unresolved_headline(
        error.as_deref(),
        outcome.as_ref().is_some_and(|o| o.completed),
    ));
    {
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::settle_if_running(
            &conn,
            trip_id,
            unresolved.status,
            &unresolved.settlement,
            (config.now_ms)(),
        );
    }
    phase(settled_row(db, trip_id).unwrap_or(unresolved))
}

/// The headline for a phase that produced no resolution. The three faults are
/// different and a reader of the trip log has to be able to tell them apart.
fn unresolved_headline(error: Option<&str>, completed: bool) -> String {
    if let Some(error) = error {
        return format!("the tripwire's session did not run: {error}");
    }
    if !completed {
        return "the tripwire's session did not finish inside its twenty minutes".to_string();
    }
    "the tripwire's session ended its turn without running the resolution verb".to_string()
}

/// The trip row's settle, if the verb has written one.
///
/// Read as a whole rather than as a status, because what the next phase needs
/// — the author ask — arrives on the same row and in the same write.
fn settled_row(db: &Db, trip_id: i64) -> Option<Settled> {
    let conn = db.lock().expect("tripwire ledger mutex");
    let trip = ledger::trip(&conn, trip_id).ok().flatten()?;
    let status = TripStatus::parse(&trip.status)?;
    if !matches!(
        status,
        TripStatus::Settled | TripStatus::Awaiting | TripStatus::Failed
    ) {
        return None;
    }
    Some(Settled {
        status,
        settlement: ledger::Settlement {
            headline: trip.headline,
            refs: trip.refs,
        },
        author_ask: trip.author_ask,
    })
}

/// The session's last words — what the authoring phase is handed ([P04]).
///
/// The transcript is frames, so the prose is scraped out of them by the same
/// span scan the rest of this build uses on tugcode output. This is a
/// convenience for the next prompt and never a decision procedure: what the
/// session *decided* came off the trip row, written by a verb.
fn closing_prose(outcome: &TripwireSessionOutcome) -> String {
    let mut last = String::new();
    for line in outcome.transcript.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(content) = value.pointer("/message/content").and_then(|c| c.as_array()) else {
            continue;
        };
        let text: Vec<&str> = content
            .iter()
            .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect();
        if !text.is_empty() {
            last = text.join("\n");
        }
    }
    last
}

/// The diagnosis phase's closing contract (Spec S03).
///
/// It names the verb and nothing else, because the verb is the whole of what
/// the engine reads. A session that instead describes its conclusion in prose
/// has said nothing the settle path can hear — which was the bug this
/// contract replaced.
fn diagnosis_contract(tripwire: &str) -> String {
    format!(
        "You are standing in a disposable checkout of the commit above. It is not the user's \
         working copy, nothing you write in it is kept, and you cannot write anyway — this \
         session runs in plan mode. Diagnose, and do nothing else.\n\n\
         Close your turn by running exactly one of:\n\
         `tugtool tripwire resolve {tripwire} --quiet` — nothing here is worth the user's \
         attention.\n\
         `tugtool tripwire resolve {tripwire} --awaiting --headline \"<one line>\"` — there is \
         something the user should see. The headline is the one line they will read.\n\n\
         Add `--author \"<one line saying what to change>\"` to either when a change is worth \
         authoring; a session with hands will then be opened on an arc to make it. Say in your \
         last words what you found and what you would change, because that prose is what that \
         session is handed."
    )
}

/// The authoring phase's closing contract (Spec S03).
///
/// It opens by telling the session to run `arc create` on an arc the engine
/// has already made. That is not busywork: `create` is idempotent, and what
/// the second call does is `claim_arc` — binding the arc to the session that
/// ran the verb ([Q02]). An arc the engine created in-process has no calling
/// session and is bound to nothing, which is exactly why the first real
/// tripwire run produced an arc nobody could join. The engine cuts the
/// worktree because there has to be somewhere to spawn into; the session
/// claims it because binding is a fact about who asked.
///
/// The absolute path is stated because the prompt is the only place it can be:
/// the session is spawned in the worktree, so its own working directory is
/// right, but a session that reasons its way onto a relative path is a session
/// writing into whatever directory it landed in — and the base checkout is one
/// `..` away.
fn authoring_contract(tripwire: &str, arc: &str, worktree: &std::path::Path) -> String {
    format!(
        "You are working on the arc `{arc}`, whose worktree is at `{path}`. Work only under \
         that path, and give every command an absolute path — a shell's working directory does \
         not survive between commands.\n\n\
         First run `tugtool arc create {arc}` — the arc already exists, so this claims it for \
         this session and nothing else.\n\n\
         Commit with `tugtool arc commit {arc} --message \"<subject>\"`; that is the only path \
         that commits here, and joining the work back is the user's act, never yours. If there \
         is nothing worth changing, change nothing and say so.\n\n\
         Close your turn by running \
         `tugtool tripwire resolve {tripwire} --awaiting --headline \"<one line>\"` when you left \
         something for the user to look at, or \
         `tugtool tripwire resolve {tripwire} --quiet` when you did not.",
        path = worktree.display(),
    )
}

/// The arc a firing stages on: `tripwire-<tripwire>-<key8>`.
///
/// Derived from the event key rather than minted, so the same firing named
/// twice — a queued trip drained after a restart — is the same arc and not a
/// second one, and *different* firings are never the same arc.
///
/// A key that is already legal arc-name material keeps its own first eight
/// characters; every other key is digested rather than sanitized. Sanitizing
/// drops the punctuation a key carries its discriminator behind, so eight
/// surviving characters of `landing:<sha>` would be eight characters of the
/// word "landing" — identical for every firing of one tripwire. Two firings
/// sharing a name is not a cosmetic collision: `create_in` is idempotent, so
/// the second adopts the first's arc, counts its rounds as its own, and a
/// green probe on the second discards the work the first staged.
fn tripwire_arc_name(tripwire: &str, event_key: &str) -> String {
    let key8 = if event_key.len() >= 8 && event_key.chars().all(|c| c.is_ascii_alphanumeric()) {
        event_key.chars().take(8).collect()
    } else {
        let digest = <Sha256 as Digest>::digest(event_key.as_bytes());
        digest.iter().take(4).fold(String::new(), |mut acc, b| {
            use std::fmt::Write;
            let _ = write!(acc, "{b:02x}");
            acc
        })
    };
    format!("{}{key8}", tripwire_arc_prefix(tripwire))
}

/// What a probe said.
struct ProbeResult {
    exit: i64,
    tail: String,
}

/// Run a tripwire's probe in its arc worktree, under a deadline.
///
/// The environment is inherited, with two changes. `TUG_SESSION_ID` is removed
/// — a probe is not a session, and leaking whichever session tugcast last
/// handled would attribute the probe's writes to a card that never ran it —
/// and the pagers are pinned off, because a probe with no terminal that pages
/// its output waits for a keypress nobody is there to give. `TUG_INSTANCE_ID`
/// rides through untouched, so a `tugtool` inside the probe addresses this
/// same instance.
///
/// A probe that outlives [`PROBE_TIMEOUT`] is killed and reported red.
/// `kill_on_drop` is what makes that true rather than aspirational: dropping
/// the timed-out future drops the child, and the child is signalled rather
/// than left running detached with its pipes still open.
async fn run_probe(command: &str, worktree: &std::path::Path) -> ProbeResult {
    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(worktree)
        .env_remove("TUG_SESSION_ID")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // A probe that could not be launched is a failing probe, not a green one:
    // reading "could not run" as "nothing wrong" is the one mistake that
    // silences a tripwire without anybody noticing.
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return ProbeResult {
                exit: -1,
                tail: format!("the probe could not be launched: {e}"),
            };
        }
    };
    match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            ProbeResult {
                exit: output.status.code().unwrap_or(-1) as i64,
                tail: tail(&text, ledger::PROBE_TAIL_CAP),
            }
        }
        Ok(Err(e)) => ProbeResult {
            exit: -1,
            tail: format!("the probe could not be read: {e}"),
        },
        Err(_) => ProbeResult {
            exit: -1,
            tail: format!(
                "the probe was still running after {} minutes and was killed",
                PROBE_TIMEOUT.as_secs() / 60
            ),
        },
    }
}

/// The last `cap` bytes, on a character boundary.
fn tail(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

/// Keep the arc only if the run is waiting on the user, and discard it
/// otherwise ([P07], [P09]).
///
/// The rule is the trip's status rather than a round count, and the two differ
/// in exactly the case the count gets wrong: a session that staged commits and
/// then resolved `--quiet` decided its own work was not worth showing anybody.
/// Keeping that arc leaves a worktree on the machine that nothing will ever
/// point at, because a quiet trip posts nothing ([P08]) — an arc nobody is
/// told about is an arc nobody joins.
///
/// Awaiting is the one status that holds an arc, and it holds it for as long as
/// the question is open: the user joining or discarding it *is* the resolution
/// ([P07]).
async fn keep_or_discard(
    run: &mut PendingRun,
    repo_root: &std::path::Path,
    arc: &str,
    settled: &Settled,
) {
    if settled.status == TripStatus::Awaiting {
        run.arc = Some(arc.to_string());
        run.engine_refs.push(OverviewRef {
            kind: OverviewRefKind::Arc,
            target: arc.to_string(),
        });
        return;
    }
    discard_agent_arc(repo_root, arc).await;
}

/// Remove a tripwire's arc without handing a byte of it back ([P09]).
async fn discard_agent_arc(repo_root: &std::path::Path, arc: &str) {
    let repo_root = repo_root.to_path_buf();
    let arc_name = arc.to_string();
    let removed = tokio::task::spawn_blocking(move || {
        tugarc_core::ops::discard_agent_arc_in(&repo_root, &arc_name, Some("tripwire"))
    })
    .await;
    if let Ok(Err(e)) = removed {
        warn!(arc, error = %e, "tripwire: the tripwire's arc could not be removed");
    }
}

/// How a trip finished, ready for the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub status: TripStatus,
    pub settlement: ledger::Settlement,
    /// What a resolution asked to have authored ([P04]). Present only on the
    /// diagnosis phase's settle, and the whole of what decides whether a
    /// second session runs.
    pub author_ask: Option<String>,
}

impl Settled {
    /// A firing that came to nothing anybody needs to see — the green probe,
    /// and the floor a firing settles at when this instance has nothing to ask.
    ///
    /// It still carries a headline. The trip log is where a reader goes to ask
    /// why a wire did nothing, and a settled row with no words is the one
    /// answer that surface cannot give.
    fn quiet(headline: String) -> Self {
        Settled {
            status: TripStatus::Settled,
            settlement: ledger::Settlement {
                headline: Some(headline),
                ..ledger::Settlement::default()
            },
            author_ask: None,
        }
    }

    /// A run that produced no resolution, and says why in the headline a reader
    /// of the trip log will actually see.
    fn failed(headline: String) -> Self {
        Settled {
            status: TripStatus::Failed,
            settlement: ledger::Settlement {
                headline: Some(headline),
                ..ledger::Settlement::default()
            },
            author_ask: None,
        }
    }
}

/// Write a finished trip's outcome and report it.
///
/// One call, because they are one act: a trip is finished, and here is what it
/// amounted to. Splitting the row from the post gave every call site the
/// chance to write one and forget the other, and a settled trip nobody was
/// told about is the failure this whole facility exists to avoid.
fn settle(config: &TripwireEngineConfig, conn: &Connection, run: &PendingRun, settled: &Settled) {
    if let Err(e) = ledger::settle(
        conn,
        run.trip_id,
        settled.status,
        &settled.settlement,
        (config.now_ms)(),
    ) {
        warn!(error = %e, tripwire = %run.tripwire, "tripwire engine: settle failed");
        return;
    }
    info!(
        tripwire = %run.tripwire,
        trip = run.trip_id,
        status = settled.status.as_str(),
        "tripwire settled"
    );
    post_settled(config, run, settled);
}

/// Post a settled trip to the Overview — the pointer post, and the only one
/// this facility makes ([P08]).
///
/// **Awaiting and nothing else.** The post-policy knob and the routine /
/// interesting split existed to ration a reporter that spoke on every firing;
/// a reporter that only ever raises its hand when it has a question for the
/// user does not need rationing, so the raised hand *is* the post. A quiet
/// settle and a failure are both rows in the trip log, which is where a reader
/// asking after a wire already goes.
///
/// The tripwire's name rides `wake_reason` as `tripwire:<name>`, which is what
/// the deck labels the row from — the author says a tripwire spoke, and the
/// reason says which one. Every ref on it is one the engine wrote down itself:
/// the landing's sha, and the arc if the run staged one.
fn post_settled(config: &TripwireEngineConfig, run: &PendingRun, settled: &Settled) {
    let Some(overview_tx) = config.overview_tx.as_ref() else {
        return;
    };
    if settled.status != TripStatus::Awaiting {
        return;
    }
    let Some(body) = settled.settlement.headline.clone() else {
        // A post with an empty body is worse than no post. The verb refuses an
        // awaiting resolution with no headline, so this is the belt to that
        // brace rather than an outcome anybody can reach.
        return;
    };

    let mut record = OverviewPost {
        id: None,
        at_ms: (config.now_ms)(),
        author: OverviewAuthor::Tripwire,
        session_id: run.session_id.clone(),
        wake_reason: Some(format!("tripwire:{}", run.tripwire)),
        body,
        refs: run.engine_refs.clone(),
        elapsed_ms: None,
        project_dir: run.project_dir.clone(),
        // A tripwire reports in words.
        attachments: Vec::new(),
        request_id: None,
        transient: false,
    };
    match config.ledger.record_overview_post(&record) {
        Ok(id) => record.id = Some(id),
        Err(e) => {
            warn!(error = %e, tripwire = %run.tripwire, "tripwire: overview ledger write failed")
        }
    }
    match serde_json::to_vec(&record) {
        Ok(bytes) => {
            let _ = overview_tx.send(Frame::new(FeedId::OVERVIEW, bytes));
        }
        Err(e) => warn!(error = %e, tripwire = %run.tripwire, "tripwire: post did not serialize"),
    }
}

/// Re-read a wire's newest settled trip and post it, because a verb in another
/// process wrote the settle this engine never saw (Spec S02).
///
/// The row is already right; what the tell buys is that anybody is told now
/// rather than never — a settle written by a `tugtool` reaches no Overview on
/// its own. Nothing here writes to the ledger, so a tell that arrives twice
/// costs a duplicate post at worst and can never disturb the settle itself.
fn republish_settled(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>, tripwire_name: &str) {
    let conn = db.lock().expect("tripwire ledger mutex");
    let Ok(Some(tripwire)) = ledger::get(&conn, tripwire_name) else {
        warn!(tripwire = %tripwire_name, "tripwire engine: told about a tripwire that is not there");
        return;
    };
    let Ok(trips) = ledger::trips_for_tripwire(&conn, tripwire.id, 1) else {
        return;
    };
    let Some(trip) = trips.into_iter().next() else {
        return;
    };
    let Some(status) = TripStatus::parse(&trip.status) else {
        return;
    };
    let settled = Settled {
        status,
        settlement: ledger::Settlement {
            headline: trip.headline.clone(),
            refs: trip.refs.clone(),
        },
        author_ask: trip.author_ask.clone(),
    };
    let context = event_context(trip.event_payload.as_deref().unwrap_or("{}"));
    let mut refs = context.refs;
    if let Some(arc) = trip.arc.clone() {
        refs.push(OverviewRef {
            kind: OverviewRefKind::Arc,
            target: arc,
        });
    }
    let run = PendingRun {
        trip_id: trip.id,
        tripwire: tripwire.name.clone(),
        event_key: trip.event_key.clone(),
        model: tripwire.model.clone(),
        brief: tripwire.brief.clone(),
        probe: tripwire.probe.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        evidence: trip.event_payload.unwrap_or_else(|| "{}".to_string()),
        engine_refs: refs,
        project_dir: context.project_dir,
        session_id: trip.session_id,
        arc: trip.arc,
    };
    post_settled(config, &run, &settled);
}

/// Whether a landing's repository falls under a tripwire's scope.
///
/// Raw prefix, compared as canonical paths, and deliberately **not** folded to
/// a base checkout: a tripwire's authoring session commits on its own arc
/// worktree, and
/// folding worktrees into the checkout they forked from would make those
/// commits re-trip the tripwire that made them. An unscoped tripwire watches the
/// machine.
fn in_scope(scope: Option<&str>, path: &str) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    let scope = scope.trim_end_matches('/');
    path == scope || path.starts_with(&format!("{scope}/"))
}

/// The key the claim arbitrates on: `landing:<sha>` (Spec S01).
///
/// Unqualified by instance, deliberately — a sha is the same fact on every
/// instance, so two engines over one ledger claim a landing once and the loser
/// stops silently. It is also the seed `tripwire_arc_name` derives from, so a
/// landing re-evaluated after a restart adopts the arc it already made rather
/// than cutting a second one.
fn event_key(landing: &LandingEvent) -> String {
    format!("landing:{}", landing.sha)
}

/// The evidence a trip carries forward — the landing and the facts that
/// matched under it.
///
/// Written onto the row rather than kept in memory, because a trip drained off
/// the queue minutes later has to compose the same post as one worked
/// immediately: the live event is gone by then, and this row is the only
/// record of it there is.
fn event_payload(
    landing: &LandingEvent,
    facts: &[crate::session_ledger::FactRow],
) -> Option<String> {
    let facts: Vec<serde_json::Value> = facts
        .iter()
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "at_ms": row.at_ms,
                "kind": row.kind,
                "session_id": row.session_id,
                "subject": row.subject,
                "text": row.text,
                "payload": serde_json::from_str::<serde_json::Value>(&row.payload)
                    .unwrap_or(serde_json::Value::Null),
            })
        })
        .collect();
    serde_json::to_string(&serde_json::json!({
        "landing": {
            "kind": landing.kind.as_str(),
            "branch": landing.branch,
            "sha": landing.sha,
            "repo_root": landing.repo_root,
            "arc": landing.arc,
            "sessions": landing.session_ids,
        },
        "facts": facts,
    }))
    .ok()
}

/// What the engine knows about an event, read back off the row it wrote.
///
/// Engine-composed refs are facts the engine recorded, not text a model
/// produced, so they are attached to the post directly. The validator exists
/// for the hallucination case — a target that never appeared in what the model
/// was shown — and a sha the engine read off a HEAD signal is not that.
#[derive(Debug, Default, Clone, PartialEq)]
struct EventContext {
    refs: Vec<OverviewRef>,
    project_dir: Option<String>,
}

fn event_context(payload: &str) -> EventContext {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return EventContext::default();
    };
    let landing = value.get("landing").unwrap_or(&serde_json::Value::Null);
    let str_field = |name: &str| {
        landing
            .get(name)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let mut refs = Vec::new();
    if let Some(sha) = str_field("sha") {
        refs.push(OverviewRef {
            kind: OverviewRefKind::Commit,
            target: sha,
        });
    }
    EventContext {
        refs,
        project_dir: str_field("repo_root"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugtool_core::tripwire_ledger::NewTripwire;

    /// A fixed clock, so a trip's timestamps are the test's rather than the
    /// machine's.
    #[derive(Clone)]
    struct TestClock(Arc<std::sync::Mutex<i64>>);

    impl TestClock {
        fn new(at: i64) -> Self {
            TestClock(Arc::new(std::sync::Mutex::new(at)))
        }
        fn as_now(&self) -> Arc<dyn Fn() -> i64 + Send + Sync> {
            let inner = Arc::clone(&self.0);
            Arc::new(move || *inner.lock().unwrap())
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        config: TripwireEngineConfig,
        conn: Connection,
        clock: TestClock,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tripwires.db");
        let conn = ledger::open_ledger(&db_path).unwrap();
        let clock = TestClock::new(1_700_000_000_000);
        let config = TripwireEngineConfig {
            ledger: Arc::new(SessionLedger::open_in_memory().unwrap()),
            db_path,
            trees_root: dir.path().join("trees"),
            instance: "inst-a".to_string(),
            now_ms: clock.as_now(),
            sessions: None,
            overview_tx: None,
            cancel: CancellationToken::new(),
        };
        Harness {
            _dir: dir,
            config,
            conn,
            clock,
        }
    }

    fn lay(conn: &Connection, name: &str, trigger: &str) -> Tripwire {
        ledger::lay(
            conn,
            &NewTripwire::new(
                name,
                trigger,
                "diagnose the failure and propose a fix",
                "main",
            ),
            1,
        )
        .unwrap()
    }

    /// Write one fact for a session, the way a live session would. Its rowid
    /// is what a wire's mark is compared against, so every call is a distinct
    /// point on that session's tail.
    fn record(config: &TripwireEngineConfig, session_id: &str, kind: &str) -> i64 {
        static SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        config
            .ledger
            .record_fact(&crate::session_ledger::NewFact {
                at_ms: 1_700_000_000_000 + n,
                kind: kind.to_string(),
                session_id: Some(session_id.to_string()),
                subject: Some(format!("f{n}")),
                text: format!("fact {n}"),
                payload: r#"{"class":"resolve"}"#.to_string(),
                dedupe_key: Some(format!("{kind}:{session_id}:{n}")),
            })
            .expect("record")
            .expect("a fresh fact lands")
    }

    /// A landing onto `main` in a project, carrying one lineage session.
    ///
    /// A fresh sha per call, because the sha is the claim key: a fixed one
    /// would make two landings one firing, and quietly turn every ceiling and
    /// mark test into a test of the key instead.
    fn landing(project_dir: &str, session_id: &str) -> LandingEvent {
        static SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        LandingEvent {
            repo_root: project_dir.to_string(),
            branch: "main".to_string(),
            sha: format!("{n:040x}"),
            kind: LandingKind::Commit,
            arc: None,
            session_ids: vec![session_id.to_string()],
        }
    }

    /// A landing carrying one fresh matching fact on its lineage session —
    /// the ordinary shape of a firing.
    fn firing(config: &TripwireEngineConfig, project_dir: &str, kind: &str) -> LandingEvent {
        let session = "sess-a";
        record(config, session, kind);
        landing(project_dir, session)
    }

    fn decision(outcomes: &[(String, Decision)], tripwire: &str) -> Decision {
        outcomes
            .iter()
            .find(|(name, _)| name == tripwire)
            .unwrap_or_else(|| panic!("{tripwire} was not considered: {outcomes:?}"))
            .1
    }

    /// The guard half alone — what every decision test asserts on. The runs it
    /// hands back are left `running`, which is exactly what a claimed trip is
    /// before its tier answers.
    fn decisions(
        config: &TripwireEngineConfig,
        conn: &Connection,
        landing: &LandingEvent,
    ) -> Vec<(String, Decision)> {
        evaluate(config, conn, landing).0
    }

    /// Decide and settle in one go, the way the loop does, against a scripted
    /// model.
    async fn work(
        config: &TripwireEngineConfig,
        conn: &Connection,
        landing: &LandingEvent,
    ) -> Vec<(String, Decision)> {
        let (decisions, mut pending) = evaluate(config, conn, landing);
        // The run half opens its own handle. `run_pending` takes the ledger
        // behind the mutex that makes the no-transaction-across-await rule a
        // compile error; the bare connection here is the assertion half's, and
        // the two are separate for the same reason the engine's are.
        let db: Db = Mutex::new(ledger::open_ledger(&config.db_path).unwrap());
        // The engine owns one of these for its whole life; a test's is per
        // call, under the harness's own scratch root, so a run cuts real
        // worktrees and cleans them up without reaching the user's data dir.
        let trees = InspectionTrees::new(config.trees_root.clone());
        for run in &mut pending {
            let settled = run_pending(config, &db, &trees, run).await;
            settle(config, conn, run, &settled);
        }
        decisions
    }

    fn statuses(conn: &Connection, wire_id: i64) -> Vec<String> {
        ledger::trips_for_tripwire(conn, wire_id, 20)
            .unwrap()
            .into_iter()
            .map(|t| t.status)
            .collect()
    }

    #[test]
    fn a_landing_whose_lineage_carries_nothing_the_wire_watches_is_a_row_that_says_so() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(&h.config, &h.conn, &firing(&h.config, "/proj", "shell"));
        assert_eq!(
            decision(&out, "w"),
            Decision::Swallowed(ledger::SWALLOW_NO_MATCH)
        );
        // A wire that has looked and found nothing does not look like a wire
        // nobody ever landed onto.
        assert_eq!(statuses(&h.conn, tripwire.id), vec!["swallowed"]);
    }

    /// A wire is not considered at all for a landing onto another branch, and
    /// writes no row about it ([P02]).
    #[test]
    fn a_landing_onto_another_branch_is_not_this_wires_business() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let mut elsewhere = firing(&h.config, "/proj", "edit_failed");
        elsewhere.branch = "release".to_string();
        let out = decisions(&h.config, &h.conn, &elsewhere);
        assert_eq!(decision(&out, "w"), Decision::NoMatch);
        assert!(statuses(&h.conn, tripwire.id).is_empty(), "no row at all");

        // And the same facts, on the branch it names, do fire it — so the
        // branch was the whole of the refusal.
        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    /// `pause` applies on the next firing because the table is re-read per
    /// event — there is no notification to forget to send.
    #[test]
    fn a_paused_tripwire_is_not_even_considered() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        ledger::set_paused(&h.conn, "w", true).unwrap();

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert!(out.is_empty(), "an armed-only read: {out:?}");
        assert!(statuses(&h.conn, tripwire.id).is_empty());

        ledger::set_paused(&h.conn, "w", false).unwrap();
        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    #[test]
    fn a_scoped_tripwire_ignores_a_foreign_path_and_takes_one_beneath_it() {
        let h = harness();
        let mut tripwire = NewTripwire::new(
            "w",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
            "main",
        );
        tripwire.scope = Some("/proj".to_string());
        ledger::lay(&h.conn, &tripwire, 1).unwrap();

        let foreign = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/elsewhere", "edit_failed"),
        );
        assert_eq!(decision(&foreign, "w"), Decision::NoMatch);

        // A sibling whose name merely starts with the scope is not under it.
        let sibling = decisions(&h.config, &h.conn, &landing("/project-other", "sess-a"));
        assert_eq!(decision(&sibling, "w"), Decision::NoMatch);

        let beneath = decisions(&h.config, &h.conn, &landing("/proj/src", "sess-a"));
        assert_eq!(decision(&beneath, "w"), Decision::Fired);
    }

    /// An arc worktree is not folded into the checkout it forked from — that
    /// folding is what would make a work-tier tripwire re-trip on its own commits.
    #[test]
    fn a_worktree_path_is_not_folded_into_its_base_checkout() {
        assert!(in_scope(Some("/proj"), "/proj/.tug/worktrees/x"));
        assert!(
            !in_scope(Some("/proj/.tug/worktrees/x"), "/proj"),
            "a scope on the worktree does not reach back to the base"
        );
        assert!(in_scope(None, "/anywhere"));
        assert!(
            in_scope(Some("/proj/"), "/proj/src"),
            "a trailing slash is not a different scope"
        );
    }

    /// Two engines over one ledger claim a landing once. The key is the sha
    /// and carries no instance qualifier, deliberately: a sha is the same fact
    /// on every instance, so the loser stops silently rather than narrating a
    /// firing the winner already owns.
    #[test]
    fn one_landing_is_one_firing_however_many_engines_see_it() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let landing = firing(&h.config, "/proj", "edit_failed");

        let mut other = harness();
        other.config.instance = "inst-b".to_string();
        other.config.db_path = h.config.db_path.clone();
        other.config.ledger = Arc::clone(&h.config.ledger);
        let other_conn = ledger::open_ledger(&h.config.db_path).unwrap();

        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &landing), "w"),
            Decision::Fired
        );
        assert_eq!(
            decision(&decisions(&other.config, &other_conn, &landing), "w"),
            Decision::NoMatch,
            "the loser of the claim stops silently"
        );
        assert_eq!(statuses(&h.conn, tripwire.id), vec!["running"]);
    }

    /// The same facts do not fire the wire twice: an evaluation spends what it
    /// looked at ([P05]).
    #[test]
    fn facts_a_landing_already_evaluated_never_fire_the_wire_again() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "w"), Decision::Fired);
        // Settle it, so the second landing meets the mark rather than the
        // busy guard.
        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 5).unwrap();
        ledger::set_status(&h.conn, trips[0].id, TripStatus::Settled, None).unwrap();

        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(
            decision(&out, "w"),
            Decision::Swallowed(ledger::SWALLOW_NO_MATCH),
            "the facts were spent by the landing that looked at them"
        );

        // A fresh fact on the same session is past the mark and fires again.
        record(&h.config, "sess-a", "edit_failed");
        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    /// The mark is per `(wire, session)`, and this is the case that proves it
    /// has to be ([P05]).
    ///
    /// Session B starts before session A's landing and lands after it. B's
    /// facts carry rowids *below* the mark A's landing set, so a single global
    /// max-rowid would spend them without anybody ever evaluating that
    /// lineage — a firing lost with no row saying so.
    #[test]
    fn a_concurrent_sessions_older_facts_still_fire_the_wire() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);

        // B writes first, then A writes and lands: B's rowid is the lower one.
        let b_rowid = record(&h.config, "sess-b", "edit_failed");
        let a_rowid = record(&h.config, "sess-a", "edit_failed");
        assert!(b_rowid < a_rowid, "B's fact is older than A's");

        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(decision(&out, "w"), Decision::Fired);
        assert_eq!(
            ledger::fact_mark(&h.conn, tripwire.id, "sess-a").unwrap(),
            Some(a_rowid)
        );
        assert_eq!(
            ledger::fact_mark(&h.conn, tripwire.id, "sess-b").unwrap(),
            None,
            "A's landing looked at A's lineage and no other"
        );
        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 5).unwrap();
        ledger::set_status(&h.conn, trips[0].id, TripStatus::Settled, None).unwrap();

        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-b"));
        assert_eq!(
            decision(&out, "w"),
            Decision::Fired,
            "B's older facts were never spent"
        );
    }

    /// A session id rotates mid-work, and the facts the earlier segment
    /// recorded are still this landing's ([P03], (#assumptions)).
    ///
    /// The landing carries the tip of the line and nothing else — that is all
    /// a commit gesture or an arc binding ever knows. Evaluating the tip alone
    /// would miss everything the session did under its previous id, and a wire
    /// that silently does not fire is worse than one that fires on nothing.
    #[test]
    fn a_rotated_sessions_earlier_facts_are_still_the_landings() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);

        // One line, two segments: the work started as `seg-old` and carried on
        // as `seg-new` after the rotation.
        for (id, at) in [("seg-old", 0), ("seg-new", 1)] {
            h.config
                .ledger
                .record_spawn(id, "ws", "/proj", "card", at, "line-1", None)
                .expect("spawn");
        }
        let old_rowid = record(&h.config, "seg-old", "edit_failed");

        let out = decisions(&h.config, &h.conn, &landing("/proj", "seg-new"));
        assert_eq!(
            decision(&out, "w"),
            Decision::Fired,
            "the tip's line carries the fact its earlier segment recorded"
        );
        assert_eq!(
            ledger::fact_mark(&h.conn, tripwire.id, "seg-old").unwrap(),
            Some(old_rowid),
            "and the segment the facts came from is what got marked"
        );
    }

    /// One live run per wire, and the skip is a row ([P06]).
    #[test]
    fn a_wire_with_a_live_trip_swallows_the_next_landing_as_busy() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        for status in [TripStatus::Running, TripStatus::Awaiting] {
            let Claim::Claimed { trip_id } =
                ledger::claim_trip(&h.conn, tripwire.id, status.as_str(), 1, "inst-a", None)
                    .unwrap()
            else {
                panic!("claimed");
            };
            ledger::set_status(&h.conn, trip_id, status, None).unwrap();

            let out = decisions(
                &h.config,
                &h.conn,
                &firing(&h.config, "/proj", "edit_failed"),
            );
            assert_eq!(
                decision(&out, "w"),
                Decision::Swallowed(ledger::SWALLOW_BUSY),
                "a {} trip holds the wire's one slot",
                status.as_str()
            );
            ledger::set_status(&h.conn, trip_id, TripStatus::Settled, None).unwrap();
        }
    }

    /// A busy skip is refused before the predicate runs, so it spends nothing:
    /// the next landing after the blocking trip resolves re-reads exactly what
    /// the skip passed over ([P05], [P06]).
    #[test]
    fn a_busy_skip_advances_no_mark() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let Claim::Claimed { trip_id: blocker } =
            ledger::claim_trip(&h.conn, tripwire.id, "blocker", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        ledger::record_run(&h.conn, blocker, None, None).unwrap();

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(
            decision(&out, "w"),
            Decision::Swallowed(ledger::SWALLOW_BUSY)
        );
        assert_eq!(
            ledger::fact_mark(&h.conn, tripwire.id, "sess-a").unwrap(),
            None,
            "a skip refused before the predicate ran looked at nothing"
        );

        // The blocker resolves, and the very facts the skip passed over fire
        // the wire on the next landing.
        ledger::set_status(&h.conn, blocker, TripStatus::Settled, None).unwrap();
        let out = decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    /// A wire never fires on the join of an arc it created itself ([P06]) —
    /// the anti-loop guard, and it names its reason on the row.
    #[test]
    fn a_join_of_the_wires_own_arc_is_swallowed_as_own_arc() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let mut own = firing(&h.config, "/proj", "edit_failed");
        own.kind = LandingKind::Join;
        own.arc = Some(tripwire_arc_name("w", "landing:abc"));
        let out = decisions(&h.config, &h.conn, &own);
        assert_eq!(
            decision(&out, "w"),
            Decision::Swallowed(ledger::SWALLOW_OWN_ARC)
        );
        assert_eq!(statuses(&h.conn, tripwire.id), vec!["swallowed"]);
        assert_eq!(
            ledger::fact_mark(&h.conn, tripwire.id, "sess-a").unwrap(),
            None,
            "an own-arc skip spends nothing either"
        );

        // Somebody else's arc is an ordinary join, and fires it.
        let mut theirs = landing("/proj", "sess-a");
        theirs.kind = LandingKind::Join;
        theirs.arc = Some("tripwire-other-abcdef12".to_string());
        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &theirs), "w"),
            Decision::Fired
        );
    }

    #[test]
    fn the_machine_ceiling_queues_rather_than_running() {
        let h = harness();
        let busy = lay(&h.conn, "busy", r#"{"fact":{"kind":"edit_failed"}}"#);
        let waiting = lay(&h.conn, "waiting", r#"{"fact":{"kind":"edit_failed"}}"#);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "1").unwrap();

        // Something else on the machine is already running.
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(&h.conn, busy.id, "other", 1, "inst-b", None).unwrap()
        else {
            panic!("claimed");
        };
        ledger::record_run(&h.conn, trip_id, None, None).unwrap();

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "waiting"), Decision::Queued);
        assert_eq!(statuses(&h.conn, waiting.id), vec!["queued"]);
    }

    /// One slot per tripwire: a newer queued event replaces the older, and the
    /// coalescing stays visible in the log.
    #[test]
    fn a_newer_queued_event_supersedes_the_older_on_one_tripwire() {
        let h = harness();
        let other = lay(&h.conn, "other", r#"{"fact":{"kind":"edit_failed"}}"#);
        let w = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "1").unwrap();
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(&h.conn, other.id, "busy", 1, "inst-b", None).unwrap()
        else {
            panic!("claimed");
        };
        ledger::record_run(&h.conn, trip_id, None, None).unwrap();

        decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        // A fresh fact past the mark, so the second landing is an evaluation
        // that queues rather than one that finds nothing.
        record(&h.config, "sess-a", "edit_failed");
        decisions(&h.config, &h.conn, &landing("/proj", "sess-a"));

        assert_eq!(statuses(&h.conn, w.id), vec!["queued", "superseded"]);
    }

    /// A trigger written against a grammar this build cannot read never fires
    /// — and never stops the tripwires beside it from being considered.
    #[test]
    fn an_unreadable_trigger_costs_its_own_tripwire_and_no_other() {
        let h = harness();
        lay(&h.conn, "future", r#"{"portent":{"omen":"raven"}}"#);
        lay(&h.conn, "ordinary", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "future"), Decision::NoMatch);
        assert_eq!(decision(&out, "ordinary"), Decision::Fired);
    }

    /// A row left `running` by a dead tugcast holds a slot nothing will free.
    #[test]
    fn the_boot_sweep_fails_this_instances_orphans_only() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        for (key, instance) in [("mine", "inst-a"), ("theirs", "inst-b")] {
            let Claim::Claimed { trip_id } =
                ledger::claim_trip(&h.conn, tripwire.id, key, 1, instance, None).unwrap()
            else {
                panic!("claimed");
            };
            ledger::record_run(&h.conn, trip_id, None, None).unwrap();
        }
        assert_eq!(
            ledger::sweep_stale_running(&h.conn, &h.config.instance, 5_000).unwrap(),
            1
        );
        assert_eq!(ledger::running_count(&h.conn).unwrap(), 1);
    }

    /// A settle frees a slot, and the trip that was waiting on it starts.
    #[tokio::test]
    async fn settling_a_trip_starts_the_one_that_was_queued_behind_it() {
        let h = harness();
        let busy = lay(&h.conn, "busy", r#"{"fact":{"kind":"edit_failed"}}"#);
        let waiting = lay(&h.conn, "waiting", r#"{"fact":{"kind":"shell"}}"#);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "1").unwrap();

        // Queue one by filling the machine, then free the slot.
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(&h.conn, busy.id, "other", 1, "inst-b", None).unwrap()
        else {
            panic!("claimed");
        };
        ledger::record_run(&h.conn, trip_id, None, None).unwrap();
        let event = firing(&h.config, "/proj", "shell");
        decisions(&h.config, &h.conn, &event);
        assert_eq!(statuses(&h.conn, waiting.id), vec!["queued"]);

        ledger::settle(
            &h.conn,
            trip_id,
            TripStatus::Settled,
            &ledger::Settlement::default(),
            2,
        )
        .unwrap();

        let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
        drain_queue(
            &h.config,
            &db,
            &InspectionTrees::new(h.config.trees_root.clone()),
        )
        .await;

        // The floor, because this harness lends no session runner: the drained
        // trip settled, which is the assertion — a queue nothing drains is the
        // failure this tick exists to prevent.
        let trips = ledger::trips_for_tripwire(&h.conn, waiting.id, 10).unwrap();
        assert_eq!(trips[0].status, "settled");
        assert!(
            trips[0]
                .headline
                .as_deref()
                .is_some_and(|h| h.contains("no session runner")),
            "{:?}",
            trips[0].headline
        );
    }

    /// A harness whose posts go somewhere a test can read them.
    fn posting_harness() -> (Harness, broadcast::Receiver<Frame>) {
        let mut h = harness();
        let (tx, rx) = broadcast::channel::<Frame>(16);
        h.config.overview_tx = Some(tx);
        (h, rx)
    }

    fn posts(ledger: &SessionLedger) -> Vec<OverviewPost> {
        ledger
            .list_overview_posts_tail(50)
            .expect("the overview tail reads")
    }

    /// The whole loop, driven by a real landing through a real ledger: the
    /// engine wakes on the landing, reads its lineage's facts, and lands the
    /// trip.
    ///
    /// A fact written before the engine booted still counts. There is no tail
    /// tip to start from any more — what a wire has spent is its mark, and a
    /// mark it never wrote is a lineage it never looked at, whenever the facts
    /// were recorded ([P05]).
    #[tokio::test]
    async fn the_running_engine_trips_on_a_landing_whose_lineage_carries_the_fact() {
        let h = harness();
        let tripwire = lay(&h.conn, "tugedit", r#"{"fact":{"kind":"edit_failed"}}"#);
        let session_ledger = Arc::clone(&h.config.ledger);
        let cancel = h.config.cancel.clone();
        let db_path = h.config.db_path.clone();

        let engine = tokio::spawn(run_tripwire_engine(TripwireEngineConfig {
            ledger: Arc::clone(&session_ledger),
            db_path,
            trees_root: h.config.trees_root.clone(),
            instance: "inst-a".to_string(),
            now_ms: h.clock.as_now(),
            sessions: None,
            overview_tx: None,
            cancel: cancel.clone(),
        }));

        // Let the engine reach its select and claim the landing channel before
        // anything is sent on it.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let mut fact = crate::feeds::facts_library::edit_failed_fact(
            2_000,
            None,
            &serde_json::json!({"class": "resolve", "files": ["a.rs"]}),
            None,
        );
        fact.session_id = Some("sess-a".to_string());
        session_ledger.record_fact(&fact).unwrap();

        landed(landing("/proj", "sess-a"));

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            if trips.first().is_some_and(|t| t.status == "settled") {
                assert_eq!(trips.len(), 1, "one landing is one trip: {trips:?}");
                assert!(
                    trips[0]
                        .headline
                        .as_deref()
                        .is_some_and(|h| h.contains("no session runner")),
                    "the engine reached its floor and said so: {:?}",
                    trips[0].headline
                );
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the engine never fired"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        cancel.cancel();
        let _ = engine.await;
    }

    /// The run over a real git repository — the half of the engine that
    /// touches the filesystem, and the only half a fake session runner cannot
    /// stand in for.
    mod run_phases {
        use super::*;

        /// What the fake was asked to do, so a test can assert on the request
        /// as well as on the outcome. The permission mode and the worktree are
        /// the two guards [P04] leans on, and an outcome alone would not show
        /// either of them kept.
        #[derive(Debug, Clone)]
        struct SeenRun {
            tripwire: String,
            worktree: PathBuf,
            permission_mode: String,
            model: Option<String>,
            prompt: String,
        }

        /// What one spawn does when it runs.
        #[derive(Debug, Clone)]
        enum Reply {
            /// Run the resolution verb against the real ledger, exactly as
            /// `tugtool tripwire resolve` would — same function, same
            /// compare-and-set. Optionally leaving a commit behind first,
            /// because the keep-or-remove decision reads git rather than the
            /// script.
            Resolve {
                status: TripStatus,
                headline: &'static str,
                author: Option<&'static str>,
                closing: &'static str,
                commits: bool,
            },
            /// End the turn having resolved nothing.
            Silent,
        }

        /// A session runner that answers from a script of [`Reply`]s, one per
        /// spawn. Two entries is a run that authored; one is a run that
        /// diagnosed and stopped.
        struct FakeSessions {
            db_path: PathBuf,
            wire_id: i64,
            script: Mutex<std::collections::VecDeque<Reply>>,
            seen: Mutex<Vec<SeenRun>>,
        }

        impl FakeSessions {
            fn new(
                db_path: &std::path::Path,
                wire_id: i64,
                script: Vec<Reply>,
            ) -> Arc<FakeSessions> {
                Arc::new(FakeSessions {
                    db_path: db_path.to_path_buf(),
                    wire_id,
                    script: Mutex::new(script.into_iter().collect()),
                    seen: Mutex::new(Vec::new()),
                })
            }

            fn seen(&self) -> Vec<SeenRun> {
                self.seen.lock().unwrap().clone()
            }
        }

        /// A frame-shaped transcript, the way the real runner hands one back:
        /// the prose arrives inside an assistant frame's text field, never as
        /// bare lines. A plain-text fake is what hid the old work tier's
        /// unreadable-transcript bug from this suite.
        fn transcript(prose: &str) -> String {
            let frame = serde_json::json!({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": prose}]},
            });
            format!("{frame}\n{{\"type\":\"turn_complete\"}}")
        }

        #[async_trait::async_trait]
        impl TripwireSessionRunner for FakeSessions {
            async fn run(
                &self,
                request: TripwireSessionRequest,
            ) -> Result<TripwireSessionOutcome, String> {
                let reply = self.script.lock().unwrap().pop_front();
                let session_id = format!("sess-tripwire-{}", self.seen.lock().unwrap().len() + 1);
                self.seen.lock().unwrap().push(SeenRun {
                    tripwire: request.tripwire,
                    worktree: request.worktree.clone(),
                    permission_mode: request.permission_mode,
                    model: request.model,
                    prompt: request.prompt,
                });
                let Some(reply) = reply else {
                    return Ok(TripwireSessionOutcome {
                        session_id,
                        transcript: transcript("nothing was scripted for this spawn"),
                        completed: true,
                    });
                };
                let closing = match reply {
                    Reply::Silent => "I had a look around.",
                    Reply::Resolve {
                        status,
                        headline,
                        author,
                        closing,
                        commits,
                    } => {
                        if commits {
                            std::fs::write(request.worktree.join("fixed.txt"), "fixed").unwrap();
                            for args in [
                                vec!["add", "-A"],
                                vec!["commit", "-m", "the tripwire's round"],
                            ] {
                                let out = std::process::Command::new("git")
                                    .args(&args)
                                    .current_dir(&request.worktree)
                                    .output()
                                    .unwrap();
                                assert!(out.status.success(), "{args:?}");
                            }
                        }
                        let conn = ledger::open_ledger(&self.db_path).unwrap();
                        let resolution = ledger::resolve_running(
                            &conn,
                            self.wire_id,
                            status,
                            &ledger::Settlement {
                                headline: Some(headline.to_string()),
                                ..ledger::Settlement::default()
                            },
                            author,
                            9_000,
                        )
                        .unwrap();
                        assert!(
                            matches!(resolution, ledger::Resolution::Resolved { .. }),
                            "the scripted session's verb was refused: {resolution:?}"
                        );
                        closing
                    }
                };
                Ok(TripwireSessionOutcome {
                    session_id,
                    transcript: transcript(closing),
                    completed: true,
                })
            }
        }

        /// A git repository with one commit, and the state directory redirected
        /// beside it so nothing an arc writes reaches the developer's own.
        fn scratch_repo() -> (tempfile::TempDir, PathBuf) {
            let temp = tempfile::tempdir().unwrap();
            // SAFETY: `#[serial]`; no other thread reads the environment here.
            unsafe {
                std::env::set_var("TUG_DATA_DIR", temp.path().join("state"));
            }
            let repo = temp.path().join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::write(repo.join("README.md"), "scratch\n").unwrap();
            for args in [
                vec!["init", "-b", "main"],
                vec!["config", "user.name", "Test User"],
                vec!["config", "user.email", "test@example.com"],
                vec!["add", "-A"],
                vec!["commit", "-m", "first"],
            ] {
                let out = std::process::Command::new("git")
                    .args(&args)
                    .current_dir(&repo)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{args:?}");
            }
            let root = std::fs::canonicalize(&repo).unwrap();
            (temp, root)
        }

        fn probing_tripwire(conn: &Connection, root: &std::path::Path, probe: &str) -> Tripwire {
            let mut new = NewTripwire::new(
                "ci",
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "put the suite back to green",
                "main",
            );
            new.probe = Some(probe.to_string());
            new.scope = Some(root.to_string_lossy().into_owned());
            new.permission_mode = "acceptEdits".to_string();
            new.model = Some("claude-opus-5".to_string());
            ledger::lay(conn, &new, 1).unwrap()
        }

        /// A landing on the scratch repo's real `HEAD`.
        ///
        /// The sha has to be a commit the repository actually holds, because
        /// the run cuts a detached worktree at it ([P10]) — a synthetic sha
        /// would fail the tree rather than the thing under test.
        fn scoped_landing(config: &TripwireEngineConfig, root: &std::path::Path) -> LandingEvent {
            let mut landing = firing(config, root.to_string_lossy().as_ref(), "edit_failed");
            let out = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(root)
                .output()
                .unwrap();
            landing.sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            landing
        }

        fn arcs_in(root: &std::path::Path) -> Vec<String> {
            let out = std::process::Command::new("git")
                .args([
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads/tugarc/",
                ])
                .current_dir(root)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }

        /// The green-probe floor, which is the whole economic argument for the
        /// design: the probe answered, so no model was summoned and no arc was
        /// ever cut.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_green_probe_settles_the_trip_and_leaves_nothing_behind() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "true");
            let sessions = FakeSessions::new(&h.config.db_path, tripwire.id, vec![]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let landing = scoped_landing(&config, &root);
            work(&config, &h.conn, &landing).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "settled");
            assert_eq!(trips[0].probe_exit, Some(0));
            assert!(
                sessions.seen().is_empty(),
                "a green probe spends no tokens at all"
            );
            assert!(
                arcs_in(&root).is_empty(),
                "no arc was ever created — the probe ran in the landing's tree ([P10]): {:?}",
                arcs_in(&root)
            );
            assert!(
                !config.trees_root.join(&landing.sha).exists(),
                "and the landing's tree went with the last trip on it"
            );
            assert!(
                posts(&config.ledger).is_empty(),
                "a quiet settle is a trip-log row and never a post ([P08])"
            );
        }

        /// A probe that cannot be launched is a **failing** probe, never a
        /// green one. Reading "could not run" as "nothing wrong" is the one
        /// mistake that silences a wire forever ([P10]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_probe_that_cannot_be_launched_is_red_rather_than_green() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exec /nonexistent/probe");
            let sessions = FakeSessions::new(
                &h.config.db_path,
                tripwire.id,
                vec![Reply::Resolve {
                    status: TripStatus::Settled,
                    headline: "looked",
                    author: None,
                    closing: "nothing here",
                    commits: false,
                }],
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_landing(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_ne!(trips[0].probe_exit, Some(0), "{:?}", trips[0].probe_exit);
            assert_eq!(
                sessions.seen().len(),
                1,
                "the firing proceeded rather than settling quiet"
            );
        }

        /// Two wires matching one landing share one checkout, and it is removed
        /// once, after the second settles — the whole economy of [P10].
        #[serial_test::serial]
        #[tokio::test]
        async fn two_wires_on_one_landing_share_one_tree() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            for name in ["ci", "ci-two"] {
                let mut new = NewTripwire::new(
                    name,
                    r#"{"fact":{"kind":"edit_failed"}}"#,
                    "diagnose the failure and propose a fix",
                    "main",
                );
                // A probe that records the tree it ran in, so the test reads
                // where each wire stood rather than inferring it.
                new.probe = Some("pwd >> ../seen.txt; true".to_string());
                new.scope = Some(root.to_string_lossy().to_string());
                ledger::lay(&h.conn, &new, 1).unwrap();
            }
            let mut config = h.config;
            ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "4").unwrap();
            config.sessions = Some(
                FakeSessions::new(&config.db_path, 0, vec![]) as Arc<dyn TripwireSessionRunner>
            );

            let landing = scoped_landing(&config, &root);
            let out = work(&config, &h.conn, &landing).await;
            assert_eq!(decision(&out, "ci"), Decision::Fired);
            assert_eq!(decision(&out, "ci-two"), Decision::Fired);

            let seen = std::fs::read_to_string(config.trees_root.join("seen.txt"))
                .expect("both probes ran and wrote where they stood");
            let dirs: Vec<&str> = seen.lines().filter(|l| !l.is_empty()).collect();
            assert_eq!(dirs.len(), 2, "{seen}");
            assert_eq!(dirs[0], dirs[1], "one tree, not two: {seen}");
            assert!(
                dirs[0].ends_with(&landing.sha),
                "named for the landing: {seen}"
            );
            assert!(
                !config.trees_root.join(&landing.sha).exists(),
                "and removed exactly once, after the second settled"
            );
        }

        /// The one-session path: a diagnosis that resolves without asking for
        /// anything to be authored costs one spawn, cuts no arc, and settles
        /// exactly as the verb said ([P04], [P07]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_diagnosis_that_asks_for_nothing_spawns_once_and_cuts_no_arc() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(
                &h.config.db_path,
                tripwire.id,
                vec![Reply::Resolve {
                    status: TripStatus::Settled,
                    headline: "the failure is a flake, not a break",
                    author: None,
                    closing: "I read the diff and the test is order-dependent.",
                    commits: false,
                }],
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let landing = scoped_landing(&config, &root);
            work(&config, &h.conn, &landing).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "settled");
            assert_eq!(
                trips[0].headline.as_deref(),
                Some("the failure is a flake, not a break")
            );
            assert_eq!(trips[0].session_id.as_deref(), Some("sess-tripwire-1"));
            assert!(trips[0].arc.is_none());
            assert_eq!(sessions.seen().len(), 1, "one spawn, not two");
            assert!(arcs_in(&root).is_empty(), "{:?}", arcs_in(&root));

            // The diagnosis phase's two guards, asserted where they actually
            // live — on the spawn's arguments ([P04]).
            let run = &sessions.seen()[0];
            assert_eq!(run.tripwire, "ci");
            assert_eq!(run.permission_mode, "plan");
            assert_eq!(run.model.as_deref(), Some("claude-opus-5"));
            assert!(
                run.worktree.ends_with(&landing.sha),
                "the diagnosis stands in the landing's disposable tree: {run:?}"
            );
            assert!(
                run.prompt.contains("put the suite back to green")
                    && run.prompt.contains("exit 3")
                    && run.prompt.contains("tugtool tripwire resolve ci"),
                "the prompt carries the brief, the probe's failure, and the verb: {}",
                run.prompt
            );
        }

        /// The two-session path: a diagnosis that asks to author causes exactly
        /// one arc and one second spawn, under the wire's own permission mode
        /// and in the arc's worktree ([P04]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_diagnosis_that_asks_to_author_cuts_one_arc_and_spawns_once_more() {
            let (_temp, root) = scratch_repo();
            let (h, mut rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(
                &h.config.db_path,
                tripwire.id,
                vec![
                    Reply::Resolve {
                        status: TripStatus::Settled,
                        headline: "the assertion is stale",
                        author: Some("update the expected string in a_test.rs"),
                        closing: "The expected string was never updated when the format changed.",
                        commits: false,
                    },
                    Reply::Resolve {
                        status: TripStatus::Awaiting,
                        headline: "put the suite back to green",
                        author: None,
                        closing: "Done, one round on the arc.",
                        commits: true,
                    },
                ],
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let landing = scoped_landing(&config, &root);
            let arc = tripwire_arc_name("ci", &event_key(&landing));
            work(&config, &h.conn, &landing).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            let trip = &trips[0];
            assert_eq!(trip.status, "awaiting");
            assert_eq!(
                trip.headline.as_deref(),
                Some("put the suite back to green")
            );
            assert_eq!(trip.arc.as_deref(), Some(arc.as_str()));
            assert_eq!(
                trip.session_id.as_deref(),
                Some("sess-tripwire-2"),
                "the row names the session a reader would want to open — the authoring one"
            );

            assert_eq!(arcs_in(&root), vec![format!("tugarc/{arc}")]);
            assert_eq!(
                tugarc_core::ops::laid_by(&root, &arc).as_deref(),
                Some("tripwire/ci")
            );

            let seen = sessions.seen();
            assert_eq!(seen.len(), 2, "one diagnosis, one authoring");
            assert_eq!(seen[0].permission_mode, "plan");
            assert_eq!(
                seen[1].permission_mode, "acceptEdits",
                "the authoring spawn takes the wire's own mode, and only it"
            );
            assert!(seen[1].worktree.ends_with(&arc), "{:?}", seen[1]);
            assert!(
                seen[1]
                    .prompt
                    .contains(&format!("tugtool arc create {arc}"))
                    && seen[1]
                        .prompt
                        .contains("update the expected string in a_test.rs")
                    && seen[1]
                        .prompt
                        .contains("The expected string was never updated")
                    && seen[1]
                        .prompt
                        .contains(&format!("tugtool arc commit {arc}"))
                    && seen[1]
                        .prompt
                        .contains(&seen[1].worktree.display().to_string()),
                "the authoring prompt carries the claim, the ask, the findings, the commit path \
                 and the absolute worktree: {}",
                seen[1].prompt
            );

            // Awaiting is the one outcome that posts ([P08]), and it names the
            // arc the user would join.
            let post = posts(&config.ledger)
                .into_iter()
                .next_back()
                .expect("an awaiting trip posts");
            assert_eq!(post.author, OverviewAuthor::Tripwire);
            assert_eq!(post.wake_reason.as_deref(), Some("tripwire:ci"));
            assert_eq!(post.body, "put the suite back to green");
            assert!(
                post.refs
                    .iter()
                    .any(|r| r.kind == OverviewRefKind::Arc && r.target == arc),
                "the post names the arc to join: {:?}",
                post.refs
            );
            assert!(rx.try_recv().is_ok(), "and it went out live too");
        }

        /// A session that ended its turn having run no verb has said nothing
        /// the settle path can hear. The trip fails, the failure says which
        /// fault it was, and the empty arc is not left standing ([P07]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_session_that_never_resolves_fails_the_trip_and_says_which_fault() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 1");
            let sessions = FakeSessions::new(&h.config.db_path, tripwire.id, vec![Reply::Silent]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_landing(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed");
            assert!(
                trips[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains("without running the resolution verb")),
                "the failure says what went wrong: {:?}",
                trips[0].headline
            );
            assert!(arcs_in(&root).is_empty());
            assert!(
                posts(&config.ledger).is_empty(),
                "a failure is a trip-log row and never a post ([P08])"
            );
        }

        /// The settle ceiling, with time under the test's control ([P07]).
        ///
        /// A session that never comes back holds a machine-wide concurrency
        /// slot, so the ceiling is what makes a wedged `claude` cost one wire
        /// rather than the facility. The paused clock is what lets this be
        /// asserted at all: the auto-advance reaches the deadline the moment
        /// every task is idle, which is exactly the state a wedged session
        /// leaves the runtime in.
        #[tokio::test(start_paused = true)]
        async fn a_session_that_never_comes_back_is_settled_by_the_ceiling() {
            /// A session runner whose turn never ends.
            struct Wedged;

            #[async_trait::async_trait]
            impl TripwireSessionRunner for Wedged {
                async fn run(
                    &self,
                    _request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, String> {
                    std::future::pending().await
                }
            }

            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let Claim::Claimed { trip_id } =
                ledger::claim_trip(&h.conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
            else {
                panic!("claimed");
            };
            ledger::record_run(&h.conn, trip_id, None, None).unwrap();

            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let phase = run_phase(
                &h.config,
                &db,
                &Wedged,
                TripwireSessionRequest {
                    tripwire: "ci".to_string(),
                    worktree: PathBuf::from("/tmp"),
                    permission_mode: "plan".to_string(),
                    model: None,
                    prompt: "diagnose".to_string(),
                },
                trip_id,
            )
            .await;

            assert_eq!(phase.settled.status, TripStatus::Failed);
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(trip.status, "failed", "and the row, not only the return");
            assert!(
                trip.headline
                    .as_deref()
                    .is_some_and(|h| h.contains("twenty minutes")),
                "{:?}",
                trip.headline
            );
        }

        /// The settle race, and the whole of why the ceiling goes through a
        /// compare-and-set (Risk R03).
        ///
        /// A session that resolves in the gap between the ceiling's last read
        /// and its write must keep its resolution: the ceiling's `failed` is a
        /// statement about a session that said nothing, and one that spoke has
        /// falsified it. Driven here by settling the row first and asking the
        /// ceiling's verb to overwrite it, which is the losing side of the race
        /// arriving second.
        #[test]
        fn the_settle_race_admits_exactly_one_writer() {
            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let Claim::Claimed { trip_id } =
                ledger::claim_trip(&h.conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
            else {
                panic!("claimed");
            };
            ledger::record_run(&h.conn, trip_id, None, None).unwrap();

            // The verb gets there first.
            let resolution = ledger::resolve_running(
                &h.conn,
                tripwire.id,
                TripStatus::Awaiting,
                &ledger::Settlement {
                    headline: Some("the user should see this".to_string()),
                    ..ledger::Settlement::default()
                },
                None,
                2,
            )
            .unwrap();
            assert!(matches!(resolution, ledger::Resolution::Resolved { .. }));

            // The ceiling arrives after it, and is refused.
            assert!(
                !ledger::settle_if_running(
                    &h.conn,
                    trip_id,
                    TripStatus::Failed,
                    &ledger::Settlement {
                        headline: Some("ran out of time".to_string()),
                        ..ledger::Settlement::default()
                    },
                    3,
                )
                .unwrap(),
                "the ceiling must not overwrite a resolution that already landed"
            );
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(trip.status, "awaiting");
            assert_eq!(trip.headline.as_deref(), Some("the user should see this"));

            // And a second verb on the settled row is refused too, naming what
            // it found instead — which is what a session told only "refused"
            // could not have worked out.
            let second = ledger::resolve_running(
                &h.conn,
                tripwire.id,
                TripStatus::Settled,
                &ledger::Settlement::default(),
                None,
                4,
            )
            .unwrap();
            assert_eq!(
                second,
                ledger::Resolution::NoLiveTrip {
                    state: Some("awaiting".to_string())
                }
            );
        }

        /// A session that staged rounds and then resolved `--quiet` decided its
        /// own work was not worth showing anybody, so the arc goes ([P07]).
        ///
        /// The round count would keep this arc and the status does not, which
        /// is the whole reason the rule reads the status. A quiet trip posts
        /// nothing ([P08]), so an arc kept here is a worktree on the machine
        /// that nothing will ever point at.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_quiet_resolution_discards_its_arc_even_with_rounds_on_it() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(
                &h.config.db_path,
                tripwire.id,
                vec![
                    Reply::Resolve {
                        status: TripStatus::Settled,
                        headline: "worth a try",
                        author: Some("try the obvious fix"),
                        closing: "The obvious fix is a one-liner.",
                        commits: false,
                    },
                    Reply::Resolve {
                        status: TripStatus::Settled,
                        headline: "the fix did not hold; nothing to show",
                        author: None,
                        closing: "I tried it and it made things worse.",
                        commits: true,
                    },
                ],
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let landing = scoped_landing(&config, &root);
            work(&config, &h.conn, &landing).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "settled");
            assert_eq!(sessions.seen().len(), 2, "the authoring session did run");
            assert!(
                arcs_in(&root).is_empty(),
                "and its arc did not survive the quiet: {:?}",
                arcs_in(&root)
            );
            assert!(
                posts(&config.ledger).is_empty(),
                "a quiet settle posts nothing, which is why keeping the arc would strand it"
            );
        }

        /// An awaiting trip holds until its arc stops existing, and then the
        /// sweep answers it ([P07], [Q01]).
        ///
        /// Joining the arc and discarding it are the same event from here —
        /// both remove the branch — so removing it is the whole simulation. No
        /// timeout is involved and none is wanted: a question put to the user
        /// does not expire on a clock.
        #[serial_test::serial]
        #[tokio::test]
        async fn an_awaiting_trip_settles_when_its_arc_stops_existing() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(
                &h.config.db_path,
                tripwire.id,
                vec![
                    Reply::Resolve {
                        status: TripStatus::Settled,
                        headline: "the assertion is stale",
                        author: Some("update the expected string"),
                        closing: "It was never updated.",
                        commits: false,
                    },
                    Reply::Resolve {
                        status: TripStatus::Awaiting,
                        headline: "a fix is waiting on the arc",
                        author: None,
                        closing: "One round, ready to look at.",
                        commits: true,
                    },
                ],
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let landing = scoped_landing(&config, &root);
            let arc = tripwire_arc_name("ci", &event_key(&landing));
            work(&config, &h.conn, &landing).await;

            let config = Arc::new(config);
            let db: Arc<Db> = Arc::new(Mutex::new(ledger::open_ledger(&config.db_path).unwrap()));

            // The arc is still there, so the question is still open and the
            // wire's live-run slot is still held.
            sweep_awaiting(&config, &db);
            let trip = ledger::trips_for_tripwire(&h.conn, tripwire.id, 1).unwrap();
            assert_eq!(trip[0].status, "awaiting", "nothing has answered it yet");
            assert!(
                ledger::live_trip(&h.conn, tripwire.id).unwrap().is_some(),
                "and it is still holding the wire"
            );

            // The user joins or discards it — from here the two are one event.
            tugarc_core::ops::discard_agent_arc_in(&root, &arc, Some("test")).unwrap();
            sweep_awaiting(&config, &db);

            let trip = ledger::trips_for_tripwire(&h.conn, tripwire.id, 1).unwrap();
            assert_eq!(trip[0].status, "settled");
            assert!(
                trip[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains(&arc)),
                "the settle names what answered it: {:?}",
                trip[0].headline
            );
            assert_eq!(
                ledger::live_trip(&h.conn, tripwire.id).unwrap(),
                None,
                "and the wire's live-run slot came back"
            );
        }
        /// One firing is one arc, whatever the event was, and the name survives
        /// a key that is not itself a legal arc name.
        #[test]
        fn a_arc_is_named_for_its_tripwire_and_its_firing() {
            assert_eq!(
                tripwire_arc_name("ci", "abc1234def5678"),
                "tripwire-ci-abc1234d",
                "a commit key is already eight legal characters"
            );
            // The property, not the spelling: two firings of one tripwire must
            // never name one arc. Sanitizing a fact key to eight characters
            // used to yield `tripwire-tugedit-factedit` for every firing there
            // would ever be, and `create_in` is idempotent — so the second
            // firing adopted the first's arc, counted its rounds as its own,
            // and a green probe on the second discarded what the first staged.
            let first = tripwire_arc_name("tugedit", "fact:inst-a:41");
            let second = tripwire_arc_name("tugedit", "fact:inst-a:42");
            let elsewhere = tripwire_arc_name("tugedit", "fact:inst-b:41");
            assert_ne!(first, second, "two facts are two arcs");
            assert_ne!(first, elsewhere, "two instances are two arcs");
            assert_eq!(
                first,
                tripwire_arc_name("tugedit", "fact:inst-a:41"),
                "one firing named twice is one arc, however often the engine restarts"
            );
            assert!(
                first.starts_with("tripwire-tugedit-")
                    && first.len() == "tripwire-tugedit-".len() + 8,
                "a digested key is still eight characters: {first}"
            );
        }
    }
}
