//! The kinds of fact the session ledger records — the one list every crate
//! that names a kind reads.
//!
//! The recorder in `tugcast` writes these strings into `facts.kind`; the
//! tripwire verbs in `tugtool` refuse a `--on fact:<kind>` that is not one of
//! them. Both sit on this enum so a kind cannot be recorded under one spelling
//! and watched under another, and so the set of things a tripwire can watch is
//! exactly the set of things the ledger writes — never wider, never a guess.
//! A new kind is added here first, and the recorder and the lay verb learn it
//! together.

/// Every kind of fact the ledger records. The `as_str` spelling is what lands
/// in `facts.kind`, what the Operator's `kind=` filter matches, and what a
/// tripwire's trigger names, so it is wire-stable — rename a variant freely,
/// never its string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactKind {
    Prompt,
    SessionSpawned,
    SessionResumed,
    SessionClosed,
    SessionErrored,
    SessionReset,
    SessionRenamed,
    SessionCompacted,
    Commit,
    Shell,
    TestRun,
    EditFailed,
}

impl FactKind {
    /// Every kind, in the order a reader sees them listed. This is the list a
    /// refusal prints, so it is the whole vocabulary and nothing is held back.
    pub const ALL: [FactKind; 12] = [
        FactKind::Prompt,
        FactKind::Shell,
        FactKind::TestRun,
        FactKind::EditFailed,
        FactKind::Commit,
        FactKind::SessionSpawned,
        FactKind::SessionResumed,
        FactKind::SessionClosed,
        FactKind::SessionErrored,
        FactKind::SessionReset,
        FactKind::SessionRenamed,
        FactKind::SessionCompacted,
    ];

    /// The exact inverse of [`FactKind::as_str`] — what turns a stored `kind`
    /// string back into the variant a projection dispatches on. An
    /// unrecognized string is `None`: a row written by a newer build is a row
    /// this one renders without depth, never an error.
    pub fn parse(s: &str) -> Option<FactKind> {
        FactKind::ALL.into_iter().find(|kind| kind.as_str() == s)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            FactKind::Prompt => "prompt",
            FactKind::SessionSpawned => "session.spawned",
            FactKind::SessionResumed => "session.resumed",
            FactKind::SessionClosed => "session.closed",
            FactKind::SessionErrored => "session.errored",
            FactKind::SessionReset => "session.reset",
            FactKind::SessionRenamed => "session.renamed",
            FactKind::SessionCompacted => "session.compacted",
            FactKind::Commit => "commit",
            FactKind::Shell => "shell",
            FactKind::TestRun => "test_run",
            FactKind::EditFailed => "edit_failed",
        }
    }

    /// The vocabulary as a refusal says it: every kind, comma-separated.
    pub fn all_spelled() -> String {
        FactKind::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips_through_its_string() {
        for kind in FactKind::ALL {
            assert_eq!(FactKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(FactKind::parse("not_a_kind"), None);
    }

    #[test]
    fn all_lists_each_kind_exactly_once() {
        let mut seen = std::collections::BTreeSet::new();
        for kind in FactKind::ALL {
            assert!(seen.insert(kind.as_str()), "{} listed twice", kind.as_str());
        }
        assert_eq!(seen.len(), FactKind::ALL.len());
    }
}
