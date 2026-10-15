import XCTest

// The pointer rule the shell's hit-test answers with, over plain rects: a
// point over a body placed visible is the body's, a point the shell claimed is
// the shell's, a claim of everything keeps every point, and a body that is not
// visible never takes one. Plus the one coordinate flip between AppKit and the
// viewport, who gets bodies at all, and where the host's floor draws the
// deck's grid.
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

    func testTheBeatOffsetIsTheEnvironmentOverTheSettingOverTheShippedValue() {
        let harness = ["TUGAPP_TEST_SOCKET": "/tmp/s"]
        let shipped = BodyGeometry.shippedBeatOffsetPeriods
        check("with nothing set, the shipped value", BodyGeometry.beatOffsetPeriods(environment: [:], setting: nil) == shipped)
        check("the setting overrides the shipped value", BodyGeometry.beatOffsetPeriods(environment: [:], setting: 2.5) == 2.5)
        check(
            "outside the harness the variable is not read",
            BodyGeometry.beatOffsetPeriods(environment: ["TUG_BODY_BEAT_OFFSET_PERIODS": "3"], setting: 2.5) == 2.5
        )
        check(
            "under the harness it overrides the setting",
            BodyGeometry.beatOffsetPeriods(
                environment: harness.merging(["TUG_BODY_BEAT_OFFSET_PERIODS": "0"]) { $1 }, setting: 2.5
            ) == 0
        )
        check("a non-finite setting is ignored", BodyGeometry.beatOffsetPeriods(environment: [:], setting: .nan) == shipped)
        check(
            "a variable that is not a number is ignored",
            BodyGeometry.beatOffsetPeriods(
                environment: harness.merging(["TUG_BODY_BEAT_OFFSET_PERIODS": "soon"]) { $1 }, setting: nil
            ) == shipped
        )
        check("the setting's address", BodyGeometry.beatOffsetKey == "bodyBeatOffsetPeriods")
    }

    // MARK: - The floor's grid

    private func near(_ a: CGFloat, _ b: CGFloat, within: CGFloat) -> Bool { abs(a - b) <= within }

    func testTheFirstLineIsAtTheOriginAndTheSpacingIsTheScaledCell() {
        let size = CGSize(width: 1200, height: 800)
        for zoom in [1.0, 0.8, 1.25] {
            for origin in [0.0, 13.3] {
                let grid = FloorGrid(cellPx: 24, linePx: 1, zoom: zoom, originX: origin, originY: origin)
                let lines = grid.lines(in: size, scale: 2)
                let label = "zoom \(zoom) origin \(origin)"
                check("\(label): a first vertical line", lines.xs.first.map { near($0, CGFloat(origin), within: 0.25) } ?? false,
                      "\(String(describing: lines.xs.first))")
                check("\(label): a first horizontal line", lines.ys.first.map { near($0, CGFloat(origin), within: 0.25) } ?? false)
                for i in 1..<lines.xs.count {
                    let gap = lines.xs[i] - lines.xs[i - 1]
                    check("\(label): spacing \(i)", near(gap, CGFloat(24 * zoom), within: 0.5), "\(gap)")
                }
                check("\(label): every position on a device pixel",
                      (lines.xs + lines.ys).allSatisfy { ($0 * 2).rounded() == $0 * 2 })
                check("\(label): the lines reach the edge and stop inside it",
                      (lines.xs.last ?? 0) < size.width && size.width - (lines.xs.last ?? 0) <= CGFloat(24 * zoom) + 0.5)
            }
        }
    }

    func testTheLineIsTheScaledWidthAndNeverUnderOneDevicePixel() {
        let size = CGSize(width: 100, height: 100)
        check("1.0 at 2x: one point", FloorGrid(zoom: 1).lines(in: size, scale: 2).width == 1)
        check("0.8 at 2x: rounded to two device pixels", FloorGrid(zoom: 0.8).lines(in: size, scale: 2).width == 1)
        check("1.25 at 2x: rounded to three device pixels", FloorGrid(zoom: 1.25).lines(in: size, scale: 2).width == 1.5)
        check("0.3 at 1x: one device pixel, not none", FloorGrid(zoom: 0.3).lines(in: size, scale: 1).width == 1)
    }

    func testAFloorGridBodyIsRead() {
        let grid = FloorGrid.from(payload: [
            "canvas": "#16181d", "grid": "rgba(51, 102, 153, 0.784)",
            "cellPx": 24, "linePx": 1, "zoom": 1.25, "originX": 0, "originY": 3.5,
        ])
        check("it parses", grid != nil)
        check("the canvas is opaque sRGB", grid?.canvas == FloorGrid.RGBA(r: 0x16 / 255.0, g: 0x18 / 255.0, b: 0x1d / 255.0, a: 1))
        check("the grid keeps its alpha", grid?.grid == FloorGrid.RGBA(r: 51 / 255.0, g: 102 / 255.0, b: 153 / 255.0, a: 0.784))
        check("zoom and origin", grid?.zoom == 1.25 && grid?.originY == 3.5)
        check("a colour it cannot read is no grid", FloorGrid.from(payload: [
            "canvas": "oklch(0.2 0.02 280)", "grid": "#ffffff",
            "cellPx": 24, "linePx": 1, "zoom": 1, "originX": 0, "originY": 0,
        ]) == nil)
    }
}
