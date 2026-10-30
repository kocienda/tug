//! `spans`: a bar per item from its `start` to its `end` on one linear
//! axis, in rows — durations side by side. A `status` colours the bar.

use super::{Builder, RowsLayout};
use crate::chart::build::rect;
use crate::chart::spec::{SpanItem, Spec};
use crate::draw::Edge;
use crate::measure::Measure;

/// The share of a row a bar takes, and the most it is ever tall.
const BAR_SHARE: f64 = 0.6;
const MAX_BAR_H: f64 = 12.0;

pub(super) fn layout(b: &mut Builder, spec: &Spec, items: &[SpanItem], w: f64, h: f64, m: &dyn Measure) {
    let labels: Vec<String> = items.iter().map(|i| i.label.clone()).collect();
    let lo = items.iter().map(|i| i.start).fold(f64::INFINITY, f64::min);
    let hi = items.iter().map(|i| i.end).fold(f64::NEG_INFINITY, f64::max);
    let frame = RowsLayout {
        spec,
        w,
        h,
        labels: &labels,
        extra_row: 0.0,
        axis: Some((lo, hi)),
        right_margin: 4.0,
    };
    let (plot, _) = frame.draw(b, m);
    let bar_h = (plot.band() * BAR_SHARE).min(MAX_BAR_H);
    for (i, item) in items.iter().enumerate() {
        let x0 = plot.x(item.start);
        // A span of no length still shows as a hairline.
        let length = (plot.x(item.end) - x0).max(1.0);
        b.fill(
            rect(x0, plot.center(i) - bar_h / 2.0, length, bar_h),
            item.role(),
            b.grow(Edge::Left, i),
        );
    }
}
