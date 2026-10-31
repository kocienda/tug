//! Turning ranked passages back into what a person reads.
//!
//! Neighbouring passages of one source are one thought that the chunker cut, so
//! they read back as one span, with their overlap taken out.

use std::collections::HashMap;

/// A passage a search found, in the shape the store holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub source_kind: String,
    pub source_id: String,
    pub ordinal: usize,
    pub start: usize,
    pub end: usize,
    pub context: String,
    pub body: String,
    pub score: f64,
}

/// A readable stretch of one source. `source_kind` and `source_id` are its ref.
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub source_kind: String,
    pub source_id: String,
    pub start: usize,
    pub end: usize,
    pub context: String,
    pub text: String,
    /// The best score among the passages it was built from.
    pub score: f64,
}

/// The spans ranked `hits` make, best first.
///
/// Hits of one source merge when they are consecutive passages or their spans
/// meet. A span's order comes from the best passage in it, and ties keep the
/// order the first of each arrived in.
pub fn reassemble(hits: &[Hit]) -> Vec<Span> {
    let mut sources: Vec<Vec<&Hit>> = Vec::new();
    let mut by_source: HashMap<(&str, &str), usize> = HashMap::new();
    for hit in hits {
        let key = (hit.source_kind.as_str(), hit.source_id.as_str());
        let index = *by_source.entry(key).or_insert_with(|| {
            sources.push(Vec::new());
            sources.len() - 1
        });
        sources[index].push(hit);
    }

    let mut spans: Vec<Span> = Vec::new();
    for mut group in sources {
        group.sort_by_key(|hit| (hit.start, hit.ordinal));
        let mut previous: Option<usize> = None;
        for hit in group {
            let joins = previous.is_some_and(|ordinal| {
                let last = spans.last().expect("a previous hit made a span");
                hit.ordinal <= ordinal + 1 || hit.start <= last.end
            });
            if joins {
                extend(spans.last_mut().expect("a previous hit made a span"), hit);
            } else {
                spans.push(Span {
                    source_kind: hit.source_kind.clone(),
                    source_id: hit.source_id.clone(),
                    start: hit.start,
                    end: hit.end,
                    context: hit.context.clone(),
                    text: hit.body.clone(),
                    score: hit.score,
                });
            }
            previous = Some(hit.ordinal);
        }
    }
    spans.sort_by(|a, b| b.score.total_cmp(&a.score));
    spans
}

/// Add `hit` to the end of `span`, which it follows or overlaps.
fn extend(span: &mut Span, hit: &Hit) {
    span.score = span.score.max(hit.score);
    if hit.end <= span.end {
        return;
    }
    if hit.start <= span.end {
        // A body is a slice of its source, so the shared bytes are its first.
        if let Some(rest) = hit.body.get(span.end - hit.start..) {
            span.text.push_str(rest);
        }
    } else {
        // The chunker only drops whitespace between passages. Two bytes are a
        // paragraph break, and one is a sentence or a line, which a newline
        // renders correctly either way.
        span.text.push_str(if hit.start - span.end >= 2 {
            "\n\n"
        } else {
            "\n"
        });
        span.text.push_str(&hit.body);
    }
    span.end = hit.end;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk;

    fn hit(source: &str, ordinal: usize, start: usize, body: &str, score: f64) -> Hit {
        Hit {
            source_kind: "help".to_string(),
            source_id: source.to_string(),
            ordinal,
            start,
            end: start + body.len(),
            context: format!("ctx {source}"),
            body: body.to_string(),
            score,
        }
    }

    fn hits_from(source_text: &str, source: &str, keep: impl Fn(usize) -> bool) -> Vec<Hit> {
        chunk("ctx", source_text)
            .into_iter()
            .filter(|passage| keep(passage.ordinal))
            .map(|passage| Hit {
                source_kind: "help".to_string(),
                source_id: source.to_string(),
                ordinal: passage.ordinal,
                start: passage.start,
                end: passage.end,
                context: passage.context,
                body: passage.body,
                score: 1.0 - passage.ordinal as f64 / 100.0,
            })
            .collect()
    }

    #[test]
    fn nothing_reassembles_to_nothing() {
        assert!(reassemble(&[]).is_empty());
    }

    #[test]
    fn every_passage_of_a_chunked_source_reads_back_as_the_source() {
        let source = (0..80)
            .map(|index| format!("Sentence number {index} says one thing."))
            .collect::<Vec<_>>()
            .join(" ");
        let hits = hits_from(&source, "features#arcs", |_| true);
        assert!(hits.len() > 1);
        let spans = reassemble(&hits);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end, source.len());
        assert_eq!(
            spans[0].text.split_whitespace().collect::<Vec<_>>(),
            source.split_whitespace().collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_paragraph_break_between_passages_comes_back() {
        let spans = reassemble(&[
            hit("a", 0, 0, "First paragraph.", 1.0),
            hit("a", 1, 18, "Second paragraph.", 0.5),
        ]);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "First paragraph.\n\nSecond paragraph.");
    }

    #[test]
    fn passages_that_do_not_touch_stay_separate_spans_ranked_by_their_best() {
        let spans = reassemble(&[
            hit("a", 5, 500, "Later.", 0.9),
            hit("a", 0, 0, "Earlier.", 0.4),
        ]);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "Later.");
        assert_eq!(spans[1].text, "Earlier.");
    }

    #[test]
    fn a_span_takes_the_best_score_of_its_passages() {
        let spans = reassemble(&[
            hit("b", 0, 0, "Other source.", 0.8),
            hit("a", 1, 10, "Second.", 0.9),
            hit("a", 0, 0, "First one.", 0.1),
        ]);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].source_id, "a");
        assert_eq!(spans[0].score, 0.9);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].context, "ctx a");
        assert_eq!(spans[1].source_id, "b");
    }

    #[test]
    fn sources_never_merge() {
        let spans = reassemble(&[hit("a", 0, 0, "Same.", 0.5), hit("b", 1, 0, "Same.", 0.5)]);
        assert_eq!(spans.len(), 2);
    }

    #[test]
    fn a_repeated_passage_is_read_once() {
        let spans = reassemble(&[hit("a", 0, 0, "Once.", 0.5), hit("a", 0, 0, "Once.", 0.7)]);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "Once.");
        assert_eq!(spans[0].score, 0.7);
    }

    #[test]
    fn overlap_between_neighbours_is_read_once() {
        let spans = reassemble(&[
            hit("a", 0, 0, "One. Two.", 1.0),
            hit("a", 1, 5, "Two. Three.", 0.5),
        ]);
        assert_eq!(spans[0].text, "One. Two. Three.");
        assert_eq!(spans[0].end, 16);
    }
}
