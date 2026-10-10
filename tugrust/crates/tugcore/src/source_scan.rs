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
///
/// A file that declares itself test-only with an inner `#![cfg(test)]` — a
/// fixtures module split out of a test block — is test code from its first
/// byte. Only the file's preamble — the doc comments, blank lines, and inner
/// attributes before its first item — is read for it: the same line inside an
/// inline `mod … { }` scopes that module alone, and must not blind a scan to
/// the production code around it.
pub(crate) fn test_module_start(text: &str) -> Option<usize> {
    let mut preamble = text
        .lines()
        .map(str::trim)
        .take_while(|l| l.is_empty() || l.starts_with("//") || l.starts_with("#!["));
    if preamble.any(|l| l == "#![cfg(test)]") {
        return Some(0);
    }
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

#[cfg(test)]
mod tests {
    use super::test_module_start;

    #[test]
    fn a_trailing_test_module_is_cut_and_a_lone_test_item_is_not() {
        let text = "fn a() {}\n#[cfg(test)]\nfn helper() {}\n#[cfg(test)]\nmod tests {}\n";
        let cut = test_module_start(text).unwrap();
        assert_eq!(&text[..cut], "fn a() {}\n#[cfg(test)]\nfn helper() {}\n");
    }

    #[test]
    fn a_file_that_declares_itself_test_only_is_test_code_throughout() {
        let text = "//! Fixtures.\n\n#![cfg(test)]\n\nfn fixture() {}\n";
        assert_eq!(test_module_start(text), Some(0));
    }

    #[test]
    fn an_inline_modules_inner_attribute_does_not_exempt_the_file() {
        let text = "fn production() {}\n\nmod fixtures {\n    #![cfg(test)]\n    fn f() {}\n}\n";
        assert_eq!(test_module_start(text), None);
    }
}
