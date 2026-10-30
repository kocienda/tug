//! `dots`: one row per label and a circle per item, oldest left, in `good`,
//! `bad` or `ink-muted` — the shape of a file's run history. The dots
//! fade in by column, so a row reads left to right.

use super::{Builder, RowsLayout};
use crate::chart::build::{circle, rect};
use crate::chart::spec::{Dot, DotRow, Spec};
use crate::draw::{ColourRole, Enter};
use crate::measure::Measure;

/// The distance between dot centres, and a dot's radius, at full size.
const PITCH: f64 = 14.0;
const RADIUS: f64 = 5.0;

pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    rows: &[DotRow],
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let labels: Vec<String> = rows.iter().map(|r| r.label.clone()).collect();
    let frame = RowsLayout {
        spec,
        w,
        h,
        labels: &labels,
        extra_row: 0.0,
        axis: None,
        right_margin: 4.0,
        lead: 0.0,
    };
    let (plot, _) = frame.draw(b, m);
    // Every row's dots fit the plot: the pitch shrinks for the longest row.
    let most = rows.iter().map(|r| r.items.len()).max().unwrap_or(1) as f64;
    let pitch = PITCH.min((plot.right - plot.left) / most).max(2.0);
    let r = RADIUS
        .min(pitch / 2.0 - 1.0)
        .min(plot.band() / 2.0 - 1.0)
        .max(1.0);
    for (i, row) in rows.iter().enumerate() {
        let cy = plot.center(i);
        for (k, dot) in row.items.iter().enumerate() {
            let cx = plot.left + pitch * (k as f64 + 0.5);
            // The column is the one in the table that counts this kind of dot.
            let (role, col) = match dot {
                Dot::Good => (ColourRole::Good, 1),
                Dot::Bad => (ColourRole::Bad, 2),
                Dot::Neutral => (ColourRole::InkMuted, 3),
            };
            b.fill(circle(cx, cy, r), role, b.enter(Enter::Fade, k));
            b.hit(
                rect(cx - pitch / 2.0, cy - plot.band() / 2.0, pitch, plot.band()),
                i,
                Some(col),
            );
        }
    }
}
