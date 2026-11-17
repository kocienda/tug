//! A chart's table alternative: the same data as rows of text. It is what
//! a reader who cannot see the figure reads, and it is what transcript
//! Find counts, so it is built from the spec alone and needs no
//! measurement.

use serde::Serialize;

use super::forms::histogram;
use super::spec::{Annotation, Data, Dot, Series, Spec, MAX_SET};

pub use super::spec::RefSlot;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ChartTable {
    pub caption: String,
    pub head: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// What the rows, columns, cells, dots and marks name, from the spec's
    /// ref slots. Absent from the wire when the spec carries none, so a
    /// chart without refs serializes as it always has.
    #[serde(skip_serializing_if = "TableRefs::is_empty")]
    pub refs: TableRefs,
    /// The spec's `source`, verbatim: the recipe a reader asks again for a
    /// mark's members. Absent from the wire when the spec has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<serde_json::Value>,
}

/// A table's refs, addressed as its text is: by row, by head column, by
/// cell, by a dot within its row, and by mark annotation. Each list is empty
/// when nothing at that address carries a ref.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TableRefs {
    /// Per table row.
    pub rows: Vec<Option<RefSlot>>,
    /// Per head column; index 0, the label column, is always `None`.
    pub cols: Vec<Option<RefSlot>>,
    /// `[row][col]`, column 0 always `None`.
    pub cells: Vec<Vec<Option<RefSlot>>>,
    /// `dots` only: `[row][dot index]`.
    pub items: Vec<Vec<Option<RefSlot>>>,
    /// The mark annotations that carry a ref, in annotation order.
    pub marks: Vec<MarkRef>,
}

impl TableRefs {
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
            && self.cols.is_empty()
            && self.cells.is_empty()
            && self.items.is_empty()
            && self.marks.is_empty()
    }
}

/// A mark annotation's ref: `index` among the spec's annotations, the
/// category `at` it marks, and its label (empty when it has none).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MarkRef {
    pub index: usize,
    pub at: usize,
    pub label: String,
    pub slot: RefSlot,
}

/// `slots`, or nothing when not one of them holds a ref.
fn some_or_none(slots: Vec<Option<RefSlot>>) -> Vec<Option<RefSlot>> {
    if slots.iter().all(Option::is_none) {
        Vec::new()
    } else {
        slots
    }
}

/// A grid of slots, or nothing when not one of its cells holds a ref.
fn grid_or_none(grid: Vec<Vec<Option<RefSlot>>>) -> Vec<Vec<Option<RefSlot>>> {
    if grid.iter().flatten().all(Option::is_none) {
        Vec::new()
    } else {
        grid
    }
}

/// A category table's refs: a row per label, a column per series, a cell
/// per value.
fn category_refs(n: usize, rows: &[Option<RefSlot>], series: &[Series]) -> TableRefs {
    let mut cols = vec![None];
    cols.extend(series.iter().map(|s| s.ref_slot.clone()));
    let cells = (0..n)
        .map(|i| {
            let mut row = vec![None];
            row.extend(series.iter().map(|s| s.refs.get(i).cloned().flatten()));
            row
        })
        .collect();
    TableRefs {
        rows: some_or_none(rows.to_vec()),
        cols: some_or_none(cols),
        cells: grid_or_none(cells),
        ..TableRefs::default()
    }
}

/// A histogram bin's slot, from its samples' refs. Every sample carrying
/// one, and their union fitting a set, gives the union; otherwise the bin's
/// whole sample count, so a set never reads fewer than the bar it labels. A
/// bin where no sample carries one has none.
fn bin_slot(samples: &[usize], refs: &[Option<String>]) -> Option<RefSlot> {
    let carried: Vec<&String> = samples
        .iter()
        .filter_map(|&i| refs.get(i).and_then(Option::as_ref))
        .collect();
    let first = carried.first()?;
    let kind = first.split_once(':').map_or(first.as_str(), |(k, _)| k);
    let count = RefSlot::Count {
        kind: kind.to_string(),
        count: samples.len() as u32,
    };
    if carried.len() < samples.len() {
        return Some(count);
    }
    let mut members: Vec<String> = Vec::new();
    for r in carried {
        if !members.contains(r) {
            members.push(r.clone());
        }
    }
    match members.len() {
        1 => members.pop().map(RefSlot::One),
        n if n <= MAX_SET => Some(RefSlot::Set {
            kind: kind.to_string(),
            members,
        }),
        _ => Some(count),
    }
}

/// The table's refs for a validated spec, at the addresses [`table`] lays
/// its text out in.
fn refs(spec: &Spec) -> TableRefs {
    let mut out = match &spec.data {
        Data::Bar {
            categories,
            series,
            refs,
            ..
        } => category_refs(categories.len(), refs, series),
        Data::Line { x, series, refs }
        | Data::Area {
            x, series, refs, ..
        } => category_refs(x.len(), refs, series),
        Data::Heat { refs, .. } => TableRefs {
            rows: some_or_none(refs.clone()),
            ..TableRefs::default()
        },
        Data::Dots { rows } => TableRefs {
            rows: some_or_none(rows.iter().map(|r| r.ref_slot.clone()).collect()),
            items: grid_or_none(rows.iter().map(|r| r.refs.clone()).collect()),
            ..TableRefs::default()
        },
        Data::Spans { items } => TableRefs {
            rows: some_or_none(items.iter().map(|i| i.ref_slot.clone()).collect()),
            ..TableRefs::default()
        },
        Data::Bullet { items } => TableRefs {
            rows: some_or_none(items.iter().map(|i| i.ref_slot.clone()).collect()),
            ..TableRefs::default()
        },
        Data::Scatter { series, .. } => TableRefs {
            rows: some_or_none(
                series
                    .iter()
                    .flat_map(|s| (0..s.points.len()).map(|k| s.refs.get(k).cloned().flatten()))
                    .collect(),
            ),
            ..TableRefs::default()
        },
        Data::Histogram { values, bins, refs } if !refs.is_empty() => {
            let bins = histogram::bins(values, *bins, spec.format);
            TableRefs {
                rows: some_or_none(bins.members.iter().map(|s| bin_slot(s, refs)).collect()),
                ..TableRefs::default()
            }
        }
        Data::Histogram { .. } | Data::Sparkline { .. } => TableRefs::default(),
    };
    out.marks = spec
        .annotations
        .iter()
        .enumerate()
        .filter_map(|(index, a)| match a {
            Annotation::Mark {
                at,
                label,
                ref_slot: Some(slot),
            } => Some(MarkRef {
                index,
                at: *at,
                label: label.clone().unwrap_or_default(),
                slot: slot.clone(),
            }),
            _ => None,
        })
        .collect();
    out
}

impl ChartTable {
    /// The text Find indexes: the caption, then the head, then the rows,
    /// row-major, joined with nothing — the order the deck's `<table>`
    /// holds them in.
    pub fn find_text(&self) -> String {
        let mut s = self.caption.clone();
        for cell in self.head.iter().chain(self.rows.iter().flatten()) {
            s.push_str(cell);
        }
        s
    }
}

/// A histogram's bins as the table lays them out: each bin's label, and
/// the indices into `values` of the samples it holds. `None` for any other
/// form. It is what a reader who presses a bin needs to name the samples
/// behind it, binned exactly as the figure binned them.
pub fn histogram_bins(spec: &Spec) -> Option<(Vec<String>, Vec<Vec<usize>>)> {
    let Data::Histogram { values, bins, .. } = &spec.data else {
        return None;
    };
    let bins = histogram::bins(values, *bins, spec.format);
    Some((bins.labels, bins.members))
}

/// The table for a validated spec, each form in its natural columns. A
/// gap is an empty cell.
pub fn table(spec: &Spec) -> ChartTable {
    let fmt = |v: &Option<f64>| v.map(|v| spec.format.apply(v)).unwrap_or_default();
    let by_category = |labels: &[String], series: &[Series]| {
        let mut head = vec![String::new()];
        head.extend(series.iter().map(|s| s.name.clone()));
        let rows = labels
            .iter()
            .enumerate()
            .map(|(i, label)| {
                let mut row = vec![label.clone()];
                row.extend(series.iter().map(|s| fmt(&s.values[i])));
                row
            })
            .collect();
        (head, rows)
    };
    let one_value = |labels: &[String], values: &[Option<f64>]| {
        (
            vec![
                String::new(),
                spec.title.clone().unwrap_or_else(|| "value".into()),
            ],
            labels
                .iter()
                .zip(values)
                .map(|(l, v)| vec![l.clone(), fmt(v)])
                .collect(),
        )
    };
    let (head, rows) = match &spec.data {
        Data::Bar {
            categories, series, ..
        } => by_category(categories, series),
        Data::Line { x, series, .. } | Data::Area { x, series, .. } => by_category(x, series),
        Data::Sparkline { values, .. } => {
            let labels: Vec<String> = (1..=values.len()).map(|i| i.to_string()).collect();
            one_value(&labels, values)
        }
        Data::Dots { rows } => (
            ["", "good", "bad", "neutral"].map(String::from).to_vec(),
            rows.iter()
                .map(|r| {
                    let count = |d: Dot| r.items.iter().filter(|i| **i == d).count().to_string();
                    vec![
                        r.label.clone(),
                        count(Dot::Good),
                        count(Dot::Bad),
                        count(Dot::Neutral),
                    ]
                })
                .collect(),
        ),
        Data::Histogram { values, bins, .. } => {
            let bins = histogram::bins(values, *bins, spec.format);
            (
                vec![String::new(), "count".to_string()],
                bins.labels
                    .iter()
                    .zip(&bins.counts)
                    .map(|(l, c)| vec![l.clone(), c.to_string()])
                    .collect(),
            )
        }
        Data::Spans { items } => (
            ["", "start", "end", "status"].map(String::from).to_vec(),
            items
                .iter()
                .map(|i| {
                    vec![
                        i.label.clone(),
                        spec.format.apply(i.start),
                        spec.format.apply(i.end),
                        i.status.clone().unwrap_or_default(),
                    ]
                })
                .collect(),
        ),
        Data::Heat {
            categories, values, ..
        } => one_value(categories, values),
        Data::Bullet { items } => (
            ["", "value", "range", "target"].map(String::from).to_vec(),
            items
                .iter()
                .map(|i| {
                    vec![
                        i.label.clone(),
                        spec.format.apply(i.value),
                        i.range
                            .map(|(a, z)| {
                                format!("{}–{}", spec.format.apply(a), spec.format.apply(z))
                            })
                            .unwrap_or_default(),
                        i.target.map(|t| spec.format.apply(t)).unwrap_or_default(),
                    ]
                })
                .collect(),
        ),
        Data::Scatter {
            series,
            x_unit,
            x_format,
        } => (
            vec![
                String::new(),
                x_unit.clone().unwrap_or_else(|| "x".into()),
                spec.unit.clone().unwrap_or_else(|| "y".into()),
            ],
            series
                .iter()
                .flat_map(|s| {
                    s.points.iter().map(|(x, y)| {
                        vec![s.name.clone(), x_format.apply(*x), spec.format.apply(*y)]
                    })
                })
                .collect(),
        ),
    };
    ChartTable {
        caption: spec.title.clone().unwrap_or_default(),
        head,
        rows,
        refs: refs(spec),
        source: spec.source.clone(),
    }
}
