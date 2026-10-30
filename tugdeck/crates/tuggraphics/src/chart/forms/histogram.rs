//! `histogram`: samples binned into equal-width ranges, a bar per bin.
//! The bin count is Freedman–Diaconis, clamped to the spec's range, unless
//! the spec gives one. The ranges are the categories — written in the
//! spec's format, since they are in the samples' units — and the counts
//! are integers whatever the format, so the bars are laid out against a
//! copy of the spec that formats counts.

use super::{bar, Builder};
use crate::chart::format::Format;
use crate::chart::spec::{Orient, Series, Spec, MAX_BINS, MIN_BINS};
use crate::draw::ColourRole;
use crate::measure::Measure;

/// The bins of a sample: a range label and a count each.
pub(crate) struct Bins {
    pub labels: Vec<String>,
    pub counts: Vec<u32>,
}

/// Bins `values` (at least one, all finite) into `bins` ranges, or into
/// the Freedman–Diaconis count — `2·IQR·n^(-1/3)` wide — clamped to
/// `MIN_BINS..=MAX_BINS`. A flat sample is spread over a unit range.
pub(crate) fn bins(values: &[f64], bins: Option<usize>, format: Format) -> Bins {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    let (min, max) = (sorted[0], sorted[n - 1]);
    let count = bins
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
    let (lo, hi) = if max > min { (min, max) } else { (min - 0.5, max + 0.5) };
    let step = (hi - lo) / count as f64;
    let mut counts = vec![0u32; count];
    for v in values {
        let k = (((v - lo) / step).floor() as isize).clamp(0, count as isize - 1) as usize;
        counts[k] += 1;
    }
    let labels = (0..count)
        .map(|k| {
            format!(
                "{}–{}",
                format.apply(lo + step * k as f64),
                format.apply(lo + step * (k + 1) as f64)
            )
        })
        .collect();
    Bins { labels, counts }
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
    bar::layout(b, &counts, &bins.labels, &series, Orient::Vertical, false, w, h, m);
}
