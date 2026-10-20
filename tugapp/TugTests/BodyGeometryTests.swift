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

    func testTheReadyDeadlineIsShortenedOnlyUnderTheHarness() {
        let harness = ["TUGAPP_TEST_SOCKET": "/tmp/s"]
        check("the decided deadline", BodyGeometry.readyDeadlineMs(environment: [:], fallback: 10_000) == 10_000)
        check(
            "outside the harness the variable is not read",
            BodyGeometry.readyDeadlineMs(environment: ["TUG_BODY_READY_DEADLINE_MS": "1500"], fallback: 10_000) == 10_000
        )
        check(
            "under the harness it shortens the deadline",
            BodyGeometry.readyDeadlineMs(
                environment: harness.merging(["TUG_BODY_READY_DEADLINE_MS": "1500"]) { $1 },
                fallback: 10_000
            ) == 1500
        )
        for bad in ["", "soon", "0", "-5", "1.5"] {
            check(
                "\"\(bad)\" is ignored",
                BodyGeometry.readyDeadlineMs(
                    environment: harness.merging(["TUG_BODY_READY_DEADLINE_MS": bad]) { $1 },
                    fallback: 10_000
                ) == 10_000
            )
        }
    }
}
