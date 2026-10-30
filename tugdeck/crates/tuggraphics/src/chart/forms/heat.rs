//! `heat`: one row of cells, a cell per category, `accent` at five opacity
//! steps by quantile so the darkest fifth of the values is the darkest
//! fifth of the strip whatever their spread; a gap is a `grid` cell. The
//! category labels are thinned as a bar chart's are.

use super::{category_labels, header, measure_header, Builder, Plot, GAP, LABEL_ROW};
use crate::chart::build::rect;
use crate::chart::spec::Spec;
use crate::draw::{ColourRole, Enter};
use crate::measure::{Measure, TypeRole};

const STEPS: f64 = 5.0;

pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    categories: &[String],
    values: &[Option<f64>],
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    measure_header(spec, m);
    for c in categories {
        m.measure(TypeRole::Label, c);
    }
    let mut y = header(b, spec, w, m);
    if y > 0.0 {
        y += GAP;
    }
    let top = y;
    let bottom = h - LABEL_ROW - 4.0;
    let plot = Plot::bands_only(0.0, w, top, bottom, categories.len());
    let band = plot.band();
    let gap = if band > 6.0 { 1.0 } else { 0.0 };
    let mut finite: Vec<f64> = values.iter().flatten().copied().collect();
    finite.sort_by(f64::total_cmp);
    if bottom > top {
        for (i, v) in values.iter().enumerate() {
            let cell = rect(plot.left + band * i as f64 + gap, top, band - 2.0 * gap, bottom - top);
            match v {
                None => b.fill(cell, ColourRole::Grid, b.enter(Enter::Fade, i)),
                Some(v) => {
                    // The share of values at or below this one, in fifths.
                    let at_or_below = finite.partition_point(|f| f <= v) as f64;
                    let step = (at_or_below / finite.len() as f64 * STEPS).ceil().clamp(1.0, STEPS);
                    b.fill_opacity(cell, ColourRole::Accent, step / STEPS, b.enter(Enter::Fade, i));
                }
            }
        }
    }
    category_labels(b, &plot, categories, w, h - LABEL_ROW / 2.0, m);
}
