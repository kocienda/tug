//! `sequence`: actors across the top, messages down the page in the order
//! they happen.
//!
//! Each actor is a box with a dashed lifeline under it. A message is an
//! arrow between two lifelines with its label on the line above, knocked
//! out of any lifeline it crosses; an answer coming back is dashed and
//! muted, and a step an actor takes alone is a short loop off its own
//! lifeline. A label stays on one line, because the rows' even height is
//! the figure's rhythm, and a key sits in the left margin on the label's
//! line rather than the arrow's. The gaps between lifelines are sized from
//! the labels that must fit in them, so every coordinate follows from the
//! text.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{BoxPaint, LineHeights, Pen, Rect, DISC, LINE_GAP, MARGIN};
use super::spec::{Message, Sequence, Tone};
use super::wrap::{Lines, Texts};
use super::Laid;

/// The padding inside an actor's box, above and below its text and either
/// side of it.
const ACTOR_PAD_Y: f64 = 9.0;
const ACTOR_PAD_X: f64 = 12.0;
/// The narrowest an actor's box is.
const ACTOR_MIN_W: f64 = 88.0;
/// The narrowest gap between two lifelines, and the room past the two
/// half-boxes it always keeps.
const GAP_MIN: f64 = 104.0;
const GAP_SPARE: f64 = 24.0;
/// The room a label leaves either side of it between the two lifelines it
/// spans, and the room a self-loop's label needs past its lifeline.
const LABEL_SPARE: f64 = 40.0;
const SELF_SPARE: f64 = 52.0;
/// A self-loop: how far it reaches right of its lifeline, half its height,
/// and where its label starts.
const LOOP_W: f64 = 20.0;
const LOOP_HALF: f64 = 7.0;
const LOOP_LABEL: f64 = 28.0;
/// The room past a row's text that makes a message's row.
const ROW_SPARE: f64 = 24.0;
/// How far the last lifeline runs past the last message.
const LIFELINE_TAIL: f64 = 18.0;
const LIFELINE_DASH: [f64; 2] = [3.0, 4.0];
/// The room a key takes in the left margin.
const KEY_GUTTER: f64 = DISC * 2.0 + 12.0;
/// The width an actor's sub-label wraps at, unless its name is wider.
const SUB_WRAP: f64 = 160.0;

fn colour(m: &Message) -> ColourRole {
    match (m.tone, m.reply) {
        (Some(t), _) => t.colour(),
        (None, true) => ColourRole::InkMuted,
        (None, false) => ColourRole::Ink,
    }
}

pub(crate) fn layout(seq: &Sequence, title: Option<&str>, animate: bool, m: &dyn Measure) -> Laid {
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

    // Sizes: every actor from its text, every label on its one line.
    let subs: Vec<Lines> = seq
        .actors
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let name_w = t.name(TypeRole::Title, &a.name, &format!("/actors/{i}/name"));
            t.wrap_opt(
                TypeRole::Value,
                a.sub.as_deref(),
                name_w.max(SUB_WRAP),
                &format!("/actors/{i}/sub"),
            )
        })
        .collect();
    let actor_w: Vec<f64> = seq
        .actors
        .iter()
        .zip(&subs)
        .map(|(a, sub)| {
            let name_w = t.width(TypeRole::Title, &a.name);
            ACTOR_MIN_W.max(name_w.max(sub.w) + 2.0 * ACTOR_PAD_X)
        })
        .collect();
    let sub_lines = subs.iter().map(Lines::count).max().unwrap_or(0);
    let actor_h = 2.0 * ACTOR_PAD_Y
        + lh.title
        + if sub_lines > 0 {
            3.0 + lh.block(sub_lines)
        } else {
            0.0
        };
    let label_w: Vec<f64> = seq
        .messages
        .iter()
        .enumerate()
        .map(|(k, msg)| t.line(TypeRole::Value, &msg.label, &format!("/messages/{k}/label")))
        .collect();

    // The gaps between neighbouring lifelines, wide enough for every label
    // that must sit in them.
    let n = seq.actors.len();
    let mut gap: Vec<f64> = (0..n.saturating_sub(1))
        .map(|i| GAP_MIN.max(((actor_w[i] + actor_w[i + 1]) / 2.0).round() + GAP_SPARE))
        .collect();
    let mut tail = (actor_w[n - 1] / 2.0).round();
    for (msg, &need) in seq.messages.iter().zip(&label_w) {
        let (a, b) = (msg.from, msg.to);
        if a == b {
            if a == n - 1 {
                tail = tail.max(need + LABEL_SPARE);
            } else {
                gap[a] = gap[a].max(need + SELF_SPARE);
            }
            continue;
        }
        let (lo, hi) = (a.min(b), a.max(b));
        let have: f64 = gap[lo..hi].iter().sum();
        if have < need + LABEL_SPARE {
            gap[hi - 1] += need + LABEL_SPARE - have;
        }
    }
    let gutter = if seq.messages.iter().any(|m| m.key.is_some()) {
        KEY_GUTTER
    } else {
        0.0
    };
    let mut cx = vec![MARGIN + gutter + (actor_w[0] / 2.0).round()];
    for g in &gap {
        cx.push(cx[cx.len() - 1] + g);
    }
    let width = (cx[n - 1] + tail + MARGIN).max(MARGIN + title_w + MARGIN);

    let row = lh.value + ROW_SPARE;
    let first = top + actor_h + row;
    let y = |k: usize| first + k as f64 * row;
    let end = y(seq.messages.len() - 1) + LIFELINE_TAIL;

    // Lifelines under everything, then the actors over their tops.
    for &x in &cx {
        pen.rule(
            (x, top + actor_h),
            (x, end),
            ColourRole::Grid,
            &LIFELINE_DASH,
            0,
        );
    }
    for (i, a) in seq.actors.iter().enumerate() {
        let r = Rect {
            x: cx[i] - (actor_w[i] / 2.0).round(),
            y: top,
            w: actor_w[i],
            h: actor_h,
        };
        pen.boxed(r, 8.0, BoxPaint::PLAIN, 0);
        pen.text(
            cx[i],
            top + ACTOR_PAD_Y,
            &a.name,
            TypeRole::Title,
            ColourRole::Ink,
            Anchor::Middle,
            Baseline::Top,
            0,
        );
        for (j, line) in subs[i].lines.iter().enumerate() {
            pen.text(
                cx[i],
                top + ACTOR_PAD_Y + lh.title + 3.0 + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Middle,
                Baseline::Top,
                0,
            );
        }
    }

    // Messages, one row each, in the order they happen.
    let keyed: Vec<u64> = {
        let mut keys: Vec<u64> = seq
            .messages
            .iter()
            .filter_map(|m| m.key.as_ref().map(|k| k.n))
            .collect();
        keys.sort_unstable();
        keys
    };
    for (k, msg) in seq.messages.iter().enumerate() {
        let (a, b) = (msg.from, msg.to);
        let yy = y(k);
        let delay = 1 + k;
        let colour = colour(msg);
        let lw = label_w[k];
        // The label's own line: a key sits level with what it numbers, not
        // with the arrow under it.
        let label_y = if a == b {
            yy
        } else {
            yy - 5.0 - (lh.value / 2.0).round()
        };
        if let Some(key) = &msg.key {
            pen.key(MARGIN + DISC, label_y, key.n, delay, m);
            if let Some(at) = keyed.iter().position(|n| *n == key.n) {
                let row_top = (label_y - lh.value / 2.0).min(yy - LOOP_HALF) - 4.0;
                let row_bottom = yy + LOOP_HALF + 4.0;
                pen.hit(
                    MARGIN,
                    row_top,
                    width - 2.0 * MARGIN,
                    row_bottom - row_top,
                    at,
                );
            }
        }
        if a == b {
            // A step the actor takes alone: a short loop off its lifeline.
            let x0 = cx[a];
            let pts = [
                (x0, yy - LOOP_HALF),
                (x0 + LOOP_W, yy - LOOP_HALF),
                (x0 + LOOP_W, yy + LOOP_HALF),
                (x0, yy + LOOP_HALF),
            ];
            pen.edge(&pts, colour, msg.reply, delay);
            let fill = if msg.tone.is_none() {
                ColourRole::Ink
            } else {
                colour
            };
            pen.text(
                x0 + LOOP_LABEL,
                yy,
                &msg.label,
                TypeRole::Value,
                fill,
                Anchor::Start,
                Baseline::Middle,
                delay,
            );
            continue;
        }
        let mx = ((cx[a] + cx[b]) / 2.0).round();
        // A label over a lifeline it crosses is knocked out of it.
        let knock = Rect {
            x: mx - (lw / 2.0).round() - 3.0,
            y: yy - 6.0 - lh.value,
            w: lw + 6.0,
            h: lh.value + 2.0,
        };
        let paint = BoxPaint {
            fill: Some((ColourRole::Surface, 1.0)),
            stroke: None,
        };
        pen.boxed(knock, 0.0, paint, delay);
        let fill = match (msg.reply, msg.tone) {
            (true, _) => ColourRole::InkMuted,
            (false, None) => ColourRole::Ink,
            (false, Some(t)) => Tone::colour(t),
        };
        pen.text(
            mx,
            label_y,
            &msg.label,
            TypeRole::Value,
            fill,
            Anchor::Middle,
            Baseline::Middle,
            delay,
        );
        pen.edge(&[(cx[a], yy), (cx[b], yy)], colour, msg.reply, delay);
    }

    Laid {
        // Messages run straight across and lifelines straight down; the
        // one can only meet the other, never cross another message.
        crossings: 0,
        program: pen.finish(width, end + MARGIN),
        errors: t.errors,
    }
}
