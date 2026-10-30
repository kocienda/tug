//! `line`: one stroked line per series over a category axis, a gap
//! wherever a value is null, each series named at its last point.

use super::{fit_text, range, Annotations, AxisLayout, Builder, Pen, Plot, GAP, VALUE_ROW};
use crate::chart::build::{circle, rect};
use crate::chart::spec::{Series, Spec};
use crate::draw::{Anchor, Enter, Seg};
use crate::measure::{Measure, TypeRole};

/// The widest an end label may be, as a share of the frame.
pub(super) const END_LABEL_SHARE: f64 = 0.25;
/// End labels sit at least one value row apart.
const END_LABEL_PITCH: f64 = VALUE_ROW;

/// Which label goes above when two series end at the same `y`.
#[derive(Clone, Copy)]
pub(super) enum TieOrder {
    /// The first series above, for lines and overlapping areas.
    SeriesOrder,
    /// The last series above: in a stack it is the one drawn on top.
    StackTopFirst,
}

pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    x: &[String],
    series: &[Series],
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    for s in series {
        m.measure(TypeRole::Value, &s.name);
    }
    let cap = (w * END_LABEL_SHARE).floor();
    let name_w = series
        .iter()
        .map(|s| super::width(m, TypeRole::Value, &s.name).min(cap))
        .fold(0.0, f64::max);
    let (lo, hi) = range(series.iter().flat_map(|s| &s.values)).unwrap_or((0.0, 0.0));
    let axis = AxisLayout {
        spec,
        w,
        h,
        lo,
        hi,
        categories: x,
        extra_row: 0.0,
        right_margin: GAP + name_w + 2.0,
    };
    let (plot, _) = axis.draw(b, m);
    let notes = Annotations::plan(spec, &plot, m);

    let mut ends = Vec::new();
    for (j, s) in series.iter().enumerate() {
        let mut path = Vec::new();
        let mut run: Vec<(f64, f64)> = Vec::new();
        let flush = |run: &mut Vec<(f64, f64)>, path: &mut Vec<Seg>, b: &mut Builder| {
            match run.as_slice() {
                [] => {}
                [(px, py)] => b.fill(circle(*px, *py, 2.0), s.role, b.enter(Enter::Fade, j)),
                [(x0, y0), rest @ ..] => {
                    path.push(Seg::Move(*x0, *y0));
                    path.extend(rest.iter().map(|(px, py)| Seg::Line(*px, *py)));
                }
            }
            run.clear();
        };
        for (i, v) in s.values.iter().enumerate() {
            match v {
                Some(v) => run.push((plot.center(i), plot.y(*v))),
                None => flush(&mut run, &mut path, b),
            }
        }
        flush(&mut run, &mut path, b);
        let pen = Pen {
            role: s.role,
            width: 2.0,
            dash: &[],
            round: true,
        };
        b.stroke(path, pen, b.enter(Enter::Draw, j));
        if let Some(last) = s.values.iter().rposition(Option::is_some) {
            let v = s.values[last].unwrap_or_default();
            ends.push((plot.y(v), plot.center(last), j));
        }
    }
    end_labels(b, ends, TieOrder::SeriesOrder, series, &plot, w, cap, m);
    notes.draw(b);
    column_bands(b, series, x.len(), &plot);
}

/// One hit target per column that holds a value: the column's whole band, with
/// a crosshair at its centre, since a line is read at a position along it and
/// not at a mark. The row is the whole column, so no one value is named.
pub(super) fn column_bands(b: &mut Builder, series: &[Series], n: usize, plot: &Plot) {
    let band = plot.band();
    for i in 0..n {
        if series.iter().all(|s| s.values[i].is_none()) {
            continue;
        }
        let cx = plot.center(i);
        b.hit_with_cross(
            rect(cx - band / 2.0, plot.top, band, plot.bottom - plot.top),
            i,
            None,
            vec![Seg::Move(cx, plot.top), Seg::Line(cx, plot.bottom)],
        );
    }
}

/// Sorts `(y, x, series index)` ends top to bottom, breaking a tie by `ties`.
fn order_ends(ends: &mut [(f64, f64, usize)], ties: TieOrder) {
    ends.sort_by(|a, b| {
        a.0.total_cmp(&b.0).then_with(|| match ties {
            TieOrder::SeriesOrder => a.2.cmp(&b.2),
            TieOrder::StackTopFirst => b.2.cmp(&a.2),
        })
    });
}

/// Direct labels at each series' end — `(y, x, series index)` — nudged
/// apart vertically so none overlaps its neighbour, and kept inside the
/// plot.
#[allow(clippy::too_many_arguments)]
pub(super) fn end_labels(
    b: &mut Builder,
    mut ends: Vec<(f64, f64, usize)>,
    ties: TieOrder,
    series: &[Series],
    plot: &Plot,
    w: f64,
    cap: f64,
    m: &dyn Measure,
) {
    order_ends(&mut ends, ties);
    let mut ys: Vec<f64> = ends.iter().map(|e| e.0).collect();
    for i in 1..ys.len() {
        ys[i] = ys[i].max(ys[i - 1] + END_LABEL_PITCH);
    }
    if let Some(last) = ys.last_mut() {
        *last = last.min(plot.bottom);
    }
    for i in (0..ys.len().saturating_sub(1)).rev() {
        ys[i] = ys[i].min(ys[i + 1] - END_LABEL_PITCH);
    }
    for (y, &(_, px, j)) in ys.iter().zip(&ends) {
        let s = &series[j];
        let lx = px + GAP;
        let fit = fit_text(&s.name, TypeRole::Value, (w - lx).min(cap), m);
        b.text(
            lx,
            y.max(plot.top - VALUE_ROW / 2.0),
            &fit.text,
            TypeRole::Value,
            s.role,
            Anchor::Start,
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tie_goes_to_the_top_of_the_stack_or_the_first_series() {
        let mut ends = [(10.0, 1.0, 0), (10.0, 1.0, 1), (4.0, 1.0, 0)];
        order_ends(&mut ends, TieOrder::StackTopFirst);
        assert_eq!(ends.map(|e| (e.0, e.2)), [(4.0, 0), (10.0, 1), (10.0, 0)]);
        order_ends(&mut ends, TieOrder::SeriesOrder);
        assert_eq!(ends.map(|e| (e.0, e.2)), [(4.0, 0), (10.0, 0), (10.0, 1)]);
    }
}
