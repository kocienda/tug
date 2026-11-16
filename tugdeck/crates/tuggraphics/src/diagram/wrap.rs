//! Text in a diagram: names on one line, secondary text wrapped by words
//! to at most two, inside the two-request measure protocol.
//!
//! The first request asks for every full string and, for a string that may
//! wrap, every word of it and the space between; that alone decides where
//! the lines break. The second asks for the lines chosen, whose exact
//! widths size the boxes. Neither the break nor the width a string wraps at
//! may depend on a second-request answer, or a third request would follow.

use crate::chart::ChartError;
use crate::measure::{Measure, TypeRole};

use super::spec::err;

/// The widest a name may be on its one line.
pub(crate) const NAME_MAX_W: f64 = 320.0;
/// The most lines a wrapped string may take.
pub(crate) const MAX_LINES: usize = 2;

/// A wrapped string: its lines, and the widest line's measured width.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Lines {
    pub lines: Vec<String>,
    pub w: f64,
}

impl Lines {
    pub fn none() -> Lines {
        Lines {
            lines: Vec::new(),
            w: 0.0,
        }
    }

    pub fn count(&self) -> usize {
        self.lines.len()
    }
}

/// Measures a layout's text and collects the errors its measurements
/// raise. A string the measurer does not know yet measures zero, which no
/// cap refuses, so a provisional round raises nothing it would take back.
pub(crate) struct Texts<'m> {
    pub m: &'m dyn Measure,
    pub errors: Vec<ChartError>,
}

impl<'m> Texts<'m> {
    pub fn new(m: &'m dyn Measure) -> Texts<'m> {
        Texts {
            m,
            errors: Vec::new(),
        }
    }

    pub fn width(&self, role: TypeRole, text: &str) -> f64 {
        self.m.measure(role, text).map_or(0.0, |g| g.w.ceil())
    }

    /// A name: one line, never wrapped, and refused past [`NAME_MAX_W`].
    pub fn name(&mut self, role: TypeRole, text: &str, path: &str) -> f64 {
        let w = self.width(role, text);
        if w > NAME_MAX_W {
            self.errors.push(err(
                path,
                format!(
                    "this name is {w} px wide on its one line; a name is at most {NAME_MAX_W} px, so shorten it"
                ),
            ));
        }
        w
    }

    /// A label that stays on one line because its row height is the
    /// figure's rhythm, refused past [`NAME_MAX_W`] as a name is.
    pub fn line(&mut self, role: TypeRole, text: &str, path: &str) -> f64 {
        let w = self.width(role, text);
        if w > NAME_MAX_W {
            self.errors.push(err(
                path,
                format!(
                    "this label is {w} px wide; it stays on one line of at most {NAME_MAX_W} px, so shorten it"
                ),
            ));
        }
        w
    }

    /// Secondary text wrapped by words at `max_w`, refused past
    /// [`MAX_LINES`]. A word wider than `max_w` takes a line of its own.
    pub fn wrap(&mut self, role: TypeRole, text: &str, max_w: f64, path: &str) -> Lines {
        let words: Vec<&str> = text.split_whitespace().collect();
        let full = self.m.measure(role, text);
        // Asked for in the first request whatever the full string turns out
        // to measure, so the break never waits on a second.
        let space = self.m.measure(role, " ");
        let word_w: Vec<Option<f64>> = if words.len() > 1 {
            words
                .iter()
                .map(|w| self.m.measure(role, w).map(|g| g.w))
                .collect()
        } else {
            Vec::new()
        };
        let one = |w: f64| Lines {
            lines: vec![text.to_string()],
            w,
        };
        let Some(full) = full else {
            return one(0.0);
        };
        if full.w <= max_w || words.len() < 2 {
            return one(full.w.ceil());
        }
        let (Some(space), Some(word_w)) = (space, word_w.into_iter().collect::<Option<Vec<f64>>>())
        else {
            return one(0.0);
        };
        let mut breaks: Vec<Vec<&str>> = Vec::new();
        let mut run = 0.0;
        for (word, w) in words.iter().zip(&word_w) {
            match breaks.last_mut() {
                Some(line) if run + space.w + w <= max_w => {
                    line.push(word);
                    run += space.w + w;
                }
                _ => {
                    breaks.push(vec![word]);
                    run = *w;
                }
            }
        }
        if breaks.len() > MAX_LINES {
            self.errors.push(err(
                path,
                format!(
                    "this wraps to {} lines at {max_w} px; it may take at most {MAX_LINES}, so shorten it",
                    breaks.len()
                ),
            ));
        }
        let lines: Vec<String> = breaks.into_iter().map(|l| l.join(" ")).collect();
        let w = lines
            .iter()
            .map(|l| self.width(role, l))
            .fold(0.0, f64::max);
        Lines { lines, w }
    }

    /// As [`Texts::wrap`], for a string that may be absent.
    pub fn wrap_opt(
        &mut self,
        role: TypeRole,
        text: Option<&str>,
        max_w: f64,
        path: &str,
    ) -> Lines {
        text.map_or_else(Lines::none, |t| self.wrap(role, t, max_w, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::measure::{run_rounds, FixedMetrics};

    // Under FixedMetrics a value grapheme is 6.6 px wide.

    #[test]
    fn a_short_string_is_one_line() {
        let lines = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            let l = t.wrap(TypeRole::Value, "runs", 100.0, "/x");
            (l, t.errors.len())
        })
        .unwrap();
        assert_eq!(lines.0.lines, vec!["runs"]);
        assert_eq!(lines.1, 0);
    }

    #[test]
    fn a_long_string_breaks_by_words_within_two_requests() {
        // 10 graphemes per line at 66 px.
        let (l, errors) = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            let l = t.wrap(TypeRole::Value, "aaaa bbbbb cc dddd", 66.0, "/x");
            (l, t.errors.len())
        })
        .unwrap();
        assert_eq!(l.lines, vec!["aaaa bbbbb", "cc dddd"]);
        assert!((l.w - 66.0).abs() < 1e-9);
        assert_eq!(errors, 0);
    }

    #[test]
    fn a_third_line_is_an_error_at_its_path() {
        let errors = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            t.wrap(
                TypeRole::Value,
                "aaaa bbbb cccc dddd eeee",
                40.0,
                "/edges/0/label",
            );
            t.errors
        })
        .unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "/edges/0/label");
        assert!(
            errors[0].message.contains("5 lines at 40 px"),
            "{}",
            errors[0].message
        );
    }

    #[test]
    fn a_name_past_its_cap_names_its_width() {
        let errors = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            // 50 title graphemes at 7.8 px.
            t.name(TypeRole::Title, &"x".repeat(50), "/columns/0/0/name");
            t.errors
        })
        .unwrap();
        assert_eq!(errors.len(), 1);
        assert!(
            errors[0].message.contains("390 px"),
            "{}",
            errors[0].message
        );
    }
}
