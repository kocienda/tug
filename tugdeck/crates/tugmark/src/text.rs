//! The find extraction: a rendered message's text as the page's painter
//! reads it, the Rust mirror of `markdownToText` in
//! `tugdeck/src/components/tugways/cards/transcript-search-index.ts`.
//!
//! Per block: the text of its sanitized HTML with every `.tugx-katex`
//! subtree removed (fenced math, whose placeholder holds LaTeX the painter
//! skips), every `.tugx-chart` subtree replaced by the chart's find text
//! (the fence's spec holds JSON the page never shows; what it shows, once
//! rendered, is the table alternative, and `tuggraphics::find_text` is
//! that table's text, or the source itself for a spec the validator
//! refuses), then unfenced `$…$` / `$$…$$` math removed exactly where the
//! page's inline-math walk would promote it — node by node, because a text
//! node boundary decides what that walk can see (`mathStrippedText` in
//! `inline-math-walker.ts`). The blocks are joined with nothing, and atom
//! placeholders (U+FFFC) are removed.

use crate::html_scan::{attr, is_void, scan, Token};
use crate::render::RenderedBlock;

/// The atom placeholder character.
const ATOM_CHAR: char = '\u{fffc}';

/// Elements whose text the inline-math walk never enters. The page's walk
/// also skips `script`, `style`, `textarea` and `title`, but this reads
/// sanitized HTML, where the allow-list admits none of them.
fn is_skip_tag(name: &str) -> bool {
    matches!(name, "code" | "pre")
}

fn has_class(attrs: &[(&str, String)], class: &str) -> bool {
    attr(attrs, "class").is_some_and(|value| value.split_ascii_whitespace().any(|c| c == class))
}

/// What an open element does to the text under it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Text is emitted as the page shows it.
    Prose,
    /// A `.tugx-katex` subtree: nothing under it is emitted.
    Katex,
    /// A `.tugx-chart` subtree: its text is the chart source, gathered and
    /// replaced by the chart's find text when the subtree closes.
    Chart,
}

/// One block's text, per the module's rule.
fn block_text(html: &str) -> String {
    // The open elements: name, and the mode the element is (or is inside).
    let mut stack: Vec<(&str, Mode)> = Vec::new();
    let mut out = String::new();
    // The source of the chart subtree being read, already entity-decoded
    // by the scanner: the placeholder escaped it for text content, and
    // `Token::Text` undoes exactly that.
    let mut chart_source = String::new();
    scan(html, |token| match token {
        Token::Start { name, attrs, .. } => {
            let mode = match stack.last().map(|(_, m)| *m) {
                Some(inherited) if inherited != Mode::Prose => inherited,
                _ if has_class(&attrs, "tugx-katex") => Mode::Katex,
                _ if has_class(&attrs, "tugx-chart") => Mode::Chart,
                _ => Mode::Prose,
            };
            if !is_void(name) {
                stack.push((name, mode));
            }
        }
        Token::End { name } => {
            if let Some(at) = stack.iter().rposition(|(open, _)| *open == name) {
                let closes_chart =
                    stack[at].1 == Mode::Chart && (at == 0 || stack[at - 1].1 != Mode::Chart);
                stack.truncate(at);
                if closes_chart {
                    out.push_str(&tuggraphics::find_text(
                        &chart_source,
                        tuggraphics::Layers::Chart,
                    ));
                    chart_source.clear();
                }
            }
        }
        Token::Text(text) => {
            match stack.last().map(|(_, m)| *m) {
                Some(Mode::Katex) => return,
                Some(Mode::Chart) => {
                    chart_source.push_str(&text);
                    return;
                }
                _ => {}
            }
            // Text at the top level sits in the page's scratch `div`.
            let parent = stack.last().map_or("div", |(n, _)| *n);
            if text.contains('$') && !is_skip_tag(parent) {
                out.push_str(&strip_math_ranges(&text));
            } else {
                out.push_str(&text);
            }
        }
    });
    out
}

/// The text the page's find index projects for a rendered message.
pub fn rendered_text(blocks: &[RenderedBlock]) -> String {
    let mut out = String::new();
    for block in blocks {
        out.push_str(&block_text(&block.html));
    }
    out.retain(|c| c != ATOM_CHAR);
    out
}

// ---------------------------------------------------------------------------
// `findInlineMathRanges`, over bytes: every delimiter it reads is ASCII, and
// an ASCII byte in UTF-8 is never part of a wider character, so a byte index
// it stops at is a character boundary and the slices are the JS slices.
// ---------------------------------------------------------------------------

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn find_unescaped_double(t: &[u8], from: usize) -> Option<usize> {
    let n = t.len();
    let mut i = from;
    while i + 1 < n {
        if t[i] == b'\\' && t[i + 1] == b'$' {
            i += 2;
            continue;
        }
        if t[i] == b'$' && t[i + 1] == b'$' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_inline_closer(t: &[u8], from: usize) -> Option<usize> {
    let n = t.len();
    let mut i = from;
    while i < n {
        if t[i] == b'\\' && i + 1 < n && t[i + 1] == b'$' {
            i += 2;
            continue;
        }
        if t[i] == b'$' {
            let next = t.get(i + 1).copied();
            if (i > 0 && is_space(t[i - 1]))
                || next == Some(b'$')
                || next.is_some_and(|b| b.is_ascii_digit())
            {
                i += 1;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// The `[start, end)` byte range of every inline-math expression in `text`.
fn find_inline_math_ranges(text: &str) -> Vec<(usize, usize)> {
    let t = text.as_bytes();
    let n = t.len();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < n {
        if t[i] == b'\\' && i + 1 < n && t[i + 1] == b'$' {
            i += 2;
            continue;
        }
        if t[i] != b'$' {
            i += 1;
            continue;
        }
        if i + 1 < n && t[i + 1] == b'$' {
            match find_unescaped_double(t, i + 2) {
                Some(close) => {
                    ranges.push((i, close + 2));
                    i = close + 2;
                }
                None => i += 2,
            }
            continue;
        }
        if i + 1 < n && is_space(t[i + 1]) {
            i += 1;
            continue;
        }
        match find_inline_closer(t, i + 1) {
            Some(close) => {
                ranges.push((i, close + 1));
                i = close + 1;
            }
            None => i += 1,
        }
    }
    ranges
}

/// `text` with every inline-math range cut out.
fn strip_math_ranges(text: &str) -> String {
    let ranges = find_inline_math_ranges(text);
    if ranges.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        out.push_str(&text[cursor..start]);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{render_blocks, Highlight};

    fn text_of(markdown: &str) -> String {
        rendered_text(&render_blocks(markdown, Highlight::Off))
    }

    #[test]
    fn blocks_join_with_nothing_and_keep_their_own_newlines() {
        assert_eq!(
            text_of("# Title\n\nBody &amp; more.\n"),
            "Title\nBody & more.\n"
        );
    }

    #[test]
    fn fenced_math_is_dropped() {
        assert_eq!(
            text_of("before\n\n```math\nx^2\n```\n\nafter\n"),
            "before\nafter\n"
        );
    }

    #[test]
    fn inline_math_is_dropped_but_code_keeps_its_dollars() {
        assert_eq!(
            text_of("cost $x^2$ here and `$y$`\n"),
            "cost  here and $y$\n"
        );
    }

    #[test]
    fn prices_are_not_math() {
        assert_eq!(text_of("$5 and $10\n"), "$5 and $10\n");
    }

    #[test]
    fn a_line_break_splits_display_math_across_text_nodes() {
        // `$$<br>…<br>$$`: no single text node holds a whole expression,
        // so the page promotes nothing and the reader sees the raw `$$`.
        assert_eq!(text_of("$$\nx\n$$\n"), "$$\nx\n$$\n");
    }

    #[test]
    fn atom_placeholders_are_removed() {
        assert_eq!(text_of("a\u{fffc}b\n"), "ab\n");
    }

    #[test]
    fn a_chart_yields_its_table_text() {
        // The fence's `<` is escaped in the placeholder and decoded on the
        // way back, so the spec `find_text` reads is the author's.
        let markdown = concat!(
            "before\n\n```tugchart\n",
            "{\"tugchart\":1,\"form\":\"bar\",\"title\":\"a < b\",",
            "\"categories\":[\"x\",\"y\"],\"series\":[{\"name\":\"n\",\"values\":[1,null]}]}\n",
            "```\n\nafter\n"
        );
        let spec = "{\"tugchart\":1,\"form\":\"bar\",\"title\":\"a < b\",\"categories\":[\"x\",\"y\"],\"series\":[{\"name\":\"n\",\"values\":[1,null]}]}";
        let expected = tuggraphics::find_text(spec, tuggraphics::Layers::Chart);
        assert_eq!(expected, "a < bnx1y");
        assert_eq!(text_of(markdown), format!("before\n{expected}after\n"));
    }

    #[test]
    fn an_invalid_chart_yields_its_source() {
        let markdown = "```tugchart\n{\"tugchart\":1,\"form\":\"pie\"}\n```\n";
        assert_eq!(text_of(markdown), "{\"tugchart\":1,\"form\":\"pie\"}");
    }

    #[test]
    fn ranges_match_the_page_grammar() {
        assert_eq!(
            find_inline_math_ranges("a $b$ c $$d$$"),
            vec![(2, 5), (8, 13)]
        );
        assert_eq!(find_inline_math_ranges(r"\$a$"), vec![]);
        assert_eq!(find_inline_math_ranges("$ a$"), vec![]);
        assert_eq!(find_inline_math_ranges("$$open"), vec![]);
    }
}
