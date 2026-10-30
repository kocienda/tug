//! `histogram`: samples binned into equal-width ranges, a bar per bin.
//! The count wanted is Freedman–Diaconis, clamped to the spec's range, unless
//! the spec asks for one; the edges then fall on the axis's nice numbers, so
//! the count is a request and what is drawn can be a few bins either side.
//! The ranges are the categories — written in the spec's format, since they
//! are in the samples' units — and the counts are integers whatever the
//! format, so the bars are laid out against a copy of the spec that formats
//! counts.

use super::{bar, Builder};
use crate::chart::format::Format;
use crate::chart::spec::{Orient, Series, Spec, MAX_BINS, MIN_BINS};
use crate::chart::ticks::step_for;
use crate::draw::ColourRole;
use crate::measure::Measure;

/// Slack for a sample on a bin edge, whose quotient by the step can land a
/// hair past the whole number it stands for.
const EDGE_SLACK: f64 = 1e-9;

/// The bins of a sample: a range label and a count each.
pub(crate) struct Bins {
    pub labels: Vec<String>,
    pub counts: Vec<u32>,
}

/// Bins `values` (at least one, all finite) on nice edges, asking for `bins`
/// ranges or for the Freedman–Diaconis count — `2·IQR·n^(-1/3)` wide — clamped
/// to `MIN_BINS..=MAX_BINS`. The step widens if the edges would need more than
/// `MAX_BINS`; a count under `MIN_BINS` that the rounding gives is kept. A flat
/// sample has no range to round, so a unit range is cut into the count wanted.
pub(crate) fn bins(values: &[f64], bins: Option<usize>, format: Format) -> Bins {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    let (min, max) = (sorted[0], sorted[n - 1]);
    let wanted = bins
        .unwrap_or_else(|| {
            let quantile = |p: f64| {
                let pos = p * (n - 1) as f64;
                let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
                sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
            };
            let iqr = quantile(0.75) - quantile(0.25);
            let width = 2.0 * iqr / (n as f64).cbrt();
            if width > 0.0 && max > min {
                ((max - min) / width).ceil() as usize
            } else {
                MIN_BINS
            }
        })
        .clamp(MIN_BINS, MAX_BINS);
    let (first, step, count) = if max > min {
        edges(
            min,
            max,
            step_for(format, (max - min) / wanted as f64),
            format,
        )
    } else {
        let step = 1.0 / wanted as f64;
        ((min - 0.5) / step, step, wanted)
    };
    let mut counts = vec![0u32; count];
    for v in values {
        let k = ((v / step - first + EDGE_SLACK).floor() as isize).clamp(0, count as isize - 1)
            as usize;
        counts[k] += 1;
    }
    let labels = (0..count)
        .map(|k| {
            format!(
                "{}–{}",
                format.apply((first + k as f64) * step),
                format.apply((first + (k + 1) as f64) * step)
            )
        })
        .collect();
    Bins { labels, counts }
}

/// The first edge in steps, the step, and the bin count covering `[min, max]`,
/// taking the next larger step while the count is over `MAX_BINS`.
fn edges(min: f64, max: f64, mut step: f64, format: Format) -> (f64, f64, usize) {
    loop {
        let first = (min / step).floor();
        let count = ((max / step - first - EDGE_SLACK).ceil() as usize).max(1);
        if count <= MAX_BINS {
            return (first, step, count);
        }
        step = step_for(format, step * 1.01);
    }
}

pub(super) fn layout(
    b: &mut Builder,
    spec: &Spec,
    values: &[f64],
    bins_wanted: Option<usize>,
    w: f64,
    h: f64,
    m: &dyn Measure,
) {
    let bins = bins(values, bins_wanted, spec.format);
    let counts = Spec {
        format: Format::Int,
        ..spec.clone()
    };
    let series = [Series {
        name: "count".to_string(),
        values: bins.counts.iter().map(|&c| Some(f64::from(c))).collect(),
        role: ColourRole::Series(1),
    }];
    bar::layout(
        b,
        &counts,
        &bins.labels,
        &series,
        Orient::Vertical,
        false,
        w,
        h,
        m,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_fall_on_nice_numbers() {
        let out = bins(&[1.0, 6.0, 12.0, 19.0], Some(4), Format::Secs);
        assert_eq!(out.labels, vec!["0s–5s", "5s–10s", "10s–15s", "15s–20s"]);
        assert_eq!(out.counts, vec![1, 1, 1, 1]);
    }

    #[test]
    fn a_count_over_the_limit_widens_the_step() {
        let out = bins(&[0.5, 40.5], Some(40), Format::Int);
        assert_eq!(out.counts.len(), 21);
        assert_eq!(out.labels[0], "0–2");
        assert_eq!(out.counts[20], 1);
    }

    #[test]
    fn a_value_on_the_last_edge_lands_in_the_last_bin() {
        let out = bins(&[0.0, 5.0, 10.0, 20.0], Some(4), Format::Secs);
        assert_eq!(out.labels.len(), 4);
        assert_eq!(out.counts, vec![1, 1, 1, 1]);
    }

    #[test]
    fn a_fractional_range_opens_no_empty_last_bin() {
        // 0.3 / 0.1 is a hair over 3 in binary.
        let out = bins(&[0.0, 0.3], Some(4), Format::Decimal);
        assert_eq!(out.counts.last(), Some(&1));
    }
}
