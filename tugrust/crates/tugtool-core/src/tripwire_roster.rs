//! The roster projection: one tripwire as every surface reads it — the stored
//! row, plus the facts about it that are not in the row at all.
//!
//! Doctrine: `tuglaws/tripwires.md` (one projection, three callers).
//!
//! **It has three callers, and that is the point.** The HTTP surface
//! (`tugcast::tripwires_api`), the `TRIPWIRES` feed, and `tugtool tripwire
//! list` all compute their answer here, so the card, the feed and the command
//! line cannot disagree about whether a tripwire is running. That is what
//! [B05]'s "one projection over one ledger" means — *not* one endpoint: the
//! CLI has to work with the app closed, so the projection is a library
//! function rather than a route.
//!
//! **One behaviour change came with the move, and it is deliberate.** The
//! `project()` this was ported from read its trips with `.unwrap_or_default()`,
//! so a failed `trips_for_tripwire` answered `200` with an all-false row —
//! a tripwire that is running reported as idle, and nobody told. [`row_for`]
//! returns a `Result` and the same failure now reaches the caller, which the
//! feed needs: Spec S01's frame has an `error` field so it can say a read
//! failed rather than publish a roster of `false`. Do not put the quiet
//! fallback back as a kindness.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::tripwire_ledger::{self as ledger, TripStatus, Tripwire, TripwireLedgerError};

/// How a caller resolves an arc's worktree path, handed to the projection
/// because this crate cannot ask for itself.
///
/// `tugarc_core::ops::worktree_path` is the one implementation — it is the
/// only thing that knows the legacy `.tugtree/` fallback, and its own doc
/// comment says a caller reconstructing the path would be reconstructing that
/// fallback. But `tugarc-core` depends on *this* crate, so the projection
/// cannot call it; it takes it as an argument instead, which is what makes
/// "the one implementation" true across all three of the callers below rather
/// than merely intended.
pub type WorktreeResolver = fn(&Path, &str) -> PathBuf;

/// How far back the projection looks for a tripwire's live state. The card
/// shows "running now" and "has staged work", both of which are recent facts;
/// a tripwire whose last twenty trips are all settled is not running.
pub const PROJECTION_DEPTH: i64 = 20;

/// The window [`trip_log_revision`] hashes ([P03]).
///
/// It holds the same number as `tripwires_api.rs`'s `MAX_TRIP_LIMIT` — the
/// ceiling on a trip log the HTTP surface will hand out — and that is a
/// constraint rather than a coincidence: the card re-asks a log whose revision
/// moved, so a revision computed over a *shorter* window would let a change
/// past that window's edge go unnoticed in a log the card is showing. This
/// constant may never fall below that one. It is not the same constant, and
/// neither moves: `MAX_TRIP_LIMIT` is the HTTP window and stays in `tugcast`.
pub const REVISION_DEPTH: i64 = 500;

/// The newest trip, as the card's row shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastTrip {
    pub at_ms: i64,
    pub status: String,
    pub headline: Option<String>,
    /// The session the newest trip ran in, when it had one — including a trip
    /// that finished quiet, whose session is still the one Open session opens
    /// ([P10]).
    pub session_id: Option<String>,
    /// The session's last assistant message, on a trip that ran one ([P04]).
    /// The fold shows it: a trip that answered its brief has put the answer
    /// where the card reads it, with no verb in between.
    pub report: Option<String>,
    /// How many rounds that trip committed on the tripwire's arc ([P04]).
    pub rounds: Option<i64>,
}

/// One tripwire as the card, the feed and the CLI read it (Spec S02).
///
/// `PartialEq` is load-bearing: the `TRIPWIRES` feed suppresses a frame that
/// says what the last one said, and this is what "the same" means there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RosterRow {
    pub name: String,
    pub trigger: String,
    pub scope: Option<String>,
    pub probe: Option<String>,
    pub brief: String,
    /// The one sentence the card shows in place of the brief ([B01]). The
    /// brief travels with it because the `/tripwire` skill reads it back
    /// through `list --json` during revision; the card simply does not render
    /// it.
    pub description: String,
    pub model: Option<String>,
    pub permission_mode: String,
    pub paused: bool,
    /// How long a trip of this tripwire may run, and how many tool calls it
    /// may spend, before the engine interrupts its session and closes it
    /// ([P06]). On the row because the cost of laying a tripwire has to be
    /// readable from the same projection every other fact about it is.
    pub max_seconds: i64,
    pub max_tool_calls: i64,
    pub running: bool,
    /// The session the row's dot reads and the row menu's Open session opens
    /// — the two have to be the same value or the dot lies ([P10]).
    ///
    /// The running trip's session, else the newest trip's when it had one.
    /// The fallback is what keeps a *finished* trip reachable ([B04]): a trip
    /// that found nothing still ran a session somebody may want to read, and
    /// the row going dark the moment it finished is the thing this exists to
    /// stop. A trip running its probe has no session yet, and the row shows a
    /// plain running dot for that stretch rather than a session dot keyed on
    /// nothing.
    pub open_session: Option<String>,
    /// The worktree the session named by `open_session` is standing in — the
    /// tripwire's own arc worktree ([P02], [P08]).
    ///
    /// Computed rather than stored: it is a fact about where the arc is on
    /// disk right now, which a column would go stale against. `None` when the
    /// tripwire has no home checkout recorded, which is a tripwire whose trips
    /// have nowhere to stand.
    ///
    /// On the row because the deck needs it to open a card on a running trip,
    /// and the roster feed is the one thing that already carries
    /// `open_session`. The alternative — resolving the session's project dir
    /// deck-side — cannot be done from an effect walking a frame of rows: the
    /// citation store is a one-id React hook with no imperative read.
    pub open_session_dir: Option<String>,
    pub last_trip: Option<LastTrip>,
    /// How many trips this tripwire has that actually ran — the number the
    /// card's band sums ([P10]). `skipped` rows are excluded, so a broad
    /// tripwire's busy-skips do not drown the count.
    pub trip_count: i64,
    /// [P03]. An opaque equality token over the tripwire's trip log — nothing
    /// may order or subtract two of them. Masked to 53 bits so it survives a
    /// JSON round trip into a TypeScript `number`.
    pub trip_log_revision: i64,
}

/// Every tripwire, in `ledger::list` order — which is the order they were laid.
pub fn roster(
    conn: &Connection,
    worktree_of: WorktreeResolver,
) -> Result<Vec<RosterRow>, TripwireLedgerError> {
    ledger::list(conn)?
        .iter()
        .map(|tripwire| row_for(conn, tripwire, worktree_of))
        .collect()
}

/// One tripwire's row.
pub fn row_for(
    conn: &Connection,
    tripwire: &Tripwire,
    worktree_of: WorktreeResolver,
) -> Result<RosterRow, TripwireLedgerError> {
    let trips = ledger::trips_for_tripwire(conn, tripwire.id, PROJECTION_DEPTH)?;
    let running = trips
        .iter()
        .find(|t| t.status == TripStatus::Running.as_str());
    let last = trips.first();
    let open_session = running
        .or_else(|| trips.iter().find(|t| t.session_id.is_some()))
        .and_then(|t| t.session_id.clone());
    // Only where there is a session to place. A tripwire with no home
    // checkout has no arc worktree either, and an empty string is not a path.
    let open_session_dir = open_session.as_ref().and_then(|_| {
        if tripwire.repo_root.is_empty() {
            return None;
        }
        let arc = ledger::tripwire_arc(&tripwire.name);
        Some(
            worktree_of(Path::new(&tripwire.repo_root), &arc)
                .to_string_lossy()
                .into_owned(),
        )
    });
    Ok(RosterRow {
        name: tripwire.name.clone(),
        trigger: tripwire.trigger.clone(),
        scope: tripwire.scope.clone(),
        probe: tripwire.probe.clone(),
        brief: tripwire.brief.clone(),
        description: tripwire.description.clone(),
        model: tripwire.model.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        paused: tripwire.paused,
        max_seconds: tripwire.max_seconds,
        max_tool_calls: tripwire.max_tool_calls,
        running: running.is_some(),
        // The running trip's session, else the newest trip that *had* one,
        // which is not the same as the newest trip. A tripwire with a live
        // trip writes a `skipped` row per matching fact, and a skip never ran
        // a session at all — so reading `first()` here put the row dark the
        // moment one skip was written after the quiet trip whose session is
        // the one Open session means ([B04]).
        open_session,
        open_session_dir,
        last_trip: last.map(|t| LastTrip {
            at_ms: t.at_ms,
            status: t.status.clone(),
            headline: t.headline.clone(),
            session_id: t.session_id.clone(),
            report: t.report.clone(),
            rounds: t.rounds,
        }),
        trip_count: ledger::trip_count(conn, tripwire.id)?,
        trip_log_revision: trip_log_revision(conn, tripwire.id)?,
    })
}

/// A 64-bit FNV-1a hash over the volatile columns of the tripwire's newest
/// [`REVISION_DEPTH`] trips, masked to 53 bits ([P03]).
///
/// The columns that move in place — `status`, `settled_at_ms`, `probe_exit`,
/// `headline`, `arc`, `report`, `rounds`, `session_id`, `reason` — go in by
/// value. The three bulky ones — `probe_tail` (8 KiB cap), `refs` and
/// `event_payload` (the fact's whole JSON) — go in by `LENGTH`, because 500
/// rows of them by value would be megabytes of transient string per recompose,
/// and every statement that writes one of them also moves a by-value column.
///
/// A tripwire with no trips has revision 0.
pub fn trip_log_revision(conn: &Connection, tripwire_id: i64) -> Result<i64, TripwireLedgerError> {
    // `quote()` renders NULL as the text `NULL` and a string with its quotes,
    // so an absent value and an empty one are different bytes. The bulky three
    // take `-1` for absent, which no LENGTH can be.
    let sql = "
        SELECT group_concat(sig, char(30)) FROM (
            SELECT
                quote(id)             || char(31) || quote(status)        || char(31) ||
                quote(at_ms)          || char(31) || quote(settled_at_ms) || char(31) ||
                quote(probe_exit)     || char(31) || quote(headline)      || char(31) ||
                quote(arc)            || char(31) ||
                quote(report)         || char(31) || quote(rounds)        || char(31) ||
                quote(session_id)     || char(31) || quote(reason)        || char(31) ||
                quote(event_key)      || char(31) || quote(instance)      || char(31) ||
                COALESCE(LENGTH(probe_tail), -1)    || char(31) ||
                COALESCE(LENGTH(refs), -1)          || char(31) ||
                COALESCE(LENGTH(event_payload), -1) AS sig
            FROM trips WHERE tripwire_id = ?1 ORDER BY id DESC LIMIT ?2
        )";
    let joined: Option<String> = conn
        .query_row(sql, params![tripwire_id, REVISION_DEPTH], |row| row.get(0))
        .optional()?
        .flatten();
    Ok(match joined {
        Some(text) => fnv1a_53(text.as_bytes()),
        None => 0,
    })
}

/// FNV-1a over the bytes, folded to 53 bits so the value survives JSON and
/// TypeScript's `number` as an opaque equality token.
fn fnv1a_53(bytes: &[u8]) -> i64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    (hash & ((1u64 << 53) - 1)) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tripwire_ledger::{NewTrip, NewTripwire, Settlement, TripStatus};

    fn scratch() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = ledger::open_ledger(dir.path().join("tripwires.db")).unwrap();
        (dir, conn)
    }

    /// The resolver the real callers hand in, standing in for
    /// `tugarc_core::ops::worktree_path` — which this crate sits below and
    /// cannot call. Its *new* home, which is what a fresh arc gets, so a test
    /// asserting the path is asserting the shape rather than the legacy
    /// fallback.
    fn worktree_of(repo: &std::path::Path, arc: &str) -> PathBuf {
        repo.join(".tug").join("worktrees").join(arc)
    }

    fn lay(conn: &Connection, name: &str) -> Tripwire {
        ledger::lay(
            conn,
            &NewTripwire::new(
                name,
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "report anything that looks wrong",
                "Reports anything that looks wrong on main",
            ),
            1,
        )
        .unwrap()
    }

    /// A trip in the state the engine would have written it in.
    fn fire(conn: &Connection, tripwire: &Tripwire, key: &str, at_ms: i64) -> i64 {
        ledger::insert_trip(
            conn,
            &NewTrip {
                tripwire_id: tripwire.id,
                event_key: key.to_string(),
                at_ms,
                instance: "inst".to_string(),
                status: TripStatus::Running,
                reason: None,
                event_payload: None,
                repo_root: None,
            },
        )
        .unwrap()
        .expect("this tripwire has no row for that key yet")
    }

    #[test]
    fn a_tripwire_that_never_fired_projects_idle_with_no_revision() {
        let (_dir, conn) = scratch();
        let tripwire = lay(&conn, "ci");
        let row = row_for(&conn, &tripwire, worktree_of).unwrap();
        assert_eq!(row.name, "ci");
        assert!(!row.paused);
        assert!(!row.running);
        assert!(row.open_session.is_none());
        assert!(
            row.last_trip.is_none(),
            "a tripwire that never fired has no last trip rather than an empty one"
        );
        assert_eq!(
            row.trip_log_revision, 0,
            "and an empty log's revision is 0, not a hash of nothing in particular"
        );
    }

    /// A running trip is what the card's live indicator reads, and it is a
    /// projection over the trip log rather than a column, so it cannot drift
    /// from the log the detail level shows.
    #[test]
    fn a_running_trip_shows_on_the_tripwire_it_is_running_for() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let other = lay(&conn, "other");
        let trip_id = fire(&conn, &ci, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();

        let rows = roster(&conn, worktree_of).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].running);
        assert_eq!(
            rows[0].open_session.as_deref(),
            Some("sess-1"),
            "the live dot is keyed on the session, so the projection has to carry it"
        );
        assert_eq!(rows[0].last_trip.as_ref().unwrap().status, "running");
        assert!(!rows[1].running, "and only that tripwire");
        assert_eq!(rows[1].name, other.name);
    }

    /// A finished trip's report and the arc it committed on, which together
    /// are what the row's fold reads ([P04], [P05]).
    #[test]
    fn a_done_trip_shows_its_report_and_the_arc_it_committed_on() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = fire(&conn, &ci, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-ci")).unwrap();
        ledger::record_report(
            &conn,
            trip_id,
            "the migration drops a column nothing backfills",
            2,
        )
        .unwrap();
        ledger::settle(&conn, trip_id, TripStatus::Done, &Settlement::default(), 20).unwrap();

        let row = row_for(&conn, &ci, worktree_of).unwrap();
        assert!(!row.running, "a done run has finished — it is not working");
        let last = row.last_trip.as_ref().unwrap();
        assert_eq!(
            last.report.as_deref(),
            Some("the migration drops a column nothing backfills")
        );
        assert_eq!(last.rounds, Some(2));
    }

    /// The worktree a trip's session is standing in rides the row beside the
    /// session itself ([P08]), so the deck can open a card on it without
    /// resolving a project dir it has no imperative way to ask for.
    #[test]
    fn a_session_on_the_row_names_the_worktree_it_stands_in() {
        let (_dir, conn) = scratch();
        let mut new = NewTripwire::new(
            "ci",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "report anything that looks wrong",
            "Reports anything that looks wrong on main",
        );
        new.repo_root = "/src/tug".to_string();
        let ci = ledger::lay(&conn, &new, 1).unwrap();
        let trip_id = fire(&conn, &ci, "fact:inst:1", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();

        let row = row_for(&conn, &ci, worktree_of).unwrap();
        assert_eq!(row.open_session.as_deref(), Some("sess-1"));
        assert_eq!(
            row.open_session_dir.as_deref(),
            Some("/src/tug/.tug/worktrees/tripwire-ci"),
            "the tripwire's own arc worktree, in its home checkout"
        );
    }

    /// Two ways to have nothing to say, and both say nothing rather than
    /// something wrong: no session to place, and no checkout to place it in.
    #[test]
    fn a_row_with_no_session_or_no_home_checkout_names_no_worktree() {
        let (_dir, conn) = scratch();

        // Laid with a home checkout, but no trip has run a session.
        let mut new = NewTripwire::new(
            "ci",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "report anything that looks wrong",
            "Reports anything that looks wrong on main",
        );
        new.repo_root = "/src/tug".to_string();
        let ci = ledger::lay(&conn, &new, 1).unwrap();
        assert_eq!(
            row_for(&conn, &ci, worktree_of).unwrap().open_session_dir,
            None
        );

        // And a tripwire laid before the arc existed: a session on the row,
        // and nowhere on disk it could be standing.
        let homeless = lay(&conn, "homeless");
        let trip_id = fire(&conn, &homeless, "fact:inst:1", 10);
        ledger::record_run(&conn, trip_id, Some("sess-2"), None).unwrap();
        let row = row_for(&conn, &homeless, worktree_of).unwrap();
        assert_eq!(row.open_session.as_deref(), Some("sess-2"));
        assert_eq!(
            row.open_session_dir, None,
            "a checkout nobody chose is not invented to fill the field"
        );
    }

    /// A finished trip's session is the one Open session opens, and a `skipped`
    /// row written after it does not take that away.
    ///
    /// The skip is the case that matters, because it is the common one: a
    /// tripwire with a live trip writes one `skipped` row per matching fact,
    /// and those rows are the newest rows in the log while carrying no session
    /// at all. A fallback that read the newest row rather than the newest row
    /// *with a session* left a finished trip's work unreachable the moment a
    /// single fact arrived behind it — which is the thing [B04] exists to stop.
    #[test]
    fn a_done_trips_session_is_the_one_open_session_opens() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = fire(&conn, &ci, "fact:inst:1", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
        ledger::settle(&conn, trip_id, TripStatus::Done, &Settlement::default(), 20).unwrap();

        let row = row_for(&conn, &ci, worktree_of).unwrap();
        assert!(!row.running);
        assert_eq!(
            row.open_session.as_deref(),
            Some("sess-1"),
            "a trip that finished still did the work, so its session stays openable"
        );

        // And a skip on top of it — the shape a busy tripwire writes by the
        // dozen — is a row with no session, not an answer to this question.
        ledger::insert_trip(
            &conn,
            &NewTrip {
                tripwire_id: ci.id,
                event_key: "fact:inst:2".to_string(),
                at_ms: 30,
                instance: "inst".to_string(),
                status: TripStatus::Skipped,
                reason: Some(ledger::SKIP_BUSY.to_string()),
                event_payload: None,
                repo_root: None,
            },
        )
        .unwrap()
        .expect("the skip is this tripwire's first row for that key");

        let row = row_for(&conn, &ci, worktree_of).unwrap();
        assert_eq!(
            row.last_trip.as_ref().unwrap().status,
            TripStatus::Skipped.as_str(),
            "the skip is the newest row, and the log says so"
        );
        assert_eq!(
            row.open_session.as_deref(),
            Some("sess-1"),
            "but it never ran a session, so it is not what Open session opens"
        );
        assert_eq!(
            row.trip_count, 1,
            "and it is not a trip the band counts either"
        );
    }

    /// Risk R01 as a checked property rather than an argument: each of the four
    /// statements that move a trip in place has to move the revision, because
    /// the frame is diff-suppressed and a change no roster field reflects would
    /// otherwise leave an open log stale with no timer behind it.
    #[test]
    fn every_in_place_write_moves_the_revision() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = fire(&conn, &ci, "abc", 10);

        let claimed = trip_log_revision(&conn, ci.id).unwrap();
        assert_ne!(claimed, 0, "a claimed trip is a log with something in it");

        ledger::record_probe(&conn, trip_id, 0, "probe said nothing").unwrap();
        let probed = trip_log_revision(&conn, ci.id).unwrap();
        assert_ne!(probed, claimed, "record_probe");

        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
        let ran = trip_log_revision(&conn, ci.id).unwrap();
        assert_ne!(ran, probed, "record_run");

        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Done,
            &Settlement {
                headline: Some("something to look at".to_string()),
                ..Settlement::default()
            },
            20,
        )
        .unwrap();
        let settled = trip_log_revision(&conn, ci.id).unwrap();
        assert_ne!(settled, ran, "settle");

        let trip_id2 = fire(&conn, &ci, "def", 30);
        ledger::record_run(&conn, trip_id2, Some("sess-2"), None).unwrap();
        let before_report = trip_log_revision(&conn, ci.id).unwrap();
        ledger::record_report(&conn, trip_id2, "what it found", 1).unwrap();
        assert_ne!(
            trip_log_revision(&conn, ci.id).unwrap(),
            before_report,
            "record_report"
        );
    }

    #[test]
    fn an_unrelated_tripwires_trips_do_not_move_the_revision() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let other = lay(&conn, "other");
        let quiet = trip_log_revision(&conn, ci.id).unwrap();

        let trip_id = fire(&conn, &other, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();

        assert_eq!(trip_log_revision(&conn, ci.id).unwrap(), quiet);
    }

    /// The revision crosses JSON into a TypeScript `number`, where anything
    /// above `Number.MAX_SAFE_INTEGER` would stop comparing equal to itself.
    #[test]
    fn the_revision_stays_inside_a_javascript_safe_integer() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        for i in 0..REVISION_DEPTH {
            fire(&conn, &ci, &format!("key-{i}"), 10 + i);
        }
        let revision = trip_log_revision(&conn, ci.id).unwrap();
        assert!(revision > 0);
        assert!(
            revision < (1i64 << 53),
            "the mask is what keeps a 64-bit hash equality-comparable after a JSON round trip"
        );
    }
}
