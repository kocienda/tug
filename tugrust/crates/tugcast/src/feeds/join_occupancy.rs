//! One dash admits one run (Spec S01).
//!
//! Every act that touches a dash's workshop — a resolve, a verification, a
//! non-preview join — takes the dash first, and is refused by name while
//! somebody else holds it. Before this, two of them could share one worktree:
//! a second resolve `reset --hard`ing under the first one's live resolver, a
//! verification resetting the tree a resolve was mid-edit in, a join tearing
//! the workshop down and a straggling task creating it again as an orphan.
//!
//! **In memory, deliberately.** An on-disk lock would need staleness detection
//! — who holds this, are they alive, when may it be broken — which is exactly
//! the reasoning the rest of this round removes from the durable facts.
//! In-process state has the opposite property: a tugcast restart releases every
//! hold by construction, and a restart is also the only event that can orphan a
//! run, so the two invalidate together.
//!
//! The registry is process-global rather than a supervisor field for one
//! reason: the join board reads it, and the board is a cache with no route back
//! to the supervisor. Occupancy is not cacheable — it is the one thing on the
//! wire that is true only right now.
//!
//! **This is the fast path, not the whole answer.** A second *process* — a
//! `tugutil dash join`, `discard`, or `join --resolve` — has no registry to
//! ask, and reads liveness off the conflict chain instead:
//! `tugdash_core::resolve::resolve_lease` ([D160]). The two compose rather than
//! compete: a run this process holds suppresses the lease, because the exact
//! answer beats the derived one wherever it exists.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// What is holding a dash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinRunKind {
    Resolve,
    Join,
}

impl JoinRunKind {
    /// The wire spelling, which is also the word the refusal uses.
    pub fn as_str(self) -> &'static str {
        match self {
            JoinRunKind::Resolve => "resolve",
            JoinRunKind::Join => "join",
        }
    }
}

/// One live run.
#[derive(Debug, Clone)]
struct JoinRun {
    kind: JoinRunKind,
    /// The dash head this run started against.
    ///
    /// A question raised mid-run is matched against this rather than against
    /// the head as it stands, so a commit landing on the dash while the
    /// resolver waits does not vanish the wizard the user is looking at.
    head: Option<String>,
}

fn registry() -> &'static Mutex<HashMap<String, JoinRun>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, JoinRun>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A held dash. Dropping it releases the hold — including on a panic, which is
/// why this is a guard and not a pair of calls.
#[derive(Debug)]
pub struct JoinOccupancy {
    owner_key: String,
}

impl Drop for JoinOccupancy {
    fn drop(&mut self) {
        registry()
            .lock()
            .expect("join occupancy mutex")
            .remove(&self.owner_key);
    }
}

/// Take the dash for a run, or say who has it.
///
/// The refusal is a sentence rather than a boolean because it is shown: a
/// second Resolve press has to explain why nothing happened, and "a resolve is
/// already running for this dash" is the whole explanation ([L31]).
pub fn acquire(
    owner_key: &str,
    kind: JoinRunKind,
    head: Option<String>,
) -> Result<JoinOccupancy, String> {
    let mut map = registry().lock().expect("join occupancy mutex");
    if let Some(live) = map.get(owner_key) {
        return Err(format!(
            "a {} is already running for this dash",
            live.kind.as_str()
        ));
    }
    map.insert(owner_key.to_string(), JoinRun { kind, head });
    Ok(JoinOccupancy {
        owner_key: owner_key.to_string(),
    })
}

/// What kind of run holds this dash, if any — the `run` fact on the wire.
pub fn run_kind(owner_key: &str) -> Option<&'static str> {
    registry()
        .lock()
        .expect("join occupancy mutex")
        .get(owner_key)
        .map(|run| run.kind.as_str())
}

/// The dash head a live run started against, for matching facts it raised.
pub fn run_head(owner_key: &str) -> Option<String> {
    registry()
        .lock()
        .expect("join occupancy mutex")
        .get(owner_key)
        .and_then(|run| run.head.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keys are per-test so the process-global registry cannot make one test's
    /// hold another's refusal.
    fn key(what: &str) -> String {
        format!("tugdash/{what}#occupancy-test")
    }

    #[test]
    fn a_second_run_is_refused_by_name_and_admitted_after_the_first_ends() {
        let k = key("second-run");
        let held = acquire(&k, JoinRunKind::Resolve, None).expect("the dash is free");
        assert_eq!(run_kind(&k), Some("resolve"));

        let refused = acquire(&k, JoinRunKind::Join, None).expect_err("the dash is held");
        assert_eq!(refused, "a resolve is already running for this dash");

        drop(held);
        assert_eq!(run_kind(&k), None);
        acquire(&k, JoinRunKind::Join, None).expect("the dash is free again");
    }

    /// Two dashes are two holds — the registry gates a dash, not the machine.
    #[test]
    fn holding_one_dash_does_not_hold_another() {
        let a = acquire(&key("alpha"), JoinRunKind::Resolve, None).expect("free");
        let b = acquire(&key("beta"), JoinRunKind::Resolve, None).expect("free");
        drop((a, b));
    }

    /// A run that panics releases its hold.
    ///
    /// Driven through a spawned task because that is the shape a resolve
    /// actually has: the guard travels into a detached task, and a task that
    /// dies mid-flight must not leave the dash refusing every later run.
    #[tokio::test]
    async fn a_panicking_run_releases_the_dash() {
        let k = key("panic");
        let held = acquire(&k, JoinRunKind::Resolve, None).expect("free");
        let died = tokio::spawn(async move {
            let _held = held;
            panic!("the run died mid-flight");
        });
        assert!(died.await.is_err(), "the task panicked");
        assert_eq!(run_kind(&k), None, "the guard released on unwind");
    }
}
