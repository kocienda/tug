//! `bullet`: one row per item on a shared axis — the range as a `grid`
//! band, the value as a bar from zero, the target as an `ink` tick — with
//! the value written beyond the bar's end when the plot has room. The history
//! is a faint trace in its own column before the plot, never across the bar,
//! and a frame too narrow for the column draws none.

use super::{range, width, Builder, Pen, RowsLayout, GAP};
use crate::chart::build::rect;
use crate::chart::spec::{BulletItem, Spec};
use crate::draw::{Anchor, ColourRole, Edge, Enter, Seg};
use crate::measure::{Measure, TypeRole};

const BAND_H: f64 = 16.0;
const BAR_H: f64 = 8.0;
const HISTORY_OPACITY: f64 = 0.35;
/// The history column's width.
const HISTORY_W: f64 = 48.0;
/// Narrower than this, the column would turn the plot inside out.
const HISTORY_MIN_W: f64 = 320.0;

pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    items: &[BulletItem],
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let labels: Vec<String> = items.iter().map(|i| i.label.clone()).collect();
    let texts: Vec<String> = items.iter().map(|i| spec.format.apply(i.value)).collect();
    for t in &texts {
        m.measure(TypeRole::Value, t);
    }
    let (mut lo, mut hi) = (0.0_f64, 0.0_f64);
    for item in items {
        lo = lo.min(item.value);
        hi = hi.max(item.value);
        if let Some((a, z)) = item.range {
            lo = lo.min(a);
            hi = hi.max(z);
        }
        if let Some(t) = item.target {
            lo = lo.min(t);
            hi = hi.max(t);
        }
    }
    let lead = if w >= HISTORY_MIN_W && items.iter().any(|i| i.history.len() > 1) {
        HISTORY_W + GAP
    } else {
        0.0
    };
    let frame = RowsLayout {
        spec,
        w,
        h,
        labels: &labels,
        extra_row: 0.0,
        axis: Some((lo, hi)),
        right_margin: 4.0,
        lead,
    };
    let (plot, _) = frame.draw(b, m);
    let band_h = BAND_H.min(plot.band() - 4.0).max(2.0);
    let bar_h = BAR_H.min(band_h / 2.0);
    let zero = plot.x(0.0);
    for (i, item) in items.iter().enumerate() {
        let cy = plot.center(i);
        // The whole row, label and history included.
        b.hit(
            rect(0.0, cy - plot.band() / 2.0, w, plot.band()),
            i,
            Some(1),
        );
        if let Some((a, z)) = item.range {
            let (xa, xz) = (plot.x(a), plot.x(z));
            b.fill(
                rect(xa, cy - band_h / 2.0, xz - xa, band_h),
                ColourRole::Grid,
                None,
            );
        }
        // The history fills its column, scaled to its own range.
        if lead > 0.0 && item.history.len() > 1 {
            if let Some((hlo, hhi)) = range(&item.history) {
                let n = item.history.len() as f64;
                let hy = |v: f64| {
                    if hhi == hlo {
                        cy
                    } else {
                        cy + band_h / 2.0 - (v - hlo) / (hhi - hlo) * band_h
                    }
                };
                let mut path = Vec::new();
                let mut open = false;
                for (k, v) in item.history.iter().enumerate() {
                    let px = plot.left - lead + HISTORY_W * k as f64 / (n - 1.0);
                    match v {
                        Some(v) if open => path.push(Seg::Line(px, hy(*v))),
                        Some(v) => {
                            path.push(Seg::Move(px, hy(*v)));
                            open = true;
                        }
                        None => open = false,
                    }
                }
                let pen = Pen {
                    role: ColourRole::InkMuted,
                    width: 1.0,
                    dash: &[],
                    round: true,
                };
                b.stroke_opacity(path, pen, HISTORY_OPACITY, None);
            }
        }
        let xv = plot.x(item.value);
        let (left, length) = if item.value >= 0.0 {
            (zero, xv - zero)
        } else {
            (xv, zero - xv)
        };
        if length > 0.0 {
            let from = if item.value >= 0.0 {
                Edge::Left
            } else {
                Edge::Right
            };
            b.fill(
                rect(left, cy - bar_h / 2.0, length, bar_h),
                ColourRole::Series(1),
                b.grow(from, i),
            );
        }
        if let Some(t) = item.target {
            b.fill(
                rect(plot.x(t) - 1.0, cy - band_h / 2.0 - 2.0, 2.0, band_h + 4.0),
                ColourRole::Ink,
                None,
            );
        }
        let text_w = width(m, TypeRole::Value, &texts[i]);
        let lx = xv.max(zero) + 4.0;
        if lx + text_w <= plot.right {
            b.text(
                lx,
                cy,
                &texts[i],
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                b.enter(Enter::Fade, i),
            );
        }
    }
}
