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

    func testTravelOfAFitCard() {
        let start = RailTravelBand(band: 1000, flow: nil)
        func shift(_ fraction: Double, _ slot: Double, _ side: RailSide, _ growth: CGFloat) -> CGFloat {
            CardGeometry.railTravelShift(.fit(fraction: fraction, slotWidth: slot), side: side, start: start, growth: growth)
        }
        // A left rail carries a slot-0 card by the whole growth.
        XCTAssertEqual(shift(0, 300, .left, 60), 60)
        XCTAssertEqual(shift(0, 300, .left, -40), -40)
        // A last-slot card stands still under a left rail.
        XCTAssertEqual(shift(1, 300, .left, 60), 0)
        // Under a right rail a card moves by its fraction of the slack lost.
        XCTAssertEqual(shift(0.5, 300, .right, 60), -30)
        XCTAssertEqual(shift(0.5, 300, .right, -60), 30)
        // A card nearly the band's width holds at the near edge.
        XCTAssertEqual(shift(1, 990, .right, 60), -10)
    }

    func testTravelOnFlow() {
        let start = RailTravelBand(band: 1000, flow: .init(offset: 380, strip: 1400))
        func shift(_ side: RailSide, _ growth: CGFloat) -> CGFloat {
            CardGeometry.railTravelShift(.flow, side: side, start: start, growth: growth)
        }
        XCTAssertEqual(shift(.left, 60), 60)
        XCTAssertEqual(shift(.left, -60), -60 + 40)
        XCTAssertEqual(shift(.right, 60), 0)
        XCTAssertEqual(shift(.right, -60), 40)
    }

    func testTravelFromABandOfNoWidth() {
        let covered = RailTravelBand(band: -200, flow: nil)
        XCTAssertEqual(CardGeometry.railTravelShift(.fit(fraction: 0.5, slotWidth: 300), side: .right, start: covered, growth: -100), 0)
        XCTAssertEqual(CardGeometry.railTravelShift(.fit(fraction: 0.5, slotWidth: 300), side: .right, start: covered, growth: -600), 50)
        XCTAssertEqual(CardGeometry.railTravelShift(.fit(fraction: 0, slotWidth: 300), side: .left, start: covered, growth: -600), -600)
        let flow = RailTravelBand(band: -200, flow: .init(offset: 380, strip: 1400))
        XCTAssertEqual(CardGeometry.railTravelShift(.flow, side: .right, start: flow, growth: -600), 0)
        XCTAssertEqual(CardGeometry.railTravelShift(.flow, side: .right, start: flow, growth: -1300), 80)
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

    /// A right rail carrying a drag lays its crossing member out from the one
    /// frame the hand writes: the member widens at its deck-facing (left)
    /// edge, the page stands still at the outer edge, and the strip and the
    /// page's mask meet where the pane's edge or the page's own border,
    /// whichever is further out, less the border's width.
    func testARailCarryingADragLaysItsCrossingOut() throws {
        let host = Member(order: 0, serial: 0, frame: CGRect(x: 0, y: 0, width: 1440, height: 900))
        let rail = RailView(side: .right)
        host.addSubview(rail)
        let member = RailMemberView(frame: .zero)
        member.wantsLayer = true
        rail.addSubview(member)
        member.frame = CGRect(x: 1000, y: 38, width: 340, height: 300)
        let page = NSView(frame: member.bounds)
        page.wantsLayer = true
        page.autoresizingMask = [.minXMargin]
        member.addSubview(page)
        rail.place(CGRect(x: 1000, y: 38, width: 340, height: 300))
        let crossing = RailCrossing(side: .right, insets: CardInsets(top: 10, right: 10, bottom: 10, left: 10), page: page)
        crossing.colors = try JSONDecoder().decode(RailEdgeColors.self, from: Data(#"""
            {"surface":[28,30,34,255],"rest":[60,64,70,255],"held":[70,130,230,255],"limit":[230,160,60,255],
             "width":1,"shadow":[0,0,0,102],"reach":10}
            """#.utf8))
        crossing.strip.edgeWidth = 1
        member.railCrossing = crossing
        rail.carriesDrag = true

        // Grown by 40 at the deck-facing edge.
        rail.place(CGRect(x: 960, y: 38, width: 380, height: 300))
        XCTAssertEqual(member.frame, CGRect(x: 960, y: 38, width: 380, height: 300))
        XCTAssertEqual(page.frame, CGRect(x: 40, y: 0, width: 340, height: 300))
        XCTAssertEqual(crossing.strip.frame, CGRect(x: 10, y: 10, width: 41, height: 280))
        XCTAssertEqual(crossing.mask.frame, CGRect(x: 11, y: 0, width: 329, height: 300))

        // Narrowed by 40 past where it started.
        rail.place(CGRect(x: 1040, y: 38, width: 300, height: 300))
        XCTAssertEqual(member.frame, CGRect(x: 1040, y: 38, width: 300, height: 300))
        XCTAssertEqual(page.frame.minX, -40)
        XCTAssertEqual(crossing.strip.frame, CGRect(x: 10, y: 10, width: 1, height: 280))
        XCTAssertEqual(crossing.mask.frame, CGRect(x: 51, y: 0, width: 289, height: 300))

        // Carrying nothing, a placement of the rail moves no member.
        rail.carriesDrag = false
        rail.place(CGRect(x: 1000, y: 38, width: 340, height: 300))
        XCTAssertEqual(member.frame, CGRect(x: 1040, y: 38, width: 300, height: 300))
        member.railCrossing = nil
        XCTAssertNil(crossing.strip.superview)
        XCTAssertNil(page.layer?.mask)
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
