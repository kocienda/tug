//! "Nice" linear ticks.
//!
//! A tick step is 1, 2 or 5 × 10^k, and the count comes from the plot's
//! extent in px alone, so ticks never depend on how text measures.

/// A value axis: its domain, widened to whole steps, and its ticks.
#[derive(Clone, Debug, PartialEq)]
pub struct Axis {
    pub lo: f64,
    pub hi: f64,
    pub step: f64,
    pub ticks: Vec<f64>,
}

/// Px of extent per tick on a vertical value axis.
pub const PX_PER_TICK_V: f64 = 48.0;
/// Px of extent per tick on a horizontal value axis.
pub const PX_PER_TICK_H: f64 = 80.0;

impl Axis {
    /// The axis over `[lo, hi]` for a plot `extent_px` long, with one tick
    /// per `px_per_tick`, and never fewer than two.
    pub fn nice(lo: f64, hi: f64, extent_px: f64, px_per_tick: f64) -> Axis {
        let (mut lo, mut hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
        if lo == hi {
            let pad = if lo == 0.0 { 1.0 } else { lo.abs() / 10.0 };
            lo -= pad;
            hi += pad;
        }
        let target = (extent_px / px_per_tick).floor().max(2.0);
        let step = nice_step((hi - lo) / target);
        let first = (lo / step).floor();
        let last = (hi / step).ceil();
        // `k × step` from integers, so error never accumulates the way a
        // running sum's would; the formatter rounds what is left.
        let ticks: Vec<f64> = (0..=(last - first) as i64).map(|i| (first + i as f64) * step).collect();
        Axis {
            lo: first * step,
            hi: last * step,
            step,
            ticks,
        }
    }

    /// Where `v` falls along an extent from `start` (at `lo`) to `end`
    /// (at `hi`).
    pub fn map(&self, v: f64, start: f64, end: f64) -> f64 {
        start + (v - self.lo) / (self.hi - self.lo) * (end - start)
    }
}

/// The smallest 1, 2 or 5 × 10^k at least `raw`. The power is found by
/// repeated multiplication rather than `log10`, which is not guaranteed to
/// round the same way on every platform.
fn nice_step(raw: f64) -> f64 {
    let mut mag = 1.0;
    while mag > raw {
        mag /= 10.0;
    }
    while mag * 10.0 <= raw {
        mag *= 10.0;
    }
    for m in [1.0, 2.0, 5.0, 10.0] {
        if m * mag >= raw {
            return m * mag;
        }
    }
    10.0 * mag
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_one_two_five() {
        assert_eq!(nice_step(1.0), 1.0);
        assert_eq!(nice_step(1.3), 2.0);
        assert_eq!(nice_step(3.0), 5.0);
        assert_eq!(nice_step(7.0), 10.0);
        assert_eq!(nice_step(130.0), 200.0);
        assert!((nice_step(0.03) - 0.05).abs() < 1e-12);
    }

    #[test]
    fn count_follows_extent() {
        // 192 px / 48 = 4 ticks wanted over 0..7: step 2, 0..8.
        let a = Axis::nice(0.0, 7.0, 192.0, PX_PER_TICK_V);
        assert_eq!(a.step, 2.0);
        assert_eq!(a.ticks, vec![0.0, 2.0, 4.0, 6.0, 8.0]);
        assert_eq!((a.lo, a.hi), (0.0, 8.0));
        // Twice the extent, twice the ticks.
        let b = Axis::nice(0.0, 7.0, 384.0, PX_PER_TICK_V);
        assert_eq!(b.step, 1.0);
    }

    #[test]
    fn negative_and_flat_domains() {
        let a = Axis::nice(-3.0, 5.0, 192.0, PX_PER_TICK_V);
        assert_eq!(a.ticks, vec![-4.0, -2.0, 0.0, 2.0, 4.0, 6.0]);
        let flat = Axis::nice(0.0, 0.0, 96.0, PX_PER_TICK_V);
        assert_eq!((flat.lo, flat.hi), (-1.0, 1.0));
        let flat = Axis::nice(50.0, 50.0, 96.0, PX_PER_TICK_V);
        assert_eq!((flat.lo, flat.hi), (45.0, 55.0));
    }

    #[test]
    fn small_extents_keep_two_ticks() {
        let a = Axis::nice(0.0, 10.0, 20.0, PX_PER_TICK_V);
        assert_eq!(a.ticks, vec![0.0, 5.0, 10.0]);
    }

    #[test]
    fn map_is_linear() {
        let a = Axis::nice(0.0, 8.0, 192.0, PX_PER_TICK_V);
        assert_eq!(a.map(0.0, 200.0, 40.0), 200.0);
        assert_eq!(a.map(8.0, 200.0, 40.0), 40.0);
        assert_eq!(a.map(4.0, 200.0, 40.0), 120.0);
    }
}
