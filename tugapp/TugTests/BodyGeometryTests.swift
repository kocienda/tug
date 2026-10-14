import XCTest

// The pointer rule the shell's hit-test answers with, over plain rects: a
// point over a body placed visible is the body's, a point the shell claimed is
// the shell's, a claim of everything keeps every point, and a body that is not
// visible never takes one. Plus the one coordinate flip between AppKit and the
// viewport, and who gets bodies at all.
final class BodyGeometryTests: XCTestCase {
    private let body = CGRect(x: 200, y: 100, width: 400, height: 300)

    func testAPointInsideAVisibleFramePassesThrough() {
        let region = BodyHitRegion(visibleFrames: [body], claim: .none)
        check("inside the body", region.passesThrough(CGPoint(x: 300, y: 200)))
        check("outside it", !region.passesThrough(CGPoint(x: 100, y: 200)))
        check("the frame index names the body", region.frameIndex(at: CGPoint(x: 300, y: 200)) == 0)
    }

    func testAClaimedRectKeepsThePointInTheShell() {
        let sheet = CGRect(x: 250, y: 150, width: 100, height: 100)
        let region = BodyHitRegion(visibleFrames: [body], claim: .rects([sheet]))
        check("inside the claim", !region.passesThrough(CGPoint(x: 300, y: 200)))
        check("in the body beside the claim", region.passesThrough(CGPoint(x: 500, y: 350)))
        check("no frame index under a claim", region.frameIndex(at: CGPoint(x: 300, y: 200)) == nil)
    }

    func testClaimingAllKeepsEveryPoint() {
        let region = BodyHitRegion(visibleFrames: [body], claim: .all)
        check("nothing passes through", !region.passesThrough(CGPoint(x: 300, y: 200)))
    }

    func testAHiddenFrameNeverPassesThrough() {
        // A hidden body is not in `visibleFrames`; that is the whole of how
        // the region knows it is hidden.
        let region = BodyHitRegion(visibleFrames: [], claim: .none)
        check("a hidden body's point is the shell's", !region.passesThrough(CGPoint(x: 300, y: 200)))
    }

    func testTheClaimPayloadReadsItsThreeForms() {
        check("all", BodyHitRegion.claim(fromPayload: ["all": true]) == .all)
        check("an empty list is no claim", BodyHitRegion.claim(fromPayload: ["rects": [] as [Any]]) == .none)
        let rects = BodyHitRegion.claim(fromPayload: [
            "rects": [["x": 1, "y": 2, "width": 3, "height": 4], ["x": "bad"]],
        ])
        check("rects, an unreadable one dropped", rects == .rects([CGRect(x: 1, y: 2, width: 3, height: 4)]))
    }

    func testTheFlipRoundTrips() {
        let height: CGFloat = 900
        let point = CGPoint(x: 40, y: 700)
        check("a point flips", BodyGeometry.flipped(point, inHeight: height) == CGPoint(x: 40, y: 200))
        check("and flips back", BodyGeometry.flipped(BodyGeometry.flipped(point, inHeight: height), inHeight: height) == point)
        let flipped = BodyGeometry.flipped(body, inHeight: height)
        check("a rect's top-left becomes its bottom-left", flipped == CGRect(x: 200, y: 500, width: 400, height: 300))
        check("and flips back", BodyGeometry.flipped(flipped, inHeight: height) == body)
    }

    func testBodiesFollowTheSettingAndTheHarnessCanAskForThem() {
        let harness = ["TUGAPP_TEST_SOCKET": "/tmp/s"]
        check("off unless the setting is on", !BodyGeometry.bodyViewsEnabled(environment: [:], setting: false))
        check("on when the setting is on", BodyGeometry.bodyViewsEnabled(environment: [:], setting: true))
        check(
            "outside the harness the variable is not read",
            !BodyGeometry.bodyViewsEnabled(environment: ["TUG_BODY_VIEWS": "1"], setting: false)
        )
        check("under the harness, off", !BodyGeometry.bodyViewsEnabled(environment: harness, setting: false))
        check(
            "under the harness, on when asked",
            BodyGeometry.bodyViewsEnabled(environment: harness.merging(["TUG_BODY_VIEWS": "1"]) { $1 }, setting: false)
        )
        check("under the harness, on when the setting is seeded", BodyGeometry.bodyViewsEnabled(environment: harness, setting: true))
        check("the setting's address", BodyGeometry.bodyViewsDomain == "dev.tugapp.deck" && BodyGeometry.bodyViewsKey == "bodies")
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
