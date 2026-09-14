//! The roster projection: one tripwire as every surface reads it — the stored
//! row, plus the facts about it that are not in the row at all.
//!
//! Doctrine: `tuglaws/tripwires.md` (one projection, three callers).
//!
//! **It has three callers, and that is the point.** The HTTP surface
//! (`tugcast::tripwires_api`), the `TRIPWIRES` feed, and `tugtool tripwire
//! list` all compute their answer here, so the card, the wire and the command
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
//! failed rather than publish a roster of `false`. Do not restore the swallow
//! as a kindness.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::tripwire_ledger::{self as ledger, TripStatus, Tripwire, TripwireLedgerError};

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
    pub branch: String,
    pub permission_mode: String,
    pub paused: bool,
    pub running: bool,
    pub adopted: bool,
    /// The session the live dot reads. A trip running its probe has none yet,
    /// and the section shows a plain running dot for that stretch rather than
    /// a session dot keyed on nothing.
    ///
    /// An adopted trip's session falls in here when nothing is running,
    /// because the alternative is that the row goes dark the instant it is
    /// adopted — and the dot the user reaches the session through is the one
    /// thing that must not disappear at that moment.
    pub running_session: Option<String>,
    pub awaiting: bool,
    pub awaiting_arc: Option<String>,
    /// The arc an *adopted* trip is holding, when it holds one.
    ///
    /// The twin of `awaiting_arc`, and it is here for the same reason: a
    /// removal dismisses an adopted trip exactly as it dismisses an awaiting
    /// one, discarding the arc it holds — so a confirm that named only the
    /// awaiting case would destroy a worktree it never mentioned.
    pub adopted_arc: Option<String>,
    pub last_trip: Option<LastTrip>,
    /// [P03]. An opaque equality token over the tripwire's trip log — nothing
    /// may order or subtract two of them. Masked to 53 bits so it survives a
    /// JSON round trip into a TypeScript `number`.
    pub trip_log_revision: i64,
}

/// Every tripwire, in `ledger::list` order — which is the order they were laid.
pub fn roster(conn: &Connection) -> Result<Vec<RosterRow>, TripwireLedgerError> {
    ledger::list(conn)?
        .iter()
        .map(|tripwire| row_for(conn, tripwire))
        .collect()
}

/// One tripwire's row.
pub fn row_for(conn: &Connection, tripwire: &Tripwire) -> Result<RosterRow, TripwireLedgerError> {
    let trips = ledger::trips_for_tripwire(conn, tripwire.id, PROJECTION_DEPTH)?;
    let running = trips
        .iter()
        .find(|t| t.status == TripStatus::Running.as_str());
    // Awaiting is what the card exists to surface: a run that finished with
    // something the user should see and is holding the wire's live-run slot
    // until they see it ([P07]). The arc it is holding comes back with it,
    // because that arc is the thing there is to decide about. Nothing checks
    // the arc is still on disk: an arc that was joined or discarded resolves
    // its own awaiting trip in the engine, so a row that still reads awaiting
    // is a row whose arc is still there.
    let awaiting = trips
        .iter()
        .find(|t| t.status == TripStatus::Awaiting.as_str());
    // And the trip a card took over. It holds no live-run slot ([B05]) — the
    // tripwire may fire again while the user works — but its session is alive
    // and reachable, which is the whole of what the row's live dot is for.
    let adopted = trips
        .iter()
        .find(|t| t.status == TripStatus::Adopted.as_str());
    let last = trips.first();
    Ok(RosterRow {
        name: tripwire.name.clone(),
        trigger: tripwire.trigger.clone(),
        scope: tripwire.scope.clone(),
        probe: tripwire.probe.clone(),
        brief: tripwire.brief.clone(),
        description: tripwire.description.clone(),
        model: tripwire.model.clone(),
        branch: tripwire.branch.clone(),
        permission_mode: tripwire.permission_mode.clone(),
        paused: tripwire.paused,
        running: running.is_some(),
        adopted: adopted.is_some(),
        running_session: running.or(adopted).and_then(|t| t.session_id.clone()),
        // An awaiting run has finished — it holds the wire's slot, it is not
        // working — so `awaiting` deliberately does not imply `running`.
        awaiting: awaiting.is_some(),
        awaiting_arc: awaiting.and_then(|t| t.arc.clone()),
        adopted_arc: adopted.and_then(|t| t.arc.clone()),
        last_trip: last.map(|t| LastTrip {
            at_ms: t.at_ms,
            status: t.status.clone(),
            headline: t.headline.clone(),
        }),
        trip_log_revision: trip_log_revision(conn, tripwire.id)?,
    })
}

/// A 64-bit FNV-1a hash over the volatile columns of the tripwire's newest
/// [`REVISION_DEPTH`] trips, masked to 53 bits ([P03]).
///
/// The columns that move in place — `status`, `settled_at_ms`, `probe_exit`,
/// `headline`, `author_ask`, `arc`, `session_id`, `swallow_reason` — go in by
/// value. The three bulky ones — `probe_tail` (8 KiB cap), `refs` and
/// `event_payload` (a landing's whole JSON) — go in by `LENGTH`, because 500
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
                quote(author_ask)     || char(31) || quote(arc)           || char(31) ||
                quote(session_id)     || char(31) || quote(swallow_reason)|| char(31) ||
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
    use crate::tripwire_ledger::{Claim, NewTripwire, Settlement};

    fn scratch() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = ledger::open_ledger(dir.path().join("tripwires.db")).unwrap();
        (dir, conn)
    }

    fn lay(conn: &Connection, name: &str) -> Tripwire {
        ledger::lay(
            conn,
            &NewTripwire::new(
                name,
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "report anything that looks wrong",
                "main",
                "Reports anything that looks wrong on main",
            ),
            1,
        )
        .unwrap()
    }

    fn claim(conn: &Connection, tripwire: &Tripwire, key: &str, at_ms: i64) -> i64 {
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(conn, tripwire.id, key, at_ms, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        trip_id
    }

    #[test]
    fn a_tripwire_that_never_fired_projects_idle_with_no_revision() {
        let (_dir, conn) = scratch();
        let tripwire = lay(&conn, "ci");
        let row = row_for(&conn, &tripwire).unwrap();
        assert_eq!(row.name, "ci");
        assert_eq!(row.branch, "main");
        assert!(!row.paused);
        assert!(!row.running);
        assert!(!row.awaiting);
        assert!(!row.adopted);
        assert!(row.running_session.is_none());
        assert!(row.awaiting_arc.is_none());
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
        let trip_id = claim(&conn, &ci, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();

        let rows = roster(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].running);
        assert_eq!(
            rows[0].running_session.as_deref(),
            Some("sess-1"),
            "the live dot is keyed on the session, so the projection has to carry it"
        );
        assert_eq!(rows[0].last_trip.as_ref().unwrap().status, "running");
        assert!(!rows[1].running, "and only that tripwire");
        assert_eq!(rows[1].name, other.name);
    }

    /// The awaiting state and the arc it holds, which together are the whole
    /// of what the section's yellow dot and its detail row read ([P07], [P08]).
    #[test]
    fn an_awaiting_trip_shows_with_the_arc_it_is_holding() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = claim(&conn, &ci, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-ci-abcd1234")).unwrap();
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

        let row = row_for(&conn, &ci).unwrap();
        assert!(row.awaiting);
        assert_eq!(row.awaiting_arc.as_deref(), Some("tripwire-ci-abcd1234"));
        assert!(
            !row.running,
            "an awaiting run has finished — it holds the wire's slot, it is not working"
        );
        assert_eq!(
            row.last_trip.as_ref().unwrap().headline.as_deref(),
            Some("the migration drops a column nothing backfills")
        );
    }

    /// An adopted trip's session fills `running_session` when nothing is
    /// running, so the row does not go dark the instant somebody takes it
    /// over — and the arc it is holding comes back beside it, because a
    /// removal discards that arc and the confirm has to be able to name it.
    #[test]
    fn an_adopted_trips_session_keeps_the_row_lit() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = claim(&conn, &ci, "abc", 10);
        ledger::record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-ci-abcd1234")).unwrap();
        ledger::adopt_if_running(&conn, trip_id, "taken over", 20).unwrap();

        let row = row_for(&conn, &ci).unwrap();
        assert!(row.adopted);
        assert!(!row.running);
        assert_eq!(row.running_session.as_deref(), Some("sess-1"));
        assert_eq!(row.adopted_arc.as_deref(), Some("tripwire-ci-abcd1234"));
    }

    /// Risk R01 as a checked property rather than an argument: each of the four
    /// statements that move a trip in place has to move the revision, because
    /// the frame is diff-suppressed and a change no roster field reflects would
    /// otherwise leave an open log stale with no timer behind it.
    #[test]
    fn every_in_place_write_moves_the_revision() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let trip_id = claim(&conn, &ci, "abc", 10);

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
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("something to look at".to_string()),
                ..Settlement::default()
            },
            20,
        )
        .unwrap();
        let settled = trip_log_revision(&conn, ci.id).unwrap();
        assert_ne!(settled, ran, "settle");

        let trip_id2 = claim(&conn, &ci, "def", 30);
        ledger::record_run(&conn, trip_id2, Some("sess-2"), None).unwrap();
        let before_adopt = trip_log_revision(&conn, ci.id).unwrap();
        ledger::adopt_if_running(&conn, trip_id2, "taken over", 40).unwrap();
        assert_ne!(
            trip_log_revision(&conn, ci.id).unwrap(),
            before_adopt,
            "adopt_if_running"
        );
    }

    #[test]
    fn an_unrelated_tripwires_trips_do_not_move_the_revision() {
        let (_dir, conn) = scratch();
        let ci = lay(&conn, "ci");
        let other = lay(&conn, "other");
        let quiet = trip_log_revision(&conn, ci.id).unwrap();

        let trip_id = claim(&conn, &other, "abc", 10);
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
            claim(&conn, &ci, &format!("key-{i}"), 10 + i);
        }
        let revision = trip_log_revision(&conn, ci.id).unwrap();
        assert!(revision > 0);
        assert!(
            revision < (1i64 << 53),
            "the mask is what keeps a 64-bit hash equality-comparable after a JSON round trip"
        );
    }
}
