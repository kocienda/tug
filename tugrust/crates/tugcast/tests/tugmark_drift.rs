//! The tugmark drift golden.
//!
//! The page renders markdown with `parseMarkdownToSanitizedBlocks` (WASM
//! pulldown-cmark, then DOMPurify, then the block transformers) and tugcast
//! renders it with `tugmark::render_blocks` (the same pulldown-cmark core,
//! then ammonia, then ported transformers). Neither test can run the other's
//! runtime, so both are held to one checked-in artifact:
//! `tugdeck/crates/tugmark/corpus/golden.json`.
//!
//! This test derives the golden from the corpus and the newest stream-json
//! catalog version and asserts it equals the file. The page side,
//! `tugdeck/src/lib/markdown/__tests__/tugmark-drift.test.ts`, renders every
//! case in the file and asserts the same blocks, comparing HTML canonically.
//!
//! The cases:
//! - every document under `corpus/constructs/` and `corpus/hostile/`, whole;
//! - one stream per catalog turn in `STREAM_TURNS`. The catalog redacts each
//!   streamed delta to `{{text:len=N}}`, so the turn's delta sequence is
//!   replayed and each delta filled with the next `N` bytes of
//!   `corpus/streams/source.md`, snapped forward to a character boundary. A
//!   partial delta appends; a complete one replaces the text with that many
//!   bytes of the source. Every state is a prefix of the source, so a stream
//!   case stores the longest prefix once and the end of each state.
//!
//! `TUGMARK_GOLDEN_WRITE=1` writes the file instead of comparing
//! (`just tugmark-golden`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use tugmark::{Highlight, RenderedBlock, render_blocks};

/// The catalog turns whose delta sequences the stream cases replay.
const STREAM_TURNS: &[&str] = &[
    "test-02-longer-response-streaming",
    "test-10-long-streaming-300-words",
];

const REGENERATE: &str = "just tugmark-golden";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn corpus_dir() -> PathBuf {
    manifest_dir().join("../../../tugdeck/crates/tugmark/corpus")
}

fn golden_path() -> PathBuf {
    corpus_dir().join("golden.json")
}

/// The newest `v<semver>` directory of the stream-json catalog.
fn newest_catalog_dir() -> PathBuf {
    let root = manifest_dir().join("tests/fixtures/stream-json-catalog");
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read {}: {e}", root.display()))
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?.strip_prefix('v')?.to_string();
            let parts: Option<Vec<u64>> = name.split('.').map(|p| p.parse().ok()).collect();
            Some((parts?, path))
        })
        .collect();
    versions.sort();
    versions
        .pop()
        .unwrap_or_else(|| panic!("no v* directory under {}", root.display()))
        .1
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// One golden case: a text and the UTF-16 ends of the prefixes rendered.
struct Case {
    name: String,
    text: String,
    ends: Vec<usize>,
}

/// Every `.md` under `corpus/<group>/`, by name, rendered whole.
fn document_cases(group: &str) -> Vec<Case> {
    let dir = corpus_dir().join(group);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let file = path.file_name().unwrap().to_string_lossy();
            Case {
                name: format!("{group}/{file}"),
                ends: vec![utf16_len(&text)],
                text,
            }
        })
        .collect()
}

/// The first char boundary of `text` at or after byte `at`.
fn snap_forward(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// `{{text:len=N}}` → `N`.
fn redacted_len(value: &str) -> usize {
    value
        .strip_prefix("{{text:len=")
        .and_then(|rest| rest.strip_suffix("}}"))
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("not a redacted text: {value}"))
}

/// One catalog turn's `assistant_text` sequence, filled from `source`.
fn stream_case(catalog: &Path, turn: &str, source: &str) -> Case {
    let path = catalog.join(format!("{turn}.jsonl"));
    let jsonl =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let mut cursor = 0usize;
    let mut longest = 0usize;
    let mut ends = Vec::new();
    for line in jsonl.lines().filter(|l| !l.trim().is_empty()) {
        let frame: Value = serde_json::from_str(line).expect("catalog line is JSON");
        if frame["type"] != "assistant_text" {
            continue;
        }
        let len = redacted_len(frame["text"].as_str().expect("assistant_text carries text"));
        let partial = frame["is_partial"].as_bool().unwrap_or(false);
        let wanted = if partial { cursor + len } else { len };
        assert!(
            wanted <= source.len(),
            "{turn} needs {wanted} bytes of corpus/streams/source.md, which has {}; lengthen it",
            source.len()
        );
        cursor = snap_forward(source, wanted);
        longest = longest.max(cursor);
        ends.push(utf16_len(&source[..cursor]));
    }
    assert!(!ends.is_empty(), "{turn} carries no assistant_text");
    Case {
        name: format!("streams/{turn}"),
        text: source[..longest].to_string(),
        ends,
    }
}

fn all_cases() -> (String, Vec<Case>) {
    let mut cases = document_cases("constructs");
    cases.extend(document_cases("hostile"));
    let catalog = newest_catalog_dir();
    let source = std::fs::read_to_string(corpus_dir().join("streams/source.md"))
        .expect("read corpus/streams/source.md");
    for turn in STREAM_TURNS {
        cases.push(stream_case(&catalog, turn, &source));
    }
    let version = catalog.file_name().unwrap().to_string_lossy().into_owned();
    (version, cases)
}

fn block_json(block: &RenderedBlock) -> Value {
    json!({
        "hash": format!("{:016x}", block.hash),
        "kind": block.kind,
        "startChar": block.start_char,
        "endChar": block.end_char,
        "depth": block.depth,
        "itemCount": block.item_count,
        "rowCount": block.row_count,
        "html": block.html,
    })
}

/// The text's first `end` UTF-16 code units. Every end is a character
/// boundary by construction.
fn utf16_prefix(text: &str, end: usize) -> &str {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == end {
            return &text[..byte];
        }
        units += ch.len_utf16();
    }
    assert_eq!(units, end, "prefix end past the text");
    text
}

/// A case's golden entry. Identical blocks across a case's prefixes are
/// stored once, and each prefix lists its blocks by index.
fn case_json(case: &Case) -> Value {
    let mut table: Vec<Value> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let prefixes: Vec<Value> = case
        .ends
        .iter()
        .map(|&end| {
            let blocks: Vec<usize> = render_blocks(utf16_prefix(&case.text, end), Highlight::Off)
                .iter()
                .map(|block| {
                    let value = block_json(block);
                    let key = value.to_string();
                    *index.entry(key).or_insert_with(|| {
                        table.push(value);
                        table.len() - 1
                    })
                })
                .collect();
            json!({ "end": end, "blocks": blocks })
        })
        .collect();
    json!({
        "name": case.name,
        "text": case.text,
        "blocks": table,
        "prefixes": prefixes,
    })
}

fn golden() -> Value {
    let (catalog, cases) = all_cases();
    let mut root = Map::new();
    root.insert(
        "comment".into(),
        Value::String(format!(
            "Derived by tugrust/crates/tugcast/tests/tugmark_drift.rs; regenerate with `{REGENERATE}`."
        )),
    );
    root.insert("catalog".into(), Value::String(catalog));
    root.insert(
        "cases".into(),
        Value::Array(cases.iter().map(case_json).collect()),
    );
    Value::Object(root)
}

/// The first place two goldens disagree, for the failure message.
fn first_difference(expected: &Value, actual: &Value) -> String {
    if expected["catalog"] != actual["catalog"] {
        return format!(
            "catalog: file {} vs derived {}",
            expected["catalog"], actual["catalog"]
        );
    }
    let empty = Vec::new();
    let file_cases = expected["cases"].as_array().unwrap_or(&empty);
    let derived_cases = actual["cases"].as_array().unwrap_or(&empty);
    let names = |cases: &[Value]| {
        cases
            .iter()
            .map(|c| c["name"].to_string())
            .collect::<Vec<_>>()
    };
    if names(file_cases) != names(derived_cases) {
        return format!(
            "case list: file {:?} vs derived {:?}",
            names(file_cases),
            names(derived_cases)
        );
    }
    for (file, derived) in file_cases.iter().zip(derived_cases) {
        if file == derived {
            continue;
        }
        let name = &derived["name"];
        if file["text"] != derived["text"] {
            return format!("{name}: the case text changed");
        }
        let resolve = |case: &Value, prefix: &Value| -> Vec<Value> {
            prefix["blocks"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .map(|i| case["blocks"][i.as_u64().unwrap() as usize].clone())
                .collect()
        };
        let file_prefixes = file["prefixes"].as_array().unwrap_or(&empty);
        let derived_prefixes = derived["prefixes"].as_array().unwrap_or(&empty);
        for (fp, dp) in file_prefixes.iter().zip(derived_prefixes) {
            if fp["end"] != dp["end"] {
                return format!("{name}: prefix end {} vs {}", fp["end"], dp["end"]);
            }
            let (fb, db) = (resolve(file, fp), resolve(derived, dp));
            if fb.len() != db.len() {
                return format!(
                    "{name} @ {}: {} blocks in the file, {} derived",
                    dp["end"],
                    fb.len(),
                    db.len()
                );
            }
            for (i, (f, d)) in fb.iter().zip(&db).enumerate() {
                if f != d {
                    return format!(
                        "{name} @ {}, block {i}:\n  file:    {f}\n  derived: {d}",
                        dp["end"]
                    );
                }
            }
        }
        return format!(
            "{name}: {} prefixes in the file, {} derived",
            file_prefixes.len(),
            derived_prefixes.len()
        );
    }
    "the files differ only in their comment".to_string()
}

#[test]
fn the_native_pipeline_reproduces_the_golden() {
    let derived = golden();
    let path = golden_path();
    if std::env::var_os("TUGMARK_GOLDEN_WRITE").is_some() {
        let mut text = serde_json::to_string_pretty(&derived).expect("serialize golden");
        text.push('\n');
        std::fs::write(&path, text).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
        return;
    }
    let file = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "read {}: {e}; generate it with `{REGENERATE}`",
            path.display()
        )
    });
    let file: Value = serde_json::from_str(&file).expect("golden.json is JSON");
    assert!(
        file == derived,
        "tugmark's native rendering no longer matches {}.\n{}\n\nIf the change is intended, regenerate with `{REGENERATE}` and check the page side with `bun test src/lib/markdown/__tests__/tugmark-drift.test.ts`.",
        path.display(),
        first_difference(&file, &derived)
    );
}

#[test]
fn stream_cases_replay_the_catalog_shape() {
    let (_, cases) = all_cases();
    for turn in STREAM_TURNS {
        let case = cases
            .iter()
            .find(|c| c.name == format!("streams/{turn}"))
            .expect("stream case present");
        assert!(case.ends.len() > 10, "{turn}: {} states", case.ends.len());
        assert_eq!(*case.ends.iter().max().unwrap(), utf16_len(&case.text));
    }
}
