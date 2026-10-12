//! find_index — transcript find as a query over the text tugcast renders.
//!
//! The deck's find engine asks one question per search: for these units (a
//! session's assistant-text and thinking Messages, by message key, in
//! transcript order), what matches the query? The text searched is each
//! unit's rendered text — `tugmark::rendered_text`, the native mirror of the
//! page's `markdownToText` — which `RenderStage` keeps for every Message it
//! has seen, live or replayed.
//!
//! Literal mode answers with matches, computed here by a matcher that
//! reproduces what the page's own `RegExp` would find for the escaped
//! literal: UTF-16 code units, ECMAScript's non-unicode `Canonicalize` for a
//! case-insensitive search, `\b` over ASCII word characters, non-overlapping
//! left-to-right, at most `limit` matches across the units in order. Grep
//! mode answers with the units' texts, because a JavaScript regular
//! expression cannot be reproduced faithfully here and the page compiles it
//! itself. Either way the mounted units' texts come back too, so the page's
//! painter can compare what was searched against what is on screen, and a
//! unit tugcast holds no text for is reported `missing` for the page to
//! project itself.
//!
//! Pure: the stage hands over owned text, and the answer is built on a
//! blocking thread.

use std::collections::{BTreeMap, HashSet};

use super::render_bridge::{FindMatch, FindOptions, RenderedFrame};

/// Where one unit's searchable text comes from.
#[derive(Debug)]
pub enum UnitText {
    /// Rendered text, current for the Message's text.
    Ready(String),
    /// Source text whose rendered text has not been extracted, or has gone
    /// stale: extracted on the blocking thread, and handed back to the stage
    /// with the source's hash so it can be kept.
    Extract { source: String },
    /// Nothing held.
    Missing,
}

/// One find query, with every unit's text owned.
#[derive(Debug)]
pub struct FindJob {
    pub request_id: String,
    pub tug_session_id: String,
    pub query: String,
    pub options: FindOptions,
    pub limit: u32,
    /// The searched units, in order.
    pub units: Vec<(String, UnitText)>,
    /// The mounted units whose text the answer carries.
    pub mounted: Vec<(String, UnitText)>,
}

/// A rendered text extracted while answering, for the stage to keep.
#[derive(Debug)]
pub struct Extracted {
    pub unit: String,
    /// `tugmark::text_hash` of the source it was extracted from.
    pub source_hash: u64,
    pub text: String,
}

/// What answering produced.
#[derive(Debug)]
pub struct FindAnswer {
    pub frame: RenderedFrame,
    pub extracted: Vec<Extracted>,
}

impl FindJob {
    /// Answer the query.
    pub fn answer(self) -> FindAnswer {
        let mut extracted = Vec::new();
        let mut resolve = |unit: &str, text: UnitText| -> Option<String> {
            match text {
                UnitText::Ready(text) => Some(text),
                UnitText::Extract { source } => {
                    let text = tugmark::rendered_text(&tugmark::render_blocks(
                        &source,
                        tugmark::Highlight::Off,
                    ));
                    extracted.push(Extracted {
                        unit: unit.to_string(),
                        source_hash: tugmark::text_hash(&source),
                        text: text.clone(),
                    });
                    Some(text)
                }
                UnitText::Missing => None,
            }
        };

        let mut missing: Vec<String> = Vec::new();
        let mut texts: BTreeMap<String, String> = BTreeMap::new();
        let mut matches: Vec<FindMatch> = Vec::new();
        let query: Vec<u16> = self.query.encode_utf16().collect();
        let mut room = self.limit as usize;
        let mounted: HashSet<String> = self.mounted.iter().map(|(unit, _)| unit.clone()).collect();

        for (unit, text) in self.units {
            let Some(text) = resolve(&unit, text) else {
                missing.push(unit);
                continue;
            };
            if !self.options.grep && room > 0 {
                let haystack: Vec<u16> = text.encode_utf16().collect();
                for (start, end) in literal_matches(&haystack, &query, self.options, room) {
                    matches.push(FindMatch {
                        unit: unit.clone(),
                        start,
                        end,
                    });
                }
                room = (self.limit as usize).saturating_sub(matches.len());
            }
            // A searched unit that is also mounted carries its text from
            // here, so it is never resolved twice.
            if self.options.grep || mounted.contains(&unit) {
                texts.insert(unit, text);
            }
        }
        for (unit, text) in self.mounted {
            if texts.contains_key(&unit) {
                continue;
            }
            match resolve(&unit, text) {
                Some(text) => {
                    texts.insert(unit, text);
                }
                None => {
                    if !missing.contains(&unit) {
                        missing.push(unit);
                    }
                }
            }
        }

        let frame = RenderedFrame::FindResult {
            request_id: self.request_id,
            tug_session_id: self.tug_session_id,
            invalid: None,
            matches: (!self.options.grep).then_some(matches),
            texts: (!texts.is_empty()).then_some(texts),
            missing,
        };
        FindAnswer { frame, extracted }
    }
}

/// ECMAScript's `Canonicalize` for a non-unicode, ignore-case pattern: the
/// code unit's uppercase, unless that is not one code unit, or would carry
/// a non-ASCII unit into ASCII.
pub fn canonicalize(unit: u16) -> u16 {
    let Some(ch) = char::from_u32(unit as u32) else {
        // A lone surrogate has no case.
        return unit;
    };
    let mut upper = ch.to_uppercase();
    let (Some(first), None) = (upper.next(), upper.next()) else {
        return unit;
    };
    let mut buf = [0u16; 2];
    let encoded = first.encode_utf16(&mut buf);
    if encoded.len() != 1 {
        return unit;
    }
    let mapped = encoded[0];
    if unit >= 128 && mapped < 128 {
        return unit;
    }
    mapped
}

/// `\w` for a non-unicode pattern: ASCII letters, digits and `_`.
fn is_word(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5A | 0x5F | 0x61..=0x7A)
}

/// `\b` at `at`: the word-ness of the units either side differs, with the
/// text's ends counting as non-word.
fn is_boundary(text: &[u16], at: usize) -> bool {
    let before = at > 0 && is_word(text[at - 1]);
    let after = at < text.len() && is_word(text[at]);
    before != after
}

/// Every non-overlapping match of the literal `query` in `text`, left to
/// right, as UTF-16 `[start, end)`, at most `limit` of them: what
/// `new RegExp(escaped, caseSensitive ? "g" : "gi")` — wrapped `\b(?:…)\b`
/// for a whole word — finds by repeated `exec`.
pub fn literal_matches(
    text: &[u16],
    query: &[u16],
    options: FindOptions,
    limit: usize,
) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let n = query.len();
    if n == 0 || n > text.len() || limit == 0 {
        return out;
    }
    let folded: Vec<u16> = if options.case_sensitive {
        query.to_vec()
    } else {
        query.iter().map(|&u| canonicalize(u)).collect()
    };
    let same = |a: u16, b: u16| {
        if options.case_sensitive {
            a == b
        } else {
            canonicalize(a) == b
        }
    };
    let mut i = 0;
    while i + n <= text.len() {
        let hit = (0..n).all(|k| same(text[i + k], folded[k]))
            && (!options.whole_word || (is_boundary(text, i) && is_boundary(text, i + n)));
        if hit {
            out.push((i as u32, (i + n) as u32));
            if out.len() >= limit {
                break;
            }
            i += n;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn opts(case_sensitive: bool, whole_word: bool, grep: bool) -> FindOptions {
        FindOptions {
            case_sensitive,
            whole_word,
            grep,
        }
    }

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn job(
        options: FindOptions,
        units: Vec<(&str, UnitText)>,
        mounted: Vec<(&str, UnitText)>,
    ) -> FindJob {
        FindJob {
            request_id: "r1".into(),
            tug_session_id: "s1".into(),
            query: "two".into(),
            options,
            limit: 100,
            units: units.into_iter().map(|(u, t)| (u.to_string(), t)).collect(),
            mounted: mounted
                .into_iter()
                .map(|(u, t)| (u.to_string(), t))
                .collect(),
        }
    }

    /// The page's `search()` over each row of `find-parity.json`, which the
    /// deck's test regenerates and holds current, reproduced here.
    #[test]
    fn the_matcher_reproduces_the_pages_regexp() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tugdeck/src/lib/__tests__/fixtures/find-parity.json");
        let raw = std::fs::read_to_string(&path).expect("find-parity.json");
        let rows: Vec<Value> = serde_json::from_str(&raw).expect("parses");
        assert!(rows.len() >= 20, "the fixture carries its cases");
        for row in rows {
            let text = row["text"].as_str().unwrap();
            let query = row["query"].as_str().unwrap();
            let options = opts(
                row["caseSensitive"].as_bool().unwrap(),
                row["wholeWord"].as_bool().unwrap(),
                false,
            );
            let expected: Vec<(u32, u32)> = row["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| (m[0].as_u64().unwrap() as u32, m[1].as_u64().unwrap() as u32))
                .collect();
            let got = literal_matches(&utf16(text), &utf16(query), options, usize::MAX);
            assert_eq!(got, expected, "{text:?} / {query:?} / {options:?}");
        }
    }

    #[test]
    fn canonicalize_follows_the_non_unicode_rule() {
        assert_eq!(canonicalize('a' as u16), 'A' as u16);
        // ſ uppercases to S, which would carry it into ASCII: it stays.
        assert_eq!(canonicalize(0x017F), 0x017F);
        // ß uppercases to two units: it stays.
        assert_eq!(canonicalize(0x00DF), 0x00DF);
        // The Kelvin sign is already uppercase.
        assert_eq!(canonicalize(0x212A), 0x212A);
        assert_eq!(canonicalize(0x03C3), 0x03A3); // σ → Σ
        assert_eq!(canonicalize(0xD83D), 0xD83D); // a lone surrogate
    }

    #[test]
    fn the_limit_runs_across_units_in_order() {
        let mut j = job(
            opts(false, false, false),
            vec![
                ("a", UnitText::Ready("two two".into())),
                ("b", UnitText::Ready("two".into())),
            ],
            vec![],
        );
        j.limit = 2;
        let FindAnswer { frame, .. } = j.answer();
        let RenderedFrame::FindResult { matches, .. } = frame else {
            panic!()
        };
        let units: Vec<String> = matches.unwrap().into_iter().map(|m| m.unit).collect();
        assert_eq!(units, vec!["a", "a"]);
    }

    #[test]
    fn replayed_text_is_extracted_and_handed_back() {
        let source = "One *two* three.\n";
        let FindAnswer { frame, extracted } = job(
            opts(false, false, false),
            vec![(
                "m1-b1",
                UnitText::Extract {
                    source: source.into(),
                },
            )],
            vec![],
        )
        .answer();
        let RenderedFrame::FindResult {
            matches, missing, ..
        } = frame
        else {
            panic!()
        };
        assert!(missing.is_empty());
        assert_eq!(
            matches.unwrap(),
            vec![FindMatch {
                unit: "m1-b1".into(),
                start: 4,
                end: 7
            }]
        );
        assert_eq!(extracted.len(), 1);
        assert_eq!(extracted[0].text, "One two three.\n");
        assert_eq!(extracted[0].source_hash, tugmark::text_hash(source));
    }

    #[test]
    fn grep_returns_texts_and_mounted_units_carry_theirs() {
        let FindAnswer { frame, .. } = job(
            opts(false, false, true),
            vec![("a", UnitText::Ready("alpha".into()))],
            vec![("b", UnitText::Ready("beta".into()))],
        )
        .answer();
        let RenderedFrame::FindResult { matches, texts, .. } = frame else {
            panic!()
        };
        assert!(matches.is_none());
        let texts = texts.unwrap();
        assert_eq!(texts["a"], "alpha");
        assert_eq!(texts["b"], "beta");
    }

    #[test]
    fn unknown_units_are_reported_missing() {
        let FindAnswer { frame, .. } = job(
            opts(false, false, false),
            vec![
                ("a", UnitText::Missing),
                ("b", UnitText::Ready("two".into())),
            ],
            vec![("a", UnitText::Missing), ("c", UnitText::Missing)],
        )
        .answer();
        let RenderedFrame::FindResult {
            missing, matches, ..
        } = frame
        else {
            panic!()
        };
        assert_eq!(missing, vec!["a", "c"]);
        assert_eq!(matches.unwrap().len(), 1);
    }
}
