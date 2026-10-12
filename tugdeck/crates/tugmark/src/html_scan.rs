//! A tokenizer over the HTML ammonia serializes, and nothing wider.
//!
//! ammonia keeps its DOM behind `--cfg ammonia_unstable`, and depending on
//! `html5ever` directly would leave this crate tracking ammonia's version of
//! it in two lock files. What the post-sanitize passes need is far smaller
//! than a DOM: the elements and the text nodes, in order. The HTML
//! serialization algorithm `ammonia::Document`'s `Display` runs gives that
//! for free, because its output is canonical:
//!
//! - every `<` in text is written `&lt;`, so a `<` in the output always opens
//!   a tag, and every attribute value is double-quoted with `"` written
//!   `&quot;`;
//! - names are lowercase, and void elements carry no end tag;
//! - the sanitizer admits no raw-text element (`script`, `style`,
//!   `textarea`, `title`), so no element's content is anything but markup.
//!
//! Text between two tags is exactly one DOM text node, which is the boundary
//! the find extraction depends on. Input this did not come from ammonia —
//! the transformers' placeholders — is built in the same shape.

use std::ops::Range;

/// One token of serialized HTML.
pub(crate) enum Token<'a> {
    /// A start tag: its lowercase name, its attributes (values decoded),
    /// and its byte span in the input, `<` through `>`.
    Start {
        name: &'a str,
        attrs: Vec<(&'a str, String)>,
        span: Range<usize>,
    },
    /// An end tag.
    End { name: &'a str },
    /// One text node, entities decoded.
    Text(String),
}

/// Elements that never take an end tag.
pub(crate) fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

/// Walk `html`, calling `on_token` for each tag and text node in order.
/// Comments and doctypes are skipped.
pub(crate) fn scan<'a>(html: &'a str, mut on_token: impl FnMut(Token<'a>)) {
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if bytes[i] != b'<' {
            let end = html[i..].find('<').map_or(n, |off| i + off);
            on_token(Token::Text(decode_entities(&html[i..end])));
            i = end;
            continue;
        }
        let start = i;
        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map_or(n, |off| i + off + 3);
            continue;
        }
        if html[i..].starts_with("<!") || html[i..].starts_with("<?") {
            i = html[i..].find('>').map_or(n, |off| i + off + 1);
            continue;
        }
        if html[i..].starts_with("</") {
            let close = html[i..].find('>').map_or(n, |off| i + off);
            on_token(Token::End {
                name: html[i + 2..close].trim(),
            });
            i = (close + 1).min(n);
            continue;
        }
        // Start tag: name, then attributes up to the closing `>`.
        i += 1;
        let name_start = i;
        while i < n && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/' {
            i += 1;
        }
        let name = &html[name_start..i];
        let mut attrs = Vec::new();
        loop {
            while i < n && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
                i += 1;
            }
            if i >= n || bytes[i] == b'>' {
                break;
            }
            let attr_start = i;
            while i < n
                && !bytes[i].is_ascii_whitespace()
                && bytes[i] != b'='
                && bytes[i] != b'>'
                && bytes[i] != b'/'
            {
                i += 1;
            }
            let attr_name = &html[attr_start..i];
            let mut value = String::new();
            if i < n && bytes[i] == b'=' {
                i += 1;
                if i < n && (bytes[i] == b'"' || bytes[i] == b'\'') {
                    let quote = bytes[i] as char;
                    let value_start = i + 1;
                    let value_end = html[value_start..].find(quote).map_or(n, |off| value_start + off);
                    value = decode_entities(&html[value_start..value_end]);
                    i = (value_end + 1).min(n);
                } else {
                    let value_start = i;
                    while i < n && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                        i += 1;
                    }
                    value = decode_entities(&html[value_start..i]);
                }
            }
            attrs.push((attr_name, value));
        }
        i = (i + 1).min(n);
        on_token(Token::Start {
            name,
            attrs,
            span: start..i,
        });
    }
}

/// Decode the character references an HTML serializer writes, plus numeric
/// references. Anything else is left as written.
pub(crate) fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest.find(';').and_then(|semi| {
            let body = &rest[1..semi];
            let ch = match body {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => body.strip_prefix('#').and_then(|num| {
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => num.parse::<u32>().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            ch.map(|c| (c, semi + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The value of attribute `name` among `attrs`, if present.
pub(crate) fn attr<'v>(attrs: &'v [(&str, String)], name: &str) -> Option<&'v str> {
    attrs.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(html: &str) -> Vec<String> {
        let mut out = Vec::new();
        scan(html, |t| {
            out.push(match t {
                Token::Start { name, attrs, .. } => format!(
                    "<{name}{}>",
                    attrs.iter().map(|(n, v)| format!(" {n}={v}")).collect::<String>()
                ),
                Token::End { name } => format!("</{name}>"),
                Token::Text(text) => format!("[{text}]"),
            })
        });
        out
    }

    #[test]
    fn tags_attributes_and_text_in_order() {
        assert_eq!(
            tokens(r#"<p class="a b">x &amp; y<br>z</p>"#),
            vec!["<p class=a b>", "[x & y]", "<br>", "[z]", "</p>"]
        );
    }

    #[test]
    fn a_left_angle_inside_an_attribute_value_is_not_a_tag() {
        assert_eq!(
            tokens(r#"<a title="<input>">t</a>"#),
            vec!["<a title=<input>>", "[t]", "</a>"]
        );
    }

    #[test]
    fn numeric_and_unknown_references() {
        assert_eq!(decode_entities("&#36;&#x24;&bogus;&"), "$$&bogus;&");
    }
}
