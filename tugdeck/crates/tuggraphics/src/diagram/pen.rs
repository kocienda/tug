//! The pen every diagram form draws with: boxes, key discs, text, and
//! connectors with rounded elbows, written straight into layer 0 items.
//! It owns the diagrams' look, so the forms say only where.
//!
//! A connector is the figure's strongest line: 2 px in full ink, with a
//! head long enough to read at a glance. A tone recolours the line, its
//! head and its label together. A label sits on the line it names, in a
//! chip of the figure's surface that the line runs into and out of, and
//! the chips are drawn after the connectors so none is crossed by one.

use crate::chart::build::{circle, rect};
use crate::draw::{
    Anchor, Baseline, Cap, ColourRole, Enter, GroupOp, HitOp, Item, Join, Motion, PaintKind,
    PaintOp, Program, Seg, TextOp, TypeRole, MAX_DELAY,
};
use crate::measure::{Ink, Measure};

pub(crate) type Pt = (f64, f64);

/// A key disc's radius.
pub(crate) const DISC: f64 = 8.0;
/// The room a key takes before the text it numbers.
pub(crate) const KEY_LEAD: f64 = DISC * 2.0 + 7.0;
/// The space around a figure.
pub(crate) const MARGIN: f64 = 16.0;
/// The pitch between two lines of wrapped secondary text, past the line
/// height.
pub(crate) const LINE_GAP: f64 = 2.0;
/// An arrowhead's length and half its width.
const HEAD: f64 = 11.0;
const HALF: f64 = 5.5;
/// The largest radius an elbow turns on.
const ELBOW: f64 = 8.0;
/// A connector's width, and the lighter width of a line that joins rather
/// than points.
pub(crate) const EDGE_WIDTH: f64 = 2.0;
pub(crate) const BARE_WIDTH: f64 = 1.5;
const EDGE_DASH: [f64; 2] = [6.0, 4.0];
/// The dot an edge starts with where it leaves a box or a row.
pub(crate) const ORIGIN_DOT: f64 = 3.5;
/// A chip's padding either side of its text, and above and below it.
pub(crate) const CHIP_PAD_X: f64 = 9.0;
pub(crate) const CHIP_PAD_Y: f64 = 4.0;

/// How a connector ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Head {
    /// A filled head: a call, a flow, a crossing.
    Filled,
    /// A stroked V: a return rather than a call.
    Open,
    /// No head: a line that joins rather than points.
    Bare,
}

/// How a connector is stroked.
#[derive(Clone, Copy)]
pub(crate) struct Stroke {
    pub colour: ColourRole,
    pub width: f64,
    pub dashed: bool,
    pub head: Head,
}

impl Stroke {
    /// The connector every form draws unless it says otherwise.
    pub fn arrow(colour: ColourRole, dashed: bool) -> Stroke {
        Stroke {
            colour,
            width: EDGE_WIDTH,
            dashed,
            head: Head::Filled,
        }
    }

    /// A line that joins rather than points: no head, lighter, muted.
    pub fn bare() -> Stroke {
        Stroke {
            colour: ColourRole::InkMuted,
            width: BARE_WIDTH,
            dashed: false,
            head: Head::Bare,
        }
    }
}

/// A box's place.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn mid_y(&self) -> f64 {
        (self.y + self.h / 2.0).round()
    }
}

/// How a box is painted.
#[derive(Clone, Copy)]
pub(crate) struct BoxPaint {
    pub fill: Option<(ColourRole, f64)>,
    pub stroke: Option<(ColourRole, f64)>,
}

impl BoxPaint {
    /// A box that holds things, and a box that holds nothing: the surface
    /// with a muted outline. Boxes are plain; nothing is tinted.
    pub const PLAIN: BoxPaint = BoxPaint {
        fill: Some((ColourRole::Surface, 1.0)),
        stroke: Some((ColourRole::InkMuted, 0.9)),
    };
}

pub(crate) struct Pen {
    items: Vec<Item>,
    hits: Vec<Item>,
    animate: bool,
}

/// One line height per role: the font box of a string with an ascender and
/// a descender, as measured. Zero until the measurer knows it.
#[derive(Clone, Copy)]
pub(crate) struct LineHeights {
    pub title: f64,
    pub label: f64,
    pub value: f64,
    pub mono: f64,
}

impl LineHeights {
    pub fn measure(m: &dyn Measure) -> LineHeights {
        let lh = |role| {
            m.measure(role, "Hg")
                .map(|g| (g.a + g.d).ceil())
                .unwrap_or(0.0)
        };
        LineHeights {
            title: lh(TypeRole::Title),
            label: lh(TypeRole::Label),
            value: lh(TypeRole::Value),
            mono: lh(TypeRole::Mono),
        }
    }

    pub fn of(&self, role: TypeRole) -> f64 {
        match role {
            TypeRole::Title => self.title,
            TypeRole::Label => self.label,
            TypeRole::Value => self.value,
            TypeRole::Mono => self.mono,
        }
    }

    /// The height of `n` lines of secondary text.
    pub fn block(&self, n: usize) -> f64 {
        self.block_of(TypeRole::Value, n)
    }

    /// The height of `n` lines of `role` text.
    pub fn block_of(&self, role: TypeRole, n: usize) -> f64 {
        if n == 0 {
            0.0
        } else {
            n as f64 * self.of(role) + (n - 1) as f64 * LINE_GAP
        }
    }
}

fn unit(a: Pt, b: Pt) -> Pt {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy);
    if len == 0.0 {
        (0.0, 0.0)
    } else {
        (dx / len, dy / len)
    }
}

fn dist(a: Pt, b: Pt) -> f64 {
    (b.0 - a.0).hypot(b.1 - a.1)
}

fn rounded_rect(x: f64, y: f64, w: f64, h: f64, r: f64) -> Vec<Seg> {
    let r = r.min(w / 2.0).min(h / 2.0);
    if r <= 0.0 {
        return rect(x, y, w, h);
    }
    let arc = |x, y| Seg::Arc {
        r,
        sweep: true,
        x,
        y,
    };
    vec![
        Seg::Move(x + r, y),
        Seg::Line(x + w - r, y),
        arc(x + w, y + r),
        Seg::Line(x + w, y + h - r),
        arc(x + w - r, y + h),
        Seg::Line(x + r, y + h),
        arc(x, y + h - r),
        Seg::Line(x, y + r),
        arc(x + r, y),
        Seg::Close,
    ]
}

impl Pen {
    pub fn new(animate: bool) -> Pen {
        Pen {
            items: Vec::new(),
            hits: Vec::new(),
            animate,
        }
    }

    fn enter(&self, enter: Enter, delay: usize) -> Option<Motion> {
        self.animate.then(|| Motion {
            enter,
            delay: delay.min(MAX_DELAY as usize) as u8,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn paint(
        &mut self,
        kind: PaintKind,
        role: ColourRole,
        path: Vec<Seg>,
        width: f64,
        dash: &[f64],
        opacity: f64,
        motion: Option<Motion>,
    ) {
        self.items.push(Item::Paint(PaintOp {
            kind,
            role,
            path,
            width,
            dash: dash.to_vec(),
            opacity,
            motion,
        }));
    }

    /// A rounded box, filled and then outlined.
    pub fn boxed(&mut self, b: Rect, r: f64, paint: BoxPaint, delay: usize) {
        let Rect { x, y, w, h } = b;
        let motion = self.enter(Enter::Fade, delay);
        if let Some((role, opacity)) = paint.fill {
            self.paint(
                PaintKind::Fill,
                role,
                rounded_rect(x, y, w, h, r),
                1.0,
                &[],
                opacity,
                motion,
            );
        }
        if let Some((role, opacity)) = paint.stroke {
            let kind = PaintKind::Stroke {
                cap: None,
                join: None,
            };
            self.paint(
                kind,
                role,
                rounded_rect(x, y, w, h, r),
                1.0,
                &[],
                opacity,
                motion,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn text(
        &mut self,
        x: f64,
        y: f64,
        text: &str,
        role: TypeRole,
        fill: ColourRole,
        anchor: Anchor,
        baseline: Baseline,
        delay: usize,
    ) {
        let motion = self.enter(Enter::Fade, delay);
        self.items.push(Item::Text(TextOp {
            x,
            y,
            text: text.to_string(),
            role,
            fill,
            anchor,
            baseline,
            opacity: 1.0,
            motion,
        }));
    }

    /// Text turned to read bottom to top, centred on `(cx, cy)`.
    pub fn upright(&mut self, cx: f64, cy: f64, text: &str, role: TypeRole, delay: usize) {
        self.items.push(Item::Group(GroupOp {
            translate: Some((cx, cy)),
            rotate: Some(-90.0),
            ..GroupOp::default()
        }));
        self.text(
            0.0,
            0.0,
            text,
            role,
            ColourRole::Ink,
            Anchor::Middle,
            Baseline::Middle,
            delay,
        );
        self.items.push(Item::End);
    }

    /// A key: an accent disc centred on `(cx, cy)`, its number centred by
    /// its ink rather than its font box, which would set it low.
    pub fn key(&mut self, cx: f64, cy: f64, n: u64, delay: usize, m: &dyn Measure) {
        let motion = self.enter(Enter::Fade, delay);
        self.paint(
            PaintKind::Fill,
            ColourRole::Accent,
            circle(cx, cy, DISC),
            1.0,
            &[],
            1.0,
            motion,
        );
        let s = n.to_string();
        let ink = m
            .measure_ink(TypeRole::Value, &s)
            .and_then(|g| g.ink)
            .unwrap_or(Ink::ZERO);
        let (x, y) = ink.origin_centred_at(cx, cy);
        self.text(
            x,
            y,
            &s,
            TypeRole::Value,
            ColourRole::Surface,
            Anchor::Start,
            Baseline::Alphabetic,
            delay,
        );
    }

    /// A straight 1 px rule, dashed or solid: a lifeline, a divider.
    pub fn rule(
        &mut self,
        a: Pt,
        b: Pt,
        colour: ColourRole,
        dash: &[f64],
        opacity: f64,
        delay: usize,
    ) {
        let motion = self.enter(Enter::Fade, delay);
        let kind = PaintKind::Stroke {
            cap: None,
            join: None,
        };
        let path = vec![Seg::Move(a.0, a.1), Seg::Line(b.0, b.1)];
        self.paint(kind, colour, path, 1.0, dash, opacity, motion);
    }

    /// An edge along `pts`, ending in a filled head.
    pub fn edge(&mut self, pts: &[Pt], colour: ColourRole, dashed: bool, delay: usize) {
        self.connector(pts, Stroke::arrow(colour, dashed), delay);
    }

    /// A connector along `pts`, ended as its stroke says. Consecutive
    /// points differ on one axis only; each turn is a small rounded elbow.
    pub fn connector(&mut self, pts: &[Pt], stroke: Stroke, delay: usize) {
        let n = pts.len();
        if n < 2 {
            return;
        }
        let tip = pts[n - 1];
        let d = unit(pts[n - 2], tip);
        let mut line: Vec<Pt> = pts.to_vec();
        // A filled head covers the stroke's end, overlapping it by a pixel
        // so no seam shows; an open head is the stroke's own end.
        if stroke.head == Head::Filled {
            line[n - 1] = (tip.0 - d.0 * (HEAD - 1.0), tip.1 - d.1 * (HEAD - 1.0));
        }

        let mut path = vec![Seg::Move(line[0].0, line[0].1)];
        for i in 1..line.len() {
            let p = line[i];
            if i == line.len() - 1 {
                path.push(Seg::Line(p.0, p.1));
                break;
            }
            let (prev, next) = (line[i - 1], line[i + 1]);
            let r = ELBOW.min(dist(prev, p) / 2.0).min(dist(p, next) / 2.0);
            let din = unit(prev, p);
            let dout = unit(p, next);
            path.push(Seg::Line(p.0 - din.0 * r, p.1 - din.1 * r));
            path.push(Seg::Curve([
                p.0,
                p.1,
                p.0,
                p.1,
                p.0 + dout.0 * r,
                p.1 + dout.1 * r,
            ]));
        }
        // A dashed stroke cannot draw itself along its length: the entrance owns the dash.
        let enter = if stroke.dashed {
            Enter::Fade
        } else {
            Enter::Draw
        };
        let motion = self.enter(enter, delay);
        let dash: &[f64] = if stroke.dashed { &EDGE_DASH } else { &[] };
        let kind = PaintKind::Stroke {
            cap: Some(Cap::Butt),
            join: Some(Join::Round),
        };
        self.paint(kind, stroke.colour, path, stroke.width, dash, 1.0, motion);
        match stroke.head {
            Head::Filled => self.head(tip, d, stroke.colour, delay),
            Head::Open => self.open_head(tip, d, stroke.colour, stroke.width, delay),
            Head::Bare => {}
        }
    }

    /// A straight arrow with a head at each end, for what crosses a
    /// boundary both ways.
    pub fn both_ways(&mut self, a: Pt, b: Pt, colour: ColourRole, delay: usize) {
        let d = unit(a, b);
        let (a0, b0) = (
            (a.0 + d.0 * (HEAD - 1.0), a.1 + d.1 * (HEAD - 1.0)),
            (b.0 - d.0 * (HEAD - 1.0), b.1 - d.1 * (HEAD - 1.0)),
        );
        let motion = self.enter(Enter::Draw, delay);
        let kind = PaintKind::Stroke {
            cap: Some(Cap::Butt),
            join: Some(Join::Round),
        };
        let path = vec![Seg::Move(a0.0, a0.1), Seg::Line(b0.0, b0.1)];
        self.paint(kind, colour, path, EDGE_WIDTH, &[], 1.0, motion);
        self.head(a, (-d.0, -d.1), colour, delay);
        self.head(b, d, colour, delay);
    }

    fn head(&mut self, tip: Pt, d: Pt, colour: ColourRole, delay: usize) {
        let (bx, by) = (tip.0 - d.0 * HEAD, tip.1 - d.1 * HEAD);
        let path = vec![
            Seg::Move(tip.0, tip.1),
            Seg::Line(bx - d.1 * HALF, by + d.0 * HALF),
            Seg::Line(bx + d.1 * HALF, by - d.0 * HALF),
            Seg::Close,
        ];
        let motion = self.enter(Enter::Fade, delay);
        self.paint(PaintKind::Fill, colour, path, 1.0, &[], 1.0, motion);
    }

    /// A stroked V at `tip`, the end of a return.
    fn open_head(&mut self, tip: Pt, d: Pt, colour: ColourRole, width: f64, delay: usize) {
        let (bx, by) = (tip.0 - d.0 * HEAD, tip.1 - d.1 * HEAD);
        let path = vec![
            Seg::Move(bx - d.1 * HALF, by + d.0 * HALF),
            Seg::Line(tip.0, tip.1),
            Seg::Line(bx + d.1 * HALF, by - d.0 * HALF),
        ];
        let kind = PaintKind::Stroke {
            cap: Some(Cap::Round),
            join: Some(Join::Round),
        };
        let motion = self.enter(Enter::Fade, delay);
        self.paint(kind, colour, path, width, &[], 1.0, motion);
    }

    /// A filled dot centred on `(cx, cy)`: where an edge leaves a box or a
    /// row, at `ORIGIN_DOT`.
    pub fn dot(&mut self, cx: f64, cy: f64, r: f64, colour: ColourRole, delay: usize) {
        let motion = self.enter(Enter::Fade, delay);
        self.paint(
            PaintKind::Fill,
            colour,
            circle(cx, cy, r),
            1.0,
            &[],
            1.0,
            motion,
        );
    }

    /// The size of a chip around `lines` of `role` text, `w` wide at its
    /// widest line.
    pub fn chip_size(lines: usize, w: f64, role: TypeRole, lh: &LineHeights) -> (f64, f64) {
        (
            (w + 2.0 * CHIP_PAD_X).ceil(),
            lh.block_of(role, lines) + 2.0 * CHIP_PAD_Y,
        )
    }

    /// A label that sits on its connector, centred on `(cx, cy)`: the
    /// figure's surface under it and a thin outline, so the line it names
    /// runs into it and out the other side. Draw it after the connectors.
    /// A toned label takes its tone for its text and its outline.
    #[allow(clippy::too_many_arguments)]
    pub fn chip(
        &mut self,
        cx: f64,
        cy: f64,
        lines: &[String],
        w: f64,
        role: TypeRole,
        tone: Option<ColourRole>,
        lh: &LineHeights,
        delay: usize,
    ) {
        if lines.is_empty() {
            return;
        }
        let (cw, ch) = Pen::chip_size(lines.len(), w, role, lh);
        let r = Rect {
            x: (cx - cw / 2.0).round(),
            y: (cy - ch / 2.0).round(),
            w: cw,
            h: ch,
        };
        let paint = BoxPaint {
            fill: Some((ColourRole::Surface, 1.0)),
            stroke: Some(match tone {
                Some(c) => (c, 0.8),
                None => (ColourRole::InkMuted, 0.55),
            }),
        };
        self.boxed(r, (ch / 2.0).min(10.0), paint, delay);
        let pitch = lh.of(role) + LINE_GAP;
        for (j, line) in lines.iter().enumerate() {
            self.text(
                cx.round(),
                r.y + CHIP_PAD_Y + j as f64 * pitch,
                line,
                role,
                tone.unwrap_or(ColourRole::Ink),
                Anchor::Middle,
                Baseline::Top,
                delay,
            );
        }
    }

    /// A hit target naming row `row` of the keyed table.
    pub fn hit(&mut self, x: f64, y: f64, w: f64, h: f64, row: usize) {
        self.hits.push(Item::Hit(HitOp {
            path: rect(x, y, w, h),
            row,
            col: None,
            item: None,
            mark: None,
            cross: Vec::new(),
        }));
    }

    /// The finished program, `w` × `h` plus one, every mark shifted half a
    /// pixel so a 1 px stroke on a whole coordinate lands on one row of
    /// pixels.
    pub fn finish(mut self, w: f64, h: f64) -> Program {
        let (w, h) = (w.ceil() + 1.0, h.ceil() + 1.0);
        let mut items = vec![Item::Group(GroupOp {
            translate: Some((0.5, 0.5)),
            ..GroupOp::default()
        })];
        items.append(&mut self.items);
        items.append(&mut self.hits);
        items.push(Item::End);
        Program {
            frame: (w, h),
            items,
        }
    }
}

/// How many times the axis-aligned runs of different edges cross: a run
/// across another edge's run strictly inside both.
pub(crate) fn crossings(paths: &[Vec<Pt>]) -> usize {
    struct Run {
        edge: usize,
        a: Pt,
        b: Pt,
    }
    let runs: Vec<Run> = paths
        .iter()
        .enumerate()
        .flat_map(|(edge, pts)| {
            pts.windows(2).map(move |w| Run {
                edge,
                a: w[0],
                b: w[1],
            })
        })
        .collect();
    let mut count = 0;
    for h in runs.iter().filter(|r| r.a.1 == r.b.1) {
        let (x0, x1) = (h.a.0.min(h.b.0), h.a.0.max(h.b.0));
        for v in runs.iter().filter(|r| r.edge != h.edge && r.a.0 == r.b.0) {
            let (y0, y1) = (v.a.1.min(v.b.1), v.a.1.max(v.b.1));
            if v.a.0 > x0 && v.a.0 < x1 && h.a.1 > y0 && h.a.1 < y1 {
                count += 1;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_runs_are_counted_once_per_pair() {
        let across = vec![(0.0, 10.0), (100.0, 10.0)];
        let down = vec![(50.0, 0.0), (50.0, 20.0)];
        assert_eq!(crossings(&[across.clone(), down]), 1);
        // A run that only touches another's end is not a crossing.
        let touching = vec![(100.0, 0.0), (100.0, 20.0)];
        assert_eq!(crossings(&[across.clone(), touching]), 0);
        // An edge never crosses itself.
        let elbow = vec![(0.0, 0.0), (50.0, 0.0), (50.0, 20.0), (0.0, 20.0)];
        assert_eq!(crossings(&[elbow]), 0);
    }
}
