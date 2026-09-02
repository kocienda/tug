//! Whose arc is this to judge?
//!
//! The dash-log is shared across every instance over one checkout, so a second
//! `Tug.app` reads a first one's arcs. It cannot get a session snapshot for a
//! seat that lives in the other tugcast's process, and before this module that
//! blindness had exactly one reading: *gone silent*. On 2026-09-02 a debug
//! instance launched by an unrelated test watched a healthy arc for thirty
//! minutes on that reading and then wrote it a durable `Stalled` stop receipt,
//! twenty-seven minutes into an audit that was working.
//!
//! The fix is a name on the seat, and a verdict over it. `arc-owner` records
//! which instance seated the stage; this module decides what a runner may do
//! about an arc it did not seat.
//!
//! **The gate is one verdict, and only one of its four values gates.**
//! `ForeignLive` — somebody else's arc, and that somebody is still running —
//! is the stand-down. `Mine` proceeds because it is this runner's work.
//! `Unowned` proceeds because that is what every pre-owner arc, every
//! standalone launch, and every `cargo`-driven test reads as, and turning
//! those into un-judgeable arcs would be a worse regression than the one this
//! closes. `ForeignDead` proceeds because a crashed tugcast must not orphan an
//! arc forever: somebody has to be able to clock it, and the only instance
//! that could is gone.

/// What this runner may do about one arc, given who owns it.
///
/// Only [`OwnerVerdict::ForeignLive`] gates. The other three proceed exactly
/// as every runner did before ownership existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerVerdict {
    /// This process seated the stage.
    Mine,
    /// No `arc-owner` line in this generation — every runner's to judge.
    Unowned,
    /// Another instance seated it and that instance is still running. The one
    /// value that stands a runner down.
    ForeignLive,
    /// Another instance seated it and that instance is gone.
    ForeignDead,
}

impl OwnerVerdict {
    /// Whether this runner must stand down: no clock, no stop, no receipt.
    pub fn stands_down(self) -> bool {
        matches!(self, OwnerVerdict::ForeignLive)
    }

    /// The word for a log line, so a verdict is greppable after the fact.
    pub fn as_str(self) -> &'static str {
        match self {
            OwnerVerdict::Mine => "mine",
            OwnerVerdict::Unowned => "unowned",
            OwnerVerdict::ForeignLive => "foreign-live",
            OwnerVerdict::ForeignDead => "foreign-dead",
        }
    }
}

/// Judge one arc's ownership.
///
/// Pure: `live` is injected, so a test never shells out to tmux. In production
/// it is [`tugcore::instance::instance_tmux_live`], which asks the owner's own
/// `tug-<token>` tmux server whether its session exists — a probe rather than a
/// lease, because an arc mid-stage writes nothing for minutes and a lease over
/// an append-only per-project file would need a heartbeat to survive that.
///
/// `live` is called **at most once**, and only on the two rows that need it: a
/// `Mine` or `Unowned` arc never probes tmux, which is what keeps the ordinary
/// single-instance tick free of a subprocess.
///
/// A process with no instance id of its own (`this_instance` is `None`) reading
/// a record that names one is foreign, not `Mine`. An unnamed process cannot be
/// the named owner, and guessing the other way is how the false stop happens.
pub fn verdict(
    record_owner: Option<&str>,
    this_instance: Option<&str>,
    live: impl FnOnce(&str) -> bool,
) -> OwnerVerdict {
    let Some(owner) = record_owner else {
        return OwnerVerdict::Unowned;
    };
    if this_instance == Some(owner) {
        return OwnerVerdict::Mine;
    }
    if live(owner) {
        OwnerVerdict::ForeignLive
    } else {
        OwnerVerdict::ForeignDead
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A predicate that fails the test if it is ever consulted. The two rows
    /// that must not probe tmux are asserted with this rather than with a
    /// counter, so the failure names itself.
    fn never_probed(_: &str) -> bool {
        panic!("liveness was probed for an arc that needed no probe");
    }

    #[test]
    fn an_arc_with_no_owner_is_unowned_and_never_probes() {
        assert_eq!(
            verdict(None, Some("release-main"), never_probed),
            OwnerVerdict::Unowned
        );
        // And with no instance id either — the standalone launch, and every
        // `cargo`-driven test in this workspace.
        assert_eq!(verdict(None, None, never_probed), OwnerVerdict::Unowned);
    }

    #[test]
    fn my_own_arc_is_mine_and_never_probes() {
        assert_eq!(
            verdict(Some("release-main"), Some("release-main"), never_probed),
            OwnerVerdict::Mine
        );
    }

    #[test]
    fn another_live_instances_arc_is_the_one_verdict_that_gates() {
        let v = verdict(Some("release-main"), Some("debug-spike"), |owner| {
            assert_eq!(owner, "release-main", "the probe asks about the owner");
            true
        });
        assert_eq!(v, OwnerVerdict::ForeignLive);
        assert!(v.stands_down());
    }

    #[test]
    fn another_dead_instances_arc_is_clocked_like_any_other() {
        // The second failure mode: a crashed tugcast must not orphan an arc
        // forever. Somebody has to be able to stop it, and the only instance
        // that could is the one that is gone.
        let v = verdict(Some("release-main"), Some("debug-spike"), |_| false);
        assert_eq!(v, OwnerVerdict::ForeignDead);
        assert!(!v.stands_down());
    }

    #[test]
    fn an_unnamed_process_reading_a_named_owner_is_foreign() {
        // Not `Mine`. A process with no id cannot be the named owner, and
        // guessing the other way is exactly how the false stop happens.
        assert_eq!(
            verdict(Some("release-main"), None, |_| true),
            OwnerVerdict::ForeignLive
        );
        assert_eq!(
            verdict(Some("release-main"), None, |_| false),
            OwnerVerdict::ForeignDead
        );
    }

    #[test]
    fn only_foreign_live_stands_a_runner_down() {
        assert!(!OwnerVerdict::Mine.stands_down());
        assert!(!OwnerVerdict::Unowned.stands_down());
        assert!(OwnerVerdict::ForeignLive.stands_down());
        assert!(!OwnerVerdict::ForeignDead.stands_down());
    }
}
