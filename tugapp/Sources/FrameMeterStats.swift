import Foundation

/// The arithmetic of a frame reading, over plain numbers.
///
/// `HostFrameMeter` records display-link tick times and presentation samples;
/// the spike reads a child page's `requestAnimationFrame` times. Both are
/// summarized here, in one place, so the host's reading and the page's are
/// judged by the same rule. Foundation-only, so `TugTests` compiles it.
enum FrameMeterStats {
    /// One gap between consecutive frames that ran past 1.5 periods.
    struct Gap: Equatable {
        /// Where the gap ended, in ms from the window's start.
        let atMs: Double
        let gapMs: Double
    }

    struct Summary: Equatable {
        let periodMs: Double
        let ticks: Int
        let expectedTicks: Int
        /// Frames that should have been and were not: for each gap over 1.5
        /// periods, `round(gap / period) - 1`.
        let missed: Int
        let worstGapMs: Double
        let gapsOverPeriod: [Gap]

        /// The JSON shape a reading travels in (the harness and the page's
        /// `hostFrames` callback both take it).
        var dictionary: [String: Any] {
            [
                "periodMs": periodMs,
                "ticks": ticks,
                "expectedTicks": expectedTicks,
                "missed": missed,
                "worstGapMs": worstGapMs,
                "gapsOverPeriod": gapsOverPeriod.map { ["atMs": $0.atMs, "gapMs": $0.gapMs] },
            ]
        }
    }

    /// Summarize the frames that landed inside `[windowStartMs, windowEndMs]`.
    ///
    /// The window's two edges count as frame boundaries: a page that froze for
    /// the whole window has one gap the window's length, not zero gaps, and a
    /// page that froze at the window's end has the trailing gap counted.
    static func summarize(
        timestampsMs: [Double],
        periodMs: Double,
        windowStartMs: Double,
        windowEndMs: Double
    ) -> Summary {
        let inside = timestampsMs.filter { $0 >= windowStartMs && $0 <= windowEndMs }.sorted()
        let windowMs = max(0, windowEndMs - windowStartMs)
        let expected = periodMs > 0 ? Int((windowMs / periodMs).rounded()) : 0
        let edges = [windowStartMs] + inside + [windowEndMs]
        var missed = 0
        var worst = 0.0
        var gaps: [Gap] = []
        for index in 1..<edges.count {
            let gap = edges[index] - edges[index - 1]
            worst = max(worst, gap)
            if periodMs > 0, gap > 1.5 * periodMs {
                missed += max(0, Int((gap / periodMs).rounded()) - 1)
                gaps.append(Gap(atMs: edges[index] - windowStartMs, gapMs: gap))
            }
        }
        return Summary(
            periodMs: periodMs,
            ticks: inside.count,
            expectedTicks: expected,
            missed: missed,
            worstGapMs: worst,
            gapsOverPeriod: gaps
        )
    }

    /// The share of consecutive samples whose position moved — what tells a
    /// layer the render server is animating from one that has stalled. Zero
    /// with fewer than two samples.
    static func advanceRatio(_ positions: [(x: Double, y: Double)]) -> Double {
        guard positions.count > 1 else { return 0 }
        var moved = 0
        for index in 1..<positions.count {
            let a = positions[index - 1]
            let b = positions[index]
            if a.x != b.x || a.y != b.y { moved += 1 }
        }
        return Double(moved) / Double(positions.count - 1)
    }

    /// The median spacing of a series, or nil with fewer than two points — a
    /// page's own frame period, read off its ticks rather than assumed.
    static func medianIntervalMs(_ timestampsMs: [Double]) -> Double? {
        let sorted = timestampsMs.sorted()
        guard sorted.count > 1 else { return nil }
        let intervals = (1..<sorted.count).map { sorted[$0] - sorted[$0 - 1] }.sorted()
        return intervals[intervals.count / 2]
    }
}
