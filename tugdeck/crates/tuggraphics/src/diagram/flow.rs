//! `flow`: columns of boxes left to right, a box may hold rows, and edges
//! route themselves.
//!
//! A forward edge — into the next column — runs straight wherever one end
//! is free to meet the other's height, and otherwise turns in a lane in
//! the gap. An edge within a column runs straight down or up between the
//! two boxes. Anything else leaves to the right, runs underneath every
//! box in a channel of its own, and comes up into its target from below.
//! The gaps are sized last, from the lanes and labels that must fit in
//! them, so every coordinate follows from the boxes' text.

use std::collections::BTreeMap;

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    crossings, BoxPaint, LineHeights, Pen, Pt, Rect, DISC, KEY_LEAD, LINE_GAP, MARGIN,
};
use super::spec::{EndRef, Flow, FlowEdge, FlowRow, Tone};
use super::wrap::{Lines, Texts};
use super::Laid;

const PAD: f64 = 14.0;
const INSET: f64 = 12.0;
const ROW_PAD_X: f64 = 10.0;
const ROW_PAD_Y: f64 = 7.0;
const ROW_GAP: f64 = 8.0;
const NODE_GAP: f64 = 28.0;
const LEAF_MIN_W: f64 = 96.0;
/// The first lane a turning edge takes past its column, and the pitch of
/// the lanes after it.
const LANE0: f64 = 18.0;
const LANE: f64 = 12.0;
/// The first channel under the boxes, and the pitch of the channels after.
const CHANNEL0: f64 = 20.0;
const CHANNEL: f64 = 14.0;
/// The narrowest gap between two columns.
const GAP_MIN: f64 = 52.0;
/// The widths secondary text wraps at, unless the name above it is wider.
const SUB_WRAP: f64 = 160.0;
const ROW_SUB_WRAP: f64 = 140.0;
const NOTE_WRAP: f64 = 220.0;
/// A label in the gap between two columns wraps narrow, since its width
/// widens the gap; one under the figure has the figure's width beneath it.
const LABEL_WRAP: f64 = 120.0;
const UNDER_LABEL_WRAP: f64 = 240.0;

fn row_role(row: &FlowRow) -> TypeRole {
    if row.mono {
        TypeRole::Mono
    } else {
        TypeRole::Label
    }
}

fn row_lead(row: &FlowRow) -> f64 {
    if row.key.is_some() {
        KEY_LEAD
    } else {
        0.0
    }
}

fn tone_colour(tone: Option<Tone>) -> ColourRole {
    tone.map_or(ColourRole::InkMuted, Tone::colour)
}

/// A row's size and its wrapped sub-label.
struct RowSize {
    w: f64,
    h: f64,
    band: f64,
    sub: Lines,
}

/// A box's size from its text, before its column stretches it.
struct Sized {
    width: f64,
    height: f64,
    head_h: f64,
    sub: Lines,
    rows: Vec<RowSize>,
    notes: Vec<Lines>,
    notes_h: f64,
}

struct Placed {
    col: usize,
    rect: Rect,
    rows: Vec<Rect>,
    /// The height the box takes in its column: the box and its notes.
    slot: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Forward,
    Stack,
    Outer,
}

struct Routed<'s> {
    edge: &'s FlowEdge,
    kind: Kind,
    y1: f64,
    y2: f64,
    label: Lines,
    lane: usize,
}

pub(crate) fn layout(flow: &Flow, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
    let mut t = Texts::new(m);
    let lh = LineHeights::measure(m);
    let mut pen = Pen::new(animate);

    // The figure's own title, when it draws one, sits above everything.
    let mut top = MARGIN;
    let mut title_w = 0.0;
    if let Some(title) = title {
        title_w = t.width(TypeRole::Title, title);
        pen.text(
            MARGIN,
            MARGIN,
            title,
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::Start,
            Baseline::Top,
            0,
        );
        top += lh.title + 12.0;
    }

    // Sizes: every box from its text.
    let sized: Vec<Vec<Sized>> = flow
        .columns
        .iter()
        .enumerate()
        .map(|(c, col)| {
            col.iter()
                .enumerate()
                .map(|(k, node)| {
                    let base = format!("/columns/{c}/{k}");
                    let name_w = t.name(TypeRole::Title, &node.name, &format!("{base}/name"));
                    let sub = t.wrap_opt(
                        TypeRole::Value,
                        node.sub.as_deref(),
                        name_w.max(SUB_WRAP),
                        &format!("{base}/sub"),
                    );
                    let head = name_w.max(sub.w);
                    let head_h = lh.title
                        + if sub.count() > 0 {
                            3.0 + lh.block(sub.count())
                        } else {
                            0.0
                        };
                    let rows: Vec<RowSize> = node
                        .rows
                        .iter()
                        .enumerate()
                        .map(|(i, row)| {
                            let rb = format!("{base}/rows/{i}");
                            let role = row_role(row);
                            let rn = t.name(role, &row.name, &format!("{rb}/name"));
                            let sub = t.wrap_opt(
                                TypeRole::Value,
                                row.sub.as_deref(),
                                rn.max(ROW_SUB_WRAP),
                                &format!("{rb}/sub"),
                            );
                            let band =
                                lh.of(role)
                                    .max(if row.key.is_some() { DISC * 2.0 } else { 0.0 });
                            let sub_h = if sub.count() > 0 {
                                LINE_GAP + lh.block(sub.count())
                            } else {
                                0.0
                            };
                            RowSize {
                                w: row_lead(row) + rn.max(sub.w) + 2.0 * ROW_PAD_X,
                                h: 2.0 * ROW_PAD_Y + band + sub_h,
                                band,
                                sub,
                            }
                        })
                        .collect();
                    let notes: Vec<Lines> = node
                        .notes
                        .iter()
                        .enumerate()
                        .map(|(i, n)| {
                            t.wrap(
                                TypeRole::Value,
                                n,
                                name_w.max(NOTE_WRAP),
                                &format!("{base}/notes/{i}"),
                            )
                        })
                        .collect();
                    let note_lines: usize = notes.iter().map(Lines::count).sum();
                    let notes_h = if note_lines > 0 {
                        8.0 + note_lines as f64 * (lh.value + LINE_GAP)
                    } else {
                        0.0
                    };
                    let note_w = notes.iter().map(|n| n.w).fold(0.0, f64::max);
                    let leaf = rows.is_empty();
                    let width = if leaf {
                        LEAF_MIN_W.max(head + 2.0 * PAD)
                    } else {
                        let widest = rows.iter().map(|r| r.w).fold(0.0, f64::max);
                        (head + 2.0 * PAD).max(widest + 2.0 * INSET)
                    };
                    let height = if leaf {
                        head_h + 2.0 * (PAD - 3.0)
                    } else {
                        PAD - 2.0
                            + head_h
                            + 10.0
                            + rows.iter().map(|r| r.h).sum::<f64>()
                            + ROW_GAP * (rows.len() - 1) as f64
                            + INSET
                    };
                    Sized {
                        width: width.max(note_w),
                        height,
                        head_h,
                        sub,
                        rows,
                        notes,
                        notes_h,
                    }
                })
                .collect()
        })
        .collect();
    let col_w: Vec<f64> = sized
        .iter()
        .map(|col| col.iter().map(|n| n.width).fold(0.0, f64::max))
        .collect();
    let col_h: Vec<f64> = sized
        .iter()
        .map(|col| {
            col.iter().map(|n| n.height + n.notes_h).sum::<f64>()
                + NODE_GAP * (col.len() - 1) as f64
        })
        .collect();
    let content_h = col_h.iter().copied().fold(0.0, f64::max);

    // Vertical placement is independent of x, so every end's height is
    // known before any gap is sized.
    let mut placed: Vec<Vec<Placed>> = Vec::new();
    for (c, col) in sized.iter().enumerate() {
        let mut y = top + ((content_h - col_h[c]) / 2.0).round();
        let mut out = Vec::new();
        for s in col {
            let mut rows = Vec::new();
            let mut ry = y + PAD - 2.0 + s.head_h + 10.0;
            for size in &s.rows {
                rows.push(Rect {
                    x: INSET,
                    y: ry,
                    w: col_w[c] - 2.0 * INSET,
                    h: size.h,
                });
                ry += size.h + ROW_GAP;
            }
            let slot = s.height + s.notes_h;
            out.push(Placed {
                col: c,
                rect: Rect {
                    x: 0.0,
                    y,
                    w: col_w[c],
                    h: s.height,
                },
                rows,
                slot,
            });
            y += slot + NODE_GAP;
        }
        placed.push(out);
    }

    let end_rect = |placed: &[Vec<Placed>], e: EndRef| -> Rect {
        let p = &placed[e.col][e.node];
        e.row.map_or(p.rect, |r| p.rows[r])
    };
    let clamp = |v: f64, r: Rect| v.max(r.y + 12.0).min(r.y + r.h - 12.0);

    // Each edge's kind and the heights it leaves and arrives at. An end on
    // a box's side is spread from the edges already there; an end on a
    // row is fixed at the row's middle.
    let mut taken: BTreeMap<(usize, usize, bool), Vec<f64>> = BTreeMap::new();
    let mut settle = |e: EndRef, right: bool, y: f64, fixed: bool| -> f64 {
        let used = taken.entry((e.col, e.node, right)).or_default();
        let mut at = y;
        if !fixed {
            while used.iter().any(|u| (u - at).abs() < 10.0) {
                at += 12.0;
            }
        }
        used.push(at);
        at
    };
    let mut routed: Vec<Routed> = flow
        .edges
        .iter()
        .enumerate()
        .map(|(i, edge)| {
            let (from, to) = (edge.from, edge.to);
            let kind = if to.col == from.col + 1 {
                Kind::Forward
            } else if to.col == from.col {
                Kind::Stack
            } else {
                Kind::Outer
            };
            let fr = end_rect(&placed, from);
            let tr = end_rect(&placed, to);
            let (from_fixed, to_fixed) = (from.row.is_some(), to.row.is_some());
            let mut y1 = fr.mid_y();
            let mut y2 = tr.mid_y();
            match kind {
                Kind::Forward => {
                    // A straight edge wherever one end is free to meet the other.
                    match (from_fixed, to_fixed) {
                        (true, false) => y2 = clamp(y1, tr),
                        (false, true) => y1 = clamp(y2, fr),
                        (false, false) => {
                            y2 = clamp(y1, tr);
                            y1 = clamp(y2, fr);
                        }
                        (true, true) => {}
                    }
                    let shift = settle(from, true, y1, from_fixed) - y1;
                    y1 += shift;
                    if !to_fixed && y2 + shift == clamp(y2 + shift, tr) {
                        y2 += shift;
                    }
                    y2 = settle(to, false, y2, to_fixed);
                }
                Kind::Outer => y1 = settle(from, true, y1, from_fixed),
                Kind::Stack => {}
            }
            let label = t.wrap_opt(
                TypeRole::Value,
                edge.label.as_deref(),
                if kind == Kind::Outer {
                    UNDER_LABEL_WRAP
                } else {
                    LABEL_WRAP
                },
                &format!("/edges/{i}/label"),
            );
            Routed {
                edge,
                kind,
                y1,
                y2,
                label,
                lane: 0,
            }
        })
        .collect();

    // Lanes: gap g is right of column g, the last one the right margin an
    // outer edge turns down in. Outer edges take the inner lanes.
    let cols = flow.columns.len();
    let mut lanes = vec![0usize; cols];
    for kind_first in [true, false] {
        for r in routed.iter_mut() {
            let turns = if kind_first {
                r.kind == Kind::Outer
            } else {
                r.kind == Kind::Forward && r.y1 != r.y2
            };
            if turns {
                let g = r.edge.from.col;
                r.lane = lanes[g];
                lanes[g] += 1;
            }
        }
    }
    let gap_w: Vec<f64> = (0..cols)
        .map(|g| {
            let turn = if lanes[g] > 0 {
                LANE0 + LANE * (lanes[g] - 1) as f64
            } else {
                0.0
            };
            if g == cols - 1 {
                return if turn > 0.0 { turn + 10.0 } else { 0.0 };
            }
            let mut need = GAP_MIN.max(turn + 22.0);
            for r in &routed {
                if r.kind != Kind::Forward || r.edge.from.col != g || r.label.count() == 0 {
                    continue;
                }
                need = need.max(if r.y1 == r.y2 {
                    r.label.w + 30.0
                } else {
                    LANE0 + LANE * r.lane as f64 + r.label.w + 26.0
                });
            }
            need
        })
        .collect();

    // Now x.
    let mut col_x = Vec::with_capacity(cols);
    let mut x = MARGIN;
    for c in 0..cols {
        col_x.push(x);
        x += col_w[c] + gap_w[c];
    }
    let right = x;
    for col in placed.iter_mut() {
        for p in col.iter_mut() {
            p.rect.x = col_x[p.col];
            for row in p.rows.iter_mut() {
                row.x += p.rect.x;
            }
        }
    }

    // Boxes, and the keyed table's rows they hold.
    let keyed: Vec<u64> = {
        let mut k: Vec<u64> = flow
            .columns
            .iter()
            .flatten()
            .flat_map(|n| &n.rows)
            .filter_map(|r| r.key.as_ref().map(|k| k.n))
            .collect();
        k.sort_unstable();
        k
    };
    for (c, col) in flow.columns.iter().enumerate() {
        for (k, node) in col.iter().enumerate() {
            let p = &placed[c][k];
            let s = &sized[c][k];
            let r = p.rect;
            let leaf = p.rows.is_empty();
            pen.boxed(r, 8.0, BoxPaint::PLAIN, c);
            let cx = r.x + (r.w / 2.0).round();
            let head_y = if leaf {
                r.y + PAD - 3.0
            } else {
                r.y + PAD - 2.0
            };
            pen.text(
                cx,
                head_y,
                &node.name,
                TypeRole::Title,
                ColourRole::Ink,
                Anchor::Middle,
                Baseline::Top,
                c,
            );
            for (i, line) in s.sub.lines.iter().enumerate() {
                pen.text(
                    cx,
                    head_y + lh.title + 3.0 + i as f64 * (lh.value + LINE_GAP),
                    line,
                    TypeRole::Value,
                    ColourRole::InkMuted,
                    Anchor::Middle,
                    Baseline::Top,
                    c,
                );
            }
            for (i, row) in node.rows.iter().enumerate() {
                let rr = p.rows[i];
                let size = &s.rows[i];
                let lit = row.lit.map(Tone::colour);
                pen.boxed(
                    rr,
                    5.0,
                    BoxPaint {
                        fill: Some((ColourRole::Surface, 1.0)),
                        stroke: Some((lit.unwrap_or(ColourRole::Grid), 1.0)),
                    },
                    c,
                );
                if let Some(lit) = lit {
                    let paint = BoxPaint {
                        fill: Some((lit, 0.14)),
                        stroke: None,
                    };
                    pen.boxed(rr, 5.0, paint, c);
                }
                // The first line's band: a key sits on it, level with the
                // text's top, never on the row's middle.
                let line_y = rr.y + ROW_PAD_Y + (size.band / 2.0).round();
                if let Some(key) = &row.key {
                    pen.key(rr.x + ROW_PAD_X + DISC, line_y, key.n, c, m);
                    if let Some(at) = keyed.iter().position(|n| *n == key.n) {
                        pen.hit(rr.x, rr.y, rr.w, rr.h, at);
                    }
                }
                let tx = rr.x + ROW_PAD_X + row_lead(row);
                pen.text(
                    tx,
                    line_y,
                    &row.name,
                    row_role(row),
                    ColourRole::Ink,
                    Anchor::Start,
                    Baseline::Middle,
                    c,
                );
                for (j, line) in size.sub.lines.iter().enumerate() {
                    pen.text(
                        tx,
                        rr.y + ROW_PAD_Y + size.band + LINE_GAP + j as f64 * (lh.value + LINE_GAP),
                        line,
                        TypeRole::Value,
                        ColourRole::InkMuted,
                        Anchor::Start,
                        Baseline::Top,
                        c,
                    );
                }
            }
            let note_lines = s.notes.iter().flat_map(|n| &n.lines);
            for (i, line) in note_lines.enumerate() {
                pen.text(
                    cx,
                    r.y + r.h + 8.0 + i as f64 * (lh.value + LINE_GAP),
                    line,
                    TypeRole::Value,
                    ColourRole::InkMuted,
                    Anchor::Middle,
                    Baseline::Top,
                    c,
                );
            }
        }
    }

    // Edges, over the boxes.
    let bottom = top + content_h;
    let outer_count = routed.iter().filter(|r| r.kind == Kind::Outer).count();
    let mut outer_seen = 0usize;
    let mut paths: Vec<Vec<Pt>> = Vec::new();
    let mut landings: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    let mut label_bottom = bottom;
    let mut label_right = right;
    let line_pitch = lh.value + LINE_GAP;
    for (i, r) in routed.iter().enumerate() {
        let colour = tone_colour(r.edge.tone);
        let delay = cols + i;
        let fr = end_rect(&placed, r.edge.from);
        let tr = end_rect(&placed, r.edge.to);
        let from_node = &placed[r.edge.from.col][r.edge.from.node];
        let to_node = &placed[r.edge.to.col][r.edge.to.node];
        let x1 = fr.x + fr.w;
        let lane_x = col_x[r.edge.from.col] + col_w[r.edge.from.col] + LANE0 + LANE * r.lane as f64;
        let pts: Vec<Pt> = match r.kind {
            Kind::Forward => {
                let x2 = tr.x;
                let pts = if r.y1 == r.y2 {
                    vec![(x1, r.y1), (x2, r.y2)]
                } else {
                    vec![(x1, r.y1), (lane_x, r.y1), (lane_x, r.y2), (x2, r.y2)]
                };
                // The label sits over the edge's last run, its last line
                // just above it.
                let a = pts[pts.len() - 2];
                let lx = ((a.0 + x2 - 8.0) / 2.0).round();
                let n = r.label.count();
                for (j, line) in r.label.lines.iter().enumerate() {
                    pen.text(
                        lx,
                        r.y2 - 5.0 - (n - 1 - j) as f64 * line_pitch,
                        line,
                        TypeRole::Value,
                        colour,
                        Anchor::Middle,
                        Baseline::Bottom,
                        delay,
                    );
                }
                pts
            }
            Kind::Stack => {
                let (a, b) = (from_node.rect, to_node.rect);
                let cx = a.x + (a.w / 2.0).round();
                let pts = if b.y > a.y {
                    vec![(cx, a.y + a.h), (cx, b.y)]
                } else {
                    vec![(cx, a.y), (cx, b.y + b.h)]
                };
                let my = ((pts[0].1 + pts[1].1) / 2.0).round();
                let block = lh.block(r.label.count());
                for (j, line) in r.label.lines.iter().enumerate() {
                    pen.text(
                        cx + 8.0,
                        my - block / 2.0 + j as f64 * line_pitch,
                        line,
                        TypeRole::Value,
                        colour,
                        Anchor::Start,
                        Baseline::Top,
                        delay,
                    );
                }
                pts
            }
            Kind::Outer => {
                // Out to the right, down past everything, along underneath,
                // and up into the target.
                let channel = bottom + CHANNEL0 + CHANNEL * outer_seen as f64;
                outer_seen += 1;
                let landing = landings.entry((r.edge.to.col, r.edge.to.node)).or_insert(0);
                let tx = to_node.rect.x + (to_node.rect.w / 2.0).round() + *landing as f64 * 14.0;
                *landing += 1;
                let pts = vec![
                    (x1, r.y1),
                    (lane_x, r.y1),
                    (lane_x, channel),
                    (tx, channel),
                    (tx, to_node.rect.y + to_node.slot),
                ];
                if r.label.count() > 0 {
                    let lx = ((lane_x + tx) / 2.0).round();
                    let ly = bottom + CHANNEL0 + CHANNEL * (outer_count - 1) as f64 + 6.0;
                    for (j, line) in r.label.lines.iter().enumerate() {
                        pen.text(
                            lx,
                            ly + j as f64 * line_pitch,
                            line,
                            TypeRole::Value,
                            colour,
                            Anchor::Middle,
                            Baseline::Top,
                            delay,
                        );
                    }
                    label_bottom = label_bottom.max(ly + lh.block(r.label.count()));
                    label_right = label_right.max(lx + r.label.w / 2.0 + MARGIN);
                } else {
                    label_bottom = label_bottom.max(channel + 4.0);
                }
                pts
            }
        };
        pen.edge(&pts, colour, r.edge.dashed, delay);
        paths.push(pts);
    }

    let tail = if gap_w[cols - 1] == 0.0 { MARGIN } else { 0.0 };
    let width = right.max(label_right).max(MARGIN + title_w + MARGIN) + tail;
    let height = label_bottom + MARGIN;
    Laid {
        crossings: crossings(&paths),
        program: pen.finish(width, height),
        errors: t.errors,
    }
}
