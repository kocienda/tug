import XCTest

// Which points of a card's view are the card's — the pane rect, and the
// apron only along the edges the pane offers as grips — and where a drag or a
// grip resize the host tracks takes the card: the deck's own clamp, resize and
// snap, ported exactly. The snap cases are `tugdeck/src/__tests__/snap.test.ts`'s,
// same inputs and same outputs.
final class CardGeometryTests: XCTestCase {
    private let pane = CGRect(x: 100, y: 100, width: 400, height: 300)

    // MARK: - The apron

    func testThePaneRectIsTheCardsWhateverItsGrips() {
        let shape = CardHitShape(paneRect: pane, grips: [])
        check("inside the pane rect", shape.contains(CGPoint(x: 300, y: 250)))
        check("its top-left point", shape.contains(CGPoint(x: 100, y: 100)))
        check("past the apron", !shape.contains(CGPoint(x: 300, y: 90)))
        check("the view is the pane outset by the apron", shape.viewRect == CGRect(x: 90, y: 90, width: 420, height: 320))
    }

    func testTheApronIsTheCardsAlongAGrippedEdgeOnly() {
        let shape = CardHitShape(paneRect: pane, grips: [.w])
        check("in the gripped west apron", shape.contains(CGPoint(x: 97, y: 250)))
        check("in the ungripped east apron", !shape.contains(CGPoint(x: 503, y: 250)))
        check("in the ungripped north apron", !shape.contains(CGPoint(x: 300, y: 97)))
    }

    func testTheApronPastTheGripReachIsPaintNotTheCards() {
        // The apron reaches 10 points, room for a rail's shadow; a press on
        // a gripped edge is the card's only within 6 of the pane.
        let shape = CardHitShape(paneRect: pane, grips: [.w])
        check("within the grip reach", shape.contains(CGPoint(x: 95, y: 250)))
        check("past the grip reach, inside the view", !shape.contains(CGPoint(x: 92, y: 250)))
        check("the point is inside the view", shape.viewRect.contains(CGPoint(x: 92, y: 250)))
    }

    func testACornerIsTheCardsOnlyWithItsGripOrBothEdgesBesideIt() {
        let oneEdge = CardHitShape(paneRect: pane, grips: [.n])
        check("a corner with one adjoining edge gripped", !oneEdge.contains(CGPoint(x: 97, y: 97)))
        let bothEdges = CardHitShape(paneRect: pane, grips: [.n, .w])
        check("a corner with both adjoining edges gripped", bothEdges.contains(CGPoint(x: 97, y: 97)))
        let corner = CardHitShape(paneRect: pane, grips: [.nw])
        check("a corner with its own grip", corner.contains(CGPoint(x: 97, y: 97)))
        check("but not the edges beside it", !corner.contains(CGPoint(x: 300, y: 97)))
    }

    // MARK: - Drag and resize

    func testAClampIsRelaxedToAStartOutsideTheEnvelope() {
        let canvas = CGSize(width: 1000, height: 800)
        // A card resting past the right bound (900 = 1000 - 100): a grab moves
        // it by the hand's travel, and never further out.
        let start = CGPoint(x: 950, y: 200)
        let inward = CardGeometry.clampedPosition(
            pointer: CGPoint(x: 480, y: 500), startPointer: CGPoint(x: 500, y: 500),
            startPosition: start, canvasSize: canvas, frameSize: CGSize(width: 400, height: 300)
        )
        check("it comes inward freely", inward == CGPoint(x: 930, y: 200), "\(inward)")
        let outward = CardGeometry.clampedPosition(
            pointer: CGPoint(x: 600, y: 500), startPointer: CGPoint(x: 500, y: 500),
            startPosition: start, canvasSize: canvas, frameSize: CGSize(width: 400, height: 300)
        )
        check("it is held where it started", outward.x == 950, "\(outward)")
        let up = CardGeometry.clampedPosition(
            pointer: CGPoint(x: 500, y: 0), startPointer: CGPoint(x: 500, y: 500),
            startPosition: CGPoint(x: 100, y: 200), canvasSize: canvas, frameSize: CGSize(width: 400, height: 300)
        )
        check("its title bar stays below the canvas's top padding", up.y == CardGeometry.canvasPadding, "\(up)")
    }

    func testAResizeRespectsItsMinimum() {
        let start = CGRect(x: 100, y: 100, width: 400, height: 300)
        let r = CardGeometry.resizeDelta(
            pointer: CGPoint(x: 100, y: 100), startPointer: CGPoint(x: 500, y: 400),
            start: start, edge: .se, minSize: CGSize(width: 250, height: 200), canvasSize: CGSize(width: 1000, height: 800)
        )
        check("held at the floor", r == CGRect(x: 100, y: 100, width: 250, height: 200), "\(r)")
        let west = CardGeometry.resizeDelta(
            pointer: CGPoint(x: 400, y: 0), startPointer: CGPoint(x: 100, y: 0),
            start: start, edge: .w, minSize: CGSize(width: 250, height: 200), canvasSize: nil
        )
        check("a west resize keeps its right edge", west == CGRect(x: 250, y: 100, width: 250, height: 300), "\(west)")
    }

    func testAPressBelowTheThresholdMovesNothing() {
        var tracker = CardGestureTracker(
            kind: .move, startRect: pane, startPointer: CGPoint(x: 200, y: 110),
            canvas: CGRect(x: 0, y: 0, width: 1200, height: 900), minSize: .zero, free: true, gap: 15, others: []
        )
        let still = tracker.step(pointer: CGPoint(x: 202, y: 111), alt: false)
        check("a click stands still", still == CardGestureTracker.Step(rect: pane, moved: false), "\(still)")
        let moved = tracker.step(pointer: CGPoint(x: 250, y: 130), alt: false)
        check("a drag moves by the hand's travel", moved.rect == pane.offsetBy(dx: 50, dy: 20) && moved.moved, "\(moved)")
    }

    func testAResizeHeldPastItsRunsEndStandsThere() {
        // A card holding a height in its slot, its top at its run's: the
        // run is 820 tall and ends at 860, a gap above the canvas's own end.
        let start = CGRect(x: 40, y: 40, width: 560, height: 400)
        var tracker = CardGestureTracker(
            kind: .resize(.s), startRect: start, startPointer: CGPoint(x: 300, y: 440),
            canvas: CGRect(x: 0, y: 0, width: 1200, height: 900),
            minSize: CGSize(width: 400, height: 145), maxSize: CGSize(width: CGFloat.greatestFiniteMagnitude, height: 820),
            free: false, gap: 15, others: []
        )
        let past = tracker.step(pointer: CGPoint(x: 300, y: 899), alt: false)
        check("the bottom edge stands at the run's end", past.rect == CGRect(x: 40, y: 40, width: 560, height: 820), "\(past)")
        let short = tracker.step(pointer: CGPoint(x: 300, y: 340), alt: false)
        check("short of it, the edge is under the hand", short.rect.height == 300, "\(short)")
    }

    // MARK: - Snap parity

    private func snap(_ moving: CGRect, _ others: [CGRect], bw: CGFloat = 0) -> SnapResult {
        CardGeometry.computeSnap(moving: moving, others: others, borderWidth: bw)
    }

    func testComputeSnapParity() {
        var r = snap(CGRect(x: 200, y: 0, width: 200, height: 300), [CGRect(x: 405, y: 500, width: 200, height: 300)])
        check("right edge within 8 of a left edge snaps", r.x == 205 && r.y == nil && r.guides.first?.position == 405, "\(r)")
        r = snap(CGRect(x: 200, y: 0, width: 200, height: 300), [CGRect(x: 420, y: 500, width: 200, height: 300)])
        check("beyond 8 does not", r.x == nil && r.y == nil && r.guides.isEmpty, "\(r)")
        r = snap(CGRect(x: 100, y: 100, width: 200, height: 200), [CGRect(x: 305, y: 94, width: 200, height: 200)])
        check("x and y snap independently", r.x == 105 && r.y == 94 && r.guides.count == 2, "\(r)")
        r = snap(CGRect(x: 100, y: 100, width: 200, height: 200), [])
        check("no others, no snap", r.x == nil && r.y == nil && r.guides.isEmpty)
        r = snap(CGRect(x: 200, y: 0, width: 200, height: 100), [CGRect(x: 403, y: 0, width: 100, height: 100), CGRect(x: 407, y: 0, width: 100, height: 100)])
        check("the closest candidate wins", r.x == 203, "\(r)")
        r = snap(CGRect(x: 200, y: 0, width: 200, height: 100), [CGRect(x: 402, y: 0, width: 200, height: 100)], bw: 1)
        check("right to left overlaps by the border", r.x == 203, "\(r)")
        r = snap(CGRect(x: 198, y: 0, width: 200, height: 100), [CGRect(x: 0, y: 0, width: 200, height: 100)], bw: 1)
        check("left to right overlaps by the border", r.x == 199, "\(r)")
        r = snap(CGRect(x: 0, y: 100, width: 100, height: 200), [CGRect(x: 0, y: 302, width: 100, height: 200)], bw: 1)
        check("bottom to top overlaps by the border", r.y == 103, "\(r)")
        r = snap(CGRect(x: 0, y: 298, width: 100, height: 200), [CGRect(x: 0, y: 0, width: 100, height: 300)], bw: 1)
        check("top to bottom overlaps by the border", r.y == 299, "\(r)")
    }

    func testComputeSnapValidatorParity() {
        let moving = CGRect(x: 200, y: 0, width: 200, height: 300)
        let stationary = CGRect(x: 405, y: 0, width: 200, height: 300)
        var r = CardGeometry.computeSnap(moving: moving, others: [stationary], validate: { axis, _, _, _ in axis != .x })
        check("a validator can reject a candidate", r.x == nil, "\(r)")
        r = CardGeometry.computeSnap(moving: moving, others: [stationary], validate: { _, _, _, _ in true })
        check("a validator can allow it", r.x == 205, "\(r)")
        r = CardGeometry.computeSnap(
            moving: CGRect(x: 200, y: 0, width: 200, height: 100),
            others: [CGRect(x: 403, y: 0, width: 100, height: 100), CGRect(x: 407, y: 0, width: 100, height: 100)],
            validate: { _, _, _, index in index != 0 }
        )
        check("a rejected best falls back to the next", r.x == 207, "\(r)")
    }

    func testComputeResizeSnapParity() {
        let other = CGRect(x: 400, y: 0, width: 200, height: 300)
        var r = CardGeometry.computeResizeSnap(ResizeEdges(right: 398), others: [other])
        check("right to a left edge", r.edges == ResizeEdges(right: 400) && r.guides.first?.position == 400, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(right: 380), others: [other])
        check("beyond the threshold", r.edges == ResizeEdges() && r.guides.isEmpty, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(top: 102, right: 398), others: [CGRect(x: 400, y: 100, width: 200, height: 300)])
        check("edges snap independently", r.edges.top == 100 && r.edges.right == 400, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(left: 203), others: [CGRect(x: 0, y: 0, width: 200, height: 300)])
        check("left to a right edge", r.edges.left == 200, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(), others: [other])
        check("no edges, nothing", r.edges == ResizeEdges() && r.guides.isEmpty)
        r = CardGeometry.computeResizeSnap(ResizeEdges(right: 398), others: [other], borderWidth: 1)
        check("adjacent right overlaps by the border, guide at the edge", r.edges.right == 401 && r.guides.first?.position == 400, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(right: 398), others: [CGRect(x: 200, y: 0, width: 200, height: 300)], borderWidth: 1)
        check("same-edge right has no offset", r.edges.right == 400, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(left: 202), others: [CGRect(x: 0, y: 0, width: 200, height: 300)], borderWidth: 1)
        check("adjacent left overlaps by the border", r.edges.left == 199 && r.guides.first?.position == 200, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(bottom: 398), others: [CGRect(x: 0, y: 400, width: 200, height: 200)], borderWidth: 1)
        check("adjacent bottom overlaps by the border", r.edges.bottom == 401 && r.guides.first?.position == 400, "\(r)")
        r = CardGeometry.computeResizeSnap(ResizeEdges(top: 202), others: [CGRect(x: 0, y: 0, width: 200, height: 200)], borderWidth: 1)
        check("adjacent top overlaps by the border", r.edges.top == 199 && r.guides.first?.position == 200, "\(r)")
        let zero = CardGeometry.computeResizeSnap(ResizeEdges(right: 398), others: [other], borderWidth: 0)
        check("a zero border is no border", zero.edges.right == 400)
    }

    func testComputeEdgeVisibilityParity() {
        func vis(_ at: CGFloat, _ s: CGFloat, _ e: CGFloat, _ vertical: Bool, _ occluders: [CGRect]) -> CGFloat {
            CardGeometry.computeEdgeVisibility(edgePosition: at, rangeStart: s, rangeEnd: e, isVerticalEdge: vertical, occluders: occluders)
        }
        check("no occluders", vis(200, 0, 300, true, []) == 1)
        check("an occluder beside the edge", vis(200, 0, 300, true, [CGRect(x: 250, y: 0, width: 200, height: 300)]) == 1)
        check("fully covered", vis(200, 0, 300, true, [CGRect(x: 100, y: 0, width: 300, height: 300)]) == 0)
        check("half covered", abs(vis(200, 0, 300, true, [CGRect(x: 100, y: 0, width: 300, height: 150)]) - 0.5) < 1e-5)
        check("overlaps merge", vis(200, 0, 300, true, [CGRect(x: 100, y: 0, width: 200, height: 200), CGRect(x: 100, y: 100, width: 200, height: 200)]) == 0)
        check("a horizontal edge", abs(vis(200, 0, 400, false, [CGRect(x: 0, y: 100, width: 200, height: 200)]) - 0.5) < 1e-5)
        check("a zero-length range", vis(200, 100, 100, true, []) == 0)
    }

    // MARK: - Which card a point is

    private let body = CGRect(x: 200, y: 100, width: 400, height: 300)

    func testAPointInsideAVisibleFramePassesThrough() {
        let region = CardHitRegion(visibleFrames: [body])
        check("inside the card", region.passesThrough(CGPoint(x: 300, y: 200)))
        check("outside it", !region.passesThrough(CGPoint(x: 100, y: 200)))
        check("the frame index names the card", region.frameIndex(at: CGPoint(x: 300, y: 200)) == 0)
    }

    func testAGripOverACardKeepsThePointInTheShell() {
        // The pane's bottom handle: 8 points tall, half inside the frame.
        let grip = CGRect(x: 208, y: 396, width: 384, height: 8)
        let region = CardHitRegion(visibleFrames: [body], visibleGrips: [[grip]])
        check("on the grip's inner half", !region.passesThrough(CGPoint(x: 300, y: 398)))
        check("in the card above the grip", region.passesThrough(CGPoint(x: 300, y: 390)))
        // A front pane's handle hanging over the card behind it is the front
        // pane's, as it is in a document where the handle is above that card.
        let back = CGRect(x: 0, y: 0, width: 800, height: 600)
        let stacked = CardHitRegion(visibleFrames: [body, back], visibleGrips: [[grip], []])
        check("the grip's outer half over the back card", !stacked.passesThrough(CGPoint(x: 300, y: 402)))
        check("the back card beside it", stacked.frameIndex(at: CGPoint(x: 50, y: 50)) == 1)
    }

    func testAWholeCardAnswersByItsHitShapeAndLetsTheUngrippedApronFallThrough() {
        // A whole card's view: the pane at (100, 100, 300, 200), outset by 6.
        let view = CGRect(x: 94, y: 94, width: 312, height: 212)
        let shape = CardHitShape(paneRect: view.insetBy(dx: 6, dy: 6), apron: 6, grips: [.e])
        let behind = CGRect(x: 0, y: 0, width: 800, height: 600)
        let region = CardHitRegion(visibleFrames: [view, behind], visibleShapes: [shape, nil])
        // Inside the pane: the card's.
        XCTAssertEqual(region.frameIndex(at: CGPoint(x: 200, y: 200)), 0)
        // The gripped east apron: the card's, its grip its own page's DOM.
        XCTAssertEqual(region.frameIndex(at: CGPoint(x: 403, y: 200)), 0)
        // The ungripped north apron: whatever is beneath the view.
        XCTAssertEqual(region.frameIndex(at: CGPoint(x: 200, y: 97)), 1)
    }

    func testAShellSeamOverAWholeCardIsTheShells() {
        // A rail member's view, and the shell's seam lying across its foot.
        let view = CGRect(x: 94, y: 94, width: 312, height: 212)
        let shape = CardHitShape(paneRect: view.insetBy(dx: 6, dy: 6), apron: 6, grips: [.e])
        let seam = CGRect(x: 100, y: 296, width: 300, height: 8)
        let region = CardHitRegion(visibleFrames: [view], visibleGrips: [[seam]], visibleShapes: [shape])
        XCTAssertNil(region.frameIndex(at: CGPoint(x: 200, y: 298)), "a point on the seam is the shell's")
        XCTAssertEqual(region.frameIndex(at: CGPoint(x: 200, y: 200)), 0, "the card keeps the rest of its pane")
    }

    func testAHiddenFrameNeverPassesThrough() {
        // A hidden card is not in `visibleFrames`; that is the whole of how
        // the region knows it is hidden.
        let region = CardHitRegion(visibleFrames: [])
        check("a hidden card's point is the shell's", !region.passesThrough(CGPoint(x: 300, y: 200)))
    }

    private func claim(_ json: String) -> CardHitRegion.Claim? {
        try? JSONDecoder().decode(CardHitRegion.Claim.self, from: Data(json.utf8))
    }

    func testTheClaimPayloadReadsItsThreeForms() {
        check("all", claim(#"{"all":true}"#) == .all)
        check("an empty list is no claim", claim(#"{"rects":[]}"#) == CardHitRegion.Claim.none)
        check("rects", claim(#"{"rects":[{"x":1,"y":2,"width":3,"height":4}]}"#) == .rects([CGRect(x: 1, y: 2, width: 3, height: 4)]))
        // A claim is refused whole rather than read in part: a rect the host
        // dropped would be a surface the pointer passed through.
        check("an unreadable rect refuses the claim", claim(#"{"rects":[{"x":1,"y":2,"width":3,"height":4},{"x":"bad"}]}"#) == nil)
        check("neither form is refused", claim(#"{"all":false}"#) == nil)
    }
}
