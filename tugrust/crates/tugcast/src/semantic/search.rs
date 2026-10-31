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

use tracing::warn;
use tugsem_core::{Candidate, Query, fuse, rank_by_similarity};

use super::embedder::EmbedderClient;
use super::index::{SemanticError, SemanticIndex};

/// How long a question waits for its own vector. Inside the verb's ceiling, and
/// short because the fallback is a good search rather than an empty one.
const QUERY_EMBED_TIMEOUT: Duration = Duration::from_secs(3);

/// How many sources each ranker hands to the fusion. A source either list ranks
/// below this adds too little to reciprocal rank to matter.
const RANKER_DEPTH: usize = 20;

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

pub(crate) struct SemanticSearch {
    index: Arc<SemanticIndex>,
    embedder: Arc<EmbedderClient>,
}

impl SemanticSearch {
    pub(crate) fn new(index: Arc<SemanticIndex>, embedder: Arc<EmbedderClient>) -> Self {
        Self { index, embedder }
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
    use super::super::embedder::fake::{FakeState, client, vector_of};
    use super::super::index::Replacement;
    use super::*;
    use std::sync::atomic::Ordering;
    use tugsem_core::chunk;

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
        let search = SemanticSearch::new(Arc::clone(&index), Arc::clone(&embedder));
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
