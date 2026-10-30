//! `sparkline`: a word-sized line with no axes and no text, so it needs no
//! measurement and compiles in one round.

use super::{range, Builder, Pen};
use crate::chart::build::circle;
use crate::chart::spec::Highlight;
use crate::draw::{ColourRole, Enter, Seg};

/// The inset that keeps the stroke and the highlight dot inside the frame.
const INSET: f64 = 3.0;
const DOT: f64 = 2.0;

pub(super) fn layout(b: &mut Builder, values: &[Option<f64>], highlight: Highlight, w: f64, h: f64) {
    let (lo, hi) = range(values).unwrap_or((0.0, 0.0));
    let n = values.len();
    let x = |i: usize| {
        if n == 1 {
            w / 2.0
        } else {
            INSET + (w - 2.0 * INSET) * i as f64 / (n - 1) as f64
        }
    };
    let y = |v: f64| {
        if hi == lo {
            h / 2.0
        } else {
            h - INSET - (v - lo) / (hi - lo) * (h - 2.0 * INSET)
        }
    };
    let role = ColourRole::Series(1);
    let mut path = Vec::new();
    let mut run = 0;
    for (i, v) in values.iter().enumerate() {
        match v {
            Some(v) => {
                path.push(if run == 0 {
                    Seg::Move(x(i), y(*v))
                } else {
                    Seg::Line(x(i), y(*v))
                });
                run += 1;
            }
            None => {
                if run == 1 {
                    path.pop();
                    if let Some(p) = values[i - 1] {
                        b.fill(circle(x(i - 1), y(p), DOT / 2.0), role, None);
                    }
                }
                run = 0;
            }
        }
    }
    if run == 1 {
        path.pop();
        if let Some(p) = values[n - 1] {
            b.fill(circle(x(n - 1), y(p), DOT / 2.0), role, None);
        }
    }
    let pen = Pen {
        role,
        width: 1.5,
        dash: &[],
        round: true,
    };
    b.stroke(path, pen, b.enter(Enter::Draw, 0));

    let mut dots: Vec<usize> = Vec::new();
    match highlight {
        Highlight::Last => dots.extend(values.iter().rposition(Option::is_some)),
        Highlight::MinMax => {
            // The first occurrence of each extreme.
            dots.extend(values.iter().position(|v| *v == Some(lo)));
            if hi != lo {
                dots.extend(values.iter().position(|v| *v == Some(hi)));
            }
        }
        Highlight::None => {}
    }
    for i in dots {
        if let Some(v) = values[i] {
            b.fill(circle(x(i), y(v), DOT), ColourRole::Accent, b.enter(Enter::Fade, 1));
        }
    }
}
