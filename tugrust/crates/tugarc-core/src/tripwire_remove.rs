//! The shared removal: refuse a tripwire that is working, discard the arc a
//! finished run is holding, and delete the row.
//!
//! One spelling for two callers — `tugtool tripwire rm` and the HTTP surface
//! the Tripwires card reaches ([B07]). It lives here rather than in
//! `tugtool-core` for exactly the reason [`crate::tripwire_dismiss`] does: the
//! half that is not a ledger write *is* an arc discard, and
//! `discard_agent_arc_in` is this crate's. `tugarc-core` already depends on
//! `tugtool-core`'s ledger, so the ledger half sits beside the discard with no
//! new edge in the graph.
//!
//! **The order is the design.** A tripwire with a `running` trip is refused
//! before anything is discarded, because a refusal that had already thrown
//! away an `adopted` trip's arc would be the worst of both outcomes: the
//! tripwire is still there and the user's worktree is not. The ledger's own
//! `NOT EXISTS` guard is the backstop for the race this read cannot close, not
//! a substitute for taking it.

use rusqlite::Connection;
use tugtool_core::tripwire_ledger::{self as ledger, Tripwire, TripwireLedgerError};

use crate::tripwire_dismiss::{self, DismissRefusal};

/// What a removal did.
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    /// The arc a finished run was holding, when it held one. Dismissed before
    /// the delete rather than orphaned by it.
    pub arc: Option<String>,
    /// Whether that arc was actually removed. `false` with no `arc` means
    /// there was nothing to remove; `false` *with* one means the discard was
    /// attempted and failed, and `discard_error` says why.
    pub discarded: bool,
    pub discard_error: Option<String>,
}

/// Why a removal could not happen.
#[derive(Debug)]
pub enum RemoveRefusal {
    /// A trip is running: a headless session is working in an inspection tree
    /// against this very tripwire. The one refusal the card states in the
    /// menu item's own label rather than in a dialog.
    TripRunning,
    /// The ledger itself failed, which is not a refusal the caller can act on.
    Ledger(TripwireLedgerError),
}

impl From<TripwireLedgerError> for RemoveRefusal {
    fn from(e: TripwireLedgerError) -> Self {
        match e {
            TripwireLedgerError::TripRunning(_) => RemoveRefusal::TripRunning,
            other => RemoveRefusal::Ledger(other),
        }
    }
}

/// Remove a tripwire, its trip log, and the arc a finished run was holding.
///
/// The dismiss in the middle is the whole reason this is an operation rather
/// than a `DELETE`. An `awaiting` trip holds an arc the user is being asked
/// about and an `adopted` one holds a session they took over; the row
/// cascading away would take the trip with it and leave the worktree standing,
/// which is the leak `tripwire dismiss` exists to close, arriving by another
/// door. So the arc goes through the path that already knows how to discard
/// one, and a tripwire that has nothing live is simply deleted.
///
/// A discard that failed is reported rather than raised, for the same reason
/// it is in a dismissal: the tripwire is removed whatever happened next, and
/// an arc left standing is a fact somebody has to be told.
pub fn remove(
    conn: &Connection,
    tripwire: &Tripwire,
    now_ms: i64,
) -> Result<Removed, RemoveRefusal> {
    if ledger::running_trip(conn, tripwire.id)?.is_some() {
        return Err(RemoveRefusal::TripRunning);
    }
    // `NoLiveTrip` is the ordinary case, not a refusal: most tripwires anybody
    // removes have nothing held at all. Only a ledger failure is worth
    // stopping for.
    let dismissed = match tripwire_dismiss::dismiss(conn, tripwire, now_ms) {
        Ok(dismissed) => Some(dismissed),
        Err(DismissRefusal::NoLiveTrip { .. }) => None,
        Err(DismissRefusal::Ledger(e)) => return Err(RemoveRefusal::Ledger(e)),
    };
    ledger::remove(conn, &tripwire.name)?;
    Ok(Removed {
        arc: dismissed.as_ref().and_then(|d| d.arc.clone()),
        discarded: dismissed.as_ref().is_some_and(|d| d.discarded),
        discard_error: dismissed.as_ref().and_then(|d| d.discard_error.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;
    use tugtool_core::tripwire_ledger::{Claim, NewTripwire, Settlement, TripStatus};

    fn scratch_ledger(dir: &Path) -> Connection {
        ledger::open_ledger(dir.join("tripwires.db")).unwrap()
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

    /// A claimed trip moved to `running`, holding `arc`.
    fn running_trip(conn: &Connection, tripwire: &Tripwire, arc: Option<&str>) -> i64 {
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(conn, tripwire.id, "abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        ledger::record_run(conn, trip_id, Some("sess-1"), arc).unwrap();
        trip_id
    }

    /// An awaiting trip holding `arc`, with `payload` as the evidence the
    /// dismiss reads the repository off.
    fn awaiting_trip(
        conn: &Connection,
        tripwire: &Tripwire,
        arc: Option<&str>,
        payload: Option<&str>,
    ) -> i64 {
        let trip_id = {
            let Claim::Claimed { trip_id } =
                ledger::claim_trip(conn, tripwire.id, "abc", 10, "inst", payload).unwrap()
            else {
                panic!("the claim is uncontested");
            };
            trip_id
        };
        ledger::record_run(conn, trip_id, Some("sess-1"), arc).unwrap();
        ledger::settle(
            conn,
            trip_id,
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("something to look at".to_string()),
                ..Settlement::default()
            },
            20,
        )
        .unwrap();
        trip_id
    }

    fn init_git_repo(path: &Path) {
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .output()
                .unwrap();
        }
        fs::write(path.join(".gitignore"), ".tugtree/\n.tug/\n").unwrap();
        fs::write(path.join("README.md"), "# Test\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-m", "Initial commit"]] {
            Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .output()
                .unwrap();
        }
    }

    /// **A tripwire with nothing live is removed, and its trip log goes with
    /// it.**
    #[test]
    fn a_quiet_tripwire_is_removed_with_its_trips() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());
        let tripwire = lay(&conn, "ci");
        let trip_id = awaiting_trip(&conn, &tripwire, None, None);
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Settled,
            &Settlement::default(),
            25,
        )
        .unwrap();

        let removed = remove(&conn, &tripwire, 30).unwrap();
        assert_eq!(removed.arc, None);
        assert!(!removed.discarded, "there was nothing held to discard");
        assert_eq!(ledger::get(&conn, "ci").unwrap(), None);
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap(),
            None,
            "the trips cascade with the row they hang off"
        );
    }

    /// **A running trip refuses the removal, and nothing moves.**
    ///
    /// The refusal is the point, but so is the second assertion: a headless
    /// session is working in an inspection tree against this tripwire, and a
    /// refusal that had already settled or discarded anything on its way to
    /// saying no would be worse than no guard at all.
    #[test]
    fn a_running_trip_refuses_the_removal_and_leaves_everything_standing() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());
        let tripwire = lay(&conn, "ci");
        let trip_id = running_trip(&conn, &tripwire, Some("tripwire-ci-abcd1234"));

        match remove(&conn, &tripwire, 30) {
            Err(RemoveRefusal::TripRunning) => {}
            other => panic!("a running trip refuses: {other:?}"),
        }
        assert!(ledger::get(&conn, "ci").unwrap().is_some());
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "running",
            "the refusal touched the trip it was protecting"
        );

        // And the ledger's own guard says the same thing on its own, which is
        // what closes the window between the read above and the delete.
        assert!(matches!(
            ledger::remove(&conn, "ci"),
            Err(TripwireLedgerError::TripRunning(n)) if n == "ci"
        ));
        assert!(ledger::get(&conn, "ci").unwrap().is_some());
    }

    /// **An awaiting trip's arc is discarded, and then the tripwire goes.**
    ///
    /// The half that makes this an operation rather than a `DELETE`: the row
    /// cascading away would take the trip with it and leave the worktree
    /// standing, with nothing left in the ledger to say it was ever there.
    #[serial]
    #[test]
    fn an_awaiting_trips_arc_is_discarded_before_the_tripwire_is_removed() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        let root = fs::canonicalize(&repo).unwrap();
        crate::ops::create_in(&root, "tripwire-ci-abcd1234", None, false, None).unwrap();
        assert!(crate::ops::arc_exists_in(&root, "tripwire-ci-abcd1234"));

        let conn = scratch_ledger(temp.path());
        let tripwire = lay(&conn, "ci");
        let payload = serde_json::json!({
            "landing": { "repo_root": root.to_string_lossy() }
        })
        .to_string();
        awaiting_trip(
            &conn,
            &tripwire,
            Some("tripwire-ci-abcd1234"),
            Some(&payload),
        );

        let removed = remove(&conn, &tripwire, 30).unwrap();
        assert_eq!(removed.arc.as_deref(), Some("tripwire-ci-abcd1234"));
        assert!(
            removed.discarded,
            "discard failed: {:?}",
            removed.discard_error
        );
        assert!(
            !crate::ops::arc_exists_in(&root, "tripwire-ci-abcd1234"),
            "the arc the trip was holding is gone from the checkout"
        );
        assert_eq!(ledger::get(&conn, "ci").unwrap(), None);
    }

    /// A name nothing answers to is a refusal the caller can report, not a
    /// silent success.
    #[test]
    fn a_tripwire_that_is_not_there_refuses() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());
        let tripwire = lay(&conn, "ci");
        remove(&conn, &tripwire, 30).unwrap();
        assert!(matches!(
            remove(&conn, &tripwire, 30),
            Err(RemoveRefusal::Ledger(TripwireLedgerError::NoSuchTripwire(n))) if n == "ci"
        ));
    }
}
