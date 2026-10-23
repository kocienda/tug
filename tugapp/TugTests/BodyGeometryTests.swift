import XCTest

// The one coordinate flip between AppKit and the viewport, and how long a
// body has to report ready. The pointer rule is `CardGeometryTests`.
final class BodyGeometryTests: XCTestCase {
    private let body = CGRect(x: 200, y: 100, width: 400, height: 300)

    func testTheFlipRoundTrips() {
        let height: CGFloat = 900
        let point = CGPoint(x: 40, y: 700)
        check("a point flips", BodyGeometry.flipped(point, inHeight: height) == CGPoint(x: 40, y: 200))
        check("and flips back", BodyGeometry.flipped(BodyGeometry.flipped(point, inHeight: height), inHeight: height) == point)
        let flipped = BodyGeometry.flipped(body, inHeight: height)
        check("a rect's top-left becomes its bottom-left", flipped == CGRect(x: 200, y: 500, width: 400, height: 300))
        check("and flips back", BodyGeometry.flipped(flipped, inHeight: height) == body)
    }

    func testTheReadyDeadlineIsTheHarnessesWhenItSetsOne() {
        check("the decided deadline", BodyGeometry.readyDeadlineMs(harness: nil, fallback: 10_000) == 10_000)
        check("the harness shortens it", BodyGeometry.readyDeadlineMs(harness: 1500, fallback: 10_000) == 1500)
        check("a fraction is whole milliseconds", BodyGeometry.readyDeadlineMs(harness: 1500.7, fallback: 10_000) == 1500)
        for low in [0.0, -5, 0.4] {
            check("\(low) is held to a millisecond", BodyGeometry.readyDeadlineMs(harness: low, fallback: 10_000) == 1)
        }
    }
}
