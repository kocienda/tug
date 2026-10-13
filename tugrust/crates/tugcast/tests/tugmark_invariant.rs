//! The sanitizer's invariant, asserted over everything tugmark emits.
//!
//! The drift golden holds tugcast's rendering equal to the page's, which
//! catches a difference between the two and nothing that is wrong on both.
//! This test asserts what must be true of any output, whatever produced it,
//! reparsed by html5ever's tokenizer rather than by tugmark's own scanner:
//!
//! - every element is in the allow-list's `ALLOWED_TAGS`;
//! - every attribute is in `ALLOWED_ATTR`;
//! - every `href` and `src` is relative, a fragment, or a safe scheme
//!   (`data:` only on `img src`);
//! - no `data-` or `aria-` attribute survives;
//!
//! except for the vocabulary tugmark's transforms and highlighter write
//! after the sanitizer, each held to the one shape that writes it.
//! And `class` and `id` hold their shapes: every `class` token is
//! pulldown-cmark's (`CLASS_PREFIXES`) or a post-sanitize class on its own
//! element, an `id` stands only on the footnote definition under the page's
//! prefix, and every fragment `href` points under it.
//!
//! The cases: every block of the golden, and every payload of DOMPurify's
//! own regression corpus (`corpus/dompurify/payloads.json`, vendored by
//! `tugdeck/scripts/import-dompurify-fixtures.ts`) rendered as markdown with
//! highlighting on, as tugcast renders a turn, and sanitized directly as HTML;
//! and a seeded fuzz, random fragments built from `corpus/fuzz/atoms.json`
//! the same way the page's fuzz builds them, through the same two paths.
//! CI runs it at a fixed seed; `just tugmark-fuzz` runs it at a fresh one
//! (`TUGMARK_FUZZ_SEED`, `TUGMARK_FUZZ_CASES`).

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;

use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    BufferQueue, StartTag, TagToken, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};
use serde_json::Value;
use tugmark::{Highlight, render_blocks};

fn deck_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tugdeck")
}

fn read_json(rel: &str) -> Value {
    let path = deck_dir().join(rel);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

struct Policy {
    tags: HashSet<String>,
    attrs: HashSet<String>,
    class_prefixes: Vec<String>,
    id_tag: String,
    id_class: String,
    id_prefix: String,
}

fn policy() -> Policy {
    let list = read_json("src/lib/markdown/sanitize-allowlist.json");
    let set = |key: &str| -> HashSet<String> {
        list[key]
            .as_array()
            .unwrap_or_else(|| panic!("{key} is not a list"))
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    let shape = |key: &str| list["ID_SHAPE"][key].as_str().unwrap().to_string();
    Policy {
        tags: set("ALLOWED_TAGS"),
        attrs: set("ALLOWED_ATTR"),
        class_prefixes: set("CLASS_PREFIXES").into_iter().collect(),
        id_tag: shape("tag"),
        id_class: shape("class"),
        id_prefix: shape("prefix"),
    }
}

/// One start tag: its name and its attributes, in source order.
type StartTagSeen = (String, Vec<(String, String)>);

#[derive(Default)]
struct StartTags(RefCell<Vec<StartTagSeen>>);

impl TokenSink for StartTags {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        if let TagToken(tag) = token {
            if tag.kind == StartTag {
                let attrs = tag
                    .attrs
                    .iter()
                    .map(|a| (a.name.local.to_string(), a.value.to_string()))
                    .collect();
                self.0.borrow_mut().push((tag.name.to_string(), attrs));
            }
        }
        TokenSinkResult::Continue
    }
}

fn start_tags(html: &str) -> Vec<StartTagSeen> {
    let tokenizer = Tokenizer::new(StartTags::default(), TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(html));
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.0.take()
}

fn class_has(attrs: &[(String, String)], prefix: &str) -> bool {
    attrs
        .iter()
        .any(|(n, v)| n == "class" && v.split_whitespace().any(|c| c.starts_with(prefix)))
}

/// The post-sanitize vocabulary: an element or attribute the policy refuses,
/// admitted only in the shape tugmark itself writes it.
fn post_sanitize(tag: &str, attrs: &[(String, String)], attr: Option<&str>) -> bool {
    match (tag, attr) {
        ("span", None) => class_has(attrs, "tug-syn-"),
        ("span", Some("class")) => true,
        ("code", Some("data-tug-highlighted")) => true,
        ("div", Some("data-tugx-math" | "data-tugx-math-pending")) => {
            class_has(attrs, "tugx-katex")
        }
        ("div", Some("data-tugx-mermaid-pending")) => class_has(attrs, "tugx-mermaid"),
        _ => false,
    }
}

/// Whether a URL is relative or names a safe scheme, read as the URL parser
/// reads it: leading and trailing C0 controls and spaces stripped, tabs and
/// newlines removed, and a scheme only where the value opens with a letter
/// and scheme characters up to a colon. Anything else resolves relative.
fn url_is_safe(tag: &str, name: &str, value: &str) -> bool {
    let url: String = value
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let scheme_len = url
        .chars()
        .enumerate()
        .take_while(|&(i, c)| {
            c.is_ascii_alphabetic()
                || (i > 0 && (c.is_ascii_digit() || matches!(c, '+' | '-' | '.')))
        })
        .count();
    if scheme_len == 0 || !url[scheme_len..].starts_with(':') {
        return true;
    }
    let scheme = url[..scheme_len].to_ascii_lowercase();
    let scheme = scheme.as_str();
    if scheme == "data" {
        return tag == "img" && name == "src";
    }
    tugmark::sanitize::SAFE_URI_SCHEMES.contains(&scheme)
}

/// Whether every token of a `class` is pulldown-cmark's or a post-sanitize
/// class on its own element.
fn class_fits(policy: &Policy, tag: &str, value: &str) -> bool {
    value.split_ascii_whitespace().all(|t| {
        policy
            .class_prefixes
            .iter()
            .any(|p| t.starts_with(p.as_str()))
            || (tag == "span" && t.starts_with("tug-syn-"))
            || (tag == "div" && (t.starts_with("tugx-katex") || t == "tugx-mermaid"))
    })
}

/// Whether an `id` stands in the footnote shape, under the page's prefix.
fn id_fits(policy: &Policy, tag: &str, attrs: &[(String, String)], value: &str) -> bool {
    tag == policy.id_tag
        && attrs
            .iter()
            .any(|(n, v)| n == "class" && v.split_ascii_whitespace().any(|t| t == policy.id_class))
        && value.starts_with(&policy.id_prefix)
}

/// Every violation of the invariant in `html`, as a readable line.
fn violations(policy: &Policy, html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (tag, attrs) in start_tags(html) {
        if !policy.tags.contains(&tag) && !post_sanitize(&tag, &attrs, None) {
            out.push(format!("element <{tag}>"));
        }
        for (name, value) in &attrs {
            let admitted = policy.attrs.contains(name)
                && !name.starts_with("data-")
                && !name.starts_with("aria-");
            if !admitted && !post_sanitize(&tag, &attrs, Some(name)) {
                out.push(format!("attribute {name} on <{tag}>"));
            }
            if (name == "href" || name == "src") && !url_is_safe(&tag, name, value) {
                out.push(format!("url {name}={value:?} on <{tag}>"));
            }
            if name == "class" && !class_fits(policy, &tag, value) {
                out.push(format!("class {value:?} on <{tag}>"));
            }
            if name == "id" && !id_fits(policy, &tag, &attrs, value) {
                out.push(format!("id {value:?} on <{tag}>"));
            }
            if name == "href"
                && value.len() > 1
                && value.starts_with('#')
                && !value[1..].starts_with(&policy.id_prefix)
            {
                out.push(format!("fragment href={value:?} on <{tag}>"));
            }
        }
    }
    out
}

#[test]
fn every_golden_block_holds_the_invariant() {
    let policy = policy();
    let golden = read_json("crates/tugmark/corpus/golden.json");
    let mut checked = 0;
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        for block in case["blocks"].as_array().unwrap() {
            let html = block["html"].as_str().unwrap();
            for v in violations(&policy, html) {
                failures.push(format!("{}: {v}", block["hash"]));
            }
            checked += 1;
        }
    }
    assert!(checked > 200, "the golden has {checked} blocks");
    assert!(
        failures.is_empty(),
        "invariant broken:\n{}",
        failures.join("\n")
    );
}

#[test]
fn every_dompurify_payload_holds_the_invariant() {
    let policy = policy();
    let fixtures = read_json("crates/tugmark/corpus/dompurify/payloads.json");
    let cases = fixtures["cases"].as_array().unwrap();
    assert!(
        cases.len() > 200,
        "DOMPurify's corpus has {} payloads",
        cases.len()
    );
    let mut failures = Vec::new();
    for case in cases {
        let title = case["title"].as_str().unwrap();
        let payload = case["payload"].as_str().unwrap();
        for block in render_blocks(payload, Highlight::On) {
            for v in violations(&policy, &block.html) {
                failures.push(format!("{title} (markdown): {v}"));
            }
        }
        for v in violations(&policy, &tugmark::sanitize::sanitize(payload)) {
            failures.push(format!("{title} (html): {v}"));
        }
    }
    assert!(
        failures.is_empty(),
        "invariant broken:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_invariant_catches_what_it_names() {
    let policy = policy();
    for (html, expect) in [
        ("<script>x</script>", "element <script>"),
        ("<p onclick=\"x\">a</p>", "attribute onclick on <p>"),
        (
            "<a href=\"javascript:alert(1)\">a</a>",
            "url href=\"javascript:alert(1)\" on <a>",
        ),
        ("<p data-x=\"1\">a</p>", "attribute data-x on <p>"),
        (
            "<a href=\"data:text/html,x\">a</a>",
            "url href=\"data:text/html,x\" on <a>",
        ),
        ("<span>a</span>", "element <span>"),
        (
            "<p data-tugx-math=\"display\">a</p>",
            "attribute data-tugx-math on <p>",
        ),
        (
            "<p class=\"tugx-katex\">a</p>",
            "class \"tugx-katex\" on <p>",
        ),
        (
            "<span class=\"tugx-mermaid\">a</span>",
            "class \"tugx-mermaid\" on <span>",
        ),
        ("<h1 id=\"top\">a</h1>", "id \"top\" on <h1>"),
        (
            "<div class=\"footnote-definition\" id=\"1\">a</div>",
            "id \"1\" on <div>",
        ),
        ("<a href=\"#top\">a</a>", "fragment href=\"#top\" on <a>"),
    ] {
        assert!(
            violations(&policy, html).iter().any(|v| v == expect),
            "{html} should report {expect}"
        );
    }
    assert!(
        violations(
            &policy,
            "<p><a href=\"https://x/a:b\">a</a> <a href=\"#tugfn-1\">1</a></p><div class=\"footnote-definition\" id=\"tugfn-1\">n</div>"
        )
        .is_empty()
    );
}

/// mulberry32, the stream the page's fuzz draws from too.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        t ^ (t >> 14)
    }

    fn below(&mut self, n: usize) -> usize {
        self.next() as usize % n
    }
}

/// `count` cases from `seed`: one to ten atoms joined by separators, each atom
/// cut short, spliced with a hazard, uppercased, or left whole. The draws are
/// made in the order the page's `fuzzCases` makes them, over code points.
fn fuzz_cases(seed: u32, count: usize) -> Vec<String> {
    let alphabet = read_json("crates/tugmark/corpus/fuzz/atoms.json");
    let strings = |key: &str| -> Vec<String> {
        alphabet[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    let (atoms, separators) = (strings("atoms"), strings("separators"));
    let hazards: Vec<char> = alphabet["hazards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| char::from_u32(v.as_u64().unwrap() as u32).unwrap())
        .collect();
    let mut rng = Mulberry32(seed);
    (0..count)
        .map(|_| {
            let n = 1 + rng.below(10);
            let mut text = String::new();
            for j in 0..n {
                if j > 0 {
                    text.push_str(&separators[rng.below(separators.len())]);
                }
                let mut atom: Vec<char> = atoms[rng.below(atoms.len())].chars().collect();
                match rng.below(8) {
                    0 => atom.truncate(rng.below(atom.len() + 1)),
                    1 => {
                        let at = rng.below(atom.len() + 1);
                        atom.insert(at, hazards[rng.below(hazards.len())]);
                    }
                    2 => atom.iter_mut().for_each(|c| c.make_ascii_uppercase()),
                    _ => {}
                }
                text.extend(atom);
            }
            text
        })
        .collect()
}

fn env_number(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().map_or(default, |v| {
        v.parse().unwrap_or_else(|e| panic!("{name}={v:?}: {e}"))
    })
}

#[test]
fn a_seed_builds_the_cases_the_page_builds() {
    let sample = &read_json("crates/tugmark/corpus/fuzz/atoms.json")["sample"];
    let expected: Vec<String> = sample["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        fuzz_cases(sample["seed"].as_u64().unwrap() as u32, expected.len()),
        expected
    );
}

#[test]
fn fuzz_holds_the_invariant() {
    let seed = env_number("TUGMARK_FUZZ_SEED", 20_261_012);
    let count = env_number("TUGMARK_FUZZ_CASES", 2_000) as usize;
    let policy = policy();
    let mut failures = Vec::new();
    for (i, text) in fuzz_cases(seed, count).iter().enumerate() {
        let rendered = render_blocks(text, Highlight::On)
            .into_iter()
            .map(|b| ("markdown", b.html));
        for (path, html) in rendered.chain([("html", tugmark::sanitize::sanitize(text))]) {
            for v in violations(&policy, &html) {
                failures.push(format!("case {i} ({path}): {v} in {text:?}"));
            }
        }
        if failures.len() >= 20 {
            break;
        }
    }
    assert!(
        failures.is_empty(),
        "seed {seed}, {count} cases; invariant broken:\n{}",
        failures.join("\n")
    );
}
