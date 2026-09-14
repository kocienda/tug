//! The shared dismiss: settle a tripwire's live trip and discard the arc it
//! was holding.
//!
//! One spelling for two callers — `tugtool tripwire dismiss` and the HTTP
//! surface the Tripwires card reaches. It lives here rather than in
//! `tugtool-core` because the destructive half *is* an arc discard: the
//! settle without the discard is exactly the leak the verb exists to close,
//! and `discard_agent_arc_in` is this crate's. `tugarc-core` already depends
//! on `tugtool-core`'s ledger, so the ledger half sits beside the discard with
//! no new edge in the graph — the reverse would need one, which is why the
//! ledger's own crate is not the home.

use rusqlite::Connection;
use tugtool_core::tripwire_ledger::{
    self as ledger, Resolution, Settlement, TripStatus, Tripwire, TripwireLedgerError,
};

/// What a dismissal did.
#[derive(Debug, Clone, PartialEq)]
pub struct Dismissed {
    pub trip_id: i64,
    /// The arc the dismissed trip was holding, when it held one.
    pub arc: Option<String>,
    /// Whether that arc was actually removed. `false` with no `arc` means
    /// there was nothing to remove; `false` *with* one means the discard was
    /// attempted and failed, and `discard_error` says why.
    pub discarded: bool,
    pub discard_error: Option<String>,
}

/// Why a dismissal could not happen.
#[derive(Debug)]
pub enum DismissRefusal {
    /// Neither an awaiting nor an adopted trip. `state` is the newest trip's
    /// status, or `None` when the tripwire has never fired — a caller told
    /// only "refused" cannot tell a tripwire that already settled from one
    /// that never fired, and those want different words.
    NoLiveTrip { state: Option<String> },
    /// The ledger itself failed, which is not a refusal the caller can act on.
    Ledger(TripwireLedgerError),
}

impl From<TripwireLedgerError> for DismissRefusal {
    fn from(e: TripwireLedgerError) -> Self {
        DismissRefusal::Ledger(e)
    }
}

/// Settle the tripwire's awaiting trip — or, failing that, its adopted one —
/// and discard the arc it was holding ([P07], [P09]).
///
/// The awaiting trip first, for the same reason `resolve` tries running first:
/// a hold the user is being shown outranks an older adopted trip. Dismissing
/// an adopted one is their door out of a session they took over and no longer
/// want held ([B10]).
///
/// A discard that failed is reported rather than raised: the settle is written
/// whatever happened next, and an arc left standing is the leak this verb
/// exists to close — silence about it is how nobody finds out.
pub fn dismiss(
    conn: &Connection,
    tripwire: &Tripwire,
    now_ms: i64,
) -> Result<Dismissed, DismissRefusal> {
    let mut resolution = ledger::resolve_awaiting(conn, tripwire.id, now_ms)?;
    if matches!(resolution, Resolution::NoLiveTrip { .. }) {
        let settlement = Settlement {
            headline: Some("dismissed".to_string()),
            ..Settlement::default()
        };
        resolution = ledger::resolve_adopted(
            conn,
            tripwire.id,
            TripStatus::Settled,
            &settlement,
            None,
            now_ms,
        )?;
    }
    let Resolution::Resolved { trip_id, arc } = resolution else {
        let Resolution::NoLiveTrip { state } = resolution else {
            unreachable!("a resolution is one of two things")
        };
        return Err(DismissRefusal::NoLiveTrip { state });
    };

    let discarded = arc
        .as_deref()
        .map(|arc| discard_tripwire_arc(conn, tripwire, trip_id, arc));
    let discard_error = match &discarded {
        Some(Err(e)) => Some(e.clone()),
        _ => None,
    };
    Ok(Dismissed {
        trip_id,
        arc,
        discarded: matches!(discarded, Some(Ok(()))),
        discard_error,
    })
}

/// Remove a dismissed trip's arc, handing nothing back to the base checkout
/// ([P09]).
///
/// Addressed by the **landing's** repository rather than by the tripwire's scope,
/// because that is where the engine cut the arc: a scope is a path prefix a
/// tripwire is confined to, which may be an ancestor of the checkout or absent
/// altogether, and an unscoped tripwire's arc is still an arc. The scope is the
/// fallback for a trip whose row carries no landing — a hand-fired one.
fn discard_tripwire_arc(
    conn: &Connection,
    tripwire: &Tripwire,
    trip_id: i64,
    arc: &str,
) -> Result<(), String> {
    let root = landing_repo_root(conn, trip_id)
        .or_else(|| tripwire.scope.clone())
        .ok_or_else(|| {
            format!(
                "the trip names no repository and tripwire {} has no scope, so there is no \
                 checkout to remove `{arc}` from",
                tripwire.name
            )
        })?;
    crate::ops::discard_agent_arc_in(std::path::Path::new(&root), arc, Some("tripwire")).map(|_| ())
}

/// The repository a trip's landing happened in, read off the evidence the row
/// carries — the same place the engine reads it from when it sweeps.
fn landing_repo_root(conn: &Connection, trip_id: i64) -> Option<String> {
    let payload = ledger::trip(conn, trip_id).ok().flatten()?.event_payload?;
    let value: serde_json::Value = serde_json::from_str(&payload).ok()?;
    value
        .get("landing")?
        .get("repo_root")?
        .as_str()
        .filter(|root| !root.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;
    use tugtool_core::tripwire_ledger::{Claim, NewTripwire, TripStatus};

    fn scratch_ledger(dir: &Path) -> Connection {
        ledger::open_ledger(dir.join("tripwires.db")).unwrap()
    }

    fn lay(conn: &Connection, name: &str, scope: Option<&str>) -> Tripwire {
        let mut new = NewTripwire::new(
            name,
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "report anything that looks wrong",
            "main",
            "Reports anything that looks wrong on main",
        );
        new.scope = scope.map(str::to_owned);
        ledger::lay(conn, &new, 1).unwrap()
    }

    /// An awaiting trip holding `arc`, with `payload` as the evidence the
    /// dismiss reads the repository off.
    fn awaiting_trip(
        conn: &Connection,
        tripwire: &Tripwire,
        arc: Option<&str>,
        payload: Option<&str>,
    ) -> i64 {
        let Claim::Claimed { trip_id } =
            ledger::claim_trip(conn, tripwire.id, "abc", 10, "inst", payload).unwrap()
        else {
            panic!("the claim is uncontested");
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

    #[test]
    fn an_awaiting_trip_holding_no_arc_settles_with_nothing_to_discard() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());
        let tripwire = lay(&conn, "ci", None);
        let trip_id = awaiting_trip(&conn, &tripwire, None, None);

        let dismissed = dismiss(&conn, &tripwire, 30).unwrap();
        assert_eq!(dismissed.trip_id, trip_id);
        assert_eq!(dismissed.arc, None);
        assert!(!dismissed.discarded, "there was no arc to discard");
        assert_eq!(dismissed.discard_error, None);
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "settled",
            "the row is settled whether or not an arc came with it"
        );
    }

    /// The half that makes this verb more than a settle: the arc the user was
    /// being asked about is gone from the checkout too.
    #[serial]
    #[test]
    fn an_awaiting_trip_holding_a_real_arc_settles_and_removes_the_worktree() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        let root = fs::canonicalize(&repo).unwrap();
        crate::ops::create_in(&root, "tripwire-ci-abcd1234", None, false, None).unwrap();
        assert!(crate::ops::arc_exists_in(&root, "tripwire-ci-abcd1234"));

        let conn = scratch_ledger(temp.path());
        let tripwire = lay(&conn, "ci", None);
        let payload = serde_json::json!({
            "landing": { "repo_root": root.to_string_lossy() }
        })
        .to_string();
        let trip_id = awaiting_trip(
            &conn,
            &tripwire,
            Some("tripwire-ci-abcd1234"),
            Some(&payload),
        );

        let dismissed = dismiss(&conn, &tripwire, 30).unwrap();
        assert_eq!(dismissed.arc.as_deref(), Some("tripwire-ci-abcd1234"));
        assert!(
            dismissed.discarded,
            "discard failed: {:?}",
            dismissed.discard_error
        );
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "settled"
        );
        assert!(
            !crate::ops::arc_exists_in(&root, "tripwire-ci-abcd1234"),
            "the arc the trip was holding is gone from the checkout"
        );
    }

    /// The two refusals a caller has to be able to tell apart: a tripwire that
    /// already settled names the state it settled to, and one that never fired
    /// names none.
    #[test]
    fn a_tripwire_with_no_live_trip_refuses_with_the_state_it_is_in() {
        let dir = TempDir::new().unwrap();
        let conn = scratch_ledger(dir.path());

        let never = lay(&conn, "never", None);
        match dismiss(&conn, &never, 30) {
            Err(DismissRefusal::NoLiveTrip { state }) => assert_eq!(state, None),
            other => panic!("a tripwire that never fired refuses with no state: {other:?}"),
        }

        let settled = lay(&conn, "settled", None);
        let trip_id = awaiting_trip(&conn, &settled, None, None);
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Settled,
            &Settlement::default(),
            25,
        )
        .unwrap();
        match dismiss(&conn, &settled, 30) {
            Err(DismissRefusal::NoLiveTrip { state }) => {
                assert_eq!(state.as_deref(), Some("settled"))
            }
            other => panic!("an already-settled tripwire names its state: {other:?}"),
        }
    }
}
