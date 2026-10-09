//! The enforcement half of the workspace's lock policy.
//!
//! Every in-process `Mutex`, `RwLock` and `Condvar` in production code is a
//! `parking_lot` lock. A `std::sync` lock poisons when a thread panics while
//! holding it, and every later `.lock().unwrap()` is a fresh panic — so in
//! tugcast one bridge fault under the session ledger's lock became a process
//! that answered nothing until the host restarted it. A `parking_lot` lock
//! releases on unwind and the next caller proceeds; what the lock guards is a
//! handle (the ledger's `Connection`, a map of channels), and SQLite
//! transactions guard the data. Sibling of `ledger_db::no_ad_hoc_ledger_opens`,
//! and here for the same reason: a policy nothing checks lasts until the next
//! file that reaches for the standard library's lock out of habit.
//!
//! `tokio::sync` locks are a different tool and are not this scan's business.

/// Files allowed to hold a `std::sync` lock in production code, and why.
///
/// For a place `std` is genuinely required — an API that takes a
/// `std::sync::Mutex` by type, say. Every entry must still name a file that
/// uses one, or the list describes a workspace that has moved on. Empty today:
/// the one `Condvar` pair in the workspace (`tugtool`'s progress poster) runs
/// on `parking_lot`'s, which needs no `std` mutex beside it.
#[cfg(test)]
const ALLOWED: &[(&str, &str)] = &[];

/// Line numbers (1-based) in `text` that name a `std::sync` lock type.
///
/// Reads `std::sync::Mutex` and its kin by path, the `sync::Mutex` spelling a
/// `use std::sync;` makes available (but not `tokio::sync::Mutex`), and a
/// `use std::sync::{…}` group, which may span lines, that imports one. Comment
/// lines are skipped so prose may name the type it is explaining.
#[cfg(test)]
fn std_lock_lines(text: &str) -> Vec<usize> {
    const TYPES: &[&str] = &["Mutex", "RwLock", "Condvar"];
    let mut hits = Vec::new();
    let mut in_group: Option<usize> = None;
    for (idx, line) in text.lines().enumerate() {
        let line_no = idx + 1;
        let code = line.trim_start();
        if code.starts_with("//") {
            continue;
        }
        let names_lock = |s: &str| {
            s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .any(|word| TYPES.contains(&word))
        };
        if let Some(start) = in_group {
            let body = code.split('}').next().unwrap_or(code);
            if names_lock(body) {
                hits.push(start);
                in_group = None;
            } else if code.contains('}') {
                in_group = None;
            }
            continue;
        }
        if let Some(at) = code.find("std::sync::{") {
            let rest = &code[at + "std::sync::{".len()..];
            let body = rest.split('}').next().unwrap_or(rest);
            if names_lock(body) {
                hits.push(line_no);
            } else if !rest.contains('}') {
                in_group = Some(line_no);
            }
            continue;
        }
        for ty in TYPES {
            let needle = format!("sync::{ty}");
            let hit = code
                .match_indices(&needle)
                .any(|(at, _)| !code[..at].ends_with("tokio::"));
            if hit {
                hits.push(line_no);
                break;
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED, std_lock_lines};

    /// No production source may hold a `std::sync` lock.
    #[test]
    fn no_std_sync_locks() {
        let crates_root = crate::source_scan::crates_root();
        let mut offenders = Vec::new();
        let mut found: Vec<&str> = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            let rel = path
                .strip_prefix(&crates_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            // The scan's own home: it quotes the spellings it looks for.
            if rel == "tugcore/src/lock_policy_scan.rs" {
                continue;
            }
            let lines = std_lock_lines(&production);
            if lines.is_empty() {
                continue;
            }
            if let Some((file, _)) = ALLOWED.iter().find(|(file, _)| *file == rel) {
                found.push(file);
                continue;
            }
            offenders.push(format!("{rel}: line(s) {lines:?}"));
        }
        assert!(
            offenders.is_empty(),
            "`std::sync` locks in production code — a panic under one poisons it, and every \
             later `.lock().unwrap()` panics again. Use `parking_lot::{{Mutex, RwLock, Condvar}}`, \
             or add the file to `ALLOWED` in tugcore/src/lock_policy_scan.rs with the reason \
             `std` is required: {offenders:#?}"
        );
        for (file, _) in ALLOWED {
            assert!(
                found.contains(file),
                "{file} is allowlisted but holds no `std::sync` lock — drop the entry"
            );
        }
    }

    /// The detector sees every spelling the policy forbids, and none it allows.
    #[test]
    fn std_lock_lines_reads_each_spelling() {
        let forbidden = [
            "use std::sync::Mutex;",
            "use std::sync::{Arc, Mutex};",
            "use std::sync::{Arc as StdArc, Mutex as StdMutex};",
            "static S: std::sync::RwLock<u8> = std::sync::RwLock::new(0);",
            "fn f() -> std::sync::MutexGuard<'static, u8> {",
            "let pair = (sync::Mutex::new(0), sync::Condvar::new());",
        ];
        for line in forbidden {
            assert_eq!(std_lock_lines(line), vec![1], "missed: {line}");
        }
        assert_eq!(
            std_lock_lines("use std::sync::{\n    Arc,\n    Mutex,\n};\n"),
            vec![1],
            "a multi-line import group"
        );

        let allowed = [
            "use parking_lot::Mutex;",
            "use std::sync::{Arc, OnceLock};",
            "use std::sync::{\n    Arc,\n    OnceLock,\n};\nstruct Mutex;",
            "let m = tokio::sync::Mutex::new(0);",
            "use tokio::sync::{Mutex, RwLock};",
            "// a `std::sync::Mutex` named in prose",
            "/// returns a std::sync::MutexGuard, once",
        ];
        for text in allowed {
            assert!(std_lock_lines(text).is_empty(), "false hit: {text}");
        }
    }
}
