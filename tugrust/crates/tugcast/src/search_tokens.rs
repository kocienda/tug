//! Sub-word vocabulary for the facts library's full-text indexes.
//!
//! FTS5's unicode61 tokenizer splits only on non-alphanumeric characters, so
//! `TugTooltip` is one token: a search for `tooltip` does not match it, and
//! neither does `tooltip*` (a prefix query extends a token rightward — it
//! cannot start mid-token). Tug's own naming conventions are built out of
//! exactly the shapes this loses — Tug-prefixed CamelCase components,
//! `useSomeHook` identifiers, `at0365`-style test ids — so the index
//! systematically fails to find the project's own vocabulary.
//!
//! The fix is a third indexed column, `tokens`, carrying a derived sub-word
//! bag: `TugTooltip` contributes `tug tooltip`, `at0365` contributes
//! `at 0365`. Word-level AND/OR/phrase semantics survive (unlike a trigram
//! tokenizer), `snippet()` keeps quoting the human-readable columns, and
//! `bm25()` can weight the derived vocabulary below the authored text.
//!
//! [`subword_tokens`] emits only what is *not* already a whole token of its
//! input: prose that says "tooltip" adds nothing here, because the `text`
//! column already indexes that word and duplicating it would double-count in
//! bm25. The function is pure and order-stable so a backfill and a live insert
//! produce identical bytes for identical input.

use std::collections::HashSet;

/// Sub-words shorter than this are noise (`x` from `TugX`, a stray initial).
const MIN_SUBWORD_CHARS: usize = 2;

/// The ceiling on one row's derived bag. Long enough that no real fact text or
/// post body reaches it; short enough that a pathological row cannot bloat the
/// index. The cut lands on a sub-word boundary, never mid-word.
const MAX_TOKENS_CHARS: usize = 2048;

/// The normalized sub-word bag for one or more source strings.
///
/// Lowercase, deduped, first-seen order, space-joined. Returns an empty string
/// when the sources contain no compound vocabulary — the common case for
/// ordinary prose, and the reason the column is worth its size.
pub fn subword_tokens(sources: &[&str]) -> String {
    let mut seen: HashSet<String> = HashSet::new();
    let mut words: Vec<String> = Vec::new();

    for source in sources {
        for token in source
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
        {
            let whole = token.to_lowercase();
            for piece in split_compound(token) {
                let piece = piece.to_lowercase();
                if piece.chars().count() < MIN_SUBWORD_CHARS {
                    continue;
                }
                // The originals are already indexed by `subject`/`text`/`body`.
                // A token that does not decompose contributes nothing.
                if piece == whole {
                    continue;
                }
                if seen.insert(piece.clone()) {
                    words.push(piece);
                }
            }
        }
    }

    join_capped(&words)
}

/// Split one alphanumeric token at its CamelCase humps and its letter/digit
/// boundaries.
///
/// `TugTooltip` → `Tug`, `Tooltip`; `useSyncExternalStore` → `use`, `Sync`,
/// `External`, `Store`; `HTTPServer` → `HTTP`, `Server` (an all-caps run breaks
/// before the capital that starts a lowercase word, not at every capital);
/// `at0365` → `at`, `0365`. A token with no internal boundary comes back whole.
fn split_compound(token: &str) -> Vec<String> {
    let chars: Vec<char> = token.chars().collect();
    let mut pieces = Vec::new();
    let mut start = 0usize;

    for i in 1..chars.len() {
        let prev = chars[i - 1];
        let cur = chars[i];
        let boundary = if prev.is_uppercase() && cur.is_uppercase() {
            // Inside an acronym run, break only where the next character shows
            // this capital was starting a word: `HTTPServer`, not `HTTPS`.
            matches!(chars.get(i + 1), Some(next) if next.is_lowercase())
        } else {
            prev.is_numeric() != cur.is_numeric() || (prev.is_lowercase() && cur.is_uppercase())
        };
        if boundary {
            pieces.push(chars[start..i].iter().collect::<String>());
            start = i;
        }
    }
    pieces.push(chars[start..].iter().collect());
    pieces
}

/// Space-join, stopping before the first word that would cross the cap.
fn join_capped(words: &[String]) -> String {
    let mut out = String::new();
    for word in words {
        let cost = if out.is_empty() {
            word.len()
        } else {
            word.len() + 1
        };
        if out.len() + cost > MAX_TOKENS_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

// MARK: - Query hygiene and the relaxation ladder

/// One term of a natural-language query, as it will be handed to FTS5.
///
/// `prefix` records a trailing `*` the writer meant as a prefix search — a sha
/// prefix is the case worth keeping, and it is the one piece of FTS5 syntax
/// that survives sanitization.
struct Term {
    text: String,
    prefix: bool,
}

impl Term {
    /// The term as an FTS5 expression. Double-quoting is what makes
    /// sanitization total: inside a quoted string the only character FTS5
    /// still reads as syntax is the quote itself, and [`Term::parse`] has
    /// already dropped those.
    fn render(&self) -> String {
        if self.prefix {
            format!("\"{}\"*", self.text)
        } else {
            format!("\"{}\"", self.text)
        }
    }

    /// `None` when nothing usable survives — punctuation on its own is not a
    /// search term, and a quoted string with no tokens in it is a query FTS5
    /// can only answer with nothing.
    fn parse(raw: &str) -> Option<Term> {
        let prefix = raw.ends_with('*');
        let body = raw.trim_end_matches('*');
        let text: String = body.chars().filter(|c| *c != '"').collect();
        if !text.chars().any(char::is_alphanumeric) {
            return None;
        }
        Some(Term { text, prefix })
    }
}

/// Whether the writer is speaking FTS5 rather than English.
///
/// A model that writes `"exact phrase"` or `a OR b` has been precise on
/// purpose, and rewriting that would be taking the query away from it. Such a
/// query passes through untouched — and if FTS5 rejects it, the model reads its
/// own syntax error, which is the one case where that error is useful.
fn is_advanced(raw: &str) -> bool {
    raw.contains('"')
        || raw.contains(" OR ")
        || raw.contains(" AND ")
        || raw.contains(" NOT ")
        || raw.contains("NEAR(")
}

fn terms_of(raw: &str) -> Vec<Term> {
    raw.split_whitespace().filter_map(Term::parse).collect()
}

/// The model's query as a MATCH expression that cannot syntax-error.
///
/// Terms are quoted and rejoined with spaces, which is FTS5's implicit AND —
/// the same semantics the query had, minus the ways it could have failed to
/// parse. `None` means nothing searchable survived.
pub fn sanitize_fts_query(raw: &str) -> Option<String> {
    if is_advanced(raw) {
        let trimmed = raw.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    let terms = terms_of(raw);
    if terms.is_empty() {
        return None;
    }
    Some(terms.iter().map(Term::render).collect::<Vec<_>>().join(" "))
}

/// Ladder rung 1: the same terms, OR-ed.
///
/// FTS5's implicit AND is what makes a natural phrase like `tooltip colors`
/// match nothing while `tooltip` alone matches thirty-nine rows. `None` when
/// there is nothing to relax — one term, or a query the writer wrote in FTS5.
pub fn relax_or(raw: &str) -> Option<String> {
    if is_advanced(raw) {
        return None;
    }
    let terms = terms_of(raw);
    if terms.len() < 2 {
        return None;
    }
    Some(
        terms
            .iter()
            .map(Term::render)
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

/// Ladder rung 2: every term OR-ed with its own sub-words.
///
/// This is the reverse of the [`subword_tokens`] indexing direction. Indexing
/// splits `TugTooltip` in the record so a search for `tooltip` reaches it; this
/// splits `TugTooltip` in the *query* so a search for it reaches a record whose
/// prose says `tooltip`. `None` when no term decomposes, which is the common
/// case and means the rung has nothing to add.
pub fn expand_subwords(raw: &str) -> Option<String> {
    if is_advanced(raw) {
        return None;
    }
    let terms = terms_of(raw);
    if terms.is_empty() {
        return None;
    }
    let mut expanded_any = false;
    let groups: Vec<String> = terms
        .iter()
        .map(|term| {
            let subwords = subword_tokens(&[term.text.as_str()]);
            if subwords.is_empty() {
                return term.render();
            }
            expanded_any = true;
            let mut alts = vec![term.render()];
            alts.extend(subwords.split(' ').map(|word| format!("\"{word}\"")));
            format!("({})", alts.join(" OR "))
        })
        .collect();
    expanded_any.then(|| groups.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_names_decompose_into_their_words() {
        assert_eq!(subword_tokens(&["TugTooltip"]), "tug tooltip");
        assert_eq!(subword_tokens(&["TugActionTooltip"]), "tug action tooltip");
        assert_eq!(
            subword_tokens(&["useSyncExternalStore"]),
            "use sync external store"
        );
    }

    #[test]
    fn an_acronym_run_breaks_where_a_word_begins() {
        assert_eq!(subword_tokens(&["HTTPServer"]), "http server");
        // No trailing lowercase means no word start, so the run stays whole —
        // and being the whole token, it emits nothing.
        assert_eq!(subword_tokens(&["HTTPS"]), "");
    }

    #[test]
    fn letter_digit_boundaries_split() {
        assert_eq!(subword_tokens(&["at0365-overview-card.test.ts"]), "at 0365");
    }

    #[test]
    fn plain_prose_contributes_nothing() {
        assert_eq!(subword_tokens(&["unify commit hover into a real"]), "");
    }

    #[test]
    fn the_headline_case_finds_the_commit_facts_vocabulary() {
        // Fact 6291's text, verbatim — the row the 2026-08-15 question needed.
        let tokens = subword_tokens(&[
            "commit ac462ba3a1ae",
            "commit ac462ba3a1ae \"tugways(entity-tips): unify commit hover into a real TugTooltip\" — 27 file(s)",
        ]);
        let words: Vec<&str> = tokens.split(' ').collect();
        assert!(words.contains(&"tooltip"), "tokens were {tokens:?}");
        assert!(words.contains(&"tug"), "tokens were {tokens:?}");
    }

    #[test]
    fn output_is_deduped_and_first_seen_ordered() {
        assert_eq!(
            subword_tokens(&["TugTooltip TugTooltip TugList"]),
            "tug tooltip list"
        );
        assert_eq!(
            subword_tokens(&["TugList", "TugTooltip"]),
            "tug list tooltip"
        );
    }

    #[test]
    fn sub_words_under_two_characters_are_dropped() {
        assert_eq!(subword_tokens(&["TugX"]), "tug");
    }

    #[test]
    fn the_cap_cuts_at_a_whole_sub_word() {
        // Distinct compounds, each contributing a unique long sub-word.
        let source: String = (0..400)
            .map(|i| format!("Tug{}Component ", "a".repeat(20 + i % 3)))
            .collect();
        let tokens = subword_tokens(&[source.as_str()]);
        assert!(tokens.len() <= MAX_TOKENS_CHARS, "len {}", tokens.len());
        assert!(!tokens.ends_with(' '));
        // Every emitted word is whole: none is a prefix-truncated fragment.
        let last = tokens.rsplit(' ').next().unwrap();
        assert!(
            source.to_lowercase().contains(last),
            "last word {last:?} was cut mid-word"
        );
    }

    #[test]
    fn an_empty_source_set_is_an_empty_bag() {
        assert_eq!(subword_tokens(&[]), "");
        assert_eq!(subword_tokens(&["", "   ", "..."]), "");
    }

    #[test]
    fn a_natural_phrase_becomes_quoted_and_ed_terms() {
        assert_eq!(
            sanitize_fts_query("tooltip colors").as_deref(),
            Some("\"tooltip\" \"colors\"")
        );
    }

    #[test]
    fn a_trailing_star_survives_as_a_prefix_search() {
        assert_eq!(
            sanitize_fts_query("ac462ba*").as_deref(),
            Some("\"ac462ba\"*")
        );
    }

    #[test]
    fn punctuation_cannot_syntax_error_and_bare_punctuation_drops_out() {
        assert_eq!(
            sanitize_fts_query("weird (chars) -here").as_deref(),
            Some("\"weird\" \"(chars)\" \"-here\"")
        );
        // Nothing alphanumeric survives, so there is no query to run.
        assert_eq!(sanitize_fts_query("--- ((( "), None);
        assert_eq!(sanitize_fts_query("   "), None);
    }

    #[test]
    fn a_query_written_in_fts5_passes_through_verbatim() {
        for raw in [
            "\"unify commit hover\"",
            "tooltip OR tug",
            "tooltip AND colors",
            "NEAR(tooltip colors, 5)",
        ] {
            assert_eq!(sanitize_fts_query(raw).as_deref(), Some(raw), "{raw}");
            assert_eq!(relax_or(raw), None, "{raw}");
            assert_eq!(expand_subwords(raw), None, "{raw}");
        }
    }

    #[test]
    fn or_relaxation_needs_two_terms() {
        assert_eq!(
            relax_or("tooltip colors").as_deref(),
            Some("\"tooltip\" OR \"colors\"")
        );
        assert_eq!(relax_or("tooltip"), None);
    }

    #[test]
    fn sub_word_expansion_reaches_prose_from_an_identifier() {
        assert_eq!(
            expand_subwords("TugTooltip").as_deref(),
            Some("(\"TugTooltip\" OR \"tug\" OR \"tooltip\")")
        );
        assert_eq!(
            expand_subwords("TugTooltip colors").as_deref(),
            Some("(\"TugTooltip\" OR \"tug\" OR \"tooltip\") OR \"colors\"")
        );
        // A query with nothing to decompose has nothing this rung can add.
        assert_eq!(expand_subwords("tooltip colors"), None);
    }
}
