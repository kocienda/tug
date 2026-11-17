//! `states`: what a thing can be, and what moves it from one state to
//! another.
//!
//! The states without `under` stand on a main line, left to right in the
//! order given: the path when all goes well. A state `under` another hangs
//! beneath it, for a failure or a side exit. Every transition is placed by
//! where its two ends stand, so a spec always draws the same figure:
//!
//! - to the next state on the main line, a straight arrow between them;
//! - between any other two states on the main line, over the top, in a
//!   lane of its own, the shorter spans in the lanes nearer the line so the
//!   lanes nest;
//! - from a state down to the one beneath it, or back up, a short vertical
//!   arrow between the two rows;
//! - from a side state to another state on the main line, out of its side
//!   along the bottom row and up into the target's lower edge.
//!
//! States are round-ended, so a reader never takes one for a `flow` box.
//! The start is a dot with an arrow into its state; a state marked `end`
//! wears a second outline; a toned state is an outcome, with the wash and
//! the outline a lit row has. A transition's label sits on its arrow in a
//! chip, drawn after every arrow so none is crossed by one.

use crate::chart::ChartError;
use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    crossings, BoxPaint, LineHeights, Pen, Pt, Rect, Stroke, DISC, KEY_LEAD, LINE_GAP, MARGIN,
    ORIGIN_DOT,
};
use super::spec::{err, Move, States, Tone};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The padding inside a state, either side of its text and above and
/// below it, and the radius its ends turn on.
const PAD_X: f64 = 18.0;
const PAD_Y: f64 = 12.0;
const RADIUS: f64 = 18.0;
/// The width a state's sub-label wraps at, unless its name is wider.
const SUB_WRAP: f64 = 130.0;
/// The widths a transition's label wraps at: over the top, where a lane
/// runs long, and everywhere else.
const OVER_WRAP: f64 = 160.0;
const LABEL_WRAP: f64 = 110.0;
/// The start: a dot this far from its state, of this radius.
const START_REACH: f64 = 28.0;
const START_DOT: f64 = 5.0;
/// The room the start takes left of the main line.
const START_ROOM: f64 = 34.0;
/// The least gap between two states on the main line, and the room a
/// step's label takes past its chip.
const GAP_MIN: f64 = 56.0;
const STEP_SPARE: f64 = 46.0;
/// The least room between two columns' widest states, and the room a
/// return along the bottom takes past its chip.
const COL_GAP: f64 = 20.0;
const BACK_SPARE: f64 = 40.0;
/// The least gap between the main line and the row beneath it, and the
/// room past the labels on the arrows between them.
const ROW_GAP: f64 = 66.0;
const ROW_SPARE: f64 = 30.0;
/// The gap between two side states beneath one state.
const SIDE_GAP: f64 = 16.0;
/// How far a label beside its arrow stands from it.
const BESIDE: f64 = 6.0;
/// The first lane's height over the main line, and the pitch between
/// lanes, each grown to hold the chips on them.
const LANE0: f64 = 30.0;
const LANE: f64 = 36.0;
const LANE_CLEAR: f64 = 10.0;
/// Where transitions meet a state's top or bottom edge: this far apart,
/// and no nearer its ends than this; and on a side state's flank, this far
/// apart.
const PORT_STEP: f64 = 24.0;
const PORT_INSET: f64 = 20.0;
const FLANK_STEP: f64 = 16.0;
/// A toned state's wash and outline, as a lit row's.
const WASH: f64 = 0.14;
const OUTLINE: f64 = 0.9;
/// An end state's second outline: this far inside the first, this faint.
const END_INSET: f64 = 4.0;
const END_OPACITY: f64 = 0.6;

fn tone_colour(tone: Option<Tone>) -> ColourRole {
    tone.map_or(ColourRole::Ink, Tone::colour)
}

/// One end of a transition on an edge of a state, waiting for its place.
struct Port {
    /// The state whose edge it is on.
    state: usize,
    /// The order it takes along the edge.
    rank: (i64, i64),
    /// What stands there: a transition's start or end, or the start.
    of: PortOf,
}

#[derive(Clone, Copy, PartialEq)]
enum PortOf {
    From(usize),
    To(usize),
    Start,
}

/// Spreads `n` places about `mid`, `step` apart, inside `lo..=hi`.
fn spread(n: usize, mid: f64, step: f64, lo: f64, hi: f64) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let room = (hi - lo).max(0.0);
    let step = if n > 1 {
        step.min(room / (n - 1) as f64)
    } else {
        step
    };
    let first = (mid - step * (n - 1) as f64 / 2.0).max(lo);
    let first = first.min(hi - step * (n - 1) as f64).max(lo);
    (0..n).map(|j| (first + step * j as f64).round()).collect()
}

/// Places each group of ports along its edge, in rank order: `centre`
/// gives an edge's middle and its range.
fn place(
    mut ports: Vec<Port>,
    step: f64,
    edge: impl Fn(usize) -> (f64, f64, f64),
) -> Vec<(PortOf, f64)> {
    ports.sort_by_key(|p| (p.state, p.rank));
    let mut out = Vec::new();
    let mut i = 0;
    while i < ports.len() {
        let state = ports[i].state;
        let j = ports[i..]
            .iter()
            .position(|p| p.state != state)
            .map_or(ports.len(), |n| i + n);
        let (mid, lo, hi) = edge(state);
        for (p, at) in ports[i..j].iter().zip(spread(j - i, mid, step, lo, hi)) {
            out.push((p.of, at));
        }
        i = j;
    }
    out
}

fn at(placed: &[(PortOf, f64)], of: PortOf) -> Option<f64> {
    placed.iter().find(|(o, _)| *o == of).map(|(_, v)| *v)
}

/// Whether a run of a connector passes through the inside of `r`.
fn runs_through(a: Pt, b: Pt, r: &Rect) -> bool {
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    x1 > r.x + 1.0 && x0 < r.x + r.w - 1.0 && y1 > r.y + 1.0 && y0 < r.y + r.h - 1.0
}

pub(crate) fn layout(spec: &States, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
    let mut t = Texts::new(m);
    let lh = LineHeights::measure(m);
    let mut pen = Pen::new(animate);

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

    // Each state's size: one height for all, so the rows read as rows.
    let n = spec.states.len();
    let mut name_w = vec![0.0; n];
    let mut subs: Vec<Lines> = Vec::new();
    let mut w = vec![0.0; n];
    for (i, s) in spec.states.iter().enumerate() {
        let base = format!("/states/{i}");
        name_w[i] = t.name(TypeRole::Title, &s.name, &format!("{base}/name"));
        let sub = t.wrap_opt(
            TypeRole::Value,
            s.sub.as_deref(),
            name_w[i].max(SUB_WRAP),
            &format!("{base}/sub"),
        );
        let lead = if s.key.is_some() { KEY_LEAD } else { 0.0 };
        w[i] = (lead + name_w[i].max(sub.w) + 2.0 * PAD_X).ceil();
        subs.push(sub);
    }
    let band1 = lh.title.max(DISC * 2.0);
    let sub_lines = subs.iter().map(Lines::count).max().unwrap_or(0);
    let sh = 2.0 * PAD_Y
        + band1
        + if sub_lines > 0 {
            LINE_GAP + lh.block(sub_lines)
        } else {
            0.0
        };

    // Each transition's move, label and chip.
    let moves = spec.moves();
    let labels: Vec<Lines> = spec
        .transitions
        .iter()
        .enumerate()
        .map(|(k, tr)| {
            let wrap = if moves[k] == Move::Over {
                OVER_WRAP
            } else {
                LABEL_WRAP
            };
            t.wrap_opt(
                TypeRole::Value,
                tr.label.as_deref(),
                wrap,
                &format!("/transitions/{k}/label"),
            )
        })
        .collect();
    let chip: Vec<(f64, f64)> = labels
        .iter()
        .map(|l| {
            if l.count() == 0 {
                (0.0, 0.0)
            } else {
                Pen::chip_size(l.count(), l.w, TypeRole::Value, &lh)
            }
        })
        .collect();

    // Columns: one per state on the main line, its side states beneath.
    let main = spec.main();
    let starts_on_top = spec.states[spec.start].under.is_none() && spec.start != main[0];
    // A state is at least wide enough for the ends meeting its top or its
    // bottom edge to stand a port's step apart, so a short name that
    // several transitions reach keeps their heads apart.
    let mut top_ends = vec![0usize; n];
    let mut bottom_ends = vec![0usize; n];
    if starts_on_top {
        top_ends[spec.start] += 1;
    }
    for (k, tr) in spec.transitions.iter().enumerate() {
        match moves[k] {
            Move::Step => {}
            Move::Over => {
                top_ends[tr.from] += 1;
                top_ends[tr.to] += 1;
            }
            // A vertical meets the bottom of the state above and the top of
            // the side state beneath it.
            Move::Drop => {
                bottom_ends[tr.from] += 1;
                top_ends[tr.to] += 1;
            }
            Move::Rise => {
                bottom_ends[tr.to] += 1;
                top_ends[tr.from] += 1;
            }
            Move::Back => bottom_ends[tr.to] += 1,
        }
    }
    for i in 0..n {
        let ends = top_ends[i].max(bottom_ends[i]);
        if ends > 1 {
            w[i] = w[i].max(2.0 * PORT_INSET + PORT_STEP * (ends - 1) as f64);
        }
    }
    let col_of = |s: usize| -> usize {
        let s = spec.states[s].under.unwrap_or(s);
        main.iter().position(|&m| m == s).unwrap_or(0)
    };
    let sides: Vec<Vec<usize>> = main
        .iter()
        .map(|&m| {
            (0..n)
                .filter(|&s| spec.states[s].under == Some(m))
                .collect()
        })
        .collect();
    let sides_w = |c: usize| -> f64 {
        let s = &sides[c];
        s.iter().map(|&i| w[i]).sum::<f64>() + SIDE_GAP * s.len().saturating_sub(1) as f64
    };
    // The vertical transitions in each column, in the order they stand.
    let verticals: Vec<Vec<usize>> = (0..main.len())
        .map(|c| {
            (0..spec.transitions.len())
                .filter(|&k| matches!(moves[k], Move::Drop | Move::Rise))
                .filter(|&k| col_of(spec.transitions[k].from) == c)
                .collect()
        })
        .collect();
    let col_w: Vec<f64> = (0..main.len())
        .map(|c| {
            let chips = verticals[c].iter().map(|&k| chip[k].0).fold(0.0, f64::max);
            w[main[c]].max(sides_w(c)).max(chips)
        })
        .collect();
    let mut cx: Vec<f64> = vec![(MARGIN + START_ROOM + col_w[0] / 2.0).round()];
    for c in 1..main.len() {
        let mut gap = GAP_MIN;
        for (k, tr) in spec.transitions.iter().enumerate() {
            if moves[k] == Move::Step && col_of(tr.from) == c - 1 {
                gap = gap.max(chip[k].0 + STEP_SPARE);
            }
        }
        let mut between = (col_w[c - 1] / 2.0 + col_w[c] / 2.0 + COL_GAP)
            .max(w[main[c - 1]] / 2.0 + w[main[c]] / 2.0 + gap);
        // A return along the bottom between neighbours needs room for its
        // label on the way.
        for (k, tr) in spec.transitions.iter().enumerate() {
            let (u, j) = (col_of(tr.from), col_of(tr.to));
            if moves[k] == Move::Back && u.min(j) == c - 1 && u.max(j) == c && chip[k].0 > 0.0 {
                between = between.max(w[tr.from] / 2.0 + chip[k].0 + BACK_SPARE);
            }
        }
        cx.push((cx[c - 1] + between).round());
    }

    // Lanes over the top: the shorter spans nearer the line, so they nest.
    let mut overs: Vec<usize> = (0..spec.transitions.len())
        .filter(|&k| moves[k] == Move::Over)
        .collect();
    let span = |k: usize| {
        let tr = &spec.transitions[k];
        col_of(tr.from).abs_diff(col_of(tr.to))
    };
    overs.sort_by_key(|&k| (span(k), k));
    let lane_of = |k: usize| overs.iter().position(|&o| o == k);
    let over_h = overs.iter().map(|&k| chip[k].1).fold(0.0, f64::max);
    let mut lane0 = LANE0.max((over_h / 2.0 + LANE_CLEAR).ceil());
    if starts_on_top {
        lane0 = lane0.max(START_REACH + START_DOT + LANE_CLEAR);
    }
    let pitch = LANE.max(over_h + LANE_CLEAR);
    let main_y = if overs.is_empty() {
        top + if starts_on_top {
            START_REACH + START_DOT
        } else {
            0.0
        }
    } else {
        (top + lane0 + pitch * (overs.len() - 1) as f64 + (over_h / 2.0).ceil()).round()
    };
    let lane_y = |lane: usize| main_y - lane0 - pitch * lane as f64;

    // The rows: the gap between them holds the labels on the arrows there.
    let row_gap = (0..main.len())
        .map(|c| {
            let labelled: Vec<f64> = verticals[c]
                .iter()
                .map(|&k| chip[k].1)
                .filter(|h| *h > 0.0)
                .collect();
            // Two labels stand side by side; more stand one above another.
            if labelled.len() == 2 {
                labelled.iter().copied().fold(0.0, f64::max) + ROW_SPARE
            } else {
                labelled.iter().sum::<f64>()
                    + ROW_SPARE
                    + 8.0 * labelled.len().saturating_sub(1) as f64
            }
        })
        .fold(ROW_GAP, f64::max)
        .round();
    let side_y = main_y + sh + row_gap;
    let has_side = sides.iter().any(|s| !s.is_empty());

    let mut rects = vec![Rect::default(); n];
    for (c, &s) in main.iter().enumerate() {
        rects[s] = Rect {
            x: (cx[c] - w[s] / 2.0).round(),
            y: main_y,
            w: w[s],
            h: sh,
        };
        let mut x = (cx[c] - sides_w(c) / 2.0).round();
        for &side in &sides[c] {
            rects[side] = Rect {
                x,
                y: side_y,
                w: w[side],
                h: sh,
            };
            x += w[side] + SIDE_GAP;
        }
    }

    // Where each transition meets each edge.
    let mut tops: Vec<Port> = Vec::new();
    let mut bottoms: Vec<Port> = Vec::new();
    let mut flanks: Vec<Port> = Vec::new();
    if starts_on_top {
        tops.push(Port {
            state: spec.start,
            rank: (-1, 0),
            of: PortOf::Start,
        });
    } else if spec.states[spec.start].under.is_some() {
        flanks.push(Port {
            state: spec.start,
            rank: (-1, 0),
            of: PortOf::Start,
        });
    }
    for (k, tr) in spec.transitions.iter().enumerate() {
        let (u, j) = (col_of(tr.from) as i64, col_of(tr.to) as i64);
        match moves[k] {
            Move::Step => {}
            Move::Over => {
                let lane = lane_of(k).unwrap_or(0) as i64;
                // Along a top edge: the ends leading left first, the inner
                // lanes leftmost; then those leading right, the inner lanes
                // rightmost. Every lane then clears every other's ends.
                let rank = |toward: i64| {
                    if toward < 0 {
                        (0, lane)
                    } else {
                        (1, -lane)
                    }
                };
                tops.push(Port {
                    state: tr.from,
                    rank: rank(j - u),
                    of: PortOf::From(k),
                });
                tops.push(Port {
                    state: tr.to,
                    rank: rank(u - j),
                    of: PortOf::To(k),
                });
            }
            Move::Drop | Move::Rise => {
                let (above, side) = if moves[k] == Move::Drop {
                    (tr.from, tr.to)
                } else {
                    (tr.to, tr.from)
                };
                let of = if moves[k] == Move::Drop {
                    PortOf::From(k)
                } else {
                    PortOf::To(k)
                };
                bottoms.push(Port {
                    state: above,
                    rank: (
                        1,
                        (rects[side].x as i64) * 2 + i64::from(moves[k] == Move::Rise),
                    ),
                    of,
                });
            }
            Move::Back => {
                // Into the target's lower edge from the side it comes from;
                // out of the source's flank, the nearer targets higher.
                bottoms.push(Port {
                    state: tr.to,
                    rank: if u < j { (0, -u) } else { (2, -u) },
                    of: PortOf::To(k),
                });
                flanks.push(Port {
                    state: tr.from,
                    rank: (if j > u { 1 } else { 0 }, (j - u).abs()),
                    of: PortOf::From(k),
                });
            }
        }
    }
    let edge_x = |s: usize| {
        let r = rects[s];
        (r.x + r.w / 2.0, r.x + PORT_INSET, r.x + r.w - PORT_INSET)
    };
    let tops = place(tops, PORT_STEP, edge_x);
    let bottoms = place(bottoms, PORT_STEP, edge_x);
    // A flank holds the ends leaving it on one side; the two sides are
    // spread apart.
    let mut left: Vec<Port> = Vec::new();
    let mut right: Vec<Port> = Vec::new();
    for p in flanks {
        if p.rank.0 == 1 {
            right.push(p);
        } else {
            left.push(p);
        }
    }
    let edge_y = |s: usize| {
        let r = rects[s];
        (r.mid_y(), r.y + RADIUS / 2.0, r.y + r.h - RADIUS / 2.0)
    };
    let mut flank = place(left, FLANK_STEP, edge_y);
    flank.extend(place(right, FLANK_STEP, edge_y));

    // Each transition's path and where its chip sits.
    let mut paths: Vec<Vec<Pt>> = Vec::new();
    let mut chips: Vec<Option<Pt>> = Vec::new();
    for (k, tr) in spec.transitions.iter().enumerate() {
        let (a, b) = (rects[tr.from], rects[tr.to]);
        let (pts, at_chip): (Vec<Pt>, Pt) = match moves[k] {
            Move::Step => {
                let y = a.mid_y();
                let (x0, x1) = if b.x > a.x {
                    (a.x + a.w, b.x)
                } else {
                    (a.x, b.x + b.w)
                };
                (vec![(x0, y), (x1, y)], (((x0 + x1) / 2.0).round(), y))
            }
            Move::Over => {
                let ly = lane_y(lane_of(k).unwrap_or(0));
                let sx = at(&tops, PortOf::From(k)).unwrap_or(a.x + a.w / 2.0);
                let tx = at(&tops, PortOf::To(k)).unwrap_or(b.x + b.w / 2.0);
                (
                    vec![(sx, a.y), (sx, ly), (tx, ly), (tx, b.y)],
                    (((sx + tx) / 2.0).round(), ly),
                )
            }
            Move::Drop | Move::Rise => {
                let (above, side) = if moves[k] == Move::Drop {
                    (a, b)
                } else {
                    (b, a)
                };
                let of = if moves[k] == Move::Drop {
                    PortOf::From(k)
                } else {
                    PortOf::To(k)
                };
                let x = at(&bottoms, of).unwrap_or(above.x + above.w / 2.0);
                // Clamped by hand: a side state narrower than two insets
                // has no range, while its text is still unmeasured.
                let xs = x.min(side.x + side.w - PORT_INSET).max(side.x + PORT_INSET);
                let (y0, y1) = (above.y + above.h, side.y);
                let mut pts = if x == xs {
                    vec![(x, y0), (x, y1)]
                } else {
                    let mid = ((y0 + y1) / 2.0).round();
                    vec![(x, y0), (x, mid), (xs, mid), (xs, y1)]
                };
                if moves[k] == Move::Rise {
                    pts.reverse();
                }
                let c = col_of(tr.from);
                let labelled: Vec<usize> = verticals[c]
                    .iter()
                    .copied()
                    .filter(|&v| chip[v].1 > 0.0)
                    .collect();
                // Two labels in one gap stand beside their arrows, each on
                // its outer side, so neither covers the other's arrow.
                if let [p, q] = labelled[..] {
                    let port_x = |v: usize| {
                        let of = if moves[v] == Move::Drop {
                            PortOf::From(v)
                        } else {
                            PortOf::To(v)
                        };
                        at(&bottoms, of).unwrap_or(0.0)
                    };
                    let other = if p == k { q } else { p };
                    let outward = if port_x(k) <= port_x(other) {
                        -1.0
                    } else {
                        1.0
                    };
                    let cx = x + outward * (chip[k].0 / 2.0 + BESIDE);
                    (pts, (cx.round(), ((y0 + y1) / 2.0).round()))
                } else {
                    // Otherwise the labels stand one above another.
                    let total: f64 = labelled.iter().map(|&v| chip[v].1).sum();
                    let space = (y1 - y0 - total) / (labelled.len() + 1) as f64;
                    let before = labelled.iter().take_while(|&&v| v != k);
                    let slot = before.clone().count() as f64;
                    let above: f64 = before.map(|&v| chip[v].1).sum();
                    let cy = y0 + space * (slot + 1.0) + above + chip[k].1 / 2.0;
                    (pts, (x, cy.round()))
                }
            }
            Move::Back => {
                let rightward = b.x > a.x;
                let sx = if rightward { a.x + a.w } else { a.x };
                let y = at(&flank, PortOf::From(k)).unwrap_or(a.mid_y());
                let tx = at(&bottoms, PortOf::To(k)).unwrap_or(b.x + b.w / 2.0);
                (
                    vec![(sx, y), (tx, y), (tx, b.y + b.h)],
                    (((sx + tx) / 2.0).round(), y),
                )
            }
        };
        paths.push(pts);
        chips.push((chip[k].1 > 0.0).then_some(at_chip));
    }

    // The start: a dot and a short arrow into its state.
    let s = rects[spec.start];
    let start: Vec<Pt> = if starts_on_top {
        let x = at(&tops, PortOf::Start).unwrap_or(s.x + s.w / 2.0);
        vec![(x, s.y - START_REACH), (x, s.y)]
    } else {
        let y = at(&flank, PortOf::Start).unwrap_or(s.mid_y());
        vec![(s.x - START_REACH, y), (s.x, y)]
    };

    // A wide chip may reach past the first state: the figure moves right
    // to keep it in.
    let chip_rect = |k: usize, c: Pt| Rect {
        x: c.0 - chip[k].0 / 2.0,
        y: c.1 - chip[k].1 / 2.0,
        w: chip[k].0,
        h: chip[k].1,
    };
    let mut extents: Vec<Rect> = rects.clone();
    extents.extend(
        chips
            .iter()
            .enumerate()
            .filter_map(|(k, c)| c.map(|c| chip_rect(k, c))),
    );
    let left_most = extents.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let left_most = left_most.min(start[0].0 - START_DOT);
    let dx = (MARGIN - left_most).max(0.0).round();
    if dx > 0.0 {
        for r in rects.iter_mut().chain(extents.iter_mut()) {
            r.x += dx;
        }
        for p in paths.iter_mut().flatten() {
            p.0 += dx;
        }
        for c in chips.iter_mut().flatten() {
            c.0 += dx;
        }
    }
    let start: Vec<Pt> = start.iter().map(|p| (p.0 + dx, p.1)).collect();

    // A transition that runs through a state it does not join hides it.
    let mut warnings: Vec<ChartError> = Vec::new();
    for (k, (tr, pts)) in spec.transitions.iter().zip(&paths).enumerate() {
        let hidden = (0..n).filter(|&s| s != tr.from && s != tr.to).find(|&s| {
            pts.windows(2)
                .any(|run| runs_through(run[0], run[1], &rects[s]))
        });
        if let Some(s) = hidden {
            warnings.push(err(
                format!("/transitions/{k}"),
                format!(
                    "the transition from \"{}\" to \"{}\" runs through \"{}\"; reorder the main line or split the figure",
                    spec.states[tr.from].name, spec.states[tr.to].name, spec.states[s].name
                ),
            ));
        }
    }

    // The states.
    let mut keys: Vec<u64> = spec
        .states
        .iter()
        .filter_map(|s| s.key.as_ref().map(|k| k.n))
        .collect();
    keys.sort_unstable();
    for (i, st) in spec.states.iter().enumerate() {
        let r = rects[i];
        let delay = col_of(i) + usize::from(st.under.is_some());
        let radius = RADIUS.min(sh / 2.0);
        pen.boxed(r, radius, BoxPaint::PLAIN, delay);
        if let Some(tone) = st.tone {
            let paint = BoxPaint {
                fill: Some((tone.colour(), WASH)),
                stroke: Some((tone.colour(), OUTLINE)),
            };
            pen.boxed(r, radius, paint, delay);
        }
        if st.end {
            let inner = Rect {
                x: r.x + END_INSET,
                y: r.y + END_INSET,
                w: r.w - 2.0 * END_INSET,
                h: r.h - 2.0 * END_INSET,
            };
            let colour = st.tone.map_or(ColourRole::InkMuted, Tone::colour);
            let paint = BoxPaint {
                fill: None,
                stroke: Some((colour, END_OPACITY)),
            };
            pen.boxed(inner, radius - END_INSET, paint, delay);
        }
        let sub = &subs[i];
        let text_h = band1
            + if sub.count() > 0 {
                LINE_GAP + lh.block(sub.count())
            } else {
                0.0
            };
        let text_top = r.y + ((sh - text_h) / 2.0).round();
        let line_y = text_top + (band1 / 2.0).round();
        let mid = (r.x + r.w / 2.0).round();
        let lead = if st.key.is_some() { KEY_LEAD } else { 0.0 };
        let left = (mid - (lead + name_w[i]) / 2.0).round();
        if let Some(key) = &st.key {
            pen.key(left + DISC, line_y, key.n, delay, m);
            if let Some(at) = keys.iter().position(|n| *n == key.n) {
                pen.hit(r.x, r.y, r.w, r.h, at);
            }
        }
        pen.text(
            left + lead,
            line_y,
            t.shown(TypeRole::Title, &st.name),
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::Start,
            Baseline::Middle,
            delay,
        );
        for (j, line) in sub.lines.iter().enumerate() {
            pen.text(
                mid,
                text_top + band1 + LINE_GAP + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Middle,
                Baseline::Top,
                delay,
            );
        }
    }

    pen.dot(start[0].0, start[0].1, START_DOT, ColourRole::Ink, 0);
    let from_dot = Stroke::arrow(ColourRole::Ink, false);
    let d = if starts_on_top {
        (0.0, 1.0)
    } else {
        (1.0, 0.0)
    };
    pen.connector(
        &[
            (start[0].0 + d.0 * START_DOT, start[0].1 + d.1 * START_DOT),
            start[1],
        ],
        from_dot,
        0,
    );

    // The transitions, then their labels over them.
    let cols = main.len();
    for (k, tr) in spec.transitions.iter().enumerate() {
        let colour = tone_colour(tr.tone);
        let pts = &paths[k];
        pen.edge(pts, colour, tr.dashed, cols + k);
        pen.dot(pts[0].0, pts[0].1, ORIGIN_DOT, colour, cols + k);
    }
    for (k, tr) in spec.transitions.iter().enumerate() {
        if let Some((x, y)) = chips[k] {
            pen.chip(
                x,
                y,
                &labels[k].lines,
                labels[k].w,
                TypeRole::Value,
                tr.tone.map(Tone::colour),
                &lh,
                cols + k,
            );
        }
    }

    let right = extents.iter().map(|r| r.x + r.w).fold(0.0, f64::max);
    let width = (right + MARGIN).max(MARGIN + title_w + MARGIN);
    let bottom = if has_side { side_y + sh } else { main_y + sh };
    let bottom = extents.iter().map(|r| r.y + r.h).fold(bottom, f64::max);
    warnings.extend(t.warnings);
    Laid {
        crossings: crossings(&paths),
        program: pen.finish(width, bottom + MARGIN),
        warnings,
    }
}
