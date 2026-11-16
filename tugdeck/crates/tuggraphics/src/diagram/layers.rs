//! `layers`: full-width strata top to bottom, and what crosses each
//! boundary.
//!
//! Each layer is a band with its name in a label column at the left and
//! its cells in a row across the rest, every cell of a layer the same
//! width and every cell of the figure the same height, so the strata read
//! as one stack. Between two layers whose upper one says what crosses to
//! the lower, an arrow with a head at each end runs down the middle with
//! the crossing's label beside it, wrapped to two lines at most.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{BoxPaint, LineHeights, Pen, Rect, DISC, KEY_LEAD, LINE_GAP, MARGIN};
use super::spec::{LayerCell, Layers};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The room inside a band around its cells, and between two cells.
const BAND_PAD: f64 = 10.0;
const CELL_GAP: f64 = 8.0;
/// The padding inside a cell, either side of its text and above and below.
const CELL_PAD_X: f64 = 12.0;
const CELL_PAD_Y: f64 = 8.0;
/// Where a layer's name starts inside its band, and the room the label
/// column keeps past the widest name.
const LABEL_INSET: f64 = 14.0;
const LABEL_SPARE: f64 = 28.0;
/// The gap between two layers with nothing said to cross it, and the
/// least gap one with a crossing takes.
const QUIET_GAP: f64 = 12.0;
const CROSSING_GAP: f64 = 34.0;
/// How far a crossing's arrow stops short of the bands it joins, and how
/// far right of it its label starts.
const ARROW_INSET: f64 = 3.0;
const ARROW_LABEL: f64 = 10.0;
/// The widths secondary text wraps at, unless the name above it is wider.
const SUB_WRAP: f64 = 160.0;
const CELL_SUB_WRAP: f64 = 140.0;
/// A crossing's label has the figure's width beside it.
const BELOW_WRAP: f64 = 240.0;

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
    let mut belows: Vec<Lines> = Vec::new();
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
        belows.push(t.wrap_opt(
            TypeRole::Value,
            layer.below.as_deref(),
            BELOW_WRAP,
            &format!("{base}/below"),
        ));
    }

    let label_w = heads.iter().map(|h| h.w).fold(0.0, f64::max) + LABEL_SPARE;
    let inner = cells
        .iter()
        .map(|row| {
            let widest = row.iter().map(|c| c.w).fold(0.0, f64::max);
            row.len() as f64 * widest + CELL_GAP * (row.len() as f64 - 1.0)
        })
        .fold(0.0, f64::max);
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
    let mut right = MARGIN + band_w;
    for (i, layer) in spec.layers.iter().enumerate() {
        let band = Rect {
            x,
            y,
            w: band_w,
            h: band_h,
        };
        pen.boxed(band, 8.0, BoxPaint::PLAIN, i);
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
        let below = &belows[i];
        if below.count() == 0 {
            y += QUIET_GAP;
            continue;
        }
        let gap = CROSSING_GAP.max(lh.block(below.count()) + 2.0 * BAND_PAD);
        let ax = (x + label_w + inner / 2.0).round();
        pen.both_ways(
            (ax, y + ARROW_INSET),
            (ax, y + gap - ARROW_INSET),
            ColourRole::InkMuted,
            i + 1,
        );
        let block = lh.block(below.count());
        let ly = y + ((gap - block) / 2.0).round();
        for (j, line) in below.lines.iter().enumerate() {
            pen.text(
                ax + ARROW_LABEL,
                ly + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                Baseline::Top,
                i + 1,
            );
        }
        right = right.max(ax + ARROW_LABEL + below.w);
        y += gap;
    }

    let width = (right + MARGIN).max(MARGIN + title_w + MARGIN);
    Laid {
        // Nothing in a stack of strata turns, so nothing crosses.
        crossings: 0,
        program: pen.finish(width, y + MARGIN),
        warnings: t.warnings,
    }
}
