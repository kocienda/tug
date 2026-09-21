//! The enforcement half of "a CLI test never runs as the developer's session".
//!
//! Sibling of `session_identity_scan::no_raw_session_id_reads` and
//! `ledger_db::no_ad_hoc_ledger_opens`, and closing the same class from the
//! side those two cannot see. Those guards stop *production* code reaching
//! past a chokepoint. This one stops a *test* handing a real binary the
//! developer's live environment.
//!
//! The incident: a CLI test file ran `tugtool arc create` in a temp repo
//! with neither `TUG_SESSION_ID` nor the instance registry scrubbed. On a
//! machine where the suite runs from inside a Session card — which is most of
//! them — the spawned binary reached the *real* registry and posted a bind
//! naming a scratch arc in a directory that would be gone a second later.
//! That is precisely the hazard `arc_api::bind`'s same-project guard was
//! added for, met from the one side the guard cannot inspect.
//!
//! It was fixed by hand, in one file. Two other CLI test files had reached the
//! same conclusion independently, and the remaining eight had never been
//! asked — which is the shape every incident in this class has had: answered
//! per-caller, with nothing saying the next caller must answer too.
//!
//! So the answer is a chokepoint rather than a habit. `crates/tugtool/tests/
//! common/mod.rs` is the one file allowed to name the binary, its `tugtool()`
//! scrubs, and every other test file spawns through it. A new CLI test cannot
//! reach the binary without going past the scrub, and this test is what says
//! so.

/// The spellings that name a Tug binary for spawning, in any test file.
///
/// Both forms of "where is the built binary" are here: `assert_cmd`'s
/// `cargo_bin` lookup and cargo's own `CARGO_BIN_EXE_*` env var. A file that
/// contains either is reaching for the binary directly.
#[cfg(test)]
const SPAWN_SPELLINGS: &[&str] = &[
    "cargo_bin(\"tugtool\")",
    "cargo_bin(\"tugedit\")",
    "CARGO_BIN_EXE_tugtool",
    "CARGO_BIN_EXE_tugedit",
];

/// The one test file allowed to name a binary — the chokepoint itself.
#[cfg(test)]
const CHOKEPOINT: &str = "tugtool/tests/common/mod.rs";

/// The scrubs the chokepoint must perform, because a chokepoint that has
/// stopped scrubbing is worse than no chokepoint: every caller now believes
/// it is covered.
#[cfg(test)]
const REQUIRED_SCRUBS: &[&str] = &[
    "env_remove(\"TUG_SESSION_ID\")",
    "env_remove(\"TUG_INSTANCE_ID\")",
    // The machine-global session index: an unscrubbed spawn writes rows
    // into the user's real one, which every other instance then answers
    // `elsewhere` about.
    "env_remove(\"TUG_SESSION_INDEX_DB\")",
];

/// Test files allowed to name a binary outside the chokepoint, and why.
///
/// Empty, deliberately. An entry here is a test that *wants* the developer's
/// live session; none has ever been needed, and if one is, the reason belongs
/// written out beside it.
#[cfg(test)]
const ALLOWED_DIRECT: &[(&str, &str)] = &[];

#[cfg(test)]
mod tests {
    use super::{ALLOWED_DIRECT, CHOKEPOINT, REQUIRED_SCRUBS, SPAWN_SPELLINGS};

    /// No CLI test may reach the binary except through the scrubbing helper.
    #[test]
    fn no_cli_test_spawns_tugtool_outside_the_chokepoint() {
        let crates_root = crate::source_scan::crates_root();
        let mut offenders = Vec::new();
        let mut chokepoint_seen = false;
        for (path, text) in crate::source_scan::integration_test_sources() {
            let rel = path
                .strip_prefix(&crates_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            let names: usize = SPAWN_SPELLINGS
                .iter()
                .map(|s| text.matches(s).count())
                .sum();
            if names == 0 {
                continue;
            }
            if rel == CHOKEPOINT {
                chokepoint_seen = true;
                continue;
            }
            if ALLOWED_DIRECT.iter().any(|(file, _)| *file == rel) {
                continue;
            }
            offenders.push(format!("{rel} ({names} site(s))"));
        }
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "a CLI test spawns a real binary, and a binary spawned with the ambient environment \
             intact runs as the developer's own session — where it can claim, bind, or attribute \
             against a scratch repo that will not exist in a second. Spawn through the scrubbing \
             helper instead:\n\n    mod common;\n    use common::tugtool;\n\n    \
             let out = tugtool().args([…]).output().unwrap();\n\n\
             Offending files: {offenders:#?}"
        );
        assert!(
            chokepoint_seen,
            "{CHOKEPOINT} names no binary — the chokepoint has moved or been renamed, and this \
             guard is guarding a workspace that no longer exists"
        );
    }

    /// The chokepoint still scrubs.
    #[test]
    fn the_chokepoint_scrubs_the_session_env() {
        let text = std::fs::read_to_string(crate::source_scan::crates_root().join(CHOKEPOINT))
            .unwrap_or_else(|e| panic!("{CHOKEPOINT} is the CLI-test spawn chokepoint: {e}"));
        for scrub in REQUIRED_SCRUBS {
            assert!(
                text.contains(scrub),
                "{CHOKEPOINT} no longer calls `{scrub}` — every CLI test spawns through it \
                 believing it does"
            );
        }
    }

    /// Every allowlisted exception exists and still names a binary, so the
    /// list cannot quietly describe a workspace that has moved on.
    #[test]
    fn the_direct_spawn_allowlist_is_not_stale() {
        let crates_root = crate::source_scan::crates_root();
        for (file, reason) in ALLOWED_DIRECT {
            let text = std::fs::read_to_string(crates_root.join(file))
                .unwrap_or_else(|e| panic!("{file} is allowlisted ({reason}) but unreadable: {e}"));
            assert!(
                SPAWN_SPELLINGS.iter().any(|s| text.contains(s)),
                "{file} is allowlisted as a direct spawner ({reason}) but names no binary — \
                 drop the entry"
            );
        }
    }
}
