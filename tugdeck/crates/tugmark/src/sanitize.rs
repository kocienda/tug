//! The native sanitizer: ammonia, configured from the one allow-list file
//! DOMPurify reads on the page (`tugdeck/src/lib/markdown/sanitize-allowlist.json`).
//!
//! Reading one file makes the two policies equal by construction for the
//! lists. Where ammonia's own defaults differ from DOMPurify's, they are
//! switched off or written down here as named constants, DOMPurify's
//! attribute-value rule is ported as `filter_attribute`, and the drift
//! golden holds the two pipelines' output equal block by block.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use ammonia::Builder;

use crate::html_scan::{attr, scan, Token};

/// The allow-list file, compiled in.
const ALLOWLIST_JSON: &str = include_str!("../../../src/lib/markdown/sanitize-allowlist.json");

/// The schemes DOMPurify's `IS_ALLOWED_URI` admits on any attribute whose
/// value it reads as a URL: `(f|ht)tps?`, `mailto`, `tel`, `callto`, `sms`,
/// `cid`, `xmpp`, `matrix`.
pub const SAFE_URI_SCHEMES: &[&str] = &[
    "http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp", "matrix",
];

/// The schemes ammonia's own URL gate lets through on `href` and `src`:
/// the safe schemes, plus `data`, which `filter_attribute` then admits only
/// where DOMPurify does (`src` on a `DATA_URI_TAGS` element). A relative URL
/// passes the gate, as DOMPurify lets a scheme-less value through.
pub const URL_SCHEMES: &[&str] = &[
    "http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp", "matrix",
    "data",
];

/// DOMPurify's `URI_SAFE_ATTRIBUTES`: attributes whose value is never read
/// as a URL, so any value is kept.
const URI_SAFE_ATTRIBUTES: &[&str] = &[
    "alt",
    "class",
    "for",
    "id",
    "label",
    "name",
    "pattern",
    "placeholder",
    "role",
    "summary",
    "title",
    "value",
    "style",
    "xmlns",
];

/// DOMPurify's `DATA_URI_TAGS`: elements a `data:` URL is admitted on.
const DATA_URI_TAGS: &[&str] = &["audio", "video", "img", "source", "image", "track"];

/// The name a `noscript` tag is renamed to before ammonia parses it; see
/// `noscript_as_element`. It is removed with its content, as DOMPurify
/// removes `noscript`.
const NOSCRIPT_STANDIN: &str = "tugmark-noscript";

/// Elements whose content the HTML tokenizer reads as text up to their own
/// end tag (`plaintext` reads to the end of the input).
const RAW_TEXT_ELEMENTS: &[&str] = &[
    "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes",
];

/// Elements whose content DOMPurify drops along with the element when it
/// removes them (its default `FORBID_CONTENTS`). Every other disallowed
/// element is unwrapped and its content kept, which is ammonia's default
/// too. An entry the allow-list admits is skipped: an allowed element is
/// never removed, so its content rule never applies.
pub const FORBID_CONTENTS: &[&str] = &[
    "annotation-xml",
    "audio",
    "colgroup",
    "desc",
    "foreignobject",
    "head",
    "iframe",
    "math",
    "mi",
    "mn",
    "mo",
    "ms",
    "mtext",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    "style",
    "svg",
    "template",
    "thead",
    "title",
    "video",
    "xmp",
];

/// The allow-list file: its four lists, its two flags, and the shapes
/// `class` and `id` are held to.
#[derive(Debug)]
pub struct AllowList {
    pub allowed_tags: Vec<String>,
    pub allowed_attr: Vec<String>,
    pub forbid_tags: Vec<String>,
    pub forbid_attr: Vec<String>,
    pub allow_data_attr: bool,
    pub allow_aria_attr: bool,
    /// A `class` keeps only the tokens that open with one of these.
    pub class_prefixes: Vec<String>,
    /// The one shape an `id` survives in.
    pub id_shape: IdShape,
}

/// The footnote shape: an `id` survives only on `tag` carrying `class`,
/// and it and every `href="#…"` are moved under `prefix`, a namespace the
/// page owns, so content can name nothing the page's own ids name.
#[derive(Debug)]
pub struct IdShape {
    pub tag: String,
    pub class: String,
    pub prefix: String,
}

impl IdShape {
    /// `value` under the prefix; a value already under it is left as is,
    /// so a second sanitize (the page's barrier) changes nothing.
    pub fn prefixed(&self, value: &str) -> String {
        if value.starts_with(&self.prefix) {
            value.to_string()
        } else {
            format!("{}{value}", self.prefix)
        }
    }
}

/// The allow-list file, parsed once.
pub fn allowlist() -> &'static AllowList {
    static LIST: OnceLock<AllowList> = OnceLock::new();
    LIST.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(ALLOWLIST_JSON).expect("sanitize-allowlist.json is JSON");
        let list = |key: &str| -> Vec<String> {
            value[key]
                .as_array()
                .unwrap_or_else(|| panic!("sanitize-allowlist.json: `{key}` is a list"))
                .iter()
                .map(|v| {
                    v.as_str()
                        .unwrap_or_else(|| panic!("sanitize-allowlist.json: `{key}` holds strings"))
                        .to_string()
                })
                .collect()
        };
        let flag = |key: &str| -> bool {
            value[key]
                .as_bool()
                .unwrap_or_else(|| panic!("sanitize-allowlist.json: `{key}` is a boolean"))
        };
        let shape = &value["ID_SHAPE"];
        let field = |key: &str| -> String {
            shape[key]
                .as_str()
                .unwrap_or_else(|| panic!("sanitize-allowlist.json: `ID_SHAPE.{key}` is a string"))
                .to_string()
        };
        AllowList {
            allowed_tags: list("ALLOWED_TAGS"),
            allowed_attr: list("ALLOWED_ATTR"),
            forbid_tags: list("FORBID_TAGS"),
            forbid_attr: list("FORBID_ATTR"),
            allow_data_attr: flag("ALLOW_DATA_ATTR"),
            allow_aria_attr: flag("ALLOW_ARIA_ATTR"),
            class_prefixes: list("CLASS_PREFIXES"),
            id_shape: IdShape {
                tag: field("tag"),
                class: field("class"),
                prefix: field("prefix"),
            },
        }
    })
}

fn builder() -> &'static Builder<'static> {
    static BUILDER: OnceLock<Builder<'static>> = OnceLock::new();
    BUILDER.get_or_init(|| {
        let list = allowlist();
        let tags: HashSet<&'static str> = list
            .allowed_tags
            .iter()
            .filter(|t| !list.forbid_tags.contains(t))
            .map(String::as_str)
            .collect();
        let attributes: HashSet<&'static str> = list
            .allowed_attr
            .iter()
            .filter(|a| !list.forbid_attr.contains(a))
            .map(String::as_str)
            .collect();
        let clean_content: HashSet<&'static str> = FORBID_CONTENTS
            .iter()
            .copied()
            .filter(|t| !tags.contains(t))
            .chain([NOSCRIPT_STANDIN])
            .collect();
        let mut builder = Builder::default();
        let prefixes: HashSet<&'static str> = [
            list.allow_data_attr.then_some("data-"),
            list.allow_aria_attr.then_some("aria-"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !prefixes.is_empty() {
            builder.generic_attribute_prefixes(prefixes);
        }
        builder
            .tags(tags)
            // DOMPurify's `ALLOWED_ATTR` is global; ammonia's per-tag
            // defaults (`hreflang`, `width`, `colspan`, …) are not ours.
            .tag_attributes(HashMap::new())
            .generic_attributes(attributes)
            .clean_content_tags(clean_content)
            .url_schemes(URL_SCHEMES.iter().copied().collect())
            // ammonia adds `rel="noopener noreferrer"` to links by default;
            // DOMPurify adds nothing.
            .link_rel(None)
            .strip_comments(true)
            .attribute_filter(filter_attribute)
            // DOMPurify's `restrictInputs` hook pins every surviving input
            // disabled; the other half of that hook is `restrict_inputs`.
            .set_tag_attribute_value("input", "disabled", "");
        builder
    })
}

/// Sanitize one block's HTML to the allow-list's policy.
pub fn sanitize(html: &str) -> String {
    restrict_ids(&restrict_inputs(
        &builder().clean(&noscript_as_element(html)).to_string(),
    ))
}

/// `html` with every `noscript` tag renamed to `NOSCRIPT_STANDIN`, outside
/// comments, attribute values and raw-text content.
///
/// DOMPurify parses with `DOMParser`, whose documents have scripting
/// disabled, so `noscript` is an ordinary element: `<p><noscript><p>x</p>`
/// closes the outer paragraph and `x` survives as markup. html5ever's
/// fragment parser, which ammonia drives, has scripting enabled and no
/// option to turn it off, so `noscript` is raw text and `x` goes with it.
/// Renamed to an unknown name, the element parses as DOMPurify's does.
fn noscript_as_element(html: &str) -> Cow<'_, str> {
    if !html
        .as_bytes()
        .windows(8)
        .any(|w| w.eq_ignore_ascii_case(b"noscript"))
    {
        return Cow::Borrowed(html);
    }
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(html.len() + 32);
    let mut copied = 0;
    let mut raw_text: Option<&str> = None;
    let mut i = 0;
    while i < n {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if raw_text.is_none() && html[i..].starts_with("<!--") {
            i = html[i + 4..].find("-->").map_or(n, |off| i + 4 + off + 3);
            continue;
        }
        let closing = bytes.get(i + 1) == Some(&b'/');
        let name_start = i + 1 + usize::from(closing);
        if !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
            i += 1;
            continue;
        }
        let name_end = name_start
            + bytes[name_start..]
                .iter()
                .take_while(|b| !b.is_ascii_whitespace() && **b != b'/' && **b != b'>')
                .count();
        let name = html[name_start..name_end].to_ascii_lowercase();
        if let Some(open) = raw_text {
            if !(closing && name == open) {
                i = name_end;
                continue;
            }
            raw_text = None;
        }
        if name == "noscript" {
            out.push_str(&html[copied..name_start]);
            out.push_str(NOSCRIPT_STANDIN);
            copied = name_end;
        }
        // To the tag's `>`, stepping over quoted attribute values.
        let mut j = name_end;
        let mut quote = None;
        while j < n {
            let b = bytes[j];
            match quote {
                Some(q) if b == q => quote = None,
                Some(_) => {}
                None if b == b'"' || b == b'\'' => quote = Some(b),
                None if b == b'>' => break,
                None => {}
            }
            j += 1;
        }
        if !closing {
            if name == "plaintext" {
                break;
            }
            raw_text = RAW_TEXT_ELEMENTS.iter().copied().find(|t| *t == name);
        }
        i = j + 1;
    }
    out.push_str(&html[copied..]);
    Cow::Owned(out)
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(crate::transform::is_js_space)
}

/// DOMPurify's `ATTR_WHITESPACE`, removed from a value before
/// `IS_ALLOWED_URI` reads it: the class U+0000–U+0020, U+00A0, U+1680,
/// U+180E, U+2000–U+2029, U+205F, U+3000.
fn is_attr_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{20}' | '\u{a0}' | '\u{1680}' | '\u{180e}' | '\u{2000}'..='\u{2029}' | '\u{205f}' | '\u{3000}'
    )
}

/// `IS_ALLOWED_URI`:
/// `/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i`.
/// A safe scheme, or anything not shaped like a scheme: a value starting
/// with a non-letter, or whose leading run of scheme characters is not
/// followed by `:`.
fn is_allowed_uri(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if SAFE_URI_SCHEMES.iter().any(|scheme| {
        lower
            .strip_prefix(scheme)
            .is_some_and(|rest| rest.starts_with(':'))
    }) {
        return true;
    }
    let Some(first) = lower.chars().next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return true;
    }
    let is_scheme_char = |c: char| c.is_ascii_lowercase() || matches!(c, '+' | '.' | '-');
    lower.chars().find(|c| !is_scheme_char(*c)) != Some(':')
}

/// DOMPurify's `SAFE_FOR_XML` attribute test:
/// `/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i`.
fn breaks_out_of_xml(value: &str) -> bool {
    const RAW_TEXT: &[&str] = &[
        "style", "script", "title", "xmp", "textarea", "noscript", "iframe", "noembed", "noframes",
    ];
    let lower = value.to_ascii_lowercase();
    lower.contains("-->")
        || lower.contains("--!>")
        || lower.contains("]>")
        || lower.match_indices("</").any(|(at, _)| {
            let rest = &lower[at + 2..];
            RAW_TEXT.iter().any(|name| rest.starts_with(name))
        })
}

/// DOMPurify's per-attribute value rule (`_sanitizeAttributes` and
/// `_isValidAttribute`), run on every attribute the allow-list admits:
/// the value is trimmed, dropped if it could close an XML context, and
/// otherwise kept only if its attribute is URI-safe, it reads as a safe
/// URI, it is a `data:` URL on a `src`/`href` of a `DATA_URI_TAGS`
/// element, or it is empty. Then the allow-list's shapes: a `class` keeps
/// only its tokens in `CLASS_PREFIXES`, an `id` survives only on the
/// footnote shape's tag and moves under its prefix, and a fragment `href`
/// moves with it. The `id`'s class half is `restrict_ids`, which can see
/// the element's other attributes.
fn filter_attribute<'a>(tag: &str, name: &str, value: &'a str) -> Option<Cow<'a, str>> {
    let value = if name == "value" {
        value
    } else {
        js_trim(value)
    };
    if breaks_out_of_xml(value) {
        return None;
    }
    let stripped: String = value.chars().filter(|c| !is_attr_whitespace(*c)).collect();
    let kept = URI_SAFE_ATTRIBUTES.contains(&name)
        || is_allowed_uri(&stripped)
        || (matches!(name, "src" | "href" | "xlink:href")
            && tag != "script"
            && value.starts_with("data:")
            && DATA_URI_TAGS.contains(&tag))
        || value.is_empty();
    if !kept {
        return None;
    }
    let list = allowlist();
    match name {
        "class" => {
            let tokens: Vec<&str> = value
                .split_ascii_whitespace()
                .filter(|t| {
                    list.class_prefixes
                        .iter()
                        .any(|p| t.starts_with(p.as_str()))
                })
                .collect();
            (!tokens.is_empty()).then(|| Cow::Owned(tokens.join(" ")))
        }
        "id" => (tag == list.id_shape.tag).then(|| Cow::Owned(list.id_shape.prefixed(value))),
        "href" if value.len() > 1 && value.starts_with('#') => Some(Cow::Owned(format!(
            "#{}",
            list.id_shape.prefixed(&value[1..])
        ))),
        _ => Some(Cow::Borrowed(value)),
    }
}

/// Remove every `<input>` that is not a checkbox — the half of DOMPurify's
/// `restrictInputs` hook an attribute rule cannot express. A missing `type`
/// is not a checkbox, as `getAttribute("type") !== "checkbox"` reads it.
fn restrict_inputs(html: &str) -> String {
    let mut cuts = Vec::new();
    scan(html, |token| {
        if let Token::Start {
            name: "input",
            attrs,
            span,
        } = token
        {
            if attr(&attrs, "type") != Some("checkbox") {
                cuts.push(span);
            }
        }
    });
    if cuts.is_empty() {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    for span in cuts {
        out.push_str(&html[cursor..span.start]);
        cursor = span.end;
    }
    out.push_str(&html[cursor..]);
    out
}

/// Remove an `id` from any element that is not the footnote shape — the
/// half of the `id` rule the attribute filter cannot see, since it needs
/// the element's `class`. ammonia serializes each attribute as
/// ` name="value"` with `"` escaped inside values, so ` id="` in a tag
/// can only open the `id` attribute.
fn restrict_ids(html: &str) -> String {
    let shape = &allowlist().id_shape;
    let mut cuts = Vec::new();
    scan(html, |token| {
        if let Token::Start { name, attrs, span } = token {
            if attr(&attrs, "id").is_none() {
                return;
            }
            let fits = name == shape.tag
                && attr(&attrs, "class")
                    .is_some_and(|c| c.split_ascii_whitespace().any(|t| t == shape.class));
            if fits {
                return;
            }
            let tag = &html[span.clone()];
            if let Some(at) = tag.find(" id=\"") {
                let open = at + " id=\"".len();
                if let Some(len) = tag[open..].find('"') {
                    cuts.push(span.start + at..span.start + open + len + 1);
                }
            }
        }
    });
    if cuts.is_empty() {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    for span in cuts {
        out.push_str(&html[cursor..span.start]);
        cursor = span.end;
    }
    out.push_str(&html[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowlist_parses() {
        let list = allowlist();
        assert!(list.allowed_tags.iter().any(|t| t == "input"));
        assert!(list.allowed_attr.iter().any(|a| a == "start"));
        assert!(list.forbid_tags.iter().any(|t| t == "script"));
        assert!(list.forbid_attr.iter().any(|a| a == "onclick"));
    }

    #[test]
    fn script_is_removed_with_its_content() {
        assert_eq!(sanitize("<p>a</p><script>alert(1)</script>"), "<p>a</p>");
    }

    #[test]
    fn event_handlers_are_removed() {
        assert_eq!(sanitize(r#"<p onclick="x()">a</p>"#), "<p>a</p>");
        assert_eq!(
            sanitize(r#"<img src="a.png" onerror="x()">"#),
            r#"<img src="a.png">"#
        );
    }

    #[test]
    fn javascript_urls_are_removed() {
        assert_eq!(
            sanitize(r#"<a href="javascript:alert(1)">x</a>"#),
            "<a>x</a>"
        );
        assert_eq!(
            sanitize(r#"<a href="https://example.com">x</a>"#),
            r#"<a href="https://example.com">x</a>"#
        );
        assert_eq!(
            sanitize("<a href=\"#fn1\">1</a>"),
            "<a href=\"#tugfn-fn1\">1</a>"
        );
    }

    #[test]
    fn links_gain_no_rel() {
        assert!(!sanitize(r#"<a href="https://example.com">x</a>"#).contains("rel="));
    }

    #[test]
    fn a_raw_text_input_is_removed() {
        assert_eq!(
            sanitize(r#"<p>a<input type="text" value="v">b</p>"#),
            "<p>ab</p>"
        );
        assert_eq!(sanitize("<p>a<input>b</p>"), "<p>ab</p>");
    }

    #[test]
    fn a_task_list_checkbox_survives_disabled() {
        let html = sanitize(
            "<ul>\n<li><input disabled=\"\" type=\"checkbox\" checked=\"\"/>\ndone</li>\n</ul>\n",
        );
        assert!(html.contains("type=\"checkbox\""), "{html}");
        assert!(html.contains("disabled=\"\""), "{html}");
        assert!(html.contains("checked=\"\""), "{html}");
        let typed = sanitize(r#"<p><input type="checkbox">x</p>"#);
        assert!(typed.contains("disabled=\"\""), "{typed}");
    }

    #[test]
    fn noscript_parses_as_an_ordinary_element() {
        assert_eq!(
            sanitize("<p><noscript><p>x</p></noscript></p>"),
            "<p></p><p>x</p><p></p>"
        );
        assert_eq!(
            sanitize("<div><noscript><b>gone</b></noscript>kept</div>"),
            "<div>kept</div>"
        );
        assert_eq!(
            noscript_as_element(
                r#"<!--<noscript>--><a title="<noscript>"><textarea><noscript></textarea>"#
            ),
            r#"<!--<noscript>--><a title="<noscript>"><textarea><noscript></textarea>"#
        );
    }

    #[test]
    fn attribute_values_follow_dompurify() {
        assert_eq!(sanitize(r#"<p title="--><x>">a</p>"#), "<p>a</p>");
        assert_eq!(sanitize(r#"<p title="</style>">a</p>"#), "<p>a</p>");
        assert_eq!(
            sanitize(r#"<ol start="javascript:x"><li>a</li></ol>"#),
            "<ol><li>a</li></ol>"
        );
        assert_eq!(
            sanitize(r#"<a href=" https://x.invalid/ ">a</a>"#),
            r#"<a href="https://x.invalid/">a</a>"#
        );
        assert_eq!(
            sanitize(r#"<img src="data:image/png;base64,AA">"#),
            r#"<img src="data:image/png;base64,AA">"#
        );
        assert_eq!(sanitize(r#"<a href="data:text/html,x">a</a>"#), "<a>a</a>");
        assert_eq!(sanitize(r#"<img src="DATA:image/png;base64,AA">"#), "<img>");
        assert_eq!(
            sanitize(r#"<p data-x="1" aria-label="a" title="t">a</p>"#),
            r#"<p title="t">a</p>"#
        );
        assert!(is_allowed_uri("a/b:c") && is_allowed_uri("#x") && is_allowed_uri("/x"));
        assert!(!is_allowed_uri("custom-scheme:x") && !is_allowed_uri(""));
    }

    #[test]
    fn allowed_attributes_survive_and_others_do_not() {
        assert_eq!(
            sanitize(r#"<ol start="3" data-x="1" style="color:red"><li>a</li></ol>"#),
            r#"<ol start="3"><li>a</li></ol>"#
        );
        assert_eq!(
            sanitize(r#"<div class="footnote-definition" id="1">x</div>"#),
            r#"<div class="footnote-definition" id="tugfn-1">x</div>"#
        );
    }

    #[test]
    fn class_keeps_only_the_parsers_vocabulary() {
        assert_eq!(
            sanitize(r#"<pre><code class="language-rust tug-syn-keyword x">a</code></pre>"#),
            r#"<pre><code class="language-rust">a</code></pre>"#
        );
        assert_eq!(
            sanitize(r#"<div class="tugx-katex">a</div>"#),
            "<div>a</div>"
        );
        assert_eq!(
            sanitize(r#"<sup class="footnote-reference">1</sup>"#),
            r#"<sup class="footnote-reference">1</sup>"#
        );
    }

    #[test]
    fn id_survives_only_on_a_footnote_definition_under_the_prefix() {
        assert_eq!(sanitize(r#"<h1 id="top">a</h1>"#), "<h1>a</h1>");
        assert_eq!(sanitize(r#"<div id="root">a</div>"#), "<div>a</div>");
        assert_eq!(
            sanitize(r#"<div class="note" id="root">a</div>"#),
            "<div>a</div>"
        );
        assert_eq!(
            sanitize(r#"<div class="footnote-definition" id="tugfn-1">x</div>"#),
            r#"<div class="footnote-definition" id="tugfn-1">x</div>"#
        );
        assert_eq!(sanitize(r##"<a href="#">a</a>"##), r##"<a href="#">a</a>"##);
        assert_eq!(
            sanitize(r##"<a href="#tugfn-1">a</a>"##),
            r##"<a href="#tugfn-1">a</a>"##
        );
    }
}
