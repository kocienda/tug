import AppKit
import XCTest

// A rail view holds one rail's member containers: it stands at the union of
// their frames, keeps viewport coordinates for them by holding its bounds
// origin at its frame origin, and stacks among the cards at its frontmost
// member's order.
final class RailGeometryTests: XCTestCase {
    /// A stacked view standing in for a body's container.
    private final class Member: NSView, StackedView {
        let order: Int
        let serial: Int
        override var isFlipped: Bool { true }
        init(order: Int, serial: Int, frame: CGRect) {
            self.order = order
            self.serial = serial
            super.init(frame: frame)
        }
        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }
    }

    func testARailStandsAtTheUnionOfItsMembers() {
        let frames = [
            CGRect(x: 10, y: 38, width: 340, height: 300),
            CGRect(x: 10, y: 330, width: 340, height: 200),
            CGRect(x: 10, y: 522, width: 340, height: 380),
        ]
        XCTAssertEqual(RailView.union(of: frames), CGRect(x: 10, y: 38, width: 340, height: 864))
        XCTAssertEqual(RailView.union(of: []), .zero)
    }

    func testAMemberKeepsItsViewportFrameInsideTheRail() {
        // The host view is flipped, as `BodyHostView` is.
        let host = Member(order: 0, serial: 0, frame: CGRect(x: 0, y: 0, width: 1440, height: 900))
        let rail = RailView(side: .left)
        host.addSubview(rail)
        let member = Member(order: 1, serial: 1, frame: CGRect(x: 10, y: 38, width: 340, height: 300))
        rail.addSubview(member)
        rail.place(CGRect(x: 10, y: 38, width: 340, height: 864))
        XCTAssertEqual(rail.bounds.origin, rail.frame.origin)
        XCTAssertEqual(member.frame, CGRect(x: 10, y: 38, width: 340, height: 300))
        // A point of the viewport is the same point inside the rail.
        let point = CGPoint(x: 100, y: 200)
        XCTAssertEqual(rail.convert(point, from: host), point)
        // And a rail placed again, wider, keeps it so.
        rail.place(CGRect(x: 10, y: 38, width: 420, height: 864))
        XCTAssertEqual(rail.bounds.origin, CGPoint(x: 10, y: 38))
        XCTAssertEqual(rail.convert(point, from: host), point)
    }

    func testARailClipsNothingAndAnswersNoPointOfItsOwn() {
        let rail = RailView(side: .right)
        rail.place(CGRect(x: 1000, y: 38, width: 340, height: 300))
        XCTAssertFalse(rail.clipsToBounds)
        XCTAssertFalse(rail.layer?.masksToBounds ?? true)
        XCTAssertFalse(rail.isHidden)
        XCTAssertNil(rail.hitTest(CGPoint(x: 1100, y: 100)))
    }

    func testARailStacksAtItsFrontmostMemberAndOldestSerial() {
        let rail = RailView(side: .left)
        rail.addSubview(Member(order: 2, serial: 7, frame: .zero))
        rail.addSubview(Member(order: 5, serial: 4, frame: .zero))
        rail.addSubview(Member(order: 3, serial: 9, frame: .zero))
        XCTAssertEqual(rail.order, 5)
        XCTAssertEqual(rail.serial, 4)
    }

    func testRailsAndContainersSortTogetherByOrderThenSerial() {
        let host = NSView(frame: .zero)
        let front = Member(order: 9, serial: 1, frame: .zero)
        let back = Member(order: 1, serial: 2, frame: .zero)
        let rail = RailView(side: .left)
        rail.addSubview(Member(order: 4, serial: 3, frame: .zero))
        host.addSubview(front)
        host.addSubview(rail)
        host.addSubview(back)
        sortStacked(in: host)
        XCTAssertTrue(host.subviews[0] === back)
        XCTAssertTrue(host.subviews[1] === rail)
        XCTAssertTrue(host.subviews[2] === front)
    }

    // MARK: The ported arithmetic (`rail-width.test.ts`, case for case)

    private let limits = RailWidthLimits(min: 320, max: 675)

    func testClampRailWidth() {
        XCTAssertEqual(CardGeometry.clampRailWidth(360, limits: limits), 360)
        XCTAssertEqual(CardGeometry.clampRailWidth(200, limits: limits), 320)
        XCTAssertEqual(CardGeometry.clampRailWidth(900, limits: limits), 675)
    }

    func testAimBetweenTheLimitsFollowsTheHand() {
        XCTAssertEqual(CardGeometry.aimRailWidth(asked: 500, limits: limits), RailAim(width: 500, shown: 500, limit: nil))
        XCTAssertEqual(CardGeometry.aimRailWidth(asked: 675, limits: limits), RailAim(width: 675, shown: 675, limit: nil))
    }

    func testAimPastTheCeilingGivesWithDiminishingReturns() {
        let near = CardGeometry.aimRailWidth(asked: 685, limits: limits)
        let far = CardGeometry.aimRailWidth(asked: 875, limits: limits)
        XCTAssertEqual(near.width, 675)
        XCTAssertEqual(near.limit, .ceiling)
        XCTAssertGreaterThan(near.shown, 675)
        XCTAssertLessThan(near.shown, 685)
        XCTAssertGreaterThan(far.shown, near.shown)
        XCTAssertLessThan(far.shown, 675 + CardGeometry.railLimitGive)
        // The give is `give·d/(d+give)`: 48·10/58 past the ceiling.
        XCTAssertEqual(near.shown, 675 + 48 * 10 / 58, accuracy: 1e-9)
    }

    func testAimPastTheFloorGivesTheOtherWay() {
        let aim = CardGeometry.aimRailWidth(asked: 220, limits: limits)
        XCTAssertEqual(aim.width, 320)
        XCTAssertEqual(aim.limit, .floor)
        XCTAssertLessThan(aim.shown, 320)
        XCTAssertGreaterThan(aim.shown, 320 - CardGeometry.railLimitGive)
    }

    // MARK: The tracker

    private let canvas = CGRect(x: 0, y: 28, width: 1440, height: 872)

    private func tracker(
        _ side: RailSide, limits: RailWidthLimits? = nil, zoom: CGFloat = 1, others: [CGRect] = []
    ) -> RailWidthTracker {
        // A 340-wide rail: a left one's outer edge at x 10, a right one's at 1430.
        RailWidthTracker(
            side: side, startWidth: 340, pinnedEdge: side == .left ? 10 : 1430,
            startPointer: CGPoint(x: side == .left ? 350 : 1090, y: 300),
            limits: limits ?? self.limits, canvas: canvas, zoom: zoom, gap: 15, others: others
        )
    }

    func testBelowTheThresholdNothingMoves() {
        var t = tracker(.left)
        let step = t.step(pointer: CGPoint(x: 352, y: 301), alt: false)
        XCTAssertFalse(step.moved)
        XCTAssertEqual(step.aim, RailAim(width: 340, shown: 340, limit: nil))
    }

    func testALeftRailGrowsRightward() {
        var t = tracker(.left)
        XCTAssertEqual(t.step(pointer: CGPoint(x: 400, y: 300), alt: false).aim.width, 390)
        XCTAssertEqual(t.step(pointer: CGPoint(x: 330, y: 300), alt: false).aim.width, 320)
    }

    func testARightRailGrowsLeftward() {
        var t = tracker(.right)
        XCTAssertEqual(t.step(pointer: CGPoint(x: 1040, y: 300), alt: false).aim.width, 390)
        XCTAssertEqual(t.step(pointer: CGPoint(x: 1110, y: 300), alt: false).aim.width, 320)
    }

    func testTheTravelIsTakenIntoLayoutPixels() {
        var t = tracker(.left, zoom: 2)
        XCTAssertEqual(t.step(pointer: CGPoint(x: 450, y: 300), alt: false).aim.width, 390)
    }

    func testPastALimitTheAimGivesAndCommitsTheLimit() {
        var t = tracker(.left)
        let aim = t.step(pointer: CGPoint(x: 1000, y: 300), alt: false).aim
        XCTAssertEqual(aim.width, 675)
        XCTAssertEqual(aim.limit, .ceiling)
        XCTAssertGreaterThan(aim.shown, 675)
    }

    func testOptionSnapsTheExposedEdgeOneGapOffAStillPane() {
        // A free pane whose left edge is at x 420: an exposed edge within the
        // threshold of it lands one gap (15) short, at 405.
        let pane = CGRect(x: 420, y: 100, width: 300, height: 400)
        var t = tracker(.left, others: [pane])
        // Asked 406: the exposed edge at 416.
        let step = t.step(pointer: CGPoint(x: 416, y: 300), alt: true)
        XCTAssertEqual(step.aim, RailAim(width: 395, shown: 395, limit: nil))
        XCTAssertEqual(step.snapX, 405)
        // Without Option it follows the hand.
        var free = tracker(.left, others: [pane])
        XCTAssertEqual(free.step(pointer: CGPoint(x: 416, y: 300), alt: false).aim.width, 406)
    }

    func testASnapNeverLandsPastALimit() {
        let pane = CGRect(x: 420, y: 100, width: 300, height: 400)
        var t = tracker(.left, limits: RailWidthLimits(min: 400, max: 675), others: [pane])
        let step = t.step(pointer: CGPoint(x: 416, y: 300), alt: true)
        XCTAssertEqual(step.aim, RailAim(width: 400, shown: 400, limit: nil))
    }

    /// A left rail's ghost keeps its outer (left) edge and moves its
    /// deck-facing (right) edge with the aim, at the full height of the
    /// members' union; it narrows to nothing, never past it.
    func testALeftRailsGhostGrowsAtItsRightEdge() {
        let panes = CGRect(x: 10, y: 38, width: 300, height: 700)
        XCTAssertEqual(RailView.ghostFrame(side: .left, panes: panes, growth: 40), CGRect(x: 10, y: 38, width: 340, height: 700))
        XCTAssertEqual(RailView.ghostFrame(side: .left, panes: panes, growth: -60), CGRect(x: 10, y: 38, width: 240, height: 700))
        XCTAssertEqual(RailView.ghostFrame(side: .left, panes: panes, growth: -400), CGRect(x: 10, y: 38, width: 0, height: 700))
    }

    /// A right rail's ghost keeps its outer (right) edge and moves its
    /// deck-facing (left) edge with the aim.
    func testARightRailsGhostGrowsAtItsLeftEdge() {
        let panes = CGRect(x: 1100, y: 38, width: 330, height: 700)
        XCTAssertEqual(RailView.ghostFrame(side: .right, panes: panes, growth: 40), CGRect(x: 1060, y: 38, width: 370, height: 700))
        XCTAssertEqual(RailView.ghostFrame(side: .right, panes: panes, growth: -30), CGRect(x: 1130, y: 38, width: 300, height: 700))
        XCTAssertEqual(RailView.ghostFrame(side: .right, panes: panes, growth: -400), CGRect(x: 1430, y: 38, width: 0, height: 700))
    }

    /// The ghost stands in the host view, not the rail, above every card's
    /// container whatever their stacking, and answers no point; removed, it
    /// stands nowhere and wears no limit.
    func testTheGhostStandsAboveEveryCardInTheHostView() {
        let host = Member(order: 0, serial: 0, frame: CGRect(x: 0, y: 0, width: 1440, height: 900))
        let rail = RailView(side: .left)
        host.addSubview(rail)
        let card = Member(order: 9, serial: 9, frame: CGRect(x: 320, y: 38, width: 600, height: 700))
        host.addSubview(card)
        rail.ghost.pastLimit = true
        rail.standGhost(CGRect(x: 10, y: 38, width: 360, height: 700), in: host)
        XCTAssertTrue(rail.ghost.superview === host)
        XCTAssertEqual(rail.ghost.frame, CGRect(x: 10, y: 38, width: 360, height: 700))
        XCTAssertGreaterThan(rail.ghost.layer?.zPosition ?? 0, card.layer?.zPosition ?? 0)
        XCTAssertNil(rail.ghost.hitTest(CGPoint(x: 20, y: 40)))
        sortStacked(in: host)
        XCTAssertTrue(rail.ghost.superview === host)
        rail.removeGhost()
        XCTAssertNil(rail.ghost.superview)
        XCTAssertFalse(rail.ghost.pastLimit)
    }

    /// The spring's curve is CSS's `cubic-bezier`: it starts at 0, ends at
    /// 1, rises throughout, and `(0.33, 1, 0.68, 1)` is well past half way
    /// at half time.
    func testTheSpringCurveIsCSSsCubicBezier() {
        let at = { (t: Double) in CardGeometry.cubicBezier(t, x1: 0.33, y1: 1, x2: 0.68, y2: 1) }
        XCTAssertEqual(at(0), 0)
        XCTAssertEqual(at(1), 1)
        let samples = stride(from: 0.0, through: 1.0, by: 0.05).map(at)
        XCTAssertEqual(samples, samples.sorted())
        XCTAssertGreaterThan(at(0.5), 0.8)
        // The linear curve is the identity.
        XCTAssertEqual(CardGeometry.cubicBezier(0.3, x1: 0, y1: 0, x2: 1, y2: 1), 0.3, accuracy: 1e-6)
    }

    func testACarriedCardIsNeverASnapTarget() {
        let member = RailMembership(side: .left, index: 0)
        let other = RailMembership(side: .right, index: 0)
        let targets = CardGeometry.railSnapTargets(side: .left, [
            .init(rect: CGRect(x: 10, y: 38, width: 340, height: 300), visible: true, sibling: false, rail: member),
            .init(rect: CGRect(x: 365, y: 38, width: 400, height: 800), visible: true, sibling: false,
                  travel: .fit(fraction: 0, slotWidth: 400)),
            .init(rect: CGRect(x: 1090, y: 38, width: 340, height: 300), visible: true, sibling: false, rail: other),
            .init(rect: CGRect(x: 800, y: 500, width: 200, height: 200), visible: true, sibling: false),
            .init(rect: CGRect(x: 800, y: 500, width: 200, height: 200), visible: true, sibling: true),
            .init(rect: CGRect(x: 600, y: 100, width: 200, height: 200), visible: false, sibling: false),
        ])
        XCTAssertEqual(targets, [CGRect(x: 1090, y: 38, width: 340, height: 300), CGRect(x: 800, y: 500, width: 200, height: 200)])
    }
}
