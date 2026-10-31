//! Splitting a source into passages the embedder can read whole.
//!
//! The contextual model reads 256 tokens and silently drops the rest, so a
//! passage over the cap is a passage whose tail cannot be found. Its tokens are
//! sub-word pieces this crate has no tokenizer for, so the count is an estimate
//! that errs high: see [`estimate_tokens`].

use std::ops::Range;

/// Bumped when a change here cuts the same source differently, which a caller
/// folds into a source's content hash so that what it stored gets re-chunked.
pub const CHUNKING_VERSION: u32 = 1;

/// The model's maximum sequence, which is the cap on a whole embedded passage.
pub const MAX_TOKENS: usize = 256;

/// The longest context line kept, in bytes. A context line says where a passage
/// is from, and a long one would eat the passage it is there to place.
const MAX_CONTEXT_BYTES: usize = 96;

/// The longest sentence carried into the next passage as overlap, so a thought
/// that straddles a cut is whole on one side of it, and neighbours stay mostly
/// distinct.
const OVERLAP_TOKENS: usize = 32;

/// What the model's start and end markers cost, on any text.
pub(crate) const MARKER_TOKENS: usize = 4;

/// One piece of a source, ready to embed and store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passage {
    /// One line saying where the passage is from, such as a document title and
    /// heading. It is embedded with the passage and is not part of the span.
    pub context: String,
    /// The passage's text, which is exactly `source[start..end]`.
    pub body: String,
    /// The passage's position among its source's passages, from 0.
    pub ordinal: usize,
    /// Where the body starts in the source, in bytes.
    pub start: usize,
    /// Where the body ends in the source, in bytes.
    pub end: usize,
}

impl Passage {
    /// The text the embedder reads: the context line, then the body.
    pub fn embedding_text(&self) -> String {
        if self.context.is_empty() {
            self.body.clone()
        } else {
            format!("{}\n{}", self.context, self.body)
        }
    }
}

/// How many tokens the model may take to read `text`, erring high.
///
/// A byte counts half a token and a byte of punctuation a whole one. Against the
/// contextual model's own sequence length over every paragraph of the two help
/// documents, this was never under on any of 195 paragraphs and came in 1.7
/// times over on average, because prose takes about one token per 2.5 to 3 bytes
/// and markup takes one per mark.
pub fn estimate_tokens(text: &str) -> usize {
    let punctuation = text.bytes().filter(u8::is_ascii_punctuation).count();
    (text.len() + punctuation).div_ceil(2) + MARKER_TOKENS
}

/// Split `source` into passages under [`MAX_TOKENS`], each carrying `context`,
/// in order. Whitespace-only input yields none.
///
/// Cuts fall between sentences, and between paragraphs where one ends far enough
/// through the passage to be worth stopping at. A short last sentence repeats at
/// the head of the next passage. A sentence too long to fit alone is cut between
/// words, and a word too long to fit alone between characters.
///
/// Whatever scrubs a source does so before this, so that the spans stay true of
/// the text the passages are slices of.
pub fn chunk(context: &str, source: &str) -> Vec<Passage> {
    let context = context_line(context);
    let budget = MAX_TOKENS
        - if context.is_empty() {
            0
        } else {
            estimate_tokens(&context)
        };
    let atoms = atoms(source, budget);
    let fits = |from: usize, to: usize| {
        estimate_tokens(&source[atoms[from].range.start..atoms[to].range.end]) <= budget
    };

    let mut passages = Vec::new();
    let mut first = 0;
    while first < atoms.len() {
        let mut last = first;
        while last + 1 < atoms.len() && fits(first, last + 1) {
            last += 1;
        }
        if last + 1 < atoms.len()
            && let Some(paragraph) = (first + 1..=last)
                .rev()
                .find(|&at| atoms[at].opens_paragraph)
        {
            let kept = &source[atoms[first].range.start..atoms[paragraph - 1].range.end];
            if estimate_tokens(kept) >= budget / 2 {
                last = paragraph - 1;
            }
        }

        let span = atoms[first].range.start..atoms[last].range.end;
        passages.push(Passage {
            context: context.clone(),
            body: source[span.clone()].to_string(),
            ordinal: passages.len(),
            start: span.start,
            end: span.end,
        });

        let next = last + 1;
        let overlaps = last > first
            && next < atoms.len()
            && estimate_tokens(&source[atoms[last].range.clone()]) <= OVERLAP_TOKENS
            && fits(last, next);
        first = if overlaps { last } else { next };
    }
    passages
}

/// `context` on one line, no longer than [`MAX_CONTEXT_BYTES`].
pub(crate) fn context_line(context: &str) -> String {
    let line = context.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut end = line.len().min(MAX_CONTEXT_BYTES);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].trim_end().to_string()
}

/// A stretch of source no cut falls inside.
struct Atom {
    range: Range<usize>,
    opens_paragraph: bool,
}

/// The sentences of `source`, each fitting `budget` alone.
fn atoms(source: &str, budget: usize) -> Vec<Atom> {
    let mut atoms = Vec::new();
    for paragraph in paragraphs(source) {
        let mut opens_paragraph = true;
        for sentence in sentences(source, paragraph) {
            for piece in pieces(source, sentence, budget) {
                atoms.push(Atom {
                    range: piece,
                    opens_paragraph,
                });
                opens_paragraph = false;
            }
        }
    }
    atoms
}

/// The runs of lines between blank lines.
fn paragraphs(source: &str) -> Vec<Range<usize>> {
    let mut paragraphs = Vec::new();
    let mut open: Option<usize> = None;
    let mut at = 0;
    for line in source.split_inclusive('\n') {
        if line.trim().is_empty() {
            if let Some(start) = open.take() {
                paragraphs.push(start..at);
            }
        } else if open.is_none() {
            open = Some(at);
        }
        at += line.len();
    }
    if let Some(start) = open {
        paragraphs.push(start..at);
    }
    paragraphs
}

/// The sentences of one paragraph, trimmed. A line break ends one, so a list
/// item stands alone, and so does `.`, `!` or `?` before a space and anything
/// other than a lower-case letter, so an abbreviation mid-sentence usually holds.
fn sentences(source: &str, paragraph: Range<usize>) -> Vec<Range<usize>> {
    let bytes = source.as_bytes();
    let mut sentences = Vec::new();
    let mut start = paragraph.start;
    let mut at = paragraph.start;
    while at < paragraph.end {
        let cut = match bytes[at] {
            b'\n' => Some(at),
            b'.' | b'!' | b'?' => {
                let mut after = at + 1;
                while after < paragraph.end
                    && matches!(
                        bytes[after],
                        b'"' | b'\'' | b')' | b']' | b'*' | b'_' | b'`'
                    )
                {
                    after += 1;
                }
                let mut next = after;
                while next < paragraph.end && bytes[next].is_ascii_whitespace() {
                    next += 1;
                }
                (next > after && next < paragraph.end && !bytes[next].is_ascii_lowercase())
                    .then_some(after)
            }
            _ => None,
        };
        match cut {
            Some(end) => {
                sentences.extend(trimmed(source, start..end));
                start = end;
                at = end.max(at + 1);
            }
            None => at += 1,
        }
    }
    sentences.extend(trimmed(source, start..paragraph.end));
    sentences
}

/// `range` without its surrounding whitespace, or nothing if that is all it is.
fn trimmed(source: &str, range: Range<usize>) -> Option<Range<usize>> {
    let text = &source[range.clone()];
    let body = text.trim();
    if body.is_empty() {
        return None;
    }
    let start = range.start + (text.len() - text.trim_start().len());
    Some(start..start + body.len())
}

/// `sentence` cut to fit `budget`: between words, or between characters for a
/// word that does not fit alone.
fn pieces(source: &str, sentence: Range<usize>, budget: usize) -> Vec<Range<usize>> {
    if estimate_tokens(&source[sentence.clone()]) <= budget {
        return vec![sentence];
    }
    let mut pieces = Vec::new();
    let mut start = sentence.start;
    while start < sentence.end {
        let rest = &source[start..sentence.end];
        let mut cut = 0;
        for (at, _) in rest.match_indices(char::is_whitespace) {
            if estimate_tokens(&rest[..at]) > budget {
                break;
            }
            cut = at;
        }
        if estimate_tokens(rest) <= budget {
            cut = rest.len();
        }
        if cut == 0 {
            for (at, c) in rest.char_indices() {
                if estimate_tokens(&rest[..at + c.len_utf8()]) > budget {
                    break;
                }
                cut = at + c.len_utf8();
            }
        }
        pieces.extend(trimmed(source, start..start + cut));
        start += cut;
        start += source[start..sentence.end].len() - source[start..sentence.end].trim_start().len();
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A paragraph in the feature guide's voice.
    const PROSE: &str = "An arc is one piece of work carried on its own git worktree and branch. \
        The Arcs card lists every arc in the project, with where each one has got to. \
        A step closes when its round is committed, and the next step opens on the next turn. \
        Nothing lands on the base until the join, which squashes the branch to one commit. \
        Joining is the user's act, and an arc that is discarded leaves the base untouched.";

    fn long_text(paragraphs: usize) -> String {
        vec![PROSE; paragraphs].join("\n\n")
    }

    /// The properties every chunking holds, whatever the input.
    fn assert_sound(context: &str, source: &str) -> Vec<Passage> {
        let passages = chunk(context, source);
        for (ordinal, passage) in passages.iter().enumerate() {
            assert_eq!(passage.ordinal, ordinal);
            assert_eq!(passage.body, source[passage.start..passage.end]);
            assert!(!passage.body.is_empty());
            assert!(
                estimate_tokens(&passage.embedding_text()) <= MAX_TOKENS,
                "passage {ordinal} is over the cap: {}",
                estimate_tokens(&passage.embedding_text())
            );
        }
        for pair in passages.windows(2) {
            assert!(pair[1].start > pair[0].start, "a passage must move forward");
            assert!(pair[1].end > pair[0].end, "a passage must add something");
        }
        for word in source.split_whitespace() {
            assert!(
                passages.iter().any(|passage| passage.body.contains(word)) || word.len() > 40,
                "lost {word:?}"
            );
        }
        passages
    }

    #[test]
    fn the_help_documents_chunk_soundly() {
        for document in [
            include_str!("../../../../docs/features.md"),
            include_str!("../../../../docs/glossary.md"),
        ] {
            assert!(assert_sound("Tug help", document).len() > 10);
        }
        let recipes = include_str!("../../../../docs/recipes.md");
        assert!(!assert_sound("Tug help", recipes).is_empty());
    }

    #[test]
    fn a_short_source_is_one_passage_with_its_context() {
        let passages = assert_sound("Tug features > Arcs", "  An arc is one piece of work.\n");
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].body, "An arc is one piece of work.");
        assert_eq!(passages[0].start, 2);
        assert_eq!(
            passages[0].embedding_text(),
            "Tug features > Arcs\nAn arc is one piece of work."
        );
    }

    #[test]
    fn a_source_with_no_text_has_no_passages() {
        assert!(chunk("context", "").is_empty());
        assert!(chunk("context", " \n\n \t\n").is_empty());
    }

    #[test]
    fn no_context_embeds_the_body_alone() {
        assert_eq!(chunk("", "Just this.")[0].embedding_text(), "Just this.");
    }

    #[test]
    fn a_passage_at_the_cap_stands_and_one_over_it_splits() {
        // Short sentences, so the exact point of the cap can be reached.
        let sentence = "Abc de fg.";
        let cost = |count: usize| estimate_tokens(&vec![sentence; count].join(" "));
        let context = "Tug";
        let budget = MAX_TOKENS - estimate_tokens(context);
        let at_cap = (1..)
            .take_while(|&count| cost(count) <= budget)
            .last()
            .unwrap();

        let source = vec![sentence; at_cap].join(" ");
        assert_eq!(assert_sound(context, &source).len(), 1);

        let source = vec![sentence; at_cap + 1].join(" ");
        assert_eq!(assert_sound(context, &source).len(), 2);
    }

    #[test]
    fn cuts_fall_between_sentences() {
        for passage in assert_sound("ctx", &long_text(4)) {
            assert!(
                passage.body.starts_with(char::is_uppercase),
                "{}",
                passage.body
            );
            assert!(passage.body.ends_with('.'), "{}", passage.body);
        }
    }

    #[test]
    fn a_cut_prefers_a_paragraph_break() {
        let first = PROSE;
        let second = "The second paragraph is its own thought. ".repeat(12);
        let source = format!("{first}\n\n{}", second.trim_end());
        let passages = assert_sound("ctx", &source);
        assert!(passages.len() >= 2);
        assert_eq!(
            passages[0].body, first,
            "the first passage stops at the paragraph"
        );
    }

    #[test]
    fn neighbours_overlap_by_one_short_sentence() {
        let source = (0..60)
            .map(|index| format!("Sentence number {index} says one thing."))
            .collect::<Vec<_>>()
            .join(" ");
        let passages = assert_sound("ctx", &source);
        assert!(passages.len() >= 2);
        for pair in passages.windows(2) {
            assert!(pair[1].start < pair[0].end, "neighbours must share text");
            let shared = &source[pair[1].start..pair[0].end];
            assert!(estimate_tokens(shared) <= OVERLAP_TOKENS);
            assert_eq!(shared.matches(". ").count(), 0, "one sentence: {shared}");
        }
    }

    #[test]
    fn a_long_sentence_is_cut_between_words() {
        let source = "word ".repeat(400);
        let source = source.trim_end();
        let passages = assert_sound("ctx", source);
        assert!(passages.len() > 1);
        for passage in passages {
            assert!(
                passage.body.split(' ').all(|word| word == "word"),
                "{}",
                passage.body
            );
        }
    }

    #[test]
    fn a_long_word_is_cut_between_characters() {
        let source = "é".repeat(600);
        let passages = chunk("ctx", &source);
        assert!(passages.len() > 1);
        assert_eq!(
            passages.iter().map(|p| p.body.as_str()).collect::<String>(),
            source
        );
        for passage in passages {
            assert!(estimate_tokens(&passage.embedding_text()) <= MAX_TOKENS);
        }
    }

    #[test]
    fn markup_heavy_text_stays_under_the_cap() {
        let source = "| `a` | **b** | [c](d) | `e` |\n".repeat(60);
        assert!(assert_sound("ctx", &source).len() > 1);
        let punctuation = "!?.:;()[]{}".repeat(60);
        assert_sound("ctx", &punctuation);
    }

    #[test]
    fn the_context_line_is_one_short_line_on_a_character_boundary() {
        let passage = &chunk("Tug\n  features", "Body.")[0];
        assert_eq!(passage.context, "Tug features");
        let passage = &chunk(&"é".repeat(MAX_CONTEXT_BYTES), "Body.")[0];
        assert!(passage.context.len() <= MAX_CONTEXT_BYTES);
        assert!(!passage.context.contains('\n'));
        assert!(estimate_tokens(&passage.embedding_text()) <= MAX_TOKENS);
    }

    #[test]
    fn an_abbreviation_mid_sentence_does_not_cut() {
        let spans = sentences("Use a verb, e.g. the join. Then stop.", 0..37);
        assert_eq!(spans.len(), 2);
        assert_eq!(
            &"Use a verb, e.g. the join. Then stop."[spans[0].clone()],
            "Use a verb, e.g. the join."
        );
    }
}
