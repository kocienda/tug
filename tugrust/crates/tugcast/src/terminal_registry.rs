//! Terminal-liveness registry reader.
//!
//! Claude Code maintains a per-process registry at `~/.claude/sessions/`:
//! one `<pid>.json` file per running claude process, carrying the process
//! id, the session id it currently holds, working directory, busy/idle
//! status, process start time, and entrypoint (`cli` for the interactive
//! terminal app, `sdk-cli` for SDK-driven processes). Files are removed
//! on clean exit; a crash can leave a stale file behind.
//!
//! This module turns that registry into a `sessionId → entry` map of
//! sessions held by a *live* process right now. The supervisor consults
//! it to annotate `list_sessions` rows and to refuse resume/trash of a
//! session another process is actively holding.
//!
//! # Stability contract
//!
//! The registry is an **undocumented internal** of Claude Code (shape
//! observed on v2.1.173). The reader is deliberately tolerant — only
//! `pid` and `sessionId` are required, everything else is optional —
//! and **fail-open**: a missing directory, unreadable file, or parse
//! failure yields an empty (or smaller) map plus a tracing warning,
//! never an error. During a format drift the exposure equals the
//! pre-liveness status quo: Tug may double-hold a session, but nothing
//! breaks.
//!
//! # Staleness guards
//!
//! A registry entry counts as live only when:
//!
//! 1. `kill(pid, 0)` says the process exists (`ESRCH` → stale crash
//!    leftover, skipped), and
//! 2. when the entry carries `procStart` and `ps -p <pid> -o lstart=`
//!    resolves, the two match after whitespace normalization — a
//!    mismatch means the pid was reused by an unrelated process since
//!    the entry was written, so the entry is treated as stale.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

/// Busy/idle classification from the registry's `status` field.
/// `Unknown` covers entries that predate the field or carry an
/// unrecognized value — still live, just without activity detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStatus {
    Busy,
    Idle,
    Unknown,
}

impl TerminalStatus {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            TerminalStatus::Busy => "busy",
            TerminalStatus::Idle => "idle",
            TerminalStatus::Unknown => "unknown",
        }
    }

    fn from_optional(raw: Option<&str>) -> Self {
        match raw {
            Some("busy") => TerminalStatus::Busy,
            Some("idle") => TerminalStatus::Idle,
            _ => TerminalStatus::Unknown,
        }
    }
}

/// One live registry entry, keyed in the result map by its session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLiveEntry {
    pub pid: i32,
    pub status: TerminalStatus,
    /// `kind` field verbatim (e.g. `"interactive"`), when present.
    pub kind: Option<String>,
    /// `entrypoint` field verbatim (`"cli"`, `"sdk-cli"`), when present.
    pub entrypoint: Option<String>,
}

/// Lenient parse target for one registry file. Only `pid` and
/// `sessionId` are required; everything else defaults to `None` so a
/// field rename in a future Claude Code release degrades that detail
/// instead of dropping the entry.
#[derive(Debug, Deserialize)]
struct RawRegistryEntry {
    pid: i32,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
    #[serde(default, rename = "procStart")]
    proc_start: Option<String>,
}

/// Default registry location: the Claude home's `sessions/`.
pub fn default_registry_root() -> Option<PathBuf> {
    Some(tugcore::claude_home::ClaudeHome::from_env().sessions_dir())
}

/// Parse one registry file's bytes. `None` (with a debug log) on any
/// shape problem — the caller skips the file.
fn parse_registry_entry(bytes: &[u8]) -> Option<RawRegistryEntry> {
    match serde_json::from_slice::<RawRegistryEntry>(bytes) {
        Ok(entry) => Some(entry),
        Err(err) => {
            tracing::warn!(error = %err, "terminal registry: unparseable entry skipped");
            None
        }
    }
}

/// True when a process with `pid` exists right now. `kill(pid, 0)`
/// delivers no signal; success or `EPERM` (exists, not ours to signal)
/// both mean alive, `ESRCH` means gone.
fn is_pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Resolve the actual start time of `pid` as `ps` formats it
/// (`lstart`, e.g. `Thu Jun 11 21:53:36 2026`). `None` when `ps`
/// fails or returns nothing — callers treat that as "cannot verify"
/// and accept the entry (fail-open).
fn actual_proc_start(pid: i32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let normalized = normalize_whitespace(&text);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Collapse runs of whitespace to single spaces and trim — `ps` pads
/// single-digit days, registry strings don't.
fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pid-reuse guard: when the entry carries `procStart` and the real
/// start time resolves, they must match. Either side missing →
/// unverifiable → accept.
fn proc_start_matches(entry_proc_start: Option<&str>, pid: i32) -> bool {
    let Some(recorded) = entry_proc_start else {
        return true;
    };
    let Some(actual) = actual_proc_start(pid) else {
        return true;
    };
    normalize_whitespace(recorded) == actual
}

/// Read the registry at `root` and return the sessions held by live
/// processes, keyed by session id. Missing root → empty map. Every
/// skip path is fail-open and logged; this function never errors.
///
/// When two live entries claim the same session id (double-hold), the
/// busier entry wins so the annotation errs toward caution.
pub fn read_live_sessions(root: &Path) -> HashMap<String, TerminalLiveEntry> {
    let mut live: HashMap<String, TerminalLiveEntry> = HashMap::new();
    let entries = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return live,
        Err(err) => {
            tracing::warn!(
                error = %err,
                root = %root.display(),
                "terminal registry: read_dir failed",
            );
            return live;
        }
    };
    for entry_result in entries {
        let Ok(dir_entry) = entry_result else {
            continue;
        };
        let path = dir_entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Some(raw) = parse_registry_entry(&bytes) else {
            continue;
        };
        if !is_pid_alive(raw.pid) {
            continue;
        }
        if !proc_start_matches(raw.proc_start.as_deref(), raw.pid) {
            tracing::info!(
                pid = raw.pid,
                session_id = %raw.session_id,
                "terminal registry: procStart mismatch (pid reuse), entry skipped",
            );
            continue;
        }
        let candidate = TerminalLiveEntry {
            pid: raw.pid,
            status: TerminalStatus::from_optional(raw.status.as_deref()),
            kind: raw.kind,
            entrypoint: raw.entrypoint,
        };
        match live.get(&raw.session_id) {
            Some(existing)
                if existing.status == TerminalStatus::Busy
                    && candidate.status != TerminalStatus::Busy => {}
            _ => {
                live.insert(raw.session_id, candidate);
            }
        }
    }
    live
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape observed on Claude Code v2.1.173 — the probe fixture. If
    /// this test fails after a claude upgrade, the registry format
    /// drifted and the reader (and this fixture) need a fresh survey.
    const PROBE_FIXTURE_V2_1_173: &str = r#"{"pid":50224,"sessionId":"c172c2e6-aa5f-4a18-9e1c-a04d200f3239","cwd":"/Users/u/src/tugtool","startedAt":1781214817047,"procStart":"Thu Jun 11 21:53:36 2026","version":"2.1.173","peerProtocol":1,"kind":"interactive","entrypoint":"cli","status":"idle","updatedAt":1781216225729,"statusUpdatedAt":1781216225729}"#;

    fn own_pid() -> i32 {
        std::process::id() as i32
    }

    fn own_proc_start() -> String {
        actual_proc_start(own_pid()).expect("test process has a ps-resolvable start time")
    }

    fn write_entry(dir: &Path, file_stem: &str, json: &str) {
        std::fs::write(dir.join(format!("{file_stem}.json")), json).unwrap();
    }

    #[test]
    fn probe_fixture_parses_with_expected_fields() {
        let raw = parse_registry_entry(PROBE_FIXTURE_V2_1_173.as_bytes()).unwrap();
        assert_eq!(raw.pid, 50224);
        assert_eq!(raw.session_id, "c172c2e6-aa5f-4a18-9e1c-a04d200f3239");
        assert_eq!(raw.status.as_deref(), Some("idle"));
        assert_eq!(raw.kind.as_deref(), Some("interactive"));
        assert_eq!(raw.entrypoint.as_deref(), Some("cli"));
        assert_eq!(raw.proc_start.as_deref(), Some("Thu Jun 11 21:53:36 2026"));
    }

    #[test]
    fn live_entry_with_own_pid_is_classified_live() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(
            r#"{{"pid":{},"sessionId":"sess-live","status":"busy","procStart":"{}","kind":"interactive","entrypoint":"cli"}}"#,
            own_pid(),
            own_proc_start(),
        );
        write_entry(dir.path(), "1", &json);
        let live = read_live_sessions(dir.path());
        let entry = live.get("sess-live").expect("own-pid entry is live");
        assert_eq!(entry.pid, own_pid());
        assert_eq!(entry.status, TerminalStatus::Busy);
        assert_eq!(entry.entrypoint.as_deref(), Some("cli"));
    }

    #[test]
    fn dead_pid_entry_is_excluded() {
        let dir = tempfile::tempdir().unwrap();
        // macOS pids cap below 100000; this pid cannot exist.
        write_entry(
            dir.path(),
            "2",
            r#"{"pid":999999,"sessionId":"sess-dead","status":"busy"}"#,
        );
        let live = read_live_sessions(dir.path());
        assert!(live.is_empty());
    }

    #[test]
    fn proc_start_mismatch_is_excluded_as_pid_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(
            r#"{{"pid":{},"sessionId":"sess-reused","procStart":"Thu Jan  1 00:00:00 1970"}}"#,
            own_pid(),
        );
        write_entry(dir.path(), "3", &json);
        let live = read_live_sessions(dir.path());
        assert!(live.is_empty());
    }

    #[test]
    fn missing_proc_start_is_accepted_fail_open() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(r#"{{"pid":{},"sessionId":"sess-nostart"}}"#, own_pid());
        write_entry(dir.path(), "4", &json);
        let live = read_live_sessions(dir.path());
        let entry = live
            .get("sess-nostart")
            .expect("entry without procStart accepted");
        assert_eq!(entry.status, TerminalStatus::Unknown);
    }

    #[test]
    fn missing_root_yields_empty_map() {
        let live = read_live_sessions(Path::new("/nonexistent/terminal-registry-root"));
        assert!(live.is_empty());
    }

    #[test]
    fn malformed_and_field_missing_entries_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_entry(dir.path(), "5", "not json at all");
        write_entry(dir.path(), "6", r#"{"sessionId":"sess-no-pid"}"#);
        write_entry(dir.path(), "7", r#"{"pid":12345}"#);
        std::fs::write(dir.path().join("notes.txt"), "ignored: wrong extension").unwrap();
        let live = read_live_sessions(dir.path());
        assert!(live.is_empty());
    }

    #[test]
    fn busy_entry_wins_a_double_hold() {
        let dir = tempfile::tempdir().unwrap();
        let start = own_proc_start();
        let idle = format!(
            r#"{{"pid":{},"sessionId":"sess-double","status":"idle","procStart":"{start}"}}"#,
            own_pid(),
        );
        let busy = format!(
            r#"{{"pid":{},"sessionId":"sess-double","status":"busy","procStart":"{start}"}}"#,
            own_pid(),
        );
        // File order is directory-iteration order; write both and assert
        // busy survives regardless.
        write_entry(dir.path(), "a", &idle);
        write_entry(dir.path(), "b", &busy);
        let live = read_live_sessions(dir.path());
        assert_eq!(
            live.get("sess-double").map(|e| e.status),
            Some(TerminalStatus::Busy)
        );
    }
}
