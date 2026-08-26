//! The `tug-quiesce` shutdown contract — one ladder, one set of numbers.
//!
//! Every Tug **service** (tugcast, tugcode, tugpulse; Tug.app as the
//! shutdown supervisor) shuts down the same way:
//!
//! 1. **Quiesce request** — the parent asks the child to stop: an explicit
//!    `shutdown` message where a control channel exists, `SIGTERM`
//!    otherwise. Both funnel into the same shutdown path.
//! 2. **Flush window** — the service stops accepting work, flushes its
//!    ledgers (final `wal_checkpoint(TRUNCATE)`), fsyncs journals, closes
//!    its SQLite connections, and exits 0 — within
//!    [`FLUSH_BUDGET_MS`], which it enforces on *itself*: a hung flush
//!    must never wedge shutdown, so the budget expiring means exit
//!    anyway, loudly.
//! 3. **Escalation** — the supervisor waits [`DRAIN_DEADLINE_MS`] for the
//!    group to drain, then `SIGKILL`s the remainder and records which
//!    PIDs needed it. A SIGKILL that actually fires is a defect signal
//!    ([`QUIESCE_REPORT_FILENAME`]), not routine housekeeping.
//!
//! These constants are the source of truth. Swift mirrors them in
//! `tugapp/Sources/InstanceConfig.swift` and TypeScript in
//! `tests/app-test/_harness/index.ts` and `tugcode/src/main.ts`; the
//! `quiesce_constants_are_mirrored` test below fails the build when a
//! mirror drifts.

use std::path::PathBuf;

/// How long one service gets to flush and exit after a quiesce request,
/// enforced by the service on itself.
pub const FLUSH_BUDGET_MS: u64 = 2_000;

/// How long the shutdown supervisor waits for a service group to drain before it
/// escalates to `SIGKILL`. Twice the per-service budget, so a service
/// that spends its whole budget still exits on its own terms.
pub const DRAIN_DEADLINE_MS: u64 = 4_000;

/// Grace between `SIGTERM` and `SIGKILL` when reclaiming a *stale
/// same-instance* process (a zombie self holding our port). Short: the
/// process being reclaimed is already known to be unresponsive.
pub const STALE_RECLAIM_GRACE_MS: u64 = 1_000;

/// Outer bound an external supervisor (the app-test harness) gives a
/// whole Tug.app teardown: the supervisor's own deadline plus room for
/// the app's save-flush and the OS teardown around it.
pub const TEARDOWN_DEADLINE_MS: u64 = 8_000;

/// Filename of the per-instance quiesce report the supervisor writes on
/// every shutdown, in [`crate::instance::data_dir`]. Its `sigkills`
/// array is the defect signal: steady state is empty.
pub const QUIESCE_REPORT_FILENAME: &str = "quiesce-report.json";

/// Absolute path of this instance's quiesce report.
pub fn report_path() -> PathBuf {
    crate::instance::data_dir().join(QUIESCE_REPORT_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mirrors must carry the same numbers as this module. Each
    /// entry is (file, the exact line that must appear).
    #[test]
    fn quiesce_constants_are_mirrored() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("repo root")
            .to_path_buf();
        let expected: &[(&str, String)] = &[
            (
                "tugapp/Sources/InstanceConfig.swift",
                format!(
                    "static let quiesceDrainDeadline: TimeInterval = {:.1}",
                    DRAIN_DEADLINE_MS as f64 / 1000.0
                ),
            ),
            (
                "tugapp/Sources/InstanceConfig.swift",
                format!(
                    "static let quiesceStaleReclaimGrace: TimeInterval = {:.1}",
                    STALE_RECLAIM_GRACE_MS as f64 / 1000.0
                ),
            ),
            (
                "tugapp/Sources/InstanceConfig.swift",
                format!("static let quiesceReportName = \"{QUIESCE_REPORT_FILENAME}\""),
            ),
            (
                "tugcode/src/main.ts",
                format!("const QUIESCE_FLUSH_BUDGET_MS = {FLUSH_BUDGET_MS};"),
            ),
            (
                "tests/app-test/_harness/index.ts",
                format!("const QUIESCE_TEARDOWN_DEADLINE_MS = {TEARDOWN_DEADLINE_MS};"),
            ),
            (
                "tests/app-test/_harness/index.ts",
                format!("export const QUIESCE_DRAIN_DEADLINE_MS = {DRAIN_DEADLINE_MS};"),
            ),
            (
                "tests/app-test/_harness/index.ts",
                format!("export const QUIESCE_REPORT_NAME = \"{QUIESCE_REPORT_FILENAME}\";"),
            ),
        ];
        for (file, line) in expected {
            let path = repo.join(file);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read mirror {}: {e}", path.display()));
            assert!(
                text.contains(line.as_str()),
                "{file} has drifted from tugcore::quiesce — expected to find:\n  {line}"
            );
        }
    }
}
