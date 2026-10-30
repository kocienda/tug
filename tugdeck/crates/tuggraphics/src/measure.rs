//! The measurement contract.
//!
//! Text is laid out against exact measurements of the face it will be set
//! in. Whoever renders supplies a [`Measure`]: the deck measures with the
//! page's own canvas, a standalone render measures the same font files,
//! and tests use [`FixedMetrics`], which is deterministic.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

/// A type role. Text carries a role, never a font: the renderer maps each
/// role to a face and a size, and the measurer reads the same mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TypeRole {
    Title,
    Label,
    Value,
    Mono,
}

impl TypeRole {
    pub const ALL: [TypeRole; 4] = [
        TypeRole::Title,
        TypeRole::Label,
        TypeRole::Value,
        TypeRole::Mono,
    ];

    pub fn parse(s: &str) -> Option<TypeRole> {
        match s {
            "title" => Some(TypeRole::Title),
            "label" => Some(TypeRole::Label),
            "value" => Some(TypeRole::Value),
            "mono" => Some(TypeRole::Mono),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TypeRole::Title => "title",
            TypeRole::Label => "label",
            TypeRole::Value => "value",
            TypeRole::Mono => "mono",
        }
    }

    /// The role's size in px under [`FixedMetrics`].
    pub fn fixed_size(self) -> f64 {
        match self {
            TypeRole::Title => 13.0,
            TypeRole::Label => 12.0,
            TypeRole::Value | TypeRole::Mono => 11.0,
        }
    }
}

/// A measured string: advance width, and the font bounding box's ascent
/// and descent above and below the alphabetic baseline, all in px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    pub w: f64,
    pub a: f64,
    pub d: f64,
}

/// Measures a string set in a role. `None` means this measurer does not
/// know the string yet; a table-backed measurer answers that way for a
/// pair it has not been given, and the compile asks for it.
pub trait Measure {
    fn measure(&self, role: TypeRole, text: &str) -> Option<Metrics>;
}

/// The deterministic measurer: `width = 0.6 × size × graphemes`,
/// `ascent = 0.8 × size`, `descent = 0.2 × size`.
#[derive(Clone, Copy, Debug, Default)]
pub struct FixedMetrics;

impl Measure for FixedMetrics {
    fn measure(&self, role: TypeRole, text: &str) -> Option<Metrics> {
        let size = role.fixed_size();
        let graphemes = text.graphemes(true).count() as f64;
        Some(Metrics {
            w: 0.6 * size * graphemes,
            a: 0.8 * size,
            d: 0.2 * size,
        })
    }
}

/// The table key for a measured pair: `"<role>\u{0}<text>"`, the same key
/// the deck's table protocol carries.
pub fn table_key(role: TypeRole, text: &str) -> String {
    format!("{}\u{0}{text}", role.name())
}

/// A measurer backed by a table of measurements someone else took. A pair
/// the table does not hold answers `None` and is recorded as a miss, so a
/// layout run against it says exactly which pairs it still needs.
#[derive(Debug, Default)]
pub struct MeasureTable {
    known: HashMap<(TypeRole, String), Metrics>,
    misses: RefCell<BTreeSet<(TypeRole, String)>>,
}

impl MeasureTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads a table in the protocol's JSON shape:
    /// `{"<role>\u0000<text>": {"w": …, "a": …, "d": …}}`.
    pub fn from_json(source: &str) -> Result<MeasureTable, String> {
        let value: Value =
            serde_json::from_str(source).map_err(|e| format!("measure table is not JSON: {e}"))?;
        let obj = value.as_object().ok_or("measure table is a JSON object")?;
        let mut table = MeasureTable::new();
        for (key, m) in obj {
            let (role, text) = key
                .split_once('\u{0}')
                .and_then(|(r, t)| Some((TypeRole::parse(r)?, t)))
                .ok_or_else(|| "measure table keys are \"<role>\\u0000<text>\"".to_string())?;
            let field = |k: &str| m.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
            match (field("w"), field("a"), field("d")) {
                (Some(w), Some(a), Some(d)) => table.insert(role, text, Metrics { w, a, d }),
                _ => {
                    return Err(
                        "measure table values are {\"w\", \"a\", \"d\"} finite numbers".into(),
                    )
                }
            }
        }
        Ok(table)
    }

    pub fn insert(&mut self, role: TypeRole, text: &str, m: Metrics) {
        self.known.insert((role, text.to_string()), m);
    }

    /// The pairs asked for and not known, in a stable order, clearing the
    /// record.
    pub fn take_misses(&self) -> Vec<(TypeRole, String)> {
        std::mem::take(&mut *self.misses.borrow_mut())
            .into_iter()
            .collect()
    }
}

impl Measure for MeasureTable {
    fn measure(&self, role: TypeRole, text: &str) -> Option<Metrics> {
        let got = self.known.get(&(role, text.to_string())).copied();
        if got.is_none() {
            self.misses.borrow_mut().insert((role, text.to_string()));
        }
        got
    }
}

/// The result of fitting a string into a width.
#[derive(Clone, Debug, PartialEq)]
pub struct Fit {
    pub text: String,
    pub metrics: Metrics,
    pub truncated: bool,
}

pub const ELLIPSIS: &str = "…";

/// Fits `text` set in `role` into `max_w` px. A string that fits is
/// returned whole; one that overflows becomes its longest grapheme prefix
/// plus "…" that fits, by exact measurement of every candidate; when even
/// "…" alone overflows the result is empty. Graphemes are never split.
///
/// Against a measurer that does not know a pair yet, the answer is
/// provisional and the pair is asked for: the full string first, then —
/// only once it is known to overflow — every candidate at once, so a
/// table-backed layout settles in at most two measure rounds.
pub fn fit_text(text: &str, role: TypeRole, max_w: f64, m: &dyn Measure) -> Fit {
    const ZERO: Metrics = Metrics {
        w: 0.0,
        a: 0.0,
        d: 0.0,
    };
    let Some(full) = m.measure(role, text) else {
        return Fit {
            text: text.to_string(),
            metrics: ZERO,
            truncated: false,
        };
    };
    if full.w <= max_w {
        return Fit {
            text: text.to_string(),
            metrics: full,
            truncated: false,
        };
    }
    let graphemes: Vec<&str> = text.graphemes(true).collect();
    // Measure every candidate so a table learns them all in one round.
    let candidates: Vec<(String, Option<Metrics>)> = (0..graphemes.len())
        .map(|k| {
            let s = format!("{}{ELLIPSIS}", graphemes[..k].concat());
            let got = m.measure(role, &s);
            (s, got)
        })
        .collect();
    let best = candidates
        .into_iter()
        .rev()
        .find_map(|(s, got)| got.filter(|g| g.w <= max_w).map(|g| (s, g)));
    match best {
        Some((s, metrics)) => Fit {
            text: s,
            metrics,
            truncated: true,
        },
        None => Fit {
            text: String::new(),
            metrics: ZERO,
            truncated: true,
        },
    }
}

/// What one layout round against a [`MeasureTable`] came to.
#[derive(Clone, Debug, PartialEq)]
pub enum RoundOutcome<T> {
    /// The pairs the layout still needs measured.
    Measure(Vec<(TypeRole, String)>),
    Done(T),
}

/// The most measure requests one compile may make. The first asks for
/// every full string, the second for the truncation candidates of strings
/// that overflow; a third is a compile error.
pub const MAX_MEASURE_REQUESTS: usize = 2;

pub const NOT_CONVERGED: &str = "measurement did not converge";

/// Runs `layout` once against `table`: `Done` when it asked for nothing
/// the table lacks, otherwise the pairs to measure. This is one round of
/// the protocol the WASM shell speaks; the caller supplies the table.
pub fn measure_round<T>(
    table: &MeasureTable,
    layout: impl FnOnce(&dyn Measure) -> T,
) -> RoundOutcome<T> {
    table.take_misses();
    let out = layout(table);
    let misses = table.take_misses();
    if misses.is_empty() {
        RoundOutcome::Done(out)
    } else {
        RoundOutcome::Measure(misses)
    }
}

/// Runs the protocol natively to completion against any measurer, with
/// the same rounds and the same limit the deck's loop enforces, so a
/// layout that converges here converges there.
pub fn run_rounds<T>(
    measurer: &dyn Measure,
    mut layout: impl FnMut(&dyn Measure) -> T,
) -> Result<T, String> {
    let mut table = MeasureTable::new();
    for request in 0..=MAX_MEASURE_REQUESTS {
        match measure_round(&table, &mut layout) {
            RoundOutcome::Done(out) => return Ok(out),
            RoundOutcome::Measure(_) if request == MAX_MEASURE_REQUESTS => break,
            RoundOutcome::Measure(missing) => {
                for (role, text) in missing {
                    let m = measurer.measure(role, &text).ok_or_else(|| {
                        format!("no measurement for {} text {text:?}", role.name())
                    })?;
                    table.insert(role, &text, m);
                }
            }
        }
    }
    Err(NOT_CONVERGED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_metrics_counts_graphemes() {
        let m = FixedMetrics.measure(TypeRole::Label, "Mon").unwrap();
        assert!((m.w - 21.6).abs() < 1e-9);
        assert!((m.a - 9.6).abs() < 1e-9);
        assert!((m.d - 2.4).abs() < 1e-9);
        // A family emoji is one grapheme of several code points.
        let family = FixedMetrics.measure(TypeRole::Value, "👨‍👩‍👧").unwrap();
        assert!((family.w - 6.6).abs() < 1e-9);
    }

    #[test]
    fn roles_round_trip() {
        for role in TypeRole::ALL {
            assert_eq!(TypeRole::parse(role.name()), Some(role));
        }
        assert_eq!(TypeRole::parse("serif"), None);
    }

    // Under FixedMetrics a label grapheme is 7.2 px wide.
    const G: f64 = 7.2;

    #[test]
    fn fit_text_leaves_a_fitting_string_whole() {
        let fit = fit_text("Mon", TypeRole::Label, 3.0 * G, &FixedMetrics);
        assert_eq!(fit.text, "Mon");
        assert!(!fit.truncated);
        assert!((fit.metrics.w - 3.0 * G).abs() < 1e-9);
    }

    #[test]
    fn fit_text_truncates_at_an_exact_boundary() {
        // "Wedn…" is five graphemes: exactly the width allowed.
        let fit = fit_text("Wednesday", TypeRole::Label, 5.0 * G, &FixedMetrics);
        assert_eq!(fit.text, "Wedn…");
        assert!(fit.truncated);
        // A hair narrower drops one more grapheme.
        let fit = fit_text("Wednesday", TypeRole::Label, 5.0 * G - 0.01, &FixedMetrics);
        assert_eq!(fit.text, "Wed…");
    }

    #[test]
    fn fit_text_too_narrow_for_the_ellipsis_is_empty() {
        let fit = fit_text("Wednesday", TypeRole::Label, G - 0.01, &FixedMetrics);
        assert_eq!(fit.text, "");
        assert!(fit.truncated);
        assert_eq!(fit.metrics.w, 0.0);
        // Exactly one grapheme wide leaves the ellipsis alone.
        assert_eq!(
            fit_text("Wednesday", TypeRole::Label, G, &FixedMetrics).text,
            "…"
        );
    }

    #[test]
    fn fit_text_never_splits_a_grapheme() {
        // A ZWJ family and an e with a combining acute are one grapheme each.
        let family = "👨\u{200d}👩\u{200d}👧";
        let text = format!("{family}e\u{301}xyz");
        let fit = fit_text(&text, TypeRole::Label, 3.0 * G, &FixedMetrics);
        assert_eq!(fit.text, format!("{family}e\u{301}…"));
        let fit = fit_text(&text, TypeRole::Label, 2.0 * G, &FixedMetrics);
        assert_eq!(fit.text, format!("{family}…"));
    }

    fn two_labels(m: &dyn Measure) -> (Fit, Fit) {
        (
            fit_text("Mon", TypeRole::Label, 100.0, m),
            fit_text("Wednesday", TypeRole::Label, 5.0 * G, m),
        )
    }

    #[test]
    fn a_round_asks_for_exactly_its_misses() {
        let mut table = MeasureTable::new();
        let RoundOutcome::Measure(first) = measure_round(&table, two_labels) else {
            panic!("round 1 should ask");
        };
        assert_eq!(
            first,
            vec![
                (TypeRole::Label, "Mon".to_string()),
                (TypeRole::Label, "Wednesday".to_string())
            ]
        );
        for (role, text) in &first {
            table.insert(*role, text, FixedMetrics.measure(*role, text).unwrap());
        }
        // Round 2: "Wednesday" overflows, so every candidate is asked for.
        let RoundOutcome::Measure(second) = measure_round(&table, two_labels) else {
            panic!("round 2 should ask for candidates");
        };
        assert_eq!(second.len(), 9);
        assert!(second.contains(&(TypeRole::Label, "…".to_string())));
        assert!(second.contains(&(TypeRole::Label, "Wednesda…".to_string())));
        for (role, text) in &second {
            table.insert(*role, text, FixedMetrics.measure(*role, text).unwrap());
        }
        match measure_round(&table, two_labels) {
            RoundOutcome::Done((a, b)) => {
                assert_eq!(a.text, "Mon");
                assert_eq!(b.text, "Wedn…");
            }
            RoundOutcome::Measure(m) => panic!("round 3 asked again: {m:?}"),
        }
    }

    #[test]
    fn run_rounds_settles_and_refuses_a_layout_that_keeps_asking() {
        let (a, b) = run_rounds(&FixedMetrics, two_labels).unwrap();
        assert_eq!((a.text.as_str(), b.text.as_str()), ("Mon", "Wedn…"));

        let mut n = 0;
        let greedy = run_rounds(&FixedMetrics, |m| {
            n += 1;
            m.measure(TypeRole::Value, &format!("ask {n}"))
        });
        assert_eq!(greedy, Err(NOT_CONVERGED.to_string()));
    }

    #[test]
    fn table_reads_the_protocol_shape() {
        let table = MeasureTable::from_json(r#"{"label\u0000Mon": {"w": 21.5, "a": 9, "d": 2.5}}"#)
            .unwrap();
        assert_eq!(
            table.measure(TypeRole::Label, "Mon"),
            Some(Metrics {
                w: 21.5,
                a: 9.0,
                d: 2.5
            })
        );
        assert_eq!(table_key(TypeRole::Label, "Mon"), "label\u{0}Mon");
        assert!(MeasureTable::from_json(r#"{"serif\u0000x": {"w": 1, "a": 1, "d": 1}}"#).is_err());
        assert!(MeasureTable::from_json(r#"{"label\u0000x": {"w": 1}}"#).is_err());
    }
}
