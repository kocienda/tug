//! `scatter`: one measure against another, a translucent point per pair so
//! that a pile-up reads as density. The plot has a value axis on both sides,
//! each with its own format, and only the vertical one takes the header's
//! unit; the horizontal's sits in a row of its own under its ticks. With two
//! or more series each is named at the plot's right, level with its
//! rightmost point, in a margin no point can reach.

use super::line::{end_labels, TieOrder, END_LABEL_SHARE};
use super::{pen, AxisLayout, Builder, GAP, LABEL_ROW};
use crate::chart::build::{circle, segment};
use crate::chart::format::Format;
use crate::chart::spec::{ScatterSeries, Series, Spec};
use crate::chart::ticks::{Axis, PX_PER_TICK_H};
use crate::draw::{Anchor, ColourRole, Enter};
use crate::measure::{Measure, TypeRole};

const POINT_R: f64 = 3.0;
const POINT_OPACITY: f64 = 0.7;
/// A point's hit target, which is what lets a three-pixel point be reached.
const HIT_R: f64 = 8.0;
/// Room past the plot's right edge for a point on the axis's last tick and
/// half of that tick's label, when no series name takes the margin.
const BARE_MARGIN: f64 = 8.0;

/// The `(lo, hi)` of one coordinate across every point.
fn extent(series: &[ScatterSeries], of: impl Fn(&(f64, f64)) -> f64) -> (f64, f64) {
    series
        .iter()
        .flat_map(|s| &s.points)
        .map(of)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    series: &[ScatterSeries],
    x_unit: Option<&str>,
    x_format: Format,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let named = series.len() > 1;
    let cap = (w * END_LABEL_SHARE).floor();
    let name_w = if named {
        series
            .iter()
            .map(|s| super::width(m, TypeRole::Value, &s.name).min(cap))
            .fold(0.0, f64::max)
    } else {
        0.0
    };
    if let Some(u) = x_unit {
        m.measure(TypeRole::Label, u);
    }
    let (y_lo, y_hi) = extent(series, |p| p.1);
    let (x_lo, x_hi) = extent(series, |p| p.0);

    // The axis layout's empty category row is where the horizontal ticks go,
    // over the row this form keeps below it for the horizontal unit.
    let unit_row = if x_unit.is_some() { LABEL_ROW } else { 0.0 };
    let axis = AxisLayout {
        spec,
        w,
        h: h - unit_row,
        lo: y_lo,
        hi: y_hi,
        categories: &[],
        extra_row: 0.0,
        right_margin: if named {
            GAP + name_w + 2.0
        } else {
            BARE_MARGIN
        },
    };
    let (plot, _) = axis.draw(b, m);

    // Spaced from the frame rather than the plot, so the tick count does not
    // depend on a measurement and no later round asks for a new tick's width.
    let x_axis = Axis::nice_for(x_format, x_lo, x_hi, w, PX_PER_TICK_H);
    let px = |v: f64| x_axis.map(v, plot.left, plot.right);
    let labels: Vec<String> = x_axis.ticks.iter().map(|&t| x_format.apply(t)).collect();
    let mut grid = Vec::new();
    for (t, label) in x_axis.ticks.iter().zip(&labels) {
        let tx = px(*t);
        segment(&mut grid, tx, plot.top, tx, plot.bottom);
        // Kept inside the frame at either end.
        let half = super::width(m, TypeRole::Value, label) / 2.0;
        b.text(
            tx.max(half).min(w - half),
            h - unit_row - LABEL_ROW / 2.0,
            label,
            TypeRole::Value,
            ColourRole::InkMuted,
            Anchor::Middle,
            None,
        );
    }
    b.stroke(grid, pen(ColourRole::Grid, 1.0), None);
    if let Some(u) = x_unit {
        let fit = super::fit_text(u, TypeRole::Label, plot.right - plot.left, m);
        b.text(
            (plot.left + plot.right) / 2.0,
            h - LABEL_ROW / 2.0,
            &fit.text,
            TypeRole::Label,
            ColourRole::InkMuted,
            Anchor::Middle,
            None,
        );
    }

    let mut ends = Vec::new();
    // The table lists every series' points in this order, one row each.
    let mut row = 0;
    for (j, s) in series.iter().enumerate() {
        for &(x, y) in &s.points {
            b.fill_opacity(
                circle(px(x), plot.y(y), POINT_R),
                s.role,
                POINT_OPACITY,
                b.enter(Enter::Fade, j),
            );
            b.hit(circle(px(x), plot.y(y), HIT_R), row, None);
            row += 1;
        }
        let rightmost = s.points.iter().copied().max_by(|a, c| a.0.total_cmp(&c.0));
        if let (true, Some((_, y))) = (named, rightmost) {
            ends.push((plot.y(y), plot.right, j));
        }
    }
    // The labeller reads a name and a role from a series, and no values.
    let names: Vec<Series> = series
        .iter()
        .map(|s| Series {
            name: s.name.clone(),
            values: Vec::new(),
            role: s.role,
        })
        .collect();
    end_labels(b, ends, TieOrder::SeriesOrder, &names, &plot, w, cap, m);
}
