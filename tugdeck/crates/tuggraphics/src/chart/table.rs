//! A chart's table alternative: the same data as rows of text. It is what
//! a reader who cannot see the figure reads, and it is what transcript
//! Find counts, so it is built from the spec alone and needs no
//! measurement.

use serde::Serialize;

use super::forms::histogram;
use super::spec::{Data, Dot, Series, Spec};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ChartTable {
    pub caption: String,
    pub head: Vec<String>,
    pub rows: Vec<Vec<String>>,
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
        Data::Line { x, series } | Data::Area { x, series, .. } => by_category(x, series),
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
        Data::Histogram { values, bins } => {
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
        Data::Heat { categories, values } => one_value(categories, values),
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
    };
    ChartTable {
        caption: spec.title.clone().unwrap_or_default(),
        head,
        rows,
    }
}
