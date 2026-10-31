//! Stored vectors in eight bits, and the in-memory arena a question scans.
//!
//! Mean pooling leaves these vectors a large component they all share, so plain
//! eight bits would spend most of their range on what ranks nothing. A blob is the
//! vector less one offset frozen per model and dimension, as an `f32` scale and an
//! `i8` per dimension. A scan scores `scale * dot(query, q)`, which leaves out
//! `dot(query, offset)`: that is the same for every row of a model, so a rank is
//! what it was, and a score is meaningful only beside another of the same scan.

use std::collections::HashMap;

use crate::score::TopK;

/// The bytes ahead of a blob's dimensions: its scale.
const HEADER_BYTES: usize = 4;
/// The largest step count a dimension's residual is written as.
const STEPS: f32 = 127.0;
/// How many floats the dot adds side by side, which is what lets it vectorize.
const LANES: usize = 16;
/// Where a freed row names its source.
const FREE: u32 = u32::MAX;

/// `vector` as the blob the store holds. A residual of nothing has a scale of 0 and
/// zeros. `vector` and `offset` are one length, which the caller's offset is keyed on.
pub fn quantize(vector: &[f32], offset: &[f32]) -> Vec<u8> {
    let residual = vector.iter().zip(offset).map(|(value, base)| value - base);
    let largest = residual.clone().fold(0.0_f32, |most, r| most.max(r.abs()));
    let scale = if largest > 0.0 && largest.is_finite() {
        largest / STEPS
    } else {
        0.0
    };
    let mut blob = Vec::with_capacity(HEADER_BYTES + vector.len());
    blob.extend_from_slice(&scale.to_le_bytes());
    blob.extend(residual.map(|r| {
        let step = if scale > 0.0 {
            (r / scale).round().clamp(-STEPS, STEPS)
        } else {
            0.0
        };
        step as i8 as u8
    }));
    blob
}

/// The vector a blob holds, to within a step, or `None` for one that is not of
/// `offset`'s dimension.
pub fn dequantize(blob: &[u8], offset: &[f32]) -> Option<Vec<f32>> {
    if blob.len() != HEADER_BYTES + offset.len() {
        return None;
    }
    let scale = f32::from_le_bytes(blob[..HEADER_BYTES].try_into().ok()?);
    Some(
        blob[HEADER_BYTES..]
            .iter()
            .zip(offset)
            .map(|(&step, base)| base + scale * f32::from(step as i8))
            .collect(),
    )
}

/// The dot of a question and a row, in lanes, since a plain float sum may not be
/// reordered and so will not vectorize.
fn lane_dot(query: &[f32], row: &[i8]) -> f32 {
    let mut lanes = [0.0_f32; LANES];
    let mut queries = query.chunks_exact(LANES);
    let mut rows = row.chunks_exact(LANES);
    for (a, b) in (&mut queries).zip(&mut rows) {
        for lane in 0..LANES {
            lanes[lane] += a[lane] * f32::from(b[lane]);
        }
    }
    let tail: f32 = queries
        .remainder()
        .iter()
        .zip(rows.remainder())
        .map(|(a, &b)| a * f32::from(b))
        .sum();
    lanes.iter().sum::<f32>() + tail
}

/// One passage's stored vector, as the arena takes it.
#[derive(Debug, Clone, Copy)]
pub struct ArenaRow<'a> {
    pub chunk_id: i64,
    pub model: &'a str,
    pub blob: &'a [u8],
}

/// The rows of one model at one dimension. A freed row is reused, so a row's place
/// never moves.
#[derive(Debug)]
struct Space {
    model: String,
    dims: usize,
    steps: Vec<i8>,
    scales: Vec<f32>,
    chunk_ids: Vec<i64>,
    sources: Vec<u32>,
    free: Vec<u32>,
}

impl Space {
    fn place(&mut self, chunk_id: i64, source: u32, blob: &[u8]) -> u32 {
        let (head, body) = blob.split_at(HEADER_BYTES);
        let scale = f32::from_le_bytes([head[0], head[1], head[2], head[3]]);
        let row = self.free.pop().unwrap_or_else(|| {
            self.steps.resize(self.steps.len() + self.dims, 0);
            self.scales.push(0.0);
            self.chunk_ids.push(0);
            self.sources.push(FREE);
            (self.sources.len() - 1) as u32
        });
        let at = row as usize;
        for (slot, &byte) in self.steps[at * self.dims..].iter_mut().zip(body) {
            *slot = byte as i8;
        }
        self.scales[at] = scale;
        self.chunk_ids[at] = chunk_id;
        self.sources[at] = source;
        row
    }

    fn free(&mut self, row: u32) {
        self.sources[row as usize] = FREE;
        self.free.push(row);
    }
}

/// Every row of `space` whose source is wanted, offered to `top`. Not generic, so it
/// compiles here at this crate's optimization and not at the caller's.
fn scan_space(space: &Space, query: &[f32], wanted: &[bool], top: &mut TopK) -> usize {
    let mut handed = 0;
    for (at, row) in space.steps.chunks_exact(space.dims).enumerate() {
        let source = space.sources[at];
        if source != FREE && wanted[source as usize] {
            top.offer_score(space.chunk_ids[at], space.scales[at] * lane_dot(query, row));
            handed += 1;
        }
    }
    handed
}

/// The vectors of a ledger, held to be scanned. Filtering is per source, once per
/// question, so what a caller keeps is asked about sources rather than about rows.
#[derive(Debug, Default)]
pub struct VectorArena {
    /// Each source's rows, by slot, as `(space, row)`. A freed slot is empty.
    slots: Vec<Vec<(u32, u32)>>,
    free_slots: Vec<u32>,
    /// Each kind's sources, by id.
    kinds: HashMap<String, HashMap<String, u32>>,
    spaces: Vec<Space>,
}

impl VectorArena {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many vectors it holds.
    pub fn vectors(&self) -> usize {
        self.spaces
            .iter()
            .map(|space| space.chunk_ids.len() - space.free.len())
            .sum()
    }

    /// What its rows take in memory, freed ones included.
    pub fn bytes(&self) -> usize {
        self.spaces
            .iter()
            .map(|space| {
                space.steps.capacity()
                    + size_of::<f32>() * space.scales.capacity()
                    + size_of::<i64>() * space.chunk_ids.capacity()
                    + size_of::<u32>() * (space.sources.capacity() + space.free.capacity())
            })
            .sum()
    }

    /// Hold `rows` as all there is of a source, replacing whatever it held under any
    /// model. A blob with no dimensions is not a row.
    pub fn insert_source<'a>(
        &mut self,
        kind: &str,
        id: &str,
        rows: impl IntoIterator<Item = ArenaRow<'a>>,
    ) {
        self.remove_source(kind, id);
        let mut placed = Vec::new();
        let slot = self.free_slots.last().copied();
        let slot = slot.unwrap_or(self.slots.len() as u32);
        for row in rows {
            if row.blob.len() <= HEADER_BYTES {
                continue;
            }
            let space = self.space_for(row.model, row.blob.len() - HEADER_BYTES);
            let at = self.spaces[space].place(row.chunk_id, slot, row.blob);
            placed.push((space as u32, at));
        }
        if placed.is_empty() {
            return;
        }
        if self.free_slots.last() == Some(&slot) {
            self.free_slots.pop();
            self.slots[slot as usize] = placed;
        } else {
            self.slots.push(placed);
        }
        self.kinds
            .entry(kind.to_string())
            .or_default()
            .insert(id.to_string(), slot);
    }

    /// Let go of a source's rows, for an insert to reuse.
    pub fn remove_source(&mut self, kind: &str, id: &str) {
        let Some(slot) = self.kinds.get_mut(kind).and_then(|ids| ids.remove(id)) else {
            return;
        };
        for (space, row) in std::mem::take(&mut self.slots[slot as usize]) {
            self.spaces[space as usize].free(row);
        }
        self.free_slots.push(slot);
    }

    /// Offer `top` every row of `model` at the question's dimension among
    /// `wanted_kinds` and within `scope`, a source-id prefix, whose source `keep`
    /// allows, and answer how many rows that was.
    pub fn scan(
        &self,
        model: &str,
        query: &[f32],
        wanted_kinds: &[&str],
        scope: Option<&str>,
        mut keep: impl FnMut(&str) -> bool,
        top: &mut TopK,
    ) -> usize {
        let space = self
            .spaces
            .iter()
            .find(|space| space.model == model && space.dims == query.len());
        let Some(space) = space else {
            return 0;
        };
        let mut wanted = vec![false; self.slots.len()];
        for ids in wanted_kinds.iter().filter_map(|kind| self.kinds.get(*kind)) {
            for (id, slot) in ids {
                if scope.is_none_or(|prefix| id.starts_with(prefix)) && keep(id) {
                    wanted[*slot as usize] = true;
                }
            }
        }
        scan_space(space, query, &wanted, top)
    }

    fn space_for(&mut self, model: &str, dims: usize) -> usize {
        let found = self
            .spaces
            .iter()
            .position(|space| space.model == model && space.dims == dims);
        found.unwrap_or_else(|| {
            self.spaces.push(Space {
                model: model.to_string(),
                dims,
                steps: Vec::new(),
                scales: Vec::new(),
                chunk_ids: Vec::new(),
                sources: Vec::new(),
                free: Vec::new(),
            });
            self.spaces.len() - 1
        })
    }

    /// How many rows are in use and how many have been allocated at all.
    #[cfg(test)]
    fn rows(&self) -> (usize, usize) {
        let allocated: usize = self.spaces.iter().map(|space| space.sources.len()).sum();
        let free: usize = self.spaces.iter().map(|space| space.free.len()).sum();
        (allocated - free, allocated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::score::cosine;

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

    const QUESTION: &str = "how do I create an arc?";

    fn the_question(records: &[Recorded]) -> usize {
        records
            .iter()
            .position(|record| record.text == QUESTION && !record.model.contains("sentence"))
            .unwrap()
    }

    /// The same numbers every run.
    fn generator(mut seed: u64) -> impl FnMut() -> f32 {
        move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 2001) as f32 / 1000.0 - 1.0
        }
    }

    /// Unit vectors sharing a large component, as mean pooling leaves them.
    fn pooled(count: usize, dims: usize, seed: u64) -> Vec<Vec<f32>> {
        let mut next = generator(seed);
        let shared: Vec<f32> = (0..dims).map(|_| next()).collect();
        (0..count)
            .map(|_| {
                let raw: Vec<f32> = shared.iter().map(|s| s * 2.0 + next() * 0.5).collect();
                let norm = raw.iter().map(|v| v * v).sum::<f32>().sqrt();
                raw.iter().map(|v| v / norm).collect()
            })
            .collect()
    }

    fn mean(vectors: &[Vec<f32>]) -> Vec<f32> {
        let mut sums = vec![0.0_f32; vectors[0].len()];
        for vector in vectors {
            for (sum, value) in sums.iter_mut().zip(vector) {
                *sum += value / vectors.len() as f32;
            }
        }
        sums
    }

    /// One row of `model` under source `id`, whose chunk is `chunk_id`.
    fn insert(
        arena: &mut VectorArena,
        kind: &str,
        id: &str,
        chunk_id: i64,
        model: &str,
        blob: &[u8],
    ) {
        arena.insert_source(
            kind,
            id,
            [ArenaRow {
                chunk_id,
                model,
                blob,
            }],
        );
    }

    fn scanned(
        arena: &VectorArena,
        model: &str,
        query: &[f32],
        kinds: &[&str],
        scope: Option<&str>,
        keep: impl FnMut(&str) -> bool,
    ) -> (Vec<i64>, usize) {
        let mut top = TopK::new(100);
        let handed = arena.scan(model, query, kinds, scope, keep, &mut top);
        (top.into_ranked().iter().map(|s| s.id).collect(), handed)
    }

    #[test]
    fn a_round_trip_stays_within_one_step_per_dimension() {
        let vectors = pooled(20, 40, 0x2545_f491_4f6c_dd1d);
        let offset = mean(&vectors);
        for vector in &vectors {
            let blob = quantize(vector, &offset);
            assert_eq!(blob.len(), 44);
            let scale = f32::from_le_bytes(blob[..4].try_into().unwrap());
            let back = dequantize(&blob, &offset).unwrap();
            for (value, was) in back.iter().zip(vector) {
                assert!((value - was).abs() <= scale, "{value} {was} {scale}");
            }
        }
    }

    #[test]
    fn a_residual_of_nothing_is_a_zero_scale_and_zeros() {
        let vector = [0.25_f32, -0.5, 0.75];
        let blob = quantize(&vector, &vector);
        assert_eq!(blob, [0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(dequantize(&blob, &vector).unwrap(), vector);
    }

    #[test]
    fn a_blob_of_another_dimension_does_not_dequantize() {
        assert_eq!(dequantize(&[0, 0, 0], &[0.5]), None);
        assert_eq!(dequantize(&[0, 0, 0, 0, 1, 1], &[0.5]), None);
    }

    #[test]
    fn the_lanes_add_what_a_plain_dot_adds() {
        let mut next = generator(7);
        for dims in [1, 15, 16, 17, 32, 512] {
            let query: Vec<f32> = (0..dims).map(|_| next()).collect();
            let row: Vec<i8> = (0..dims).map(|_| (next() * 127.0) as i8).collect();
            let plain: f32 = query.iter().zip(&row).map(|(a, &b)| a * f32::from(b)).sum();
            assert!((lane_dot(&query, &row) - plain).abs() < 1e-2, "{dims}");
        }
    }

    #[test]
    fn ranking_agrees_with_float_cosine_over_a_seeded_sample() {
        const TOP: usize = 20;
        let vectors = pooled(2000, 512, 0x9e37_79b9_7f4a_7c15);
        let queries = pooled(30, 512, 0x9e37_79b9_7f4a_7c15 ^ 0xabcd);
        let offset = mean(&vectors[..16]);
        let mut arena = VectorArena::new();
        for (at, vector) in vectors.iter().enumerate() {
            let blob = quantize(vector, &offset);
            insert(&mut arena, "k", &at.to_string(), at as i64, "m", &blob);
        }
        let mut shared = 0;
        for query in &queries {
            let mut floats: Vec<(usize, f32)> = vectors
                .iter()
                .enumerate()
                .map(|(at, vector)| (at, cosine(query, vector).unwrap()))
                .collect();
            floats.sort_by(|a, b| b.1.total_cmp(&a.1));
            let best: Vec<i64> = floats[..TOP].iter().map(|f| f.0 as i64).collect();
            let mut top = TopK::new(TOP);
            arena.scan("m", query, &["k"], None, |_| true, &mut top);
            shared += top
                .into_ranked()
                .iter()
                .filter(|scored| best.contains(&scored.id))
                .count();
        }
        let overlap = shared as f64 / (TOP * queries.len()) as f64;
        assert!(overlap >= 0.95, "{overlap}");
    }

    #[test]
    fn a_question_ranks_the_section_that_answers_it_over_the_ones_that_do_not() {
        let records = recorded();
        let question = the_question(&records);
        let candidates: Vec<usize> = (0..records.len())
            .filter(|at| *at != question && records[*at].model == records[question].model)
            .collect();
        let vectors: Vec<Vec<f32>> = candidates
            .iter()
            .map(|at| records[*at].vector.clone())
            .collect();
        let offset = mean(&vectors);
        let mut arena = VectorArena::new();
        for at in &candidates {
            let blob = quantize(&records[*at].vector, &offset);
            let id = at.to_string();
            insert(&mut arena, "k", &id, *at as i64, records[*at].model, &blob);
        }
        let mut top = TopK::new(10);
        let query = &records[question].vector;
        arena.scan(
            records[question].model,
            query,
            &["k"],
            None,
            |_| true,
            &mut top,
        );
        let ranked = top.into_ranked();
        assert_eq!(ranked.len(), 3);
        assert_eq!(records[ranked[0].id as usize].text, "Opening an arc");
        assert!(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
    }

    #[test]
    fn a_mixed_model_set_compares_only_the_questions_own_model() {
        let records = recorded();
        let question = the_question(&records);
        assert!(records.len() >= 6);
        let zeros = vec![0.0_f32; 512];
        let mut arena = VectorArena::new();
        for (at, record) in records.iter().enumerate() {
            if at != question {
                assert_eq!(record.vector.len(), 512);
                let blob = quantize(&record.vector, &zeros);
                insert(
                    &mut arena,
                    "k",
                    &at.to_string(),
                    at as i64,
                    record.model,
                    &blob,
                );
            }
        }
        let query = &records[question].vector;
        let (ids, handed) = scanned(&arena, records[question].model, query, &["k"], None, |_| {
            true
        });
        assert!(handed > 0);
        for id in ids {
            assert_eq!(records[id as usize].model, records[question].model);
        }
        assert_eq!(
            scanned(&arena, "nl-other-r9", query, &["k"], None, |_| true).1,
            0
        );
    }

    #[test]
    fn removing_a_source_frees_its_rows_and_an_insert_reuses_them() {
        let vector = [0.6_f32, 0.8];
        let blob = quantize(&vector, &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        insert(&mut arena, "k", "a", 1, "m", &blob);
        insert(&mut arena, "k", "b", 2, "m", &blob);
        assert_eq!(arena.rows(), (2, 2));

        arena.remove_source("k", "a");
        assert_eq!(arena.rows(), (1, 2));
        assert_eq!(
            scanned(&arena, "m", &vector, &["k"], None, |_| true),
            (vec![2], 1)
        );

        insert(&mut arena, "k", "c", 3, "m", &blob);
        assert_eq!(arena.rows(), (2, 2));
        assert_eq!(arena.slots.len(), 2, "the freed slot is reused too");
        assert_eq!(
            scanned(&arena, "m", &vector, &["k"], None, |_| true),
            (vec![2, 3], 2)
        );

        arena.remove_source("k", "never held");
        assert_eq!(arena.rows(), (2, 2));
    }

    #[test]
    fn a_source_replaced_under_a_new_model_leaves_the_old_ones_rows_gone() {
        let vector = [0.6_f32, 0.8];
        let blob = quantize(&vector, &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        insert(&mut arena, "k", "a", 1, "old", &blob);
        insert(&mut arena, "k", "a", 1, "new", &blob);
        assert_eq!(scanned(&arena, "old", &vector, &["k"], None, |_| true).1, 0);
        assert_eq!(
            scanned(&arena, "new", &vector, &["k"], None, |_| true),
            (vec![1], 1)
        );
    }

    #[test]
    fn a_source_with_no_row_left_is_held_by_nothing() {
        let blob = quantize(&[0.6, 0.8], &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        insert(&mut arena, "k", "a", 1, "m", &blob);
        arena.insert_source("k", "a", []);
        assert_eq!(arena.rows(), (0, 1));
        assert_eq!(
            scanned(&arena, "m", &[0.6, 0.8], &["k"], None, |_| true).1,
            0
        );
    }

    #[test]
    fn a_source_may_hold_rows_of_two_dimensions() {
        let short = quantize(&[0.6, 0.8], &[0.0, 0.0]);
        let long = quantize(&[0.6, 0.8, 0.0], &[0.0, 0.0, 0.0]);
        let mut arena = VectorArena::new();
        let row = |chunk_id, blob| ArenaRow {
            chunk_id,
            model: "m",
            blob,
        };
        arena.insert_source(
            "k",
            "a",
            [row(1, short.as_slice()), row(2, long.as_slice())],
        );
        assert_eq!(
            scanned(&arena, "m", &[0.6, 0.8], &["k"], None, |_| true),
            (vec![1], 1)
        );
        assert_eq!(
            scanned(&arena, "m", &[0.6, 0.8, 0.0], &["k"], None, |_| true),
            (vec![2], 1)
        );
        arena.remove_source("k", "a");
        assert_eq!(arena.rows(), (0, 2));
    }

    #[test]
    fn a_blob_too_short_to_be_a_row_is_skipped() {
        let good = quantize(&[0.6, 0.8], &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        let row = |chunk_id, blob| ArenaRow {
            chunk_id,
            model: "m",
            blob,
        };
        arena.insert_source(
            "k",
            "a",
            [
                row(1, [0_u8, 1].as_slice()),
                row(2, [0_u8, 0, 0, 0].as_slice()),
                row(3, good.as_slice()),
            ],
        );
        assert_eq!(
            scanned(&arena, "m", &[0.6, 0.8], &["k"], None, |_| true),
            (vec![3], 1)
        );
    }

    #[test]
    fn a_scan_filters_by_kind_scope_and_keep_with_counts() {
        let vector = [0.6_f32, 0.8];
        let blob = quantize(&vector, &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        insert(&mut arena, "help", "features#a", 1, "m", &blob);
        insert(&mut arena, "transcript", "s1/a", 2, "m", &blob);
        insert(&mut arena, "transcript", "s1/b", 3, "m", &blob);
        insert(&mut arena, "transcript", "s10/a", 4, "m", &blob);

        let all = ["help", "transcript"];
        assert_eq!(scanned(&arena, "m", &vector, &all, None, |_| true).1, 4);
        assert_eq!(
            scanned(&arena, "m", &vector, &["help"], None, |_| true),
            (vec![1], 1)
        );
        assert_eq!(
            scanned(&arena, "m", &vector, &all, Some("s1/"), |_| true),
            (vec![2, 3], 2)
        );
        assert_eq!(
            scanned(&arena, "m", &vector, &all, None, |id| id != "s1/a"),
            (vec![1, 3, 4], 3)
        );
        assert_eq!(
            scanned(&arena, "m", &vector, &["post"], None, |_| true).1,
            0
        );
    }

    #[test]
    fn a_question_of_another_dimension_or_model_hands_nothing() {
        let blob = quantize(&[0.6, 0.8], &[0.0, 0.0]);
        let mut arena = VectorArena::new();
        insert(&mut arena, "k", "a", 1, "m", &blob);
        assert_eq!(
            scanned(&arena, "m", &[1.0, 0.0, 0.0], &["k"], None, |_| true).1,
            0
        );
        assert_eq!(
            scanned(&arena, "other", &[1.0, 0.0], &["k"], None, |_| true).1,
            0
        );
    }
}
