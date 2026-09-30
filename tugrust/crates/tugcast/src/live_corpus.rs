//! Test support for the parity contracts that run against the user's **live**
//! session corpus (`~/.claude/projects/<encoded-cwd>/`).
//!
//! Those contracts compare two readings of the same files — tugcode's, taken
//! by a subprocess, and the Rust engine's, taken moments later. The corpus is
//! not frozen: a session running while the suite runs grows between the two
//! readings, and the extra records read as a divergence that no code change
//! caused and no code change can fix. A green suite must not depend on the
//! user having no session open.
//!
//! `StillFiles` stamps the directory before the subprocess runs and re-stamps
//! each file after it is read. A file whose mtime moved was in flight; only a
//! still file is a fair comparison. Every live-corpus contract goes through
//! here so the guard cannot be forgotten in a new one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The user's real local session corpus for this checkout.
///
/// Derived, never written down: Claude Code names a project directory after
/// the checkout's own path with every non-alphanumeric byte turned into `-`,
/// so the path is computed from `CARGO_MANIFEST_DIR` rather than hardcoded.
/// A hardcoded one goes stale the moment the checkout is renamed or the
/// contract runs from an arc worktree, and a stale path is a gate that
/// silently compares nothing.
pub fn reference_corpus_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let checkout = std::fs::canonicalize(&checkout).unwrap_or(checkout);
    PathBuf::from(home)
        .join(".claude/projects")
        .join(encode_project_dir(&checkout))
}

/// Claude Code's project-directory encoding: every byte that is not
/// alphanumeric becomes `-`, so `/Users/me/src/tug` is `-Users-me-src-tug`.
fn encode_project_dir(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// True when `dir` holds at least one session JSONL. A corpus directory can
/// outlive its sessions — a renamed checkout leaves the old one behind with
/// only `memory/` in it — and an empty corpus is nothing to compare against,
/// so every contract treats it exactly as it treats an absent one.
pub fn corpus_has_sessions(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
}

/// The bun-compiled `tugcode` binary — the other side of every parity
/// contract. `TUGCODE_BIN` overrides; else the workspace `target/debug`.
pub fn tugcode_bin() -> PathBuf {
    if let Ok(p) = std::env::var("TUGCODE_BIN") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tugcode")
}

/// A pre-run stamp of every file in a corpus directory.
pub struct StillFiles {
    stamps: HashMap<PathBuf, Option<SystemTime>>,
    skipped: usize,
}

impl StillFiles {
    /// Stamp `dir` now — call this *before* spawning tugcode.
    pub fn stamp(dir: &Path) -> Self {
        let stamps = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| {
                let path = e.path();
                let t = mtime(&path);
                (path, t)
            })
            .collect();
        Self { stamps, skipped: 0 }
    }

    /// True when `path` has not moved since the stamp. A file that did move
    /// was written during the run; it counts toward [`Self::skipped`] and
    /// the caller drops it from the comparison.
    pub fn still(&mut self, path: &Path) -> bool {
        if self.stamps.get(path).copied().flatten() == mtime(path) {
            return true;
        }
        self.skipped += 1;
        false
    }

    /// How many files were written during the run, so a skip is never silent.
    pub fn skipped(&self) -> usize {
        self.skipped
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard the parity contracts rest on: a file that moves between the
    /// stamp and the read is reported as in flight, and one that does not is
    /// still. A file created *after* the stamp is new — also not still.
    #[test]
    fn a_file_written_after_the_stamp_is_not_still() {
        let dir = tempfile::tempdir().unwrap();
        let quiet = dir.path().join("quiet.jsonl");
        let busy = dir.path().join("busy.jsonl");
        std::fs::write(&quiet, "a\n").unwrap();
        std::fs::write(&busy, "a\n").unwrap();

        let mut still = StillFiles::stamp(dir.path());

        // A live session appends while the comparison is under way. Set the
        // mtime explicitly so the assertion cannot ride on clock resolution.
        let f = std::fs::File::options().append(true).open(&busy).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(2_000_000_000))
            .unwrap();

        // A session that starts after the stamp was never stamped at all.
        let fresh = dir.path().join("fresh.jsonl");
        std::fs::write(&fresh, "a\n").unwrap();

        assert!(still.still(&quiet), "an untouched file is still");
        assert!(!still.still(&busy), "an appended file is in flight");
        assert!(!still.still(&fresh), "a file created mid-run is in flight");
        assert_eq!(still.skipped(), 2);
    }
}
