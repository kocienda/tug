//! Native fence highlighting: tree-sitter over each fenced `<code>` body,
//! written as `<span class="tug-syn-<slot>">` runs.
//!
//! The slot names are the code slots of the page's `TUG_SYNTAX_SLOTS`
//! (`tugdeck/src/lib/language-registry.ts`), and `tug-syntax-classes.css`
//! colours them for both highlighters, so a fence tugcast highlighted and a
//! fence the page highlighted read in one palette. A highlighted `<code>`
//! is stamped `data-tug-highlighted=""` so the page leaves it alone. The
//! stamp and the spans are added after sanitization; both are built from
//! escaped text and fixed class names, so neither can carry markup.
//!
//! A fence whose language has no grammar here (markdown, astro,
//! dockerfile, sql, anything unknown) is left unstamped, and the page
//! highlights it when it can. The sql crate's queries are written for
//! Neovim's matcher (a Lua `%d` in a `#match?`), so numbers would read
//! as strings and the page's grammar does better.

use std::cell::RefCell;
use std::sync::OnceLock;

use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

use crate::html_scan::decode_entities;

/// Recognized capture names and the slot each lands in. tree-sitter
/// matches a capture to the recognized name with the most dot-separated
/// parts it contains, so `constant.builtin` beats `constant` and
/// `string.escape` beats `string`; a capture that matches none (a bare
/// `variable`, `embedded`) emits no span.
const CAPTURES: &[(&str, &str)] = &[
    ("keyword", "keyword"),
    ("conditional", "keyword"),
    ("repeat", "keyword"),
    ("include", "keyword"),
    ("storageclass", "keyword"),
    ("string", "string"),
    ("string.special", "string"),
    ("character", "string"),
    ("string.regex", "string"),
    ("string.escape", "string-expression"),
    ("escape", "string-expression"),
    ("number", "number"),
    ("float", "number"),
    ("boolean", "number"),
    ("constant.builtin", "number"),
    ("comment", "comment"),
    ("function", "function"),
    ("function.method", "function"),
    ("function.builtin", "function"),
    ("method", "function"),
    ("type", "type"),
    ("type.builtin", "type"),
    ("constructor", "type"),
    ("namespace", "type"),
    ("module", "type"),
    ("property", "property"),
    ("field", "property"),
    ("variable.parameter", "variable"),
    ("parameter", "variable"),
    ("constant", "constant"),
    (ATTRIBUTE, "decorator"),
    ("label", "decorator"),
    ("tag", "tag"),
    ("operator", "operator"),
    ("punctuation", "punctuation"),
    ("punctuation.bracket", "punctuation"),
    ("punctuation.delimiter", "punctuation"),
];

/// The one capture whose slot depends on the grammar: an HTML or JSX
/// attribute name is `attribute`, a Rust/Python/Java attribute is a
/// decorator.
const ATTRIBUTE: &str = "attribute";

/// The languages with a grammar here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lang {
    Js,
    Jsx,
    Ts,
    Tsx,
    Rust,
    Python,
    Json,
    Css,
    Html,
    Go,
    Java,
    Swift,
    Bash,
    Toml,
    Yaml,
    C,
    Cpp,
}

const LANG_COUNT: usize = 17;

impl Lang {
    fn index(self) -> usize {
        self as usize
    }

    /// Whether `attribute` captures name markup attributes.
    fn markup_attributes(self) -> bool {
        matches!(self, Lang::Html | Lang::Jsx | Lang::Tsx)
    }

    fn config(self) -> Option<HighlightConfiguration> {
        use tree_sitter_javascript as js;
        use tree_sitter_typescript as ts;
        let (language, name, queries): (tree_sitter::Language, &str, Vec<&str>) = match self {
            Lang::Js => (js::LANGUAGE.into(), "javascript", vec![js::HIGHLIGHT_QUERY]),
            Lang::Jsx => (
                js::LANGUAGE.into(),
                "jsx",
                vec![js::HIGHLIGHT_QUERY, js::JSX_HIGHLIGHT_QUERY],
            ),
            Lang::Ts => (
                ts::LANGUAGE_TYPESCRIPT.into(),
                "typescript",
                vec![js::HIGHLIGHT_QUERY, ts::HIGHLIGHTS_QUERY],
            ),
            Lang::Tsx => (
                ts::LANGUAGE_TSX.into(),
                "tsx",
                vec![
                    js::HIGHLIGHT_QUERY,
                    js::JSX_HIGHLIGHT_QUERY,
                    ts::HIGHLIGHTS_QUERY,
                ],
            ),
            Lang::Rust => (
                tree_sitter_rust::LANGUAGE.into(),
                "rust",
                vec![tree_sitter_rust::HIGHLIGHTS_QUERY],
            ),
            Lang::Python => (
                tree_sitter_python::LANGUAGE.into(),
                "python",
                vec![tree_sitter_python::HIGHLIGHTS_QUERY],
            ),
            Lang::Json => (
                tree_sitter_json::LANGUAGE.into(),
                "json",
                vec![tree_sitter_json::HIGHLIGHTS_QUERY],
            ),
            Lang::Css => (
                tree_sitter_css::LANGUAGE.into(),
                "css",
                vec![tree_sitter_css::HIGHLIGHTS_QUERY],
            ),
            Lang::Html => (
                tree_sitter_html::LANGUAGE.into(),
                "html",
                vec![tree_sitter_html::HIGHLIGHTS_QUERY],
            ),
            Lang::Go => (
                tree_sitter_go::LANGUAGE.into(),
                "go",
                vec![tree_sitter_go::HIGHLIGHTS_QUERY],
            ),
            Lang::Java => (
                tree_sitter_java::LANGUAGE.into(),
                "java",
                vec![tree_sitter_java::HIGHLIGHTS_QUERY],
            ),
            Lang::Swift => (
                tree_sitter_swift::LANGUAGE.into(),
                "swift",
                vec![tree_sitter_swift::HIGHLIGHTS_QUERY],
            ),
            Lang::Bash => (
                tree_sitter_bash::LANGUAGE.into(),
                "bash",
                vec![tree_sitter_bash::HIGHLIGHT_QUERY],
            ),
            Lang::Toml => (
                tree_sitter_toml_ng::LANGUAGE.into(),
                "toml",
                vec![tree_sitter_toml_ng::HIGHLIGHTS_QUERY],
            ),
            Lang::Yaml => (
                tree_sitter_yaml::LANGUAGE.into(),
                "yaml",
                vec![tree_sitter_yaml::HIGHLIGHTS_QUERY],
            ),
            Lang::C => (
                tree_sitter_c::LANGUAGE.into(),
                "c",
                vec![tree_sitter_c::HIGHLIGHT_QUERY],
            ),
            Lang::Cpp => (
                tree_sitter_cpp::LANGUAGE.into(),
                "cpp",
                vec![
                    tree_sitter_c::HIGHLIGHT_QUERY,
                    tree_sitter_cpp::HIGHLIGHT_QUERY,
                ],
            ),
        };
        // The last pattern matching a node wins, so the base grammar's
        // query leads and the extending one follows, as each grammar's
        // `tree-sitter.json` orders them.
        // `@spell` and `@nospell` are Neovim's spell-check markers. A node
        // keeps its last capture, so `(comment) @comment @spell` would
        // otherwise leave the comment unhighlighted.
        let query = queries
            .join("\n")
            .replace(" @nospell", "")
            .replace(" @spell", "");
        let mut config = HighlightConfiguration::new(language, name, &query, "", "").ok()?;
        let names: Vec<&str> = CAPTURES.iter().map(|(capture, _)| *capture).collect();
        config.configure(&names);
        Some(config)
    }
}

/// The page's `extForLangId`: `LANG_ID_ALIASES`, then the `LOADERS` keys,
/// resolved to the grammars this crate carries.
fn lang_for_id(lang_id: &str) -> Option<Lang> {
    let id = lang_id.trim().to_ascii_lowercase();
    let ext = match id.as_str() {
        "typescript" => "ts",
        "javascript" => "js",
        "python" => "py",
        "rust" => "rs",
        "golang" => "go",
        "shell" | "shellscript" | "bash" | "zsh" => "sh",
        "c++" | "cxx" => "cpp",
        "yml" => "yaml",
        "markdown" => "md",
        "docker" => "dockerfile",
        "htm" => "html",
        other => other,
    };
    Some(match ext {
        "js" | "mjs" | "cjs" => Lang::Js,
        "jsx" => Lang::Jsx,
        "ts" => Lang::Ts,
        "tsx" => Lang::Tsx,
        "rs" => Lang::Rust,
        "py" => Lang::Python,
        "json" => Lang::Json,
        "css" => Lang::Css,
        "html" => Lang::Html,
        "go" => Lang::Go,
        "java" => Lang::Java,
        "swift" => Lang::Swift,
        "sh" => Lang::Bash,
        "toml" => Lang::Toml,
        "yaml" => Lang::Yaml,
        "c" | "h" => Lang::C,
        "cpp" => Lang::Cpp,
        // md, astro, dockerfile, sql: the page's.
        _ => return None,
    })
}

/// Each grammar's configuration, compiled on first use and kept.
static CONFIGS: [OnceLock<Option<HighlightConfiguration>>; LANG_COUNT] =
    [const { OnceLock::new() }; LANG_COUNT];

fn config_for(lang: Lang) -> Option<&'static HighlightConfiguration> {
    CONFIGS[lang.index()].get_or_init(|| lang.config()).as_ref()
}

thread_local! {
    static HIGHLIGHTER: RefCell<Highlighter> = RefCell::new(Highlighter::new());
}

/// Escape text for an element body.
fn push_escaped(out: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

/// Highlight `source` as `lang_id` into span-wrapped escaped HTML, or
/// `None` when the language has no grammar here, the source is empty, or
/// the highlighter fails.
pub fn highlight_code(lang_id: &str, source: &str) -> Option<String> {
    if source.is_empty() {
        return None;
    }
    let lang = lang_for_id(lang_id)?;
    let config = config_for(lang)?;
    HIGHLIGHTER.with(|cell| {
        let mut highlighter = cell.borrow_mut();
        let events = highlighter
            .highlight(config, source.as_bytes(), None, |_| None)
            .ok()?;
        let mut out = String::with_capacity(source.len() * 2);
        for event in events {
            match event.ok()? {
                HighlightEvent::Source { start, end } => {
                    push_escaped(&mut out, source.get(start..end)?)
                }
                HighlightEvent::HighlightStart(highlight) => {
                    let (capture, slot) = CAPTURES.get(highlight.0)?;
                    let slot = if *capture == ATTRIBUTE && lang.markup_attributes() {
                        "attribute"
                    } else {
                        slot
                    };
                    out.push_str("<span class=\"tug-syn-");
                    out.push_str(slot);
                    out.push_str("\">");
                }
                HighlightEvent::HighlightEnd => out.push_str("</span>"),
            }
        }
        Some(out)
    })
}

const PRE_CODE_OPEN: &str = "<pre><code class=\"";
const CODE_CLOSE: &str = "</code>";

/// Highlight every fenced `<pre><code class="language-X">` body in `html`
/// whose language has a grammar, stamping each one it highlights. `None`
/// when nothing was highlighted, so the caller keeps its string.
pub fn highlight_fences(html: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = html;
    let mut changed = false;
    while let Some(at) = rest.find(PRE_CODE_OPEN) {
        let after_open = &rest[at + PRE_CODE_OPEN.len()..];
        let Some(quote) = after_open.find('"') else {
            break;
        };
        let class = &after_open[..quote];
        let Some(body_and_rest) = after_open[quote + 1..].strip_prefix('>') else {
            out.push_str(&rest[..at + PRE_CODE_OPEN.len()]);
            rest = after_open;
            continue;
        };
        let Some(close) = body_and_rest.find(CODE_CLOSE) else {
            break;
        };
        let body = &body_and_rest[..close];
        let spans = class
            .split_ascii_whitespace()
            .find_map(|c| c.strip_prefix("language-"))
            .and_then(|lang| highlight_code(lang, &decode_entities(body)));
        out.push_str(&rest[..at]);
        match spans {
            Some(spans) => {
                out.push_str(PRE_CODE_OPEN);
                out.push_str(class);
                out.push_str("\" data-tug-highlighted=\"\">");
                out.push_str(&spans);
                changed = true;
            }
            None => {
                let consumed = at + PRE_CODE_OPEN.len() + quote + 2 + close;
                out.push_str(&rest[at..consumed]);
            }
        }
        out.push_str(CODE_CLOSE);
        rest = &body_and_rest[close + CODE_CLOSE.len()..];
    }
    if !changed {
        return None;
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The element-free text of span-wrapped HTML, decoded.
    fn text_of(html: &str) -> String {
        let mut text = String::new();
        let mut in_tag = false;
        for ch in html.chars() {
            match ch {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                _ if !in_tag => text.push(ch),
                _ => {}
            }
        }
        decode_entities(&text)
    }

    /// The slot classes wrapping each occurrence of `token` in `html`.
    fn slot_of(html: &str, token: &str) -> Option<String> {
        let escaped = {
            let mut s = String::new();
            push_escaped(&mut s, token);
            s
        };
        let needle_end = format!("\">{escaped}</span>");
        let end = html.find(&needle_end)?;
        let start = html[..end].rfind("tug-syn-")? + "tug-syn-".len();
        Some(html[start..end].to_string())
    }

    struct Fixture {
        lang: String,
        source: String,
        salient: Vec<(String, String)>,
        /// The tokens the two highlighters slot differently, with this
        /// side's slot (`None`: no span of its own).
        diverges: Vec<(String, Option<String>)>,
    }

    /// One fixture per grammar. `salient` holds the tokens both
    /// highlighters slot alike, and the page's `language-registry.test.ts`
    /// holds its fence highlighter to the same file. `diverges` pins every
    /// token the two slot differently, each side asserting its own column
    /// (tugcast's is the second, the page's the third), so a fork that moves
    /// on either side fails here or there. Between them the two lists name
    /// every slot this highlighter writes.
    fn fixtures() -> Vec<Fixture> {
        let raw: serde_json::Value =
            serde_json::from_str(include_str!("../corpus/highlight/fixtures.json"))
                .expect("fixtures parse");
        let text = |v: &serde_json::Value| v.as_str().expect("a string").to_string();
        raw.as_array()
            .expect("an array")
            .iter()
            .map(|f| Fixture {
                lang: text(&f["lang"]),
                source: text(&f["source"]),
                salient: f["salient"]
                    .as_array()
                    .expect("salient pairs")
                    .iter()
                    .map(|pair| (text(&pair[0]), text(&pair[1])))
                    .collect(),
                diverges: f["diverges"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .map(|row| (text(&row[0]), row[1].as_str().map(str::to_string)))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect()
    }

    #[test]
    fn every_grammar_compiles() {
        let fixtures = fixtures();
        for index in 0..LANG_COUNT {
            let lang = fixtures
                .iter()
                .filter_map(|f| lang_for_id(&f.lang))
                .find(|l| l.index() == index)
                .expect("a fixture per grammar");
            assert!(config_for(lang).is_some(), "{lang:?} query compiles");
        }
    }

    #[test]
    fn each_fixture_keeps_its_text_and_slots_its_salient_tokens() {
        for fixture in fixtures() {
            let html = highlight_code(&fixture.lang, &fixture.source)
                .unwrap_or_else(|| panic!("{}: highlights", fixture.lang));
            assert_eq!(text_of(&html), fixture.source, "{}: text", fixture.lang);
            for (token, slot) in &fixture.salient {
                assert_eq!(
                    slot_of(&html, token).as_deref(),
                    Some(slot.as_str()),
                    "{}: {token:?} in {html}",
                    fixture.lang
                );
            }
            for (token, slot) in &fixture.diverges {
                assert_eq!(
                    slot_of(&html, token),
                    *slot,
                    "{}: the pinned fork {token:?} in {html}",
                    fixture.lang
                );
            }
        }
    }

    #[test]
    fn the_fixtures_name_every_slot_this_highlighter_writes() {
        let mut named = std::collections::BTreeSet::new();
        for fixture in fixtures() {
            named.extend(fixture.salient.into_iter().map(|(_, slot)| slot));
            named.extend(fixture.diverges.into_iter().filter_map(|(_, slot)| slot));
        }
        let written: std::collections::BTreeSet<String> = CAPTURES
            .iter()
            .map(|(_, slot)| slot.to_string())
            .chain(std::iter::once(ATTRIBUTE.to_string()))
            .collect();
        let missing: Vec<&String> = written.difference(&named).collect();
        assert!(missing.is_empty(), "slots no fixture names: {missing:?}");
    }

    #[test]
    fn ids_resolve_through_the_page_aliases() {
        assert_eq!(lang_for_id("TypeScript"), Some(Lang::Ts));
        assert_eq!(lang_for_id("zsh"), Some(Lang::Bash));
        assert_eq!(lang_for_id("c++"), Some(Lang::Cpp));
        assert_eq!(lang_for_id("yml"), Some(Lang::Yaml));
        assert_eq!(lang_for_id("markdown"), None);
        assert_eq!(lang_for_id("astro"), None);
        assert_eq!(lang_for_id("dockerfile"), None);
        assert_eq!(lang_for_id("sql"), None);
        assert_eq!(lang_for_id("nope"), None);
    }

    #[test]
    fn fences_are_decoded_highlighted_escaped_and_stamped() {
        let html = "<p>x</p>\n<pre><code class=\"language-rust\">let a = &quot;&lt;b&gt;&quot;;\n</code></pre>\n";
        let out = highlight_fences(html).expect("highlighted");
        assert!(
            out.starts_with(
                "<p>x</p>\n<pre><code class=\"language-rust\" data-tug-highlighted=\"\">"
            ),
            "{out}"
        );
        assert!(out.ends_with("</code></pre>\n"), "{out}");
        assert!(out.contains("&lt;b&gt;"), "{out}");
        assert!(!out.contains("<b>"), "{out}");
        assert!(
            out.contains("<span class=\"tug-syn-keyword\">let</span>"),
            "{out}"
        );
    }

    #[test]
    fn unknown_and_unlabelled_fences_are_left_alone() {
        assert_eq!(
            highlight_fences("<pre><code class=\"language-md\"># x\n</code></pre>\n"),
            None
        );
        assert_eq!(highlight_fences("<pre><code>plain\n</code></pre>\n"), None);
        // A known fence after an unknown one: the unknown one is copied as written.
        let html = "<pre><code class=\"language-md\"># x\n</code></pre>\n<pre><code class=\"language-py\">pass\n</code></pre>\n";
        let out = highlight_fences(html).expect("highlighted");
        assert!(out.starts_with("<pre><code class=\"language-md\"># x\n</code></pre>\n<pre><code class=\"language-py\" data-tug-highlighted=\"\">"), "{out}");
    }
}
