//! Ranking: brute-force cosine over a model's vectors, and reciprocal rank fusion
//! of any rank lists.

use std::collections::HashMap;

/// The fusion constant from the method's original paper, which damps the gap
/// between the top ranks so that no one list decides alone.
const RRF_K: f64 = 60.0;

/// A question's vector, and the model that made it.
#[derive(Debug, Clone, Copy)]
pub struct Query<'a> {
    pub model: &'a str,
    pub vector: &'a [f32],
}

/// A stored vector to compare a question against.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub id: i64,
    pub model: &'a str,
    pub vector: &'a [f32],
}

/// A candidate's similarity to a question.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scored {
    pub id: i64,
    pub score: f32,
}

/// An item's fused score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fused {
    pub id: i64,
    pub score: f64,
}

/// The cosine of two vectors, or `None` when there is no such number: they differ
/// in length, or one has no direction.
pub fn cosine(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() {
        return None;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0_f32, 0.0_f32, 0.0_f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let score = dot / (norm_a * norm_b).sqrt();
    score.is_finite().then_some(score)
}

/// The candidates most like the question, best first, at most `limit`.
///
/// Only vectors of the question's own model are compared. Two models' spaces are
/// unrelated even at the same dimension, so a score across them would look like
/// an answer and mean nothing.
pub fn rank_by_similarity<'a>(
    query: Query<'_>,
    candidates: impl IntoIterator<Item = Candidate<'a>>,
    limit: usize,
) -> Vec<Scored> {
    let mut scored: Vec<Scored> = candidates
        .into_iter()
        .filter(|candidate| candidate.model == query.model)
        .filter_map(|candidate| {
            let score = cosine(query.vector, candidate.vector)?;
            Some(Scored {
                id: candidate.id,
                score,
            })
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
    scored.truncate(limit);
    scored
}

/// Fuse rank lists by reciprocal rank, best first, at most `limit`.
///
/// Each list gives an item `1 / (k + rank)`, so an item two lists agree on beats
/// one a single list loves, and the scores of the lists themselves, which are not
/// comparable, play no part. A list that found nothing simply adds nothing, which
/// leaves the other's order standing. Ties go to the better single rank, then to
/// the earlier list, then to the lower id.
pub fn fuse(rankers: &[&[i64]], limit: usize) -> Vec<Fused> {
    struct Entry {
        score: f64,
        best_rank: usize,
        first_ranker: usize,
    }

    let mut entries: HashMap<i64, Entry> = HashMap::new();
    for (ranker, ids) in rankers.iter().enumerate() {
        let mut seen = std::collections::HashSet::new();
        for (index, &id) in ids.iter().enumerate() {
            if !seen.insert(id) {
                continue;
            }
            let rank = index + 1;
            let share = 1.0 / (RRF_K + rank as f64);
            entries
                .entry(id)
                .and_modify(|entry| {
                    entry.score += share;
                    entry.best_rank = entry.best_rank.min(rank);
                })
                .or_insert(Entry {
                    score: share,
                    best_rank: rank,
                    first_ranker: ranker,
                });
        }
    }

    let mut ordered: Vec<(i64, Entry)> = entries.into_iter().collect();
    ordered.sort_by(|(a_id, a), (b_id, b)| {
        b.score
            .total_cmp(&a.score)
            .then(a.best_rank.cmp(&b.best_rank))
            .then(a.first_ranker.cmp(&b.first_ranker))
            .then(a_id.cmp(b_id))
    });
    ordered.truncate(limit);
    ordered
        .into_iter()
        .map(|(id, entry)| Fused {
            id,
            score: entry.score,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors `tugembed` wrote on 2026-10-30, one line per text: the model, the
    /// text, and six-decimal floats.
    const RECORDED: &str = include_str!("../fixtures/recorded-vectors.tsv");

    struct Recorded {
        model: &'static str,
        text: &'static str,
        vector: Vec<f32>,
    }

    fn recorded() -> Vec<Recorded> {
        RECORDED
            .lines()
            .map(|line| {
                let mut fields = line.split('\t');
                Recorded {
                    model: fields.next().unwrap(),
                    text: fields.next().unwrap(),
                    vector: fields
                        .next()
                        .unwrap()
                        .split(' ')
                        .map(|value| value.parse().unwrap())
                        .collect(),
                }
            })
            .collect()
    }

    fn one(records: &[Recorded], static_model: bool, text: &str) -> usize {
        records
            .iter()
            .position(|record| {
                record.text == text && record.model.contains("sentence") == static_model
            })
            .unwrap()
    }

    fn ids(scored: &[Scored]) -> Vec<i64> {
        scored.iter().map(|item| item.id).collect()
    }

    const QUESTION: &str = "how do I create an arc?";

    #[test]
    fn recorded_vectors_are_512_floats_of_unit_length() {
        let records = recorded();
        assert!(records.len() >= 6);
        for record in &records {
            assert_eq!(record.vector.len(), 512);
            let norm: f32 = record.vector.iter().map(|value| value * value).sum();
            assert!((norm - 1.0).abs() < 1e-3, "{} {norm}", record.text);
        }
    }

    #[test]
    fn a_question_ranks_the_section_that_answers_it_over_the_ones_that_do_not() {
        let records = recorded();
        let question = one(&records, false, QUESTION);
        let candidates: Vec<Candidate> = records
            .iter()
            .enumerate()
            .filter(|(index, record)| *index != question && !record.model.contains("sentence"))
            .map(|(index, record)| Candidate {
                id: index as i64,
                model: record.model,
                vector: &record.vector,
            })
            .collect();
        let query = Query {
            model: records[question].model,
            vector: &records[question].vector,
        };
        let ranked = rank_by_similarity(query, candidates, 10);
        assert_eq!(ranked.len(), 3);
        assert_eq!(records[ranked[0].id as usize].text, "Opening an arc");
        assert!(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
    }

    #[test]
    fn a_mixed_model_set_compares_only_the_questions_own_model() {
        let records = recorded();
        let question = one(&records, false, QUESTION);
        let candidates: Vec<Candidate> = records
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != question)
            .map(|(index, record)| Candidate {
                id: index as i64,
                model: record.model,
                vector: &record.vector,
            })
            .collect();
        let query = Query {
            model: records[question].model,
            vector: &records[question].vector,
        };
        let ranked = rank_by_similarity(query, candidates, 10);
        assert!(!ranked.is_empty());
        for item in &ranked {
            assert_eq!(records[item.id as usize].model, records[question].model);
        }

        let unknown = Query {
            model: "nl-other-en-r9",
            vector: &records[question].vector,
        };
        let candidates = records.iter().map(|record| Candidate {
            id: 0,
            model: record.model,
            vector: &record.vector,
        });
        assert!(rank_by_similarity(unknown, candidates, 10).is_empty());
    }

    #[test]
    fn cosine_ignores_length_and_refuses_what_has_no_answer() {
        assert_eq!(cosine(&[2.0, 0.0], &[5.0, 0.0]), Some(1.0));
        assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]), Some(0.0));
        assert_eq!(cosine(&[1.0, 0.0], &[-1.0, 0.0]), Some(-1.0));
        assert_eq!(cosine(&[1.0], &[1.0, 0.0]), None);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 0.0]), None);
        assert_eq!(cosine(&[f32::NAN, 0.0], &[1.0, 0.0]), None);
    }

    #[test]
    fn similarity_breaks_ties_by_id_and_honours_the_limit() {
        let vector = [1.0_f32, 0.0];
        let candidates = [3, 1, 2].map(|id| Candidate {
            id,
            model: "m",
            vector: &vector,
        });
        let query = Query {
            model: "m",
            vector: &vector,
        };
        assert_eq!(ids(&rank_by_similarity(query, candidates, 2)), vec![1, 2]);
    }

    #[test]
    fn a_vector_of_another_length_is_skipped_not_fatal() {
        let short = [1.0_f32];
        let good = [1.0_f32, 0.0];
        let candidates = [
            Candidate {
                id: 1,
                model: "m",
                vector: &short,
            },
            Candidate {
                id: 2,
                model: "m",
                vector: &good,
            },
        ];
        let query = Query {
            model: "m",
            vector: &good,
        };
        assert_eq!(ids(&rank_by_similarity(query, candidates, 5)), vec![2]);
    }

    fn fused_ids(fused: &[Fused]) -> Vec<i64> {
        fused.iter().map(|item| item.id).collect()
    }

    #[test]
    fn fusion_where_one_ranker_returns_nothing_keeps_the_others_order() {
        let lexical: &[i64] = &[];
        let semantic: &[i64] = &[7, 3, 9];
        assert_eq!(fused_ids(&fuse(&[lexical, semantic], 10)), vec![7, 3, 9]);
        assert_eq!(fused_ids(&fuse(&[semantic, lexical], 10)), vec![7, 3, 9]);
    }

    #[test]
    fn fusion_of_nothing_is_nothing() {
        let empty: &[i64] = &[];
        assert!(fuse(&[empty, empty], 10).is_empty());
        assert!(fuse(&[], 10).is_empty());
    }

    #[test]
    fn an_item_both_rankers_found_beats_the_top_of_either() {
        let lexical: &[i64] = &[1, 2, 3];
        let semantic: &[i64] = &[4, 5, 2];
        let fused = fuse(&[lexical, semantic], 10);
        assert_eq!(fused[0].id, 2);
        assert!((fused[0].score - (1.0 / 62.0 + 1.0 / 63.0)).abs() < 1e-12);
    }

    #[test]
    fn fusion_ties_go_to_the_earlier_ranker_and_the_limit_cuts_after_ranking() {
        let lexical: &[i64] = &[10, 11];
        let semantic: &[i64] = &[20, 21];
        assert_eq!(
            fused_ids(&fuse(&[lexical, semantic], 10)),
            vec![10, 20, 11, 21]
        );
        assert_eq!(fused_ids(&fuse(&[lexical, semantic], 3)), vec![10, 20, 11]);
    }

    #[test]
    fn a_ranker_repeating_an_item_counts_it_once() {
        let once = fuse(&[&[1, 2]], 10);
        let twice = fuse(&[&[1, 1, 2]], 10);
        assert_eq!(once[0], twice[0]);
    }
}
