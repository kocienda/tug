//! The enforcement half of the session-identity chokepoint ([P01]).
//!
//! Sibling of `ledger_db::no_ad_hoc_ledger_opens` and
//! `instance::no_ad_hoc_data_dir_resolution`, and here for the same reason:
//! `$TUG_SESSION_ID` is frozen in a process's environment at spawn while the
//! Wheel rotates a card's session on purpose, so **every raw read of the
//! variable is a latent bug** — a verb addressing a segment that closed two
//! rotations ago, writing onto a corpse and reporting success.
//!
//! That hazard has now been answered four times, once per caller, and each
//! answer left the next caller exposed: `draft`, `ask`, and `changes claim`
//! survived the round of fixes that closed the `/api/arc` door precisely
//! because nothing structural said they must not. This test is that
//! structure. A new `std::env::var("TUG_SESSION_ID")` fails the build until
//! it is either routed through `tugtool::session_identity` or added below
//! with a reason.

/// Files allowed to name `TUG_SESSION_ID` in a `std::env::var` read, and why.
///
/// Every entry is a **read that already answers for the line** rather than
/// for the segment it was handed — which is the property the chokepoint
/// exists to guarantee, reached locally before the chokepoint existed. They
/// are counted, not whole-file-skipped, so a second read added to one of
/// these files is still caught.
#[cfg(test)]
const ALLOWED_READS: &[(&str, usize, &str)] = &[
    (
        "tugtool/src/session_identity.rs",
        1,
        "the chokepoint itself — the one read every verb goes through",
    ),
    (
        "tugarc-core/src/ops.rs",
        1,
        "`session_citation_for`'s fallback, whose citation resolves the id to \
         its line before writing a trailer ([P13])",
    ),
    (
        "tugchanges-core/src/changes.rs",
        1,
        "`resolve_changes`'s `--session` default, expanded to the whole line \
         by `line_segments` on the next statement",
    ),
];

/// The spawn-time exporters: the processes that *set* the variable for a
/// child. They are the origin of every frozen id, and nothing about them is
/// stale — a card's session is exactly what it is at the moment it spawns.
#[cfg(test)]
const ALLOWED_EXPORTERS: &[&str] = &[
    "tugcast/src/feeds/agent_bridge.rs",
    "tugcast/src/feeds/shell.rs",
];

#[cfg(test)]
mod tests {
    use super::{ALLOWED_EXPORTERS, ALLOWED_READS};

    /// No production source may read `$TUG_SESSION_ID` outside the resolver.
    #[test]
    fn no_raw_session_id_reads() {
        let crates_root = crate::source_scan::crates_root();
        let mut offenders = Vec::new();
        // A scan that matches nothing passes vacuously. Each allowlisted
        // entry must still be *there*, or the list is describing a workspace
        // that no longer exists and the guard is guarding nothing.
        let mut found: Vec<&str> = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            let rel = path
                .strip_prefix(&crates_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            // The scan's own home: it quotes the pattern it looks for, which
            // is not a read of anything.
            if rel == "tugcore/src/session_identity_scan.rs" {
                continue;
            }
            // `std::env::var("TUG_SESSION_ID")` and the `env::var` spelling
            // that a `use std::env` makes available — both are the same read.
            let reads = production.matches("var(\"TUG_SESSION_ID\")").count()
                + production.matches("var_os(\"TUG_SESSION_ID\")").count();
            let allowed = ALLOWED_READS
                .iter()
                .find(|(file, _, _)| *file == rel)
                .map(|(_, count, _)| *count)
                .unwrap_or(0);
            if reads > allowed {
                offenders.push(format!("{rel} ({reads} read(s), {allowed} allowed)"));
            }
            if reads > 0 && allowed > 0 {
                found.push(
                    ALLOWED_READS
                        .iter()
                        .find(|(file, _, _)| *file == rel)
                        .map(|(file, _, _)| *file)
                        .expect("allowlisted"),
                );
            }
        }
        assert!(
            offenders.is_empty(),
            "raw `$TUG_SESSION_ID` reads outside `tugtool::session_identity` — the id is frozen \
             at spawn and the Wheel rotates a card's session on purpose, so a raw read addresses \
             whichever segment happened to be seated when the process started. Route these \
             through the resolver, or add the file to `ALLOWED_READS` with the reason it is \
             already line-aware: {offenders:#?}"
        );
        for (file, _, _) in ALLOWED_READS {
            assert!(
                found.contains(file),
                "{file} is allowlisted but reads nothing — drop the entry rather than leaving \
                 the guard describing a workspace that has moved on"
            );
        }
    }

    /// The exporters exist, spelled the way the allowlist spells them.
    ///
    /// An allowlist whose entries have been renamed out from under it is a
    /// guard that has quietly stopped guarding, and the spawn-time exporters
    /// are the one shape the scan above deliberately cannot see (they `.env(…)`
    /// rather than `var(…)`). This keeps the note honest.
    #[test]
    fn the_spawn_time_exporters_still_export() {
        let crates_root = crate::source_scan::crates_root();
        for file in ALLOWED_EXPORTERS {
            let text = std::fs::read_to_string(crates_root.join(file))
                .unwrap_or_else(|e| panic!("{file} is named as a spawn-time exporter: {e}"));
            assert!(
                text.contains("\"TUG_SESSION_ID\""),
                "{file} no longer names TUG_SESSION_ID — the exporter allowlist is stale"
            );
        }
    }
}
