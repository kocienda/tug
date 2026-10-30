//! Ports of the page's default block transformers
//! (`tugdeck/src/lib/markdown/block-transformers/math.ts` and
//! `tugchart.ts`).
//!
//! Each promotes a sanitized `<pre><code class="language-X">` fence to a
//! placeholder the page's enhancers typeset, and its output is byte-identical
//! to the TypeScript version's: the drift golden compares the two.

/// JavaScript's `\s`: the ECMAScript WhiteSpace and LineTerminator sets.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Strip an ASCII-case-insensitive `prefix` from `s`.
fn strip_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Match `/^<pre><code\s+class="language-([^"]+)"\s*>/i` at the start of
/// `html`: the fence's language and the opening tag's length.
fn match_fence_open(html: &str) -> Option<(&str, usize)> {
    let rest = strip_prefix_ignore_case(html, "<pre><code")?;
    let after_space = rest.trim_start_matches(is_js_space);
    if after_space.len() == rest.len() {
        return None;
    }
    let rest = strip_prefix_ignore_case(after_space, "class=\"language-")?;
    let quote = rest.find('"')?;
    if quote == 0 {
        return None;
    }
    let lang = &rest[..quote];
    let rest = rest[quote + 1..].trim_start_matches(is_js_space);
    let rest = rest.strip_prefix('>')?;
    Some((lang, html.len() - rest.len()))
}

/// The fence body between the opening tag and `/<\/code><\/pre>\s*$/`.
fn fence_body(html: &str, open_len: usize) -> Option<&str> {
    let trimmed = html.trim_end_matches(is_js_space);
    let body_end = trimmed.strip_suffix("</code></pre>")?.len();
    (body_end >= open_len).then(|| &html[open_len..body_end])
}

/// Decode the entity set pulldown-cmark emits inside a code fence body,
/// `&amp;` last so an already-escaped entity decodes exactly once.
pub fn decode_fenced_entities(escaped: &str) -> String {
    escaped
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Escape `&` and `<` so a placeholder's source survives an `innerHTML`
/// round-trip as its text content.
fn escape_for_text_content(raw: &str) -> String {
    raw.replace('&', "&amp;").replace('<', "&lt;")
}

/// The language and decoded source of a fence whose language is one of
/// `langs`, or `None` when `html` is not that exact fence shape.
fn extract_fence_source(html: &str, langs: &[&str]) -> Option<(String, String)> {
    let (lang, open_len) = match_fence_open(html)?;
    let body = fence_body(html, open_len)?;
    let lang = lang.to_lowercase();
    if !langs.contains(&lang.as_str()) {
        return None;
    }
    let trimmed = body.strip_suffix('\n').unwrap_or(body);
    Some((lang, decode_fenced_entities(trimmed)))
}

const MATH_LANGS: &[&str] = &["math", "latex", "tex"];
const TUGCHART_LANGS: &[&str] = &["tugchart"];

/// `extractMathSource`: a ```math / ```latex / ```tex fence's language and
/// LaTeX source.
pub fn extract_math_source(html: &str) -> Option<(String, String)> {
    extract_fence_source(html, MATH_LANGS)
}

/// `extractTugchartSource`: a ```tugchart fence's language and spec source.
pub fn extract_tugchart_source(html: &str) -> Option<(String, String)> {
    extract_fence_source(html, TUGCHART_LANGS)
}

/// A line with up to three leading spaces removed, or `None` when it is
/// indented further — CommonMark's rule for a fence line.
fn unindent_fence(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    (spaces <= 3).then(|| &line[spaces..])
}

/// The fence character and run length a line opens with, if any.
fn fence_run(line: &str) -> Option<(char, usize)> {
    let body = unindent_fence(line)?;
    let ch = body.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let n = body.chars().take_while(|c| *c == ch).count();
    (n >= 3).then_some((ch, n))
}

/// `fenceIsClosed`: whether a fenced code block's source ends in its closing
/// fence, by CommonMark's closing rule — at least two lines, and the last
/// non-blank line, with up to three leading spaces and trailing whitespace
/// removed, a run of the opening fence's character at least as long as the
/// opening run. The same test on both render sides, at every moment of a
/// stream.
pub fn fence_is_closed(source: &str) -> bool {
    let mut lines = source.split('\n');
    let Some((ch, n)) = lines.next().and_then(fence_run) else {
        return false;
    };
    let rest: Vec<&str> = lines.collect();
    for line in rest.iter().rev() {
        let line = line.trim_end_matches(is_js_space);
        if line.trim_matches(is_js_space).is_empty() {
            continue;
        }
        let Some(body) = unindent_fence(line) else {
            return false;
        };
        return body.chars().count() >= n && body.chars().all(|c| c == ch);
    }
    false
}

/// `buildMathPlaceholderHtml`.
pub fn build_math_placeholder_html(source: &str) -> String {
    format!(
        "<div class=\"tugx-katex tugx-katex--display\" data-tugx-math=\"display\" data-tugx-math-pending=\"true\">{}</div>",
        escape_for_text_content(source)
    )
}

/// `buildChartPlaceholderHtml`.
pub fn build_chart_placeholder_html(source: &str) -> String {
    format!(
        "<div class=\"tugx-chart\" data-tugx-chart-pending=\"true\">{}</div>",
        escape_for_text_content(source)
    )
}

/// `DEFAULT_BLOCK_TRANSFORMERS` over one block with `isComplete = true`:
/// math, then tugchart. Each matches only a `code` block and
/// no two match the same fence, so one block in gives one block out.
/// `source` is the block's own slice of the text, which decides whether a
/// chart fence is closed.
pub fn apply_default_transformers(kind: &mut String, html: &mut String, source: &str) {
    if kind != "code" {
        return;
    }
    if let Some((_, source)) = extract_math_source(html) {
        *kind = "tug-math-display".to_string();
        *html = build_math_placeholder_html(&source);
    } else if let Some((_, spec)) = extract_tugchart_source(html) {
        if fence_is_closed(source) {
            *kind = "tug-chart".to_string();
            *html = build_chart_placeholder_html(&spec);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values below are the ones `math-transformer.test.ts`
    // asserts.

    #[test]
    fn decodes_the_entity_set_pulldown_cmark_emits() {
        assert_eq!(
            decode_fenced_entities("a &amp; b &lt; c &gt; d &quot; e &#39; f"),
            "a & b < c > d \" e ' f"
        );
        assert_eq!(decode_fenced_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_fenced_entities("&amp;amp;"), "&amp;");
    }

    #[test]
    fn extracts_math_source_and_aliases() {
        let fence = |lang: &str, body: &str| {
            format!("<pre><code class=\"language-{lang}\">{body}</code></pre>\n")
        };
        assert_eq!(
            extract_math_source(&fence("math", "E=mc^2\n")),
            Some(("math".to_string(), "E=mc^2".to_string()))
        );
        assert_eq!(
            extract_math_source(&fence("latex", "x")).map(|m| m.0),
            Some("latex".to_string())
        );
        assert_eq!(
            extract_math_source(&fence("tex", "x")).map(|m| m.0),
            Some("tex".to_string())
        );
        assert_eq!(
            extract_math_source(&fence("MATH", "x")).map(|m| m.0),
            Some("math".to_string())
        );
        assert_eq!(extract_math_source(&fence("ts", "x")), None);
        assert_eq!(extract_math_source("<pre><code>x</code></pre>\n"), None);
        assert_eq!(extract_math_source("<p>$E=mc^2$</p>"), None);
        assert_eq!(
            extract_math_source(&fence("math", "x &lt; y &amp;&amp; a &gt; b\n")).map(|m| m.1),
            Some("x < y && a > b".to_string())
        );
        assert_eq!(
            extract_math_source(&fence("math", "line1\nline2\n")).map(|m| m.1),
            Some("line1\nline2".to_string())
        );
    }

    #[test]
    fn math_placeholder_is_byte_identical() {
        assert_eq!(
            build_math_placeholder_html("a < b && c"),
            "<div class=\"tugx-katex tugx-katex--display\" data-tugx-math=\"display\" data-tugx-math-pending=\"true\">a &lt; b &amp;&amp; c</div>"
        );
    }

    #[test]
    fn transformers_promote_only_code_blocks() {
        let mut kind = "code".to_string();
        let mut html = "<pre><code class=\"language-math\">x\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html, "```math\nx\n```\n");
        assert_eq!(kind, "tug-math-display");
        assert!(html.starts_with("<div class=\"tugx-katex"));

        let mut kind = "paragraph".to_string();
        let mut html = "<pre><code class=\"language-math\">x\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html, "");
        assert_eq!(kind, "paragraph");

        let mut kind = "code".to_string();
        let mut html = "<pre><code class=\"language-json\">a\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html, "```json\na\n```\n");
        assert_eq!(kind, "code");
        assert!(html.starts_with("<pre><code"));
    }

    // Expected values below are the ones `tugchart-transformer.test.ts`
    // asserts.

    #[test]
    fn tugchart_source_and_placeholder() {
        let html = "<pre><code class=\"language-tugchart\">{&quot;a&quot;: &quot;x &lt; y&quot;}\n</code></pre>\n";
        assert_eq!(
            extract_tugchart_source(html),
            Some(("tugchart".to_string(), "{\"a\": \"x < y\"}".to_string()))
        );
        assert_eq!(
            extract_tugchart_source("<pre><code class=\"language-tugchartx\">x\n</code></pre>\n"),
            None
        );
        assert_eq!(
            build_chart_placeholder_html("{\"a\": \"x < y & z\"}"),
            "<div class=\"tugx-chart\" data-tugx-chart-pending=\"true\">{\"a\": \"x &lt; y &amp; z\"}</div>"
        );
    }

    #[test]
    fn fence_closing_rule() {
        assert!(fence_is_closed("```tugchart\n{}\n```"));
        assert!(fence_is_closed("```tugchart\n{}\n```\n"));
        assert!(fence_is_closed("```tugchart\n{}\n   ````  \n\n"));
        assert!(fence_is_closed("~~~tugchart\n{}\n~~~"));
        assert!(!fence_is_closed("```tugchart\n{}\n"));
        assert!(!fence_is_closed("```tugchart\n{}"));
        assert!(!fence_is_closed("```tugchart"));
        assert!(!fence_is_closed("```tugchart\n```x\n"));
        assert!(!fence_is_closed("```tugchart\n    ```\n"));
        assert!(!fence_is_closed("```tugchart\n{}\n~~~\n"));
        assert!(!fence_is_closed("````tugchart\n{}\n```\n"));
        assert!(fence_is_closed("````tugchart\n{}\n```\n````\n"));
    }

    #[test]
    fn tugchart_promotes_only_a_closed_fence() {
        let html = "<pre><code class=\"language-tugchart\">{}\n</code></pre>\n";
        let mut kind = "code".to_string();
        let mut out = html.to_string();
        apply_default_transformers(&mut kind, &mut out, "```tugchart\n{}\n```\n");
        assert_eq!(kind, "tug-chart");
        assert_eq!(
            out,
            "<div class=\"tugx-chart\" data-tugx-chart-pending=\"true\">{}</div>"
        );

        let mut kind = "code".to_string();
        let mut out = html.to_string();
        apply_default_transformers(&mut kind, &mut out, "```tugchart\n{}\n");
        assert_eq!(kind, "code");
        assert_eq!(out, html);
    }
}
