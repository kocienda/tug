//! The shared removal: refuse a tripwire that is working, discard the arc a
//! finished run is holding, and delete the row.
//!
//! One spelling for two callers — `tugtool tripwire rm` and the HTTP surface
//! the Tripwires card reaches ([B07]). It lives here rather than in
//! `tugtool-core` because the half that is not a ledger write *is* an arc
//! discard, and `discard_agent_arc_in` is this crate's. `tugarc-core` already
//! depends on `tugtool-core`'s ledger, so the ledger half sits beside the
//! discard with no new edge in the graph.
//!
//! **The order is the design.** A tripwire with a `running` trip is refused
//! before anything is discarded, because a refusal that had already thrown
//! away the tripwire's arc would be the worst of both outcomes: the tripwire
//! is still there and its worktree is not. The ledger's own `NOT EXISTS` guard
//! is the backstop for the race this read cannot close, not a substitute for
//! taking it.

use rusqlite::Connection;
use tugtool_core::tripwire_ledger::{self as ledger, Tripwire, TripwireLedgerError};

/// What a removal did.
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    /// The tripwire's own arc, when its row records a checkout to find it in.
    /// Discarded with the row rather than orphaned by it.
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
    /// A trip is running: a session is working in the tripwire's arc worktree
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

/// Remove a tripwire, its trip log, and the arc it owns.
///
/// **The arc a removal discards is the tripwire's own** ([P02]):
/// `tripwire-<name>` in the checkout the row records, whether or not any trip
/// is live. That is the whole reason this is an operation rather than a
/// `DELETE` — the row cascading away would take every trip with it and leave
/// the worktree standing, with nothing left in the ledger to say it was ever
/// there.
///
/// A discard that failed is reported rather than raised, for the same reason
/// the removal happens at all: the tripwire is gone whatever happened next,
/// and an arc left standing is a fact somebody has to be told.
pub fn remove(conn: &Connection, tripwire: &Tripwire) -> Result<Removed, RemoveRefusal> {
    if ledger::running_trip(conn, tripwire.id)?.is_some() {
        return Err(RemoveRefusal::TripRunning);
    }
    ledger::remove(conn, &tripwire.name)?;
    Ok(discard_the_tripwires_arc(tripwire))
}

/// Take the tripwire's own arc off the machine, and say what happened.
///
/// A row laid before the arc existed records no checkout, so there is nothing
/// to reach for and nothing to report. An arc that is already gone from a
/// checkout that is still there — a person took it — counts as discarded
/// rather than as a failure: the removal wanted it absent and it is absent. A
/// checkout that is *not* there is a different fact, and the discard is
/// attempted so its refusal can say so, because `arc_exists_in` answers
/// `false` to both questions and only one of them is good news.
fn discard_the_tripwires_arc(tripwire: &Tripwire) -> Removed {
    if tripwire.repo_root.is_empty() {
        return Removed {
            arc: None,
            discarded: false,
            discard_error: None,
        };
    }
    let root = std::path::PathBuf::from(&tripwire.repo_root);
    let arc = ledger::tripwire_arc(&tripwire.name);
    if root.is_dir() && !crate::ops::arc_exists_in(&root, &arc) {
        return Removed {
            arc: Some(arc),
            discarded: true,
            discard_error: None,
        };
    }
    match crate::ops::discard_agent_arc_in(&root, &arc, Some("tripwire")) {
        Ok(_) => Removed {
            arc: Some(arc),
            discarded: true,
            discard_error: None,
        },
        Err(e) => Removed {
            arc: Some(arc),
            discarded: false,
            discard_error: Some(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;
    use tugtool_core::tripwire_ledger::{NewTrip, NewTripwire, Settlement, TripStatus};

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
                "Reports anything that looks wrong on main",
            ),
            1,
        )
        .unwrap()
    }

    /// The same, with the home checkout its arc lives in ([P02]).
    fn lay_in(conn: &Connection, name: &str, repo_root: &str) -> Tripwire {
        let mut new = NewTripwire::new(
            name,
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "report anything that looks wrong",
            "Reports anything that looks wrong on main",
        );
        new.repo_root = repo_root.to_string();
        ledger::lay(conn, &new, 1).unwrap()
    }

    /// A `running` trip holding `arc`.
    fn running_trip(conn: &Connection, tripwire: &Tripwire, arc: Option<&str>) -> i64 {
        let trip_id = write_running(conn, tripwire, None);
        ledger::record_run(conn, trip_id, Some("sess-1"), arc).unwrap();
        trip_id
    }

    /// A `running` row, the way the engine writes one.
    fn write_running(conn: &Connection, tripwire: &Tripwire, repo_root: Option<&str>) -> i64 {
        ledger::insert_trip(
            conn,
            &NewTrip {
                tripwire_id: tripwire.id,
                event_key: "fact:i:1".to_string(),
                at_ms: 10,
                instance: "inst".to_string(),
                status: TripStatus::Running,
                reason: None,
                event_payload: None,
                repo_root: repo_root.map(str::to_owned),
            },
        )
        .unwrap()
        .expect("this tripwire has no row for that key yet")
    }

    /// A finished trip naming `arc`, standing in `repo_root` — the column the
    /// removal reads the repository off ([P05]).
    fn finished_trip(
        conn: &Connection,
        tripwire: &Tripwire,
        arc: Option<&str>,
        repo_root: Option<&str>,
    ) -> i64 {
        let trip_id = write_running(conn, tripwire, repo_root);
        ledger::record_run(conn, trip_id, Some("sess-1"), arc).unwrap();
        ledger::settle(
            conn,
            trip_id,
            TripStatus::Done,
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
    fn a_settled_tripwire_is_removed_with_its_trips() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());
        let tripwire = lay(&conn, "ci");
        let trip_id = finished_trip(&conn, &tripwire, None, None);

        let removed = remove(&conn, &tripwire).unwrap();
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

        match remove(&conn, &tripwire) {
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

    /// **The tripwire's own arc is discarded, and then the tripwire goes.**
    ///
    /// The half that makes this an operation rather than a `DELETE`: the row
    /// cascading away would take every trip with it and leave the worktree
    /// standing, with nothing left in the ledger to say it was ever there.
    #[serial]
    #[test]
    fn the_tripwires_arc_is_discarded_before_the_tripwire_is_removed() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        let root = fs::canonicalize(&repo).unwrap();
        crate::ops::create_in(&root, "tripwire-ci", None, false, None).unwrap();
        assert!(crate::ops::arc_exists_in(&root, "tripwire-ci"));

        let conn = scratch_ledger(temp.path());
        let tripwire = lay_in(&conn, "ci", &root.to_string_lossy());
        finished_trip(
            &conn,
            &tripwire,
            Some("tripwire-ci"),
            Some(&root.to_string_lossy()),
        );

        let removed = remove(&conn, &tripwire).unwrap();
        assert_eq!(removed.arc.as_deref(), Some("tripwire-ci"));
        assert!(
            removed.discarded,
            "discard failed: {:?}",
            removed.discard_error
        );
        assert!(
            !crate::ops::arc_exists_in(&root, "tripwire-ci"),
            "the arc the tripwire owned is gone from the checkout"
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
        remove(&conn, &tripwire).unwrap();
        assert!(matches!(
            remove(&conn, &tripwire),
            Err(RemoveRefusal::Ledger(TripwireLedgerError::NoSuchTripwire(n))) if n == "ci"
        ));
    }
}
