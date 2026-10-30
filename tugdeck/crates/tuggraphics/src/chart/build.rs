//! A builder for layer 0 programs. Forms write their figures through it
//! straight into [`Program`] items, so a chart is drawn by the same
//! renderer as a hand-written program, without a round trip through
//! JSON and its op limit.

use crate::draw::{
    Anchor, Baseline, Cap, ColourRole, Edge, Enter, HitOp, Item, Join, Motion, PaintKind, PaintOp,
    Program, Seg, TextOp, TypeRole, MAX_DELAY,
};

pub(crate) struct Builder {
    items: Vec<Item>,
    /// Hit targets, written after every mark so that they sit over them all.
    hits: Vec<Item>,
    animate: bool,
}

/// A stroke's look.
#[derive(Clone, Copy)]
pub(crate) struct Pen<'a> {
    pub role: ColourRole,
    pub width: f64,
    pub dash: &'a [f64],
    pub round: bool,
}

impl Builder {
    pub fn new(animate: bool) -> Builder {
        Builder {
            items: Vec::new(),
            hits: Vec::new(),
            animate,
        }
    }

    /// An entrance, or none when the chart does not animate. Stagger
    /// indices past the largest share it.
    pub fn enter(&self, enter: Enter, index: usize) -> Option<Motion> {
        self.animate.then(|| Motion {
            enter,
            delay: index.min(MAX_DELAY as usize) as u8,
        })
    }

    pub fn grow(&self, from: Edge, index: usize) -> Option<Motion> {
        self.enter(Enter::Grow(from), index)
    }

    pub fn fill(&mut self, path: Vec<Seg>, role: ColourRole, motion: Option<Motion>) {
        self.fill_opacity(path, role, 1.0, motion);
    }

    /// A translucent fill: an overlapping area, a heat cell's step.
    pub fn fill_opacity(
        &mut self,
        path: Vec<Seg>,
        role: ColourRole,
        opacity: f64,
        motion: Option<Motion>,
    ) {
        if path.is_empty() {
            return;
        }
        self.items.push(Item::Paint(PaintOp {
            kind: PaintKind::Fill,
            role,
            path,
            width: 1.0,
            dash: Vec::new(),
            opacity,
            motion,
        }));
    }

    pub fn stroke(&mut self, path: Vec<Seg>, pen: Pen, motion: Option<Motion>) {
        self.stroke_opacity(path, pen, 1.0, motion);
    }

    /// A translucent stroke: a bullet's faint history line.
    pub fn stroke_opacity(
        &mut self,
        path: Vec<Seg>,
        pen: Pen,
        opacity: f64,
        motion: Option<Motion>,
    ) {
        if path.is_empty() {
            return;
        }
        let (cap, join) = if pen.round {
            (Some(Cap::Round), Some(Join::Round))
        } else {
            (None, None)
        };
        self.items.push(Item::Paint(PaintOp {
            kind: PaintKind::Stroke { cap, join },
            role: pen.role,
            path,
            width: pen.width,
            dash: pen.dash.to_vec(),
            opacity,
            motion,
        }));
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
        motion: Option<Motion>,
    ) {
        if text.is_empty() {
            return;
        }
        self.items.push(Item::Text(TextOp {
            x,
            y,
            text: text.to_string(),
            role,
            fill,
            anchor,
            baseline: Baseline::Middle,
            opacity: 1.0,
            motion,
        }));
    }

    /// A hit target for row `row` of the chart's table, and for `col` when one
    /// of the row's values is the one this mark draws.
    pub fn hit(&mut self, path: Vec<Seg>, row: usize, col: Option<usize>) {
        self.hit_with_cross(path, row, col, Vec::new());
    }

    /// A hit target with a line to show while it is hovered.
    pub fn hit_with_cross(
        &mut self,
        path: Vec<Seg>,
        row: usize,
        col: Option<usize>,
        cross: Vec<Seg>,
    ) {
        self.hits.push(Item::Hit(HitOp {
            path,
            row,
            col,
            cross,
        }));
    }

    pub fn finish(mut self, w: f64, h: f64) -> Program {
        self.items.append(&mut self.hits);
        Program {
            frame: (w, h),
            items: self.items,
        }
    }
}

pub(crate) fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<Seg> {
    vec![
        Seg::Move(x, y),
        Seg::Line(x + w, y),
        Seg::Line(x + w, y + h),
        Seg::Line(x, y + h),
        Seg::Close,
    ]
}

pub(crate) fn circle(cx: f64, cy: f64, r: f64) -> Vec<Seg> {
    vec![
        Seg::Move(cx + r, cy),
        Seg::Arc {
            r,
            sweep: true,
            x: cx - r,
            y: cy,
        },
        Seg::Arc {
            r,
            sweep: true,
            x: cx + r,
            y: cy,
        },
        Seg::Close,
    ]
}

/// One straight segment as its own subpath.
pub(crate) fn segment(path: &mut Vec<Seg>, x0: f64, y0: f64, x1: f64, y1: f64) {
    path.push(Seg::Move(x0, y0));
    path.push(Seg::Line(x1, y1));
}
