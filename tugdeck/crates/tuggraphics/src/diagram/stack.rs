//! `stack`: the architecture block diagram.
//!
//! Layers are ruled on a grid of equal columns, top to bottom, each with
//! its name in the left margin, as on a drawing, and rows of cells inside
//! it; a layer may span part of the grid. What lies outside the system
//! stands in blocks above and beneath, painted in `outside`, and each
//! block reaches the first layer in its way with a two-headed arrow, past
//! any narrower layer to the one behind it. What every layer uses runs
//! down the right side as bars with upright names.
//!
//! A cell's text is centred, so its key sits in the box's top-left
//! corner, and the cell leaves the disc's room on both sides so the text
//! stays centred. The grid column is the narrowest at which every layer
//! and block still fits its span.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::{fit_text, Measure};

use super::pen::{BoxPaint, LineHeights, Pen, Rect, DISC, LINE_GAP, MARGIN};
use super::spec::{Span, Stack, StackBlock};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The gutter between two grid columns.
const GUTTER: f64 = 12.0;
/// The room inside a layer around its cells, and between two cells or rows.
const PAD: f64 = 10.0;
const CELL_GAP: f64 = 8.0;
/// The gap between two layers.
const LAYER_GAP: f64 = 12.0;
/// The gap an outside block's arrow crosses to the stack.
const ARROW: f64 = 34.0;
const ARROW_INSET: f64 = 3.0;
/// How far a key disc sits in from a cell's top-left corner.
const KEY_INSET: f64 = 5.0;
/// The least space between a corner disc and the centred text beside it.
const KEY_CLEAR: f64 = 4.0;
/// The padding inside a cell, either side of its text and above and below.
const CELL_PAD_X: f64 = 12.0;
const CELL_PAD_Y: f64 = 8.0;
/// The padding inside an outside block.
const BLOCK_PAD_X: f64 = 18.0;
const BLOCK_PAD_Y: f64 = 10.0;
/// The narrowest a grid column is.
const UNIT_MIN: f64 = 64.0;
/// How far the layers' names stand off the grid.
const LABEL_GAP: f64 = 14.0;
/// How far the bars that cut across stand off the grid, and the gap
/// between two of them.
const ACROSS_GAP: f64 = 28.0;
const BAR_GAP: f64 = 6.0;
/// The widths secondary text wraps at, unless the name above it is wider.
const SUB_WRAP: f64 = 160.0;
const CELL_SUB_WRAP: f64 = 240.0;

fn count(s: Span) -> f64 {
    (s.1 - s.0 + 1) as f64
}

/// The height of a name and up to two lines under it.
fn head_h(name: f64, sub: &Lines, lh: &LineHeights, gap: f64) -> f64 {
    name + if sub.count() > 0 {
        gap + lh.block(sub.count())
    } else {
        0.0
    }
}

pub(crate) fn layout(spec: &Stack, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
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

    // Sizes: every block, layer head and cell from its text.
    struct Sized {
        w: f64,
        sub: Lines,
    }
    let block = |t: &mut Texts, b: &StackBlock, base: &str| -> Sized {
        let name_w = t.name(TypeRole::Title, &b.name, &format!("{base}/name"));
        let sub = t.wrap_opt(
            TypeRole::Value,
            b.sub.as_deref(),
            name_w.max(SUB_WRAP),
            &format!("{base}/sub"),
        );
        Sized {
            w: name_w.max(sub.w) + 2.0 * BLOCK_PAD_X,
            sub,
        }
    };
    let above: Vec<Sized> = spec
        .above
        .iter()
        .enumerate()
        .map(|(i, b)| block(&mut t, b, &format!("/above/{i}")))
        .collect();
    let below: Vec<Sized> = spec
        .below
        .iter()
        .enumerate()
        .map(|(i, b)| block(&mut t, b, &format!("/below/{i}")))
        .collect();
    let mut heads: Vec<Sized> = Vec::new();
    let mut cells: Vec<Vec<Vec<Sized>>> = Vec::new();
    for (i, layer) in spec.layers.iter().enumerate() {
        let base = format!("/layers/{i}");
        let name_w = t.name(TypeRole::Title, &layer.name, &format!("{base}/name"));
        let sub = t.wrap_opt(
            TypeRole::Value,
            layer.sub.as_deref(),
            name_w.max(SUB_WRAP),
            &format!("{base}/sub"),
        );
        heads.push(Sized {
            w: name_w.max(sub.w),
            sub,
        });
        cells.push(
            layer
                .rows
                .iter()
                .enumerate()
                .map(|(r, row)| {
                    row.iter()
                        .enumerate()
                        .map(|(k, c)| {
                            let cb = format!("{base}/rows/{r}/{k}");
                            let cn = t.name(TypeRole::Label, &c.name, &format!("{cb}/name"));
                            let sub = t.wrap_opt(
                                TypeRole::Value,
                                c.sub.as_deref(),
                                cn.max(CELL_SUB_WRAP),
                                &format!("{cb}/sub"),
                            );
                            // A keyed cell keeps its text centred by leaving
                            // the disc's room on both sides: what it takes
                            // past the cell's own padding to clear it.
                            let disc = if c.key.is_some() {
                                2.0 * (KEY_INSET + DISC * 2.0 + KEY_CLEAR - CELL_PAD_X)
                            } else {
                                0.0
                            };
                            Sized {
                                w: cn.max(sub.w) + 2.0 * CELL_PAD_X + disc,
                                sub,
                            }
                        })
                        .collect()
                })
                .collect(),
        );
    }

    // The grid column: the narrowest every layer and block still fits its
    // span at.
    let mut unit = UNIT_MIN;
    let mut fit = |need: f64, s: Span| {
        let n = count(s);
        unit = unit.max(((need - (n - 1.0) * GUTTER) / n).ceil());
    };
    for (layer, rows) in spec.layers.iter().zip(&cells) {
        for row in rows {
            let widest = row.iter().map(|c| c.w).fold(0.0, f64::max);
            let n = row.len() as f64;
            fit(n * widest + CELL_GAP * (n - 1.0) + 2.0 * PAD, layer.span);
        }
    }
    for (b, s) in spec
        .above
        .iter()
        .zip(&above)
        .chain(spec.below.iter().zip(&below))
    {
        fit(s.w, b.span);
    }

    let label_w = heads.iter().map(|h| h.w).fold(0.0, f64::max);
    let x0 = MARGIN + label_w + LABEL_GAP;
    let span_x = |s: Span| x0 + (s.0 - 1) as f64 * (unit + GUTTER);
    let span_w = |s: Span| count(s) * unit + (count(s) - 1.0) * GUTTER;
    let grid_w = span_w((1, spec.columns));

    // Each row of cells is as tall as its tallest cell.
    let row_h: Vec<Vec<f64>> = cells
        .iter()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let lines = row.iter().map(|c| c.sub.count()).max().unwrap_or(0);
                    2.0 * CELL_PAD_Y
                        + lh.label
                        + if lines > 0 {
                            LINE_GAP + lh.block(lines)
                        } else {
                            0.0
                        }
                })
                .collect()
        })
        .collect();
    let block_h = |sized: &[Sized]| {
        let lines = sized.iter().map(|s| s.sub.count()).max().unwrap_or(0);
        2.0 * BLOCK_PAD_Y
            + lh.title
            + if lines > 0 {
                3.0 + lh.block(lines)
            } else {
                0.0
            }
    };
    let (above_h, below_h) = (block_h(&above), block_h(&below));

    let across_title_h = if spec.across.is_some() {
        lh.label + 8.0
    } else {
        0.0
    };
    let mut y = top
        + if spec.above.is_empty() {
            across_title_h
        } else {
            0.0
        };

    let draw_block = |pen: &mut Pen, b: &StackBlock, s: &Sized, by: f64, bh: f64, delay: usize| {
        let r = Rect {
            x: span_x(b.span),
            y: by,
            w: span_w(b.span),
            h: bh,
        };
        pen.boxed(r, 8.0, BoxPaint::PLAIN, delay);
        let paint = BoxPaint {
            fill: Some((ColourRole::Outside, 0.16)),
            stroke: Some((ColourRole::Outside, 1.0)),
        };
        pen.boxed(r, 8.0, paint, delay);
        let mx = r.x + (r.w / 2.0).round();
        let ty = by + ((bh - head_h(lh.title, &s.sub, &lh, 3.0)) / 2.0).round();
        pen.text(
            mx,
            ty,
            t.shown(TypeRole::Title, &b.name),
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::Middle,
            Baseline::Top,
            delay,
        );
        for (j, line) in s.sub.lines.iter().enumerate() {
            pen.text(
                mx,
                ty + lh.title + 3.0 + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Middle,
                Baseline::Top,
                delay,
            );
        }
    };

    let above_y = y;
    if !spec.above.is_empty() {
        for (b, s) in spec.above.iter().zip(&above) {
            draw_block(&mut pen, b, s, y, above_h, 0);
        }
        y += above_h + ARROW;
    }

    let keyed: Vec<u64> = {
        let mut keys: Vec<u64> = spec
            .layers
            .iter()
            .flat_map(|l| l.rows.iter().flatten())
            .filter_map(|c| c.key.as_ref().map(|k| k.n))
            .collect();
        keys.sort_unstable();
        keys
    };

    // Layers.
    let layer_top = y;
    let mut layer_rects: Vec<Rect> = Vec::new();
    for (i, layer) in spec.layers.iter().enumerate() {
        let delay = i + 1;
        let rows_h: f64 = row_h[i].iter().sum::<f64>() + CELL_GAP * (layer.rows.len() as f64 - 1.0);
        let head = &heads[i];
        let lr = Rect {
            x: span_x(layer.span),
            y,
            w: span_w(layer.span),
            h: (2.0 * PAD + rows_h).max(head_h(lh.title, &head.sub, &lh, 3.0) + 2.0 * PAD),
        };
        pen.boxed(lr, 8.0, BoxPaint::PLAIN, delay);
        layer_rects.push(lr);

        // The layer's name stands outside it, at the left, as on a
        // drawing's margin.
        let ty = y + ((lr.h - head_h(lh.title, &head.sub, &lh, 3.0)) / 2.0).round();
        pen.text(
            x0 - LABEL_GAP,
            ty,
            t.shown(TypeRole::Title, &layer.name),
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::End,
            Baseline::Top,
            delay,
        );
        for (j, line) in head.sub.lines.iter().enumerate() {
            pen.text(
                x0 - LABEL_GAP,
                ty + lh.title + 3.0 + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::End,
                Baseline::Top,
                delay,
            );
        }

        let mut cy = y + ((lr.h - rows_h) / 2.0).round();
        for (r, row) in layer.rows.iter().enumerate() {
            let rh = row_h[i][r];
            let n = row.len() as f64;
            let cw = (lr.w - 2.0 * PAD - CELL_GAP * (n - 1.0)) / n;
            for (k, cell) in row.iter().enumerate() {
                let size = &cells[i][r][k];
                let cr = Rect {
                    x: (lr.x + PAD + k as f64 * (cw + CELL_GAP)).round(),
                    y: cy,
                    w: cw.round(),
                    h: rh,
                };
                let paint = BoxPaint {
                    fill: Some((ColourRole::Surface, 1.0)),
                    stroke: Some((ColourRole::Grid, 1.0)),
                };
                pen.boxed(cr, 6.0, paint, delay);
                // In a centred cell the key belongs to the box: its
                // top-left corner.
                if let Some(key) = &cell.key {
                    pen.key(
                        cr.x + KEY_INSET + DISC,
                        cr.y + KEY_INSET + DISC,
                        key.n,
                        delay,
                        m,
                    );
                    if let Some(at) = keyed.iter().position(|n| *n == key.n) {
                        pen.hit(cr.x, cr.y, cr.w, cr.h, at);
                    }
                }
                let text_top =
                    cr.y + ((rh - head_h(lh.label, &size.sub, &lh, LINE_GAP)) / 2.0).round();
                let mx = cr.x + (cr.w / 2.0).round();
                pen.text(
                    mx,
                    text_top,
                    t.shown(TypeRole::Label, &cell.name),
                    TypeRole::Label,
                    ColourRole::Ink,
                    Anchor::Middle,
                    Baseline::Top,
                    delay,
                );
                for (j, line) in size.sub.lines.iter().enumerate() {
                    pen.text(
                        mx,
                        text_top + lh.label + LINE_GAP + j as f64 * (lh.value + LINE_GAP),
                        line,
                        TypeRole::Value,
                        ColourRole::InkMuted,
                        Anchor::Middle,
                        Baseline::Top,
                        delay,
                    );
                }
            }
            cy += rh + CELL_GAP;
        }
        y += lr.h;
        if i + 1 < spec.layers.len() {
            y += LAYER_GAP;
        }
    }
    let layer_bottom = y;

    let mut below_y = y;
    if !spec.below.is_empty() {
        below_y = y + ARROW;
        for (b, s) in spec.below.iter().zip(&below) {
            draw_block(&mut pen, b, s, below_y, below_h, spec.layers.len() + 1);
        }
        y = below_y + below_h;
    }

    // Each outside block reaches the first layer in its way: past a
    // narrower layer, into the one behind it.
    let n_layers = spec.layers.len();
    let reach = |pen: &mut Pen, b: &StackBlock, from_top: bool, delay: usize| {
        let order: Vec<usize> = if from_top {
            (0..n_layers).collect()
        } else {
            (0..n_layers).rev().collect()
        };
        for i in order {
            let ls = spec.layers[i].span;
            let (lo, hi) = (b.span.0.max(ls.0), b.span.1.min(ls.1));
            if lo > hi {
                continue;
            }
            let ax = (span_x((lo, hi)) + span_w((lo, hi)) / 2.0).round();
            let r = layer_rects[i];
            let (a, z) = if from_top {
                (above_y + above_h + ARROW_INSET, r.y - ARROW_INSET)
            } else {
                (r.y + r.h + ARROW_INSET, below_y - ARROW_INSET)
            };
            pen.both_ways((ax, a), (ax, z), ColourRole::InkMuted, delay);
            return;
        }
    };
    for b in &spec.above {
        reach(&mut pen, b, true, 1);
    }
    for b in &spec.below {
        reach(&mut pen, b, false, n_layers + 1);
    }

    // What cuts across: bars the height of the stack, read bottom to top.
    let mut right = x0 + grid_w;
    if let Some(across) = &spec.across {
        let delay = n_layers + 2;
        let bar = lh.label + 16.0;
        let n = across.names.len() as f64;
        let ax = right + ACROSS_GAP;
        let title_w = t.width(TypeRole::Label, &across.title);
        let aw = (n * bar + (n - 1.0) * BAR_GAP + 2.0 * PAD).max(title_w);
        let stack_h = layer_bottom - layer_top;
        let bar_h = stack_h - 2.0 * PAD;
        pen.text(
            ax + (aw / 2.0).round(),
            layer_top - 8.0,
            &across.title,
            TypeRole::Label,
            ColourRole::Ink,
            Anchor::Middle,
            Baseline::Bottom,
            delay,
        );
        pen.boxed(
            Rect {
                x: ax,
                y: layer_top,
                w: aw,
                h: stack_h,
            },
            8.0,
            BoxPaint::PLAIN,
            delay,
        );
        let bars_w = n * bar + (n - 1.0) * BAR_GAP;
        let bx0 = ax + ((aw - bars_w) / 2.0).round();
        for (k, name) in across.names.iter().enumerate() {
            let path = format!("/across/names/{k}");
            // A name longer than its bar is cut to it. The bar's height
            // follows from the first request alone, so the cut's candidates
            // are the second.
            let w = t.width(TypeRole::Label, name);
            let room = bar_h - 2.0 * CELL_PAD_X;
            let shown = if w > room {
                t.warnings.push(super::spec::err(
                    &path,
                    format!(
                        "this name is {w} px long and runs upright in a bar {bar_h} px tall, so it is cut short: shorten it, or give the stack more layers"
                    ),
                ));
                fit_text(name, TypeRole::Label, room, m).text
            } else {
                name.clone()
            };
            let bx = bx0 + k as f64 * (bar + BAR_GAP);
            let paint = BoxPaint {
                fill: Some((ColourRole::Surface, 1.0)),
                stroke: Some((ColourRole::Grid, 1.0)),
            };
            pen.boxed(
                Rect {
                    x: bx,
                    y: layer_top + PAD,
                    w: bar,
                    h: bar_h,
                },
                6.0,
                paint,
                delay,
            );
            pen.upright(
                bx + (bar / 2.0).round(),
                ((layer_top + layer_bottom) / 2.0).round(),
                &shown,
                TypeRole::Label,
                delay,
            );
        }
        right = ax + aw;
    }

    let width = (right + MARGIN).max(MARGIN + title_w + MARGIN);
    Laid {
        // Nothing in a stack turns, so nothing crosses.
        crossings: 0,
        program: pen.finish(width, y + MARGIN),
        warnings: t.warnings,
    }
}
