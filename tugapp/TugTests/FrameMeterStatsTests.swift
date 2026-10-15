import XCTest

// `FrameMeterStats` is the rule both frame readings are judged by — the
// host's display link and a child page's rAF — so each claim here is one a
// spike verdict rests on: a clean series misses nothing, a gap is counted in
// the frames it cost, a frozen page is one long gap rather than none, and a
// layer that never moved has advanced on no tick.
final class FrameMeterStatsTests: XCTestCase {
    private let period = 1000.0 / 60.0

    private func series(count: Int, from start: Double = 0) -> [Double] {
        (0..<count).map { start + Double($0) * period }
    }

    func testACleanSixtyHertzSeriesMissesNothing() {
        let ticks = series(count: 61)
        let summary = FrameMeterStats.summarize(
            timestampsMs: ticks, periodMs: period, windowStartMs: 0, windowEndMs: ticks.last!)
        check("no frame missed", summary.missed == 0, "missed \(summary.missed)")
        check("no gap over the period", summary.gapsOverPeriod.isEmpty)
        check("every expected tick arrived", summary.ticks >= summary.expectedTicks,
              "\(summary.ticks)/\(summary.expectedTicks)")
        check("the worst gap is one period", abs(summary.worstGapMs - period) < 0.001,
              "worst \(summary.worstGapMs)")
    }

    func testOneFiftyMillisecondGapIsTwoMissedFrames() {
        var ticks = series(count: 10)
        let resume = ticks.last! + 50
        ticks += (0..<10).map { resume + Double($0) * period }
        let summary = FrameMeterStats.summarize(
            timestampsMs: ticks, periodMs: period, windowStartMs: 0, windowEndMs: ticks.last!)
        check("a 50 ms gap at 60 Hz costs two frames", summary.missed == 2, "missed \(summary.missed)")
        check("the gap is reported once", summary.gapsOverPeriod.count == 1)
        check("the worst gap is the 50 ms one", abs(summary.worstGapMs - 50) < 0.001,
              "worst \(summary.worstGapMs)")
    }

    func testAPageThatFrozeForTheWholeWindowIsOneLongGap() {
        let summary = FrameMeterStats.summarize(
            timestampsMs: [], periodMs: period, windowStartMs: 100, windowEndMs: 1100)
        check("no tick landed", summary.ticks == 0)
        check("sixty were expected", summary.expectedTicks == 60, "\(summary.expectedTicks)")
        check("the window is the gap", abs(summary.worstGapMs - 1000) < 0.001)
    }

    func testTicksOutsideTheWindowAreNotCounted() {
        let ticks = series(count: 120)
        let summary = FrameMeterStats.summarize(
            timestampsMs: ticks, periodMs: period, windowStartMs: 500, windowEndMs: 1000)
        check("only the window's ticks count", summary.ticks == 30, "\(summary.ticks)")
    }

    func testTheAdvanceRatioOfAFrozenSeriesIsZero() {
        let frozen = Array(repeating: (x: 10.0, y: 20.0), count: 30)
        check("a frozen layer advanced on no tick", FrameMeterStats.advanceRatio(frozen) == 0)
        let moving = (0..<30).map { (x: Double($0), y: 20.0) }
        check("a moving layer advanced on every tick", FrameMeterStats.advanceRatio(moving) == 1)
    }

    func testTheWorstStillRunIsTheLongestSpanAtOnePosition() {
        let moving = (0..<30).map { (t: Double($0) * period, x: Double($0), y: 0.0) }
        check("a layer that moves on every tick never stood still", FrameMeterStats.worstStillMs(moving) == 0)
        var oneMiss = moving
        oneMiss[10] = (t: oneMiss[10].t, x: oneMiss[9].x, y: 0)
        let one = FrameMeterStats.worstStillMs(oneMiss)
        check("one missed advance stands still for one period", abs(one - period) < 0.001, "\(one)")
        var twoMiss = oneMiss
        twoMiss[11] = (t: twoMiss[11].t, x: twoMiss[9].x, y: 0)
        let two = FrameMeterStats.worstStillMs(twoMiss)
        check("two missed advances stand still for two periods", abs(two - 2 * period) < 0.001, "\(two)")
        check("a single sample has no run", FrameMeterStats.worstStillMs([(t: 0, x: 0, y: 0)]) == 0)
    }

    func testASizeOnlyBeatAdvancesWhenItsPositionStandsStill() {
        // An origin-anchored layer that only shrinks keeps its position.
        let shrinking = (0..<30).map { (t: Double($0) * period, state: [10.0, 20.0, 600 - Double($0), 400]) }
        check("a size change is an advance", FrameMeterStats.advanceRatio(states: shrinking.map(\.state)) == 1)
        check("and is never still", FrameMeterStats.worstStillMs(states: shrinking) == 0)
        let frozen = (0..<30).map { (t: Double($0) * period, state: [10.0, 20.0, 600, 400]) }
        check("a layer that holds its size and place advanced on no tick", FrameMeterStats.advanceRatio(states: frozen.map(\.state)) == 0)
    }

    func testTheMedianIntervalIsTheSeriesOwnPeriod() {
        var ticks = series(count: 12)
        ticks.append(ticks.last! + 80)
        let median = FrameMeterStats.medianIntervalMs(ticks)
        check("one long gap does not move the median", median.map { abs($0 - period) < 0.001 } ?? false,
              "\(String(describing: median))")
        check("a single tick has no period", FrameMeterStats.medianIntervalMs([5]) == nil)
    }
}
