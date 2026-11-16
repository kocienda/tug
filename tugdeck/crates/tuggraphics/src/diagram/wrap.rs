//! Text in a diagram: names on one line, secondary text wrapped by words
//! to at most two, inside the two-request measure protocol.
//!
//! Text past a cap is never a reason to withhold the figure. A name wider
//! than its line is cut to fit and ends in an ellipsis, a third line of
//! secondary text is folded into an ellipsis on the second, and each is
//! reported as a warning for the author; the keyed table carries every
//! name whole.
//!
//! The first request asks for every full string and, for a string that may
//! wrap, every word of it, the space between and the ellipsis; that alone
//! decides where the lines break and which names are cut. The second asks
//! for the lines chosen and the cut names' candidates. Neither the break
//! nor the width a string wraps at may depend on a second-request answer,
//! or a third request would follow: so a cut name takes exactly its cap,
//! whatever its candidates turn out to measure.

use std::collections::BTreeMap;

use crate::chart::ChartError;
use crate::measure::{fit_text, Measure, TypeRole, ELLIPSIS};

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

/// Measures a layout's text and collects the warnings its measurements
/// raise. A string the measurer does not know yet measures zero, which is
/// past no cap, so a provisional round raises nothing it would take back.
pub(crate) struct Texts<'m> {
    pub m: &'m dyn Measure,
    pub warnings: Vec<ChartError>,
    /// The one-line strings cut to fit, by what they were.
    cut: BTreeMap<(TypeRole, String), String>,
}

impl<'m> Texts<'m> {
    pub fn new(m: &'m dyn Measure) -> Texts<'m> {
        Texts {
            m,
            warnings: Vec::new(),
            cut: BTreeMap::new(),
        }
    }

    pub fn width(&self, role: TypeRole, text: &str) -> f64 {
        self.m.measure(role, text).map_or(0.0, |g| g.w.ceil())
    }

    /// What a one-line string is drawn as: itself, or what it was cut to.
    pub fn shown<'a>(&'a self, role: TypeRole, text: &'a str) -> &'a str {
        self.cut
            .get(&(role, text.to_string()))
            .map_or(text, String::as_str)
    }

    /// Cuts a one-line string to `max_w` when it is wider, and returns the
    /// width it had. The caller sizes a cut string at exactly `max_w`, so
    /// nothing sized from it waits on the candidates' measurements.
    pub fn cut_to(&mut self, role: TypeRole, text: &str, max_w: f64) -> Option<f64> {
        let w = self.width(role, text);
        if w <= max_w {
            return None;
        }
        let fit = fit_text(text, role, max_w, self.m);
        self.cut.insert((role, text.to_string()), fit.text);
        Some(w)
    }

    /// A name: one line, never wrapped, cut to [`NAME_MAX_W`] with an
    /// ellipsis when it is wider. Draw it with [`Texts::shown`].
    pub fn name(&mut self, role: TypeRole, text: &str, path: &str) -> f64 {
        match self.cut_to(role, text, NAME_MAX_W) {
            None => self.width(role, text),
            Some(w) => {
                self.warnings.push(err(
                    path,
                    format!(
                        "this name is {w} px wide on its one line; a name is at most {NAME_MAX_W} px, so it is cut short: shorten it"
                    ),
                ));
                NAME_MAX_W
            }
        }
    }

    /// A label that stays on one line because its row height is the
    /// figure's rhythm, cut to [`NAME_MAX_W`] as a name is.
    pub fn line(&mut self, role: TypeRole, text: &str, path: &str) -> f64 {
        match self.cut_to(role, text, NAME_MAX_W) {
            None => self.width(role, text),
            Some(w) => {
                self.warnings.push(err(
                    path,
                    format!(
                        "this label is {w} px wide; it stays on one line of at most {NAME_MAX_W} px, so it is cut short: shorten it"
                    ),
                ));
                NAME_MAX_W
            }
        }
    }

    /// Secondary text wrapped by words at `max_w` to at most [`MAX_LINES`];
    /// what would run onto another is dropped and the last line ends in an
    /// ellipsis. A word wider than `max_w` takes a line of its own.
    pub fn wrap(&mut self, role: TypeRole, text: &str, max_w: f64, path: &str) -> Lines {
        let words: Vec<&str> = text.split_whitespace().collect();
        let full = self.m.measure(role, text);
        // Asked for in the first request whatever the full string turns out
        // to measure, so the break never waits on a second.
        let space = self.m.measure(role, " ");
        let ellipsis = self.m.measure(role, ELLIPSIS);
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
        let (Some(space), Some(ellipsis), Some(word_w)) = (
            space,
            ellipsis,
            word_w.into_iter().collect::<Option<Vec<f64>>>(),
        ) else {
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
        let mut lines: Vec<String> = breaks.iter().map(|l| l.join(" ")).collect();
        if breaks.len() > MAX_LINES {
            self.warnings.push(err(
                path,
                format!(
                    "this wraps to {} lines at {max_w} px; it may take at most {MAX_LINES}, so the rest is dropped: shorten it",
                    breaks.len()
                ),
            ));
            // The last line kept gives up words until the ellipsis fits
            // beside what is left, by the widths the first request gave.
            let taken: usize = breaks[..MAX_LINES - 1].iter().map(Vec::len).sum();
            let mut last = breaks[MAX_LINES - 1].clone();
            let line_w = |ws: &[&str]| {
                let at = taken..taken + ws.len();
                word_w[at].iter().sum::<f64>() + space.w * (ws.len() - 1) as f64
            };
            while last.len() > 1 && line_w(&last) + ellipsis.w > max_w {
                last.pop();
            }
            lines.truncate(MAX_LINES - 1);
            lines.push(format!("{}{ELLIPSIS}", last.join(" ")));
        }
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
            (l, t.warnings.len())
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
            (l, t.warnings.len())
        })
        .unwrap();
        assert_eq!(l.lines, vec!["aaaa bbbbb", "cc dddd"]);
        assert!((l.w - 66.0).abs() < 1e-9);
        assert_eq!(errors, 0);
    }

    #[test]
    fn a_third_line_folds_into_an_ellipsis_with_a_warning_at_its_path() {
        let (lines, errors) = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            let l = t.wrap(
                TypeRole::Value,
                "aaaa bbbb cccc dddd eeee",
                40.0,
                "/edges/0/label",
            );
            (l, t.warnings)
        })
        .unwrap();
        assert_eq!(lines.lines, vec!["aaaa", "bbbb…"]);
        // 5 value graphemes at 6.6 px, rounded up.
        assert!((lines.w - 33.0).abs() < 1e-9, "{}", lines.w);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "/edges/0/label");
        assert!(
            errors[0].message.contains("5 lines at 40 px"),
            "{}",
            errors[0].message
        );
    }

    #[test]
    fn the_last_line_gives_up_words_until_the_ellipsis_fits() {
        // 10 graphemes per line at 66 px: "cc dddd ee" fills the second
        // line, so "ee" goes to make room for the ellipsis.
        let lines = run_rounds(&FixedMetrics, |m| {
            Texts::new(m).wrap(TypeRole::Value, "aaaa bbbbb cc dddd ee ffff", 66.0, "/x")
        })
        .unwrap();
        assert_eq!(lines.lines, vec!["aaaa bbbbb", "cc dddd…"]);
    }

    #[test]
    fn a_name_past_its_cap_is_cut_and_names_its_width() {
        let name = "x".repeat(50);
        let (w, shown, errors) = run_rounds(&FixedMetrics, |m| {
            let mut t = Texts::new(m);
            // 50 title graphemes at 7.8 px.
            let w = t.name(TypeRole::Title, &name, "/columns/0/0/name");
            (w, t.shown(TypeRole::Title, &name).to_string(), t.warnings)
        })
        .unwrap();
        // 41 graphemes at 7.8 px are 319.8 px: 40 of the name and the
        // ellipsis. The name takes its cap whatever the cut measures.
        assert_eq!(shown, format!("{}…", "x".repeat(40)));
        assert!((w - NAME_MAX_W).abs() < 1e-9);
        assert_eq!(errors.len(), 1);
        assert!(
            errors[0].message.contains("390 px"),
            "{}",
            errors[0].message
        );
    }
}
