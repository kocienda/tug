//! The tripwire engine — what turns a standing tripwire into a firing.
//!
//! The feature's doctrine is `tuglaws/tripwires.md` — the lifecycle, the guards
//! and the caps are argued there and only implemented here.
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
//! **One stream: the fact.** A tripwire fires when a fact is *recorded*
//! ([B01]). Every `record_fact` in this process passes through one funnel, and
//! that funnel calls [`fact_recorded`]; the engine receives the row on its own
//! task, so nothing the user waits on waits on a tripwire. The event key is
//! `fact:<instance>:<rowid>`, unique by construction — a fact is recorded by
//! one instance and evaluated by one engine, so there is nothing to arbitrate
//! and no claim to make. A hand-typed `git commit` records no fact and fires
//! nothing, which is a stated non-goal rather than a gap.
//!
//! **Four gates, in order, and none of them writes a row.** The predicate has
//! to read; the tripwire's scope has to contain the fact's checkout; the fact
//! has to match; and the fact must not come from a session this very tripwire
//! spawned ([B03]). A fact that fails any of those writes nothing — there is no
//! event to explain, and a row per unmatched fact would bury the ones that mean
//! something. Past them, a tripwire already working a trip, a machine at its
//! ceiling, or a host with no room each write a `skipped` row naming which
//! ([P04]), because those are refusals a reader needs to see.
//!
//! **A trip stands in the tripwire's own arc worktree.** Every tripwire owns
//! one permanent arc, `tripwire-<name>`, replayed onto the base checkout's
//! `HEAD` before each trip ([P02], [P03]). The session has hands from its
//! first turn and can commit there, and nothing it does reaches the user's
//! working checkout.
//!
//! **Four words are the whole of a trip's state:** `skipped`, `running`,
//! `done`, `failed` ([P05]). What a finished trip found is its report, and
//! whether it committed is its rounds count — neither of them a word the
//! model chose ([P04]).
//!
//! **A trip is bounded.** Its own `max_seconds` and `max_tool_calls` are read
//! off its row; past either the session is interrupted, given [`CAP_GRACE`] to
//! go quiet, and failed saying which cap it met ([P06]).
//!
//! **The guard half is synchronous, the run half is not — and that split is
//! load-bearing.** `evaluate` decides against an open `rusqlite::Connection`
//! and hands back what is to be run; the model turn happens with no connection
//! in reach, and the settle takes it up again. `&Connection` is not `Send`, so
//! the ledger's no-transaction-across-await rule is enforced by the compiler
//! rather than by care.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tugarc_core::ops::round_count_in;
use tugcast_core::types::{OverviewAuthor, OverviewPost, OverviewRef, OverviewRefKind};
use tugcast_core::{FeedId, Frame};
use tugtool_core::tripwire_ledger::{self as ledger, NewTrip, TripStatus, Tripwire, tripwire_arc};
use tugtool_core::tripwire_predicate::{self, FactEvent};

use crate::feeds::tripwire_prompt as prompt;
use crate::feeds::tripwire_session::{
    CapKind, RunRefusal, SessionEnd, TripwireSessionOutcome, TripwireSessionRequest,
    TripwireSessionRunner,
};
use crate::session_ledger::SessionLedger;

/// How often the engine sweeps for runs another instance left behind. Nothing
/// waits on it — a fact wakes the engine directly.
const SWEEP_TICK: Duration = Duration::from_secs(5);

/// How long a probe may run before the engine stops waiting on it.
///
/// A probe is an arbitrary command from a tripwire row, run unattended, and the two
/// failure modes it has no defence against on its own are the one that blocks
/// on a prompt and the one that never terminates. Neither announces itself:
/// without a deadline the trip stays `running` forever, holding its slot, and
/// the run it is inside never settles. Generous, because `just ci`
/// is the motivating probe and a cold build is slow.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How long another instance's `running` trip may sit before this engine may
/// declare it dead.
///
/// [`ledger::sweep_stale_running`] clears *this* instance's orphans at boot,
/// which is the clean case. It cannot clear another instance's: from here, an
/// instance that crashed and one that is mid-run look identical. But the
/// concurrency count is machine-wide, so rows nobody will ever settle consume
/// the ceiling for every tripwire on the machine — at the default ceiling of two,
/// two orphans stop the facility outright, and nothing recovers, because
/// draining the queue is something a settle triggers and no settle is coming.
/// Age is the only evidence available about another instance, so this is the
/// one duration in the engine that fails a row on a clock — and it is a bound
/// on a crash, never on a session. This instance's own rows are exempt from
/// it: a session this engine is running has no ceiling, and it knows those
/// runs are alive. Past the probe's own bound, with room to spare, because a
/// run's only clocked part is its probe; the session after it takes as long
/// as the work takes.
const ORPHANED_RUN_AGE: Duration = Duration::from_secs(90 * 60);

/// How long a capped session is given to end its turn on the interrupt before
/// the engine closes it anyway ([P06]).
///
/// A bound on the wait rather than on the session: the session is already over
/// as far as the engine is concerned, and this is only how long it is worth
/// waiting for a polite ending before taking the impolite one. Short, because
/// the case it exists for is a bridge that is not going to answer.
pub(crate) const CAP_GRACE: Duration = Duration::from_secs(10);

/// The channel a hand-fired `tripwire trip` reaches the engine on.
///
/// Process-global rather than threaded through `ActionContext`, the same shape
/// the registry's `workspace_open_tx` uses: one optional consumer, set at boot
/// by whichever engine is running, and a send that is simply skipped in a
/// build without one.
static MANUAL_KICK: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// What a hand-firing found at the door ([P08]).
///
/// Three answers rather than a bool, because the two refusals want different
/// sentences: "no engine is running in this instance" is the wrong thing to
/// tell somebody whose tripwire simply has no checkout to stand in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kick {
    /// The engine has it and is minting the row now.
    Served,
    /// Nothing is listening: no engine in this process. With no queue ([P03])
    /// there is no row a later engine could pick up, so this is a refusal
    /// rather than a deferral.
    NoEngine,
    /// The tripwire has no `--scope`, so a hand-fired trip has no checkout to
    /// cut a tree from. A real fact supplies one from its session; a
    /// hand-firing has only the scope.
    NoScope,
}

/// Fire a tripwire by hand, or say why not ([P08]).
///
/// The scope is checked here rather than only inside the engine because the
/// answer is the caller's to render, and a caller that had to guess which of
/// the two refusals applied would guess wrong half the time. `serve_manual`
/// checks it again on the engine's side, where it also refuses to write a row.
pub fn kick(tripwire: &Tripwire) -> Kick {
    if tripwire.scope.as_deref().is_none_or(str::is_empty) {
        return Kick::NoScope;
    }
    match MANUAL_KICK.get() {
        Some(tx) if tx.try_send(tripwire.name.clone()).is_ok() => Kick::Served,
        _ => Kick::NoEngine,
    }
}

/// The channel a recorded fact reaches the engine on ([P01]).
///
/// Process-global for the same reason [`MANUAL_KICK`] is: the fifteen
/// `record_fact` callers have no engine handle to be given, and a build with no
/// engine simply has no receiver.
static FACT_TX: OnceLock<mpsc::UnboundedSender<crate::session_ledger::FactRow>> = OnceLock::new();

/// Tell the engine a fact was recorded. Fire-and-forget, and deliberately so:
/// the write that produced it has finished and must not wait on a tripwire.
/// Unbounded, because a bounded queue's one failure mode is a silent refusal
/// and a fact is a few strings arriving at human pace.
///
/// A send with no receiver is skipped **silently**, not warned: `record_fact`
/// runs in every test that touches the session ledger, and the engine is gated
/// off entirely under the app-test harness. A warning here would be noise on
/// every one of those and would say nothing about this process.
pub fn fact_recorded(row: crate::session_ledger::FactRow) {
    if let Some(tx) = FACT_TX.get() {
        let _ = tx.send(row);
    }
}

/// What the engine needs to run.
pub struct TripwireEngineConfig {
    /// The session ledger a fact's session and transcripts are read from.
    pub ledger: Arc<SessionLedger>,
    /// Where `tripwires.db` lives. Injected rather than resolved here so a
    /// test drives a real ledger at a temp path.
    pub db_path: PathBuf,
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

/// One recorded fact, from the row arriving to every trip it fired.
///
/// The two halves are visible in the shape: the decision runs under the lock,
/// the model's turn runs with the lock released, and the settle takes it
/// again.
fn work_fact(
    config: &Arc<TripwireEngineConfig>,
    db: &Arc<Db>,
    fact: &crate::session_ledger::FactRow,
) {
    let pending = {
        let conn = db.lock().expect("tripwire ledger mutex");
        evaluate(config, &conn, fact).1
    };
    // The `skipped` and `running` rows `evaluate` inserted beneath this.
    crate::feeds::tripwires::bump();
    for run in pending {
        spawn_run(config, db, run);
    }
}

/// Work one claimed firing on a task of its own.
///
/// Off the engine's task, because a run is not a fast thing: a probe may take
/// fifteen minutes and a session as long as its work, and waiting on that
/// inline meant the `select!` loop stopped reading for the whole of it. Facts
/// survived that —
/// the tail is a rowid and catches up — but `GIT_HEAD` is a broadcast, so
/// commits past the channel's depth were lost outright, and every one of them
/// was a firing that never happened and left no row saying so.
///
/// Unbounded here only in the shape of the code. The trip is already `running`
/// in the ledger before this is called and the ceiling is read against that
/// count, so the number alive at once is exactly what the ceiling permits —
/// and the ceiling only becomes true *within* one instance now that runs are
/// concurrent at all.
fn spawn_run(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>, mut run: PendingRun) {
    let config = Arc::clone(config);
    let db = Arc::clone(db);
    tokio::spawn(async move {
        let settled = run_pending(&config, &db, &mut run).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            settle(&config, &conn, &run, &settled);
        }
    });
}

/// Fail this instance's `running` trips at boot.
///
/// The sessions those trips ran were children of the process that restarted
/// and are gone, so the rows are honest.
///
/// **It touches no arc, and that is the decision.** A tripwire owns one
/// permanent arc ([P02]), so the old pass — discard any arc the failed trips
/// name that holds no rounds — would destroy the tripwire's own worktree on any
/// restart that caught a trip with nothing committed yet.
///
/// `&mut` on the connection so the future stays `Send` across the caller's
/// blocking reads, which is what lets the engine be spawned at all.
///
/// No roster nudge: this runs once at engine boot, before the roster feed has
/// composed anything or has a client to tell. Its writes are in the first
/// roster the feed publishes.
fn sweep_restarted_runs(config: &TripwireEngineConfig, conn: &mut Connection) {
    match ledger::sweep_stale_running(conn, &config.instance, (config.now_ms)()) {
        Ok(0) => {}
        Ok(n) => info!(count = n, "tripwire engine: swept stale running trips"),
        Err(e) => warn!(error = %e, "tripwire engine: boot sweep failed"),
    }
}

/// Fail every `running` trip an instance that is not this one abandoned.
///
/// The machine ceiling is machine-wide, so another instance's dead rows ration
/// *this* instance's trips. Boot only ever reaches this engine's own rows, and
/// with no queue there is no drain to carry this any more ([P03]) — so it runs
/// on the tick, which is the only thing that reaches it at all.
fn sweep_orphans(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>) {
    let conn = db.lock().expect("tripwire ledger mutex");
    match ledger::sweep_orphaned_running(
        &conn,
        (config.now_ms)() - ORPHANED_RUN_AGE.as_millis() as i64,
        &config.instance,
    ) {
        Ok(0) | Err(_) => {}
        Ok(n) => {
            // A sweep that failed somebody's running trip is a card-visible
            // status change, so the roster is nudged from here rather than
            // from a line the ordinary tick never reaches.
            crate::feeds::tripwires::bump();
            info!(count = n, "tripwire engine: failed abandoned running trips");
        }
    }
}

/// A trip that passed every guard, carried out of the synchronous
/// decision so its turn can run with no ledger connection in reach.
#[derive(Debug, Clone)]
pub struct PendingRun {
    pub trip_id: i64,
    pub tripwire: String,
    pub model: Option<String>,
    pub brief: String,
    /// The command that decides whether an AI is needed at all ([P10]).
    pub probe: Option<String>,
    /// What the trip's session is allowed to do without asking [B09].
    pub permission_mode: String,
    /// The two ceilings this trip's session runs under, off the tripwire's
    /// own row ([P06]). Carried here rather than re-read at the wait, for the
    /// reason everything else in this struct is: the run is an `await` and the
    /// connection cannot come along.
    pub max_seconds: u64,
    pub max_tool_calls: u32,
    /// The event as the trip row holds it — what the model is shown.
    pub evidence: String,
    /// The refs the engine composed from the event itself — the commit's sha,
    /// the session that produced the fact. Facts the engine wrote rather than
    /// text a model produced, so they are attached directly.
    pub engine_refs: Vec<OverviewRef>,
    /// The project the event happened in, so the post lands on the right
    /// Overview.
    pub project_dir: Option<String>,
    /// The checkout the fact was recorded in ([foreign checkout]). Evidence
    /// the prompt carries, never where the trip stands.
    pub repo_root: String,
    /// The checkout the tripwire's arc lives in, off its own row ([P02]).
    /// Empty is a failure rather than a fallback: a tripwire laid before the
    /// arc existed has nowhere to stand.
    pub home_root: String,
    /// The session that recorded the fact, when it had one. A hand-fired trip
    /// has none.
    pub fact_session: Option<String>,
    /// The session the event came from, when it came from one.
    pub session_id: Option<String>,
    /// The arc this trip committed on, when it committed anything ([P02],
    /// Spec S02). Always `tripwire-<name>` or `None`: the arc is the
    /// tripwire's, and what varies is whether this trip put a round on it.
    pub arc: Option<String>,
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

    let mut conn = match ledger::open_ledger(&config.db_path) {
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
    sweep_restarted_runs(&config, &mut conn);
    // Shared rather than owned by the loop, because a run now happens on a task
    // of its own and has to carry the ledger and the pools with it.
    let config = Arc::new(config);
    let db: Arc<Db> = Arc::new(Mutex::new(conn));

    let (kick_tx, mut kick_rx) = mpsc::channel::<String>(16);
    let _ = MANUAL_KICK.set(kick_tx);
    // Unbounded, so a fact is never dropped for want of room ([P01]); the
    // sender is `record_fact_tx` and it waits for nothing.
    let (fact_tx, mut fact_rx) = mpsc::unbounded_channel::<crate::session_ledger::FactRow>();
    let _ = FACT_TX.set(fact_tx);

    let mut ticker = tokio::time::interval(SWEEP_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!(instance = %config.instance, "tripwire engine: watching facts");

    loop {
        tokio::select! {
            _ = config.cancel.cancelled() => {
                debug!("tripwire engine: shutting down");
                return;
            }
            _ = ticker.tick() => {
                // Another instance's orphans hold the machine-wide ceiling for
                // everybody, and boot only ever reaches this instance's own
                // rows — so the tick is the one thing that frees them.
                sweep_orphans(&config, &db);
            }
            kicked = kick_rx.recv() => match kicked {
                Some(name) => serve_manual(&config, &db, name.as_str()),
                None => return,
            },
            fact = fact_rx.recv() => match fact {
                Some(fact) => work_fact(&config, &db, &fact),
                None => return,
            },
        }
    }
}

/// Serve a hand-fired trip: mint the row, compose a synthetic fact, and run it
/// ([P08]).
///
/// The CLI writes no row any more — with no queue there is nothing a later
/// engine could pick up — so the engine is where a hand-firing becomes a trip.
/// It goes past the four gates by construction: a bench-test firing that could
/// be refused as not-matching would test nothing.
///
/// **An unscoped tripwire is refused here and writes no row.** A hand-fired
/// trip has no fact to take a checkout from and only the scope to name one
/// with, so an unscoped one is "lay it with a scope" rather than a red row on
/// the card. [`kick`] answers
/// [`Kick::NoScope`] before this is ever reached; this is the same refusal on
/// the engine's side of the door.
fn serve_manual(config: &Arc<TripwireEngineConfig>, db: &Arc<Db>, tripwire_name: &str) {
    let run = {
        let conn = db.lock().expect("tripwire ledger mutex");
        let Ok(Some(tripwire)) = ledger::get(&conn, tripwire_name) else {
            warn!(tripwire = %tripwire_name, "tripwire engine: kicked for a tripwire that is not there");
            return;
        };
        let repo_root = tripwire.scope.clone().unwrap_or_default();
        if repo_root.is_empty() {
            debug!(tripwire = %tripwire_name,
                   "tripwire engine: kicked for a tripwire with no scope, so there is no checkout");
            return;
        }
        let now = (config.now_ms)();
        let fact = synthetic_fact(&tripwire, now);
        let payload = fact_payload(&fact);
        let key = format!("manual:{}", uuid::Uuid::new_v4());
        let inserted = ledger::insert_trip(
            &conn,
            &NewTrip {
                tripwire_id: tripwire.id,
                event_key: key.clone(),
                at_ms: now,
                instance: config.instance.clone(),
                status: TripStatus::Running,
                reason: None,
                event_payload: payload.clone(),
                repo_root: Some(repo_root.clone()),
            },
        );
        let Ok(Some(trip_id)) = inserted else {
            warn!(tripwire = %tripwire_name, "tripwire engine: the hand-fired trip could not be written");
            return;
        };
        crate::feeds::tripwires::bump();
        start_run(
            &tripwire,
            trip_id,
            payload,
            repo_root,
            fact.session_id.clone(),
        )
    };
    spawn_run(config, db, run);
}

/// The fact a hand-fired trip stands in for ([P08]).
///
/// For a `fact:commit` tripwire it is a `commit` fact at the scope's `HEAD`,
/// composed through `facts_library` like every other. For any other kind it is
/// a row of that kind carrying `{"manual": true}` plus each exact `--where`
/// field's value, so a session reading it sees the shape it was watching for
/// rather than an unrelated commit. It is not passed through the predicate: a
/// firing the user asked for by name is not a firing to second-guess.
fn synthetic_fact(tripwire: &Tripwire, now_ms: i64) -> crate::session_ledger::FactRow {
    let trigger = tripwire.predicate().ok().map(|p| match p {
        tugtool_core::tripwire_predicate::Predicate::Fact(fact) => fact,
    });
    let kind = trigger.as_ref().map(|t| t.kind.clone()).unwrap_or_default();
    if kind == crate::feeds::facts_library::FactKind::Commit.as_str() {
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
        let fact =
            crate::feeds::facts_library::commit_fact(now_ms, None, &sha, "", &[], None, None);
        return crate::session_ledger::FactRow {
            id: 0,
            at_ms: fact.at_ms,
            kind: fact.kind,
            session_id: fact.session_id,
            subject: fact.subject,
            text: fact.text,
            payload: fact.payload,
        };
    }
    let mut payload = serde_json::Map::new();
    payload.insert("manual".to_string(), serde_json::Value::Bool(true));
    // Each exact `--where` field's own value, so a hand-fired trip's evidence
    // is the shape the tripwire was watching for rather than an empty object
    // the session has to guess at. A `contains` or `prefix` matcher names no
    // single value to write, so it contributes nothing.
    if let Some(clause) = trigger.as_ref().and_then(|t| t.r#where.as_ref()) {
        for (field, matcher) in clause {
            if let tugtool_core::tripwire_predicate::Matcher::Exact(value) = matcher {
                payload.insert(field.clone(), serde_json::Value::String(value.clone()));
            }
        }
    }
    crate::session_ledger::FactRow {
        id: 0,
        at_ms: now_ms,
        kind,
        session_id: None,
        subject: None,
        text: "fired by hand".to_string(),
        payload: serde_json::Value::Object(payload).to_string(),
    }
}

/// The outcome of considering one tripwire against one fact — the whole of what
/// the guard half decides, named so a test can assert on it rather than on
/// whatever rows happened to appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// A gate that writes nothing said no: an unreadable trigger, a foreign
    /// scope, a fact that did not match, or a fact this very tripwire's own
    /// session recorded ([P04]).
    NoMatch,
    /// The fact matched and the trip did not run, for the named reason. A row
    /// with that reason on it.
    Skipped(&'static str),
    /// Past every guard, inserted `running`, and handed on to its run.
    Fired,
}

/// Consider every armed tripwire against one recorded fact.
///
/// The tripwires table is re-read per fact rather than cached, which is what
/// makes `pause` and `edit` apply on the next firing with no notification
/// plumbing at all: the next fact reads the row as it now stands.
///
/// The fact's checkout is resolved once here rather than per tripwire — it is
/// one session-ledger read and every tripwire's scope gate wants the same
/// answer. A fact with no session, or one whose session this ledger does not
/// know, is considered by nobody: there is no checkout to compare a scope
/// against and none to cut a tree from.
pub fn evaluate(
    config: &TripwireEngineConfig,
    conn: &Connection,
    fact: &crate::session_ledger::FactRow,
) -> (Vec<(String, Decision)>, Vec<PendingRun>) {
    let tripwires = match ledger::armed(conn) {
        Ok(tripwires) => tripwires,
        Err(e) => {
            warn!(error = %e, "tripwire engine: cannot read the tripwires table");
            return (Vec::new(), Vec::new());
        }
    };
    let Some(repo_root) = fact
        .session_id
        .as_deref()
        .and_then(|id| config.ledger.get(id).ok().flatten())
        .map(|row| row.project_dir)
        .filter(|dir| !dir.is_empty())
    else {
        debug!(fact = fact.id, kind = %fact.kind,
               "tripwire engine: a fact with no known checkout is nobody's business");
        return (Vec::new(), Vec::new());
    };
    let mut decisions = Vec::with_capacity(tripwires.len());
    let mut pending = Vec::new();
    for tripwire in &tripwires {
        let (decision, run) = consider(config, conn, tripwire, fact, &repo_root);
        decisions.push((tripwire.name.clone(), decision));
        if let Some(run) = run {
            pending.push(run);
        }
    }
    (decisions, pending)
}

/// One tripwire against one fact, in the order (#fact-to-trip) fixes: the four
/// gates that write nothing, then the three that write a `skipped` row, then
/// the insert.
///
/// The gates that write nothing come first because there is nothing to explain:
/// a fact the tripwire does not watch, or one from outside its scope, is not an
/// event in this tripwire's life. The three that do write a row are engineering
/// refusals of a fact that *did* match, and a reader needs to see those or a
/// tripwire that refused a hundred firings looks like one that never saw any.
fn consider(
    config: &TripwireEngineConfig,
    conn: &Connection,
    tripwire: &Tripwire,
    fact: &crate::session_ledger::FactRow,
    repo_root: &str,
) -> (Decision, Option<PendingRun>) {
    let Ok(predicate) = tripwire.predicate() else {
        // A trigger this build cannot read belongs to a newer one. The tripwire
        // stays listable and removable; it simply never fires here — and it
        // costs its own tripwire and no other.
        return (Decision::NoMatch, None);
    };
    if !in_scope(tripwire.scope.as_deref(), repo_root) {
        return (Decision::NoMatch, None);
    }
    let event = FactEvent {
        kind: fact.kind.clone(),
        payload: serde_json::from_str(&fact.payload).unwrap_or(serde_json::Value::Null),
    };
    if !tripwire_predicate::matches(&predicate, &event) {
        return (Decision::NoMatch, None);
    }
    // A tripwire never fires on facts recorded by a session it spawned ([B03]).
    // Without it, every shell command a trip runs fires the tripwire that
    // started it. Per tripwire rather than across all of them ([Q01]).
    if let Some(session_id) = fact.session_id.as_deref()
        && matches!(
            ledger::is_trip_session(conn, tripwire.id, session_id),
            Ok(true)
        )
    {
        return (Decision::NoMatch, None);
    }

    let now = (config.now_ms)();
    let key = event_key(&config.instance, fact.id);
    let payload = fact_payload(fact);
    let skip = |reason: &'static str| {
        let _ = ledger::insert_trip(
            conn,
            &NewTrip {
                tripwire_id: tripwire.id,
                event_key: key.clone(),
                at_ms: now,
                instance: config.instance.clone(),
                status: TripStatus::Skipped,
                reason: Some(reason.to_string()),
                event_payload: payload.clone(),
                repo_root: Some(repo_root.to_string()),
            },
        );
    };

    // One live run per tripwire: a trip that is still `running` holds the
    // slot, and nothing else does — a finished trip is finished.
    if matches!(ledger::live_trip(conn, tripwire.id), Ok(Some(_))) {
        skip(ledger::SKIP_BUSY);
        return (Decision::Skipped(ledger::SKIP_BUSY), None);
    }
    // Two budgets, one ladder ([B02]). The ledger's ceiling rations worktrees
    // machine-wide; the host's rations memory in this process, and the trip's
    // own session has always spent it. Neither is a queue: with the trigger at
    // fact time the next matching fact is along in seconds, so a skip that says
    // which budget refused is more honest than a row waiting for a drain.
    if ledger::running_count(conn).unwrap_or(0) >= ledger::max_concurrent_trips(conn).unwrap_or(2) {
        skip(ledger::SKIP_CEILING);
        return (Decision::Skipped(ledger::SKIP_CEILING), None);
    }
    if config
        .sessions
        .as_ref()
        .is_some_and(|sessions| !sessions.admits_spawn())
    {
        skip(ledger::SKIP_NO_ROOM);
        return (Decision::Skipped(ledger::SKIP_NO_ROOM), None);
    }

    // `running` before the turn, not after: the machine ceiling counts running
    // trips, and a trip that took its slot only once it finished would let
    // every instance start at once. It is also what makes the seat race
    // harmless — from this instant the tripwire's `live_trip` is set, so the
    // new session's own first facts are skipped as `busy` (#seat-race).
    let inserted = ledger::insert_trip(
        conn,
        &NewTrip {
            tripwire_id: tripwire.id,
            event_key: key.clone(),
            at_ms: now,
            instance: config.instance.clone(),
            status: TripStatus::Running,
            reason: None,
            event_payload: payload.clone(),
            repo_root: Some(repo_root.to_string()),
        },
    );
    match inserted {
        Ok(Some(trip_id)) => {
            crate::feeds::tripwires::bump();
            (
                Decision::Fired,
                Some(start_run(
                    tripwire,
                    trip_id,
                    payload,
                    repo_root.to_string(),
                    fact.session_id.clone(),
                )),
            )
        }
        // A rowid this tripwire already has a row for — the case the unique
        // constraint exists for. Nothing to do and nothing to say.
        Ok(None) => (Decision::NoMatch, None),
        Err(e) => {
            warn!(error = %e, tripwire = %tripwire.name, "tripwire engine: the trip row could not be written");
            (Decision::NoMatch, None)
        }
    }
}

/// Gather everything a trip's turn needs, off a row that is already `running`.
///
/// Everything is copied out rather than borrowed, because what happens next is
/// an `await` and the connection cannot come along.
fn start_run(
    tripwire: &Tripwire,
    trip_id: i64,
    payload: Option<String>,
    repo_root: String,
    fact_session: Option<String>,
) -> PendingRun {
    let evidence = payload.unwrap_or_else(|| "{}".to_string());
    PendingRun {
        trip_id,
        tripwire: tripwire.name.clone(),
        model: tripwire.model.clone(),
        brief: tripwire.brief.clone(),
        probe: tripwire.probe.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        // Clamped at zero rather than trusted: the column is `NOT NULL` with a
        // positive default and the CLI refuses a non-positive cap, so a
        // negative here is a row somebody wrote by hand — and the honest
        // reading of one is the smallest ceiling there is.
        max_seconds: tripwire.max_seconds.max(0) as u64,
        max_tool_calls: tripwire.max_tool_calls.clamp(0, u32::MAX as i64) as u32,
        // Written when the run ends, and only if it committed something
        // ([P02], Spec S02).
        arc: None,
        // The fact's own session, attached directly: it is something the
        // engine recorded rather than text a model produced, so the
        // hallucination validator has nothing to say about it.
        engine_refs: fact_session
            .clone()
            .map(|target| OverviewRef {
                kind: OverviewRefKind::Session,
                target,
            })
            .into_iter()
            .collect(),
        project_dir: Some(repo_root.clone()),
        repo_root,
        home_root: tripwire.repo_root.clone(),
        fact_session,
        session_id: None,
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
/// One shape of run, and only one ([P01], [P03]): the tripwire's own arc
/// worktree, reset and replayed onto the base's `HEAD`, a probe inside it, and
/// one session with hands.
pub async fn run_pending(config: &TripwireEngineConfig, db: &Db, run: &mut PendingRun) -> Settled {
    let Some(sessions) = config.sessions.clone() else {
        // No runner, so nothing can be asked. The firing is a recorded fact
        // about the tripwire and no more; it is not a failure, because the
        // tripwire matched, the guards passed, and nothing claims work was
        // done.
        return Settled::done(Some(format!(
            "{} fired, and this instance has no session runner to ask",
            run.tripwire
        )));
    };
    if run.home_root.is_empty() {
        return Settled::failed(format!(
            "tripwire {} names no home checkout, so its arc has nowhere to live",
            run.tripwire
        ));
    }
    let home_root = PathBuf::from(&run.home_root);
    let arc = tripwire_arc(&run.tripwire);

    // The tripwire's own worktree, standing on the base as it is now ([P03]).
    // A trip on a stale base diagnoses a repository that no longer exists, and
    // a replay that cannot be made clean is a trip whose findings would be
    // about the wrong tree — so it fails rather than proceeds.
    let worktree = match prepare_arc_worktree(&home_root, &arc).await {
        Ok(worktree) => worktree,
        Err(e) => return Settled::failed(e),
    };

    run_in_tree(config, db, sessions, run, &worktree, &arc).await
}

/// Put the tripwire's worktree back on the base's tip, and hand back the path
/// a trip runs in ([P03]).
///
/// The reset is a precondition of the replay rather than a policy of its own:
/// `replay_onto` refuses a dirty worktree, and residue here is by construction
/// work a previous trip declined to commit — every trip leaves a report, so
/// nothing a reader wanted is in those bytes.
///
/// `Conflicted` and `Deferred` come back as the outcome's own sentence, because
/// the trip row is where a person reads why nothing ran and "replay failed"
/// answers nothing.
async fn prepare_arc_worktree(repo_root: &Path, arc: &str) -> Result<PathBuf, String> {
    let repo_root = repo_root.to_path_buf();
    let arc = arc.to_string();
    tokio::task::spawn_blocking(move || {
        let worktree = tugarc_core::ops::worktree_path(&repo_root, &arc);
        if !worktree.is_dir() {
            return Err(format!(
                "arc `{arc}` has no worktree in {}, so the trip has nowhere to stand",
                repo_root.display()
            ));
        }
        for args in [["reset", "--hard"].as_slice(), ["clean", "-fd"].as_slice()] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&worktree)
                .args(args)
                .output()
                .map_err(|e| format!("arc `{arc}`'s worktree could not be cleared: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "arc `{arc}`'s worktree could not be cleared: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }
        match tugarc_core::replay::replay_onto(&repo_root, &arc)? {
            tugarc_core::replay::ReplayOutcome::Replayed { .. }
            | tugarc_core::replay::ReplayOutcome::Recorded { .. }
            | tugarc_core::replay::ReplayOutcome::Current => Ok(worktree),
            tugarc_core::replay::ReplayOutcome::Conflicted {
                round,
                round_subject,
                ..
            } => Err(format!(
                "arc `{arc}` could not be replayed onto the base: round {round} \
                 (`{round_subject}`) conflicts"
            )),
            // An arc with nothing on it is the ordinary state of a tripwire
            // that has not committed yet, and a replay with no rounds to move
            // defers rather than fast-forwarding. The worktree still has to
            // stand on the base's tip, so it is moved there directly — the
            // arc is an ancestor of the base by construction, which is what
            // makes `--ff-only` the honest spelling.
            tugarc_core::replay::ReplayOutcome::Deferred { reason, .. }
                if reason == "no-rounds" =>
            {
                let base = tugarc_core::ops::arc_base_in(&repo_root, &arc)?;
                let out = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&worktree)
                    .args(["merge", "--ff-only", &base])
                    .output()
                    .map_err(|e| format!("arc `{arc}` could not be moved onto `{base}`: {e}"))?;
                if !out.status.success() {
                    return Err(format!(
                        "arc `{arc}` could not be moved onto `{base}`: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
                Ok(worktree)
            }
            tugarc_core::replay::ReplayOutcome::Deferred { reason, detail } => Err(format!(
                "arc `{arc}` could not be replayed onto the base: {reason} — {detail}"
            )),
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("the replay task could not be run: {e}")))
}

/// The run itself, in the tripwire's own worktree.
async fn run_in_tree(
    config: &TripwireEngineConfig,
    db: &Db,
    sessions: Arc<dyn TripwireSessionRunner>,
    run: &mut PendingRun,
    worktree: &Path,
    arc: &str,
) -> Settled {
    let tree = worktree;
    let mut probe_report = None;
    // Read before anything runs, because "how many rounds did *this trip*
    // commit" is a difference rather than a count: the arc is permanent and
    // carries every earlier trip's rounds ([P02]).
    let home_root = PathBuf::from(&run.home_root);
    let rounds_before = round_count_in(&home_root, arc);

    // The probe, when the tripwire has one, in the trip's tree. Its exit is
    // the whole decision procedure: green means the thing the tripwire watches for
    // is not wrong here, and no model needs to be asked ([P10]).
    if let Some(command) = run.probe.clone() {
        let probe = run_probe(&command, tree).await;
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            let _ = ledger::record_probe(&conn, run.trip_id, probe.exit, &probe.tail);
        }
        crate::feeds::tripwires::bump();
        if probe.exit == 0 {
            return Settled::done(Some(format!("`{command}` exited 0; nothing to report")));
        }
        probe_report = Some(prompt::ProbeReport {
            command,
            exit: probe.exit,
            tail: probe.tail,
        });
    }

    // Everything the session is told, assembled here rather than reconstructed
    // by it (Spec S02). The fact is read back off the row rather than out of
    // memory: after a restart the row's payload is the only record there is.
    let sessions_named: Vec<String> = run.fact_session.clone().into_iter().collect();
    let trip_prompt = prompt::TripPrompt {
        fact: prompt::fact_from_evidence(&run.evidence).unwrap_or_else(|| {
            crate::session_ledger::FactRow {
                id: 0,
                at_ms: (config.now_ms)(),
                kind: "unknown".to_string(),
                session_id: run.fact_session.clone(),
                subject: None,
                text: "This trip's fact could not be read back off its row.".to_string(),
                payload: "{}".to_string(),
            }
        }),
        repo_root: run.repo_root.clone(),
        arc: arc.to_string(),
        tree: tree.to_path_buf(),
        session: prompt::session_transcripts(&config.ledger, &sessions_named),
        probe: probe_report,
    };

    // The trip's one session, in the tripwire's arc worktree and under the
    // tripwire's own permission mode: a trip is one session with hands from
    // its first turn ([P01]).
    let trip = run_phase(
        config,
        db,
        sessions.as_ref(),
        TripwireSessionRequest {
            tripwire: run.tripwire.clone(),
            worktree: tree.to_path_buf(),
            permission_mode: run.permission_mode.clone(),
            model: run.model.clone(),
            prompt: trip_prompt.prompt(&run.brief, &closing_rule()),
            max_seconds: run.max_seconds,
            max_tool_calls: run.max_tool_calls,
            seated: None,
        },
        run.trip_id,
    )
    .await;
    if let Some(session_id) = trip.session_id.clone() {
        run.session_id = Some(session_id.clone());
    }
    // The row already names the session: the phase wrote it at seat time,
    // which is what the row's session dot reads. All that is left here is to
    // carry the id into the run for `settle` and `post_settled`.

    // What the trip amounted to, in the two facts nobody had to be asked for
    // ([P04]): the session's last words, and whether it committed anything on
    // the arc it was standing in. The report is written whatever the settle
    // does with the row, because the words are never the casualty of a race.
    let rounds = (round_count_in(&home_root, arc).saturating_sub(rounds_before)) as i64;
    let mut settled = trip.settled;
    settled.report = Some(trip.closing.clone());
    {
        let conn = db.lock().expect("tripwire ledger mutex");
        let _ = ledger::record_report(&conn, run.trip_id, &trip.closing, rounds);
        // A trip that committed names its arc, and a trip that did not leaves
        // the column NULL — which is Spec S02's "always `tripwire-<name>` for a
        // trip that committed", and the one thing that writes it. `record_run`
        // puts the row back to `running` as it writes, which is where it still
        // is: the settle is the caller's next act.
        if rounds > 0 {
            run.arc = Some(arc.to_string());
            let _ = ledger::record_run(&conn, run.trip_id, run.session_id.as_deref(), Some(arc));
        }
    }
    if rounds > 0 {
        run.engine_refs.push(OverviewRef {
            kind: OverviewRefKind::Arc,
            target: arc.to_string(),
        });
    }
    crate::feeds::tripwires::bump();
    settled
}

/// What one phase of a run amounted to.
struct Phase {
    session_id: Option<String>,
    /// The session's last words, read off its transcript — the trip's report
    /// ([P04]). The caller writes it to the row.
    closing: String,
    /// What the run amounted to: done, failed, or skipped for a full host.
    settled: Settled,
}

/// Spawn one session and wait for it to end — finished, dead, or refused by a
/// host with no room. Nothing else ends the wait: a session that is alive is
/// doing the tripwire's work, however long that takes.
///
/// There is no second thing to watch for any more. The wait used to poll the
/// trip row beside the turn, because the row was the only channel between this
/// engine and a `tugtool resolve` running in another process; with the verbs
/// gone the session's own ending is the whole of the signal, and what the
/// session *found* is read off its transcript rather than out of a column it
/// wrote ([P04]).
///
/// The first thing the phase writes is the seat: the runner sends the session
/// id the moment the supervisor has one, and this loop puts it on the row
/// before the session's first turn ends, so a running trip is one a reader can
/// open ([B04], [F05]).
async fn run_phase(
    config: &TripwireEngineConfig,
    db: &Db,
    sessions: &dyn TripwireSessionRunner,
    mut request: TripwireSessionRequest,
    trip_id: i64,
) -> Phase {
    let (seated_tx, mut seated_rx) = tokio::sync::oneshot::channel();
    request.seated = Some(seated_tx);
    let running = sessions.run(request);
    tokio::pin!(running);

    // The seat's own guard, and deliberately not `seated_id.is_none()`: a
    // `oneshot::Receiver` completes on `Err(RecvError)` as well as on a value,
    // and that is every path where the runner drops the sender without sending
    // — both spawn-failure arms, and any fake that ignores `seated`. There the
    // id stays `None`, a guard reading it would leave the arm enabled, and the
    // select would poll a completed receiver and panic inside the engine's run
    // task. This flag is set in both outcomes, so the arm disables itself
    // either way.
    let mut seat_read = false;
    let mut seated_id: Option<String> = None;
    let answered: Result<TripwireSessionOutcome, RunRefusal> = loop {
        tokio::select! {
            biased;
            seated = &mut seated_rx, if !seat_read => {
                seat_read = true;
                if let Ok(id) = seated {
                    {
                        let conn = db.lock().expect("tripwire ledger mutex");
                        let _ = ledger::record_session_if_running(&conn, trip_id, &id);
                    }
                    info!(trip = trip_id, session = %id, "tripwire session seated");
                    seated_id = Some(id);
                    crate::feeds::tripwires::bump();
                }
            }
            ended = &mut running => break ended,
        }
    };

    let outcome = answered.as_ref().ok();
    let phase = |settled| Phase {
        // The seat's id first: it is the one that survives a run whose session
        // id the runner never returned, which is the path that used to lose a
        // session id for good ([F06]).
        session_id: seated_id
            .clone()
            .or_else(|| outcome.map(|o| o.session_id.clone())),
        closing: outcome.map(closing_prose).unwrap_or_default(),
        settled,
    };

    let ended = match &answered {
        Ok(o) => Ok(o.end),
        Err(e) => Err(e),
    };
    let headline = unresolved_headline(ended);

    // A full host is not a trip that failed. The engine asked before it
    // committed to this run, so getting here means a card took the last slot in
    // between — and the answer to that race is a skip that says so ([P04]).
    // The same row the consider-time gate writes for the same condition, so
    // the two spellings of one event read alike on the card. There is no queue
    // to go back to: the next matching fact is along in seconds.
    //
    // It is also the one outcome this function writes, because it is the one
    // the caller must not overwrite: `settle` reads a `Skipped` and leaves the
    // row alone.
    if matches!(ended, Err(RunRefusal::HostFull(_))) {
        let skipped = Settled::skipped(ledger::SKIP_NO_ROOM, headline);
        {
            let conn = db.lock().expect("tripwire ledger mutex");
            let _ = ledger::settle_if_running(
                &conn,
                trip_id,
                skipped.status,
                &skipped.settlement,
                (config.now_ms)(),
            );
        }
        crate::feeds::tripwires::bump();
        return phase(skipped);
    }

    // A session that ran to the end is done, whatever it said — the words are
    // the report and this is only the row's word for "it finished" ([P05]).
    // Everything else ended without producing one.
    if matches!(ended, Ok(SessionEnd::Finished)) {
        return phase(Settled::done(None));
    }
    // A session the engine stopped is a failure that says which ceiling it
    // crossed, which is [Q01]'s whole evidence ([P06]).
    if let Ok(SessionEnd::Capped(kind)) = ended {
        return phase(Settled::capped(kind, headline));
    }
    phase(Settled::failed(headline))
}

/// The headline for a run that produced no report. The faults are different
/// and a reader of the trip log has to be able to tell them apart: the session
/// never ran, or it died partway.
///
/// The third case is not a fault at all, and says so: a host at its spawn
/// budget is busy rather than broken, and the row it writes is a skipped one.
///
/// A session that simply *finished* never reaches here: it is `done`, and what
/// it found is its report rather than a sentence written for it ([P04]).
fn unresolved_headline(ended: Result<SessionEnd, &RunRefusal>) -> String {
    match ended {
        Err(RunRefusal::HostFull(_)) => {
            // Not "waiting for one": there is nothing to wait in. The queue
            // that sentence described was retired with the old trigger, and
            // the headline wins over the row's own sentence on the card — so a
            // `skipped`/`no-room` row said a trip would still happen.
            "the host had no room for the tripwire's session, so the trip did not run".to_string()
        }
        Err(refusal) => format!("the tripwire's session did not run: {}", refusal.message()),
        Ok(SessionEnd::Died) => "the tripwire's session died before it could report".to_string(),
        Ok(SessionEnd::Finished) => "the tripwire's session finished".to_string(),
        Ok(SessionEnd::Capped(CapKind::Seconds)) => {
            "the tripwire's session ran past the seconds it is allowed, and was stopped".to_string()
        }
        Ok(SessionEnd::Capped(CapKind::ToolCalls)) => {
            "the tripwire's session spent every tool call it is allowed, and was stopped"
                .to_string()
        }
    }
}

/// The session's last words, read off its own JSONL transcript.
///
/// This is the trip's report ([P04]): what a trip amounted to is what its
/// session said at the end of its turn, and nothing else. It is read rather
/// than asked for, so a session that forgets to say anything leaves an empty
/// report rather than an unsettled trip.
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

/// The one rule the engine appends to the brief ([B08]).
///
/// One rule, and it offers no choices. The menu that stood here — resolve
/// with one word or another — asked the model to decide whether its own
/// findings deserved the user's attention, which is a judgment the brief is
/// what should be making. So the appended text tells it nothing about *what*
/// to do, only where to put what it found: the last words of the turn are the
/// report, and the engine reads them off the transcript itself ([P04]).
fn closing_rule() -> String {
    "End your turn with a short report of what you found and what you did. Your last \
     message is what the user reads; nothing else you say is kept."
        .to_string()
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

/// How a trip finished, ready for the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub status: TripStatus,
    pub settlement: ledger::Settlement,
    /// The session's last words, when the trip ran a session ([P04]).
    ///
    /// Beside the settlement rather than inside it, because the ledger writes
    /// the two with different statements and for different reasons: the report
    /// is what the session produced, and the settlement is the engine's
    /// judgment about the run that produced it.
    pub report: Option<String>,
}

impl Settled {
    /// A trip that ran to its end ([P05]). The headline is the engine's own
    /// sentence for the two endings that ran no session at all — a green probe,
    /// and an instance with nothing to ask — and `None` for a session that
    /// finished, whose words are the report rather than a line written for it.
    ///
    /// The two cases keep one constructor because they are one status, and a
    /// row that carries neither a headline nor a report has not happened: the
    /// trip log is where a reader goes to ask why a tripwire did nothing, and
    /// a settled row with no words is the one answer that surface cannot give.
    fn done(headline: Option<String>) -> Self {
        Settled {
            status: TripStatus::Done,
            settlement: ledger::Settlement {
                headline,
                ..ledger::Settlement::default()
            },
            report: None,
        }
    }

    /// A run that produced no report, and says why in the headline a reader
    /// of the trip log will actually see.
    fn failed(headline: String) -> Self {
        Settled {
            status: TripStatus::Failed,
            settlement: ledger::Settlement {
                headline: Some(headline),
                ..ledger::Settlement::default()
            },
            report: None,
        }
    }

    /// A session the engine stopped at one of the tripwire's two ceilings
    /// ([P06]).
    ///
    /// A `failed` row like any other, and the reason is what makes it useful:
    /// one word a surface can render, and the thing [Q01] is settled by
    /// counting. The report is written by the caller whatever this says — a
    /// capped session still said something, and its words are not the
    /// casualty of the cap.
    fn capped(kind: CapKind, headline: String) -> Self {
        let reason = match kind {
            CapKind::Seconds => ledger::FAIL_CAP_SECONDS,
            CapKind::ToolCalls => ledger::FAIL_CAP_TOOL_CALLS,
        };
        Settled {
            status: TripStatus::Failed,
            settlement: ledger::Settlement {
                headline: Some(headline),
                reason: Some(reason.to_string()),
                ..ledger::Settlement::default()
            },
            report: None,
        }
    }

    /// The fact matched and the run did not happen — the host was full, or the
    /// machine was at its ceiling ([P04]). It carries both a reason a surface
    /// can render in one word and a headline a reader of the trip log can
    /// read, because a bare `skipped` answers neither.
    fn skipped(reason: &'static str, headline: String) -> Self {
        Settled {
            status: TripStatus::Skipped,
            settlement: ledger::Settlement {
                headline: Some(headline),
                reason: Some(reason.to_string()),
                ..ledger::Settlement::default()
            },
            report: None,
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
    // Each arm that writes nudges the roster feed. Every one of those is
    // latency and none of them is the mechanism: the feed's `data_version`
    // probe sees the same commit within its interval whatever happens here
    // ([P02]).
    // A skip is already on disk: the phase that met the full host wrote it
    // through the same compare-and-set the settle below uses, so a second
    // unconditional write here would stamp over whatever the verb may have
    // landed in between ([P04]).
    if settled.status == TripStatus::Skipped {
        info!(
            tripwire = %run.tripwire,
            trip = run.trip_id,
            reason = settled.settlement.reason.as_deref().unwrap_or_default(),
            "tripwire skipped: the trip did not run"
        );
        return;
    }
    // The compare-and-set rather than a bare write, because this engine is no
    // longer the only thing that can move a `running` row: another instance's
    // orphan sweep reaches for the same rows, and a trip it already failed
    // must not be dragged back out of that outcome (Risk R03). A row that has
    // moved is one somebody else settled, and its words are theirs.
    match ledger::settle_if_running(
        conn,
        run.trip_id,
        settled.status,
        &settled.settlement,
        (config.now_ms)(),
    ) {
        Err(e) => {
            warn!(error = %e, tripwire = %run.tripwire, "tripwire engine: settle failed");
            return;
        }
        Ok(false) => {
            info!(
                tripwire = %run.tripwire,
                trip = run.trip_id,
                "tripwire settle: the row had already moved"
            );
            return;
        }
        Ok(true) => {}
    }
    crate::feeds::tripwires::bump();
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
/// **A trip that ran a session and said something, and nothing else.** The
/// report *is* the raised hand ([P04]): a trip that answered its brief has
/// words for the user, and this is what puts them where the user reads them.
/// The two endings that run no session — a green probe, an instance with
/// nothing to ask — have only the engine's own sentence, and a failure has
/// only a fault; all three are rows in the trip log, which is where a reader
/// asking after a tripwire already goes.
///
/// The tripwire's name rides `wake_reason` as `tripwire:<name>`, which is what
/// the deck labels the row from — the author says a tripwire spoke, and the
/// reason says which one. Every ref on it is one the engine wrote down itself:
/// the fact's session, and the arc if the run staged one.
fn post_settled(config: &TripwireEngineConfig, run: &PendingRun, settled: &Settled) {
    let Some(overview_tx) = config.overview_tx.as_ref() else {
        return;
    };
    if settled.status != TripStatus::Done {
        return;
    }
    let Some(body) = settled
        .report
        .clone()
        .filter(|report| !report.trim().is_empty())
    else {
        // A post with an empty body is worse than no post, and an empty report
        // is reachable: a session may end its turn having said nothing at all.
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

/// Whether a fact's repository falls under a tripwire's scope.
///
/// Raw prefix, compared as canonical paths, and deliberately **not** folded to
/// a base checkout: a trip's session commits on the tripwire's own arc
/// worktree, and folding worktrees into the checkout they forked from would
/// make those commits re-trip the tripwire that made them. An unscoped
/// tripwire watches the machine.
fn in_scope(scope: Option<&str>, path: &str) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    let scope = scope.trim_end_matches('/');
    path == scope || path.starts_with(&format!("{scope}/"))
}

/// The key a fact's trip is written under: `fact:<instance>:<rowid>`.
///
/// Qualified by instance because a rowid is only unique within one instance's
/// session ledger, and two instances on one machine share `tripwires.db`. A
/// trip re-read after a restart therefore lands on the row it already has
/// rather than minting a second one for the same fact.
fn event_key(instance: &str, fact_id: i64) -> String {
    format!("fact:{instance}:{fact_id}")
}

/// The evidence a trip carries forward: the fact, whole (Spec S01).
///
/// Written onto the row rather than kept in memory, because the run composes
/// its prompt and its post minutes later, on another task, with the live row
/// long out of reach — and after a restart this row is the only record of the
/// fact there is.
fn fact_payload(fact: &crate::session_ledger::FactRow) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "fact": {
            "id": fact.id,
            "at_ms": fact.at_ms,
            "kind": fact.kind,
            "session_id": fact.session_id,
            "subject": fact.subject,
            "text": fact.text,
            "payload": serde_json::from_str::<serde_json::Value>(&fact.payload)
                .unwrap_or(serde_json::Value::Null),
        },
    }))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::agent_supervisor::AgentSupervisorConfig;
    use tugtool_core::tripwire_ledger::NewTripwire;

    /// What a duration in this engine may bound ([B06]).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Bounds {
        /// An arbitrary command run unattended, which must be killable.
        Probe,
        /// Another instance's crash, which age is the only evidence of.
        Orphan,
        /// How often a record is re-read; never a deadline on anything.
        Poll,
        /// A live session, and the only one that may be: the wait a capped
        /// session is given to end its turn politely before the engine
        /// closes it ([P06]). It bounds the *wait*, not the work — the work
        /// is bounded by the tripwire's own row, which is a number somebody
        /// set rather than a constant here.
        CappedSessionGrace,
    }

    /// What a concurrency count in this facility rations ([B03]).
    ///
    /// The two are not the same budget wearing two names, and the whole of
    /// this step is saying so in a place that can fail: they guard different
    /// resources, at different scopes, recorded in different places.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Rations {
        /// Arc worktrees, machine-wide and durable. Counted across every
        /// instance sharing `tripwires.db`, because a commit storm must not
        /// fan out one worktree per commit however many tugcasts see it.
        WorktreesMachineWide,
        /// Private memory, in this process and nowhere else. Counted over the
        /// supervisor's in-memory ledger, because a live session is a pair of
        /// subprocesses this host has to carry.
        MemoryPerProcess,
    }

    /// Every concurrency budget in this facility says which resource it
    /// guards, and the trip ceiling can never exceed what the host would
    /// admit ([B03]).
    ///
    /// The two compose rather than duplicating one another, which is why
    /// neither was folded into the other — but nothing made them agree, and a
    /// `settings` row could name a trip ceiling far above the host's session
    /// cap with nothing noticing. The clamp is the fix and this is its guard,
    /// in the shape the duration guard above established: the counts are
    /// enumerated with what each rations, the sources are scanned so a third
    /// budget added later has to be named, and the relation is asserted
    /// through the reader the engine actually calls rather than against the
    /// constant alone.
    #[test]
    fn each_budget_says_what_it_rations_and_the_trip_ceiling_fits_the_hosts() {
        let host = AgentSupervisorConfig::default().max_concurrent_sessions as i64;
        let declared: &[(&str, i64, Rations)] = &[
            (
                "DEFAULT_MAX_CONCURRENT_TRIPS",
                ledger::DEFAULT_MAX_CONCURRENT_TRIPS,
                Rations::WorktreesMachineWide,
            ),
            (
                "MAX_CONCURRENT_TRIPS_LIMIT",
                ledger::MAX_CONCURRENT_TRIPS_LIMIT,
                Rations::WorktreesMachineWide,
            ),
            ("max_concurrent_sessions", host, Rations::MemoryPerProcess),
        ];

        // A budget is a count, so the scan reads declarations whose type is an
        // integer: a `const`, a `static`, or a struct field. That is what
        // catches `max_concurrent_sessions`, which is a field rather than a
        // constant, and what leaves `SETTING_MAX_CONCURRENT_TRIPS` — a
        // settings key, not a count — alone.
        let mut seen: Vec<&str> = Vec::new();
        for source in [
            include_str!("tripwire.rs"),
            include_str!("agent_supervisor.rs"),
            include_str!("../../../tugtool-core/src/tripwire_ledger.rs"),
        ] {
            for line in source.lines() {
                let line = line.trim_start();
                let line = match line.strip_prefix("pub") {
                    Some(rest) => rest.trim_start_matches(|c| c != ' ').trim_start(),
                    None => line,
                };
                let rest = line
                    .strip_prefix("const ")
                    .or_else(|| line.strip_prefix("static "))
                    .unwrap_or(line);
                let Some((name, ty)) = rest.split_once(':') else {
                    continue;
                };
                let name = name.trim();
                if !name.to_ascii_lowercase().contains("concurrent") {
                    continue;
                }
                // Up to the initializer: a `const` carries `= 64;` after its
                // type and a struct field carries a trailing comma, and both
                // have to come off before the type is a type.
                let ty = ty
                    .split('=')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .trim_end_matches([',', ';', ' ']);
                if !matches!(ty, "i64" | "usize" | "u32" | "u64" | "i32") {
                    continue;
                }
                assert!(
                    declared.iter().any(|(n, _, _)| *n == name),
                    "`{name}` is a concurrency budget this test does not know; say which \
                     resource it rations, and it may not exceed what the host will admit"
                );
                seen.push(name);
            }
        }
        // And the scan reached every one of them. A guard that stopped reading
        // its own sources would pass for the same reason an empty one does.
        for (name, _, _) in declared {
            assert!(
                seen.contains(name),
                "the scan never found `{name}`; it is no longer reading what it claims to"
            );
        }

        // The relation, in the direction that matters. A trip's session is an
        // ordinary session and spends the host's budget like every other, so
        // every worktree budget has to fit inside the memory one; the reverse
        // is false and deliberately not asserted, because 64 cards are fine
        // and 64 arc worktrees are not.
        for (name, value, rations) in declared {
            if *rations == Rations::WorktreesMachineWide {
                assert!(
                    *value <= host,
                    "{name} is {value}, above the {host} sessions the host will admit — a \
                     ceiling the machine could never honour is not a ceiling"
                );
                assert!(
                    *value <= ledger::MAX_CONCURRENT_TRIPS_LIMIT,
                    "{name} is {value}, above the bound a settings row is clamped to — a \
                     ceiling above the clamp is one the clamp cannot enforce"
                );
            }
        }

        // Through the reader the engine calls, because that is where the clamp
        // either happens or does not. A settings row is a number somebody
        // typed, and nothing stops them typing a million.
        let h = harness();
        for typed in ["1000000", "65", "-1", "not a number", "0"] {
            ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, typed).unwrap();
            let effective = ledger::max_concurrent_trips(&h.conn).unwrap();
            assert!(
                effective > 0 && effective <= host,
                "a settings row of {typed:?} yielded {effective}, outside the 1..={host} the \
                 host would admit"
            );
        }
    }

    /// No constant in the engine decides how long a trip's session may work
    /// ([B06]). Every `Duration` the two engine files declare is enumerated
    /// here with what it bounds, and the source is scanned so a constant
    /// added later has to be named — the ceiling cannot come back on the
    /// strength of a doc comment's argument.
    ///
    /// A trip *is* bounded now, and by two numbers rather than none: the
    /// tripwire's own `max_seconds` and `max_tool_calls` ([P06]). Neither is
    /// in this list and neither could be, because neither is a constant —
    /// they are columns, per tripwire, set by whoever laid it. The one
    /// duration here that touches a live session at all is the grace a capped
    /// one gets to end its turn before the close, and it is called out as
    /// such below rather than filed under a poll.
    #[test]
    fn every_remaining_duration_bounds_a_probe_an_orphan_a_poll_or_a_capped_sessions_grace() {
        let declared: &[(&str, Duration, Bounds)] = &[
            ("SWEEP_TICK", SWEEP_TICK, Bounds::Poll),
            ("PROBE_TIMEOUT", PROBE_TIMEOUT, Bounds::Probe),
            ("ORPHANED_RUN_AGE", ORPHANED_RUN_AGE, Bounds::Orphan),
            ("CAP_GRACE", CAP_GRACE, Bounds::CappedSessionGrace),
            (
                "SESSION_READ_INTERVAL",
                crate::feeds::tripwire_session::SESSION_READ_INTERVAL,
                Bounds::Poll,
            ),
        ];
        let mut seen: Vec<&str> = Vec::new();
        for source in [
            include_str!("tripwire.rs"),
            include_str!("tripwire_session.rs"),
        ] {
            for line in source.lines() {
                // Any visibility, not the two these files happen to wear
                // today. The constant this test exists to keep out was
                // declared `pub const TRIPWIRE_RUN_TIMEOUT`, so a scan blind
                // to `pub` is blind at exactly the shape the ceiling would
                // come back in.
                let line = line.trim_start();
                let line = match line.strip_prefix("pub") {
                    Some(rest) => rest.trim_start_matches(|c| c != ' ').trim_start(),
                    None => line,
                };
                let Some(rest) = line
                    .strip_prefix("const ")
                    .or_else(|| line.strip_prefix("static "))
                else {
                    continue;
                };
                let Some((name, ty)) = rest.split_once(':') else {
                    continue;
                };
                if !ty.trim_start().starts_with("Duration") {
                    continue;
                }
                let name = name.trim();
                assert!(
                    declared.iter().any(|(n, _, _)| *n == name),
                    "`{}` is a duration this test does not know; say what it bounds, and it \
                     may not be a live session",
                    name
                );
                seen.push(name);
            }
        }
        // And the scan reached every one of them: a guard that silently stops
        // reading its own sources would pass for the same reason an empty one
        // does.
        for (name, _, _) in declared {
            assert!(
                seen.contains(name),
                "the scan never found `{name}`; it is no longer reading what it claims to"
            );
        }
        // A poll is a cadence, not a deadline: short enough that nothing waits
        // on it noticeably, and nothing it reads is failed by it.
        for (name, value, bounds) in declared {
            if *bounds == Bounds::Poll {
                assert!(
                    *value <= Duration::from_secs(10),
                    "{name} is too long to be a poll and too short to be anything else"
                );
            }
        }
        // The one age that fails a row belongs to another instance's crash,
        // and it stands past the one bounded thing a run contains.
        assert!(ORPHANED_RUN_AGE > PROBE_TIMEOUT);
        assert!(
            declared
                .iter()
                .filter(|(_, _, b)| *b == Bounds::Orphan)
                .count()
                == 1
        );
        // And exactly one duration touches a live session: the grace. It is
        // a wait for a turn to end, so it is short — anything long enough to
        // be mistaken for a working budget is the ceiling coming back under
        // another name.
        let graces: Vec<_> = declared
            .iter()
            .filter(|(_, _, b)| *b == Bounds::CappedSessionGrace)
            .collect();
        assert_eq!(graces.len(), 1);
        assert!(
            graces[0].1 <= Duration::from_secs(30),
            "{} is {:?}, long enough to read as a budget rather than a grace",
            graces[0].0,
            graces[0].1
        );
    }
    /// The retired words stay out of the tripwire surface ([B05][B06], [P09]).
    /// Every file the feature owns is read here and each line is checked for
    /// the nouns the rename retired, with the old spellings allowed only in
    /// the regions named below — the migrations that read what is on disk and
    /// the fixtures that exercise them — each named individually so a new
    /// exemption has to be argued for here. A repo-wide grep would not do: the
    /// deck says `wire` for its protocol, and that word is not this feature's
    /// to retire.
    ///
    /// **The scan is a substring scan and stays one.** Each line is lowercased,
    /// the literal `tripwire` is taken out of it so the feature's own noun does
    /// not trip on `wire`, and the rest is checked with `contains`. Nothing
    /// tokenises, which is why one entry `swallow` catches `swallowed` and
    /// `swallow_reason` and one entry `supersede` catches `superseded`. Do not
    /// add word-boundary matching: the answer to a false positive is a narrower
    /// spelling or a named `Exempt` region ([P09]).
    #[test]
    fn the_retired_words_stay_out_of_the_tripwire_surface() {
        const RETIRED: [&str; 20] = [
            "wire",
            "dash",
            "envelope",
            "tier",
            // What the fact-time reset retired ([P09]). Narrow spellings on
            // purpose: bare `mark` hits the card's `TripMark`, and bare `claim`
            // hits `arc create`'s `claim_arc`, so the list takes the spellings
            // the retired concepts actually wore.
            "landing",
            "lineage",
            "swallow",
            "supersede",
            "dossier",
            "high-water",
            "fact_mark",
            "claim_trip",
            // What one session with hands retired ([P01]): the second spawn
            // and the column that carried the ask which opened it.
            "author_ask",
            "authoring",
            // What the tripwire's own permanent arc retired ([P02], [P03]):
            // the tree cut at a sha and thrown away after.
            "disposable",
            "inspection tree",
            // What the report and the four statuses retired ([P04], [P05]):
            // two finished statuses that said what the model chose to say.
            "awaiting",
            "adopted",
            // And the third, by the spellings the *status* wore rather than
            // bare. `quiet` is an ordinary English word this surface still
            // needs — a session goes quiet, `CAP_GRACE` waits for it to — and
            // the scan reads whole lines with `contains`, so a bare entry
            // would fail the build on correct code. `SessionRead::Quiet` is
            // live for the same reason, which is why `::Quiet` is not here
            // either.
            "'quiet'",
            "\"quiet\"",
        ];
        let surface: &[(&str, &str)] = &[
            (
                "tugtool-core/src/tripwire_ledger.rs",
                include_str!("../../../tugtool-core/src/tripwire_ledger.rs"),
            ),
            (
                "tugtool-core/src/tripwire_roster.rs",
                include_str!("../../../tugtool-core/src/tripwire_roster.rs"),
            ),
            (
                "tugtool-core/src/tripwire_predicate.rs",
                include_str!("../../../tugtool-core/src/tripwire_predicate.rs"),
            ),
            ("tugcast/src/feeds/tripwire.rs", include_str!("tripwire.rs")),
            (
                "tugcast/src/feeds/tripwire_session.rs",
                include_str!("tripwire_session.rs"),
            ),
            (
                "tugcast/src/feeds/tripwire_prompt.rs",
                include_str!("tripwire_prompt.rs"),
            ),
            (
                "tugcast/src/tripwires_api.rs",
                include_str!("../tripwires_api.rs"),
            ),
            (
                "tugtool/src/tripwire.rs",
                include_str!("../../../tugtool/src/tripwire.rs"),
            ),
            (
                "tugdeck/src/lib/tripwires-store.ts",
                include_str!("../../../../../tugdeck/src/lib/tripwires-store.ts"),
            ),
            (
                "tugdeck/src/components/tripwires/tripwires-card.tsx",
                include_str!("../../../../../tugdeck/src/components/tripwires/tripwires-card.tsx"),
            ),
            (
                "tugdeck/src/components/tripwires/tripwire-presentation.ts",
                include_str!(
                    "../../../../../tugdeck/src/components/tripwires/tripwire-presentation.ts"
                ),
            ),
            (
                "tugdeck/src/components/tripwires/trip-log.ts",
                include_str!("../../../../../tugdeck/src/components/tripwires/trip-log.ts"),
            ),
            (
                "tugplug/skills/tripwire/SKILL.md",
                include_str!("../../../../../tugplug/skills/tripwire/SKILL.md"),
            ),
        ];

        /// A region the old words may stand in: it opens on the first line
        /// containing `opens` and runs through the first line equal to
        /// `closes`. A region whose opener is also its closer is one line.
        struct Exempt {
            file: &'static str,
            name: &'static str,
            opens: &'static str,
            closes: &'static str,
        }
        let ledger = "tugtool-core/src/tripwire_ledger.rs";
        let exempt = [
            // The migrations spell the shapes they read from disk.
            Exempt {
                file: ledger,
                name: "the v1 → v2 migration",
                opens: "const MIGRATE_V1_TO_V2: &str",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the v4 → v5 migration",
                opens: "const MIGRATE_V4_TO_V5: &str",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the trip column rename",
                opens: "fn migrate_trips_arc_column(",
                closes: "}",
            },
            Exempt {
                file: ledger,
                name: "the table and column rename",
                opens: "fn migrate_tripwire_names(",
                closes: "}",
            },
            // The fixtures that lay an old ledger down, and the tests that
            // open one and say what the migrations made of it.
            Exempt {
                file: ledger,
                name: "the v1 DDL fixture",
                opens: "const V1_LEDGER_SQL: &str",
                closes: "    \";",
            },
            Exempt {
                file: ledger,
                name: "the v1 ledger fixture",
                opens: "/// A ledger as v1 left it",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v4 → v5 rename test",
                opens: "fn a_v4_ledger_renames_the_trip_arc_column_and_its_swallow_value(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v1 migration test",
                opens: "fn a_v1_ledger_migrates_its_rows_and_drops_the_retired_columns(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v5 DDL fixture",
                opens: "/// The v5 DDL, verbatim",
                closes: "    \";",
            },
            Exempt {
                file: ledger,
                name: "the v6 DDL fixture",
                opens: "/// The v6 DDL, verbatim",
                closes: "    \";",
            },
            Exempt {
                file: ledger,
                name: "the v5 ledger fixture",
                opens: "fn v5_ledger(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v5 → v6 rename test",
                opens: "fn a_v5_ledger_renames_its_tables_and_column_and_keeps_every_row(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the interrupted rename test",
                opens: "fn a_rename_interrupted_before_the_stamp_is_finished_on_the_next_open(",
                closes: "    }",
            },
            // The v8 migration drops the retired marks table under both names
            // it has worn, and the older of the two is `wire_marks`. A
            // migration names what is on disk, whatever the surface calls it
            // now ([P09]).
            Exempt {
                file: ledger,
                name: "the v8 marks drop",
                opens: "DROP TABLE IF EXISTS wire_marks;",
                closes: "    conn.execute_batch(\"DROP TABLE IF EXISTS tripwire_marks; DROP TABLE IF EXISTS wire_marks;\")?;",
            },
            // The v8 migration names the four statuses it maps, and the probe
            // beside it names the column it renames. A migration says what is
            // on disk, whatever the surface calls it now ([P09]).
            Exempt {
                file: ledger,
                name: "the v7 → v8 status map",
                opens: "const MIGRATE_V7_TO_V8: &str",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the trips reason column rename",
                opens: "fn migrate_trips_reason_column(",
                closes: "}",
            },
            // The migrations that carry the retired vocabulary across: each
            // names a shape that is on disk, or was, and a migration that
            // could not say `author_ask` could not drop the column.
            Exempt {
                file: ledger,
                name: "the v2 → v3 migration",
                opens: "/// v2 → v3: a resolution may ask for a change to be authored",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the v8 → v9 migration",
                opens: "/// v8 → v9: a trip is one session with hands",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the author-ask drop",
                opens: "fn migrate_trips_author_ask(",
                closes: "}",
            },
            Exempt {
                file: ledger,
                name: "the author-ask drop's call",
                opens: "    migrate_trips_author_ask(conn)?;",
                closes: "    migrate_trips_author_ask(conn)?;",
            },
            Exempt {
                file: ledger,
                name: "the v9 → v10 migration",
                opens: "/// v9 → v10: a tripwire owns one arc",
                closes: "\";",
            },
            Exempt {
                file: ledger,
                name: "the v10 → v11 status collapse",
                opens: "/// v10 → v11: a trip ends with a report",
                closes: "\";",
            },
            // And the fixtures those migrations are run against, each laying
            // an old ledger down in the words it was written in.
            Exempt {
                file: ledger,
                name: "the v8 DDL fixture",
                opens: "/// A ledger as v8 left it",
                closes: "    \";",
            },
            Exempt {
                file: ledger,
                name: "the v8 ledger fixture",
                opens: "fn v8_ledger(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v9 DDL fixture",
                opens: "/// A ledger as v9 left it",
                closes: "    \";",
            },
            Exempt {
                file: ledger,
                name: "the v9 ledger fixture",
                opens: "fn v9_ledger(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v9 → v10 migration test",
                opens: "/// **The tripwire gains its home checkout",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v10 ledger fixture",
                opens: "fn v10_ledger(",
                closes: "    }",
            },
            Exempt {
                file: ledger,
                name: "the v8 → v9 migration test",
                opens: "fn a_v8_ledger_drops_the_author_ask_column_and_keeps_its_rows(",
                closes: "    }",
            },
            // `tier` is also a `TugSessionIdentity` prop — the size a session
            // chip is drawn at — and the card passes it to render the worker
            // beside a running tripwire. The scan reads whole lines, so a
            // retired noun and a foreign component's prop that happen to be
            // spelled alike are the same string to it; the word stays retired
            // everywhere else on the surface.
            Exempt {
                file: "tugdeck/src/components/tripwires/tripwires-card.tsx",
                name: "the session chip's size prop",
                opens: "                tier=\"chip\"",
                closes: "                tier=\"chip\"",
            },
            // This test names the words it keeps out.
            Exempt {
                file: "tugcast/src/feeds/tripwire.rs",
                name: "the retired-word guard",
                opens: "/// The retired words stay out of the tripwire surface",
                closes: "    }",
            },
        ];

        let mut used = vec![false; exempt.len()];
        for (file, source) in surface {
            let mut open: Option<usize> = None;
            for (index, line) in source.lines().enumerate() {
                let number = index + 1;
                if let Some(region) = open {
                    if line == exempt[region].closes {
                        open = None;
                    }
                    continue;
                }
                if let Some(region) = exempt
                    .iter()
                    .position(|x| x.file == *file && line.contains(x.opens))
                {
                    used[region] = true;
                    if line != exempt[region].closes {
                        open = Some(region);
                    }
                    continue;
                }
                // The feature's own noun contains the first retired word, so
                // it is taken out before the line is read.
                let bare = line.to_ascii_lowercase().replace("tripwire", "");
                for word in RETIRED {
                    assert!(
                        !bare.contains(word),
                        "`{file}:{number}` says `{word}`, a word the tripwire surface retired, \
                         outside every named exemption:\n{line}"
                    );
                }
            }
            if let Some(region) = open {
                panic!(
                    "{} in `{file}` opened and never closed; its closer no longer matches a line",
                    exempt[region].name
                );
            }
        }
        // And every exemption was found: one whose opener is gone is a region
        // the scan silently stopped guarding.
        for (region, seen) in exempt.iter().zip(used) {
            assert!(
                seen,
                "the scan never found {} in `{}`; its opener no longer matches a line",
                region.name, region.file
            );
        }
    }

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
                "Says what broke and proposes a fix",
            ),
            1,
        )
        .unwrap()
    }

    /// A scoped tripwire, laid.
    fn lay_scoped(conn: &Connection, name: &str, trigger: &str, scope: &str) -> Tripwire {
        let mut tripwire = NewTripwire::new(
            name,
            trigger,
            "diagnose the failure and propose a fix",
            "Says what broke and proposes a fix",
        );
        tripwire.scope = Some(scope.to_string());
        ledger::lay(conn, &tripwire, 1).unwrap()
    }

    /// Register a session in the ledger with the checkout it is working in.
    ///
    /// The engine resolves a fact's checkout through exactly this row
    /// (#fact-to-trip), so a fixture that skipped it would produce facts no
    /// tripwire could ever consider — and every gate below would pass for the
    /// wrong reason.
    fn seat(config: &TripwireEngineConfig, session_id: &str, project_dir: &str) {
        // Through the spawn verb rather than a hand-written row, so a fixture
        // cannot register a session in a shape the product never produces.
        // Idempotent, so a helper that seats the same session twice is fine.
        config
            .ledger
            .record_spawn(
                session_id,
                project_dir,
                project_dir,
                &format!("card-{session_id}"),
                1_700_000_000_000,
                &format!("line-{session_id}"),
                None,
            )
            .expect("the session ledger takes the row");
    }

    /// Record one fact for a session and hand back the row the engine would
    /// have been sent, exactly as `record_fact_tx` composes it.
    fn fact(
        config: &TripwireEngineConfig,
        project_dir: &str,
        session_id: &str,
        kind: &str,
        payload: &str,
    ) -> crate::session_ledger::FactRow {
        static SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        seat(config, session_id, project_dir);
        let new = crate::session_ledger::NewFact {
            at_ms: 1_700_000_000_000 + n,
            kind: kind.to_string(),
            session_id: Some(session_id.to_string()),
            subject: Some(format!("f{n}")),
            text: format!("fact {n}"),
            payload: payload.to_string(),
            dedupe_key: Some(format!("{kind}:{session_id}:{n}")),
        };
        let id = config
            .ledger
            .record_fact(&new)
            .expect("record")
            .expect("a fresh fact lands");
        crate::session_ledger::FactRow {
            id,
            at_ms: new.at_ms,
            kind: new.kind,
            session_id: new.session_id,
            subject: new.subject,
            text: new.text,
            payload: new.payload,
        }
    }

    /// The ordinary shape: a matching fact from a session working in `/proj`.
    fn firing(
        config: &TripwireEngineConfig,
        project_dir: &str,
        kind: &str,
    ) -> crate::session_ledger::FactRow {
        fact(
            config,
            project_dir,
            "sess-a",
            kind,
            r#"{"class":"resolve"}"#,
        )
    }

    fn decision(outcomes: &[(String, Decision)], tripwire: &str) -> Decision {
        outcomes
            .iter()
            .find(|(name, _)| name == tripwire)
            .unwrap_or_else(|| panic!("{tripwire} was not considered: {outcomes:?}"))
            .1
    }

    /// The guard half alone — what every decision test asserts on. The runs it
    /// hands back are left `running`, which is what the row already says.
    fn decisions(
        config: &TripwireEngineConfig,
        conn: &Connection,
        fact: &crate::session_ledger::FactRow,
    ) -> Vec<(String, Decision)> {
        evaluate(config, conn, fact).0
    }

    /// Decide and settle in one go, the way the loop does, against a scripted
    /// model.
    async fn work(
        config: &TripwireEngineConfig,
        conn: &Connection,
        fact: &crate::session_ledger::FactRow,
    ) -> Vec<(String, Decision)> {
        let (decisions, mut pending) = evaluate(config, conn, fact);
        // The run half opens its own handle. `run_pending` takes the ledger
        // behind the mutex that makes the no-transaction-across-await rule a
        // compile error; the bare connection here is the assertion half's, and
        // the two are separate for the same reason the engine's are.
        let db: Db = Mutex::new(ledger::open_ledger(&config.db_path).unwrap());
        for run in &mut pending {
            let settled = run_pending(config, &db, run).await;
            settle(config, conn, run, &settled);
        }
        decisions
    }

    fn statuses(conn: &Connection, tripwire_id: i64) -> Vec<String> {
        ledger::trips_for_tripwire(conn, tripwire_id, 20)
            .unwrap()
            .into_iter()
            .map(|t| t.status)
            .collect()
    }

    fn trips(conn: &Connection, tripwire_id: i64) -> Vec<ledger::Trip> {
        ledger::trips_for_tripwire(conn, tripwire_id, 20).unwrap()
    }

    /// **The whole of the new trigger**: a matching fact fires the tripwire,
    /// and the row it writes names the checkout the fact happened in ([B01],
    /// [P05]).
    #[test]
    fn a_matching_fact_fires_the_tripwire_and_the_row_names_its_checkout() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "w"), Decision::Fired);

        let rows = trips(&h.conn, tripwire.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "running");
        assert_eq!(
            rows[0].repo_root.as_deref(),
            Some("/proj"),
            "the tree is cut from the fact's own checkout"
        );
        assert!(
            rows[0]
                .event_payload
                .as_deref()
                .unwrap()
                .contains("\"fact\""),
            "the fact rides the row: {:?}",
            rows[0].event_payload
        );
    }

    /// A fact the `where` clause does not take writes **no row at all**
    /// ([P04]). A row per unmatched fact would bury the ones that mean
    /// something — a `fact:shell` tripwire sees one per Bash call.
    #[test]
    fn a_fact_that_fails_the_where_clause_writes_no_row() {
        let h = harness();
        let tripwire = lay(
            &h.conn,
            "w",
            r#"{"fact":{"kind":"shell","where":{"ok":"false"}}}"#,
        );
        let green = fact(
            &h.config,
            "/proj",
            "sess-a",
            "shell",
            r#"{"command":"cargo build","ok":true}"#,
        );
        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &green), "w"),
            Decision::NoMatch
        );
        assert!(statuses(&h.conn, tripwire.id).is_empty());

        let red = fact(
            &h.config,
            "/proj",
            "sess-a",
            "shell",
            r#"{"command":"cargo build","ok":false}"#,
        );
        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &red), "w"),
            Decision::Fired
        );
    }

    /// The own-session guard ([B03]): a tripwire never fires on facts recorded
    /// by a session it spawned. Without it, every shell command a trip runs
    /// fires the tripwire that started it.
    #[test]
    fn a_fact_from_the_tripwires_own_session_writes_no_row() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        // A finished trip of this tripwire's, with the session it ran in.
        let past = ledger::insert_trip(
            &h.conn,
            &ledger::NewTrip {
                tripwire_id: tripwire.id,
                event_key: "fact:inst-a:0".to_string(),
                at_ms: 1,
                instance: "inst-a".to_string(),
                status: TripStatus::Done,
                reason: None,
                event_payload: None,
                repo_root: Some("/proj".to_string()),
            },
        )
        .unwrap()
        .expect("written");
        h.conn
            .execute(
                "UPDATE trips SET session_id = 's-trip' WHERE id = ?1",
                rusqlite::params![past],
            )
            .unwrap();

        let own = fact(
            &h.config,
            "/proj",
            "s-trip",
            "edit_failed",
            r#"{"class":"resolve"}"#,
        );
        assert_eq!(
            decision(&decisions(&h.config, &h.conn, &own), "w"),
            Decision::NoMatch
        );
        assert_eq!(
            statuses(&h.conn, tripwire.id),
            vec!["done"],
            "no second row: the tripwire's own session is not an event in its life"
        );
    }

    /// And the guard is **per tripwire** ([Q01]): another tripwire's trip
    /// session is an ordinary session as far as this one is concerned. The
    /// brief decided this form, and widening it is dropping one clause.
    #[test]
    fn a_fact_from_another_tripwires_session_still_fires_this_one() {
        let h = harness();
        let theirs = lay(&h.conn, "theirs", r#"{"fact":{"kind":"edit_failed"}}"#);
        lay(&h.conn, "mine", r#"{"fact":{"kind":"edit_failed"}}"#);
        let past = ledger::insert_trip(
            &h.conn,
            &ledger::NewTrip {
                tripwire_id: theirs.id,
                event_key: "fact:inst-a:0".to_string(),
                at_ms: 1,
                instance: "inst-a".to_string(),
                status: TripStatus::Done,
                reason: None,
                event_payload: None,
                repo_root: Some("/proj".to_string()),
            },
        )
        .unwrap()
        .expect("written");
        h.conn
            .execute(
                "UPDATE trips SET session_id = 's-trip' WHERE id = ?1",
                rusqlite::params![past],
            )
            .unwrap();

        let out = decisions(
            &h.config,
            &h.conn,
            &fact(
                &h.config,
                "/proj",
                "s-trip",
                "edit_failed",
                r#"{"class":"resolve"}"#,
            ),
        );
        assert_eq!(decision(&out, "theirs"), Decision::NoMatch);
        assert_eq!(decision(&out, "mine"), Decision::Fired);
    }

    /// One live trip per tripwire, and a second matching fact meanwhile is a
    /// **skip that says why** rather than a queue ([B03], [P03]).
    #[test]
    fn a_second_matching_fact_while_a_trip_runs_is_skipped_as_busy() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        // `running` is the whole of the live set now ([P05]): the two statuses
        // that used to share this guard were finished trips holding on for a
        // person, and a trip that always leaves a report holds nothing.
        let trip_id = ledger::insert_trip(
            &h.conn,
            &ledger::NewTrip {
                tripwire_id: tripwire.id,
                event_key: "live:running".to_string(),
                at_ms: 1,
                instance: "inst-a".to_string(),
                status: TripStatus::Running,
                reason: None,
                event_payload: None,
                repo_root: Some("/proj".to_string()),
            },
        )
        .unwrap()
        .expect("written");

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(
            decision(&out, "w"),
            Decision::Skipped(ledger::SKIP_BUSY),
            "a running trip holds the tripwire's one slot"
        );
        let newest = trips(&h.conn, tripwire.id).remove(0);
        assert_eq!(newest.status, "skipped");
        assert_eq!(newest.reason.as_deref(), Some(ledger::SKIP_BUSY));

        // And the slot comes back when it finishes.
        ledger::settle(
            &h.conn,
            trip_id,
            TripStatus::Done,
            &ledger::Settlement::default(),
            9,
        )
        .unwrap();
        assert!(ledger::live_trip(&h.conn, tripwire.id).unwrap().is_none());
    }

    /// The machine ceiling skips rather than queues ([P03]): with the trigger
    /// at fact time the next matching fact is along in seconds, so a row
    /// naming the budget that refused is more honest than one waiting for a
    /// drain that no longer exists.
    #[test]
    fn the_machine_ceiling_skips_rather_than_queues() {
        let h = harness();
        let busy = lay(&h.conn, "busy", r#"{"fact":{"kind":"edit_failed"}}"#);
        let waiting = lay(&h.conn, "waiting", r#"{"fact":{"kind":"edit_failed"}}"#);
        ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "1").unwrap();
        ledger::insert_trip(
            &h.conn,
            &ledger::NewTrip {
                tripwire_id: busy.id,
                event_key: "live".to_string(),
                at_ms: 1,
                instance: "inst-a".to_string(),
                status: TripStatus::Running,
                reason: None,
                event_payload: None,
                repo_root: Some("/proj".to_string()),
            },
        )
        .unwrap()
        .expect("written");

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(
            decision(&out, "waiting"),
            Decision::Skipped(ledger::SKIP_CEILING)
        );
        let row = trips(&h.conn, waiting.id).remove(0);
        assert_eq!(row.status, "skipped");
        assert_eq!(row.reason.as_deref(), Some(ledger::SKIP_CEILING));
    }

    /// A host with no room for a session is the other budget on the same
    /// ladder, and it writes the other reason.
    #[test]
    fn a_full_host_skips_with_no_room() {
        /// A runner that admits nothing.
        struct FullHost;

        #[async_trait::async_trait]
        impl TripwireSessionRunner for FullHost {
            fn admits_spawn(&self) -> bool {
                false
            }
            async fn run(
                &self,
                _request: TripwireSessionRequest,
            ) -> Result<TripwireSessionOutcome, RunRefusal> {
                unreachable!("the gate refuses before any spawn")
            }
        }

        let mut h = harness();
        h.config.sessions = Some(Arc::new(FullHost));
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);

        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "w"), Decision::Skipped(ledger::SKIP_NO_ROOM));
        let row = trips(&h.conn, tripwire.id).remove(0);
        assert_eq!(row.reason.as_deref(), Some(ledger::SKIP_NO_ROOM));
    }

    /// A fact with no session — or one this ledger does not know — is nobody's
    /// business: there is no checkout to compare a scope against and none to
    /// cut a tree from, so no tripwire is even considered (#fact-to-trip).
    #[test]
    fn a_fact_with_no_session_is_nobodys_business() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let appwide = crate::session_ledger::FactRow {
            id: 7,
            at_ms: 1_700_000_000_000,
            kind: "edit_failed".to_string(),
            session_id: None,
            subject: None,
            text: "an app-scoped fact".to_string(),
            payload: "{}".to_string(),
        };
        assert!(decisions(&h.config, &h.conn, &appwide).is_empty());

        let unknown = crate::session_ledger::FactRow {
            session_id: Some("sess-nobody-registered".to_string()),
            ..appwide
        };
        assert!(decisions(&h.config, &h.conn, &unknown).is_empty());
        assert!(statuses(&h.conn, tripwire.id).is_empty());
    }

    /// The key is `fact:<instance>:<rowid>`, and both halves are load-bearing:
    /// a rowid is unique only within one instance's session ledger, and two
    /// instances on one machine share `tripwires.db`.
    #[test]
    fn the_event_key_carries_the_instance_and_the_rowid() {
        let h = harness();
        let tripwire = lay(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#);
        let row = firing(&h.config, "/proj", "edit_failed");
        decisions(&h.config, &h.conn, &row);

        let written = trips(&h.conn, tripwire.id).remove(0);
        assert_eq!(written.event_key, format!("fact:inst-a:{}", row.id));

        // And a replay of the same fact writes nothing further.
        decisions(&h.config, &h.conn, &row);
        assert_eq!(trips(&h.conn, tripwire.id).len(), 1);
    }

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
        let out = decisions(
            &h.config,
            &h.conn,
            &firing(&h.config, "/proj", "edit_failed"),
        );
        assert_eq!(decision(&out, "w"), Decision::Fired);
    }

    #[test]
    fn a_scoped_tripwire_ignores_a_foreign_path_and_takes_one_beneath_it() {
        let h = harness();
        lay_scoped(&h.conn, "w", r#"{"fact":{"kind":"edit_failed"}}"#, "/proj");

        let foreign = decisions(
            &h.config,
            &h.conn,
            &fact(
                &h.config,
                "/elsewhere",
                "sess-far",
                "edit_failed",
                r#"{"class":"resolve"}"#,
            ),
        );
        assert_eq!(decision(&foreign, "w"), Decision::NoMatch);

        // A sibling whose name merely starts with the scope is not under it.
        let sibling = decisions(
            &h.config,
            &h.conn,
            &fact(
                &h.config,
                "/project-other",
                "sess-sib",
                "edit_failed",
                r#"{"class":"resolve"}"#,
            ),
        );
        assert_eq!(decision(&sibling, "w"), Decision::NoMatch);

        let beneath = decisions(
            &h.config,
            &h.conn,
            &fact(
                &h.config,
                "/proj/src",
                "sess-in",
                "edit_failed",
                r#"{"class":"resolve"}"#,
            ),
        );
        assert_eq!(decision(&beneath, "w"), Decision::Fired);
    }

    /// An arc worktree is not folded into the checkout it forked from — that
    /// folding is what would make a tripwire re-trip on its own commits.
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
            ledger::insert_trip(
                &h.conn,
                &ledger::NewTrip {
                    tripwire_id: tripwire.id,
                    event_key: key.to_string(),
                    at_ms: 1,
                    instance: instance.to_string(),
                    status: TripStatus::Running,
                    reason: None,
                    event_payload: None,
                    repo_root: Some("/proj".to_string()),
                },
            )
            .unwrap()
            .expect("written");
        }
        assert_eq!(
            ledger::sweep_stale_running(&h.conn, &h.config.instance, 5_000).unwrap(),
            1
        );
        assert_eq!(ledger::running_count(&h.conn).unwrap(), 1);
    }

    /// A trip in the state the engine would have written it in, for the tests
    /// below that need one on disk before they start.
    fn seed_trip(conn: &Connection, tripwire_id: i64, key: &str, status: TripStatus) -> i64 {
        ledger::insert_trip(
            conn,
            &ledger::NewTrip {
                tripwire_id,
                event_key: key.to_string(),
                at_ms: 1,
                instance: "inst-a".to_string(),
                status,
                reason: None,
                event_payload: None,
                repo_root: Some("/proj".to_string()),
            },
        )
        .unwrap()
        .expect("this tripwire has no row for that key yet")
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

    /// The whole loop, driven by a real fact through a real ledger: recording
    /// the fact is what wakes the engine ([B01], [P01]), and the trip lands
    /// without anything else being sent.
    ///
    /// The channel is process-global, so this is also the one test that proves
    /// `record_fact_tx`'s hook reaches a running engine rather than an
    /// installed test seam.
    #[tokio::test]
    async fn the_running_engine_trips_on_the_fact_being_recorded() {
        let h = harness();
        let tripwire = lay(&h.conn, "tugedit", r#"{"fact":{"kind":"edit_failed"}}"#);
        let session_ledger = Arc::clone(&h.config.ledger);
        let cancel = h.config.cancel.clone();
        let db_path = h.config.db_path.clone();

        let engine = tokio::spawn(run_tripwire_engine(TripwireEngineConfig {
            ledger: Arc::clone(&session_ledger),
            db_path,

            instance: "inst-a".to_string(),
            now_ms: h.clock.as_now(),
            sessions: None,
            overview_tx: None,
            cancel: cancel.clone(),
        }));

        // Let the engine reach its select and install the fact channel before
        // anything is recorded.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        // The session has to name a checkout, because that is what the engine
        // resolves a fact's repository through (#fact-to-trip).
        seat(&h.config, "sess-a", "/proj");
        let mut fact = crate::feeds::facts_library::edit_failed_fact(
            2_000,
            None,
            &serde_json::json!({"class": "resolve", "files": ["a.rs"]}),
            None,
        );
        fact.session_id = Some("sess-a".to_string());
        session_ledger.record_fact(&fact).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            if trips.first().is_some_and(|t| t.status == "done") {
                assert_eq!(trips.len(), 1, "one fact is one trip: {trips:?}");
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

        /// A request the phase can be handed when the test cares about what
        /// the phase does rather than about what it asked for. `seated` is the
        /// phase's own to fill, so it starts empty here too.
        fn request(prompt: &str) -> TripwireSessionRequest {
            TripwireSessionRequest {
                tripwire: "ci".to_string(),
                worktree: PathBuf::from("/tmp"),
                permission_mode: "plan".to_string(),
                model: None,
                prompt: prompt.to_string(),
                max_seconds: 120,
                max_tool_calls: 30,
                seated: None,
            }
        }

        /// What one spawn does when it runs.
        #[derive(Debug, Clone)]
        enum Reply {
            /// End the turn with these last words — which the engine reads off
            /// the transcript as the trip's report ([P04]). Optionally leaving
            /// a commit behind first, because the rounds count reads git
            /// rather than the script.
            Says {
                closing: &'static str,
                commits: bool,
            },
            /// End the turn with the fake's own stock words.
            Silent,
            /// The session ran past one of the tripwire's caps and the engine
            /// stopped it ([P06]). For the wall-clock cap the fake first
            /// spends the seconds it was handed, so a request that carried no
            /// cap is a test that hangs rather than one that passes on a
            /// scripted answer.
            Capped(CapKind),
        }

        /// What the host says about room for one more session — the second
        /// budget a trip's session spends, faked so a test can fill it.
        #[derive(Clone, Copy, PartialEq, Eq)]
        enum HostRoom {
            /// Room for a session. Every test that is not about the ladder.
            Admits,
            /// No room, and the engine can see it before it commits to a run.
            Full,
            /// No room, but the engine could not see it: the answer was yes
            /// and a card took the last slot before the spawn. The race
            /// `admits_spawn` leaves open, on purpose.
            FullAfterAdmitting,
        }

        /// A session runner that answers from a script of [`Reply`]s, one per
        /// spawn. A trip spawns once, so the second entry is only ever read
        /// by a test that fires twice.
        struct FakeSessions {
            script: Mutex<std::collections::VecDeque<Reply>>,
            seen: Mutex<Vec<SeenRun>>,
            /// How long each spawn works before it answers. Zero unless a
            /// test is about the wait itself.
            delay: Duration,
            host: Mutex<HostRoom>,
        }

        impl FakeSessions {
            fn new(script: Vec<Reply>) -> Arc<FakeSessions> {
                FakeSessions::delayed(script, Duration::ZERO)
            }

            fn delayed(script: Vec<Reply>, delay: Duration) -> Arc<FakeSessions> {
                Arc::new(FakeSessions {
                    script: Mutex::new(script.into_iter().collect()),
                    seen: Mutex::new(Vec::new()),
                    delay,
                    host: Mutex::new(HostRoom::Admits),
                })
            }

            fn seen(&self) -> Vec<SeenRun> {
                self.seen.lock().unwrap().clone()
            }

            /// Fill the host's budget, or free it again.
            fn host(&self, room: HostRoom) {
                *self.host.lock().unwrap() = room;
            }
        }

        /// A transcript-shaped transcript, the way the real runner hands one back:
        /// the prose arrives inside an assistant line's text field, never as
        /// bare lines. A plain-text fake is what hid the old runner's
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
            fn admits_spawn(&self) -> bool {
                *self.host.lock().unwrap() != HostRoom::Full
            }

            async fn run(
                &self,
                mut request: TripwireSessionRequest,
            ) -> Result<TripwireSessionOutcome, RunRefusal> {
                if *self.host.lock().unwrap() != HostRoom::Admits {
                    return Err(RunRefusal::HostFull(
                        "the tripwire's session could not be spawned: CapExceeded".to_string(),
                    ));
                }
                let session_id = format!("sess-tripwire-{}", self.seen.lock().unwrap().len() + 1);
                // The seat, where the real runner puts it: the spawn has
                // succeeded and there is an id, long before the turn is over.
                // A fake that skipped it would leave every trip row here
                // nameless, which is the bug this reports rather than hides.
                if let Some(tx) = request.seated.take() {
                    let _ = tx.send(session_id.clone());
                }
                // And then the engine gets a turn, which in the real runner
                // is the rotation and the whole wait for the session's end.
                // Without it a fake that seats and resolves in one poll never
                // lets the seat reach the row, which is a property of the fake
                // rather than of the engine.
                tokio::task::yield_now().await;
                self.seen.lock().unwrap().push(SeenRun {
                    tripwire: request.tripwire,
                    worktree: request.worktree.clone(),
                    permission_mode: request.permission_mode,
                    model: request.model,
                    prompt: request.prompt,
                });
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                let reply = self.script.lock().unwrap().pop_front();
                let Some(reply) = reply else {
                    return Ok(TripwireSessionOutcome {
                        session_id,
                        transcript: transcript("nothing was scripted for this spawn"),
                        end: SessionEnd::Finished,
                    });
                };
                let closing = match reply {
                    Reply::Silent => "I had a look around.",
                    Reply::Capped(kind) => {
                        if kind == CapKind::Seconds {
                            tokio::time::sleep(Duration::from_secs(request.max_seconds)).await;
                        }
                        return Ok(TripwireSessionOutcome {
                            session_id,
                            transcript: transcript("I was still going when it was stopped."),
                            end: SessionEnd::Capped(kind),
                        });
                    }
                    Reply::Says { closing, commits } => {
                        if commits {
                            commit_a_round(&request.worktree);
                        }
                        closing
                    }
                };
                Ok(TripwireSessionOutcome {
                    session_id,
                    transcript: transcript(closing),
                    end: SessionEnd::Finished,
                })
            }
        }

        /// One round on an arc worktree, the way a session leaves one.
        fn commit_a_round(worktree: &std::path::Path) {
            std::fs::write(worktree.join("fixed.txt"), "fixed").unwrap();
            for args in [
                vec!["add", "-A"],
                vec!["commit", "-m", "the tripwire's round"],
            ] {
                let out = std::process::Command::new("git")
                    .args(&args)
                    .current_dir(worktree)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{args:?}");
            }
        }

        /// What the base checkout is, byte for byte as far as git can tell:
        /// its `HEAD` and every path that differs from it. Two equal
        /// fingerprints mean nothing a trip did reached the user's checkout.
        fn base_fingerprint(root: &std::path::Path) -> String {
            let mut out = String::new();
            for args in [vec!["rev-parse", "HEAD"], vec!["status", "--porcelain"]] {
                let run = std::process::Command::new("git")
                    .args(&args)
                    .current_dir(root)
                    .output()
                    .unwrap();
                assert!(run.status.success(), "{args:?}");
                out.push_str(&String::from_utf8_lossy(&run.stdout));
            }
            out
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
                "Puts the suite back to green after an edit goes wrong",
            );
            new.probe = Some(probe.to_string());
            new.scope = Some(root.to_string_lossy().into_owned());
            new.permission_mode = "acceptEdits".to_string();
            new.model = Some("claude-opus-5".to_string());
            new.repo_root = root.to_string_lossy().into_owned();
            let laid = ledger::lay(conn, &new, 1).unwrap();
            // The arc `lay` makes, made here too: every trip stands in it
            // ([P02]), so a harness without one tests nothing that runs.
            tugarc_core::ops::create_in(
                root,
                &tripwire_arc(&laid.name),
                Some(format!("tripwire {}", laid.name)),
                false,
                None,
            )
            .unwrap();
            laid
        }

        /// A matching fact from a session working in the scratch repo.
        ///
        /// The repository has to be a real one, because the run resolves its
        /// `HEAD` and cuts a detached worktree there ([P06]) — a path that is
        /// not a checkout would fail the tree rather than the thing under
        /// test.
        fn scoped_fact(
            config: &TripwireEngineConfig,
            root: &std::path::Path,
        ) -> crate::session_ledger::FactRow {
            firing(config, root.to_string_lossy().as_ref(), "edit_failed")
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

        /// **A trip stands on the base as it is now, not as it was.**
        ///
        /// The tripwire's worktree is permanent, so without a replay the second
        /// trip would diagnose the repository as it stood when the arc was cut —
        /// a tree no commit describes any more ([P03]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trip_replays_its_arc_onto_the_moved_base_before_it_runs() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Silent]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            // The base moves after the arc was cut.
            std::fs::write(root.join("landed.txt"), "after the arc\n").unwrap();
            for args in [
                vec!["add", "-A"],
                vec!["commit", "-m", "a commit the arc has not seen"],
            ] {
                let out = std::process::Command::new("git")
                    .args(&args)
                    .current_dir(&root)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{args:?}");
            }

            let worktree = tugarc_core::ops::worktree_path(&root, &tripwire_arc("ci"));
            assert!(
                !worktree.join("landed.txt").exists(),
                "the fixture is only meaningful if the arc starts out behind"
            );

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            assert_eq!(sessions.seen().len(), 1, "the trip ran");
            assert!(
                worktree.join("landed.txt").exists(),
                "the trip stood on a base that had moved out from under it"
            );
        }

        /// **A replay that cannot be made clean fails the trip and says which
        /// round conflicts.**
        ///
        /// Proceeding would mean a session diagnosing the wrong tree, so nothing
        /// is spawned at all ([P03]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_conflicted_replay_fails_the_trip_and_names_the_round() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Silent]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            // One round on the arc and one commit on the base, both rewriting
            // the same line — which is what `merge-tree` cannot resolve.
            let worktree = tugarc_core::ops::worktree_path(&root, &tripwire_arc("ci"));
            let commit = |dir: &std::path::Path, body: &str, subject: &str| {
                std::fs::write(dir.join("README.md"), body).unwrap();
                for args in [vec!["add", "-A"], vec!["commit", "-m", subject]] {
                    let out = std::process::Command::new("git")
                        .args(&args)
                        .current_dir(dir)
                        .output()
                        .unwrap();
                    assert!(out.status.success(), "{args:?}");
                }
            };
            commit(&worktree, "the arc's line\n", "the tripwire's round");
            commit(&root, "the base's line\n", "the user's commit");

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed");
            let headline = trips[0].headline.clone().expect("a failure says why");
            assert!(
                headline.contains("the tripwire's round"),
                "the failure names the round that conflicts: {headline}"
            );
            assert!(
                sessions.seen().is_empty(),
                "nothing was spawned against a tree that could not be made right"
            );
        }

        /// **Residue a previous trip declined to commit is discarded before the
        /// replay.**
        ///
        /// `replay_onto` refuses a dirty worktree, so the reset is a
        /// precondition rather than a policy of its own — and nothing a reader
        /// wanted is in those bytes, because every trip leaves a report ([P03]).
        #[serial_test::serial]
        #[tokio::test]
        async fn residue_in_the_worktree_is_discarded_before_the_replay() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Silent]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let worktree = tugarc_core::ops::worktree_path(&root, &tripwire_arc("ci"));
            std::fs::write(worktree.join("README.md"), "a previous trip's half-edit\n").unwrap();
            std::fs::write(worktree.join("scratch.txt"), "and something untracked\n").unwrap();

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            assert_eq!(sessions.seen().len(), 1, "the trip ran rather than failing");
            assert_eq!(
                std::fs::read_to_string(worktree.join("README.md")).unwrap(),
                "scratch\n",
                "the tracked edit was reset"
            );
            assert!(
                !worktree.join("scratch.txt").exists(),
                "and the untracked file was cleaned"
            );
        }
        /// The green-probe floor, which is the whole economic argument for the
        /// design: the probe answered, so no model was summoned. The arc is
        /// the tripwire's rather than the trip's, so it stays ([P02]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_green_probe_settles_the_trip_and_leaves_the_arc_alone() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "true");
            let sessions = FakeSessions::new(vec![]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let event = scoped_fact(&config, &root);
            work(&config, &h.conn, &event).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "done");
            assert_eq!(trips[0].probe_exit, Some(0));
            assert!(
                sessions.seen().is_empty(),
                "a green probe spends no tokens at all"
            );
            assert!(
                arcs_in(&root) == vec!["tugarc/tripwire-ci".to_string()],
                "the tripwire's own arc survives a trip that found nothing: {:?}",
                arcs_in(&root)
            );
            assert!(
                posts(&config.ledger).is_empty(),
                "a quiet settle is a trip-log row and never a post ([P08])"
            );
        }

        /// A probe that cannot be launched is a **failing** probe, never a
        /// green one. Reading "could not run" as "nothing wrong" is the one
        /// mistake that silences a tripwire forever ([P10]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_probe_that_cannot_be_launched_is_red_rather_than_green() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exec /nonexistent/probe");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "nothing here",
                commits: false,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_ne!(trips[0].probe_exit, Some(0), "{:?}", trips[0].probe_exit);
            assert_eq!(
                sessions.seen().len(),
                1,
                "the firing proceeded rather than settling quiet"
            );
        }

        /// A host with no room for a session is **busy**, not broken, and the
        /// trip that meets one is skipped with a reason that says so ([P04]).
        ///
        /// The two budgets are one ladder: the ledger's ceiling rations
        /// worktrees machine-wide and the host's rations memory in this
        /// process. There is no queue for a firing that clears neither — with
        /// the trigger at fact time the next matching fact is along in seconds
        /// ([P03]). What this pins is that the refusal costs nothing on the
        /// way — no probe is run, no tree is cut, no model is asked — and that
        /// the row names the budget rather than accusing the tripwire.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_full_host_skips_the_trip_rather_than_failing_it() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "false");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "nothing here",
                commits: false,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            sessions.host(HostRoom::Full);
            let event = scoped_fact(&config, &root);
            work(&config, &h.conn, &event).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "skipped");
            assert_eq!(
                trips[0].reason.as_deref(),
                Some(ledger::SKIP_NO_ROOM),
                "the row names the budget that refused, not a fault of the tripwire"
            );
            assert_eq!(
                trips[0].probe_exit, None,
                "the skip is decided before any work is spent on the firing"
            );
            assert!(sessions.seen().is_empty(), "and no session was asked for");
            assert_eq!(
                arcs_in(&root),
                vec!["tugarc/tripwire-ci".to_string()],
                "and nothing was staged on the tripwire's arc"
            );
        }

        /// The race the snapshot leaves open: the host said yes and a card took
        /// the last slot before the spawn.
        ///
        /// It writes the **same row** the consider-time gate would have
        /// written for the same condition ([P04]): `skipped`, reason
        /// `no-room`. Two spellings of one event reading alike on the card is
        /// the whole point of settling it at all.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_host_that_fills_between_the_gate_and_the_spawn_skips_rather_than_failing() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "false");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "nothing here",
                commits: false,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            sessions.host(HostRoom::FullAfterAdmitting);
            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "skipped", "{:?}", trips[0].headline);
            assert_eq!(
                trips[0].reason.as_deref(),
                Some(ledger::SKIP_NO_ROOM),
                "the same reason the gate writes for the same condition"
            );
            assert!(
                trips[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains("the host had no room")),
                "{:?}",
                trips[0].headline
            );
            assert_eq!(
                arcs_in(&root),
                vec!["tugarc/tripwire-ci".to_string()],
                "and the tripwire's own arc is the only one there is"
            );
        }

        /// Two tripwires matching one fact each work their own arc ([P02]):
        /// two worktrees, neither of them the base checkout.
        #[serial_test::serial]
        #[tokio::test]
        async fn two_tripwires_on_one_fact_each_work_their_own_arc() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            for name in ["ci", "ci-two"] {
                let mut new = NewTripwire::new(
                    name,
                    r#"{"fact":{"kind":"edit_failed"}}"#,
                    "diagnose the failure and propose a fix",
                    "Says what broke and proposes a fix",
                );
                // A probe that records the worktree it ran in, so the test
                // reads where each tripwire stood rather than inferring it.
                new.probe = Some(format!(
                    "pwd >> {}/seen.txt; true",
                    root.parent().unwrap().display()
                ));
                new.scope = Some(root.to_string_lossy().to_string());
                new.repo_root = root.to_string_lossy().into_owned();
                let laid = ledger::lay(&h.conn, &new, 1).unwrap();
                tugarc_core::ops::create_in(&root, &tripwire_arc(&laid.name), None, false, None)
                    .unwrap();
            }
            let mut config = h.config;
            ledger::set_setting(&h.conn, ledger::SETTING_MAX_CONCURRENT_TRIPS, "4").unwrap();
            config.sessions = Some(FakeSessions::new(vec![]) as Arc<dyn TripwireSessionRunner>);

            let event = scoped_fact(&config, &root);
            let out = work(&config, &h.conn, &event).await;
            assert_eq!(decision(&out, "ci"), Decision::Fired);
            assert_eq!(decision(&out, "ci-two"), Decision::Fired);

            let seen = std::fs::read_to_string(root.parent().unwrap().join("seen.txt"))
                .expect("both probes ran and wrote where they stood");
            let dirs: Vec<&str> = seen.lines().filter(|l| !l.is_empty()).collect();
            assert_eq!(dirs.len(), 2, "{seen}");
            assert_ne!(dirs[0], dirs[1], "two arcs, not one: {seen}");
            for dir in &dirs {
                assert!(
                    !std::path::Path::new(dir).starts_with(&root)
                        || std::path::Path::new(dir) != root,
                    "a probe stood in the user's own checkout: {seen}"
                );
            }
            assert_eq!(
                arcs_in(&root),
                vec![
                    "tugarc/tripwire-ci".to_string(),
                    "tugarc/tripwire-ci-two".to_string()
                ],
                "and both arcs are still there — they are the tripwires', not the trips'"
            );
        }

        /// The spawn's own arguments, which is where the trip's session is
        /// actually constrained ([P01]): one spawn, the tripwire's own
        /// permission mode and model, its own arc worktree, and a prompt
        /// carrying the brief, the probe's failure and the closing rule.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trips_one_session_is_told_where_it_stands_and_what_to_do() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "I read the diff and the test is order-dependent.",
                commits: false,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let event = scoped_fact(&config, &root);
            work(&config, &h.conn, &event).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "done");
            assert_eq!(trips[0].session_id.as_deref(), Some("sess-tripwire-1"));
            assert!(
                trips[0].arc.is_none(),
                "a trip that committed nothing names no arc"
            );
            assert_eq!(sessions.seen().len(), 1, "one spawn, not two");
            assert_eq!(
                arcs_in(&root),
                vec!["tugarc/tripwire-ci".to_string()],
                "the tripwire's arc, and no second one cut for the trip"
            );

            let run = &sessions.seen()[0];
            assert_eq!(run.tripwire, "ci");
            assert_eq!(
                run.permission_mode, "acceptEdits",
                "the trip's one session runs under the tripwire's own mode"
            );
            assert_eq!(run.model.as_deref(), Some("claude-opus-5"));
            assert!(
                run.worktree.ends_with("tripwire-ci"),
                "and stands in the tripwire's own arc worktree: {run:?}"
            );
            assert!(
                run.prompt.contains("put the suite back to green")
                    && run.prompt.contains("exit 3")
                    && run.prompt.contains("End your turn with a short report"),
                "the prompt carries the brief, the probe's failure, and the closing rule: {}",
                run.prompt
            );
        }

        /// A trip is one session with hands from its first turn: it costs one
        /// spawn, cuts no arc, and ends `done` carrying the session's own last
        /// words as its report ([P01], [P04]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trips_report_is_its_sessions_last_words() {
            let (_temp, root) = scratch_repo();
            let (h, mut rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "The expected string was never updated when the format changed.",
                commits: false,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            let event = scoped_fact(&config, &root);
            work(&config, &h.conn, &event).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            let trip = &trips[0];
            assert_eq!(trip.status, "done");
            assert_eq!(
                trip.report.as_deref(),
                Some("The expected string was never updated when the format changed."),
                "the report is read off the transcript, with no verb having run"
            );
            assert_eq!(trip.rounds, Some(0), "and it committed nothing");
            assert_eq!(
                trip.session_id.as_deref(),
                Some("sess-tripwire-1"),
                "the row names the one session there is"
            );

            let seen = sessions.seen();
            assert_eq!(seen.len(), 1, "one session, whatever it found");
            assert_eq!(
                seen[0].permission_mode, "acceptEdits",
                "and it takes the tripwire's own mode from its first turn"
            );
            assert_eq!(
                arcs_in(&root),
                vec!["tugarc/tripwire-ci".to_string()],
                "no second arc is cut for the trip"
            );

            // The report is the raised hand, so it is the post's body ([P04]).
            let post = posts(&config.ledger)
                .into_iter()
                .next_back()
                .expect("a trip that reported posts");
            assert_eq!(post.author, OverviewAuthor::Tripwire);
            assert_eq!(post.wake_reason.as_deref(), Some("tripwire:ci"));
            assert_eq!(
                post.body,
                "The expected string was never updated when the format changed."
            );
            assert!(rx.try_recv().is_ok(), "and it went out live too");
        }

        /// **A trip that committed says how many rounds, and names the arc.**
        ///
        /// The count is a difference rather than a total: the arc is permanent
        /// and carries every earlier trip's rounds ([P02]), so the only honest
        /// answer to "what did *this* trip commit" is what it added. The arc
        /// column and the post's `arc` ref are written on the same condition,
        /// which is Spec S02's "always `tripwire-<name>` for a trip that
        /// committed".
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trip_that_committed_a_round_says_how_many() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let sessions = FakeSessions::new(vec![Reply::Says {
                closing: "I put the expected string back and committed it.",
                commits: true,
            }]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "done");
            assert_eq!(trips[0].rounds, Some(1), "one round, not the arc's total");
            assert_eq!(
                trips[0].arc.as_deref(),
                Some("tripwire-ci"),
                "a trip that committed names the arc it committed on"
            );

            let post = posts(&config.ledger)
                .into_iter()
                .next_back()
                .expect("a trip that reported posts");
            assert!(
                post.refs
                    .iter()
                    .any(|r| r.kind == OverviewRefKind::Arc && r.target == "tripwire-ci"),
                "and the post points at it: {:?}",
                post.refs
            );
        }

        /// **A session that dies is `failed` and still reports what it said.**
        ///
        /// The report is read off the transcript rather than written by the
        /// session, so a session that stopped partway has still left its words
        /// behind ([P04]) — which is the whole reason the report is not a verb.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_session_that_dies_is_failed_and_still_reports_what_it_said() {
            /// Says one thing, then dies.
            struct DiesMidTurn;

            #[async_trait::async_trait]
            impl TripwireSessionRunner for DiesMidTurn {
                async fn run(
                    &self,
                    mut request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    if let Some(tx) = request.seated.take() {
                        let _ = tx.send("sess-doomed".to_string());
                    }
                    Ok(TripwireSessionOutcome {
                        session_id: "sess-doomed".to_string(),
                        transcript: transcript("I got as far as the migration."),
                        end: SessionEnd::Died,
                    })
                }
            }

            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let mut config = h.config;
            config.sessions = Some(Arc::new(DiesMidTurn) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed");
            assert_eq!(
                trips[0].report.as_deref(),
                Some("I got as far as the migration."),
                "the words survive the session that stopped saying them"
            );
            assert!(
                trips[0]
                    .headline
                    .as_deref()
                    .is_some_and(|h| h.contains("died")),
                "and the headline says which fault it was: {:?}",
                trips[0].headline
            );
            assert!(
                posts(&config.ledger).is_empty(),
                "a failure is a trip-log row and never a post"
            );
        }

        /// A session that ran to the end is `done`, whatever it said. There is
        /// no verb left to forget and so no fault to find in a session that
        /// simply finished: what it reported is the report, even when the
        /// report is the fake's stock sentence ([P04], [P05]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_session_that_finishes_is_done_whatever_it_said() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 1");
            let sessions = FakeSessions::new(vec![Reply::Silent]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "done");
            assert_eq!(
                trips[0].report.as_deref(),
                Some("I had a look around."),
                "the last words are the report, whatever they amount to"
            );
            assert_eq!(
                trips[0].headline, None,
                "a done row's words are its report, not a sentence written for it"
            );
            assert_eq!(arcs_in(&root), vec!["tugarc/tripwire-ci".to_string()]);
        }

        /// Set one of a tripwire's caps after it was laid, the way `tripwire
        /// edit` does — which is how a test injects a ceiling small enough to
        /// run up against.
        fn cap(conn: &Connection, edit: ledger::TripwireEdit) {
            ledger::update(conn, "ci", &edit).unwrap();
        }

        /// A session that will not stop is stopped, and the row says which of
        /// the two ceilings it crossed — which is the whole of what [Q01] is
        /// settled by reading ([P06]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trip_over_its_second_cap_is_failed_and_says_which_cap() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 1");
            cap(
                &h.conn,
                ledger::TripwireEdit {
                    max_seconds: Some(1),
                    ..Default::default()
                },
            );
            let sessions = FakeSessions::new(vec![Reply::Capped(CapKind::Seconds)]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed", "{:?}", trips[0].headline);
            assert_eq!(
                trips[0].reason.as_deref(),
                Some(ledger::FAIL_CAP_SECONDS),
                "one word a surface can render, and the one a query groups by"
            );
            let headline = trips[0].headline.clone().expect("a failed trip says why");
            assert!(
                headline.contains("seconds it is allowed"),
                "and a sentence a reader of the log understands: {headline}"
            );
            assert!(
                posts(&config.ledger).is_empty(),
                "a trip the engine stopped is a trip-log row and never a post"
            );
        }

        /// The tool-call ceiling is the other question about the same session
        /// — it spent too much rather than took too long — and it earns its
        /// own word on the row ([P06], [P07]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_trip_over_its_tool_call_cap_is_failed_and_says_which_cap() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 1");
            cap(
                &h.conn,
                ledger::TripwireEdit {
                    max_tool_calls: Some(2),
                    ..Default::default()
                },
            );
            let sessions = FakeSessions::new(vec![Reply::Capped(CapKind::ToolCalls)]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(trips[0].status, "failed", "{:?}", trips[0].headline);
            assert_eq!(
                trips[0].reason.as_deref(),
                Some(ledger::FAIL_CAP_TOOL_CALLS),
                "the two caps are told apart on the row, not only in the prose"
            );
            let headline = trips[0].headline.clone().expect("a failed trip says why");
            assert!(
                headline.contains("tool call"),
                "and the sentence says which ceiling: {headline}"
            );
        }

        /// A capped session still said things, and the words are not the
        /// casualty of the cap: the report is written whatever the settle does
        /// with the row ([P04]).
        #[serial_test::serial]
        #[tokio::test]
        async fn a_capped_trip_keeps_its_transcript() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 1");
            cap(
                &h.conn,
                ledger::TripwireEdit {
                    max_tool_calls: Some(2),
                    ..Default::default()
                },
            );
            let sessions = FakeSessions::new(vec![Reply::Capped(CapKind::ToolCalls)]);
            let mut config = h.config;
            config.sessions = Some(Arc::clone(&sessions) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            let trips = ledger::trips_for_tripwire(&h.conn, tripwire.id, 10).unwrap();
            assert_eq!(
                trips[0].report.as_deref(),
                Some("I was still going when it was stopped."),
                "the words the session got out before it was stopped are still the report"
            );
        }

        /// The caps reach the runner off the row rather than out of a constant
        /// here, which is what makes them settable at all ([P06]).
        #[serial_test::serial]
        #[tokio::test]
        async fn the_tripwires_own_caps_are_what_the_run_is_handed() {
            let (_temp, root) = scratch_repo();
            let (h, _rx) = posting_harness();
            probing_tripwire(&h.conn, &root, "exit 1");
            cap(
                &h.conn,
                ledger::TripwireEdit {
                    max_seconds: Some(7),
                    max_tool_calls: Some(9),
                    ..Default::default()
                },
            );
            let handed: Arc<Mutex<Option<(u64, u32)>>> = Arc::new(Mutex::new(None));

            /// Records the ceilings it was handed and finishes at once.
            struct RecordsCaps(Arc<Mutex<Option<(u64, u32)>>>);

            #[async_trait::async_trait]
            impl TripwireSessionRunner for RecordsCaps {
                async fn run(
                    &self,
                    mut request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    *self.0.lock().unwrap() = Some((request.max_seconds, request.max_tool_calls));
                    if let Some(tx) = request.seated.take() {
                        let _ = tx.send("sess-capped".to_string());
                    }
                    Ok(TripwireSessionOutcome {
                        session_id: "sess-capped".to_string(),
                        transcript: transcript("nothing to report"),
                        end: SessionEnd::Finished,
                    })
                }
            }

            let mut config = h.config;
            config.sessions =
                Some(Arc::new(RecordsCaps(Arc::clone(&handed))) as Arc<dyn TripwireSessionRunner>);

            work(&config, &h.conn, &scoped_fact(&config, &root)).await;

            assert_eq!(
                *handed.lock().unwrap(),
                Some((7, 9)),
                "the row's numbers, not the defaults and not a constant"
            );
        }

        /// The seat is on the row while the session is still working, which is
        /// the whole of [F05]: a running trip a reader can open, rather than
        /// one they can only watch.
        #[tokio::test(start_paused = true)]
        async fn a_seated_session_is_on_the_row_before_the_run_ends() {
            /// Seats, then holds until the test lets go.
            struct Seats {
                held: Arc<tokio::sync::Notify>,
            }

            #[async_trait::async_trait]
            impl TripwireSessionRunner for Seats {
                async fn run(
                    &self,
                    mut request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    let _ = request
                        .seated
                        .take()
                        .unwrap()
                        .send("sess-seated".to_string());
                    self.held.notified().await;
                    Ok(TripwireSessionOutcome {
                        session_id: "sess-seated".to_string(),
                        transcript: String::new(),
                        end: SessionEnd::Finished,
                    })
                }
            }

            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);

            let held = Arc::new(tokio::sync::Notify::new());
            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let runner = Seats { held: held.clone() };
            let phase = run_phase(&h.config, &db, &runner, request("diagnose"), trip_id);
            tokio::pin!(phase);

            // Long enough for a wait that watched anything else to have ended,
            // and the session is still in its first turn: the id is on the row
            // all the same.
            assert!(
                tokio::time::timeout(Duration::from_secs(8), &mut phase)
                    .await
                    .is_err(),
                "the phase ended while the session was still working",
            );
            let seated = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(seated.session_id.as_deref(), Some("sess-seated"));
            assert_eq!(seated.status, "running", "the seat settles nothing");

            held.notify_one();
            let phase = phase.await;
            assert_eq!(phase.session_id.as_deref(), Some("sess-seated"));
        }

        /// The seat's id is the one that reaches the row, even when the
        /// runner's own outcome names another — the path that used to lose a
        /// session id for good ([F06]). The runner hands back a *different*
        /// id, so the assertion can only pass on the seat's.
        #[tokio::test(start_paused = true)]
        async fn a_run_whose_outcome_names_another_session_keeps_the_seats_id() {
            /// Seats, works for a while, and only then returns — naming
            /// another session, the way an outcome composed after a handover
            /// would.
            struct SeatsThenWanders;

            #[async_trait::async_trait]
            impl TripwireSessionRunner for SeatsThenWanders {
                async fn run(
                    &self,
                    mut request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    let _ = request
                        .seated
                        .take()
                        .unwrap()
                        .send("sess-seated".to_string());
                    // The engine's loop has to see the seat before the run
                    // ends, which is the ordering this is about.
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    Ok(TripwireSessionOutcome {
                        session_id: "sess-someone-else".to_string(),
                        transcript: String::new(),
                        end: SessionEnd::Finished,
                    })
                }
            }

            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);

            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let phase = run_phase(
                &h.config,
                &db,
                &SeatsThenWanders,
                request("diagnose"),
                trip_id,
            )
            .await;

            assert_eq!(phase.settled.status, TripStatus::Done);
            assert_eq!(
                phase.session_id.as_deref(),
                Some("sess-seated"),
                "the phase named the session it was seated in",
            );
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(
                trip.session_id.as_deref(),
                Some("sess-seated"),
                "and the row kept the seat rather than the outcome's id",
            );
        }

        /// A runner that never seats is not a runner that panics the engine.
        ///
        /// The regression test for the seat arm's `seat_read` guard: the
        /// sender is dropped rather than sent, so the receiver completes with
        /// `RecvError` and every later poll of it would panic. A guard reading
        /// the id instead of the flag leaves the arm enabled, and the next
        /// settle tick takes the engine's run task down with it.
        #[tokio::test(start_paused = true)]
        async fn a_runner_that_never_seats_still_settles_its_trip() {
            /// Drops the request — and so the sender — then takes its time.
            struct NeverSeats;

            #[async_trait::async_trait]
            impl TripwireSessionRunner for NeverSeats {
                async fn run(
                    &self,
                    request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    drop(request);
                    // A long stretch with a completed receiver in the select:
                    // this is the window the panic lived in.
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    Ok(TripwireSessionOutcome {
                        session_id: "sess-unseated".to_string(),
                        transcript: String::new(),
                        end: SessionEnd::Finished,
                    })
                }
            }

            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);

            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let phase = run_phase(&h.config, &db, &NeverSeats, request("diagnose"), trip_id).await;

            assert_eq!(
                phase.session_id.as_deref(),
                Some("sess-unseated"),
                "with no seat, the outcome's id is the fallback",
            );
            assert_eq!(phase.settled.status, TripStatus::Done);
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(
                trip.status, "running",
                "the phase leaves the settle to its caller"
            );
        }

        /// No clock settles a trip whose session is alive, with time under the
        /// test's control ([P07]).
        ///
        /// The runs the old ceiling killed were real work, nearly done. A
        /// session the supervisor reports alive is left to finish, and the
        /// user who can see the trip on the card is the one who decides how
        /// long that may take. The paused clock lets three hours pass in a
        /// moment; the row is still `running` at the end of them.
        #[tokio::test(start_paused = true)]
        async fn a_session_alive_past_any_duration_is_never_failed() {
            /// A session runner whose turn never ends.
            struct Wedged;

            #[async_trait::async_trait]
            impl TripwireSessionRunner for Wedged {
                async fn run(
                    &self,
                    _request: TripwireSessionRequest,
                ) -> Result<TripwireSessionOutcome, RunRefusal> {
                    std::future::pending().await
                }
            }

            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);

            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let waited = tokio::time::timeout(
                Duration::from_secs(3 * 60 * 60),
                run_phase(
                    &h.config,
                    &db,
                    &Wedged,
                    TripwireSessionRequest {
                        tripwire: "ci".to_string(),
                        worktree: PathBuf::from("/tmp"),
                        permission_mode: "plan".to_string(),
                        model: None,
                        prompt: "diagnose".to_string(),
                        max_seconds: 120,
                        max_tool_calls: 30,
                        seated: None,
                    },
                    trip_id,
                ),
            )
            .await;

            assert!(
                waited.is_err(),
                "the phase settled a session that was still alive"
            );
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(trip.status, "running", "and the row, not only the return");
        }

        /// A session that works long after the old ceilings would have fired
        /// is still `done` at the end of it, with its own last words for a
        /// report.
        #[tokio::test(start_paused = true)]
        async fn a_session_that_works_for_hours_is_done_when_it_ends() {
            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);
            let sessions = FakeSessions::delayed(
                vec![Reply::Says {
                    closing: "done at last",
                    commits: false,
                }],
                Duration::from_secs(2 * 60 * 60),
            );

            let db: Db = Mutex::new(ledger::open_ledger(&h.config.db_path).unwrap());
            let started = tokio::time::Instant::now();
            let phase = run_phase(
                &h.config,
                &db,
                sessions.as_ref(),
                TripwireSessionRequest {
                    tripwire: "ci".to_string(),
                    worktree: PathBuf::from("/tmp"),
                    permission_mode: "plan".to_string(),
                    model: None,
                    prompt: "diagnose".to_string(),
                    max_seconds: 120,
                    max_tool_calls: 30,
                    seated: None,
                },
                trip_id,
            )
            .await;

            assert!(started.elapsed() >= Duration::from_secs(2 * 60 * 60));
            assert_eq!(phase.settled.status, TripStatus::Done);
            assert_eq!(phase.closing, "done at last");
        }

        /// The settle race, and the whole of why the engine's settle goes
        /// through a compare-and-set (Risk R03).
        ///
        /// The verbs are gone, but the second writer is not: another
        /// instance's orphan sweep reaches for the same `running` rows, and a
        /// trip it already failed must not be dragged back out of that
        /// outcome. Driven here by settling the row first and asking a second
        /// settle to overwrite it, which is the losing side of the race
        /// arriving second.
        #[test]
        fn the_settle_race_admits_exactly_one_writer() {
            let h = harness();
            let tripwire = lay(&h.conn, "ci", r#"{"fact":{"kind":"edit_failed"}}"#);
            let trip_id = seed_trip(&h.conn, tripwire.id, "fact:inst-a:1", TripStatus::Running);

            // One writer gets there first.
            assert!(
                ledger::settle_if_running(
                    &h.conn,
                    trip_id,
                    TripStatus::Done,
                    &ledger::Settlement {
                        headline: Some("the user should see this".to_string()),
                        ..ledger::Settlement::default()
                    },
                    2,
                )
                .unwrap()
            );

            // The other arrives after it, and is refused.
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
                "a settle that already landed is not overwritten"
            );
            let trip = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(trip.status, "done");
            assert_eq!(trip.headline.as_deref(), Some("the user should see this"));
        }

        /// **A restart fails the rows and leaves the tripwire's arc standing.**
        ///
        /// The old sweep discarded any arc a failed trip named that held no
        /// rounds, which was right when an arc belonged to one trip. Under
        /// [P02] it belongs to the tripwire, so that pass would destroy the
        /// tripwire's own worktree on any restart that caught a trip with
        /// nothing committed yet — and the next trip would have nowhere to
        /// stand. The empty arc is the case that would have gone.
        #[serial_test::serial]
        #[tokio::test]
        async fn a_restart_leaves_the_tripwires_arc_alone() {
            let (_temp, root) = scratch_repo();
            let h = harness();
            let tripwire = probing_tripwire(&h.conn, &root, "exit 3");
            let arc = tripwire_arc(&tripwire.name);
            let trip_id = ledger::insert_trip(
                &h.conn,
                &ledger::NewTrip {
                    tripwire_id: tripwire.id,
                    event_key: "fact:inst-a:1".to_string(),
                    at_ms: 1,
                    instance: h.config.instance.clone(),
                    status: TripStatus::Running,
                    reason: None,
                    event_payload: None,
                    repo_root: Some(root.to_string_lossy().into_owned()),
                },
            )
            .unwrap()
            .expect("written");
            ledger::record_run(&h.conn, trip_id, None, Some(&arc)).unwrap();
            let before = base_fingerprint(&root);

            let mut conn = ledger::open_ledger(&h.config.db_path).unwrap();
            sweep_restarted_runs(&h.config, &mut conn);

            let swept = ledger::trip(&h.conn, trip_id).unwrap().unwrap();
            assert_eq!(
                swept.status, "failed",
                "the session the row named died with the process"
            );
            assert!(
                tugarc_core::ops::arc_exists_in(&root, &arc),
                "the tripwire's arc holds no rounds and is still its own: {:?}",
                arcs_in(&root)
            );
            assert_eq!(base_fingerprint(&root), before);
        }
    }
}
