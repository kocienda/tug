//! The tripwire engine — what turns a standing tripwire into a firing.
//!
//! One engine per tugcast. It watches two streams, and every firing it decides
//! on becomes a row in `tripwires.db`, including the ones it refuses.
//!
//! **A sibling of the Overview, never a part of it.** The Observer's one-way
//! isolation forbids anything in that subsystem acting toward a work session;
//! this engine reads the same facts and posts to the same feed, but it is its
//! own task with its own ledger, so nothing here is reachable from an Observer
//! wake and nothing there gains hands by our being adjacent.
//!
//! **Two streams, two shapes of key.** Facts arrive as a rowid tail off the
//! session ledger, woken by its signal and backstopped by a sweep tick, so a
//! fact written through the batch path is late rather than lost. Commits
//! arrive as `GitHeadSignal`s off the shared GIT_HEAD broadcast, the same
//! channel the base-motion engine subscribes to. A commit's event key is its
//! sha, which is why re-checking out a tripped commit never trips again.
//!
//! **Every refusal is written down.** A cooldown swallow, a ceiling queue, a
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

use tugcast_core::types::{
    GitHeadSignal, OverviewAuthor, OverviewPost, OverviewRef, OverviewRefKind,
};
use tugcast_core::{FeedId, Frame};
use tugutil_core::tripwire_ledger::{
    self as ledger, Claim, PostPolicy, Tier, TripStatus, Tripwire,
};
use tugutil_core::tripwire_predicate::{self, TripwireEvent};

use crate::feeds::agent_supervisor::TRIPWIRE_CARD_PREFIX;
use crate::feeds::tripwire_agent::{self, Outcome, TripwirePools};
use crate::feeds::tripwire_session::{self, TripwireSessionRunner};
use crate::session_ledger::SessionLedger;

/// How often the engine re-reads the fact tail regardless of the signal.
///
/// The backstop for `record_fact_tx`: a caller already holding the ledger lock
/// writes without signalling, so those facts are late by at most one tick
/// rather than invisible. It is also what drains a queue when the run that
/// would have freed a slot died with another instance.
const SWEEP_TICK: Duration = Duration::from_secs(5);

/// How many facts one tail read takes. A cap rather than the whole backlog, so
/// a burst is worked in bounded chunks and the engine stays responsive to its
/// cancel between them.
const FACT_TAIL_CAP: usize = 200;

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

/// What the engine needs to run.
pub struct TripwireEngineConfig {
    /// The session ledger the fact tail reads and the signal comes from.
    pub ledger: Arc<SessionLedger>,
    /// Where `tripwires.db` lives. Injected rather than resolved here so a
    /// test drives a real ledger at a temp path.
    pub db_path: PathBuf,
    /// Which instance owns the trips this engine claims. The boot sweep reads
    /// it to tell its own orphans from another instance's live runs.
    pub instance: String,
    /// The clock, injected so a test can place two events in one cooldown
    /// window without sleeping through it.
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// What spawns a tripwire pool's worker. Injected for the same reason the
    /// clock is: a test scripts what the model says, and nothing in the loop
    /// has to know which of the two it is talking to.
    pub spawner: Arc<dyn crate::shared_agent::AgentWorkerSpawner>,
    /// Where a trip's post goes. `None` in a test that is only asserting on
    /// the ledger; the post is skipped rather than faked.
    pub overview_tx: Option<broadcast::Sender<Frame>>,
    /// What runs a work-tier tripwire's session. `None` leaves the work tier at
    /// its floor — the firing is recorded and nothing is asked — which is what
    /// a tugcast with no supervisor to lend, and a test asserting only on the
    /// verdict tier, both want.
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
    pools: &Arc<TripwirePools>,
    event: &TripwireEvent,
) {
    let pending = {
        let conn = db.lock().expect("tripwire ledger mutex");
        evaluate(config, &conn, event).1
    };
    for run in pending {
        spawn_run(config, db, pools, run);
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
    pools: &Arc<TripwirePools>,
    mut run: PendingRun,
) {
    let config = Arc::clone(config);
    let db = Arc::clone(db);
    let pools = Arc::clone(pools);
    tokio::spawn(async move {
        let settled = run_pending(&config, &db, &pools, &mut run).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            settle(&config, &conn, &run, &settled);
        }
        drain_queue(&config, &db, &pools).await;
    });
}

/// Look for a queued trip to start, on a task of its own. The tick's door into
/// [`drain_queue`], which otherwise only ever runs behind a settle.
fn spawn_drain(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>, pools: &Arc<TripwirePools>) {
    let config = Arc::clone(config);
    let db = Arc::clone(db);
    let pools = Arc::clone(pools);
    tokio::spawn(async move { drain_queue(&config, &db, &pools).await });
}

/// Start the oldest queued trip now that a slot came free.
///
/// One per settle rather than a loop to empty the queue: each settle frees one
/// slot, so serving more than one would put the machine straight back over its
/// own ceiling.
async fn drain_queue(config: &TripwireEngineConfig, db: &Db, pools: &TripwirePools) {
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
    let settled = run_pending(config, db, pools, &mut run).await;
    let conn = db.lock().expect("tripwire ledger mutex");
    settle(config, &conn, &run, &settled);
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
    /// The key the claim arbitrated on — the dash's name is derived from it,
    /// so one event's dash is one dash however often the engine restarts.
    pub event_key: String,
    pub tier: Tier,
    pub model: Option<String>,
    pub brief: String,
    /// The checkout a work-tier run happens in. A work tripwire cannot arm without
    /// one ([B07]); a verdict tripwire may have none.
    pub scope: Option<String>,
    /// The command that decides whether an AI is needed at all ([P05]).
    pub probe: Option<String>,
    /// What the session is allowed to do without asking [B09].
    pub permission_mode: String,
    /// The event as the trip row holds it — what the model is shown.
    pub evidence: String,
    /// When to post the outcome.
    pub post: PostPolicy,
    /// The refs the engine composed from the event itself — the commit's sha,
    /// the session that produced the fact. Facts the engine wrote rather than
    /// text a model produced, so they are attached directly.
    pub engine_refs: Vec<OverviewRef>,
    /// The project the event happened in, so the post lands on the right
    /// Overview.
    pub project_dir: Option<String>,
    /// The session the event came from, when it came from one.
    pub session_id: Option<String>,
    /// The dash this run staged, once it has one and is keeping it.
    pub dash: Option<String>,
}

/// Run the engine until cancelled.
///
/// Goes quiet under the app-test harness for the same reason the agent pools
/// do: an app-test must be free, fast and deterministic, and a tripwire that fired
/// during one would spend tokens nobody asked for on a tree nobody kept.
pub async fn run_tripwire_engine(
    config: TripwireEngineConfig,
    mut gh_rx: broadcast::Receiver<Frame>,
) {
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

    // The tail starts at the tip, not at zero: an engine that replayed the
    // whole fact history at boot would narrate months of old work as though it
    // had just happened. Events during tugcast downtime never trip, which is a
    // property rather than a gap.
    let mut tail = config.ledger.max_fact_rowid().unwrap_or(0);
    let fact_signal = config.ledger.fact_signal();

    let (kick_tx, mut kick_rx) = mpsc::channel::<String>(16);
    let _ = MANUAL_KICK.set(kick_tx);

    let mut ticker = tokio::time::interval(SWEEP_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let pools = Arc::new(TripwirePools::new(Arc::clone(&config.spawner)));

    info!(instance = %config.instance, from_rowid = tail, "tripwire engine: watching");

    loop {
        tokio::select! {
            _ = config.cancel.cancelled() => {
                debug!("tripwire engine: shutting down");
                return;
            }
            _ = fact_signal.notified() => drain_facts(&config, &db, &pools, &mut tail).await,
            _ = ticker.tick() => {
                drain_facts(&config, &db, &pools, &mut tail).await;
                // The tick is the only thing that reaches a queue nothing is
                // going to settle behind: a trip queued while the machine was
                // at its ceiling waits for a slot to come free, and the settle
                // that would have freed one may have died with another
                // instance. Without this the queue is drained only by a settle
                // that already happened, which on an idle machine is never.
                spawn_drain(&config, &db, &pools);
            }
            kicked = kick_rx.recv() => match kicked {
                Some(name) => serve_manual(&config, &db, &pools, name.as_str()),
                None => return,
            },
            recv = gh_rx.recv() => match recv {
                Ok(frame) => match serde_json::from_slice::<GitHeadSignal>(&frame.payload) {
                    // The git read finishes before the connection is touched.
                    // That ordering is the ledger's no-transaction-across-await
                    // rule made structural: `&Connection` is not `Send`, so a
                    // borrow spanning this await would not compile at all.
                    Ok(signal) => {
                        if let Some(event) = commit_event(signal).await {
                            work_event(&config, &db, &pools, &event);
                        }
                    }
                    Err(e) => warn!(error = %e, "tripwire engine: unreadable GIT_HEAD signal"),
                },
                // A dropped signal is a HEAD move nobody saw. There is nothing
                // to re-derive — the next move will carry its own sha — so the
                // lag is noted and the loop continues rather than pretending.
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(missed = n, "tripwire engine: missed GIT_HEAD signals");
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

/// Read every fact past the tail and evaluate each one.
async fn drain_facts(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    pools: &Arc<TripwirePools>,
    tail: &mut i64,
) {
    loop {
        let batch = match config.ledger.facts_after(*tail, FACT_TAIL_CAP) {
            Ok(batch) => batch,
            Err(e) => {
                warn!(error = %e, "tripwire engine: fact tail read failed");
                return;
            }
        };
        if batch.is_empty() {
            return;
        }
        for row in &batch {
            *tail = row.id;
            let Some(event) = fact_event(config, row) else {
                continue;
            };
            work_event(config, db, pools, &event);
        }
        if batch.len() < FACT_TAIL_CAP {
            return;
        }
    }
}

/// One fact as an event, or `None` when it must not be considered at all.
///
/// The tripwire-session drop lives here rather than in the per-tripwire loop because
/// it is a property of the event, not of any tripwire: a fact a tripwire's own session
/// produced is not evidence about the project, it is the tripwire's own residue.
fn fact_event(
    config: &TripwireEngineConfig,
    row: &crate::session_ledger::FactRow,
) -> Option<TripwireEvent> {
    let payload = serde_json::from_str(&row.payload).unwrap_or(serde_json::Value::Null);
    let (project_dir, session_card) = match &row.session_id {
        Some(id) => match config.ledger.get(id) {
            Ok(Some(session)) => (Some(session.project_dir), session.card_id),
            // A fact whose session the ledger cannot name is app-scoped or
            // orphaned. It still counts; it simply matches no scoped tripwire.
            _ => (None, None),
        },
        None => (None, None),
    };
    if session_card
        .as_deref()
        .is_some_and(|card| card.starts_with(TRIPWIRE_CARD_PREFIX))
    {
        return None;
    }
    Some(TripwireEvent::Fact {
        kind: row.kind.clone(),
        payload,
        project_dir,
        session_card,
        seq: row.id,
    })
}

/// Resolve a HEAD move into a commit event, or `None` when there is no commit
/// to be about.
async fn commit_event(signal: GitHeadSignal) -> Option<TripwireEvent> {
    if signal.head.is_empty() {
        // An unborn or non-repo workspace has no commit to be about.
        return None;
    }
    let branch = current_branch(&signal.workspace_key).await;
    Some(TripwireEvent::Commit {
        branch,
        sha: signal.head,
        workspace_path: signal.workspace_key,
    })
}

/// The workspace's current branch, or `None` when detached or unreadable.
///
/// `None` is not "any branch": a tripwire narrowed to `main` must not fire on a
/// branch nobody could name, which is what the predicate's own commit arm
/// enforces.
async fn current_branch(workspace: &str) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!branch.is_empty()).then_some(branch)
}

/// Serve a hand-fired trip: find the tripwire's queued manual row and work it.
///
/// The CLI wrote the row before this arrived, so there is nothing to claim —
/// the queue already holds the firing, and this is only the nudge that says
/// not to wait for the tick.
fn serve_manual(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    pools: &Arc<TripwirePools>,
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
        start_run(
            &conn,
            &tripwire,
            queued.id,
            &queued.event_key,
            queued.event_payload.clone(),
        )
    };
    spawn_run(config, db, pools, run);
}

/// The outcome of considering one tripwire against one event — the whole of what
/// the guard half decides, named so a test can assert on it rather than on
/// whatever rows happened to appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The predicate or the scope said no.
    NoMatch,
    /// Refused before any work, for the named reason.
    Swallowed(&'static str),
    /// Serviceable, but the machine is busy.
    Queued,
    /// Claimed, past every guard, and handed on to its tier.
    Fired,
}

/// Consider every armed tripwire against one event.
///
/// The tripwires table is re-read per event rather than cached, which is what
/// makes `pause` and `edit` apply on the next firing with no notification
/// plumbing at all: the next event reads the row as it now stands.
pub fn evaluate(
    config: &TripwireEngineConfig,
    conn: &Connection,
    event: &TripwireEvent,
) -> (Vec<(String, Decision)>, Vec<PendingRun>) {
    let tripwires = match ledger::armed(conn) {
        Ok(tripwires) => tripwires,
        Err(e) => {
            warn!(error = %e, "tripwire engine: cannot read the tripwires table");
            return (Vec::new(), Vec::new());
        }
    };
    let mut decisions = Vec::with_capacity(tripwires.len());
    let mut pending = Vec::new();
    for tripwire in &tripwires {
        let (decision, run) = consider(config, conn, tripwire, event);
        decisions.push((tripwire.name.clone(), decision));
        if let Some(run) = run {
            pending.push(run);
        }
    }
    (decisions, pending)
}

fn consider(
    config: &TripwireEngineConfig,
    conn: &Connection,
    tripwire: &Tripwire,
    event: &TripwireEvent,
) -> (Decision, Option<PendingRun>) {
    let Ok(predicate) = tripwire.predicate() else {
        // A trigger this build cannot read belongs to a newer one. The tripwire
        // stays listable and removable; it simply never fires here.
        return (Decision::NoMatch, None);
    };
    if !tripwire_predicate::matches(&predicate, event) {
        return (Decision::NoMatch, None);
    }
    if !in_scope(tripwire.scope.as_deref(), event.project_path()) {
        return (Decision::NoMatch, None);
    }

    let now = (config.now_ms)();
    let key = event_key(event, &config.instance);

    let payload = event_payload(event);

    // The claim comes first, and every later refusal is a transition on the
    // row it made. Asking about the cooldown first would have the loser of a
    // race between two instances write a `cooldown` row for a firing the
    // winner already owns — a log that names the wrong reason for the right
    // outcome. Claiming first keeps one event to one row per tripwire, which is
    // what the unique constraint already promises.
    match ledger::claim_trip(
        conn,
        tripwire.id,
        &key,
        now,
        &config.instance,
        payload.as_deref(),
    ) {
        // Another instance owns this firing. Stop, silently: saying anything
        // would be two instances narrating one event.
        Ok(Claim::AlreadyClaimed) => (Decision::NoMatch, None),
        Err(e) => {
            warn!(error = %e, tripwire = %tripwire.name, "tripwire engine: claim failed");
            (Decision::NoMatch, None)
        }
        Ok(Claim::Claimed { trip_id }) => {
            // A work tripwire cannot arm without a scope, so one reaching this
            // point is a row laid by an older build. Re-checked here rather
            // than trusted, and swallowed with its reason: the claim is
            // already made, and a tripwire that cannot run has to say so
            // somewhere a reader will look [B07].
            if tripwire.resolved_tier() == Tier::Work && tripwire.scope.is_none() {
                let _ = ledger::set_status(conn, trip_id, TripStatus::Swallowed, Some("no-scope"));
                return (Decision::Swallowed("no-scope"), None);
            }
            // A firing inside the tripwire's own window: the flapping case, and
            // the swallow is this row rather than a second one. It stops
            // counting toward the window the moment it is written, so a tripwire
            // that swallows does not push its own next firing further away.
            if let Some(last) = ledger::previous_active_trip_at(conn, tripwire.id, trip_id)
                .ok()
                .flatten()
                && now - last < tripwire.cooldown_secs * 1_000
            {
                let _ = ledger::set_status(conn, trip_id, TripStatus::Swallowed, Some("cooldown"));
                return (Decision::Swallowed("cooldown"), None);
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
        tier: tripwire.resolved_tier(),
        model: tripwire.model.clone(),
        brief: tripwire.brief.clone(),
        scope: tripwire.scope.clone(),
        probe: tripwire.probe.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        post: tripwire.post_policy(),
        engine_refs: context.refs,
        project_dir: context.project_dir,
        session_id: None,
        dash: None,
        evidence,
    }
}

/// Work one pending trip: the tier's turn, then the settle.
///
/// Split from `evaluate` because this is the half that awaits. No ledger
/// connection is in scope for the turn itself — the caller holds it and takes
/// it up again at the settle — which is the no-transaction-across-await rule
/// standing on the type system rather than on anybody remembering it.
pub async fn run_pending(
    config: &TripwireEngineConfig,
    db: &Db,
    pools: &TripwirePools,
    run: &mut PendingRun,
) -> Settled {
    match run.tier {
        Tier::Verdict | Tier::Auto => run_verdict(pools, run).await,
        Tier::Work => run_work(config, db, run).await,
    }
}

/// The work tier: a dash, a probe, and — only if the probe could not settle it
/// — a session with hands ([P05], [P15]).
///
/// The order is the point. The dash comes first because the probe may write
/// and must not write on the user's checkout. The probe comes next because it
/// is free, and a green probe settles the trip with no tokens spent at all —
/// which is what makes an armed tripwire cheap enough to leave armed. The session
/// is last, and runs only on the residue the probe could not answer.
async fn run_work(config: &TripwireEngineConfig, db: &Db, run: &mut PendingRun) -> Settled {
    let Some(sessions) = config.sessions.clone() else {
        // No runner, so nothing can be asked. The firing is a recorded fact
        // about the tripwire and no more; it is not a failure, because the tripwire
        // matched, the guards passed, and nothing claims work was done.
        return Settled::logged(format!(
            "{} fired, and this instance has no session runner to ask",
            run.tripwire
        ));
    };
    let Some(scope) = run.scope.clone() else {
        return Settled::failed(
            "the tripwire runs at the work tier and named no scope, so there is no checkout to \
             stage its work in"
                .to_string(),
        );
    };
    let repo_root = PathBuf::from(&scope);
    let dash = tripwire_dash_name(&run.tripwire, &run.event_key);

    let created = match tokio::task::spawn_blocking({
        let repo_root = repo_root.clone();
        let dash = dash.clone();
        let tripwire = run.tripwire.clone();
        move || {
            let outcome = tugdash_core::ops::create_in(
                &repo_root,
                &dash,
                Some(format!("tripwire {tripwire}")),
                false,
                None,
            )?;
            tugdash_core::ops::set_laid_by(&repo_root, &dash, &format!("tripwire/{tripwire}"));
            Ok::<_, String>(outcome)
        }
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(e)) => {
            return Settled::failed(format!("the tripwire's dash could not be created: {e}"));
        }
        Err(e) => return Settled::failed(format!("the tripwire's dash could not be created: {e}")),
    };
    let worktree = PathBuf::from(&created.worktree);
    {
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_run(&conn, run.trip_id, None, Some(&dash));
    }

    // The probe, when the tripwire has one. Its exit is the tier's own decision
    // procedure: green means the thing the tripwire watches for is not wrong here,
    // and no model needs to be asked.
    if let Some(command) = run.probe.clone() {
        let probe = run_probe(&command, &worktree).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            let _ = ledger::record_probe(&conn, run.trip_id, probe.exit, &probe.tail);
        }
        if probe.exit == 0 {
            cleanup_dash(&repo_root, &dash).await;
            return Settled::logged(format!("`{command}` exited 0; nothing to report"));
        }
        run.evidence = format!(
            "{}\n\nThe probe `{command}` exited {}. Its output ends:\n{}",
            run.evidence, probe.exit, probe.tail
        );
    }

    // Somebody is about to be told something, and the run may take twenty
    // minutes. The placeholder is how the Overview says so now rather than
    // after the fact ([P09]) — transient, so it leaves nothing behind when the
    // real post replaces it.
    post_placeholder(config, run);

    let outcome = sessions
        .run(tripwire_session::TripwireSessionRequest {
            tripwire: run.tripwire.clone(),
            worktree: worktree.clone(),
            permission_mode: run.permission_mode.clone(),
            model: run.model.clone(),
            prompt: compose_work_prompt(run, &dash),
        })
        .await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(e) => {
            cleanup_or_keep(run, &repo_root, &dash).await;
            return Settled::failed(format!("the tripwire's session did not run: {e}"));
        }
    };
    run.session_id = Some(outcome.session_id.clone());
    {
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_run(&conn, run.trip_id, Some(&outcome.session_id), Some(&dash));
    }

    let envelope = tripwire_agent::parse_tripwire_envelope(&outcome.transcript);
    let kept = cleanup_or_keep(run, &repo_root, &dash).await;
    let Some(envelope) = envelope else {
        return Settled::failed(if outcome.completed {
            "the tripwire's session finished with no readable envelope".to_string()
        } else {
            "the tripwire's session did not finish inside its twenty minutes".to_string()
        });
    };
    let mut settled = Settled::from_envelope(&envelope);
    if kept {
        // Commits on the branch are the fact; the envelope is a report about
        // it. A session that did the work and then under-claimed would
        // otherwise leave a dash on the machine that nothing tells anybody
        // about, which is the one outcome this tier must not produce.
        settled.settlement.outcome = Some(Outcome::Staged.as_str().to_string());
        settled.settlement.interest =
            Some(tripwire_agent::Interest::Interesting.as_str().to_string());
    }
    settled
}

/// The dash a firing stages on: `tripwire-<tripwire>-<key8>`.
///
/// Derived from the event key rather than minted, so the same firing named
/// twice — a queued trip drained after a restart — is the same dash and not a
/// second one, and *different* firings are never the same dash.
///
/// A commit sha is already legal dash-name material, so it keeps its own first
/// eight characters: a dash a person will open is worth naming after the thing
/// it is about. Every other key is digested instead of sanitized. Sanitizing
/// drops the punctuation a fact key carries its discriminator behind, so eight
/// surviving characters are eight characters of the *shape* `fact:<instance>:`
/// — identical for every firing of one tripwire. Two firings sharing a name is not
/// a cosmetic collision: `create_in` is idempotent, so the second adopts the
/// first's dash, counts its rounds as its own, and a green probe on the second
/// discards the work the first staged.
fn tripwire_dash_name(tripwire: &str, event_key: &str) -> String {
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
    format!("tripwire-{tripwire}-{key8}")
}

/// What a probe said.
struct ProbeResult {
    exit: i64,
    tail: String,
}

/// Run a tripwire's probe in its dash worktree, under a deadline.
///
/// The environment is inherited, with two changes. `TUG_SESSION_ID` is removed
/// — a probe is not a session, and leaking whichever session tugcast last
/// handled would attribute the probe's writes to a card that never ran it —
/// and the pagers are pinned off, because a probe with no terminal that pages
/// its output waits for a keypress nobody is there to give. `TUG_INSTANCE_ID`
/// rides through untouched, so a `tugutil` inside the probe addresses this
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

/// Keep the dash if it holds commits, remove it if it does not ([P15]).
///
/// Returns whether it was kept. A dash whose branch tip is still its base is a
/// worktree nobody wrote in, and leaving one behind per firing would fill the
/// machine with empty dashes — the eager half of [B07]'s lazy-create,
/// eager-clean pair.
async fn cleanup_or_keep(run: &mut PendingRun, repo_root: &std::path::Path, dash: &str) -> bool {
    let rounds = {
        let repo_root = repo_root.to_path_buf();
        let dash = dash.to_string();
        tokio::task::spawn_blocking(move || tugdash_core::ops::round_count_in(&repo_root, &dash))
            .await
            .unwrap_or(0)
    };
    if rounds == 0 {
        cleanup_dash(repo_root, dash).await;
        return false;
    }
    run.dash = Some(dash.to_string());
    run.engine_refs.push(OverviewRef {
        kind: OverviewRefKind::Dash,
        target: dash.to_string(),
    });
    true
}

async fn cleanup_dash(repo_root: &std::path::Path, dash: &str) {
    let repo_root = repo_root.to_path_buf();
    let dash_name = dash.to_string();
    let removed = tokio::task::spawn_blocking(move || {
        tugdash_core::ops::discard_in(&repo_root, &dash_name, Some("tripwire"), false)
    })
    .await;
    if let Ok(Err(e)) = removed {
        warn!(dash, error = %e, "tripwire: the tripwire's empty dash could not be removed");
    }
}

/// What the work-tier session is told.
///
/// The brief is the tripwire's own words; the evidence is what happened; the rest
/// is the standing contract — how to commit, that joining is not its to do,
/// and the envelope it has to close with.
fn compose_work_prompt(run: &PendingRun, dash: &str) -> String {
    format!(
        "{brief}\n\nWhat happened:\n{evidence}\n\n\
         You are working on the dash `{dash}`, in the worktree this session opened in. \
         Commit with `tugutil dash commit {dash} --message \"<subject>\"` — that is the only \
         path that commits here, and joining the work back is the user's act, never yours. \
         If there is nothing worth changing, change nothing and say so.\n\n\
         Close your turn with one JSON object on its own line:\n\
         {contract}\n\
         `outcome` is \"staged\" when you left commits on the dash and \"verdict\" when you \
         did not. `headline` is one sentence a reader who saw none of this will understand.",
        brief = run.brief,
        evidence = run.evidence,
        contract = tripwire_agent::ENVELOPE_CONTRACT,
    )
}

/// Say that a tripwire is working, before it has anything to report.
///
/// Transient ([P09]): it is a live signal rather than a record, so it is
/// broadcast and never written down. A run that dies without settling leaves
/// no orphaned claim behind, because there was never a row.
fn post_placeholder(config: &TripwireEngineConfig, run: &PendingRun) {
    let Some(overview_tx) = config.overview_tx.as_ref() else {
        return;
    };
    if run.post == PostPolicy::Never {
        return;
    }
    let record = OverviewPost {
        id: None,
        at_ms: (config.now_ms)(),
        author: OverviewAuthor::Tripwire,
        session_id: None,
        wake_reason: Some(format!("tripwire:{}", run.tripwire)),
        body: format!("{} is working on what it found.", run.tripwire),
        refs: run.engine_refs.clone(),
        elapsed_ms: None,
        project_dir: run.project_dir.clone(),
        attachments: Vec::new(),
        request_id: None,
        transient: true,
    };
    if let Ok(bytes) = serde_json::to_vec(&record) {
        let _ = overview_tx.send(Frame::new(FeedId::OVERVIEW, bytes));
    }
}

/// One pool turn, read as an envelope.
async fn run_verdict(pools: &TripwirePools, run: &PendingRun) -> Settled {
    let pool = pools.for_model(run.model.as_deref());
    let input = tripwire_agent::compose_input(&run.brief, &run.evidence);
    let answer = match pool.run(tripwire_agent::TRIPWIRE_VERDICT, input).await {
        Ok(answer) => answer,
        Err(e) => {
            warn!(tripwire = %run.tripwire, error = %e, "tripwire: the verdict turn failed");
            return Settled::failed(format!("the tripwire's turn did not complete: {e}"));
        }
    };
    let Some(envelope) = tripwire_agent::parse_tripwire_envelope(&answer) else {
        // A tripwire that was asked a question and did not answer has to say so.
        // Silence here would make a tripwire broken for a week look exactly like a
        // tripwire with nothing to report.
        warn!(tripwire = %run.tripwire, "tripwire: no readable envelope in the answer");
        return Settled::failed("the tripwire's answer carried no readable envelope".to_string());
    };
    // A verdict-tier tripwire has no hands, so a claim of staged work is a
    // contract violation rather than something to reinterpret. Reading it as
    // a verdict would put a model's mistaken claim in the log as a fact.
    if envelope.outcome == Outcome::Staged {
        warn!(tripwire = %run.tripwire, "tripwire: a no-hands tripwire claimed staged work");
        return Settled::failed(
            "the tripwire has no hands and claimed staged work, so its answer was not read"
                .to_string(),
        );
    }
    Settled::from_envelope(&envelope)
}

/// How a trip finished, ready for the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub status: TripStatus,
    pub settlement: ledger::Settlement,
}

impl Settled {
    /// The floor: the firing happened and nothing was asked about it.
    ///
    /// It still carries a headline. A settlement with none cannot be posted at
    /// all — `post_settled` has no body to send — so a tripwire laid `--post
    /// always` to shake it down would say nothing on exactly the outcome a
    /// probe-carrying tripwire produces most: green. `auto` still stays quiet on
    /// it, because that is `interest` doing its job rather than an absent
    /// sentence doing it by accident.
    fn logged(headline: String) -> Self {
        Settled {
            status: TripStatus::Settled,
            settlement: ledger::Settlement {
                interest: Some(tripwire_agent::Interest::Routine.as_str().to_string()),
                outcome: Some(Outcome::Verdict.as_str().to_string()),
                headline: Some(headline),
                refs: None,
            },
        }
    }

    /// A run that produced no outcome, and says why in the headline a reader
    /// of the trip log will actually see.
    fn failed(headline: String) -> Self {
        Settled {
            status: TripStatus::Failed,
            settlement: ledger::Settlement {
                interest: Some(tripwire_agent::Interest::Interesting.as_str().to_string()),
                outcome: None,
                headline: Some(headline),
                refs: None,
            },
        }
    }

    fn from_envelope(envelope: &tripwire_agent::TripwireEnvelope) -> Self {
        // Staged work is always worth telling, whatever the model said about
        // it: a dash left on the machine that nobody is told about is a dash
        // nobody joins.
        let interest = if envelope.outcome == Outcome::Staged {
            tripwire_agent::Interest::Interesting
        } else {
            envelope.interest
        };
        let refs = envelope.known_refs();
        Settled {
            status: TripStatus::Settled,
            settlement: ledger::Settlement {
                interest: Some(interest.as_str().to_string()),
                outcome: Some(envelope.outcome.as_str().to_string()),
                headline: Some(envelope.headline.clone()),
                refs: (!refs.is_empty()).then(|| serde_json::to_string(&refs).unwrap_or_default()),
            },
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
        tier = run.tier.as_str(),
        status = settled.status.as_str(),
        "tripwire settled"
    );
    post_settled(config, run, settled);
}

/// Whether this outcome reaches the Overview.
///
/// `auto` is the judgment the tripwire's own turn made: a routine firing is a row
/// in the trip log and nothing more, which is what keeps an armed tripwire from
/// filling the channel with the pattern it was laid to watch for. A failure
/// always posts under `auto`, because a tripwire that has stopped working is
/// exactly the thing nobody would otherwise find out about.
fn should_post(policy: PostPolicy, settled: &Settled) -> bool {
    match policy {
        PostPolicy::Never => false,
        PostPolicy::Always => true,
        PostPolicy::Auto => {
            settled.status == TripStatus::Failed
                || settled.settlement.interest.as_deref()
                    == Some(tripwire_agent::Interest::Interesting.as_str())
        }
    }
}

/// Post a settled trip to the Overview.
///
/// The tripwire's name rides `wake_reason` as `tripwire:<name>`, which is what the
/// deck labels the row from — the author says a tripwire spoke, and the reason
/// says which one.
///
/// Two provenances of ref, and they are not the same claim. The engine's own —
/// the firing commit's sha, the session, a staged dash — are facts it wrote
/// down, so they are attached directly. The model's are the hallucination case
/// the Observer's validator exists for, and they arrive already narrowed to
/// the kinds this build can resolve.
fn post_settled(config: &TripwireEngineConfig, run: &PendingRun, settled: &Settled) {
    let Some(overview_tx) = config.overview_tx.as_ref() else {
        return;
    };
    if !should_post(run.post, settled) {
        return;
    }
    let Some(body) = settled.settlement.headline.clone() else {
        // Nothing to say. The log-only floor settles with no headline, and a
        // post with an empty body is worse than no post.
        return;
    };

    let mut refs = run.engine_refs.clone();
    for authored in envelope_refs(settled) {
        if !refs.iter().any(|r| r.target == authored.target) {
            refs.push(authored);
        }
    }

    let mut record = OverviewPost {
        id: None,
        at_ms: (config.now_ms)(),
        author: OverviewAuthor::Tripwire,
        session_id: run.session_id.clone(),
        wake_reason: Some(format!("tripwire:{}", run.tripwire)),
        body,
        refs,
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

/// The refs the model named, as the Overview's own kinds. Already narrowed to
/// the resolvable spellings by the envelope; a kind that survived that and
/// still does not parse here is dropped rather than repaired.
fn envelope_refs(settled: &Settled) -> Vec<OverviewRef> {
    let Some(raw) = settled.settlement.refs.as_deref() else {
        return Vec::new();
    };
    let Ok(authored) = serde_json::from_str::<Vec<tripwire_agent::TripwireRef>>(raw) else {
        return Vec::new();
    };
    authored
        .into_iter()
        .filter_map(|r| {
            Some(OverviewRef {
                kind: parse_ref_kind(&r.kind)?,
                target: r.target,
            })
        })
        .collect()
}

fn parse_ref_kind(kind: &str) -> Option<OverviewRefKind> {
    match kind {
        "session" => Some(OverviewRefKind::Session),
        "file" => Some(OverviewRefKind::File),
        "commit" => Some(OverviewRefKind::Commit),
        "dash" => Some(OverviewRefKind::Dash),
        _ => None,
    }
}

/// Whether an event's path falls under a tripwire's scope.
///
/// Raw prefix, compared as canonical paths, and deliberately **not** folded to
/// a base checkout: a work-tier tripwire commits on its own dash worktree, and
/// folding worktrees into the checkout they forked from would make those
/// commits re-trip the tripwire that made them. An unscoped tripwire watches the
/// machine; a scoped tripwire against an event with no path matches nothing,
/// because a scope that was given cannot be silently ignored.
fn in_scope(scope: Option<&str>, path: Option<&str>) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    let Some(path) = path else {
        return false;
    };
    let scope = scope.trim_end_matches('/');
    path == scope || path.starts_with(&format!("{scope}/"))
}

/// The key the claim arbitrates on.
///
/// A commit's is its sha, so two instances seeing one commit is one firing and
/// a re-checkout of a tripped sha is none. A fact takes the instance it was
/// read in and its rowid there: a session ledger is per-instance, so no two
/// engines ever read one fact, and qualifying by instance is what stops one
/// instance's fact 42 from being read as another's. Deliberately not the
/// arrival time — two facts of one kind landing in one millisecond would share
/// a key, and the loser of that claim is a firing with no row at all, which is
/// the one silence this facility is built to refuse.
fn event_key(event: &TripwireEvent, instance: &str) -> String {
    match event {
        TripwireEvent::Commit { sha, .. } => sha.clone(),
        TripwireEvent::Fact { seq, .. } => format!("fact:{instance}:{seq}"),
    }
}

/// The evidence a trip carries forward — what the tiers show a model, and
/// what the post is composed from.
///
/// Where the event happened rides along with what happened, because both
/// readers want it: a model diagnosing a failed edit is helped by knowing the
/// project, and a post has to land on that project's Overview. Writing it here
/// is also what lets a trip drained off the queue minutes later compose the
/// same post as one worked immediately — the live event is gone by then, and
/// this row is the only record of it there is.
fn event_payload(event: &TripwireEvent) -> Option<String> {
    match event {
        TripwireEvent::Fact {
            kind,
            payload,
            project_dir,
            session_card,
            seq,
        } => serde_json::to_string(&serde_json::json!({
            "kind": kind,
            "payload": payload,
            "project_dir": project_dir,
            "session_card": session_card,
            "seq": seq,
        }))
        .ok(),
        TripwireEvent::Commit {
            branch,
            sha,
            workspace_path,
        } => serde_json::to_string(&serde_json::json!({
            "branch": branch,
            "sha": sha,
            "workspace": workspace_path,
        }))
        .ok(),
    }
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
    let str_field = |name: &str| {
        value
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
        project_dir: str_field("project_dir").or_else(|| str_field("workspace")),
    }
}

/// Whether a tripwire's resolved tier needs a worktree — read by the tiers that
/// follow, and named here because the guard half already knows the answer.
#[allow(dead_code)]
pub fn needs_worktree(tripwire: &Tripwire) -> bool {
    tripwire.resolved_tier() == Tier::Work
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_agent::AgentWorkerSpawner;
    use crate::shared_agent::test_support::FakeSpawner;
    use tugutil_core::tripwire_ledger::NewTripwire;

    /// A clock the test moves by hand, so two events can sit inside one
    /// cooldown window without anybody sleeping through it.
    #[derive(Clone)]
    struct TestClock(Arc<std::sync::Mutex<i64>>);

    impl TestClock {
        fn new(at: i64) -> Self {
            TestClock(Arc::new(std::sync::Mutex::new(at)))
        }
        fn advance(&self, ms: i64) {
            *self.0.lock().unwrap() += ms;
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
            instance: "inst-a".to_string(),
            now_ms: clock.as_now(),
            spawner: FakeSpawner::always(Ok("{}".to_string())),
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
            &NewTripwire::new(name, trigger, "diagnose the failure and propose a fix"),
            1,
        )
        .unwrap()
    }

    fn fact_event(kind: &str, project_dir: Option<&str>, card: Option<&str>) -> TripwireEvent {
        // A fresh rowid per call, because each call stands for a separate
        // fact. A fixed one would make two firings one claim, and quietly turn
        // every cooldown and ceiling test into a test of the key instead.
        static SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
        TripwireEvent::Fact {
            kind: kind.to_string(),
            payload: serde_json::json!({"class": "resolve"}),
            project_dir: project_dir.map(str::to_owned),
            session_card: card.map(str::to_owned),
            seq: SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
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
        event: &TripwireEvent,
    ) -> Vec<(String, Decision)> {
        evaluate(config, conn, event).0
    }

    /// Decide and settle in one go, the way the loop does, against a scripted
    /// model.
    async fn work(
        config: &TripwireEngineConfig,
        conn: &Connection,
        pools: &TripwirePools,
        event: &TripwireEvent,
    ) -> Vec<(String, Decision)> {
        let (decisions, mut pending) = evaluate(config, conn, event);
        // The run half opens its own handle. `run_pending` takes the ledger
        // behind the mutex that makes the no-transaction-across-await rule a
        // compile error; the bare connection here is the assertion half's, and
        // the two are separate for the same reason the engine's are.
        let db: Db = Mutex::new(ledger::open_ledger(&config.db_path).unwrap());
        for run in &mut pending {
            let settled = run_pending(config, &db, pools, run).await;
            settle(config, conn, run, &settled);
        }
        decisions
    }

    fn scripted(answers: Vec<Result<String, String>>) -> (TripwirePools, Arc<FakeSpawner>) {
        let spawner = FakeSpawner::new(answers);
        let pools = TripwirePools::new(Arc::clone(&spawner) as Arc<dyn AgentWorkerSpawner>);
        (pools, spawner)
    }

    fn statuses(conn: &Connection, wire_id: i64) -> Vec<String> {
        ledger::trips_for_tripwire(conn, wire_id, 20)
            .unwrap()
            .into_iter()
            .map(|t| t.status)
            .collect()
    }

    #[tokio::test]
    async fn a_matching_fact_fires_the_tripwire_and_settles_from_the_models_envelope() {
        let h = harness();
        let tripwire = lay(&h.conn, "tugedit", r#"{"fact":{"kind":"edit_failed"}}"#);
        let (pools, spawner) = scripted(vec![Ok(r#"{"interest":"interesting","outcome":"verdict","headline":"a.rs went stale","refs":[{"kind":"file","target":"a.rs"}]}"#.to_string())]);
        let out = work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;
        assert_eq!(decision(&out, "tugedit"), Decision::Fired);

        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].status, "settled");
        assert_eq!(trips[0].interest.as_deref(), Some("interesting"));
        assert_eq!(trips[0].outcome.as_deref(), Some("verdict"));
        assert_eq!(trips[0].headline.as_deref(), Some("a.rs went stale"));
        assert!(
            trips[0].refs.as_deref().unwrap().contains("a.rs"),
            "{:?}",
            trips[0].refs
        );
        assert_eq!(trips[0].instance, "inst-a");
        assert!(
            trips[0]
                .event_payload
                .as_deref()
                .unwrap()
                .contains("edit_failed"),
            "the evidence rides the row: {:?}",
            trips[0].event_payload
        );

        // The brief is the question and the evidence is what it is asked
        // about, and both reached the model.
        let seen = spawner.turns_seen();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0].contains("BRIEF\ndiagnose the failure and propose a fix"),
            "{}",
            seen[0]
        );
        assert!(seen[0].contains("edit_failed"), "{}", seen[0]);
    }

    #[test]
    fn a_fact_of_another_kind_never_reaches_the_claim() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(&h.config, &h.conn, &fact_event("shell", None, None));
        assert_eq!(decision(&out, "w"), Decision::NoMatch);
        assert!(statuses(&h.conn, tripwire.id).is_empty(), "no row at all");
    }

    /// `pause` applies on the next firing because the table is re-read per
    /// event — there is no notification to forget to send.
    #[test]
    fn a_paused_tripwire_is_not_even_considered() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        ledger::set_paused(&h.conn, "w", true).unwrap();

        let out = decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        assert!(out.is_empty(), "an armed-only read: {out:?}");
        assert!(statuses(&h.conn, tripwire.id).is_empty());

        ledger::set_paused(&h.conn, "w", false).unwrap();
        let out = decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    #[test]
    fn a_scoped_tripwire_ignores_a_foreign_path_and_takes_one_beneath_it() {
        let h = harness();
        let mut tripwire = NewTripwire::new(
            "w",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        tripwire.scope = Some("/proj".to_string());
        ledger::lay(&h.conn, &tripwire, 1).unwrap();

        let foreign = decisions(
            &h.config,
            &h.conn,
            &fact_event("edit_failed", Some("/elsewhere"), None),
        );
        assert_eq!(decision(&foreign, "w"), Decision::NoMatch);

        // A sibling whose name merely starts with the scope is not under it.
        let sibling = decisions(
            &h.config,
            &h.conn,
            &fact_event("edit_failed", Some("/project-other"), None),
        );
        assert_eq!(decision(&sibling, "w"), Decision::NoMatch);

        let beneath = decisions(
            &h.config,
            &h.conn,
            &fact_event("edit_failed", Some("/proj/src"), None),
        );
        assert_eq!(decision(&beneath, "w"), Decision::Fired);
    }

    /// A scope that was given cannot be silently ignored, so an event with no
    /// path matches no scoped tripwire.
    #[test]
    fn a_scoped_tripwire_matches_no_pathless_event() {
        let h = harness();
        let mut tripwire = NewTripwire::new(
            "scoped",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        tripwire.scope = Some("/proj".to_string());
        ledger::lay(&h.conn, &tripwire, 1).unwrap();
        lay(&h.conn, "unscoped", r#"{"fact":{"kind":"edit_failed"}}"#);

        let out = decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        assert_eq!(decision(&out, "scoped"), Decision::NoMatch);
        assert_eq!(
            decision(&out, "unscoped"),
            Decision::Fired,
            "an unscoped tripwire watches the machine"
        );
    }

    /// A dash worktree is not folded into the checkout it forked from — that
    /// folding is what would make a work-tier tripwire re-trip on its own commits.
    #[test]
    fn a_worktree_path_is_not_folded_into_its_base_checkout() {
        assert!(in_scope(Some("/proj"), Some("/proj/.tug/worktrees/x")));
        assert!(
            !in_scope(Some("/proj/.tug/worktrees/x"), Some("/proj")),
            "a scope on the worktree does not reach back to the base"
        );
        assert!(in_scope(None, Some("/anywhere")));
        assert!(
            in_scope(Some("/proj/"), Some("/proj/src")),
            "a trailing slash is not a different scope"
        );
    }

    #[test]
    fn a_commit_event_honors_the_branch_filter_and_keys_on_the_sha() {
        let h = harness();
        let main = lay(&h.conn, "main-only", r#"{"commit":{"branch":"main"}}"#);
        lay(&h.conn, "any-branch", r#"{"commit":{}}"#);

        let on_dash = TripwireEvent::Commit {
            branch: Some("tugdash/x".to_string()),
            sha: "abc123".to_string(),
            workspace_path: "/proj".to_string(),
        };
        let out = decisions(&h.config, &h.conn, &on_dash);
        assert_eq!(decision(&out, "main-only"), Decision::NoMatch);
        assert_eq!(decision(&out, "any-branch"), Decision::Fired);

        // The same sha again is the same firing, whoever sees it.
        h.clock.advance(10 * 60 * 1_000);
        let out = decisions(&h.config, &h.conn, &on_dash);
        assert_eq!(
            decision(&out, "any-branch"),
            Decision::NoMatch,
            "a re-checkout of a tripped sha is not a new event"
        );
        assert!(statuses(&h.conn, main.id).is_empty());
    }

    /// Two facts of one kind arriving in one millisecond are two firings.
    ///
    /// Keyed by arrival time they were one: the second claim lost, `consider`
    /// read that as `NoMatch`, and the firing left no row at all — a firing
    /// that never happened and never said so, which is the one silence this
    /// facility exists to refuse.
    #[test]
    fn two_facts_in_one_millisecond_are_two_firings() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        // No cooldown, so a second row is refused for its key or not at all.
        ledger::update(
            &h.conn,
            "w",
            &ledger::TripwireEdit {
                cooldown_secs: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        for _ in 0..2 {
            decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        }
        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 50).unwrap();
        assert_eq!(trips.len(), 2, "the clock never moved: {trips:?}");
    }

    #[test]
    fn a_second_firing_inside_the_window_is_swallowed_with_its_reason() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        assert_eq!(
            decision(
                &decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None)),
                "w"
            ),
            Decision::Fired
        );

        h.clock.advance(1_000);
        assert_eq!(
            decision(
                &decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None)),
                "w"
            ),
            Decision::Swallowed("cooldown")
        );

        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips[0].status, "swallowed");
        assert_eq!(trips[0].swallow_reason.as_deref(), Some("cooldown"));

        // Past the window it fires again — and the swallow did not extend it.
        h.clock.advance(tripwire.cooldown_secs * 1_000);
        assert_eq!(
            decision(
                &decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None)),
                "w"
            ),
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

        let out = decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
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

        decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        // Past the cooldown, so the second event is a queue rather than a
        // swallow.
        h.clock.advance(120_000);
        decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));

        assert_eq!(statuses(&h.conn, w.id), vec!["queued", "superseded"]);
    }

    /// Two engines over one ledger see one event once — the whole of the
    /// arbitration, exercised through the engine rather than the ledger.
    #[test]
    fn two_engines_over_one_ledger_claim_one_commit_once() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"commit":{}}"#);
        let second_conn = ledger::open_ledger(&h.config.db_path).unwrap();
        let second = TripwireEngineConfig {
            ledger: Arc::new(SessionLedger::open_in_memory().unwrap()),
            db_path: h.config.db_path.clone(),
            instance: "inst-b".to_string(),
            now_ms: h.clock.as_now(),
            spawner: FakeSpawner::always(Ok("{}".to_string())),
            sessions: None,
            overview_tx: None,
            cancel: CancellationToken::new(),
        };
        let event = TripwireEvent::Commit {
            branch: Some("main".to_string()),
            sha: "deadbeef".to_string(),
            workspace_path: "/proj".to_string(),
        };

        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &event), "w"),
            Decision::Fired
        );
        assert_eq!(
            decision(&decisions(&second, &second_conn, &event), "w"),
            Decision::NoMatch,
            "the loser stops silently"
        );
        assert_eq!(
            statuses(&h.conn, tripwire.id),
            vec!["running"],
            "one row, and the winner is working it"
        );
    }

    /// A trigger written against a grammar this build cannot read never fires
    /// — and never stops the tripwires beside it from being considered.
    #[test]
    fn an_unreadable_trigger_costs_its_own_tripwire_and_no_other() {
        let h = harness();
        lay(&h.conn, "future", r#"{"portent":{"omen":"raven"}}"#);
        lay(&h.conn, "ordinary", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(&h.config, &h.conn, &fact_event("edit_failed", None, None));
        assert_eq!(decision(&out, "future"), Decision::NoMatch);
        assert_eq!(decision(&out, "ordinary"), Decision::Fired);
    }

    /// A row left `running` by a dead tugcast holds a slot nothing will free.
    #[test]
    fn the_boot_sweep_fails_this_instances_orphans_only() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"commit":{}}"#);
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

    /// A tripwire was asked a question and did not answer. Silence here would make
    /// a tripwire broken for a week look exactly like a tripwire with nothing to say.
    #[tokio::test]
    async fn an_answer_with_no_readable_envelope_fails_the_trip_and_says_why() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let (pools, _) = scripted(vec![Ok("I could not tell.".to_string())]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;

        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips[0].status, "failed");
        assert!(
            trips[0].headline.as_deref().unwrap().contains("envelope"),
            "the trip log says what went wrong: {:?}",
            trips[0].headline
        );
        assert!(trips[0].settled_at_ms.is_some(), "a failure is settled too");
    }

    #[tokio::test]
    async fn a_turn_that_never_completes_fails_the_trip() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let (pools, _) = scripted(vec![Err("the worker died".to_string())]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;
        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips[0].status, "failed");
        assert!(
            trips[0]
                .headline
                .as_deref()
                .unwrap()
                .contains("did not complete"),
            "{:?}",
            trips[0].headline
        );
    }

    /// A verdict-tier tripwire has no hands, so a claim of staged work is a
    /// contract violation rather than something to quietly reinterpret.
    #[tokio::test]
    async fn a_no_hands_tripwire_claiming_staged_work_fails_rather_than_being_reread() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let (pools, _) = scripted(vec![Ok(
            r#"{"interest":"routine","outcome":"staged","headline":"I fixed it"}"#.to_string(),
        )]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;

        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips[0].status, "failed");
        assert!(
            trips[0].headline.as_deref().unwrap().contains("no hands"),
            "{:?}",
            trips[0].headline
        );
        assert_ne!(
            trips[0].outcome.as_deref(),
            Some("staged"),
            "a claim that could not be true is not recorded as one"
        );
    }

    /// A ref kind this build cannot resolve would render as an inert chip, so
    /// it is dropped — and the refs beside it are kept.
    #[tokio::test]
    async fn an_unknown_ref_kind_never_reaches_the_row() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let (pools, _) = scripted(vec![Ok(r#"{"interest":"routine","outcome":"verdict","headline":"h","refs":[{"kind":"portent","target":"raven"},{"kind":"commit","target":"abc1234"}]}"#.to_string())]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;

        let refs = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap()[0]
            .refs
            .clone()
            .unwrap();
        assert!(refs.contains("abc1234"));
        assert!(!refs.contains("raven"), "{refs}");
    }

    /// A tugcast that lends no session runner leaves the work tier at its
    /// floor: the firing is a recorded fact and no more — not a failure, and
    /// not a model turn. Nothing on disk is touched either, because the floor
    /// is reached before the dash would be created.
    #[tokio::test]
    async fn a_work_tier_tripwire_settles_at_the_log_only_floor_without_a_turn() {
        let h = harness();
        let mut new = NewTripwire::new(
            "ci",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        new.probe = Some("just ci".to_string());
        new.scope = Some("/tmp/tripwire-scope".to_string());
        let tripwire = ledger::lay(&h.conn, &new, 1).unwrap();
        assert_eq!(tripwire.resolved_tier(), Tier::Work);

        let (pools, spawner) = scripted(vec![Ok("never asked".to_string())]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", Some("/tmp/tripwire-scope"), None),
        )
        .await;

        let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
        assert_eq!(trips[0].status, "settled");
        assert_eq!(trips[0].interest.as_deref(), Some("routine"));
        // The floor still says what it was. A settlement with no headline can
        // never be posted at all, so `--post always` was silent on it.
        assert!(
            trips[0]
                .headline
                .as_deref()
                .is_some_and(|h| h.contains("no session runner")),
            "the floor says why nothing was asked: {:?}",
            trips[0].headline
        );
        assert!(
            spawner.turns_seen().is_empty(),
            "no model was summoned: {:?}",
            spawner.turns_seen()
        );
    }

    /// The tripwire's `model` column is what routes the turn, and a tripwire with none
    /// takes the default rather than nothing.
    #[tokio::test]
    async fn each_tripwires_model_column_routes_its_turn_to_that_models_pool() {
        let h = harness();
        let mut named = NewTripwire::new(
            "opus-tripwire",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        named.model = Some("opus".to_string());
        ledger::lay(&h.conn, &named, 1).unwrap();
        lay(
            &h.conn,
            "default-tripwire",
            r#"{"fact":{"kind":"edit_failed"}}"#,
        );

        let (pools, _) = scripted(vec![
            Ok(
                r#"{"interest":"routine","outcome":"verdict","headline":"h"}"#.to_string()
            );
            4
        ]);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "4").unwrap();
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;

        assert_eq!(
            pools.pool_count(),
            2,
            "two tripwires on two models are two pools"
        );
        assert!(Arc::ptr_eq(
            &pools.for_model(None),
            &pools.for_model(Some(tripwire_agent::DEFAULT_TRIPWIRE_MODEL)),
        ));
    }

    /// A settle frees a slot, and the trip that was waiting on it starts.
    #[tokio::test]
    async fn settling_a_trip_starts_the_one_that_was_queued_behind_it() {
        let h = harness();
        let busy = lay(&h.conn, "busy", r#"{"fact":{"kind":"edit_failed"}}"#);
        let waiting = lay(&h.conn, "waiting", r#"{"commit":{}}"#);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "1").unwrap();

        // Queue one by filling the machine, then free the slot.
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(&h.conn, busy.id, "other", 1, "inst-b", None).unwrap()
        else {
            panic!("claimed");
        };
        ledger::record_run(&h.conn, trip_id, None, None).unwrap();
        let event = TripwireEvent::Commit {
            branch: Some("main".to_string()),
            sha: "abc".to_string(),
            workspace_path: "/proj".to_string(),
        };
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

        let (pools, _) = scripted(vec![Ok(
            r#"{"interest":"routine","outcome":"verdict","headline":"drained"}"#.to_string(),
        )]);
        let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
        drain_queue(&h.config, &db, &pools).await;

        let trips = ledger::trips_for_tripwire(&h.conn, waiting.id, 10).unwrap();
        assert_eq!(trips[0].status, "settled");
        assert_eq!(trips[0].headline.as_deref(), Some("drained"));
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

    /// The whole reporting path: an interesting verdict becomes a post in the
    /// Tripwire's voice, on the tripwire's name, carrying both provenances of ref.
    #[tokio::test]
    async fn an_interesting_verdict_posts_as_the_tripwire_naming_its_tripwire() {
        let (h, mut rx) = posting_harness();
        lay(&h.conn, "ci", r#"{"commit":{}}"#);
        let (pools, _) = scripted(vec![Ok(r#"{"interest":"interesting","outcome":"verdict","headline":"the suite went red on abc1234","refs":[{"kind":"file","target":"src/a.rs"}]}"#.to_string())]);

        work(
            &h.config,
            &h.conn,
            &pools,
            &TripwireEvent::Commit {
                branch: Some("main".to_string()),
                sha: "abc1234".to_string(),
                workspace_path: "/proj".to_string(),
            },
        )
        .await;

        let written = posts(&h.config.ledger);
        assert_eq!(written.len(), 1, "{written:?}");
        let post = &written[0];
        assert_eq!(post.author, OverviewAuthor::Tripwire);
        assert_eq!(post.wake_reason.as_deref(), Some("tripwire:ci"));
        assert_eq!(post.body, "the suite went red on abc1234");
        assert_eq!(post.project_dir.as_deref(), Some("/proj"));

        // The engine's own ref rides first and unvalidated: it is a fact the
        // engine read off the HEAD signal, not a target a model named.
        assert_eq!(post.refs[0].kind, OverviewRefKind::Commit);
        assert_eq!(post.refs[0].target, "abc1234");
        assert_eq!(post.refs[1].kind, OverviewRefKind::File);
        assert_eq!(post.refs[1].target, "src/a.rs");

        // And it went out live, not only into the ledger.
        let frame = rx.try_recv().expect("a broadcast frame");
        assert_eq!(frame.feed_id, FeedId::OVERVIEW);
        let broadcast: OverviewPost = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(broadcast.author, OverviewAuthor::Tripwire);
        assert!(broadcast.id.is_some(), "the broadcast carries its row id");
    }

    /// The regression this pins is the engine's own dash ref being eaten:
    /// a generated tripwire dash name appears nowhere in what the model was
    /// shown, so passing it through the Observer's validator would silently
    /// drop the chip the post exists to offer.
    #[tokio::test]
    async fn an_engine_composed_ref_reaches_the_post_unvalidated() {
        let (h, _rx) = posting_harness();
        lay(&h.conn, "ci", r#"{"commit":{}}"#);
        // The model names a dash it was never shown — which is exactly the
        // shape a work-tier settle produces.
        let (pools, _) = scripted(vec![Ok(r#"{"interest":"interesting","outcome":"verdict","headline":"staged a fix","refs":[{"kind":"dash","target":"tripwire-ci-abc12345"}]}"#.to_string())]);

        work(
            &h.config,
            &h.conn,
            &pools,
            &TripwireEvent::Commit {
                branch: Some("main".to_string()),
                sha: "deadbeef".to_string(),
                workspace_path: "/proj".to_string(),
            },
        )
        .await;

        let post = posts(&h.config.ledger).remove(0);
        assert!(
            post.refs
                .iter()
                .any(|r| r.kind == OverviewRefKind::Dash && r.target == "tripwire-ci-abc12345"),
            "the dash ref survived: {:?}",
            post.refs
        );
    }

    #[tokio::test]
    async fn post_never_writes_no_post_however_interesting_the_verdict() {
        let (h, mut rx) = posting_harness();
        let mut new = NewTripwire::new(
            "quiet",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        new.post = PostPolicy::Never;
        ledger::lay(&h.conn, &new, 1).unwrap();
        let (pools, _) = scripted(vec![Ok(
            r#"{"interest":"interesting","outcome":"verdict","headline":"loud"}"#.to_string(),
        )]);

        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", None, None),
        )
        .await;

        assert!(posts(&h.config.ledger).is_empty());
        assert!(rx.try_recv().is_err(), "nothing on the tripwire either");
    }

    /// Under `auto` a routine firing is a trip-log row and nothing more —
    /// which is what keeps an armed tripwire from filling the channel with the
    /// pattern it was laid to watch for.
    #[tokio::test]
    async fn auto_posts_the_interesting_and_the_failed_but_not_the_routine() {
        let routine = Settled::from_envelope(&tripwire_agent::TripwireEnvelope {
            interest: tripwire_agent::Interest::Routine,
            outcome: Outcome::Verdict,
            headline: "ordinary".to_string(),
            refs: Vec::new(),
        });
        let interesting = Settled::from_envelope(&tripwire_agent::TripwireEnvelope {
            interest: tripwire_agent::Interest::Interesting,
            outcome: Outcome::Verdict,
            headline: "worth telling".to_string(),
            refs: Vec::new(),
        });
        let failed = Settled::failed("it broke".to_string());

        assert!(!should_post(PostPolicy::Auto, &routine));
        assert!(should_post(PostPolicy::Auto, &interesting));
        assert!(
            should_post(PostPolicy::Auto, &failed),
            "a tripwire that stopped working is what nobody would otherwise find out about"
        );

        for settled in [&routine, &interesting, &failed] {
            assert!(should_post(PostPolicy::Always, settled));
            assert!(!should_post(PostPolicy::Never, settled));
        }
    }

    /// `always` is the shakedown policy, so it has to reach the outcome a
    /// freshly laid probe-carrying tripwire actually produces: the quiet one.
    /// `auto` reads `interest` and stays out of the channel.
    #[tokio::test]
    async fn the_log_only_floor_is_sayable_under_always_and_quiet_under_auto() {
        let (h, mut rx) = posting_harness();
        let mut new = NewTripwire::new(
            "ci",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
        );
        new.probe = Some("just ci".to_string());
        new.scope = Some("/tmp/tripwire-scope".to_string());
        new.post = PostPolicy::Always;
        ledger::lay(&h.conn, &new, 1).unwrap();

        let (pools, _) = scripted(vec![Ok("never asked".to_string()); 2]);
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", Some("/tmp/tripwire-scope"), None),
        )
        .await;

        // `always` is how a freshly laid tripwire is shaken down, and the outcome a
        // probe-carrying tripwire produces most is the quiet one. A floor with no
        // headline could not be posted at all — `post_settled` had no body to
        // send — so the policy said nothing on exactly the firing it was set
        // for.
        assert_eq!(
            posts(&h.config.ledger).len(),
            1,
            "always says the quiet one"
        );
        assert!(rx.try_recv().is_ok());
        // `auto` still stays quiet on it, and that is `interest` doing the work
        // rather than a missing sentence doing it by accident.
        ledger::update(
            &h.conn,
            "ci",
            &ledger::TripwireEdit {
                post: Some(PostPolicy::Auto),
                cooldown_secs: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        work(
            &h.config,
            &h.conn,
            &pools,
            &fact_event("edit_failed", Some("/tmp/tripwire-scope"), None),
        )
        .await;
        assert_eq!(posts(&h.config.ledger).len(), 1, "auto added nothing");
    }

    /// The whole loop, driven by a real fact through a real ledger: the engine
    /// wakes on the signal, reads its tail, and lands the trip.
    #[tokio::test]
    async fn the_running_engine_trips_on_a_fact_recorded_after_it_booted() {
        let h = harness();
        let tripwire = lay(&h.conn, "tugedit", r#"{"fact":{"kind":"edit_failed"}}"#);
        let session_ledger = Arc::clone(&h.config.ledger);
        let cancel = h.config.cancel.clone();
        let db_path = h.config.db_path.clone();

        // A fact recorded before the boot must not trip: the tail starts at
        // the tip, so history is not narrated as though it just happened.
        session_ledger
            .record_fact(&crate::feeds::facts_library::edit_failed_fact(
                1_000,
                None,
                &serde_json::json!({"class": "parse", "files": []}),
                None,
            ))
            .unwrap();

        let (_gh_tx, gh_rx) = broadcast::channel::<Frame>(8);
        let spawner = FakeSpawner::always(Ok(
            r#"{"interest":"interesting","outcome":"verdict","headline":"the program went stale"}"#
                .to_string(),
        ));
        let engine = tokio::spawn(run_tripwire_engine(
            TripwireEngineConfig {
                ledger: Arc::clone(&session_ledger),
                db_path,
                instance: "inst-a".to_string(),
                now_ms: h.clock.as_now(),
                spawner,
                sessions: None,
                overview_tx: None,
                cancel: cancel.clone(),
            },
            gh_rx,
        ));

        // Let the engine reach its select before the fact lands, so the wake
        // is the signal rather than the sweep tick.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        session_ledger
            .record_fact(&crate::feeds::facts_library::edit_failed_fact(
                2_000,
                None,
                &serde_json::json!({"class": "resolve", "files": ["a.rs"]}),
                None,
            ))
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            if trips.first().is_some_and(|t| t.status == "settled") {
                assert_eq!(trips.len(), 1, "the pre-boot fact did not trip: {trips:?}");
                assert_eq!(
                    trips[0].headline.as_deref(),
                    Some("the program went stale"),
                    "the engine settled from the model's own envelope"
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

    /// The work tier over a real git repository — the half of the engine that
    /// touches the filesystem, and the only half a fake session runner cannot
    /// stand in for.
    mod work_tier {
        use super::*;
        use crate::feeds::tripwire_session::{TripwireSessionOutcome, TripwireSessionRequest};

        /// What the fake was asked to do, so a test can assert on the request as
        /// well as on the outcome — the permission mode and the worktree are
        /// promises the tier makes, and an outcome alone would not show them kept.
        #[derive(Debug, Clone)]
        struct SeenRun {
            tripwire: String,
            worktree: PathBuf,
            permission_mode: String,
            model: Option<String>,
            prompt: String,
        }

        /// A session runner that answers from a script and, when asked, leaves a
        /// real commit on the worktree it was given — because the keep-or-remove
        /// decision reads git rather than the script, and a fake that only spoke
        /// would never exercise it.
        struct FakeSessions {
            transcript: String,
            completed: bool,
            commits: bool,
            seen: Mutex<Vec<SeenRun>>,
        }

        impl FakeSessions {
            fn new(transcript: &str, commits: bool) -> Arc<FakeSessions> {
                Arc::new(FakeSessions {
                    transcript: transcript.to_string(),
                    completed: true,
                    commits,
                    seen: Mutex::new(Vec::new()),
                })
            }

            /// A run that never reached its turn end — what the twenty-minute
            /// timeout hands back.
            fn timed_out() -> Arc<FakeSessions> {
                Arc::new(FakeSessions {
                    transcript: "I was still working when".to_string(),
                    completed: false,
                    commits: false,
                    seen: Mutex::new(Vec::new()),
                })
            }

            fn seen(&self) -> Vec<SeenRun> {
                self.seen.lock().unwrap().clone()
            }
        }

        #[async_trait::async_trait]
        impl TripwireSessionRunner for FakeSessions {
            async fn run(
                &self,
                request: TripwireSessionRequest,
            ) -> Result<TripwireSessionOutcome, String> {
                if self.commits {
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
                self.seen.lock().unwrap().push(SeenRun {
                    tripwire: request.tripwire,
                    worktree: request.worktree,
                    permission_mode: request.permission_mode,
                    model: request.model,
                    prompt: request.prompt,
                });
                Ok(TripwireSessionOutcome {
                    session_id: "sess-tripwire".to_string(),
                    transcript: self.transcript.clone(),
                    completed: self.completed,
                })
            }
        }

        /// A git repository with one commit, and the state directory redirected
        /// beside it so nothing a dash writes reaches the developer's own.
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

        fn work_tripwire(conn: &Connection, root: &std::path::Path, probe: &str) -> Tripwire {
            let mut new = NewTripwire::new("ci", r#"{"commit":{}}"#, "put the suite back to green");
            new.probe = Some(probe.to_string());
            new.scope = Some(root.to_string_lossy().into_owned());
            new.permission_mode = "acceptEdits".to_string();
            new.model = Some("claude-opus-5".to_string());
            ledger::lay(conn, &new, 1).unwrap()
        }

        fn commit_event(root: &std::path::Path) -> TripwireEvent {
            TripwireEvent::Commit {
                branch: Some("main".to_string()),
                sha: "abc1234def".to_string(),
                workspace_path: root.to_string_lossy().into_owned(),
            }
        }

        fn dashes_in(root: &std::path::Path) -> Vec<String> {
            let out = std::process::Command::new("git")
                .args([
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads/tugdash/",
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
        /// tier: the probe answered, so no model was summoned, and the dash the
        /// probe needed is gone again.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_green_probe_settles_the_trip_and_leaves_nothing_behind() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = work_tripwire(&h.conn, &root, "true");
            let sessions = FakeSessions::new("never asked", false);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let (pools, spawner) = scripted(vec![Ok("never asked".to_string())]);
            work(&config, &h.conn, &pools, &commit_event(&root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "settled");
            assert_eq!(trips[0].interest.as_deref(), Some("routine"));
            assert_eq!(trips[0].probe_exit, Some(0));
            assert!(
                sessions.seen().is_empty() && spawner.turns_seen().is_empty(),
                "a green probe spends no tokens at all"
            );
            assert!(
                dashes_in(&root).is_empty(),
                "the dash the probe ran in is gone: {:?}",
                dashes_in(&root)
            );
        }

        /// The residue: the probe failed, so the session ran on the dash, left a
        /// commit, and the dash stays — carried on the trip row and on the post,
        /// which is the only way anybody finds out there is work to join.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_red_probe_stages_work_on_a_dash_that_survives_the_settle() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = work_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(
                // Frame-shaped, the way the real runner hands a transcript
                // back: the envelope escaped inside an assistant frame's text
                // field, never as bare prose. A plain-text fake here is what
                // hid the work tier's unreadable-envelope bug from this suite.
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done.\n\n{\"interest\":\"routine\",\"outcome\":\"staged\",\"headline\":\"put the suite back to green\"}"}]}}
{"type":"turn_complete"}"#,
                true,
            );
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let (pools, _) = scripted(vec![Ok("never asked".to_string())]);
            work(&config, &h.conn, &pools, &commit_event(&root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            let trip = &trips[0];
            assert_eq!(trip.status, "settled");
            assert_eq!(trip.probe_exit, Some(3));
            assert_eq!(trip.session_id.as_deref(), Some("sess-tripwire"));
            assert_eq!(trip.dash.as_deref(), Some("tripwire-ci-abc1234d"));
            assert_eq!(
                trip.outcome.as_deref(),
                Some("staged"),
                "the commits are the fact"
            );
            assert_eq!(
                trip.interest.as_deref(),
                Some("interesting"),
                "staged work is always worth telling, whatever the model called it"
            );

            assert_eq!(
                dashes_in(&root),
                vec!["tugdash/tripwire-ci-abc1234d".to_string()]
            );
            assert_eq!(
                tugdash_core::ops::laid_by(&root, "tripwire-ci-abc1234d").as_deref(),
                Some("tripwire/ci")
            );

            let run = sessions.seen().first().cloned().expect("the session ran");
            assert_eq!(run.tripwire, "ci");
            assert_eq!(run.permission_mode, "acceptEdits");
            assert_eq!(run.model.as_deref(), Some("claude-opus-5"));
            assert!(run.worktree.ends_with("tripwire-ci-abc1234d"), "{run:?}");
            assert!(
                run.prompt.contains("put the suite back to green")
                    && run.prompt.contains("exit 3")
                    && run
                        .prompt
                        .contains("tugutil dash commit tripwire-ci-abc1234d"),
                "the prompt carries the brief, the probe's failure and the commit path: {}",
                run.prompt
            );

            let post = posts(&config.ledger)
                .into_iter()
                .next_back()
                .expect("the staged work was posted");
            assert!(
                post.refs
                    .iter()
                    .any(|r| r.kind == OverviewRefKind::Dash && r.target == "tripwire-ci-abc1234d"),
                "the post names the dash to join: {:?}",
                post.refs
            );
        }

        /// A session that answered nothing usable, on a dash it never wrote in:
        /// the trip fails loudly and the empty dash is cleaned up anyway.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_session_with_no_envelope_fails_the_trip_and_still_cleans_up() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = work_tripwire(&h.conn, &root, "exit 1");
            let sessions = FakeSessions::new("I had a look around.", false);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let (pools, _) = scripted(vec![Ok("never asked".to_string())]);
            work(&config, &h.conn, &pools, &commit_event(&root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed");
            assert!(
                trips[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains("envelope")),
                "the failure says what went wrong: {:?}",
                trips[0].headline
            );
            assert!(dashes_in(&root).is_empty());
        }

        /// A wedged session is not a silent one. The trip fails, and the headline
        /// says the run ran out of time rather than that it said nothing — the two
        /// are different faults and a reader of the log has to be able to tell
        /// them apart.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_session_that_never_finished_settles_as_a_timeout() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = work_tripwire(&h.conn, &root, "exit 1");
            let mut config = h.config;
            config.sessions = Some(FakeSessions::timed_out() as Arc<dyn TripwireSessionRunner>);

            let (pools, _) = scripted(vec![Ok("never asked".to_string())]);
            work(&config, &h.conn, &pools, &commit_event(&root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed");
            assert!(
                trips[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains("twenty minutes")),
                "{:?}",
                trips[0].headline
            );
        }

        /// One firing is one dash, whatever the event was, and the name survives
        /// a key that is not itself a legal dash name.
        #[test]
        fn a_dash_is_named_for_its_tripwire_and_its_firing() {
            assert_eq!(
                tripwire_dash_name("ci", "abc1234def5678"),
                "tripwire-ci-abc1234d",
                "a commit key is already eight legal characters"
            );
            // The property, not the spelling: two firings of one tripwire must
            // never name one dash. Sanitizing a fact key to eight characters
            // used to yield `tripwire-tugedit-factedit` for every firing there
            // would ever be, and `create_in` is idempotent — so the second
            // firing adopted the first's dash, counted its rounds as its own,
            // and a green probe on the second discarded what the first staged.
            let first = tripwire_dash_name("tugedit", "fact:inst-a:41");
            let second = tripwire_dash_name("tugedit", "fact:inst-a:42");
            let elsewhere = tripwire_dash_name("tugedit", "fact:inst-b:41");
            assert_ne!(first, second, "two facts are two dashes");
            assert_ne!(first, elsewhere, "two instances are two dashes");
            assert_eq!(
                first,
                tripwire_dash_name("tugedit", "fact:inst-a:41"),
                "one firing named twice is one dash, however often the engine restarts"
            );
            assert!(
                first.starts_with("tripwire-tugedit-")
                    && first.len() == "tripwire-tugedit-".len() + 8,
                "a digested key is still eight characters: {first}"
            );
        }
    }
}
