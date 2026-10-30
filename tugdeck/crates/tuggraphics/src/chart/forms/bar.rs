//! `bar`: one band per category. Vertical bars stand on zero, side by side
//! when grouped or one on another in series order when stacked; horizontal
//! bars run from the left in rows, with the category labels in a column.
//! A stacked chart labels its totals only.

use super::{
    legend, overlaps, pen, range, width, Annotations, AxisLayout, Builder, HPlot, Plot, RowsLayout, LABEL_ROW,
    VALUE_ROW,
};
use crate::chart::build::rect;
use crate::chart::spec::{Orient, Series, Spec};
use crate::draw::{Anchor, ColourRole, Edge, Enter, Seg};
use crate::measure::{Measure, TypeRole};

/// The share of a band the bars of one category take.
const GROUP_SHARE: f64 = 0.8;

/// The value labels a chart may place: one per bar when grouped, or the
/// positive and negative totals per category when stacked. An empty
/// string is no label.
struct Labels {
    grouped: Vec<Vec<String>>,
    pos: Vec<String>,
    neg: Vec<String>,
}

/// The stacked segments of category `i`: each series' span on the value
/// axis, positives up from zero and negatives down, in series order.
fn stacked_segments(series: &[Series], i: usize) -> Vec<(usize, f64, f64)> {
    let (mut pos, mut neg) = (0.0, 0.0);
    series
        .iter()
        .enumerate()
        .filter_map(|(j, s)| {
            let v = s.values[i]?;
            if v >= 0.0 {
                let from = pos;
                pos += v;
                Some((j, from, pos))
            } else {
                let from = neg;
                neg += v;
                Some((j, from, neg))
            }
        })
        .collect()
}

/// The positive and negative totals of category `i`, and whether it holds
/// any value at all.
fn totals(series: &[Series], i: usize) -> (f64, f64, bool) {
    let mut any = false;
    let (mut pos, mut neg) = (0.0, 0.0);
    for v in series.iter().filter_map(|s| s.values[i]) {
        any = true;
        if v >= 0.0 {
            pos += v;
        } else {
            neg += v;
        }
    }
    (pos, neg, any)
}

/// The value domain the bars cover, zero included.
fn domain(series: &[Series], n: usize, stacked: bool) -> (f64, f64) {
    let (lo, hi) = if stacked {
        (0..n).fold((0.0, 0.0), |(lo, hi), i| {
            let (pos, neg, _) = totals(series, i);
            (f64::min(lo, neg), f64::max(hi, pos))
        })
    } else {
        range(series.iter().flat_map(|s| &s.values)).unwrap_or((0.0, 0.0))
    };
    (lo.min(0.0), hi.max(0.0))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    categories: &[String],
    series: &[Series],
    orient: Orient,
    stacked: bool,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let fmt = |v: f64| spec.format.apply(v);
    let n = categories.len();
    let labels = if stacked {
        let mut pos = Vec::with_capacity(n);
        let mut neg = Vec::with_capacity(n);
        for i in 0..n {
            let (p, q, any) = totals(series, i);
            pos.push(if any { fmt(p) } else { String::new() });
            neg.push(if q < 0.0 { fmt(q) } else { String::new() });
        }
        Labels {
            grouped: Vec::new(),
            pos,
            neg,
        }
    } else {
        Labels {
            grouped: series
                .iter()
                .map(|s| s.values.iter().map(|v| v.map(fmt).unwrap_or_default()).collect())
                .collect(),
            pos: Vec::new(),
            neg: Vec::new(),
        }
    };
    for text in labels
        .grouped
        .iter()
        .flatten()
        .chain(&labels.pos)
        .chain(&labels.neg)
        .filter(|t| !t.is_empty())
    {
        m.measure(TypeRole::Value, text);
    }
    if series.len() > 1 {
        for s in series {
            m.measure(TypeRole::Label, &s.name);
        }
    }
    match orient {
        Orient::Vertical => vertical(b, spec, categories, series, stacked, &labels, w, h, m),
        Orient::Horizontal => horizontal(b, spec, categories, series, stacked, &labels, w, h, m),
    }
}

/// Where a label for a bar of `height` ending at `y` goes: beyond the end
/// when there is room before the plot's edge, inside the bar when it is
/// long enough, else nowhere. Returns the y and the fill.
fn vertical_slot(plot: &Plot, y: f64, height: f64, positive: bool) -> Option<(f64, ColourRole)> {
    let (beyond, inside, fits_beyond) = if positive {
        let beyond = y - 2.0 - VALUE_ROW / 2.0;
        (beyond, y + 2.0 + VALUE_ROW / 2.0, beyond - VALUE_ROW / 2.0 >= plot.top - VALUE_ROW / 2.0)
    } else {
        let beyond = y + 2.0 + VALUE_ROW / 2.0;
        (beyond, y - 2.0 - VALUE_ROW / 2.0, beyond + VALUE_ROW / 2.0 <= plot.bottom)
    };
    if fits_beyond {
        Some((beyond, ColourRole::InkMuted))
    } else if height >= VALUE_ROW + 4.0 {
        Some((inside, ColourRole::Surface))
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
fn vertical_label(
    b: &mut Builder,
    plot: &Plot,
    notes: &Annotations,
    m: &dyn Measure,
    text: &str,
    cx: f64,
    y: f64,
    height: f64,
    positive: bool,
    room: f64,
    delay: usize,
) {
    let text_w = width(m, TypeRole::Value, text);
    if text.is_empty() || text_w > room {
        return;
    }
    let Some((ly, fill)) = vertical_slot(plot, y, height, positive) else {
        return;
    };
    let at = [cx - text_w / 2.0, ly - VALUE_ROW / 2.0, cx + text_w / 2.0, ly + VALUE_ROW / 2.0];
    if notes.boxes.iter().any(|n| overlaps(n, &at)) {
        return;
    }
    b.text(cx, ly, text, TypeRole::Value, fill, Anchor::Middle, b.enter(Enter::Fade, delay));
}

#[allow(clippy::too_many_arguments)]
fn vertical(
    b: &mut Builder,
    spec: &Spec,
    categories: &[String],
    series: &[Series],
    stacked: bool,
    labels: &Labels,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let legend_row = series.len() > 1;
    let (lo, hi) = domain(series, categories.len(), stacked);
    let axis = AxisLayout {
        spec,
        w,
        h,
        lo,
        hi,
        categories,
        extra_row: if legend_row { LABEL_ROW } else { 0.0 },
        right_margin: 4.0,
    };
    let (plot, legend_y) = axis.draw(b, m);
    let notes = Annotations::plan(spec, &plot, m);
    if legend_row {
        legend(b, series, w, legend_y, m);
    }

    let band = plot.band();
    let group = band * GROUP_SHARE;
    let zero = plot.y(0.0);
    let x0 = |i: usize| plot.left + band * i as f64 + (band - group) / 2.0;
    if stacked {
        for i in 0..categories.len() {
            for (j, from, to) in stacked_segments(series, i) {
                let (y0, y1) = (plot.y(from), plot.y(to));
                let height = (y0 - y1).abs();
                if height > 0.0 {
                    let edge = if to >= from { Edge::Bottom } else { Edge::Top };
                    b.fill(rect(x0(i), y0.min(y1), group, height), series[j].role, b.grow(edge, j));
                }
            }
            let (pos, neg, _) = totals(series, i);
            let cx = x0(i) + group / 2.0;
            let yp = plot.y(pos);
            vertical_label(b, &plot, &notes, m, &labels.pos[i], cx, yp, zero - yp, true, band - 2.0, i);
            let yn = plot.y(neg);
            vertical_label(b, &plot, &notes, m, &labels.neg[i], cx, yn, yn - zero, false, band - 2.0, i);
        }
    } else {
        let n = series.len() as f64;
        let gap = if group / n > 4.0 && series.len() > 1 { 1.0 } else { 0.0 };
        let bar_w = (group - gap * (n - 1.0)) / n;
        // A value label's horizontal room: its band when bars stand alone,
        // its own bar and the gap beside it when they are grouped.
        let room = if series.len() == 1 { band - 2.0 } else { bar_w + gap };
        for i in 0..categories.len() {
            for (j, s) in series.iter().enumerate() {
                let Some(v) = s.values[i] else { continue };
                let x = x0(i) + j as f64 * (bar_w + gap);
                let y = plot.y(v);
                let (top, height) = if v >= 0.0 { (y, zero - y) } else { (zero, y - zero) };
                let from = if v >= 0.0 { Edge::Bottom } else { Edge::Top };
                if height > 0.0 {
                    b.fill(rect(x, top, bar_w, height), s.role, b.grow(from, i));
                }
                let cx = x + bar_w / 2.0;
                vertical_label(b, &plot, &notes, m, &labels.grouped[j][i], cx, y, height, v >= 0.0, room, i);
            }
        }
    }
    // The baseline over the bars' feet.
    b.stroke(
        vec![Seg::Move(plot.left, zero), Seg::Line(plot.right, zero)],
        pen(ColourRole::InkMuted, 1.0),
        None,
    );
    notes.draw(b);
}

/// The horizontal counterpart of [`vertical_label`]: beyond the bar's end
/// when the plot has room, inside it when it is long enough.
#[allow(clippy::too_many_arguments)]
fn horizontal_label(
    b: &mut Builder,
    plot: &HPlot,
    notes: &Annotations,
    m: &dyn Measure,
    text: &str,
    cy: f64,
    x_end: f64,
    length: f64,
    positive: bool,
    delay: usize,
) {
    let text_w = width(m, TypeRole::Value, text);
    if text.is_empty() {
        return;
    }
    let fits_beyond = if positive {
        x_end + 4.0 + text_w <= plot.right
    } else {
        x_end - 4.0 - text_w >= plot.left
    };
    let (x, anchor, fill) = if fits_beyond {
        let (x, anchor) = if positive {
            (x_end + 4.0, Anchor::Start)
        } else {
            (x_end - 4.0, Anchor::End)
        };
        (x, anchor, ColourRole::InkMuted)
    } else if length >= text_w + 8.0 {
        let (x, anchor) = if positive {
            (x_end - 4.0, Anchor::End)
        } else {
            (x_end + 4.0, Anchor::Start)
        };
        (x, anchor, ColourRole::Surface)
    } else {
        return;
    };
    let left = if anchor == Anchor::Start { x } else { x - text_w };
    let at = [left, cy - VALUE_ROW / 2.0, left + text_w, cy + VALUE_ROW / 2.0];
    if notes.boxes.iter().any(|n| overlaps(n, &at)) {
        return;
    }
    b.text(x, cy, text, TypeRole::Value, fill, anchor, b.enter(Enter::Fade, delay));
}

#[allow(clippy::too_many_arguments)]
fn horizontal(
    b: &mut Builder,
    spec: &Spec,
    categories: &[String],
    series: &[Series],
    stacked: bool,
    labels: &Labels,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let legend_row = series.len() > 1;
    let rows = RowsLayout {
        spec,
        w,
        h,
        labels: categories,
        extra_row: if legend_row { LABEL_ROW } else { 0.0 },
        axis: Some(domain(series, categories.len(), stacked)),
        right_margin: 4.0,
    };
    let (plot, legend_y) = rows.draw(b, m);
    let notes = Annotations::plan_rows(spec, &plot, m);
    if legend_row {
        legend(b, series, w, legend_y, m);
    }

    let band = plot.band();
    let group = band * GROUP_SHARE;
    let zero = plot.x(0.0);
    let y0 = |i: usize| plot.top + band * i as f64 + (band - group) / 2.0;
    if stacked {
        for i in 0..categories.len() {
            for (j, from, to) in stacked_segments(series, i) {
                let (xa, xb) = (plot.x(from), plot.x(to));
                let length = (xb - xa).abs();
                if length > 0.0 {
                    let edge = if to >= from { Edge::Left } else { Edge::Right };
                    b.fill(rect(xa.min(xb), y0(i), length, group), series[j].role, b.grow(edge, j));
                }
            }
            let (pos, neg, _) = totals(series, i);
            let cy = y0(i) + group / 2.0;
            let xp = plot.x(pos);
            horizontal_label(b, &plot, &notes, m, &labels.pos[i], cy, xp, xp - zero, true, i);
            let xn = plot.x(neg);
            horizontal_label(b, &plot, &notes, m, &labels.neg[i], cy, xn, zero - xn, false, i);
        }
    } else {
        let n = series.len() as f64;
        let gap = if group / n > 4.0 && series.len() > 1 { 1.0 } else { 0.0 };
        let bar_h = (group - gap * (n - 1.0)) / n;
        for i in 0..categories.len() {
            for (j, s) in series.iter().enumerate() {
                let Some(v) = s.values[i] else { continue };
                let y = y0(i) + j as f64 * (bar_h + gap);
                let x = plot.x(v);
                let (left, length) = if v >= 0.0 { (zero, x - zero) } else { (x, zero - x) };
                let from = if v >= 0.0 { Edge::Left } else { Edge::Right };
                if length > 0.0 {
                    b.fill(rect(left, y, length, bar_h), s.role, b.grow(from, i));
                }
                let cy = y + bar_h / 2.0;
                horizontal_label(b, &plot, &notes, m, &labels.grouped[j][i], cy, x, length, v >= 0.0, i);
            }
        }
    }
    // The baseline the bars start from.
    b.stroke(
        vec![Seg::Move(zero, plot.top), Seg::Line(zero, plot.bottom)],
        pen(ColourRole::InkMuted, 1.0),
        None,
    );
    notes.draw(b);
}
