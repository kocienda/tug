//! `tree`: what is inside what.
//!
//! The root stands at the left and each level of depth is a column to its
//! right, so every name stays horizontal and depth costs width once per
//! level. Every node in a column is the column's width, and a parent is
//! centred on its children. The lines joining a parent to its children
//! turn in one lane per level, midway between the two columns, so they
//! never cross; they have no heads and are drawn lighter and muted, since
//! containment has no direction to read. A node with children wears the
//! full outline and a leaf a fainter one, so the structure reads before
//! the names do; a toned node wears its tone's wash and outline.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    crossings, BoxPaint, LineHeights, Pen, Pt, Rect, Stroke, DISC, KEY_LEAD, LINE_GAP, MARGIN,
};
use super::spec::{Tree, TreeNode};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The gap between two columns, whose middle is the lane the joining
/// lines turn in, and the gap between two siblings.
const H_GAP: f64 = 44.0;
const V_GAP: f64 = 8.0;
/// The padding inside a node, either side of its text and above and below
/// it, and the radius its corners turn on.
const PAD_X: f64 = 12.0;
const PAD_Y: f64 = 7.0;
const RADIUS: f64 = 6.0;
/// The width a node's sub-label wraps at, unless its name is wider.
const SUB_WRAP: f64 = 160.0;
/// A node's outline: full with children, fainter as a leaf.
const PARENT_OUTLINE: f64 = 0.9;
const LEAF_OUTLINE: f64 = 0.4;
/// A toned node's wash.
const WASH: f64 = 0.14;
/// How far past the lane a toned child's stub starts: past the turn's
/// radius, so the trunk its siblings share stays muted.
const STUB_TURN: f64 = 8.0;

fn role(n: &TreeNode, depth: usize) -> TypeRole {
    if n.mono {
        TypeRole::Mono
    } else if depth == 0 {
        TypeRole::Title
    } else {
        TypeRole::Label
    }
}

/// One node, flattened: where it stands in the tree and what it measures.
struct Flat<'a> {
    node: &'a TreeNode,
    depth: usize,
    path: String,
    children: Vec<usize>,
    name_w: f64,
    sub: Lines,
    band: f64,
    w: f64,
    h: f64,
}

/// Every node in pre-order, parents before their children.
fn flatten<'a>(n: &'a TreeNode, depth: usize, path: String, out: &mut Vec<Flat<'a>>) -> usize {
    let at = out.len();
    out.push(Flat {
        node: n,
        depth,
        path: path.clone(),
        children: Vec::new(),
        name_w: 0.0,
        sub: Lines::none(),
        band: 0.0,
        w: 0.0,
        h: 0.0,
    });
    for (i, c) in n.children.iter().enumerate() {
        let child = flatten(c, depth + 1, format!("{path}/children/{i}"), out);
        out[at].children.push(child);
    }
    at
}

pub(crate) fn layout(spec: &Tree, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
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

    let mut nodes: Vec<Flat> = Vec::new();
    flatten(&spec.root, 0, "/root".into(), &mut nodes);

    // Sizes, and each column as wide as its widest node.
    let mut col_w: Vec<f64> = Vec::new();
    for f in nodes.iter_mut() {
        let r = role(f.node, f.depth);
        f.name_w = t.name(r, &f.node.name, &format!("{}/name", f.path));
        f.sub = t.wrap_opt(
            TypeRole::Value,
            f.node.sub.as_deref(),
            f.name_w.max(SUB_WRAP),
            &format!("{}/sub", f.path),
        );
        let lead = if f.node.key.is_some() { KEY_LEAD } else { 0.0 };
        f.band = lh.of(r).max(DISC * 2.0);
        f.w = (lead + f.name_w.max(f.sub.w) + 2.0 * PAD_X).ceil();
        f.h = 2.0 * PAD_Y
            + f.band
            + if f.sub.count() > 0 {
                LINE_GAP + lh.block(f.sub.count())
            } else {
                0.0
            };
        if col_w.len() <= f.depth {
            col_w.resize(f.depth + 1, 0.0);
        }
        col_w[f.depth] = col_w[f.depth].max(f.w);
    }
    let mut col_x = vec![MARGIN];
    for d in 1..col_w.len() {
        col_x.push(col_x[d - 1] + col_w[d - 1] + H_GAP);
    }

    // How tall each node's place is: its own height, or its children's
    // with the gaps between them. Children follow their parent, so the
    // last node is measured first.
    let n = nodes.len();
    let mut kids_h = vec![0.0; n];
    let mut extent = vec![0.0; n];
    for i in (0..n).rev() {
        let kids = &nodes[i].children;
        kids_h[i] = kids.iter().map(|&c| extent[c]).sum::<f64>()
            + V_GAP * kids.len().saturating_sub(1) as f64;
        extent[i] = nodes[i].h.max(kids_h[i]);
    }

    // Each node's place, parents first: the run of rows it and all beneath
    // it take.
    let mut place_top = vec![0.0; n];
    place_top[0] = top;
    for i in 0..n {
        let f = &nodes[i];
        let mut ky = place_top[i] + (extent[i] - kids_h[i]) / 2.0;
        for &c in &f.children {
            place_top[c] = ky;
            ky += extent[c] + V_GAP;
        }
    }
    // Then each node in its place, children first: a leaf centred in its
    // place, a parent centred on the middles of its first and last child.
    let mut rects = vec![Rect::default(); n];
    for i in (0..n).rev() {
        let f = &nodes[i];
        let y = match (f.children.first(), f.children.last()) {
            (Some(&a), Some(&b)) => {
                let centre = (rects[a].mid_y() + rects[b].mid_y()) / 2.0;
                (centre - f.h / 2.0).clamp(place_top[i], place_top[i] + extent[i] - f.h)
            }
            _ => place_top[i] + (extent[i] - f.h) / 2.0,
        };
        rects[i] = Rect {
            x: col_x[f.depth],
            y: y.round(),
            w: col_w[f.depth],
            h: f.h,
        };
    }

    // The joining lines, under the nodes.
    let mut paths: Vec<Vec<Pt>> = Vec::new();
    for (i, f) in nodes.iter().enumerate() {
        let p = rects[i];
        let (x0, mid) = (p.x + p.w, p.mid_y());
        let lane = (x0 + H_GAP / 2.0).round();
        for &c in &f.children {
            let r = rects[c];
            let cmid = r.mid_y();
            let pts: Vec<Pt> = if cmid == mid {
                vec![(x0, mid), (r.x, cmid)]
            } else {
                vec![(x0, mid), (lane, mid), (lane, cmid), (r.x, cmid)]
            };
            pen.connector(&pts, Stroke::bare(), f.depth + 1);
            // A toned child's tone is its own: it colours the stub into
            // it, past the turn, never the trunk its siblings share.
            if let Some(tone) = nodes[c].node.tone {
                let stroke = Stroke {
                    colour: tone.colour(),
                    ..Stroke::bare()
                };
                pen.connector(
                    &[(lane + STUB_TURN, cmid), (r.x, cmid)],
                    stroke,
                    f.depth + 1,
                );
            }
            paths.push(pts);
        }
    }

    // The nodes.
    let mut keys: Vec<u64> = nodes
        .iter()
        .filter_map(|f| f.node.key.as_ref().map(|k| k.n))
        .collect();
    keys.sort_unstable();
    for (i, f) in nodes.iter().enumerate() {
        let r = rects[i];
        let delay = f.depth;
        let outline = if f.children.is_empty() {
            LEAF_OUTLINE
        } else {
            PARENT_OUTLINE
        };
        let paint = match f.node.tone {
            None => BoxPaint {
                fill: Some((ColourRole::Surface, 1.0)),
                stroke: Some((ColourRole::InkMuted, outline)),
            },
            Some(tone) => BoxPaint {
                fill: Some((ColourRole::Surface, 1.0)),
                stroke: Some((tone.colour(), outline)),
            },
        };
        pen.boxed(r, RADIUS, paint, delay);
        if let Some(tone) = f.node.tone {
            let wash = BoxPaint {
                fill: Some((tone.colour(), WASH)),
                stroke: None,
            };
            pen.boxed(r, RADIUS, wash, delay);
        }
        let r_role = role(f.node, f.depth);
        let line_y = r.y + PAD_Y + (f.band / 2.0).round();
        if let Some(key) = &f.node.key {
            pen.key(r.x + PAD_X + DISC, line_y, key.n, delay, m);
            if let Some(at) = keys.iter().position(|n| *n == key.n) {
                pen.hit(r.x, r.y, r.w, r.h, at);
            }
        }
        let tx = r.x + PAD_X + if f.node.key.is_some() { KEY_LEAD } else { 0.0 };
        pen.text(
            tx,
            line_y,
            t.shown(r_role, &f.node.name),
            r_role,
            ColourRole::Ink,
            Anchor::Start,
            Baseline::Middle,
            delay,
        );
        for (j, line) in f.sub.lines.iter().enumerate() {
            pen.text(
                tx,
                r.y + PAD_Y + f.band + LINE_GAP + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                Baseline::Top,
                delay,
            );
        }
    }

    let last = col_w.len() - 1;
    let width = (col_x[last] + col_w[last] + MARGIN).max(MARGIN + title_w + MARGIN);
    Laid {
        crossings: crossings(&paths),
        program: pen.finish(width, top + extent[0] + MARGIN),
        warnings: t.warnings,
    }
}
