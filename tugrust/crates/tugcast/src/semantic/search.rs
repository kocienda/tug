//! Asking the index a question: BM25 over the text shadow and cosine over the
//! vectors, fused by rank.
//!
//! A search is hybrid or it is not offered. With no live model, a query that could
//! not be embedded in time, or nothing yet embedded on the live model, [`rank`]
//! answers `None` and the caller stays on whatever it can do without the index.
//!
//! [`rank`]: SemanticSearch::rank

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tracing::warn;
use tugsem_core::{
    Candidate, Hit, Query, TopK, decode_vector_into, fuse, rank_by_similarity, reassemble,
};

use super::coverage::SemanticCoverage;
use super::embedder::EmbedderClient;
use super::index::{SemanticError, SemanticIndex};

/// How long a question waits for its own vector. Inside the verb's ceiling, and
/// short because the fallback is a good search rather than an empty one.
const QUERY_EMBED_TIMEOUT: Duration = Duration::from_secs(3);

/// How many sources each ranker hands to the fusion. A source either list ranks
/// below this adds too little to reciprocal rank to matter.
const RANKER_DEPTH: usize = 20;

/// The most of a span a search shows: enough to judge it, and to follow it for more.
pub(crate) const SEARCH_SPAN_MAX_BYTES: usize = 1536;

/// What an excerpt's ellipses cost, so one with both still fits inside the cap.
const ELLIPSES_BYTES: usize = 6;

/// Sources in fused order, best first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ranked {
    pub sources: Vec<String>,
    /// Whether any passage holds any of the words. When none does, everything in
    /// `sources` is here on meaning alone.
    pub any_terms: bool,
    /// Whether some one passage holds all of the words.
    pub all_terms: bool,
}

/// A readable stretch of a source a search found, best first among its fellows.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PassageHit {
    pub kind: String,
    pub source_id: String,
    pub context: String,
    pub text: String,
    pub meta: Option<String>,
    pub score: f64,
}

/// Hits in fused order, best first.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RankedPassages {
    pub hits: Vec<PassageHit>,
    /// Whether any kept passage holds any of the words.
    pub any_terms: bool,
    /// Whether some one kept passage holds all of the words.
    pub all_terms: bool,
}

pub(crate) struct SemanticSearch {
    index: Arc<SemanticIndex>,
    embedder: Arc<EmbedderClient>,
    coverage: watch::Receiver<SemanticCoverage>,
}

impl SemanticSearch {
    pub(crate) fn new(
        index: Arc<SemanticIndex>,
        embedder: Arc<EmbedderClient>,
        coverage: watch::Receiver<SemanticCoverage>,
    ) -> Self {
        Self {
            index,
            embedder,
            coverage,
        }
    }

    /// How much of what could be searched is in the index so far.
    pub(crate) fn coverage(&self) -> SemanticCoverage {
        self.coverage.borrow().clone()
    }

    /// Rank the sources of `kind` for `query`, whose words the caller has already
    /// reduced to `terms`. `scope` is a source-id prefix that both rankers and both
    /// word flags stay inside, so a source outside it cannot take a place in a
    /// ranker's depth or answer for a word the scope does not hold. Never starts the
    /// helper: a search that had to load a model would pay for it under a person
    /// waiting.
    pub(crate) async fn rank(
        &self,
        kind: &str,
        scope: Option<&str>,
        query: &str,
        terms: &[String],
    ) -> Option<Ranked> {
        self.embedder.live_model()?;
        let embedded = tokio::time::timeout(
            QUERY_EMBED_TIMEOUT,
            self.embedder.embed(vec![query.to_string()]),
        )
        .await
        .ok()?
        .ok()?;
        let vector = embedded.vectors.into_iter().next()??;

        let stored = read("vectors", self.index.vectors(kind, &embedded.model, scope))?;
        if stored.is_empty() {
            return None;
        }
        let source_of: HashMap<i64, &str> = stored
            .iter()
            .map(|chunk| (chunk.id, chunk.source_id.as_str()))
            .collect();
        let by_meaning: Vec<&str> = rank_by_similarity(
            Query {
                model: &embedded.model,
                vector: &vector,
            },
            stored.iter().map(|chunk| Candidate {
                id: chunk.id,
                model: &embedded.model,
                vector: &chunk.vector,
            }),
            stored.len(),
        )
        .iter()
        .filter_map(|scored| source_of.get(&scored.id).copied())
        .collect();
        let by_meaning = best_of_each_source(by_meaning);

        let by_word = read(
            "the text shadow",
            self.index.lexical_sources(kind, scope, terms),
        )?;
        let all_terms = read("the text shadow", self.index.holds_all(kind, scope, terms))?;
        let by_word_refs: Vec<&str> = by_word.iter().map(String::as_str).collect();
        let by_word_refs = best_of_each_source(by_word_refs);

        // The fusion ranks numbers, so a source's number is its place in `names`.
        let mut names = by_word_refs.clone();
        names.extend(
            by_meaning
                .iter()
                .filter(|name| !by_word_refs.contains(name)),
        );
        let numbered = |ranked: &[&str]| -> Vec<i64> {
            ranked
                .iter()
                .filter_map(|name| names.iter().position(|known| known == name))
                .map(|place| place as i64)
                .collect()
        };
        let word_ids = numbered(&by_word_refs);
        let meaning_ids = numbered(&by_meaning);
        let sources = fuse(&[&word_ids, &meaning_ids], usize::MAX)
            .iter()
            .map(|fused| names[fused.id as usize].to_string())
            .collect();
        Some(Ranked {
            sources,
            any_terms: !by_word.is_empty(),
            all_terms,
        })
    }

    /// The passages among `kinds` that answer `query` best, within `scope`, a source-id
    /// prefix, at most `limit` of them. A source of a session in `excluded_sessions`
    /// is out of each scan ahead of its depth, so it takes no place.
    ///
    /// `None` as for [`rank`](Self::rank): no live model, a question that could not be
    /// embedded in time, or nothing embedded on the live model. Past the question's
    /// embed this runs off the async threads, on connections of its own, because it
    /// walks every stored vector.
    pub(crate) async fn passages(
        &self,
        kinds: &[&'static str],
        scope: Option<&str>,
        query: &str,
        terms: &[String],
        excluded_sessions: &HashSet<String>,
        limit: usize,
    ) -> Option<RankedPassages> {
        self.embedder.live_model()?;
        let embedded = tokio::time::timeout(
            QUERY_EMBED_TIMEOUT,
            self.embedder.embed(vec![query.to_string()]),
        )
        .await
        .ok()?
        .ok()?;
        let vector = embedded.vectors.into_iter().next()??;

        let index = Arc::clone(&self.index);
        let kinds = kinds.to_vec();
        let scope = scope.map(str::to_string);
        let terms = terms.to_vec();
        let excluded = excluded_sessions.clone();
        tokio::task::spawn_blocking(move || {
            let asked = Asked {
                kinds: &kinds,
                scope: scope.as_deref(),
                model: &embedded.model,
                vector: &vector,
                terms: &terms,
                excluded: &excluded,
                limit,
            };
            read("the index", asked.rank(&index))?
        })
        .await
        .ok()?
    }
}

/// One question, as the blocking half of a search reads it.
struct Asked<'a> {
    kinds: &'a [&'static str],
    scope: Option<&'a str>,
    model: &'a str,
    vector: &'a [f32],
    terms: &'a [String],
    excluded: &'a HashSet<String>,
    limit: usize,
}

impl Asked<'_> {
    /// Whether a source may answer. A document's id begins with a path, so what comes
    /// ahead of its first `/` is empty and names no session.
    fn keeps(&self, source_id: &str) -> bool {
        source_id
            .split_once('/')
            .is_none_or(|(session, _)| !self.excluded.contains(session))
    }

    fn rank(&self, index: &SemanticIndex) -> Result<Option<RankedPassages>, SemanticError> {
        // Several passages can reassemble to one hit, so each ranker goes deeper than
        // the hits asked for.
        let depth = RANKER_DEPTH.max(3 * self.limit);
        let mut top = TopK::new(depth);
        let mut decoded = Vec::new();
        let handed = index.scan_vectors(
            self.kinds,
            self.model,
            self.scope,
            |source_id| self.keeps(source_id),
            |id, blob| {
                if decode_vector_into(blob, &mut decoded) {
                    top.offer(id, self.vector, &decoded);
                }
            },
        )?;
        if handed == 0 {
            return Ok(None);
        }
        let by_meaning: Vec<i64> = top.into_ranked().iter().map(|scored| scored.id).collect();
        let by_word = index.lexical_chunks(
            self.kinds,
            self.scope,
            self.terms,
            |source_id| self.keeps(source_id),
            depth,
        )?;
        let all_terms = index.holds_all_kept(self.kinds, self.scope, self.terms, |source_id| {
            self.keeps(source_id)
        })?;
        let fused = fuse(&[&by_word, &by_meaning], usize::MAX);
        let scores: HashMap<i64, f64> = fused.iter().map(|f| (f.id, f.score)).collect();
        let ids: Vec<i64> = fused.iter().map(|f| f.id).collect();
        Ok(Some(RankedPassages {
            hits: self.hits(index.passages_by_ids(&ids)?, &scores),
            any_terms: !by_word.is_empty(),
            all_terms,
        }))
    }

    /// The embedded passages reassembled and each lexical row a hit of its own, placed
    /// by score. A source's embedded passages and lexical rows have consecutive
    /// ordinals and spans in two different texts, so `reassemble` would splice them.
    fn hits(
        &self,
        found: Vec<super::index::FoundPassage>,
        scores: &HashMap<i64, f64>,
    ) -> Vec<PassageHit> {
        let mut metas: HashMap<(String, String), Option<String>> = HashMap::new();
        let mut embedded: Vec<Hit> = Vec::new();
        let mut hits: Vec<PassageHit> = Vec::new();
        for passage in found {
            let score = scores.get(&passage.chunk_id).copied().unwrap_or(0.0);
            let hit = Hit {
                score,
                ..passage.hit
            };
            if passage.lexical_only {
                hits.push(PassageHit {
                    text: excerpt(&hit.body, self.terms),
                    kind: hit.source_kind,
                    source_id: hit.source_id,
                    context: hit.context,
                    meta: passage.meta,
                    score,
                });
            } else {
                metas.insert(
                    (hit.source_kind.clone(), hit.source_id.clone()),
                    passage.meta,
                );
                embedded.push(hit);
            }
        }
        for span in reassemble(&embedded) {
            let meta = metas
                .get(&(span.source_kind.clone(), span.source_id.clone()))
                .cloned()
                .flatten();
            hits.push(PassageHit {
                kind: span.source_kind,
                source_id: span.source_id,
                context: span.context,
                text: span.text,
                meta,
                score: span.score,
            });
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(self.limit);
        hits
    }
}

/// The bytes around the first of `terms` in `body`, or its head when a stemmed match
/// leaves no term spelled there. A third of the room goes ahead of the term.
fn excerpt(body: &str, terms: &[String]) -> String {
    if body.len() <= SEARCH_SPAN_MAX_BYTES {
        return body.to_string();
    }
    let room = SEARCH_SPAN_MAX_BYTES - ELLIPSES_BYTES;
    let lowered = body.to_ascii_lowercase();
    let at = terms
        .iter()
        .filter_map(|term| lowered.find(term.as_str()))
        .min()
        .unwrap_or(0);
    let mut start = at.saturating_sub(room / 3);
    while !body.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + room).min(body.len());
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let lead = if start > 0 { "…" } else { "" };
    let tail = if end < body.len() { "…" } else { "" };
    format!("{lead}{}{tail}", &body[start..end])
}

/// A read the search can do without: logged, and the caller's plain search stands.
fn read<T>(what: &str, result: Result<T, SemanticError>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(err) => {
            warn!("semantic search: could not read {what}: {err}");
            None
        }
    }
}

/// A source's best passage stands for it, so a long section with many passages
/// does not crowd the list, and each ranker stops at its depth.
fn best_of_each_source(ranked: Vec<&str>) -> Vec<&str> {
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter(|source| seen.insert(*source))
        .take(RANKER_DEPTH)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::coverage::coverage_channel;
    use super::super::embedder::fake::{FakeState, client, vector_of};
    use super::super::index::Replacement;
    use super::*;
    use std::sync::atomic::Ordering;
    use tugsem_core::{Passage, chunk};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: Arc<FakeState>,
        embedder: Arc<EmbedderClient>,
        index: Arc<SemanticIndex>,
        search: SemanticSearch,
    }

    fn fixture(model: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SemanticIndex::open(dir.path().join("semantic.db")).unwrap());
        let state = FakeState::new(model);
        let embedder = client(&state);
        let search = SemanticSearch::new(
            Arc::clone(&index),
            Arc::clone(&embedder),
            coverage_channel(false).1,
        );
        Fixture {
            _dir: dir,
            state,
            embedder,
            index,
            search,
        }
    }

    fn store(f: &Fixture, id: &str, text: &str, model: Option<&str>) {
        let passages = chunk("", text);
        let vectors: Vec<Option<Vec<f32>>> = passages
            .iter()
            .map(|passage| model.map(|_| vector_of(&passage.embedding_text())))
            .collect();
        f.index
            .replace_source(&Replacement {
                kind: "help",
                id,
                content_hash: "hash",
                model,
                passages: &passages,
                vectors: &vectors,
                meta: None,
                lexical: &[],
            })
            .unwrap();
    }

    fn terms(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[tokio::test]
    async fn a_source_found_by_either_ranker_is_in_the_answer_and_both_rank_first() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        // Its words are the query's, so the fake's vectors say it is the nearest,
        // and nothing else holds the exact token.
        store(&f, "near", "open one new arc", Some("m"));
        store(&f, "token", "the flag at0339 is here", Some("m"));
        store(&f, "both", "open one new at0339", Some("m"));

        let ranked = f
            .search
            .rank("help", None, "open one new at0339", &terms(&["at0339"]))
            .await
            .unwrap();
        assert_eq!(ranked.sources[0], "both");
        assert!(ranked.sources.iter().any(|source| source == "near"));
        assert!(ranked.sources.iter().any(|source| source == "token"));
        assert!(ranked.any_terms);
        assert!(ranked.all_terms);
    }

    #[tokio::test]
    async fn a_query_no_passage_words_match_says_so_and_still_ranks_by_meaning() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "a", "some words here", Some("m"));

        let ranked = f
            .search
            .rank("help", None, "zzyzx", &terms(&["zzyzx"]))
            .await
            .unwrap();
        assert_eq!(ranked.sources, vec!["a"]);
        assert!(!ranked.any_terms);
        assert!(!ranked.all_terms);
    }

    #[tokio::test]
    async fn some_words_held_is_not_all_words_held() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "a", "only one word arc", Some("m"));
        let ranked = f
            .search
            .rank("help", None, "arc zzyzx", &terms(&["arc", "zzyzx"]))
            .await
            .unwrap();
        assert!(ranked.any_terms);
        assert!(!ranked.all_terms);
    }

    #[tokio::test]
    async fn a_plural_finds_the_singular_in_the_text_shadow() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "a", "a slot can split", Some("m"));
        let ranked = f
            .search
            .rank("help", None, "splits", &terms(&["splits"]))
            .await
            .unwrap();
        assert!(ranked.all_terms);
    }

    #[tokio::test]
    async fn a_long_source_counts_once() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        let long = (0..40)
            .map(|n| format!("The arc paragraph number {n} says the same few words again and again so that it fills its passage."))
            .collect::<Vec<_>>()
            .join("\n\n");
        store(&f, "long", &long, Some("m"));
        assert!(f.index.chunks().len() > 1);
        let ranked = f
            .search
            .rank("help", None, "arc", &terms(&["arc"]))
            .await
            .unwrap();
        assert_eq!(ranked.sources, vec!["long"]);
    }

    #[tokio::test]
    async fn vectors_of_another_model_are_not_compared() {
        let f = fixture(Some("new"));
        f.embedder.start().await;
        store(&f, "a", "stored under the old model", Some("old"));
        assert_eq!(
            f.search
                .rank("help", None, "model", &terms(&["model"]))
                .await,
            None
        );
    }

    #[tokio::test]
    async fn a_scope_keeps_the_answer_and_its_word_flags_inside_it() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "features#a", "the word zebra lives here", Some("m"));
        store(&f, "glossary#b", "something else altogether", Some("m"));

        let ranked = f
            .search
            .rank("help", Some("glossary#"), "zebra", &terms(&["zebra"]))
            .await
            .unwrap();
        assert_eq!(ranked.sources, vec!["glossary#b"]);
        assert!(!ranked.any_terms, "only the other document holds the word");
        assert!(!ranked.all_terms);
    }

    #[tokio::test]
    async fn sources_outside_a_scope_take_no_place_in_a_rankers_depth() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        for n in 0..RANKER_DEPTH + 5 {
            store(&f, &format!("features#{n}"), "arc arc arc arc", Some("m"));
        }
        store(
            &f,
            "glossary#a",
            "one arc among many other words here",
            Some("m"),
        );

        let ranked = f
            .search
            .rank("help", Some("glossary#"), "arc", &terms(&["arc"]))
            .await
            .unwrap();
        assert_eq!(ranked.sources, vec!["glossary#a"]);
        assert!(ranked.any_terms && ranked.all_terms);
    }

    #[tokio::test]
    async fn another_kind_of_source_is_not_searched() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "a", "help words", Some("m"));
        assert_eq!(
            f.search
                .rank("session", None, "help", &terms(&["help"]))
                .await,
            None
        );
    }

    #[tokio::test]
    async fn with_no_live_model_there_is_no_answer_and_no_helper_is_started() {
        let f = fixture(Some("m"));
        store(&f, "a", "some words", Some("m"));
        assert_eq!(
            f.search
                .rank("help", None, "words", &terms(&["words"]))
                .await,
            None
        );
        assert_eq!(f.state.spawns.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn a_helper_with_no_model_leaves_no_answer() {
        let f = fixture(None);
        f.embedder.start().await;
        store(&f, "a", "some words", None);
        assert_eq!(
            f.search
                .rank("help", None, "words", &terms(&["words"]))
                .await,
            None
        );
    }

    /// An indexer over the fixture's index and embedder.
    fn indexer(f: &Fixture) -> super::super::ingest::Indexer {
        super::super::ingest::Indexer::new(Arc::clone(&f.index), Arc::clone(&f.embedder), None)
    }

    async fn ask(f: &Fixture, query: &str, words: &[&str], limit: usize) -> RankedPassages {
        f.search
            .passages(
                &["help"],
                None,
                query,
                &terms(words),
                &HashSet::new(),
                limit,
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn neighbouring_passages_read_back_as_one_hit_with_their_overlap_removed() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        let long = (0..16)
            .map(|n| {
                format!(
                    "The arc paragraph number {n} {}.",
                    "says the same words ".repeat(12)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        store(&f, "long", &long, Some("m"));
        assert!(f.index.chunks().len() > 1 && f.index.chunks().len() <= RANKER_DEPTH);

        let ranked = ask(&f, "arc", &["arc"], 8).await;
        assert_eq!(ranked.hits.len(), 1);
        assert_eq!(ranked.hits[0].text, long);
    }

    #[tokio::test]
    async fn a_limit_holds_and_each_ranker_goes_deep_enough_to_fill_it() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        for n in 0..40 {
            store(&f, &format!("s{n}"), "arc arc arc", Some("m"));
        }
        assert_eq!(ask(&f, "arc", &["arc"], 3).await.hits.len(), 3);
        assert_eq!(ask(&f, "arc", &["arc"], 20).await.hits.len(), 20);
    }

    #[tokio::test]
    async fn an_excluded_session_takes_no_place_in_either_rankers_depth() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        for n in 0..RANKER_DEPTH + 5 {
            store(&f, &format!("gone/{n}"), "arc arc arc arc", Some("m"));
        }
        store(&f, "kept/1", "one arc among other words", Some("m"));
        store(&f, "gone10/1", "another arc among other words", Some("m"));

        let excluded: HashSet<String> = ["gone".to_string()].into();
        let ranked = f
            .search
            .passages(&["help"], None, "arc", &terms(&["arc"]), &excluded, 20)
            .await
            .unwrap();
        let mut sources: Vec<&str> = ranked.hits.iter().map(|h| h.source_id.as_str()).collect();
        sources.sort();
        assert_eq!(sources, ["gone10/1", "kept/1"]);
    }

    #[tokio::test]
    async fn every_row_excluded_answers_for_no_word_and_no_vector() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "gone/1", "the word zebra", Some("m"));
        let excluded: HashSet<String> = ["gone".to_string()].into();
        let ranked = f
            .search
            .passages(&["help"], None, "zebra", &terms(&["zebra"]), &excluded, 8)
            .await;
        assert_eq!(ranked, None);
    }

    #[tokio::test]
    async fn a_scope_is_read_as_a_range_that_stops_at_its_session() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "s1/a", "the arc is here", Some("m"));
        store(&f, "s10/a", "the arc is here too", Some("m"));
        let ranked = f
            .search
            .passages(
                &["help"],
                Some("s1/"),
                "arc",
                &terms(&["arc"]),
                &HashSet::new(),
                8,
            )
            .await
            .unwrap();
        let sources: Vec<&str> = ranked.hits.iter().map(|h| h.source_id.as_str()).collect();
        assert_eq!(sources, ["s1/a"]);
    }

    /// A body a long way past what a hit shows, with `word` deep inside it.
    fn long_log(word: &str) -> String {
        let padding = "ordinary log line with nothing in it\n".repeat(120);
        format!("{padding}commit {word} built\n{padding}")
    }

    async fn ingest_log(f: &Fixture, text: &str, body: &str) {
        indexer(f)
            .ingest(&super::super::ingest::Source {
                kind: "help",
                id: "log",
                context: "c",
                text,
                session: None,
                meta: Some("{\"role\":\"tool\"}"),
                lexical: Some(body),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_word_only_a_lexical_row_holds_comes_back_excerpted_around_it() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        ingest_log(&f, "The head of a run.", &long_log("9f3c1e5a")).await;

        let ranked = ask(&f, "9f3c1e5a", &["9f3c1e5a"], 8).await;
        let hit = ranked
            .hits
            .iter()
            .find(|hit| hit.text.contains("9f3c1e5a"))
            .expect("the row that holds the sha");
        assert!(
            hit.text.len() <= SEARCH_SPAN_MAX_BYTES,
            "{}",
            hit.text.len()
        );
        assert_eq!(hit.meta.as_deref(), Some("{\"role\":\"tool\"}"));
        assert!(ranked.any_terms);
    }

    #[tokio::test]
    async fn a_passage_and_a_lexical_row_of_one_source_are_two_hits_and_never_spliced() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        ingest_log(&f, "The head says zebra.", &long_log("zebra")).await;

        let ranked = ask(&f, "zebra", &["zebra"], 8).await;
        let head: Vec<&PassageHit> = ranked
            .hits
            .iter()
            .filter(|hit| hit.text.contains("The head"))
            .collect();
        assert_eq!(head.len(), 1);
        assert_eq!(head[0].text, "The head says zebra.");
        assert!(
            ranked.hits.iter().any(
                |hit| hit.text.contains("commit zebra built") && !hit.text.contains("The head")
            )
        );
    }

    #[test]
    fn an_excerpt_stays_inside_its_cap_on_character_boundaries() {
        let body = format!("{}zebra{}", "é".repeat(2000), "ü".repeat(2000));
        let text = excerpt(&body, &terms(&["zebra"]));
        assert!(text.contains("zebra"));
        assert!(text.len() <= SEARCH_SPAN_MAX_BYTES, "{}", text.len());
        assert!(text.starts_with('…') && text.ends_with('…'));
        assert_eq!(excerpt("short", &terms(&["zebra"])), "short");
    }

    #[tokio::test]
    async fn a_search_and_help_search_each_answer_while_a_long_scan_holds_its_read_open() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "s1/a", "the arc is here", Some("m"));
        store(&f, "features#b", "the arc is there", Some("m"));

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let index = Arc::clone(&f.index);
        let scan = std::thread::spawn(move || {
            index
                .scan_vectors(
                    &["help"],
                    "m",
                    None,
                    |_| true,
                    |_, _| {
                        let _ = started_tx.send(());
                        let _ = release_rx.recv();
                    },
                )
                .unwrap()
        });
        started_rx.recv().unwrap();

        let scoped = f
            .search
            .passages(
                &["help"],
                Some("s1/"),
                "arc",
                &terms(&["arc"]),
                &HashSet::new(),
                8,
            )
            .await
            .unwrap();
        assert_eq!(scoped.hits.len(), 1);
        assert!(
            f.search
                .rank("help", None, "arc", &terms(&["arc"]))
                .await
                .is_some()
        );

        drop(release_tx);
        assert_eq!(scan.join().unwrap(), 2);
    }

    /// What a question costs at the size a full catch-up reaches: the count of embedded
    /// passages the corpus chunks to and the lexical rows its tool results make, with a
    /// term common to every row so BM25 has a large match set to order. It prints the
    /// wall times to read against the two seconds that would call for moving the vectors
    /// to a table of their own.
    #[tokio::test]
    #[ignore = "writes an index of a gigabyte and more, and takes minutes"]
    async fn question_cost_reading_at_full_size() {
        const EMBEDDED: usize = 250_000;
        const LEXICAL: usize = 27_500;
        const LEXICAL_BYTES: usize = 16 * 1024;
        const BODY_BYTES: usize = 900;
        const SESSIONS: usize = 200;
        const PER_SOURCE: usize = 64;
        const DIMENSIONS: usize = 512;

        let f = fixture(Some("m"));
        f.embedder.start().await;
        for at in 0..200 {
            store(
                &f,
                &format!("doc#{at}"),
                &format!("common help text {at}"),
                Some("m"),
            );
        }

        // The same bytes every run.
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let passages_of = |next: &mut dyn FnMut() -> u64, count: usize, bytes: usize| {
            (0..count)
                .map(|ordinal| {
                    let mut body = String::from("common");
                    while body.len() < bytes {
                        body.push_str(&format!(" word{}", next() % 20_000));
                    }
                    Passage {
                        context: "curly-apple turn 1 assistant".to_string(),
                        end: body.len(),
                        body,
                        ordinal,
                        start: 0,
                    }
                })
                .collect::<Vec<Passage>>()
        };
        for at in 0..EMBEDDED / PER_SOURCE {
            let passages = passages_of(&mut next, PER_SOURCE, BODY_BYTES);
            let vectors: Vec<Option<Vec<f32>>> = passages
                .iter()
                .map(|_| {
                    Some(
                        (0..DIMENSIONS)
                            .map(|_| (next() % 2001) as f32 / 1000.0 - 1.0)
                            .collect(),
                    )
                })
                .collect();
            f.index
                .replace_source(&Replacement {
                    kind: "transcript",
                    id: &format!("s{}/embedded-{at}.0", at % SESSIONS),
                    content_hash: "hash",
                    model: Some("m"),
                    passages: &passages,
                    vectors: &vectors,
                    meta: None,
                    lexical: &[],
                })
                .unwrap();
        }
        for at in 0..LEXICAL / PER_SOURCE {
            f.index
                .replace_source(&Replacement {
                    kind: "transcript",
                    id: &format!("s{}/lexical-{at}.0", at % SESSIONS),
                    content_hash: "hash",
                    model: None,
                    passages: &[],
                    vectors: &[],
                    meta: None,
                    lexical: &passages_of(&mut next, PER_SOURCE, LEXICAL_BYTES),
                })
                .unwrap();
        }
        let bytes =
            std::fs::metadata(f._dir.path().join("semantic.db")).map_or(0, |file| file.len());
        println!("index: {:.2} GB", bytes as f64 / 1e9);

        let vector: Vec<f32> = (0..DIMENSIONS)
            .map(|_| (next() % 2001) as f32 / 1000.0 - 1.0)
            .collect();
        let question = terms(&["common", "word17"]);
        let excluded = HashSet::new();
        let kinds = ["help", "transcript", "fact", "post", "document"];
        for (label, scope) in [("all kinds", None), ("one session", Some("s0/"))] {
            let asked = Asked {
                kinds: &kinds,
                scope,
                model: "m",
                vector: &vector,
                terms: &question,
                excluded: &excluded,
                limit: 8,
            };
            let started = std::time::Instant::now();
            let ranked = asked.rank(&f.index).unwrap().unwrap();
            println!(
                "passages, {label}: {:?}, {} hits",
                started.elapsed(),
                ranked.hits.len()
            );
        }
        // Where the time of the widest question goes.
        let started = std::time::Instant::now();
        let mut top = TopK::new(RANKER_DEPTH);
        let mut decoded = Vec::new();
        f.index
            .scan_vectors(
                &kinds,
                "m",
                None,
                |_| true,
                |id, blob| {
                    if decode_vector_into(blob, &mut decoded) {
                        top.offer(id, &vector, &decoded);
                    }
                },
            )
            .unwrap();
        println!("the vector scan alone: {:?}", started.elapsed());
        let started = std::time::Instant::now();
        f.index
            .lexical_chunks(&kinds, None, &question, |_| true, RANKER_DEPTH)
            .unwrap();
        println!("the word ranker alone: {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let ranked = f
            .search
            .rank("help", None, "common", &terms(&["common"]))
            .await;
        println!(
            "rank, help: {:?}, answered: {}",
            started.elapsed(),
            ranked.is_some()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_helper_that_never_answers_a_query_leaves_no_answer() {
        let f = fixture(Some("m"));
        f.embedder.start().await;
        store(&f, "a", "some words", Some("m"));
        f.state.silent.store(true, Ordering::Relaxed);
        assert_eq!(
            f.search
                .rank("help", None, "words", &terms(&["words"]))
                .await,
            None
        );
    }
}
