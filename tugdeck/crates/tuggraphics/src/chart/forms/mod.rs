//! The forms: each turns a validated spec into a layer 0 program.
//!
//! All layout arithmetic lives here. Rows have fixed heights per type
//! role, so the vertical layout — and with it the tick count — never
//! depends on measurement; measurement decides only widths: the value
//! axis margin, truncation, label thinning and collisions.
//!
//! Every form measures every full string it could place before it lays
//! anything out, so the first measure request asks for all of them and
//! the second only for truncation candidates.

mod area;
mod bar;
mod bullet;
mod dots;
pub(crate) mod histogram;
mod heat;
mod line;
mod sparkline;
mod spans;

use super::build::{rect, segment, Builder, Pen};
use super::spec::{Annotation, Data, Series, Spec};
use super::ticks::{Axis, PX_PER_TICK_H, PX_PER_TICK_V};
use crate::draw::{Anchor, ColourRole, Program, Seg};
use crate::measure::{fit_text, Measure, TypeRole};

/// Row heights, by the role set in them.
pub(crate) const TITLE_ROW: f64 = 20.0;
pub(crate) const LABEL_ROW: f64 = 16.0;
pub(crate) const VALUE_ROW: f64 = 14.0;
/// Space between a label and what it labels.
pub(crate) const GAP: f64 = 6.0;
/// A thinned category label is never given a wider slot than this; past
/// it, labels truncate instead of thinning further.
const MAX_SLOT: f64 = 96.0;
const RULE_DASH: [f64; 2] = [4.0, 3.0];
/// A row form's label column takes at most this share of the width.
pub(crate) const LABEL_COLUMN_SHARE: f64 = 0.4;
const SWATCH: f64 = 10.0;

/// Lays out `spec` in a `w` × `h` frame.
pub(crate) fn layout(spec: &Spec, w: f64, h: f64, animate: bool, m: &dyn Measure) -> Program {
    let mut b = Builder::new(animate);
    match &spec.data {
        Data::Bar {
            categories,
            series,
            orient,
            stacked,
        } => bar::layout(&mut b, spec, categories, series, *orient, *stacked, w, h, m),
        Data::Line { x, series } => line::layout(&mut b, spec, x, series, w, h, m),
        Data::Area { x, series, stacked } => area::layout(&mut b, spec, x, series, *stacked, w, h, m),
        Data::Sparkline { values, highlight } => sparkline::layout(&mut b, values, *highlight, w, h),
        Data::Dots { rows } => dots::layout(&mut b, spec, rows, w, h, m),
        Data::Histogram { values, bins } => histogram::layout(&mut b, spec, values, *bins, w, h, m),
        Data::Spans { items } => spans::layout(&mut b, spec, items, w, h, m),
        Data::Heat { categories, values } => heat::layout(&mut b, spec, categories, values, w, h, m),
        Data::Bullet { items } => bullet::layout(&mut b, spec, items, w, h, m),
    }
    b.finish(w, h)
}

/// The one-row legend above a plot with more than one series: a swatch
/// and the name per series, left to right.
pub(crate) fn legend(b: &mut Builder, series: &[Series], w: f64, y: f64, m: &dyn Measure) {
    let slot = w / series.len() as f64;
    let mut x = 0.0;
    for s in series {
        let fit = fit_text(&s.name, TypeRole::Label, slot - SWATCH - 4.0 - 8.0, m);
        let mid = y + LABEL_ROW / 2.0;
        b.fill(rect(x, mid - SWATCH / 2.0, SWATCH, SWATCH), s.role, None);
        b.text(x + SWATCH + 4.0, mid, &fit.text, TypeRole::Label, ColourRole::Ink, Anchor::Start, None);
        x += SWATCH + 4.0 + fit.metrics.w + 12.0;
    }
}

/// A plot with rows down the frame and, when the form has one, a value
/// axis along the bottom.
pub(crate) struct HPlot {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub axis: Axis,
    pub bands: usize,
}

impl HPlot {
    pub fn x(&self, v: f64) -> f64 {
        self.axis.map(v, self.left, self.right)
    }

    pub fn band(&self) -> f64 {
        (self.bottom - self.top) / self.bands as f64
    }

    pub fn center(&self, i: usize) -> f64 {
        self.top + self.band() * (i as f64 + 0.5)
    }
}

/// Everything a row form lays out before its marks: the header, an
/// optional row under it (a legend), a label column at the left truncated
/// to [`LABEL_COLUMN_SHARE`] of the width, and — when `axis` gives a
/// domain — a value axis under the rows with its grid.
pub(crate) struct RowsLayout<'a> {
    pub spec: &'a Spec,
    pub w: f64,
    pub h: f64,
    pub labels: &'a [String],
    pub extra_row: f64,
    /// The value domain, or `None` for a form with no value axis.
    pub axis: Option<(f64, f64)>,
    pub right_margin: f64,
}

impl RowsLayout<'_> {
    /// Returns the plot and the y the extra row starts at.
    pub fn draw(&self, b: &mut Builder, m: &dyn Measure) -> (HPlot, f64) {
        let spec = self.spec;
        measure_header(spec, m);
        for l in self.labels {
            m.measure(TypeRole::Label, l);
        }
        let mut y = header(b, spec, self.w, m);
        let extra_y = y + if self.extra_row > 0.0 { 4.0 } else { 0.0 };
        y = extra_y + self.extra_row;
        if y > 0.0 {
            y += GAP;
        }
        let top = y;
        let bottom = self.h - 4.0 - if self.axis.is_some() { VALUE_ROW + 4.0 } else { 0.0 };
        let cap = (self.w * LABEL_COLUMN_SHARE).floor();
        let col = self
            .labels
            .iter()
            .map(|l| width(m, TypeRole::Label, l).min(cap))
            .fold(0.0, f64::max);
        let left = if col > 0.0 { col + 8.0 } else { 0.0 };
        let right = self.w - self.right_margin;
        let (mut lo, mut hi) = self.axis.unwrap_or((0.0, 1.0));
        if self.axis.is_some() {
            for a in &spec.annotations {
                if let Annotation::Rule { value, .. } = a {
                    lo = lo.min(*value);
                    hi = hi.max(*value);
                }
            }
        }
        let axis = match self.axis {
            Some(_) => Axis::nice(lo, hi, right - left, PX_PER_TICK_H),
            None => Axis {
                lo: 0.0,
                hi: 1.0,
                step: 1.0,
                ticks: Vec::new(),
            },
        };
        let plot = HPlot {
            left,
            right,
            top,
            bottom,
            axis,
            bands: self.labels.len(),
        };
        for (i, l) in self.labels.iter().enumerate() {
            let fit = fit_text(l, TypeRole::Label, cap, m);
            b.text(0.0, plot.center(i), &fit.text, TypeRole::Label, ColourRole::InkMuted, Anchor::Start, None);
        }
        if self.axis.is_some() {
            let labels: Vec<String> = plot.axis.ticks.iter().map(|&t| spec.format.apply(t)).collect();
            for l in &labels {
                m.measure(TypeRole::Value, l);
            }
            let mut grid = Vec::new();
            let ty = self.h - VALUE_ROW / 2.0;
            for (t, label) in plot.axis.ticks.iter().zip(&labels) {
                let tx = plot.x(*t);
                segment(&mut grid, tx, plot.top, tx, plot.bottom);
                // Kept inside the frame at either end.
                let half = width(m, TypeRole::Value, label) / 2.0;
                let cx = tx.max(half).min(self.w - half);
                b.text(cx, ty, label, TypeRole::Value, ColourRole::InkMuted, Anchor::Middle, None);
            }
            b.stroke(grid, pen(ColourRole::Grid, 1.0), None);
        }
        (plot, extra_y)
    }
}

/// The width of `text` in `role`; 0 while it is not measured yet.
pub(crate) fn width(m: &dyn Measure, role: TypeRole, text: &str) -> f64 {
    m.measure(role, text).map_or(0.0, |x| x.w)
}

/// Asks for every string a header could place.
fn measure_header(spec: &Spec, m: &dyn Measure) {
    if let Some(t) = &spec.title {
        m.measure(TypeRole::Title, t);
    }
    if let Some(s) = header_line(spec) {
        m.measure(TypeRole::Label, &s);
    }
    for a in &spec.annotations {
        if let Annotation::Rule { label: Some(l), .. } | Annotation::Mark { label: Some(l), .. } = a {
            m.measure(TypeRole::Value, l);
        }
    }
}

/// The second header line: the subtitle and the unit.
fn header_line(spec: &Spec) -> Option<String> {
    match (&spec.subtitle, &spec.unit) {
        (Some(s), Some(u)) => Some(format!("{s} · {u}")),
        (Some(s), None) => Some(s.clone()),
        (None, Some(u)) => Some(u.clone()),
        (None, None) => None,
    }
}

/// Draws the title and the subtitle line; returns the y below them.
fn header(b: &mut Builder, spec: &Spec, w: f64, m: &dyn Measure) -> f64 {
    let mut y = 0.0;
    if let Some(t) = &spec.title {
        let fit = fit_text(t, TypeRole::Title, w, m);
        b.text(0.0, y + TITLE_ROW / 2.0, &fit.text, TypeRole::Title, ColourRole::Ink, Anchor::Start, None);
        y += TITLE_ROW;
    }
    if let Some(s) = header_line(spec) {
        let fit = fit_text(&s, TypeRole::Label, w, m);
        b.text(0.0, y + LABEL_ROW / 2.0, &fit.text, TypeRole::Label, ColourRole::InkMuted, Anchor::Start, None);
        y += LABEL_ROW;
    }
    y
}

/// A plot with a value axis on the left and categories along the bottom,
/// one band per category.
pub(crate) struct Plot {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub axis: Axis,
    pub bands: usize,
}

impl Plot {
    /// A band row with no value axis: what a heat strip's category labels
    /// are placed against.
    pub fn bands_only(left: f64, right: f64, top: f64, bottom: f64, bands: usize) -> Plot {
        Plot {
            left,
            right,
            top,
            bottom,
            axis: Axis {
                lo: 0.0,
                hi: 1.0,
                step: 1.0,
                ticks: Vec::new(),
            },
            bands,
        }
    }

    pub fn y(&self, v: f64) -> f64 {
        self.axis.map(v, self.bottom, self.top)
    }

    pub fn band(&self) -> f64 {
        (self.right - self.left) / self.bands as f64
    }

    pub fn center(&self, i: usize) -> f64 {
        self.left + self.band() * (i as f64 + 0.5)
    }
}

/// Everything an axis chart lays out before its marks: the header, an
/// optional row between header and plot (a legend), the value axis with
/// its grid, and the category labels.
pub(crate) struct AxisLayout<'a> {
    pub spec: &'a Spec,
    pub w: f64,
    pub h: f64,
    /// The value domain the data covers, before rule annotations.
    pub lo: f64,
    pub hi: f64,
    pub categories: &'a [String],
    /// The height of the row between the header and the plot.
    pub extra_row: f64,
    pub right_margin: f64,
}

impl AxisLayout<'_> {
    /// Measures the header, ticks and categories; returns the plot, the
    /// y the extra row starts at.
    pub fn draw(&self, b: &mut Builder, m: &dyn Measure) -> (Plot, f64) {
        let spec = self.spec;
        measure_header(spec, m);
        for c in self.categories {
            m.measure(TypeRole::Label, c);
        }
        let mut y = header(b, spec, self.w, m);
        let extra_y = y + if self.extra_row > 0.0 { 4.0 } else { 0.0 };
        y = extra_y + self.extra_row;
        if y > 0.0 {
            y += GAP;
        }
        let top = y + VALUE_ROW / 2.0;
        let bottom = self.h - LABEL_ROW - 4.0;
        let (mut lo, mut hi) = (self.lo, self.hi);
        for a in &spec.annotations {
            if let Annotation::Rule { value, .. } = a {
                lo = lo.min(*value);
                hi = hi.max(*value);
            }
        }
        let axis = Axis::nice(lo, hi, bottom - top, PX_PER_TICK_V);
        let labels: Vec<String> = axis.ticks.iter().map(|&t| spec.format.apply(t)).collect();
        let tick_w = labels
            .iter()
            .map(|l| width(m, TypeRole::Value, l))
            .fold(0.0, f64::max);
        let plot = Plot {
            left: tick_w + 8.0,
            right: self.w - self.right_margin,
            top,
            bottom,
            axis,
            bands: self.categories.len(),
        };
        let mut grid = Vec::new();
        for (t, label) in plot.axis.ticks.iter().zip(&labels) {
            let ty = plot.y(*t);
            segment(&mut grid, plot.left, ty, plot.right, ty);
            b.text(tick_w, ty, label, TypeRole::Value, ColourRole::InkMuted, Anchor::End, None);
        }
        b.stroke(grid, pen(ColourRole::Grid, 1.0), None);
        category_labels(b, &plot, self.categories, self.w, self.h - LABEL_ROW / 2.0, m);
        (plot, extra_y)
    }
}

pub(crate) fn pen(role: ColourRole, width: f64) -> Pen<'static> {
    Pen {
        role,
        width,
        dash: &[],
        round: false,
    }
}

/// Category labels under the plot, centred on their bands. When any two
/// would overlap, only every k-th is shown, with k the smallest that
/// makes room — up to a slot of [`MAX_SLOT`] px, past which the shown
/// labels truncate. A label never runs past the frame's edges.
fn category_labels(b: &mut Builder, plot: &Plot, labels: &[String], w: f64, y: f64, m: &dyn Measure) {
    let band = plot.band();
    let widths: Vec<f64> = labels.iter().map(|l| width(m, TypeRole::Label, l)).collect();
    let mut k = 1;
    while k < labels.len() {
        let slot = band * k as f64 - GAP;
        if slot >= MAX_SLOT || widths.iter().step_by(k).all(|&lw| lw <= slot) {
            break;
        }
        k += 1;
    }
    let slot = band * k as f64 - GAP;
    for i in (0..labels.len()).step_by(k) {
        let cx = plot.center(i);
        let room = slot.min(2.0 * cx).min(2.0 * (w - cx));
        let fit = fit_text(&labels[i], TypeRole::Label, room, m);
        b.text(cx, y, &fit.text, TypeRole::Label, ColourRole::InkMuted, Anchor::Middle, None);
    }
}

/// A label's box: left, top, right, bottom.
pub(crate) type LabelBox = [f64; 4];

pub(crate) fn overlaps(a: &LabelBox, b: &LabelBox) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// A value-role label centred vertically on `y`, its box from its anchor.
fn value_box(x: f64, y: f64, w: f64, anchor: Anchor) -> LabelBox {
    let left = match anchor {
        Anchor::Start => x,
        Anchor::Middle => x - w / 2.0,
        Anchor::End => x - w,
    };
    [left, y - VALUE_ROW / 2.0, left + w, y + VALUE_ROW / 2.0]
}

/// The rules and marks of a chart, laid out before its marks so value
/// labels can keep clear of theirs, and drawn over them.
pub(crate) struct Annotations {
    strokes: Vec<Vec<Seg>>,
    labels: Vec<(f64, f64, String, Anchor)>,
    pub boxes: Vec<LabelBox>,
}

impl Annotations {
    pub fn plan(spec: &Spec, plot: &Plot, m: &dyn Measure) -> Annotations {
        let mut out = Annotations {
            strokes: Vec::new(),
            labels: Vec::new(),
            boxes: Vec::new(),
        };
        let room = (plot.right - plot.left) / 3.0;
        for a in &spec.annotations {
            let (path, label, at) = match a {
                Annotation::Rule { value, label } => {
                    let y = plot.y(*value);
                    let mut path = Vec::new();
                    segment(&mut path, plot.left, y, plot.right, y);
                    (path, label, (plot.right, y - VALUE_ROW / 2.0, None))
                }
                Annotation::Mark { at, label } => {
                    let x = plot.center(*at);
                    let path = vec![Seg::Move(x, plot.top), Seg::Line(x, plot.bottom)];
                    (path, label, (x, plot.top + VALUE_ROW / 2.0, Some(x)))
                }
            };
            out.strokes.push(path);
            let Some(l) = label else { continue };
            let fit = fit_text(l, TypeRole::Value, room, m);
            let (x, y, anchor) = match at {
                // A rule's label sits on it at the plot's right end.
                (x, y, None) => (x, y, Anchor::End),
                // A mark's label sits beside it, on whichever side has room.
                (_, y, Some(x)) if x + 3.0 + fit.metrics.w > plot.right => (x - 3.0, y, Anchor::End),
                (_, y, Some(x)) => (x + 3.0, y, Anchor::Start),
            };
            out.boxes.push(value_box(x, y, fit.metrics.w, anchor));
            out.labels.push((x, y, fit.text, anchor));
        }
        out
    }

    /// The same, for a row plot: a rule is a vertical line at its value
    /// with its label at the top, a mark a horizontal line through its
    /// row with its label at the right end.
    pub fn plan_rows(spec: &Spec, plot: &HPlot, m: &dyn Measure) -> Annotations {
        let mut out = Annotations {
            strokes: Vec::new(),
            labels: Vec::new(),
            boxes: Vec::new(),
        };
        let room = (plot.right - plot.left) / 3.0;
        for a in &spec.annotations {
            let (path, label, at) = match a {
                Annotation::Rule { value, label } => {
                    let x = plot.x(*value);
                    let path = vec![Seg::Move(x, plot.top), Seg::Line(x, plot.bottom)];
                    (path, label, (x, plot.top + VALUE_ROW / 2.0, true))
                }
                Annotation::Mark { at, label } => {
                    let y = plot.center(*at);
                    let mut path = Vec::new();
                    segment(&mut path, plot.left, y, plot.right, y);
                    (path, label, (plot.right, y - VALUE_ROW / 2.0, false))
                }
            };
            out.strokes.push(path);
            let Some(l) = label else { continue };
            let fit = fit_text(l, TypeRole::Value, room, m);
            let (x, y, anchor) = match at {
                // A rule's label sits beside it at the top, on whichever side has room.
                (x, y, true) if x + 3.0 + fit.metrics.w > plot.right => (x - 3.0, y, Anchor::End),
                (x, y, true) => (x + 3.0, y, Anchor::Start),
                // A mark's label sits over it at the plot's right end.
                (x, y, false) => (x, y, Anchor::End),
            };
            out.boxes.push(value_box(x, y, fit.metrics.w, anchor));
            out.labels.push((x, y, fit.text, anchor));
        }
        out
    }

    pub fn draw(self, b: &mut Builder) {
        let dashed = Pen {
            role: ColourRole::InkMuted,
            width: 1.0,
            dash: &RULE_DASH,
            round: false,
        };
        for path in self.strokes {
            b.stroke(path, dashed, None);
        }
        for (x, y, text, anchor) in self.labels {
            b.text(x, y, &text, TypeRole::Value, ColourRole::InkMuted, anchor, None);
        }
    }
}

/// The finite values' range, or `None` when every value is a gap.
pub(crate) fn range<'a>(values: impl IntoIterator<Item = &'a Option<f64>>) -> Option<(f64, f64)> {
    values.into_iter().flatten().fold(None, |acc, &v| match acc {
        None => Some((v, v)),
        Some((lo, hi)) => Some((lo.min(v), hi.max(v))),
    })
}
