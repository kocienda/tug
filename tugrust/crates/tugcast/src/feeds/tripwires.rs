//! The tripwire roster feed (TRIPWIRES, `0xB0`) — every laid tripwire with its
//! live state, pushed to every client and republished whenever any of it
//! changes ([P01]).
//!
//! It replaces the card's 5-second `GET /api/tripwires` poll. The roster is
//! small, always shown, and is what every dot and every gesture on the
//! Tripwires card reads, which is what makes it worth pushing; the per-tripwire
//! trip log stays a request, because it is per-tripwire and up to 500 rows.
//!
//! **What makes it correct is the `PRAGMA data_version` probe, not the bumps**
//! ([P02]). Four parties write `tripwires.db` — this process's engine, this
//! process's HTTP surface, a `tugtool tripwire` in another process, and another
//! instance's engine — and the fourth has no door to reach this process
//! through at all. `data_version` moves on *every* other connection's commit,
//! including this process's own engine on its own connection, so a nudge that
//! was never added, or one that was missed, costs latency rather than
//! correctness. Every `bump()` in the codebase is there to remove that latency
//! and nothing rests on one.
//!
//! The loop is `changeset_all`'s with `jots`'s payload discipline: compose,
//! suppress a snapshot equal to the last, publish; then wait on the cancel, on
//! a bump behind a coalescing floor, or on the probe — which never recomposes,
//! only fires the bump.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::Connection;
use serde_json::json;
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tugcast_core::{FeedId, Frame, SnapshotFeed};
use tugtool_core::tripwire_ledger as ledger;
use tugtool_core::tripwire_roster::{self, RosterRow};

/// How long a bump waits before recomposing, so a burst of them costs one
/// compose. `changeset_all`'s floor, for the same reason: a landing settles
/// several trips in quick succession and each one nudges.
const BUMP_FLOOR: Duration = Duration::from_millis(150);

/// How often the ledger's own version is read ([P04]).
///
/// `changeset_all`'s drafts-probe interval rather than `jots`'s 250 ms, and
/// for the same reason: the bump already covers every writer with a door to
/// this process, and the probe is the named exception — the writer with no
/// door, another instance's engine. The event is real; only its *observation*
/// is polled.
const DATA_VERSION_PROBE: Duration = Duration::from_secs(2);

/// The process-global recompose signal.
///
/// A `OnceLock` rather than an axum `Extension` for the same reason
/// [`crate::feeds::tripwire`]'s `MANUAL_KICK` is one: the callers are the HTTP
/// handlers and the engine, neither of which is handed a feed. The handlers
/// already resolve their db path per request, and a second wiring path that
/// only tests take is exactly what that avoids.
static ROSTER_BUMP: OnceLock<Arc<Notify>> = OnceLock::new();

/// Tell the roster feed the ledger moved. Answers whether anybody was
/// listening — `false` on a build with no feed, which changes nothing, since
/// the probe would have seen the same commit within [`DATA_VERSION_PROBE`].
pub fn bump() -> bool {
    match ROSTER_BUMP.get() {
        Some(notify) => {
            notify.notify_one();
            true
        }
        None => false,
    }
}

/// The account-global TRIPWIRES feed.
pub struct TripwiresFeed {
    db_path: PathBuf,
    bump: Arc<Notify>,
}

impl TripwiresFeed {
    pub fn new(db_path: PathBuf) -> Self {
        let bump = Arc::new(Notify::new());
        // A second feed in one process would be a bug, so the set is
        // deliberately not `expect`ed: the first one wins and the second's
        // bumps would simply reach the first.
        let _ = ROSTER_BUMP.set(Arc::clone(&bump));
        Self { db_path, bump }
    }
}

/// Spec S01's payload. `tripwires` retains the last good roster on a failed
/// read, and `error` carries the reason — the `jots` `frame_from_outcome`
/// contract, and the reason [`tripwire_roster::row_for`] returns a `Result`
/// rather than swallowing a failed trip read into a roster of `false`.
fn frame(rows: &[RosterRow], error: Option<&str>) -> Frame {
    let payload = json!({ "tripwires": rows, "error": error });
    Frame::new(
        FeedId::TRIPWIRES,
        serde_json::to_vec(&payload).unwrap_or_default(),
    )
}

/// The ledger's own change counter. Moves for every *other* connection's
/// commit, which is the whole of why it is the backstop.
fn data_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

#[async_trait]
impl SnapshotFeed for TripwiresFeed {
    fn feed_id(&self) -> FeedId {
        FeedId::TRIPWIRES
    }

    fn name(&self) -> &str {
        "tripwires"
    }

    async fn run(self: Box<Self>, tx: watch::Sender<Frame>, cancel: CancellationToken) {
        // One connection for the task's life. A failed open warns and returns
        // rather than retrying, the shape `run_tripwire_engine` takes — the
        // ledger is created on first open, so a failure here is a broken
        // machine rather than a race.
        let conn = match ledger::open_ledger(&self.db_path) {
            Ok(conn) => conn,
            Err(e) => {
                warn!(error = %e, "tripwires feed: cannot open the ledger");
                let _ = tx.send(frame(&[], Some(&e.to_string())));
                return;
            }
        };
        info!("tripwires roster feed started");

        let mut previous: Option<Vec<RosterRow>> = None;
        let mut last_good: Vec<RosterRow> = Vec::new();

        let mut probe = tokio::time::interval(DATA_VERSION_PROBE);
        probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Seed before the loop, the way `changeset_all` seeds
        // `last_drafts_version`: an interval's first tick fires immediately,
        // so an unseeded `last` turns that tick into a spurious bump and
        // spends a whole compose the diff suppression then throws away.
        let mut last_data_version = data_version(&conn);

        loop {
            match tripwire_roster::roster(&conn) {
                Ok(rows) => {
                    if previous.as_ref() != Some(&rows) {
                        debug!(tripwires = rows.len(), "tripwire roster updated");
                        let _ = tx.send(frame(&rows, None));
                        last_good = rows.clone();
                        previous = Some(rows);
                    }
                }
                Err(e) => {
                    // An error always publishes — its message is the payload,
                    // and the roster beside it is the last one that read
                    // cleanly rather than a roster of `false`.
                    warn!(error = %e, "tripwires feed: roster read failed");
                    let _ = tx.send(frame(&last_good, Some(&e.to_string())));
                    previous = None;
                }
            }

            'wait: loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        info!("tripwires roster feed shutting down");
                        return;
                    }
                    _ = self.bump.notified() => {
                        tokio::select! {
                            _ = cancel.cancelled() => {
                                info!("tripwires roster feed shutting down");
                                return;
                            }
                            _ = tokio::time::sleep(BUMP_FLOOR) => {}
                        }
                        // Nothing awaited `notified()` during the sleep, so a
                        // bump that landed there left a stored permit. Consume
                        // it — its work is already folded into the compose
                        // about to run, and leaving it would spend a second
                        // compose on an identical roster.
                        let _ = tokio::time::timeout(
                            Duration::ZERO,
                            self.bump.notified(),
                        )
                        .await;
                        break 'wait;
                    }
                    // The probe never composes. It reads one integer and, on a
                    // move, fires the bump — the compose happens on the next
                    // pass of the arm above, exactly as `changeset_all`'s
                    // drafts probe does it.
                    _ = probe.tick() => {
                        let version = data_version(&conn);
                        if version != last_data_version {
                            last_data_version = version;
                            self.bump.notify_one();
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcast_core::spawn_snapshot_feed;
    use tugtool_core::tripwire_ledger::{Claim, NewTripwire, Settlement, TripStatus};

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tripwires.db");
        ledger::open_ledger(&path).unwrap();
        (dir, path)
    }

    /// A second connection to the same file — what every other writer of this
    /// ledger is, and what `PRAGMA data_version` exists to notice.
    fn lay(path: &std::path::Path, name: &str) {
        let conn = ledger::open_ledger(path).unwrap();
        ledger::lay(
            &conn,
            &NewTripwire::new(
                name,
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "report anything that looks wrong",
                "main",
            ),
            1,
        )
        .unwrap();
    }

    fn roster_of(frame: &Frame) -> serde_json::Value {
        serde_json::from_slice(&frame.payload).unwrap()
    }

    /// What makes a test binary — and a build with the feed absent — safe:
    /// the door answers rather than panicking when nobody registered one. The
    /// shape `feeds::tripwire::kick` already has.
    #[test]
    fn a_bump_with_no_feed_registered_is_answered_false() {
        assert!(!bump());
    }

    fn start(path: &std::path::Path) -> (watch::Receiver<Frame>, CancellationToken) {
        let (tx, rx) = watch::channel(Frame::new(FeedId::TRIPWIRES, vec![]));
        let cancel = CancellationToken::new();
        spawn_snapshot_feed(
            Box::new(TripwiresFeed::new(path.to_path_buf())),
            tx,
            cancel.clone(),
        );
        (rx, cancel)
    }

    async fn next_frame(rx: &mut watch::Receiver<Frame>, secs: u64) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(secs), rx.changed())
            .await
            .expect("a frame within the timeout")
            .expect("sender alive");
        roster_of(&rx.borrow_and_update())
    }

    #[tokio::test]
    async fn the_initial_frame_carries_the_whole_roster_in_lay_order() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        lay(&path, "edits");
        let (mut rx, cancel) = start(&path);

        let body = next_frame(&mut rx, 5).await;
        assert!(body["error"].is_null());
        let rows = body["tripwires"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], "ci");
        assert_eq!(rows[1]["name"], "edits");
        assert_eq!(rows[0]["running"], false);

        cancel.cancel();
    }

    /// The backstop, and the only test that proves it: a write on another
    /// connection with no bump at all still reaches a client, because
    /// `PRAGMA data_version` moved.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_with_no_bump_reaches_the_feed_through_the_version_probe() {
        let (_dir, path) = scratch();
        let (mut rx, cancel) = start(&path);
        next_frame(&mut rx, 5).await;

        lay(&path, "ci");

        let body = next_frame(&mut rx, 10).await;
        let rows = body["tripwires"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "ci");

        cancel.cancel();
    }

    #[tokio::test]
    async fn a_bump_over_an_unchanged_ledger_publishes_no_frame() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (mut rx, cancel) = start(&path);
        next_frame(&mut rx, 5).await;

        assert!(bump(), "the feed registered the process-global door");
        assert!(
            tokio::time::timeout(Duration::from_millis(750), rx.changed())
                .await
                .is_err(),
            "a compose that answers what the last one answered publishes nothing"
        );

        cancel.cancel();
    }

    /// What makes the probe interval free: a tick over a ledger nobody wrote
    /// reads one integer, finds it unmoved, and does not even compose.
    #[tokio::test]
    async fn a_probe_tick_over_a_quiet_ledger_publishes_no_frame() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (mut rx, cancel) = start(&path);
        next_frame(&mut rx, 5).await;

        assert!(
            tokio::time::timeout(Duration::from_secs(5), rx.changed())
                .await
                .is_err(),
            "two probe intervals pass over a quiet ledger with nothing published"
        );

        cancel.cancel();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bumps_inside_the_floor_publish_one_frame() {
        let (_dir, path) = scratch();
        let (mut rx, cancel) = start(&path);
        next_frame(&mut rx, 5).await;

        lay(&path, "ci");
        assert!(bump());
        tokio::time::sleep(Duration::from_millis(50)).await;
        lay(&path, "edits");
        assert!(bump());

        let body = next_frame(&mut rx, 5).await;
        assert_eq!(
            body["tripwires"].as_array().unwrap().len(),
            2,
            "one frame carries both writes"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(750), rx.changed())
                .await
                .is_err(),
            "the stored permit was consumed, so no second compose follows"
        );

        cancel.cancel();
    }

    /// A settle moves nothing in the tripwires table, so the roster's live
    /// fields and the log revision are the whole of what says it happened.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_settle_on_another_connection_moves_last_trip_and_the_revision() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (mut rx, cancel) = start(&path);
        let before = next_frame(&mut rx, 5).await;
        let quiet_revision = before["tripwires"][0]["trip_log_revision"].clone();
        assert!(before["tripwires"][0]["last_trip"].is_null());

        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("the migration drops a column nothing backfills".to_string()),
                ..Settlement::default()
            },
            20,
        )
        .unwrap();
        assert!(bump());

        let after = next_frame(&mut rx, 5).await;
        let row = &after["tripwires"][0];
        assert_eq!(row["awaiting"], true);
        assert_eq!(
            row["last_trip"]["headline"],
            "the migration drops a column nothing backfills"
        );
        assert_ne!(row["trip_log_revision"], quiet_revision);

        cancel.cancel();
    }
}
