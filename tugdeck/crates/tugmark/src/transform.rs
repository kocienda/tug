//! Ports of the page's default block transformers
//! (`tugdeck/src/lib/markdown/block-transformers/math.ts` and `mermaid.ts`).
//!
//! Each promotes a sanitized `<pre><code class="language-X">` fence to a
//! placeholder the page's enhancers typeset, and its output is byte-identical
//! to the TypeScript version's: the drift golden compares the two.

/// JavaScript's `\s`: the ECMAScript WhiteSpace and LineTerminator sets.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
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
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
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
const MERMAID_LANGS: &[&str] = &["mermaid"];

/// `extractMathSource`: a ```math / ```latex / ```tex fence's language and
/// LaTeX source.
pub fn extract_math_source(html: &str) -> Option<(String, String)> {
    extract_fence_source(html, MATH_LANGS)
}

/// `extractMermaidSource`: a ```mermaid fence's language and diagram source.
pub fn extract_mermaid_source(html: &str) -> Option<(String, String)> {
    extract_fence_source(html, MERMAID_LANGS)
}

/// `buildMathPlaceholderHtml`.
pub fn build_math_placeholder_html(source: &str) -> String {
    format!(
        "<div class=\"tugx-katex tugx-katex--display\" data-tugx-math=\"display\" data-tugx-math-pending=\"true\">{}</div>",
        escape_for_text_content(source)
    )
}

/// `buildMermaidPlaceholderHtml`.
pub fn build_mermaid_placeholder_html(source: &str) -> String {
    format!(
        "<div class=\"tugx-mermaid\" data-tugx-mermaid-pending=\"true\">{}</div>",
        escape_for_text_content(source)
    )
}

/// `DEFAULT_BLOCK_TRANSFORMERS` over one block with `isComplete = true`:
/// math, then mermaid. Each matches only a `code` block and the two never
/// match the same fence, so one block in gives one block out.
pub fn apply_default_transformers(kind: &mut String, html: &mut String) {
    if kind != "code" {
        return;
    }
    if let Some((_, source)) = extract_math_source(html) {
        *kind = "tug-math-display".to_string();
        *html = build_math_placeholder_html(&source);
    } else if let Some((_, source)) = extract_mermaid_source(html) {
        *kind = "tug-mermaid".to_string();
        *html = build_mermaid_placeholder_html(&source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values below are the ones `math-transformer.test.ts` and
    // `mermaid-transformer.test.ts` assert.

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
        let fence = |lang: &str, body: &str| format!("<pre><code class=\"language-{lang}\">{body}</code></pre>\n");
        assert_eq!(
            extract_math_source(&fence("math", "E=mc^2\n")),
            Some(("math".to_string(), "E=mc^2".to_string()))
        );
        assert_eq!(extract_math_source(&fence("latex", "x")).map(|m| m.0), Some("latex".to_string()));
        assert_eq!(extract_math_source(&fence("tex", "x")).map(|m| m.0), Some("tex".to_string()));
        assert_eq!(extract_math_source(&fence("MATH", "x")).map(|m| m.0), Some("math".to_string()));
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
    fn mermaid_source_and_placeholder() {
        let html = "<pre><code class=\"language-mermaid\">graph TD\nA--&gt;B\n</code></pre>\n";
        assert_eq!(
            extract_mermaid_source(html),
            Some(("mermaid".to_string(), "graph TD\nA-->B".to_string()))
        );
        assert_eq!(
            build_mermaid_placeholder_html("graph TD\nA-->B"),
            "<div class=\"tugx-mermaid\" data-tugx-mermaid-pending=\"true\">graph TD\nA-->B</div>"
        );
    }

    #[test]
    fn transformers_promote_only_code_blocks() {
        let mut kind = "code".to_string();
        let mut html = "<pre><code class=\"language-math\">x\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html);
        assert_eq!(kind, "tug-math-display");
        assert!(html.starts_with("<div class=\"tugx-katex"));

        let mut kind = "paragraph".to_string();
        let mut html = "<pre><code class=\"language-math\">x\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html);
        assert_eq!(kind, "paragraph");

        let mut kind = "code".to_string();
        let mut html = "<pre><code class=\"language-mermaid\">a\n</code></pre>\n".to_string();
        apply_default_transformers(&mut kind, &mut html);
        assert_eq!(kind, "tug-mermaid");
    }
}
