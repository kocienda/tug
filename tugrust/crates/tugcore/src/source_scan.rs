//! Shared source-scanning helper for the workspace's enforcement tests.
//!
//! Several invariants in this crate are upheld by reading the workspace's
//! own sources and asserting a forbidden call does not appear outside its
//! sanctioned chokepoint — `ledger_db::no_ad_hoc_ledger_opens` for raw
//! SQLite opens, `instance::no_ad_hoc_data_dir_resolution` for the data
//! root. They share this traversal so the definition of "production
//! source" cannot drift between them.

use std::path::{Path, PathBuf};

/// Every production `.rs` file under `crates/`, paired with the portion of
/// its text that precedes any test module.
///
/// Excludes `target/` output, per-crate `tests/` (integration tests may do
/// as they like), and `fixtures/`.
pub(crate) fn production_sources() -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![crates_root()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read_dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if name == "target" || name == "tests" || name == "fixtures" {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source");
            let production = match test_module_start(&text) {
                Some(cut) => text[..cut].to_string(),
                None => text,
            };
            out.push((path, production));
        }
    }
    out
}

/// The workspace's `crates/` directory.
pub(crate) fn crates_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .to_path_buf()
}

/// Every integration-test `.rs` file under a crate's `tests/` directory,
/// paired with its whole text.
///
/// The complement of [`production_sources`], which excludes `tests/` because
/// an integration test may do as it likes with the *workspace's* internals.
/// It may not do as it likes with the *developer's machine*: a CLI test
/// spawns a real binary, and a binary spawned with the ambient environment
/// intact reaches the real instance registry. That is what
/// `cli_test_env_scan` guards, and this is how it sees the files.
///
/// `corpus/` and `fixtures/` are skipped — they hold sample trees a test
/// reads, not tests.
pub(crate) fn integration_test_sources() -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(crates_root()).expect("read_dir") {
        let tests = entry.expect("dir entry").path().join("tests");
        if tests.is_dir() {
            stack.push(tests);
        }
    }
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read_dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != "corpus" && name != "fixtures" && name != "target" {
                    stack.push(path);
                }
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source");
            out.push((path, text));
        }
    }
    out
}

/// Byte offset where a file's `#[cfg(test)] … mod …` block starts, or
/// `None` when the file has no test module.
///
/// The workspace convention is a trailing `#[cfg(test)]` followed
/// (possibly through more attributes) by `mod …`. A lone `#[cfg(test)]`
/// on a single item must NOT truncate the scan, so the `mod` is required.
pub(crate) fn test_module_start(text: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find("#[cfg(test)]") {
        let at = search_from + rel;
        let after = &text[at + "#[cfg(test)]".len()..];
        let is_module = after
            .lines()
            .map(str::trim_start)
            .find(|l| !l.is_empty() && !l.starts_with("#["))
            .is_some_and(|l| l.starts_with("mod ") || l.starts_with("pub mod "));
        if is_module {
            return Some(at);
        }
        search_from = at + "#[cfg(test)]".len();
    }
    None
}
