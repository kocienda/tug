//! The worker gauge: a debug-build assertion that `SessionLedger`'s
//! connection is never locked on a tokio worker outside the facade.
//!
//! A blocking SQLite call on a worker stalls every task scheduled behind it,
//! and a grep cannot find them — it misses calls made through helpers and
//! flags calls already inside `spawn_blocking`. So the check is made where
//! the blocking happens: [`GaugedMutex::lock`], which wraps
//! `SessionLedger::db`, asks whether the current thread is a worker and, if
//! so, whether it is inside [`crate::ledger_handle`]'s facade.
//!
//! **Which threads are workers.** Tokio names worker and blocking-pool
//! threads alike, so a name cannot tell them apart. The runtime's
//! `on_thread_park` hook can: tokio invokes it from the worker loop (and the
//! current-thread scheduler), never from the blocking pool. A thread is
//! marked the first time it parks. So a raw `spawn_blocking` closure — off
//! the worker already — passes without a facade mark, and so does the
//! `block_on` thread (`main`'s, or a test's), which is not a worker.
//!
//! A mark is never cleared. That is sound only because a worker never goes
//! back to serving the blocking pool, which in tokio happens only after
//! `block_in_place` hands a worker's core away. `tugcast` has no
//! `block_in_place`; adding one needs an unmark here, or that thread's later
//! raw `spawn_blocking` closures would be flagged.
//!
//! **Modes.** Runtimes built by [`strict_test_runtime`] panic on a violation
//! (before the lock is taken), which is how a conversion test proves a file's
//! async paths stay off the worker. The production runtime `main` builds
//! reports instead — a backtrace for the first few, then a running count —
//! because the sites not yet converted would otherwise crash every debug
//! app. Release builds keep the thread naming and nothing else: the lock is
//! a plain lock and no hook is installed.
//!
//! ## Census
//!
//! What the gauge covers, what it deliberately leaves, and what it would
//! catch if widened — taken 2026-10-10.
//!
//! **Sites that stay synchronous** (`// LEDGER-SYNC:` at each):
//!
//! - `feeds/agent_supervisor/mod.rs`
//!   - `compose_changeset_aggregate` hands the ledger to `compose_aggregate`
//!     in `feeds/changeset.rs`, which reads it between its own git awaits.
//!   - `note_model_switch`, `spawn_session_metrics_refresh` and
//!     `spawn_rewound_row_refresh` already run on the blocking pool, where
//!     the ledger work is mixed with arc-file or transcript I/O.
//!   - `resolve_ink_line` stays sync because the telemetry handlers call it
//!     synchronously; the async callers in this file go through the handle.
//! - `feeds/agent_supervisor/control/changeset.rs`
//!   - `do_changeset_draft_request` gives the `Arc` to the draft engine
//!     (`feeds/draft_engine.rs`) for the generation it spawns.
//!   - `do_changeset_join_resolve_base` passes the ledger to
//!     `live_base_dirt_for` in `feeds/changeset.rs`.
//!
//! **The other ledgers.** `PromptLedger`, `ShellLedger` and `RefsLedger`
//! each guard their connection with a `parking_lot::Mutex` of their own. To
//! test them, a throwaway probe swapped all three for [`GaugedMutex`] and
//! had strict mode print each hit rather than panic. It then ran the four
//! strict-gauge tests, one each for:
//!
//! - the supervisor's ledger paths;
//! - the session bridge's relay;
//! - the sessions recorder;
//! - the changeset control handlers.
//!
//! None of the four fired. That is a weak zero: none of those tests
//! installs a prompt, shell or refs ledger, so none of them reaches one.
//! Reading the code instead finds these locks taken on a worker:
//!
//! - `ShellLedger`
//!   - `shell_session_task` in `feeds/shell.rs` calls `record_exchange`
//!     inline.
//!   - `do_list_shell_exchanges` in `control/telemetry.rs` calls
//!     `list_exchanges_since` and `exchange_census`.
//!   - `ink_census_handler` in `server.rs` calls `ink_census`.
//!   - `shell_history` in `feeds/operator.rs` is a sync tool called from the
//!     async `dispatch`.
//!   - The landing receipts already run off the worker, through
//!     `record_landing_receipt_off_worker`.
//! - `RefsLedger`: `do_list_refs` in `control/telemetry.rs` calls
//!   `list_refs`. `execute_run` is clean: it runs on `spawn_blocking`.
//! - `PromptLedger`: none found. The `/api/prompt-history` handlers run on
//!   `spawn_blocking`, and the prompt-lineage write runs through `offload`.
//!
//! The gauge stays on `SessionLedger` alone. Widening it to the other three
//! is follow-on work, and the sites above are where it would start.
//!
//! **No sites in `feeds/arc.rs`.** It never reaches a `SessionLedger`, so
//! there was nothing to convert there.
//!
//! **Not yet converted.** Report mode names these `SessionLedger` callers in
//! a running debug build whenever they lock on a worker:
//!
//! - `server.rs`
//! - `boot/ledgers.rs` (its watchdog)
//! - `feeds/changeset.rs` and `feeds/changeset_all.rs`
//! - `feeds/draft_engine.rs`
//! - the other `feeds/agent_supervisor/control/*.rs` files: `arc.rs`,
//!   `rows.rs`, `session.rs` (which includes two inline recorder calls) and
//!   `telemetry.rs`
//! - `feeds/shell.rs`
//! - `feeds/refs.rs`
//! - `feeds/operator.rs` and `feeds/operator_ask.rs`
//! - `feeds/observer.rs` and `feeds/observer_wake.rs`
//! - `feeds/overview_agent.rs` and `feeds/overview_replay.rs`
//! - `feeds/arc_notes.rs` and `feeds/arc_runner.rs`
//! - `feeds/base_motion.rs`
//! - `wheel/mod.rs`
//! - `arc_api.rs`
//!
//! `boot/early.rs` runs on the `block_on` thread, which is not a worker, so
//! the gauge passes it.

#[cfg(debug_assertions)]
use std::cell::Cell;
#[cfg(debug_assertions)]
use std::sync::Arc;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicUsize, Ordering};

/// What a marked worker does when it locks the ledger outside the facade.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum GaugeMode {
    /// Panic. Only test runtimes are strict.
    #[cfg_attr(not(test), allow(dead_code))]
    Strict,
    /// Count and log, rate-limited.
    Report,
}

/// Reports carrying a backtrace before the log falls back to a count.
#[cfg(debug_assertions)]
const REPORT_BACKTRACES: usize = 16;

/// After the backtraces, one count line per this many violations.
#[cfg(debug_assertions)]
const REPORT_EVERY: usize = 1000;

#[cfg(debug_assertions)]
static VIOLATIONS: AtomicUsize = AtomicUsize::new(0);

#[cfg(debug_assertions)]
thread_local! {
    static WORKER_MARK: Cell<Option<GaugeMode>> = const { Cell::new(None) };
    static FACADE_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// The runtime `tugcast` runs on: multi-thread, every driver enabled, threads
/// named `tugcast-rt`. In debug builds its workers are marked in `mode`.
pub(crate) fn runtime_builder(mode: GaugeMode) -> tokio::runtime::Builder {
    #[cfg(debug_assertions)]
    {
        marked_builder(mode, Arc::new(AtomicUsize::new(0)))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = mode;
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        builder.enable_all().thread_name("tugcast-rt");
        builder
    }
}

/// A builder whose park hook marks each worker in `mode`, counting each
/// newly marked thread in `marked`.
#[cfg(debug_assertions)]
fn marked_builder(mode: GaugeMode, marked: Arc<AtomicUsize>) -> tokio::runtime::Builder {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder
        .enable_all()
        .thread_name("tugcast-rt")
        .on_thread_park(move || {
            WORKER_MARK.with(|mark| {
                if mark.get().is_none() {
                    mark.set(Some(mode));
                    marked.fetch_add(1, Ordering::Relaxed);
                }
            });
        });
    builder
}

/// A strict runtime with `workers` workers, returned only once every worker
/// has parked and been marked — a worker that stole a task before its first
/// park would otherwise pass over an unconverted site.
#[cfg(test)]
pub(crate) fn strict_test_runtime(workers: usize) -> tokio::runtime::Runtime {
    #[cfg(debug_assertions)]
    {
        let marked = Arc::new(AtomicUsize::new(0));
        let rt = marked_builder(GaugeMode::Strict, Arc::clone(&marked))
            .worker_threads(workers)
            .build()
            .expect("strict test runtime");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while marked.load(Ordering::Relaxed) < workers {
            assert!(
                std::time::Instant::now() < deadline,
                "only {} of {workers} workers parked within 2 s",
                marked.load(Ordering::Relaxed)
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        rt
    }
    #[cfg(not(debug_assertions))]
    {
        runtime_builder(GaugeMode::Strict)
            .worker_threads(workers)
            .build()
            .expect("strict test runtime")
    }
}

/// How many violations this process has seen. Tests run one per process
/// under nextest, so a test can assert on it directly.
#[cfg(test)]
pub(crate) fn violations() -> usize {
    #[cfg(debug_assertions)]
    {
        VIOLATIONS.load(Ordering::Relaxed)
    }
    #[cfg(not(debug_assertions))]
    {
        0
    }
}

/// The facade mark: while one is alive on a thread, locking the ledger there
/// is sanctioned. A depth, so nested offloads compose.
pub(crate) struct FacadeGuard {
    _private: (),
}

impl FacadeGuard {
    pub(crate) fn enter() -> Self {
        #[cfg(debug_assertions)]
        FACADE_DEPTH.with(|depth| depth.set(depth.get() + 1));
        Self { _private: () }
    }
}

impl Drop for FacadeGuard {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        FACADE_DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// Fire if this thread is a marked worker outside the facade.
#[cfg(debug_assertions)]
#[track_caller]
fn check() {
    let Some(mode) = WORKER_MARK.with(Cell::get) else {
        return;
    };
    if FACADE_DEPTH.with(Cell::get) > 0 {
        return;
    }
    let count = VIOLATIONS.fetch_add(1, Ordering::Relaxed) + 1;
    let location = std::panic::Location::caller();
    match mode {
        GaugeMode::Strict => panic!(
            "SessionLedger locked on a tokio worker outside LedgerHandle::run (at {location})"
        ),
        GaugeMode::Report => {
            if count <= REPORT_BACKTRACES {
                tracing::warn!(
                    %location,
                    count,
                    backtrace = %std::backtrace::Backtrace::force_capture(),
                    "SessionLedger locked on a tokio worker outside LedgerHandle::run"
                );
            } else if count % REPORT_EVERY == 0 {
                tracing::warn!(
                    %location,
                    count,
                    "SessionLedger locked on a tokio worker outside LedgerHandle::run"
                );
            }
        }
    }
}

/// `parking_lot::Mutex` with the gauge in front of `lock`. The call sites are
/// the plain mutex's; only the type changes.
pub(crate) struct GaugedMutex<T>(parking_lot::Mutex<T>);

impl<T> GaugedMutex<T> {
    pub(crate) fn new(value: T) -> Self {
        Self(parking_lot::Mutex::new(value))
    }

    /// Lock, after the gauge's check in debug builds. `track_caller` so a
    /// report names the ledger method that locked, not this one.
    #[track_caller]
    pub(crate) fn lock(&self) -> parking_lot::MutexGuard<'_, T> {
        #[cfg(debug_assertions)]
        check();
        self.0.lock()
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::ledger_handle::LedgerHandle;
    use crate::session_ledger::SessionLedger;

    fn ledger() -> Arc<SessionLedger> {
        Arc::new(SessionLedger::open_in_memory().expect("ledger"))
    }

    #[test]
    fn gauge_panics_on_a_worker_outside_run() {
        let rt = strict_test_runtime(2);
        let ledger = ledger();
        let joined = rt.block_on(async move {
            tokio::spawn(async move { ledger.get("nope").map(|_| ()) }).await
        });
        let err = joined.expect_err("a worker locking the ledger directly panics");
        assert!(err.is_panic());
        let payload = err.into_panic();
        let message = payload
            .downcast_ref::<String>()
            .cloned()
            .unwrap_or_default();
        assert!(
            message.contains("outside LedgerHandle::run"),
            "panic said: {message}"
        );
        assert_eq!(violations(), 1);
    }

    #[test]
    fn gauge_allows_run() {
        let rt = strict_test_runtime(2);
        let handle = LedgerHandle::new(ledger());
        rt.block_on(async move {
            tokio::spawn(async move { handle.run(|l| l.get("nope").map(|_| ())).await })
                .await
                .expect("no panic")
                .expect("read");
        });
        assert_eq!(violations(), 0);
    }

    #[test]
    fn gauge_allows_raw_spawn_blocking() {
        let rt = strict_test_runtime(2);
        let ledger = ledger();
        rt.block_on(async move {
            tokio::spawn(async move {
                tokio::task::spawn_blocking(move || ledger.get("nope").map(|_| ()))
                    .await
                    .expect("join")
            })
            .await
            .expect("no panic")
            .expect("read");
        });
        assert_eq!(violations(), 0);
    }

    #[test]
    fn gauge_allows_the_block_on_thread() {
        let rt = strict_test_runtime(2);
        let ledger = ledger();
        rt.block_on(async move { ledger.get("nope").map(|_| ()) })
            .expect("read");
        assert_eq!(violations(), 0);
    }
}
