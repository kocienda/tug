//! tugdiff-wasm — `imara-diff` bindings compiled to WASM.
//!
//! # API
//!
//! - [`parse_unified_diff`] — parse a unified-diff string (one or more `@@` hunks)
//!   into a structured array of hunks with per-line classification.
//! - [`two_text_diff`] — compute a diff between two text inputs and return the
//!   same structured representation.
//!
//! Both functions return JS values shaped as `DiffHunk[]`:
//!
//! ```ts
//! type DiffHunk = {
//!     before_start: number;   // 1-based line number in `before`; 0 if hunk has no removed lines
//!     before_count: number;
//!     after_start: number;    // 1-based line number in `after`;  0 if hunk has no added lines
//!     after_count: number;
//!     header: string;         // text after the closing `@@` (often empty)
//!     lines: DiffLine[];
//! };
//! type DiffLine = {
//!     kind: "context" | "add" | "remove";
//!     content: string;        // line text without trailing newline; the leading +/-/space marker is stripped
//!     before_lineno: number | null;
//!     after_lineno: number | null;
//! };
//! ```

use imara_diff::{Algorithm, BasicLineDiffPrinter, Diff, InternedInput, UnifiedDiffConfig};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub before_start: u32,
    pub before_count: u32,
    pub after_start: u32,
    pub after_count: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    pub before_lineno: Option<u32>,
    pub after_lineno: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Remove,
}

/// Parse a unified-diff string into structured hunks.
///
/// The input may include `---` / `+++` file headers; they are ignored. Parsing
/// starts at the first `@@` hunk header and continues until end of input.
///
/// Lines beginning with `\` (e.g. `\ No newline at end of file`) are skipped.
/// Malformed hunk headers are skipped — recovery resumes at the next `@@`.
#[wasm_bindgen]
pub fn parse_unified_diff(text: &str) -> Result<JsValue, JsValue> {
    let hunks = parse_unified_diff_text(text);
    serde_wasm_bindgen::to_value(&hunks).map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Compute the unified diff between two text inputs.
///
/// Uses the Histogram algorithm with line-level postprocessing for human-readable
/// output. The result has the same shape as [`parse_unified_diff`].
#[wasm_bindgen]
pub fn two_text_diff(before: &str, after: &str) -> Result<JsValue, JsValue> {
    let hunks = compute_two_text_hunks(before, after);
    serde_wasm_bindgen::to_value(&hunks).map_err(|err| JsValue::from_str(&err.to_string()))
}

// ---------------------------------------------------------------------------
// Plain-Rust core (testable without a wasm runtime)
// ---------------------------------------------------------------------------

pub fn compute_two_text_hunks(before: &str, after: &str) -> Vec<DiffHunk> {
    let input = InternedInput::new(before, after);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    let unified = diff
        .unified_diff(
            &BasicLineDiffPrinter(&input.interner),
            UnifiedDiffConfig::default(),
            &input,
        )
        .to_string();
    parse_unified_diff_text(&unified)
}

pub fn parse_unified_diff_text(text: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut current: Option<DiffHunk> = None;
    let mut before_lineno: u32 = 0;
    let mut after_lineno: u32 = 0;

    for line in text.split_inclusive('\n').map(strip_trailing_newline) {
        if let Some(rest) = line.strip_prefix("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            if let Some((before_start, before_count, after_start, after_count, header)) =
                parse_hunk_header(rest)
            {
                before_lineno = before_start;
                after_lineno = after_start;
                current = Some(DiffHunk {
                    before_start,
                    before_count,
                    after_start,
                    after_count,
                    header,
                    lines: Vec::new(),
                });
            }
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };

        if line.starts_with('\\') {
            continue;
        }

        if let Some(content) = line.strip_prefix('+') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Add,
                content: content.to_string(),
                before_lineno: None,
                after_lineno: Some(after_lineno),
            });
            after_lineno = after_lineno.saturating_add(1);
        } else if let Some(content) = line.strip_prefix('-') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Remove,
                content: content.to_string(),
                before_lineno: Some(before_lineno),
                after_lineno: None,
            });
            before_lineno = before_lineno.saturating_add(1);
        } else if let Some(content) = line.strip_prefix(' ') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Context,
                content: content.to_string(),
                before_lineno: Some(before_lineno),
                after_lineno: Some(after_lineno),
            });
            before_lineno = before_lineno.saturating_add(1);
            after_lineno = after_lineno.saturating_add(1);
        } else if line.is_empty() {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Context,
                content: String::new(),
                before_lineno: Some(before_lineno),
                after_lineno: Some(after_lineno),
            });
            before_lineno = before_lineno.saturating_add(1);
            after_lineno = after_lineno.saturating_add(1);
        }
    }

    if let Some(h) = current.take() {
        hunks.push(h);
    }

    hunks
}

fn strip_trailing_newline(s: &str) -> &str {
    s.strip_suffix('\n')
        .map(|t| t.strip_suffix('\r').unwrap_or(t))
        .unwrap_or(s)
}

/// Parse the body of a hunk header (everything after the leading `@@`).
///
/// Expected shape: ` -<n>[,<n>] +<n>[,<n>] @@[ <header text>]`.
/// Returns `(before_start, before_count, after_start, after_count, header_text)`.
fn parse_hunk_header(rest: &str) -> Option<(u32, u32, u32, u32, String)> {
    let trimmed = rest.trim_start();
    let close_idx = trimmed.find("@@")?;
    let info = trimmed[..close_idx].trim();
    let header = trimmed[close_idx + 2..].trim().to_string();

    let mut parts = info.split_whitespace();
    let before_part = parts.next()?.strip_prefix('-')?;
    let after_part = parts.next()?.strip_prefix('+')?;

    let (before_start, before_count) = parse_range(before_part)?;
    let (after_start, after_count) = parse_range(after_part)?;

    Some((before_start, before_count, after_start, after_count, header))
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.splitn(2, ',');
    let start: u32 = parts.next()?.parse().ok()?;
    let count: u32 = match parts.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_with_count() {
        assert_eq!(parse_range("1,5"), Some((1, 5)));
    }

    #[test]
    fn parse_range_default_count_is_one() {
        // git omits the count when count == 1
        assert_eq!(parse_range("42"), Some((42, 1)));
    }

    #[test]
    fn parse_range_zero_count() {
        // pure addition uses "0,0" on the before side
        assert_eq!(parse_range("0,0"), Some((0, 0)));
    }

    #[test]
    fn parse_range_rejects_garbage() {
        assert_eq!(parse_range(""), None);
        assert_eq!(parse_range("abc"), None);
    }

    #[test]
    fn parse_hunk_header_simple() {
        let parsed = parse_hunk_header(" -1,3 +1,4 @@");
        assert_eq!(parsed, Some((1, 3, 1, 4, String::new())));
    }

    #[test]
    fn parse_hunk_header_with_section() {
        let parsed = parse_hunk_header(" -10,2 +10,3 @@ fn foo()");
        assert_eq!(parsed, Some((10, 2, 10, 3, "fn foo()".to_string())));
    }

    #[test]
    fn parse_unified_diff_round_trips_known_fixture() {
        // Fixture taken from the imara-diff documented example output.
        // Built line-by-line so that leading single-space context markers survive
        // (Rust's `\\<newline>` continuation eats subsequent whitespace).
        let fixture = concat!(
            "@@ -1,5 +1,8 @@\n",
            "+// lorem ipsum\n",
            " fn foo() -> Bar {\n",
            "     let mut foo = 2;\n",
            "     foo *= 50;\n",
            "-    println!(\"hello world\")\n",
            "+    println!(\"hello world\");\n",
            "+    println!(\"{foo}\");\n",
            " }\n",
            "+// foo\n",
        );

        let hunks = parse_unified_diff_text(fixture);
        assert_eq!(hunks.len(), 1);
        let hunk = &hunks[0];
        assert_eq!(hunk.before_start, 1);
        assert_eq!(hunk.before_count, 5);
        assert_eq!(hunk.after_start, 1);
        assert_eq!(hunk.after_count, 8);
        assert_eq!(hunk.lines.len(), 9);

        // First line: pure addition `// lorem ipsum`
        assert_eq!(hunk.lines[0].kind, DiffLineKind::Add);
        assert_eq!(hunk.lines[0].content, "// lorem ipsum");
        assert_eq!(hunk.lines[0].before_lineno, None);
        assert_eq!(hunk.lines[0].after_lineno, Some(1));

        // Second line: context `fn foo() -> Bar {`
        assert_eq!(hunk.lines[1].kind, DiffLineKind::Context);
        assert_eq!(hunk.lines[1].content, "fn foo() -> Bar {");
        assert_eq!(hunk.lines[1].before_lineno, Some(1));
        assert_eq!(hunk.lines[1].after_lineno, Some(2));

        // Removal line
        assert_eq!(hunk.lines[4].kind, DiffLineKind::Remove);
        assert_eq!(hunk.lines[4].content, "    println!(\"hello world\")");
        assert_eq!(hunk.lines[4].before_lineno, Some(4));
        assert_eq!(hunk.lines[4].after_lineno, None);

        // First add after the removal: the after-side line counter has advanced
        // past the three context lines (lines 2..=4 on the after side) and now
        // emits at after-line 5.
        assert_eq!(hunk.lines[5].kind, DiffLineKind::Add);
        assert_eq!(hunk.lines[5].after_lineno, Some(5));
        assert_eq!(hunk.lines[5].before_lineno, None);
    }

    #[test]
    fn parse_unified_diff_skips_file_headers() {
        let fixture = concat!(
            "--- a/foo.txt\n",
            "+++ b/foo.txt\n",
            "@@ -1,1 +1,1 @@\n",
            "-old\n",
            "+new\n",
        );
        let hunks = parse_unified_diff_text(fixture);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 2);
        assert_eq!(hunks[0].lines[0].kind, DiffLineKind::Remove);
        assert_eq!(hunks[0].lines[1].kind, DiffLineKind::Add);
    }

    #[test]
    fn parse_unified_diff_handles_multiple_hunks() {
        let fixture = concat!(
            "@@ -1,1 +1,1 @@\n",
            "-alpha\n",
            "+beta\n",
            "@@ -10,1 +10,1 @@\n",
            "-gamma\n",
            "+delta\n",
        );
        let hunks = parse_unified_diff_text(fixture);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].before_start, 1);
        assert_eq!(hunks[1].before_start, 10);
    }

    #[test]
    fn parse_unified_diff_skips_no_newline_marker() {
        let fixture = concat!(
            "@@ -1,1 +1,1 @@\n",
            "-old\n",
            "\\ No newline at end of file\n",
            "+new\n",
        );
        let hunks = parse_unified_diff_text(fixture);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 2);
    }

    #[test]
    fn parse_unified_diff_handles_empty_context_line() {
        let fixture = concat!("@@ -1,3 +1,3 @@\n", " keep\n", "\n", " keep2\n",);
        let hunks = parse_unified_diff_text(fixture);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 3);
        assert_eq!(hunks[0].lines[1].kind, DiffLineKind::Context);
        assert_eq!(hunks[0].lines[1].content, "");
        assert_eq!(hunks[0].lines[1].before_lineno, Some(2));
        assert_eq!(hunks[0].lines[1].after_lineno, Some(2));
    }

    #[test]
    fn parse_unified_diff_returns_empty_for_no_hunks() {
        assert!(parse_unified_diff_text("").is_empty());
        assert!(parse_unified_diff_text("just some prose\nwith no hunk markers\n").is_empty());
    }

    #[test]
    fn two_text_diff_produces_correct_hunks_for_known_pair() {
        // Same fixture as the imara-diff doc example.
        let before = concat!(
            "fn foo() -> Bar {\n",
            "    let mut foo = 2;\n",
            "    foo *= 50;\n",
            "    println!(\"hello world\")\n",
            "}\n",
        );
        let after = concat!(
            "// lorem ipsum\n",
            "fn foo() -> Bar {\n",
            "    let mut foo = 2;\n",
            "    foo *= 50;\n",
            "    println!(\"hello world\");\n",
            "    println!(\"{foo}\");\n",
            "}\n",
            "// foo\n",
        );
        let hunks = compute_two_text_hunks(before, after);
        assert_eq!(hunks.len(), 1);
        let hunk = &hunks[0];
        assert_eq!(hunk.before_start, 1);
        assert_eq!(hunk.before_count, 5);
        assert_eq!(hunk.after_start, 1);
        assert_eq!(hunk.after_count, 8);

        // 1 add (lorem) + 3 context + 1 remove + 2 add + 1 context + 1 add = 9
        assert_eq!(hunk.lines.len(), 9);
        let kinds: Vec<DiffLineKind> = hunk.lines.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            vec![
                DiffLineKind::Add,
                DiffLineKind::Context,
                DiffLineKind::Context,
                DiffLineKind::Context,
                DiffLineKind::Remove,
                DiffLineKind::Add,
                DiffLineKind::Add,
                DiffLineKind::Context,
                DiffLineKind::Add,
            ]
        );
    }

    #[test]
    fn two_text_diff_identical_inputs_produce_no_hunks() {
        let same = "alpha\nbeta\ngamma\n";
        assert!(compute_two_text_hunks(same, same).is_empty());
    }

    #[test]
    fn two_text_diff_pure_addition() {
        let before = "";
        let after = "added line\n";
        let hunks = compute_two_text_hunks(before, after);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 1);
        assert_eq!(hunks[0].lines[0].kind, DiffLineKind::Add);
        assert_eq!(hunks[0].lines[0].content, "added line");
    }
}
