//! `layers`: full-width strata top to bottom, and what crosses each
//! boundary.
//!
//! Each layer is a band with its name in a label column at the left and
//! its cells in a row across the rest, every cell of a layer the same
//! width and every cell of the figure the same height, so the strata read
//! as one stack; a faint rule divides the label column from the cells, and
//! a layer outside the system wears the outside wash.
//!
//! Between two layers whose upper one says what crosses to the lower, the
//! crossing is centred on the band's own centre line in a gap of its own.
//! A string is one two-headed arrow with the label in a chip on it. An
//! object says what goes `down` and comes `up` — two one-way arrows, the
//! one going down at the left with its label left of it, the one coming up
//! at the right with its label right of it — and the channel between them,
//! `via`, set in the code face in a chip. One direction alone is a single
//! one-way arrow with its label beside it. The band widens to hold its
//! widest crossing, laid out symmetrically about the centre.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    BoxPaint, LineHeights, Pen, Rect, Stroke, CHIP_PAD_Y, DISC, KEY_LEAD, LINE_GAP, MARGIN,
};
use super::spec::{Crossing, LayerCell, Layers};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The room inside a band around its cells, and between two cells.
const BAND_PAD: f64 = 10.0;
const CELL_GAP: f64 = 8.0;
/// The padding inside a cell, either side of its text and above and below.
const CELL_PAD_X: f64 = 12.0;
const CELL_PAD_Y: f64 = 8.0;
/// Where a layer's name starts inside its band, and the room the label
/// column keeps past the widest name; the rule dividing it from the cells
/// stands this far left of the cells.
const LABEL_INSET: f64 = 14.0;
const LABEL_SPARE: f64 = 44.0;
const RULE_BACK: f64 = 15.0;
/// The gap between two layers with nothing said to cross it, and the
/// least gap one with a crossing takes.
const QUIET_GAP: f64 = 12.0;
const CROSSING_GAP: f64 = 58.0;
/// How far a crossing's arrow stops short of the bands it joins, and how
/// far from it a label beside it stands.
const ARROW_INSET: f64 = 4.0;
const ARROW_LABEL: f64 = 12.0;
/// Half the distance between a paired crossing's two arrows with no
/// channel between them, and the room either side of a channel's chip.
const PAIR_HALF: f64 = 12.0;
const VIA_SPARE: f64 = 18.0;
/// The widths secondary text wraps at, unless the name above it is wider.
const SUB_WRAP: f64 = 160.0;
const CELL_SUB_WRAP: f64 = 140.0;
/// A two-way crossing's label sits in a chip on its arrow; what goes one
/// way stands beside its arrow, one of two sides.
const BELOW_WRAP: f64 = 240.0;
const WAY_WRAP: f64 = 170.0;

fn cell_role(c: &LayerCell) -> TypeRole {
    if c.mono {
        TypeRole::Mono
    } else {
        TypeRole::Label
    }
}

fn cell_lead(c: &LayerCell) -> f64 {
    if c.key.is_some() {
        KEY_LEAD
    } else {
        0.0
    }
}

pub(crate) fn layout(spec: &Layers, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
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

    // Sizes: each layer's head, each cell's text, each crossing's label.
    struct Head {
        w: f64,
        sub: Lines,
    }
    struct Cell {
        w: f64,
        sub: Lines,
    }
    let mut heads: Vec<Head> = Vec::new();
    let mut cells: Vec<Vec<Cell>> = Vec::new();
    let mut crosses: Vec<Option<Cross>> = Vec::new();
    for (i, layer) in spec.layers.iter().enumerate() {
        let base = format!("/layers/{i}");
        let name_w = t.name(TypeRole::Title, &layer.name, &format!("{base}/name"));
        let sub = t.wrap_opt(
            TypeRole::Value,
            layer.sub.as_deref(),
            name_w.max(SUB_WRAP),
            &format!("{base}/sub"),
        );
        heads.push(Head {
            w: name_w.max(sub.w),
            sub,
        });
        cells.push(
            layer
                .cells
                .iter()
                .enumerate()
                .map(|(k, c)| {
                    let cb = format!("{base}/cells/{k}");
                    let cn = t.name(cell_role(c), &c.name, &format!("{cb}/name"));
                    let sub = t.wrap_opt(
                        TypeRole::Value,
                        c.sub.as_deref(),
                        cn.max(CELL_SUB_WRAP),
                        &format!("{cb}/sub"),
                    );
                    Cell {
                        w: cell_lead(c) + cn.max(sub.w) + 2.0 * CELL_PAD_X,
                        sub,
                    }
                })
                .collect(),
        );
        crosses.push(
            layer
                .below
                .as_ref()
                .map(|c| Cross::measure(&mut t, c, &lh, &format!("{base}/below"))),
        );
    }

    let label_w = heads.iter().map(|h| h.w).fold(0.0, f64::max) + LABEL_SPARE;
    let mut inner = cells
        .iter()
        .map(|row| {
            let widest = row.iter().map(|c| c.w).fold(0.0, f64::max);
            row.len() as f64 * widest + CELL_GAP * (row.len() as f64 - 1.0)
        })
        .fold(0.0, f64::max);
    // A crossing is laid out about the band's centre, so the band is at
    // least as wide as its widest crossing.
    let need = crosses
        .iter()
        .flatten()
        .map(|c| c.need)
        .fold(0.0, f64::max);
    inner = inner.max((need - label_w - BAND_PAD).ceil());
    let band1 = lh.label.max(DISC * 2.0);
    let sub_lines = cells
        .iter()
        .flatten()
        .map(|c| c.sub.count())
        .max()
        .unwrap_or(0);
    let cell_h = 2.0 * CELL_PAD_Y
        + band1
        + if sub_lines > 0 {
            LINE_GAP + lh.block(sub_lines)
        } else {
            0.0
        };
    let head_h = |h: &Head| {
        lh.title
            + if h.sub.count() > 0 {
                3.0 + lh.block(h.sub.count())
            } else {
                0.0
            }
    };
    let band_h = (cell_h + 2.0 * BAND_PAD)
        .max(heads.iter().map(head_h).fold(0.0, f64::max) + 2.0 * BAND_PAD);
    let band_w = label_w + inner + BAND_PAD;

    let keyed: Vec<u64> = {
        let mut keys: Vec<u64> = spec
            .layers
            .iter()
            .flat_map(|l| &l.cells)
            .filter_map(|c| c.key.as_ref().map(|k| k.n))
            .collect();
        keys.sort_unstable();
        keys
    };

    let x = MARGIN;
    let mut y = top;
    let right = MARGIN + band_w;
    let mid = (x + band_w / 2.0).round();
    for (i, layer) in spec.layers.iter().enumerate() {
        let band = Rect {
            x,
            y,
            w: band_w,
            h: band_h,
        };
        pen.boxed(band, 8.0, BoxPaint::PLAIN, i);
        if layer.outside {
            let paint = BoxPaint {
                fill: Some((ColourRole::Outside, 0.16)),
                stroke: Some((ColourRole::Outside, 0.9)),
            };
            pen.boxed(band, 8.0, paint, i);
        }
        // The layer's name is the band's label, ruled off from what the
        // band holds.
        let rx = x + label_w - RULE_BACK;
        pen.rule(
            (rx, y + BAND_PAD),
            (rx, y + band_h - BAND_PAD),
            ColourRole::InkMuted,
            &[],
            0.35,
            i,
        );
        let head = &heads[i];
        let ty = y + ((band_h - head_h(head)) / 2.0).round();
        pen.text(
            x + LABEL_INSET,
            ty,
            t.shown(TypeRole::Title, &layer.name),
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::Start,
            Baseline::Top,
            i,
        );
        for (j, line) in head.sub.lines.iter().enumerate() {
            pen.text(
                x + LABEL_INSET,
                ty + lh.title + 3.0 + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                Baseline::Top,
                i,
            );
        }

        let count = layer.cells.len() as f64;
        let cw = ((inner - CELL_GAP * (count - 1.0)) / count).round();
        for (k, cell) in layer.cells.iter().enumerate() {
            let size = &cells[i][k];
            let r = Rect {
                x: (x + label_w + k as f64 * (cw + CELL_GAP)).round(),
                y: y + BAND_PAD,
                w: cw,
                h: cell_h,
            };
            let paint = BoxPaint {
                fill: Some((ColourRole::Surface, 1.0)),
                stroke: Some((ColourRole::Grid, 1.0)),
            };
            pen.boxed(r, 5.0, paint, i);
            let text_h = band1
                + if size.sub.count() > 0 {
                    LINE_GAP + lh.block(size.sub.count())
                } else {
                    0.0
                };
            let text_top = r.y + ((cell_h - text_h) / 2.0).round();
            // The first line's band: a key sits on it, level with the
            // name, never on the cell's middle.
            let line_y = text_top + (band1 / 2.0).round();
            if let Some(key) = &cell.key {
                pen.key(r.x + CELL_PAD_X + DISC, line_y, key.n, i, m);
                if let Some(at) = keyed.iter().position(|n| *n == key.n) {
                    pen.hit(r.x, r.y, r.w, r.h, at);
                }
            }
            let tx = r.x + CELL_PAD_X + cell_lead(cell);
            pen.text(
                tx,
                line_y,
                t.shown(cell_role(cell), &cell.name),
                cell_role(cell),
                ColourRole::Ink,
                Anchor::Start,
                Baseline::Middle,
                i,
            );
            for (j, line) in size.sub.lines.iter().enumerate() {
                pen.text(
                    tx,
                    text_top + band1 + LINE_GAP + j as f64 * (lh.value + LINE_GAP),
                    line,
                    TypeRole::Value,
                    ColourRole::InkMuted,
                    Anchor::Start,
                    Baseline::Top,
                    i,
                );
            }
        }

        y += band_h;
        if i + 1 == spec.layers.len() {
            break;
        }
        let Some(cross) = &crosses[i] else {
            y += QUIET_GAP;
            continue;
        };
        cross.draw(&mut pen, &t, &lh, mid, y, i + 1);
        y += cross.gap;
    }

    let width = (right + MARGIN).max(MARGIN + title_w + MARGIN);
    Laid {
        // Nothing in a stack of strata turns, so nothing crosses.
        crossings: 0,
        program: pen.finish(width, y + MARGIN),
        warnings: t.warnings,
    }
}

/// A crossing, measured: its labels, where its arrows stand about the
/// band's centre, the band width it needs, and the gap it takes.
struct Cross {
    /// The label of a crossing both ways.
    both: Lines,
    /// The channel between, cut to one line, and its chip's width.
    via: Option<(String, f64)>,
    down: Lines,
    up: Lines,
    /// How far either arrow of a pair stands from the centre.
    half: f64,
    /// How far a lone arrow's label stands from the centre.
    beside: f64,
    need: f64,
    gap: f64,
}

impl Cross {
    fn measure(t: &mut Texts, c: &Crossing, lh: &LineHeights, path: &str) -> Cross {
        let chip = |n: usize, w: f64, role| Pen::chip_size(n, w, role, lh);
        match c {
            Crossing::Both(s) => {
                let both = t.wrap(TypeRole::Value, s, BELOW_WRAP, path);
                let (cw, ch) = chip(both.count(), both.w, TypeRole::Value);
                Cross {
                    need: cw + 2.0 * BAND_PAD,
                    gap: CROSSING_GAP.max(ch + 2.0 * BAND_PAD),
                    both,
                    via: None,
                    down: Lines::none(),
                    up: Lines::none(),
                    half: 0.0,
                    beside: 0.0,
                }
            }
            Crossing::Ways { via, down, up } => {
                let via = via.as_ref().map(|v| {
                    let w = t.line(TypeRole::Mono, v, &format!("{path}/via"));
                    (v.clone(), chip(1, w, TypeRole::Mono).0)
                });
                let way = |t: &mut Texts, s: &Option<String>, key: &str| {
                    t.wrap_opt(TypeRole::Value, s.as_deref(), WAY_WRAP, &format!("{path}/{key}"))
                };
                let down = way(t, down, "down");
                let up = way(t, up, "up");
                let via_w = via.as_ref().map_or(0.0, |v| v.1);
                let side = down.w.max(up.w);
                let paired = down.count() > 0 && up.count() > 0;
                let half = if !paired {
                    0.0
                } else if via.is_some() {
                    (via_w / 2.0).round() + VIA_SPARE
                } else {
                    PAIR_HALF
                };
                // A lone arrow's label clears the channel's chip on it.
                let beside = if via.is_some() {
                    (via_w / 2.0).round() + 8.0
                } else {
                    ARROW_LABEL
                };
                let reach = if paired {
                    half + ARROW_LABEL + side
                } else if side > 0.0 {
                    beside + side
                } else {
                    via_w / 2.0
                };
                let lines = down.count().max(up.count());
                let via_h = if via.is_some() {
                    lh.mono + 2.0 * CHIP_PAD_Y
                } else {
                    0.0
                };
                Cross {
                    need: 2.0 * reach.ceil() + 2.0 * BAND_PAD,
                    gap: CROSSING_GAP
                        .max(lh.block(lines) + 2.0 * BAND_PAD)
                        .max(via_h + 2.0 * BAND_PAD),
                    both: Lines::none(),
                    via,
                    down,
                    up,
                    half,
                    beside,
                }
            }
        }
    }

    /// Draws the crossing about `mid`, in the gap that starts at `y`.
    fn draw(&self, pen: &mut Pen, t: &Texts, lh: &LineHeights, mid: f64, y: f64, delay: usize) {
        let (a, b) = (y + ARROW_INSET, y + self.gap - ARROW_INSET);
        let cy = (y + self.gap / 2.0).round();
        let arrow = Stroke::arrow(ColourRole::Ink, false);
        let beside = |pen: &mut Pen, lx: f64, lines: &Lines, anchor: Anchor| {
            let top = cy - (lh.block(lines.count()) / 2.0).round();
            for (j, line) in lines.lines.iter().enumerate() {
                pen.text(
                    lx,
                    top + j as f64 * (lh.value + LINE_GAP),
                    line,
                    TypeRole::Value,
                    ColourRole::Ink,
                    anchor,
                    Baseline::Top,
                    delay,
                );
            }
        };
        let (down, up) = (self.down.count() > 0, self.up.count() > 0);
        if self.both.count() > 0 {
            pen.both_ways((mid, a), (mid, b), ColourRole::Ink, delay);
            pen.chip(
                mid,
                cy,
                &self.both.lines,
                self.both.w,
                TypeRole::Value,
                None,
                lh,
                delay,
            );
            return;
        }
        if down && up {
            let (l, r) = (mid - self.half, mid + self.half);
            pen.connector(&[(l, a), (l, b)], arrow, delay);
            pen.connector(&[(r, b), (r, a)], arrow, delay);
            beside(pen, l - ARROW_LABEL, &self.down, Anchor::End);
            beside(pen, r + ARROW_LABEL, &self.up, Anchor::Start);
        } else if down || up {
            let pts = if up { [(mid, b), (mid, a)] } else { [(mid, a), (mid, b)] };
            pen.connector(&pts, arrow, delay);
            let lines = if up { &self.up } else { &self.down };
            beside(pen, mid + self.beside, lines, Anchor::Start);
        } else {
            pen.both_ways((mid, a), (mid, b), ColourRole::Ink, delay);
        }
        if let Some((via, cw)) = &self.via {
            let shown = t.shown(TypeRole::Mono, via).to_string();
            let w = cw - 2.0 * super::pen::CHIP_PAD_X;
            pen.chip(mid, cy, &[shown], w, TypeRole::Mono, None, lh, delay);
        }
    }
}
