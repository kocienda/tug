//! `sequence`: actors across the top, messages down the page in the order
//! they happen.
//!
//! Each actor is a box with a dashed lifeline under it, and its name is
//! said again where the line ends, so the last message is never read
//! against a bare line. A message is an arrow between two lifelines with
//! its label above it, knocked out of any lifeline it crosses. Where a
//! message starts is marked on the sender's lifeline: by its key's disc
//! when it has one, and by a small dot when it is an unkeyed call. A call
//! is solid with a filled head; an answer coming back is dashed, lighter,
//! ends in an open head, and sits closer under the message before it than
//! a new call does, so an exchange reads as one. An actor that has been
//! called and not yet answered carries a narrow bar on its lifeline, from
//! the call to the reply it sends for it, derived from the messages alone.
//! A step an actor takes alone is a short loop off its own lifeline.
//!
//! A `phases` list names runs of messages: each is a faint band behind its
//! run, with its label and note in a gutter at the left. The gaps between
//! lifelines are sized from the labels that must fit in them, so every
//! coordinate follows from the text.

use crate::draw::{Anchor, Baseline, ColourRole, TypeRole};
use crate::measure::Measure;

use super::pen::{
    BoxPaint, Head, LineHeights, Pen, Rect, Stroke, DISC, LINE_GAP, MARGIN, ORIGIN_DOT,
};
use super::spec::{Message, Sequence, Tone};
use super::wrap::{Lines, Texts, NAME_MAX_W};
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
/// The room a label leaves between the two lifelines it spans: the disc at
/// one end, the head at the other, and air either side.
const LABEL_SPARE: f64 = 56.0;
/// A self-loop: how far it reaches right of its lifeline, how far down it
/// comes back, where its label starts, and the room its label needs before
/// the next lifeline.
const LOOP_W: f64 = 34.0;
const LOOP_H: f64 = 22.0;
const LOOP_LABEL: f64 = 46.0;
const SELF_SPARE: f64 = LOOP_LABEL + 16.0;
/// How far above its arrow a message's label sits.
const LABEL_LIFT: f64 = 7.0;
/// The steps between rows, past a label's height: a new call takes the
/// full step and a reply the short one, so a reply sits close under the
/// message before it. A row after a self-loop takes the loop's extra
/// depth, and a row that opens a phase or follows one takes more.
const CALL_SPARE: f64 = 30.0;
const REPLY_SPARE: f64 = 18.0;
const AFTER_LOOP: f64 = 12.0;
const PHASE_LEAD: f64 = 18.0;
/// Half the width of an activation bar, and how far it runs past the call
/// and reply it spans.
const BAR: f64 = 5.0;
const BAR_PAST: f64 = 5.0;
/// How far a lifeline runs past the last message, and where it stops short
/// of the actor's name repeated at its foot.
const FOOT: f64 = 30.0;
const FOOT_GAP: f64 = 6.0;
const LIFELINE_DASH: [f64; 2] = [3.0, 4.0];
const LIFELINE_OPACITY: f64 = 0.7;
/// The width an actor's sub-label wraps at, unless its name is wider.
const SUB_WRAP: f64 = 160.0;
/// A reply's stroke, lighter than a call's.
const REPLY_WIDTH: f64 = 1.5;
/// A phase: the width its note wraps at in the gutter, the gutter's room
/// past its widest text, the band's reach above its first arrow and below
/// its last, its text's inset, and how much ink the band takes.
const PHASE_WRAP: f64 = 118.0;
const GUTTER_SPARE: f64 = 26.0;
const BAND_BELOW: f64 = 14.0;
const BAND_ABOVE: f64 = 14.0;
const BAND_INSET: f64 = 10.0;
const BAND_TEXT_TOP: f64 = 9.0;
const BAND_REACH: f64 = 8.0;
const BAND_OPACITY: f64 = 0.07;

fn colour(m: &Message) -> ColourRole {
    m.tone.map_or(ColourRole::Ink, Tone::colour)
}

/// A call is a solid connector with a filled head; a reply is dashed,
/// lighter, and ends in an open head, so the two read apart at a glance.
fn stroke(m: &Message) -> Stroke {
    if m.reply {
        Stroke {
            colour: colour(m),
            width: REPLY_WIDTH,
            dashed: true,
            head: Head::Open,
        }
    } else {
        Stroke::arrow(colour(m), false)
    }
}

/// An actor busy from a call it receives to the reply it sends for it.
struct Busy {
    actor: usize,
    from: usize,
    to: usize,
}

/// Every call answered by a later reply from the actor it reached back to
/// the actor that sent it.
fn activations(seq: &Sequence) -> Vec<Busy> {
    let mut out = Vec::new();
    for (i, m) in seq.messages.iter().enumerate() {
        if m.reply || m.from == m.to {
            continue;
        }
        let answer = seq
            .messages
            .iter()
            .enumerate()
            .skip(i + 1)
            .find(|(_, r)| r.reply && r.from == m.to && r.to == m.from);
        if let Some((j, _)) = answer {
            out.push(Busy {
                actor: m.to,
                from: i,
                to: j,
            });
        }
    }
    out
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
            let name_w = t.width(TypeRole::Title, &a.name).min(NAME_MAX_W);
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

    // The phases' gutter, as wide as the widest text in it.
    let phase_text: Vec<(f64, Lines)> = seq
        .phases
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let w = t.line(TypeRole::Label, &p.label, &format!("/phases/{i}/label"));
            let note = t.wrap_opt(
                TypeRole::Value,
                p.note.as_deref(),
                PHASE_WRAP,
                &format!("/phases/{i}/note"),
            );
            (w, note)
        })
        .collect();
    let gutter = phase_text
        .iter()
        .map(|(w, note)| w.max(note.w))
        .fold(None, |acc: Option<f64>, w| Some(acc.map_or(w, |a| a.max(w))))
        .map_or(0.0, |w| (w + GUTTER_SPARE).ceil());

    // The gaps between neighbouring lifelines, wide enough for every label
    // that must sit in them.
    let n = seq.actors.len();
    let mut gap: Vec<f64> = (0..n.saturating_sub(1))
        .map(|i| GAP_MIN.max(((actor_w[i] + actor_w[i + 1]) / 2.0).round() + GAP_SPARE))
        .collect();
    for (msg, &need) in seq.messages.iter().zip(&label_w) {
        let (a, b) = (msg.from, msg.to);
        if a == b {
            if a < n - 1 {
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
    let mut cx = vec![MARGIN + gutter + (actor_w[0] / 2.0).round()];
    for g in &gap {
        cx.push(cx[cx.len() - 1] + g);
    }
    let mut right = cx[n - 1] + (actor_w[n - 1] / 2.0).round();
    for (msg, &need) in seq.messages.iter().zip(&label_w) {
        if msg.from == msg.to {
            right = right.max(cx[msg.from] + LOOP_LABEL + need);
        }
    }
    let right = right.ceil();
    let band_right = right + BAND_REACH;
    let width = (band_right + MARGIN).max(MARGIN + title_w + MARGIN);

    // Rows: a reply sits close under the message before it, a new call
    // takes a full step, and a phase opens with more.
    let call_step = lh.value + CALL_SPARE;
    let reply_step = lh.value + REPLY_SPARE;
    let is_loop = |k: usize| seq.messages[k].from == seq.messages[k].to;
    let mut ys: Vec<f64> = Vec::with_capacity(seq.messages.len());
    let mut y = top + actor_h + call_step;
    for (k, msg) in seq.messages.iter().enumerate() {
        if k > 0 {
            y += if msg.reply { reply_step } else { call_step };
            if is_loop(k - 1) {
                y += AFTER_LOOP;
            }
            if seq.phases.iter().any(|p| p.from == k || p.to + 1 == k) {
                y += PHASE_LEAD;
            }
        }
        ys.push(y);
    }
    // A band is at least as tall as the text in its gutter; one that is
    // not pushes everything after it down.
    let mut bands: Vec<(f64, f64)> = Vec::with_capacity(seq.phases.len());
    for (p, (_, note)) in seq.phases.iter().zip(&phase_text) {
        let y0 = ys[p.from] - lh.value - LABEL_LIFT - BAND_ABOVE;
        let mut y1 = ys[p.to] + if is_loop(p.to) { LOOP_H + BAND_BELOW } else { BAND_BELOW };
        let text = BAND_TEXT_TOP
            + lh.label
            + if note.count() > 0 {
                3.0 + lh.block(note.count())
            } else {
                0.0
            }
            + BAND_TEXT_TOP;
        let short = y0 + text - y1;
        if short > 0.0 {
            y1 += short;
            for later in ys.iter_mut().skip(p.to + 1) {
                *later += short;
            }
        }
        bands.push((y0, y1));
    }
    let last = seq.messages.len() - 1;
    let mut foot = ys[last] + if is_loop(last) { LOOP_H } else { 0.0 } + FOOT;
    if let Some(&(_, y1)) = bands.last() {
        foot = foot.max(y1 + FOOT_GAP + BAND_BELOW);
    }

    // Phases first: they are the ground the exchange is drawn on.
    for ((p, &(y0, y1)), (_, note)) in seq.phases.iter().zip(&bands).zip(&phase_text) {
        let delay = 1 + p.from;
        let paint = BoxPaint {
            fill: Some((ColourRole::InkMuted, BAND_OPACITY)),
            stroke: None,
        };
        let band = Rect {
            x: MARGIN,
            y: y0,
            w: band_right - MARGIN,
            h: y1 - y0,
        };
        pen.boxed(band, 6.0, paint, delay);
        pen.text(
            MARGIN + BAND_INSET,
            y0 + BAND_TEXT_TOP,
            t.shown(TypeRole::Label, &p.label),
            TypeRole::Label,
            ColourRole::Ink,
            Anchor::Start,
            Baseline::Top,
            delay,
        );
        for (j, line) in note.lines.iter().enumerate() {
            pen.text(
                MARGIN + BAND_INSET,
                y0 + BAND_TEXT_TOP + lh.label + 3.0 + j as f64 * (lh.value + LINE_GAP),
                line,
                TypeRole::Value,
                ColourRole::InkMuted,
                Anchor::Start,
                Baseline::Top,
                delay,
            );
        }
    }

    // Lifelines, the actors over their tops, and each name again at the
    // foot.
    for (i, a) in seq.actors.iter().enumerate() {
        pen.rule(
            (cx[i], top + actor_h),
            (cx[i], foot - FOOT_GAP),
            ColourRole::InkMuted,
            &LIFELINE_DASH,
            LIFELINE_OPACITY,
            0,
        );
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
            t.shown(TypeRole::Title, &a.name),
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
        pen.text(
            cx[i],
            foot,
            t.shown(TypeRole::Value, &a.name),
            TypeRole::Value,
            ColourRole::InkMuted,
            Anchor::Middle,
            Baseline::Top,
            seq.messages.len(),
        );
    }

    // An actor is busy from a call it receives to the reply it sends.
    let busy = activations(seq);
    for b in &busy {
        let r = Rect {
            x: cx[b.actor] - BAR,
            y: ys[b.from] - BAR_PAST,
            w: 2.0 * BAR,
            h: ys[b.to] - ys[b.from] + 2.0 * BAR_PAST,
        };
        pen.boxed(r, 3.0, BoxPaint::PLAIN, 1 + b.from);
    }
    let bar_at = |actor: usize, k: usize| {
        busy
            .iter()
            .any(|b| b.actor == actor && b.from <= k && b.to >= k)
    };

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
        let yy = ys[k];
        let delay = 1 + k;
        let colour = colour(msg);
        let lw = label_w[k];
        // Where the message leaves its sender: past the disc that numbers
        // it, or the bar it leaves from.
        let lead = if msg.key.is_some() {
            DISC
        } else if bar_at(a, k) {
            BAR
        } else {
            0.0
        };
        if let Some(key) = &msg.key {
            if let Some(at) = keyed.iter().position(|n| *n == key.n) {
                let row_top = yy - LABEL_LIFT - lh.value - 4.0;
                let row_bottom = yy + if a == b { LOOP_H } else { 0.0 } + DISC + 4.0;
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
            let back = if bar_at(a, k) { BAR } else { 1.0 };
            let pts = [
                (x0 + lead, yy),
                (x0 + LOOP_W, yy),
                (x0 + LOOP_W, yy + LOOP_H),
                (x0 + back, yy + LOOP_H),
            ];
            pen.connector(&pts, stroke(msg), delay);
            if let Some(key) = &msg.key {
                pen.key(x0, yy, key.n, delay, m);
            }
            pen.text(
                x0 + LOOP_LABEL,
                (yy + LOOP_H / 2.0).round(),
                t.shown(TypeRole::Value, &msg.label),
                TypeRole::Value,
                colour,
                Anchor::Start,
                Baseline::Middle,
                delay,
            );
            continue;
        }
        let dir = if b > a { 1.0 } else { -1.0 };
        let origin = cx[a] + dir * lead;
        let tip = cx[b] - dir * if bar_at(b, k) { BAR } else { 1.0 };
        let mx = ((origin + tip) / 2.0).round();
        let label_bottom = yy - LABEL_LIFT;
        // A label over a lifeline it crosses is knocked out of it.
        let knock = Rect {
            x: mx - (lw / 2.0).round() - 3.0,
            y: label_bottom - lh.value - 1.0,
            w: lw + 6.0,
            h: lh.value + 2.0,
        };
        let paint = BoxPaint {
            fill: Some((ColourRole::Surface, 1.0)),
            stroke: None,
        };
        pen.boxed(knock, 0.0, paint, delay);
        let fill = match (msg.reply, msg.tone) {
            (true, None) => ColourRole::InkMuted,
            (_, Some(t)) => Tone::colour(t),
            (false, None) => ColourRole::Ink,
        };
        pen.text(
            mx,
            label_bottom,
            t.shown(TypeRole::Value, &msg.label),
            TypeRole::Value,
            fill,
            Anchor::Middle,
            Baseline::Bottom,
            delay,
        );
        pen.connector(&[(origin, yy), (tip, yy)], stroke(msg), delay);
        // The message starts on its sender's lifeline: its key there, or a
        // dot for a call that has none and leaves no bar.
        if let Some(key) = &msg.key {
            pen.key(cx[a], yy, key.n, delay, m);
        } else if !msg.reply && !bar_at(a, k) {
            pen.dot(cx[a], yy, ORIGIN_DOT, colour, delay);
        }
    }

    Laid {
        // Messages run straight across and lifelines straight down; the
        // one can only meet the other, never cross another message.
        crossings: 0,
        program: pen.finish(width, foot + lh.value + MARGIN),
        warnings: t.warnings,
    }
}
