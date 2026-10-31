//! Text too long for any model to read, cut to what lexical search can hold.

use std::collections::BTreeMap;

use crate::chunk::{MARKER_TOKENS, MAX_TOKENS, Passage, context_line, estimate_tokens};

/// What a tool result's context line may cost. A transcript's context line is a
/// callsign, a turn and a role, so this holds any of them, and a reduced result is
/// one passage after it.
const CONTEXT_TOKENS: usize = 40;

/// The most a tool result's embedded passage may cost.
const TOOL_BUDGET_TOKENS: usize = MAX_TOKENS - CONTEXT_TOKENS;

/// How much of a reduced result may be failure and summary lines, as a divisor of its
/// budget, so that a log of nothing else still shows how it began and ended.
const VERDICT_SHARE: usize = 3;

/// Words that say something went wrong. They are read before [`SUMMARY_WORDS`], or a
/// long run of passes would fill the share and hide the one failure among them.
const FAILURE_WORDS: [&str; 6] = ["error", "fail", "panic", "traceback", "not ok", "✗"];

/// Words that say how a run came out.
const SUMMARY_WORDS: [&str; 4] = ["exit code", "verdict", "passed", "warning:"];

/// What marks lines left out.
const GAP: &str = "…";

/// A tool result as the index holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReducedTool<'a> {
    /// The one passage a model reads.
    pub embedded: String,
    /// The whole text, for the text shadow alone, when `embedded` is not all of it.
    pub lexical: Option<&'a str>,
}

/// Reduce a tool result to one passage. A result that fits is itself. One that does
/// not is `label`, its head, its failure and summary lines and its tail, in file
/// order, with [`GAP`] where lines were left out, and the whole text as `lexical`.
pub fn reduce_tool_result<'a>(label: &str, text: &'a str) -> ReducedTool<'a> {
    if estimate_tokens(text) <= TOOL_BUDGET_TOKENS {
        return ReducedTool {
            embedded: text.to_string(),
            lexical: None,
        };
    }
    let label = fit_start(label.lines().next().unwrap_or(""), TOOL_BUDGET_TOKENS / 2);
    let lines: Vec<&str> = text.trim().lines().collect();
    let mut kept: BTreeMap<usize, &str> = BTreeMap::new();
    let mut left = TOOL_BUDGET_TOKENS - MARKER_TOKENS - line_tokens(label);

    let mut verdicts = TOOL_BUDGET_TOKENS / VERDICT_SHARE;
    for words in [&FAILURE_WORDS[..], &SUMMARY_WORDS[..]] {
        for (at, line) in lines.iter().enumerate() {
            let cost = kept_tokens(line);
            if cost <= verdicts && !kept.contains_key(&at) && holds_any(line, words) {
                kept.insert(at, line);
                verdicts -= cost;
                left -= cost;
            }
        }
    }

    // The tail claims first but not everything, because the head is the command's own
    // account of what it set out to do.
    let mut tail = left - left / 3;
    left -= tail;
    for (at, line) in lines.iter().enumerate().rev() {
        if kept.contains_key(&at) {
            continue;
        }
        let shown = if at + 1 == lines.len() {
            fit_end(line, tail.saturating_sub(gap_tokens()))
        } else {
            line
        };
        let cost = kept_tokens(shown);
        if cost > tail {
            break;
        }
        kept.insert(at, shown);
        tail -= cost;
    }
    left += tail;
    for (at, line) in lines.iter().enumerate() {
        if kept.contains_key(&at) {
            continue;
        }
        let shown = if at == 0 {
            fit_start(line, left.saturating_sub(gap_tokens()))
        } else {
            line
        };
        let cost = kept_tokens(shown);
        if cost > left {
            break;
        }
        kept.insert(at, shown);
        left -= cost;
    }

    let mut embedded = label.to_string();
    let mut next = 0;
    for (at, line) in &kept {
        if *at != next {
            embedded.push('\n');
            embedded.push_str(GAP);
        }
        embedded.push('\n');
        embedded.push_str(line);
        next = at + 1;
    }
    if next != lines.len() {
        embedded.push('\n');
        embedded.push_str(GAP);
    }
    ReducedTool {
        embedded,
        lexical: Some(text),
    }
}

fn holds_any(line: &str, words: &[&str]) -> bool {
    let line = line.to_lowercase();
    words.iter().any(|word| line.contains(word))
}

/// What `line` and the line break before it add to [`estimate_tokens`], at most.
fn line_tokens(line: &str) -> usize {
    let punctuation = line.bytes().filter(u8::is_ascii_punctuation).count();
    (line.len() + punctuation + 1).div_ceil(2)
}

/// What a line break and [`GAP`] add.
fn gap_tokens() -> usize {
    line_tokens(GAP)
}

/// What a kept line adds, counting the gap that may stand before it.
fn kept_tokens(line: &str) -> usize {
    line_tokens(line) + gap_tokens()
}

/// As much of the start of `line` as costs at most `tokens`.
fn fit_start(line: &str, tokens: usize) -> &str {
    let mut end = 0;
    for (at, c) in line.char_indices() {
        let next = at + c.len_utf8();
        if line_tokens(&line[..next]) > tokens {
            break;
        }
        end = next;
    }
    &line[..end]
}

/// As much of the end of `line` as costs at most `tokens`.
fn fit_end(line: &str, tokens: usize) -> &str {
    let mut start = line.len();
    for (at, _) in line.char_indices().rev() {
        if line_tokens(&line[at..]) > tokens {
            break;
        }
        start = at;
    }
    &line[start..]
}

/// The most a lexical row holds. Long enough that a log takes few rows, and short
/// enough that a row is cheap to read back to show the bytes around a match.
const LEXICAL_ROW_BYTES: usize = 16 * 1024;

/// Split `text` into rows for the text shadow alone, in order, each carrying
/// `context`. A row ends at a line break, unless one line is longer than a row, and
/// then that line is cut between characters. Every row is exactly
/// `text[start..end]`, and together they are all of it. Whitespace-only input yields
/// none.
///
/// Whatever scrubs the text does so before this, so that the spans stay true of the
/// text the rows are slices of.
pub fn lexical_spans(context: &str, text: &str) -> Vec<Passage> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let context = context_line(context);
    let mut rows = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = row_end(text, start);
        rows.push(Passage {
            context: context.clone(),
            body: text[start..end].to_string(),
            ordinal: rows.len(),
            start,
            end,
        });
        start = end;
    }
    rows
}

/// Where the row beginning at `start` ends.
fn row_end(text: &str, start: usize) -> usize {
    let rest = &text[start..];
    if rest.len() <= LEXICAL_ROW_BYTES {
        return text.len();
    }
    let mut limit = LEXICAL_ROW_BYTES;
    while !rest.is_char_boundary(limit) {
        limit -= 1;
    }
    start
        + rest[..limit]
            .rfind('\n')
            .map_or(limit, |line_break| line_break + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_whole(rows: &[Passage], text: &str) {
        let mut at = 0;
        for (ordinal, row) in rows.iter().enumerate() {
            assert_eq!(row.ordinal, ordinal);
            assert_eq!(row.start, at);
            assert_eq!(&text[row.start..row.end], row.body);
            assert!(row.body.len() <= LEXICAL_ROW_BYTES);
            at = row.end;
        }
        assert_eq!(at, text.len());
    }

    fn assert_one_passage(embedded: &str) {
        assert!(
            estimate_tokens(embedded) <= TOOL_BUDGET_TOKENS,
            "{embedded}"
        );
        let passages = crate::chunk("curly-apple turn 1204 tool", embedded);
        assert_eq!(passages.len(), 1, "{embedded}");
    }

    #[test]
    fn a_short_result_is_itself_with_no_body() {
        let reduced = reduce_tool_result("ls", "a.rs\nb.rs\n");
        assert_eq!(reduced.embedded, "a.rs\nb.rs\n");
        assert_eq!(reduced.lexical, None);
    }

    #[test]
    fn a_long_log_keeps_its_ends_and_the_failure_in_its_middle() {
        let mut lines: Vec<String> = (0..4000)
            .map(|line| format!("test case {line} ... ok"))
            .collect();
        lines[2000] = "test case 2000 ... FAILED".to_string();
        let text = lines.join("\n");
        let reduced = reduce_tool_result("cargo test", &text);

        assert_one_passage(&reduced.embedded);
        assert_eq!(reduced.lexical, Some(text.as_str()));
        let shown: Vec<&str> = reduced.embedded.lines().collect();
        assert_eq!(shown[0], "cargo test");
        assert_eq!(shown[1], "test case 0 ... ok");
        assert_eq!(shown.last(), Some(&"test case 3999 ... ok"));
        let at = |line: &str| shown.iter().position(|shown| *shown == line).unwrap();
        assert!(at("test case 0 ... ok") < at("test case 2000 ... FAILED"));
        assert!(at("test case 2000 ... FAILED") < at("test case 3999 ... ok"));
        assert!(shown.contains(&GAP));
    }

    #[test]
    fn a_failure_is_not_crowded_out_by_passes() {
        let mut lines: Vec<String> = (0..500).map(|line| format!("case {line} passed")).collect();
        lines[400] = "case 400 panic: index out of bounds".to_string();
        let text = lines.join("\n");
        let reduced = reduce_tool_result("run", &text);
        assert_one_passage(&reduced.embedded);
        assert!(reduced.embedded.contains("case 400 panic"));
    }

    #[test]
    fn one_enormous_line_is_cut_to_fit() {
        let text = "é".repeat(20_000);
        let reduced = reduce_tool_result(&"x".repeat(200), &text);
        assert_one_passage(&reduced.embedded);
        assert_eq!(reduced.lexical, Some(text.as_str()));
        assert!(reduced.embedded.contains('é'));
    }

    #[test]
    fn nothing_but_verdict_lines_stays_inside_the_budget() {
        let text = "error: nope, and again\n".repeat(2000);
        assert_one_passage(&reduce_tool_result("c", &text).embedded);
    }

    #[test]
    fn short_text_is_one_row_with_its_context() {
        let rows = lexical_spans("cargo test", "one line\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].context, "cargo test");
        assert_eq!(rows[0].body, "one line\n");
    }

    #[test]
    fn nothing_to_find_is_no_rows() {
        assert!(lexical_spans("c", "").is_empty());
        assert!(lexical_spans("c", " \n\n ").is_empty());
    }

    #[test]
    fn a_long_log_is_cut_at_line_breaks_and_loses_nothing() {
        let text: String = (0..5000)
            .map(|line| format!("test case {line} ... ok\n"))
            .collect();
        let rows = lexical_spans("c", &text);
        assert!(rows.len() > 1);
        assert_whole(&rows, &text);
        for row in &rows {
            assert!(row.body.ends_with('\n'));
        }
    }

    #[test]
    fn one_line_longer_than_a_row_is_cut_between_characters() {
        let text = "é".repeat(LEXICAL_ROW_BYTES);
        let rows = lexical_spans("c", &text);
        assert_eq!(rows.len(), 2);
        assert_whole(&rows, &text);
    }
}
