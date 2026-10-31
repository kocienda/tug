//! Ranking: the best of a stream of scores, reciprocal rank fusion of any rank
//! lists, and cosine for whoever holds two whole vectors.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::collections::HashMap;

/// The fusion constant from the method's original paper, which damps the gap
/// between the top ranks so that no one list decides alone.
const RRF_K: f64 = 60.0;

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

/// The best `limit` of a stream of scores, holding no more than that: best score
/// first, ties to the lower id.
#[derive(Debug)]
pub struct TopK {
    limit: usize,
    heap: BinaryHeap<Held>,
}

/// Orders worst first at the top of the heap, which is the one a better score evicts.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Held(Scored);

impl Eq for Held {}

impl Ord for Held {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .score
            .total_cmp(&self.0.score)
            .then(self.0.id.cmp(&other.0.id))
    }
}

impl PartialOrd for Held {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl TopK {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: BinaryHeap::with_capacity(limit),
        }
    }

    /// Offer a candidate's score.
    pub fn offer_score(&mut self, id: i64, score: f32) {
        let held = Held(Scored { id, score });
        if self.heap.len() < self.limit {
            self.heap.push(held);
        } else if let Some(mut worst) = self.heap.peek_mut()
            && held < *worst
        {
            *worst = held;
        }
    }

    /// What was kept, best first.
    pub fn into_ranked(self) -> Vec<Scored> {
        self.heap
            .into_sorted_vec()
            .into_iter()
            .map(|held| held.0)
            .collect()
    }
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

    /// Unit vectors at many angles, several of them equal, so ties are in play.
    fn fan(count: usize) -> Vec<Scored> {
        (0..count)
            .map(|n| {
                let angle = (n % 7) as f32 * 0.3;
                let vector = [angle.cos(), angle.sin()];
                Scored {
                    id: n as i64,
                    score: cosine(&[0.8, 0.6], &vector).unwrap(),
                }
            })
            .collect()
    }

    #[test]
    fn top_k_keeps_the_best_in_order_with_ties_to_the_lower_id() {
        let scored = fan(50);
        for limit in [0, 1, 5, 20, 50, 80] {
            let mut top = TopK::new(limit);
            for item in &scored {
                top.offer_score(item.id, item.score);
            }
            let mut expected = scored.clone();
            expected.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
            expected.truncate(limit);
            assert_eq!(top.into_ranked(), expected, "limit {limit}");
        }
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
