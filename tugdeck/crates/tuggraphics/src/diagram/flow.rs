//! `flow`: columns of boxes left to right, a box may hold rows, and edges
//! route themselves.
//!
//! An edge between neighbouring columns, forward or back, leaves the side
//! of its source that faces the target and crosses the one gap: straight
//! wherever one end is free to meet the other's height, and otherwise
//! turning in a lane of the gap. An edge within a column runs straight
//! down or up between the two boxes. Only an edge that skips a column runs
//! under the boxes, each in a lane of its own; it comes up into a box from
//! below, or, when it ends at a row, in the gap beside that row's box and
//! turns into the row. No edge runs through a box it does not join: an end
//! on a box with another beneath it leaves or arrives by the box's side,
//! in a lane outside the figure when its column is the first or the last
//! and otherwise in the gap beside it, and an edge within a column that
//! passes a box between its ends goes round by the column's right. The
//! gaps are sized last, from the lanes and labels that must fit in them,
//! so every coordinate follows from the boxes' text.
//!
//! Every edge starts with a dot where it leaves its box or row, and its
//! label sits on it in a chip, drawn after all the edges. A lit row wears
//! its tone as a wash, an outline and a dot, and a `legend` names what each
//! tone means in one line under the figure.

use std::collections::BTreeMap;

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    crossings, BoxPaint, Head, LineHeights, Pen, Pt, Rect, Stroke, CHIP_PAD_X, DISC, EDGE_WIDTH,
    KEY_LEAD, LINE_GAP, MARGIN, ORIGIN_DOT,
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
/// The first lane under the boxes, and the pitch of the lanes after: far
/// enough apart that each one's chip sits on its own line.
const UNDER0: f64 = 26.0;
const UNDER: f64 = 30.0;
/// How far apart two edges leave or reach a box's bottom, and how far from
/// its corners they stay.
const PORT_STEP: f64 = 24.0;
const PORT_CLEAR: f64 = 22.0;
const PORT_INSET: f64 = 20.0;
/// How far inside a box a row's height may meet its side as it is.
const MEET_INSET: f64 = 6.0;
/// The narrowest gap between two columns.
const GAP_MIN: f64 = 52.0;
/// The widths secondary text wraps at, unless the name above it is wider.
const SUB_WRAP: f64 = 160.0;
const ROW_SUB_WRAP: f64 = 140.0;
const NOTE_WRAP: f64 = 220.0;
/// A label in the gap between two columns wraps narrow, since its width
/// widens the gap; one under the figure has the figure's width beneath it.
const LABEL_WRAP: f64 = 96.0;
const UNDER_LABEL_WRAP: f64 = 240.0;
/// The air either side of a chip on a turn down the gap's centre.
const CHIP_AIR: f64 = 14.0;
/// The room a chip on a turn keeps from another edge crossing its gap.
const CHIP_CLEAR: f64 = 3.0;
/// A lit row: its wash, its outline's strength, its dot, and the room the
/// dot takes at the row's right.
const LIT_WASH: f64 = 0.14;
const LIT_OUTLINE: f64 = 0.9;
const LIT_DOT: f64 = 4.0;
const LIT_DOT_INSET: f64 = 13.0;
const LIT_ROOM: f64 = 18.0;
/// The legend: its distance under the figure, each entry's swatch, the
/// room between the swatch and its text, and between entries.
const LEGEND_GAP: f64 = 16.0;
const SWATCH: f64 = 20.0;
const SWATCH_GAP: f64 = 7.0;
const LEGEND_SPACE: f64 = 22.0;

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
    tone.map_or(ColourRole::Ink, Tone::colour)
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
    /// To the neighbouring column, either way.
    Near,
    /// Within the column.
    Stack,
    /// Past a column, under the boxes.
    Skip,
}

/// A lane in the gap right of column `gap`, counted from the column on its
/// left or from the one on its right, or the gap's centre; or a lane
/// outside the figure, left of the first column or right of the last.
#[derive(Clone, Copy)]
struct Lane {
    gap: usize,
    left: bool,
    k: usize,
    /// The lane down the gap's middle, which a labelled turn between
    /// neighbours takes so its chip can sit on the turn.
    centre: bool,
    /// Outside the figure: left of the first column when `left`, and
    /// otherwise right of the last.
    outer: bool,
}

impl Lane {
    /// Whether the lane lies to the right of column `col`.
    fn right_of(self, col: usize) -> bool {
        if self.outer {
            !self.left
        } else {
            self.gap == col
        }
    }

    /// The side of `rect`, in column `col`, that faces the lane.
    fn side(self, rect: Rect, col: usize) -> f64 {
        if self.right_of(col) {
            rect.x + rect.w
        } else {
            rect.x
        }
    }
}

struct Routed<'s> {
    edge: &'s FlowEdge,
    kind: Kind,
    /// 1 when the edge runs right or stays in its column, -1 when it runs
    /// left.
    dir: f64,
    y1: f64,
    y2: f64,
    label: Lines,
    /// The lane a neighbour turns in, the one a skipping edge leaves its
    /// row or its covered box by, or the one an edge within a column goes
    /// round a box in.
    turn: Option<Lane>,
    /// The lane a skipping edge comes up in to reach its row or its
    /// covered box.
    rise: Option<Lane>,
    /// A skipping edge's lane under the boxes.
    under: usize,
}

/// An end on a box's bottom: its order there (a deeper lane's farther from
/// where the edge goes), the edge, and whether the edge leaves by it.
type FloorEnd = (f64, usize, bool);

/// The next lane on one side of a gap.
fn take(lanes: &mut [[usize; 2]], gap: usize, left: bool) -> Lane {
    let side = usize::from(!left);
    let k = lanes[gap][side];
    lanes[gap][side] += 1;
    Lane {
        gap,
        left,
        k,
        centre: false,
        outer: false,
    }
}

/// The next lane outside the figure on one side.
fn take_outer(outer: &mut [usize; 2], left: bool) -> Lane {
    let side = usize::from(!left);
    let k = outer[side];
    outer[side] += 1;
    Lane {
        gap: 0,
        left,
        k,
        centre: false,
        outer: true,
    }
}

/// Where a chip on a turn down a gap's centre sits: as near the turn's
/// middle as it can be, slid along the turn clear of every other edge that
/// crosses the same gap, and at the middle when no place is clear.
fn on_turn(r: &Routed, all: &[Routed], gap: usize, chip_h: f64) -> f64 {
    let (lo, hi) = (r.y1.min(r.y2), r.y1.max(r.y2));
    let mid = ((lo + hi) / 2.0).round();
    let half = (chip_h / 2.0).ceil() + CHIP_CLEAR;
    let crossing: Vec<f64> = all
        .iter()
        .filter(|o| {
            !std::ptr::eq(*o, r)
                && o.kind == Kind::Near
                && o.edge.from.col.min(o.edge.to.col) == gap
        })
        .flat_map(|o| [o.y1, o.y2])
        .collect();
    let clear = |cy: f64| crossing.iter().all(|y| (y - cy).abs() > half);
    // The chip may hang past either end of the turn by half its height.
    let reach = (hi - lo) / 2.0 + (chip_h / 2.0).floor();
    let mut step = 0.0;
    while step <= reach {
        for cy in [mid - step, mid + step] {
            if clear(cy) {
                return cy;
            }
        }
        step += 1.0;
    }
    mid
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
                                w: row_lead(row)
                                    + rn.max(sub.w)
                                    + 2.0 * ROW_PAD_X
                                    + if row.lit.is_some() { LIT_ROOM } else { 0.0 },
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
    // A row's height met on a box's side as it is wherever it lies inside
    // the box, so a nearly level edge is drawn level.
    let meet = |v: f64, r: Rect| {
        if v >= r.y + MEET_INSET && v <= r.y + r.h - MEET_INSET {
            v
        } else {
            clamp(v, r)
        }
    };

    // Each edge's kind and the heights it leaves and arrives at. An end on
    // a box's side is spread from the edges already there, far enough that
    // a chip on one does not cover the other, and kept inside the box; an
    // end on a row is fixed at the row's middle.
    let mut taken: BTreeMap<(usize, usize, bool), Vec<f64>> = BTreeMap::new();
    let mut settle = |e: EndRef, right: bool, y: f64, fixed: bool, r: Rect| -> f64 {
        let used = taken.entry((e.col, e.node, right)).or_default();
        let mut at = y;
        if !fixed {
            for k in 1..8u32 {
                if !used.iter().any(|u| (u - at).abs() < PORT_CLEAR) {
                    break;
                }
                let side = if k % 2 == 1 { 1.0 } else { -1.0 };
                at = clamp(y + f64::from(k.div_ceil(2)) * PORT_STEP * side, r);
            }
        }
        used.push(at);
        at
    };

    let kind_of = |e: &FlowEdge| {
        if e.from.col.abs_diff(e.to.col) == 1 {
            Kind::Near
        } else if e.to.col == e.from.col {
            Kind::Stack
        } else {
            Kind::Skip
        }
    };
    // The heights each neighbour leaves and arrives at, settled first for
    // the edges with a row at an end: those heights are fixed, so the free
    // ends make room around them rather than the other way round.
    let mut heights: Vec<(f64, f64)> = flow
        .edges
        .iter()
        .map(|e| {
            (
                end_rect(&placed, e.from).mid_y(),
                end_rect(&placed, e.to).mid_y(),
            )
        })
        .collect();
    let mut order: Vec<usize> = (0..flow.edges.len()).collect();
    order.sort_by_key(|&i| {
        let e = &flow.edges[i];
        e.from.row.is_none() && e.to.row.is_none()
    });
    for i in order {
        let edge = &flow.edges[i];
        if kind_of(edge) != Kind::Near {
            continue;
        }
        let (from, to) = (edge.from, edge.to);
        let ahead = to.col >= from.col;
        let fr = end_rect(&placed, from);
        let tr = end_rect(&placed, to);
        let (from_fixed, to_fixed) = (from.row.is_some(), to.row.is_some());
        let (mut y1, mut y2) = heights[i];
        // A straight edge wherever one end is free to meet the other.
        match (from_fixed, to_fixed) {
            (true, false) => y2 = meet(y1, tr),
            (false, true) => y1 = meet(y2, fr),
            (false, false) => {
                y2 = clamp(y1, tr);
                y1 = clamp(y2, fr);
            }
            (true, true) => {}
        }
        let shift = settle(from, ahead, y1, from_fixed, fr) - y1;
        y1 += shift;
        if !to_fixed && y2 + shift == clamp(y2 + shift, tr) {
            y2 += shift;
        }
        y2 = settle(to, !ahead, y2, to_fixed, tr);
        heights[i] = (y1, y2);
    }
    let mut routed: Vec<Routed> = flow
        .edges
        .iter()
        .enumerate()
        .map(|(i, edge)| {
            let kind = kind_of(edge);
            let (y1, y2) = heights[i];
            let label = t.wrap_opt(
                TypeRole::Value,
                edge.label.as_deref(),
                if kind == Kind::Skip {
                    UNDER_LABEL_WRAP
                } else {
                    LABEL_WRAP
                },
                &format!("/edges/{i}/label"),
            );
            Routed {
                edge,
                kind,
                dir: if edge.to.col >= edge.from.col {
                    1.0
                } else {
                    -1.0
                },
                y1,
                y2,
                label,
                turn: None,
                rise: None,
                under: 0,
            }
        })
        .collect();

    // Lanes. The edges under the boxes nest: the one spanning fewer
    // columns, or ending at a row before its box, takes the shallower lane.
    // In the gaps, a skipping edge takes the lanes nearest the columns it
    // leaves a row from or comes up to a row in, the deepest first, so it
    // leaves and rises inside the shallower ones; then each neighbour that
    // turns takes the next lane past its source.
    let cols = flow.columns.len();
    let mut lanes: Vec<[usize; 2]> = vec![[0, 0]; cols];
    let mut outer = [0usize; 2];
    // An end on a box with another beneath it cannot use the box's bottom:
    // the way down is through the box below.
    let covered = |e: EndRef| e.row.is_none() && e.node + 1 < flow.columns[e.col].len();
    let at_edge = |c: usize| c == 0 || c == cols - 1;
    let mut skips: Vec<usize> = (0..routed.len())
        .filter(|&i| routed[i].kind == Kind::Skip)
        .collect();
    skips.sort_by_key(|&i| {
        let e = routed[i].edge;
        (e.from.col.abs_diff(e.to.col), e.to.row.is_none(), i)
    });
    for (under, &i) in skips.iter().enumerate() {
        routed[i].under = under;
    }
    for &i in skips.iter().rev() {
        let r = &mut routed[i];
        let (from, to) = (r.edge.from, r.edge.to);
        let ahead = r.dir > 0.0;
        if from.row.is_some() || (covered(from) && !at_edge(from.col)) {
            r.turn = Some(if ahead {
                take(&mut lanes, from.col, true)
            } else {
                take(&mut lanes, from.col - 1, false)
            });
        }
        if to.row.is_some() || (covered(to) && !at_edge(to.col)) {
            r.rise = Some(if ahead {
                take(&mut lanes, to.col - 1, false)
            } else {
                take(&mut lanes, to.col, true)
            });
        }
    }
    // A covered box in the first or the last column is left or reached
    // round the outside of the figure, where nothing else runs. The
    // shallowest lane under the boxes takes the nearest lane outside, so
    // the deeper ones pass round it.
    for &i in &skips {
        let r = &mut routed[i];
        let (from, to) = (r.edge.from, r.edge.to);
        if covered(from) && at_edge(from.col) {
            r.turn = Some(take_outer(&mut outer, from.col == 0));
        }
        if covered(to) && at_edge(to.col) {
            r.rise = Some(take_outer(&mut outer, to.col == 0));
        }
    }
    // An edge within a column that would pass through a box between its
    // ends goes round by the column's right.
    for r in routed.iter_mut().filter(|r| {
        r.kind == Kind::Stack && r.edge.from.node.abs_diff(r.edge.to.node) > 1
    }) {
        let c = r.edge.from.col;
        r.turn = Some(if c + 1 < cols {
            take(&mut lanes, c, true)
        } else {
            take_outer(&mut outer, false)
        });
    }
    // The ends these lanes put on a box's side are spread from the edges
    // already there, as a neighbour's are.
    for r in routed.iter_mut().filter(|r| r.kind != Kind::Near) {
        let (from, to) = (r.edge.from, r.edge.to);
        if let (Some(l), None) = (r.turn, from.row) {
            let rect = end_rect(&placed, from);
            r.y1 = settle(from, l.right_of(from.col), r.y1, false, rect);
        }
        let arrive = if r.kind == Kind::Stack { r.turn } else { r.rise };
        if let (Some(l), None) = (arrive, to.row) {
            let rect = end_rect(&placed, to);
            r.y2 = settle(to, l.right_of(to.col), r.y2, false, rect);
        }
    }
    // A labelled turn takes the gap's centre, one to a gap, and its chip
    // sits on the turn: the gap then holds the chip and a little air, not
    // a lane, the chip and a head's room besides.
    let mut centred = vec![false; cols];
    for r in routed
        .iter_mut()
        .filter(|r| r.kind == Kind::Near && r.y1 != r.y2)
    {
        let g = r.edge.from.col.min(r.edge.to.col);
        if r.label.count() > 0 && !centred[g] {
            centred[g] = true;
            r.turn = Some(Lane {
                gap: g,
                left: true,
                k: 0,
                centre: true,
                outer: false,
            });
            continue;
        }
        r.turn = Some(if r.dir > 0.0 {
            take(&mut lanes, r.edge.from.col, true)
        } else {
            take(&mut lanes, r.edge.to.col, false)
        });
    }
    let reach = |n: usize| {
        if n > 0 {
            LANE0 + LANE * (n - 1) as f64
        } else {
            0.0
        }
    };
    let gap_w: Vec<f64> = (0..cols)
        .map(|g| {
            if g == cols - 1 {
                return 0.0;
            }
            let [l, rr] = lanes[g];
            // Lanes from both sides need one pitch between them; from one
            // side, room for the arrival past the last.
            let between = if l > 0 && rr > 0 { LANE } else { 22.0 };
            let mut need = GAP_MIN.max(reach(l) + reach(rr) + between);
            for r in &routed {
                // A chip on a turn round a box sits past the lane.
                if let (Kind::Stack, Some(lane)) = (r.kind, r.turn) {
                    if !lane.outer && lane.gap == g && r.label.count() > 0 {
                        let chip = r.label.w + 2.0 * CHIP_PAD_X;
                        need = need.max(LANE0 + LANE * lane.k as f64 + chip + 26.0);
                    }
                    continue;
                }
                if r.kind != Kind::Near
                    || r.edge.from.col.min(r.edge.to.col) != g
                    || r.label.count() == 0
                {
                    continue;
                }
                let chip = r.label.w + 2.0 * CHIP_PAD_X;
                need = need.max(match r.turn {
                    None => chip + 30.0,
                    Some(lane) if lane.centre => {
                        chip + 2.0 * CHIP_AIR + 2.0 * reach(l).max(reach(rr))
                    }
                    Some(lane) => LANE0 + LANE * lane.k as f64 + chip + 26.0,
                });
            }
            need
        })
        .collect();

    // Now x.
    let mut col_x = Vec::with_capacity(cols);
    let mut x = MARGIN + reach(outer[0]);
    for c in 0..cols {
        col_x.push(x);
        x += col_w[c] + gap_w[c];
    }
    let right = x + reach(outer[1]);
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
                t.shown(TypeRole::Title, &node.name),
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
                        stroke: Some(lit.map_or((ColourRole::Grid, 1.0), |c| (c, LIT_OUTLINE))),
                    },
                    c,
                );
                if let Some(lit) = lit {
                    let paint = BoxPaint {
                        fill: Some((lit, LIT_WASH)),
                        stroke: None,
                    };
                    pen.boxed(rr, 5.0, paint, c);
                }
                // The first line's band: a key sits on it, level with the
                // text's top, never on the row's middle.
                let line_y = rr.y + ROW_PAD_Y + (size.band / 2.0).round();
                // A lit row carries its tone as a mark, not as a colour
                // alone.
                if let Some(lit) = lit {
                    pen.dot(rr.x + rr.w - LIT_DOT_INSET, line_y, LIT_DOT, lit, c);
                }
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
                    t.shown(row_role(row), &row.name),
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
    let lane_x = |l: Lane| {
        if l.outer {
            let out = LANE0 + LANE * l.k as f64;
            if l.left {
                col_x[0] - out
            } else {
                col_x[cols - 1] + col_w[cols - 1] + out
            }
        } else if l.centre {
            col_x[l.gap] + col_w[l.gap] + (gap_w[l.gap] / 2.0).round()
        } else if l.left {
            col_x[l.gap] + col_w[l.gap] + LANE0 + LANE * l.k as f64
        } else {
            col_x[l.gap + 1] - LANE0 - LANE * l.k as f64
        }
    };
    // Where the skipping edges leave and reach boxes' bottoms: spread about
    // each box's middle, a deeper lane's end standing farther out on the
    // side away from where the edge goes, so the lanes nest, not cross.
    let mut floors: BTreeMap<(usize, usize), Vec<FloorEnd>> = BTreeMap::new();
    for (i, r) in routed.iter().enumerate() {
        if r.kind != Kind::Skip {
            continue;
        }
        let depth = r.under as f64;
        if r.turn.is_none() {
            let e = r.edge.from;
            let ends = floors.entry((e.col, e.node)).or_default();
            ends.push((-r.dir * depth, i, true));
        }
        if r.rise.is_none() {
            let e = r.edge.to;
            let ends = floors.entry((e.col, e.node)).or_default();
            ends.push((r.dir * depth, i, false));
        }
    }
    let mut ports: BTreeMap<(usize, bool), f64> = BTreeMap::new();
    for ((c, k), mut ends) in floors {
        let rect = placed[c][k].rect;
        ends.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let n = ends.len() as f64;
        let mid = rect.x + (rect.w / 2.0).round();
        for (j, (_, i, leaving)) in ends.into_iter().enumerate() {
            let x = (mid + (j as f64 - (n - 1.0) / 2.0) * PORT_STEP).round();
            let x = x.max(rect.x + PORT_INSET).min(rect.x + rect.w - PORT_INSET);
            ports.insert((i, leaving), x);
        }
    }
    let mut paths: Vec<Vec<Pt>> = Vec::new();
    let mut label_bottom = bottom;
    let mut label_right = right;
    // Each label's chip, drawn once every edge is down.
    let mut chips: Vec<(f64, f64, usize)> = Vec::new();
    for (i, r) in routed.iter().enumerate() {
        let colour = tone_colour(r.edge.tone);
        let delay = cols + i;
        let (from, to) = (r.edge.from, r.edge.to);
        let fr = end_rect(&placed, from);
        let tr = end_rect(&placed, to);
        let from_node = &placed[from.col][from.node];
        let to_node = &placed[to.col][to.node];
        let ahead = r.dir > 0.0;
        // The side of a rect that faces the way the edge goes, leaving it
        // or arriving at it.
        let face = |rect: Rect, leaving: bool| {
            if leaving == ahead {
                rect.x + rect.w
            } else {
                rect.x
            }
        };
        let pts: Vec<Pt> = match r.kind {
            Kind::Near => {
                let (x1, x2) = (face(fr, true), face(tr, false));
                let (edge_s, edge_t) = (face(from_node.rect, true), face(to_node.rect, false));
                let (pts, run) = match r.turn {
                    None => (vec![(x1, r.y1), (x2, r.y2)], edge_s),
                    Some(l) => {
                        let lx = lane_x(l);
                        (vec![(x1, r.y1), (lx, r.y1), (lx, r.y2), (x2, r.y2)], lx)
                    }
                };
                // The label sits in the gap: on the turn when the edge
                // took the centre for it, and otherwise on its last run.
                match r.turn {
                    Some(l) if l.centre => {
                        let (_, ch) =
                            Pen::chip_size(r.label.count(), r.label.w, TypeRole::Value, &lh);
                        let cy = on_turn(r, &routed, l.gap, ch);
                        chips.push((run, cy, i));
                    }
                    _ => chips.push((((run + edge_t) / 2.0).round(), r.y2, i)),
                }
                pts
            }
            Kind::Stack => 'stack: {
                let (a, b) = (from_node.rect, to_node.rect);
                if let Some(l) = r.turn {
                    // Round the box between: out the side, along the
                    // lane, and back in.
                    let lx = lane_x(l);
                    let pts = vec![
                        (l.side(fr, from.col), r.y1),
                        (lx, r.y1),
                        (lx, r.y2),
                        (l.side(tr, to.col), r.y2),
                    ];
                    if r.label.count() > 0 {
                        let (cw, _) =
                            Pen::chip_size(r.label.count(), r.label.w, TypeRole::Value, &lh);
                        let half = (cw / 2.0).ceil();
                        // On the lane, and clear of the boxes it passes.
                        let cx = lx.max(l.side(a, from.col) + 6.0 + half);
                        chips.push((cx, ((r.y1 + r.y2) / 2.0).round(), i));
                        label_right = label_right.max(cx + half + MARGIN);
                    }
                    break 'stack pts;
                }
                let cx = a.x + (a.w / 2.0).round();
                let pts = if b.y > a.y {
                    vec![(cx, a.y + a.h), (cx, b.y)]
                } else {
                    vec![(cx, a.y), (cx, b.y + b.h)]
                };
                let my = ((pts[0].1 + pts[1].1) / 2.0).round();
                chips.push((cx, my, i));
                pts
            }
            Kind::Skip => {
                // Down to a lane of its own under the boxes, along it, and
                // up: into the box from below, or beside a row's box and in.
                let lane_y = bottom + UNDER0 + UNDER * r.under as f64;
                let mut pts: Vec<Pt> = Vec::new();
                let sx = match r.turn {
                    Some(l) => {
                        let lx = lane_x(l);
                        pts.push((l.side(fr, from.col), r.y1));
                        pts.push((lx, r.y1));
                        lx
                    }
                    None => {
                        let x = ports[&(i, true)];
                        pts.push((x, from_node.rect.y + from_node.slot));
                        x
                    }
                };
                pts.push((sx, lane_y));
                let tx = match r.rise {
                    Some(l) => {
                        let lx = lane_x(l);
                        pts.push((lx, lane_y));
                        pts.push((lx, r.y2));
                        pts.push((l.side(tr, to.col), r.y2));
                        lx
                    }
                    None => {
                        let x = ports[&(i, false)];
                        pts.push((x, lane_y));
                        pts.push((x, to_node.rect.y + to_node.slot));
                        x
                    }
                };
                if r.label.count() > 0 {
                    let lx = ((sx + tx) / 2.0).round();
                    chips.push((lx, lane_y, i));
                    let (cw, ch) = Pen::chip_size(r.label.count(), r.label.w, TypeRole::Value, &lh);
                    label_bottom = label_bottom.max(lane_y + (ch / 2.0).ceil());
                    label_right = label_right.max(lx + (cw / 2.0).ceil() + MARGIN);
                } else {
                    label_bottom = label_bottom.max(lane_y + 4.0);
                }
                pts
            }
        };
        pen.edge(&pts, colour, r.edge.dashed, delay);
        pen.dot(pts[0].0, pts[0].1, ORIGIN_DOT, colour, delay);
        paths.push(pts);
    }
    for (cx, cy, i) in chips {
        let r = &routed[i];
        let tone = r.edge.tone.map(Tone::colour);
        pen.chip(
            cx,
            cy,
            &r.label.lines,
            r.label.w,
            TypeRole::Value,
            tone,
            &lh,
            cols + i,
        );
    }

    // The legend: one line under the figure, a swatch of each tone and
    // what it means here.
    let mut bottom_edge = label_bottom;
    let mut legend_right = 0.0;
    if !flow.legend.is_empty() {
        let y = label_bottom + LEGEND_GAP;
        let mid = y + (lh.value / 2.0).round();
        let delay = cols + flow.edges.len();
        let mut lx = MARGIN;
        for (i, item) in flow.legend.iter().enumerate() {
            let swatch = Stroke {
                colour: item.tone.colour(),
                width: EDGE_WIDTH,
                dashed: false,
                head: Head::Bare,
            };
            pen.connector(&[(lx, mid), (lx + SWATCH, mid)], swatch, delay);
            let w = t.line(TypeRole::Value, &item.text, &format!("/legend/{i}/text"));
            pen.text(
                lx + SWATCH + SWATCH_GAP,
                mid,
                t.shown(TypeRole::Value, &item.text),
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                Baseline::Middle,
                delay,
            );
            lx += SWATCH + SWATCH_GAP + w + LEGEND_SPACE;
        }
        legend_right = lx - LEGEND_SPACE;
        bottom_edge = y + lh.value;
    }

    let width = (right + MARGIN)
        .max(label_right)
        .max(legend_right + MARGIN)
        .max(MARGIN + title_w + MARGIN);
    Laid {
        crossings: crossings(&paths),
        program: pen.finish(width, bottom_edge + MARGIN),
        warnings: t.warnings,
    }
}
