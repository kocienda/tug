//! `area`: `line` with each series filled down to the baseline. Overlapping
//! fills are translucent so every series stays legible through the ones in
//! front; stacked fills are opaque, each standing on the one below, and a
//! gap stacks as zero while the table still shows it empty.

use super::{line, range, Annotations, AxisLayout, Builder, Pen, GAP};
use crate::chart::build::circle;
use crate::chart::spec::{Series, Spec};
use crate::draw::{Enter, Seg};
use crate::measure::{Measure, TypeRole};

/// The fill opacity of overlapping areas.
const OVERLAP_OPACITY: f64 = 0.35;

#[allow(clippy::too_many_arguments)]
pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    x: &[String],
    series: &[Series],
    stacked: bool,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    for s in series {
        m.measure(TypeRole::Value, &s.name);
    }
    let n = x.len();
    let cap = (w * line::END_LABEL_SHARE).floor();
    let name_w = series
        .iter()
        .map(|s| super::width(m, TypeRole::Value, &s.name).min(cap))
        .fold(0.0, f64::max);
    // The tops of each series, in series order: the values themselves, or
    // the running sums when stacked.
    let mut tops: Vec<Vec<Option<f64>>> = Vec::with_capacity(series.len());
    let mut below: Vec<f64> = vec![0.0; n];
    for s in series {
        let row: Vec<Option<f64>> = if stacked {
            s.values
                .iter()
                .enumerate()
                .map(|(i, v)| Some(below[i] + v.unwrap_or(0.0)))
                .collect()
        } else {
            s.values.clone()
        };
        if stacked {
            below = row.iter().map(|v| v.unwrap_or(0.0)).collect();
        }
        tops.push(row);
    }
    let (lo, hi) = range(tops.iter().flatten()).unwrap_or((0.0, 0.0));
    let axis = AxisLayout {
        spec,
        w,
        h,
        lo: lo.min(0.0),
        hi: hi.max(0.0),
        categories: x,
        extra_row: 0.0,
        right_margin: GAP + name_w + 2.0,
    };
    let (plot, _) = axis.draw(b, m);
    let notes = Annotations::plan(spec, &plot, m);
    let base_y = plot.y(0.0);

    let mut ends = Vec::new();
    let mut below: Vec<f64> = vec![0.0; n];
    for (j, s) in series.iter().enumerate() {
        let top = &tops[j];
        let mut line_path = Vec::new();
        let mut i = 0;
        while i < n {
            if top[i].is_none() {
                i += 1;
                continue;
            }
            let start = i;
            while i < n && top[i].is_some() {
                i += 1;
            }
            let run = start..i;
            let point = |k: usize| (plot.center(k), plot.y(top[k].unwrap_or_default()));
            if run.len() == 1 {
                let (px, py) = point(start);
                b.fill(circle(px, py, 2.0), s.role, b.enter(Enter::Fade, j));
                continue;
            }
            let mut poly = Vec::new();
            for k in run.clone() {
                let (px, py) = point(k);
                poly.push(if k == start { Seg::Move(px, py) } else { Seg::Line(px, py) });
                line_path.push(if k == start { Seg::Move(px, py) } else { Seg::Line(px, py) });
            }
            for k in run.rev() {
                let floor = if stacked { plot.y(below[k]) } else { base_y };
                poly.push(Seg::Line(plot.center(k), floor));
            }
            poly.push(Seg::Close);
            let opacity = if stacked { 1.0 } else { OVERLAP_OPACITY };
            b.fill_opacity(poly, s.role, opacity, b.enter(Enter::Fade, j));
        }
        let pen = Pen {
            role: s.role,
            width: 2.0,
            dash: &[],
            round: true,
        };
        b.stroke(line_path, pen, b.enter(Enter::Draw, j));
        if let Some(last) = top.iter().rposition(Option::is_some) {
            ends.push((plot.y(top[last].unwrap_or_default()), plot.center(last), j));
        }
        if stacked {
            below = top.iter().map(|v| v.unwrap_or(0.0)).collect();
        }
    }
    line::end_labels(b, ends, series, &plot, w, cap, m);
    notes.draw(b);
}
