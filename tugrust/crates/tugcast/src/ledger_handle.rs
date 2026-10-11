//! `LedgerHandle`: the async face of `SessionLedger`.
//!
//! `SessionLedger` is synchronous — a `rusqlite` connection behind a mutex,
//! and a forward path that waits on the network — so every call from an
//! `async fn` blocks the worker it runs on. The handle moves where that
//! blocking happens, not how the ledger locks: [`LedgerHandle::run`] puts a
//! closure over the ledger on the blocking pool and awaits it, and
//! [`offload`] does the same for blocking work that reaches the ledger
//! through another owner (the sessions recorder).
//!
//! There is deliberately no `Deref` to `SessionLedger`: a deref would let a
//! sync call compile through the handle and quietly undo the conversion.
//! [`LedgerHandle::ledger`] is the escape hatch for a path that genuinely is
//! synchronous, and every use of it outside this module says why with a
//! `// LEDGER-SYNC:` comment.
//!
//! A routed write (`record_file_event_with_spans`, `upsert_changeset_draft`,
//! …) needs nothing special: inside `run`, its whole forward — the wait on
//! `forward_order`, the send, the settle — happens on the blocking thread.

use std::sync::Arc;

use crate::session_ledger::SessionLedger;
use crate::worker_gauge::FacadeGuard;

/// A cloneable handle to the session ledger whose calls run off the worker.
#[derive(Clone)]
pub(crate) struct LedgerHandle(Arc<SessionLedger>);

impl LedgerHandle {
    pub(crate) fn new(ledger: Arc<SessionLedger>) -> Self {
        Self(ledger)
    }

    /// The sync escape hatch; every use outside this module carries
    /// `// LEDGER-SYNC: <why>`.
    pub(crate) fn ledger(&self) -> &Arc<SessionLedger> {
        &self.0
    }

    /// Run `f` against the ledger on the blocking pool and await its result.
    pub(crate) async fn run<R, F>(&self, f: F) -> R
    where
        R: Send + 'static,
        F: FnOnce(&SessionLedger) -> R + Send + 'static,
    {
        let ledger = Arc::clone(&self.0);
        offload(move || f(&ledger)).await
    }
}

/// Run any blocking closure on the blocking pool, under the facade mark, and
/// await it. A panic in `f` is re-raised on the awaiting task.
pub(crate) async fn offload<R, F>(f: F) -> R
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let joined = tokio::task::spawn_blocking(move || {
        let _facade = FacadeGuard::enter();
        f()
    })
    .await;
    match joined {
        Ok(value) => value,
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(_) => panic!("ledger task cancelled"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_ledger::FileEventRow;
    use crate::worker_gauge::{strict_test_runtime, violations};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn event(tool: &str) -> FileEventRow {
        FileEventRow {
            tug_session_id: "s1".into(),
            tool_use_id: tool.into(),
            file_path: format!("{tool}.rs"),
            tool_name: "Write".into(),
            op: "modified".into(),
            origin: "exact".into(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".into(),
            at: 1,
        }
    }

    /// An owner publishing `port` and a follower forwarding to it, both
    /// opened on the calling thread.
    fn owner_and_follower(dir: &Path, port: u16) -> (Arc<SessionLedger>, Arc<SessionLedger>) {
        let changes = dir.join("changes.db");
        let owner =
            SessionLedger::open_full_for_test(dir.join("owner.db"), Some(changes.clone()), port)
                .expect("owner ledger");
        let follower = SessionLedger::open_full_for_test(dir.join("follower.db"), Some(changes), 0)
            .expect("follower ledger");
        assert!(!follower.owns_changes_writer());
        (Arc::new(owner), Arc::new(follower))
    }

    /// The owner's `/api/changes-write`, stalling `stall(tool)` before it
    /// applies on the blocking pool, and announcing each arrival on
    /// `arrivals` (a std channel, so a thread outside any runtime can wait).
    fn owner_app(
        owner: Arc<SessionLedger>,
        stall: fn(&str) -> Duration,
        arrivals: std::sync::mpsc::Sender<String>,
    ) -> axum::Router {
        axum::Router::new().route(
            "/api/changes-write",
            axum::routing::post(move |body: axum::body::Bytes| {
                let owner = Arc::clone(&owner);
                let arrivals = arrivals.clone();
                async move {
                    let tool = match serde_json::from_slice(&body) {
                        Ok(crate::changes_journal::Record::FileEvent { row, .. }) => {
                            row.tool_use_id
                        }
                        _ => String::new(),
                    };
                    let _ = arrivals.send(tool.clone());
                    tokio::time::sleep(stall(&tool)).await;
                    tokio::task::spawn_blocking(move || {
                        crate::server::apply_changes_write(&owner, &body)
                    })
                    .await
                    .expect("join")
                }
            }),
        )
    }

    /// A forwarded write made through `run` waits on the network on the
    /// blocking pool: on a one-worker runtime, the worker keeps serving
    /// other tasks for the whole stall — here, the owner's own endpoint and a
    /// ticker.
    #[test]
    fn handle_write_change_leaves_the_worker_free_during_a_stalled_forward() {
        let rt = strict_test_runtime(1);
        let dir = tempfile::tempdir().expect("tempdir");
        let listener = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (owner, follower) = owner_and_follower(dir.path(), port);
        let (tx, _arrivals) = std::sync::mpsc::channel();
        let app = owner_app(Arc::clone(&owner), |_| Duration::from_millis(1500), tx);
        rt.spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let ticks = Arc::new(AtomicUsize::new(0));
        rt.spawn({
            let ticks = Arc::clone(&ticks);
            async move {
                let mut interval = tokio::time::interval(Duration::from_millis(50));
                loop {
                    interval.tick().await;
                    ticks.fetch_add(1, Ordering::Relaxed);
                }
            }
        });

        let handle = LedgerHandle::new(follower);
        let before = ticks.load(Ordering::Relaxed);
        let written = rt
            .block_on(rt.spawn(async move {
                handle
                    .run(move |l| l.record_file_event_with_spans(&event("t1"), &[]))
                    .await
            }))
            .expect("no panic");
        let during = ticks.load(Ordering::Relaxed) - before;

        written.expect("the forwarded write lands");
        assert_eq!(owner.file_events_for_session("s1").unwrap().len(), 1);
        assert!(
            during >= 10,
            "the worker ticked {during} times during a 1.5 s stall"
        );
        assert_eq!(violations(), 0);
    }

    #[test]
    fn run_reraises_a_panic() {
        let rt = strict_test_runtime(2);
        let handle = LedgerHandle::new(Arc::new(SessionLedger::open_in_memory().expect("ledger")));
        let err = rt
            .block_on(rt.spawn(async move { handle.run(|_| -> () { panic!("boom") }).await }))
            .expect_err("the closure's panic reaches the awaiting task");
        let payload = err.into_panic();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        assert_eq!(message, "boom");
    }

    /// The hazard `forward_order` is shaped to avoid: sync writers still on
    /// the workers block there while an async forward is mid-send. Because
    /// the async forward holds the lock on a blocking-pool thread, it settles
    /// and releases without needing a worker, and everyone lands.
    #[test]
    fn sync_writers_on_every_worker_do_not_starve_an_async_forward() {
        let dir = tempfile::tempdir().expect("tempdir");

        // The owner's endpoint lives on its own runtime and thread, so a
        // blocked worker here can never be the thing that serves it.
        let (port_tx, port_rx) = std::sync::mpsc::channel();
        let (arrival_tx, arrivals) = std::sync::mpsc::channel();
        let (owner_tx, owner_rx) = std::sync::mpsc::channel::<Arc<SessionLedger>>();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("owner runtime");
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind");
                port_tx
                    .send(listener.local_addr().expect("addr").port())
                    .expect("port");
                let owner = owner_rx.recv().expect("owner ledger");
                let app = owner_app(
                    owner,
                    |tool| {
                        if tool == "t1" {
                            Duration::from_secs(1)
                        } else {
                            Duration::ZERO
                        }
                    },
                    arrival_tx,
                );
                let _ = axum::serve(listener, app).await;
            });
        });
        let port = port_rx.recv().expect("owner port");
        let (owner, follower) = owner_and_follower(dir.path(), port);
        owner_tx.send(Arc::clone(&owner)).expect("hand over owner");

        let rt = strict_test_runtime(2);
        let (done_tx, done) = std::sync::mpsc::channel();
        {
            let handle = LedgerHandle::new(Arc::clone(&follower));
            let done_tx = done_tx.clone();
            rt.spawn(async move {
                let result = handle.run(move |l| l.record_file_event(&event("t1"))).await;
                let _ = done_tx.send(("t1", result.is_ok()));
            });
        }
        assert_eq!(
            arrivals
                .recv_timeout(Duration::from_secs(5))
                .expect("t1 reached the owner"),
            "t1"
        );
        for tool in ["t2", "t3"] {
            let follower = Arc::clone(&follower);
            let done_tx = done_tx.clone();
            rt.spawn(async move {
                // Deliberately the unconverted shape: a sync write on a worker.
                let ok = follower.record_file_event(&event(tool)).is_ok();
                let _ = done_tx.send((tool, ok));
            });
        }

        let mut finished: Vec<(&str, bool)> = (0..3)
            .map(|_| {
                done.recv_timeout(Duration::from_secs(5))
                    .expect("every write finished — no worker starved the async forward")
            })
            .collect();
        finished.sort();
        assert_eq!(finished, [("t1", true), ("t2", true), ("t3", true)]);
        assert_eq!(owner.file_events_for_session("s1").unwrap().len(), 3);
        assert_eq!(violations(), 0);
    }
}
