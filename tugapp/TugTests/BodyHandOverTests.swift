import AppKit
import XCTest

// The host's hand-over plan: a view on screen that a placement no longer
// shows is leaving, a leaving view that meets a card the shell marked `face`
// is handed over, and only then is every face drawn. And the title band's
// ink, read off a face's crop, tells a stand-in's title from a blank band.
final class BodyHandOverTests: XCTestCase {
    /// One placement entry, decoded the way the shell's JSON arrives.
    /// A face carries the display list the host draws it from unless `drawn` is false.
    private func entry(_ cardId: String, _ rect: CGRect, visible: Bool, face: Bool = false, drawn: Bool = true) throws -> CardPlacementEntry {
        let json = """
            {"cardId":"\(cardId)","x":\(rect.minX + 8),"y":\(rect.minY + 8),"width":\(rect.width - 16),"height":\(rect.height - 16),
             "view":{"x":\(rect.minX),"y":\(rect.minY),"width":\(rect.width),"height":\(rect.height)},
             "insets":{"top":8,"right":8,"bottom":8,"left":8},"shell":[],"visible":\(visible),
             \(face ? "\"face\":true," : "")\(face && drawn ? "\"faceDraw\":{\"boxes\":[],\"texts\":[],\"images\":[]}," : "")
             "z":1,"grips":[],"free":false,"min":{"width":0,"height":0}}
            """
        return try JSONDecoder().decode(CardPlacementEntry.self, from: Data(json.utf8))
    }

    private let left = CGRect(x: 0, y: 40, width: 700, height: 500)
    private let right = CGRect(x: 700, y: 40, width: 700, height: 500)

    func testADepartingViewMeetingAFaceIsHandedOverAndEveryFaceIsListed() throws {
        // A switch: `text` stood across both arriving panes, which wait on their pages.
        let text = CGRect(x: 0, y: 40, width: 1400, height: 500)
        let plan = BodyHandOver.plan(
            onScreen: ["text": text],
            entries: [
                try entry("text", text, visible: false),
                try entry("a", left, visible: false, face: true),
                try entry("b", right, visible: false, face: true),
            ]
        )
        check("text is leaving", plan.leaving == ["text"], "\(plan.leaving)")
        check("and handed over", plan.handedOver == ["text"], "\(plan.handedOver)")
        check("every face is listed", plan.faces == [HandOverFace(cardId: "a", rect: left), HandOverFace(cardId: "b", rect: right)], "\(plan.faces)")
    }

    func testADepartingViewMeetingNoFaceListsNoFaces() throws {
        // A close: `a` goes, and the face waits in a pane `a` never stood over.
        let below = CGRect(x: 0, y: 600, width: 700, height: 300)
        let plan = BodyHandOver.plan(
            onScreen: ["a": left],
            entries: [try entry("b", below, visible: false, face: true)]
        )
        check("a is leaving, named or not", plan.leaving == ["a"], "\(plan.leaving)")
        check("but handed over to nothing", plan.handedOver.isEmpty, "\(plan.handedOver)")
        check("so no face is drawn", plan.faces.isEmpty, "\(plan.faces)")
    }

    func testAViewThatOnlySharesAnEdgeWithAFaceIsNotHandedOver() throws {
        let plan = BodyHandOver.plan(
            onScreen: ["a": left],
            entries: [try entry("a", left, visible: false), try entry("b", right, visible: false, face: true)]
        )
        check("an edge in common is not a meeting", plan.handedOver.isEmpty, "\(plan.handedOver)")
    }

    func testAFaceWithNoDisplayListTakesNothingOver() throws {
        // The shell held `a` for its paint over a face it read no list for: nothing to draw, nothing handed over.
        let plan = BodyHandOver.plan(
            onScreen: ["a": left],
            entries: [try entry("a", left, visible: false), try entry("b", left, visible: false, face: true, drawn: false)]
        )
        check("a is leaving", plan.leaving == ["a"], "\(plan.leaving)")
        check("but not handed over", plan.handedOver.isEmpty, "\(plan.handedOver)")
        check("so no face is drawn", plan.faces.isEmpty, "\(plan.faces)")
    }

    func testABodyStillShownIsNotLeaving() throws {
        let plan = BodyHandOver.plan(
            onScreen: ["a": left],
            entries: [try entry("a", left, visible: true), try entry("b", left, visible: false, face: true)]
        )
        check("nothing leaves", plan.leaving.isEmpty, "\(plan.leaving)")
        check("nothing is handed over", plan.handedOver.isEmpty)
        check("no face is drawn", plan.faces.isEmpty)
    }

    func testATabOntoACardThatCannotShowHandsTheOldTabOver() throws {
        // A tab change: pane `left` chooses `b`, whose page has not painted, over `a`.
        let plan = BodyHandOver.plan(
            onScreen: ["a": left],
            entries: [try entry("a", left, visible: false), try entry("b", left, visible: false, face: true)]
        )
        check("a is leaving", plan.leaving == ["a"], "\(plan.leaving)")
        check("and handed over", plan.handedOver == ["a"], "\(plan.handedOver)")
        check("to b's face", plan.faces == [HandOverFace(cardId: "b", rect: left)], "\(plan.faces)")
    }

    func testAFaceDrawDecodesFromTheShellsJSONColoursIncluded() throws {
        let json = """
            {"boxes":[{"rect":{"x":5,"y":5,"width":700,"height":500},"fill":"rgba(46, 48, 54, 1)",
                       "border":{"width":1,"color":"rgba(255, 255, 255, 0.06)"},"radius":8},
                      {"rect":{"x":5,"y":5,"width":700,"height":28},"fill":null,"border":null,"radius":0}],
             "texts":[{"rect":{"x":40,"y":11,"width":220,"height":16},"text":"tug-r44e-a/upbeat-relic",
                       "font":{"family":"IBM Plex Sans","size":12,"weight":600},"color":"rgba(230, 232, 236, 1)"}],
             "images":[{"rect":{"x":14,"y":11,"width":16,"height":16},
                        "svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"16\\" height=\\"16\\" viewBox=\\"0 0 24 24\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"10\\" fill=\\"none\\" stroke=\\"rgb(230, 232, 236)\\" stroke-opacity=\\"1\\" stroke-width=\\"2\\"/></svg>"}]}
            """
        let draw = try JSONDecoder().decode(FaceDraw.self, from: Data(json.utf8))
        check("two boxes, one text run", draw.boxes.count == 2 && draw.texts.count == 1)
        check("the pane's rect", draw.boxes[0].rect.cgRect == CGRect(x: 5, y: 5, width: 700, height: 500))
        check("a box with no fill reads none", draw.boxes[1].fill == nil && draw.boxes[1].border == nil)
        check("the run's font", draw.texts[0].font == FaceDraw.Font(family: "IBM Plex Sans", size: 12, weight: 600))
        let fill = draw.boxes[0].fill.flatMap(BodyHandOver.color(rgba:))?.components ?? []
        check("the fill parses to its channels", fill.count == 4 && abs(fill[0] - 46.0 / 255) < 1e-6 && fill[3] == 1, "\(fill)")
        let border = draw.boxes[0].border.flatMap { BodyHandOver.color(rgba: $0.color) }?.alpha ?? -1
        check("the border keeps its alpha", abs(border - 0.06) < 1e-6, "\(border)")
        check("anything not rgba is no colour", BodyHandOver.color(rgba: "oklch(1 0 0)") == nil)
        check("one icon at its rect", draw.images.count == 1 && draw.images[0].rect.cgRect == CGRect(x: 14, y: 11, width: 16, height: 16))
        // AppKit's SVG reader paints nothing for an `rgba()` paint, which is why the shell writes `rgb()` and an opacity.
        let drawn = NSImage(data: Data(draw.images[0].svg.utf8))?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        let inked = drawn.flatMap { BodyHandOver.rgbaBytes(of: $0) }.map { bytes in stride(from: 3, to: bytes.count, by: 4).filter { bytes[$0] > 80 }.count } ?? 0
        check("whose markup AppKit draws", inked > 0, "\(inked) inked pixels")
    }

    func testAHandOverReposedIsTheSameOneAndAnyChangeIsNot() {
        let faces = [HandOverFace(cardId: "a", rect: left), HandOverFace(cardId: "b", rect: right)]
        let pending = HandOverPlan(leaving: ["text"], faces: faces, handedOver: ["text"])
        let reposted = HandOverPlan(leaving: ["text"], faces: faces.reversed(), handedOver: ["text"])
        check("the same faces at the same rects continue", BodyHandOver.continues(pending: pending, next: reposted))
        var moved = faces
        moved[1].rect = right.offsetBy(dx: 1, dy: 0)
        check("a face that moved does not", !BodyHandOver.continues(pending: pending, next: HandOverPlan(leaving: ["text"], faces: moved, handedOver: ["text"])))
        check("a face added does not", !BodyHandOver.continues(
            pending: pending,
            next: HandOverPlan(leaving: ["text"], faces: faces + [HandOverFace(cardId: "c", rect: left)], handedOver: ["text"])
        ))
        check("a face dropped does not", !BodyHandOver.continues(
            pending: pending, next: HandOverPlan(leaving: ["text"], faces: [faces[0]], handedOver: ["text"])
        ))
        check("another view handed over does not", !BodyHandOver.continues(
            pending: pending, next: HandOverPlan(leaving: ["text", "x"], faces: faces, handedOver: ["text", "x"])
        ))
    }

    func testACropIsTheFacesRectInTheSnapshotsPixels() {
        let union = left.union(right)
        let crop = BodyHandOver.cropRect(of: right, in: union, scale: 2)
        check("the right face starts 700 points, 1400 pixels, in", crop == CGRect(x: 1400, y: 0, width: 1400, height: 1000), "\(crop)")
    }

    // MARK: - The title band's ink

    private let width = 100
    private let height = 40
    private let band = BodyHandOver.titleBand(
        viewSize: CGSize(width: 100, height: 40),
        insets: CardInsets(top: 4, right: 4, bottom: 4, left: 4),
        scale: 1
    )

    /// A `width` × `height` RGBA image of one colour.
    private func flat(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> [UInt8] {
        (0..<(width * height)).flatMap { _ in [r, g, b, 255] }
    }

    func testTheBandRunsInsideThePaneBelowItsTop() {
        check("from 12 in and 10 down, 76 wide and 20 tall", band == CGRect(x: 12, y: 10, width: 76, height: 20), "\(band)")
    }

    func testAFlatBandHoldsNoInk() {
        let share = BodyHandOver.inkShare(rgba: flat(40, 44, 52), width: width, height: height, band: band)
        check("a flat band reads 0", share == 0, "\(share)")
    }

    func testADarkBarInTheBandIsInk() {
        var rgba = flat(230, 230, 230)
        // A title's worth of dark ink across the band's middle rows.
        for y in 16..<22 {
            for x in 20..<70 {
                let i = (y * width + x) * 4
                rgba[i] = 20; rgba[i + 1] = 20; rgba[i + 2] = 20
            }
        }
        let share = BodyHandOver.inkShare(rgba: rgba, width: width, height: height, band: band)
        check("the bar reads as ink", share > 0.05 && share < 0.5, "\(share)")
    }

    func testAShadeNearTheSurfaceIsNotInk() {
        var rgba = flat(230, 230, 230)
        for y in 16..<22 {
            for x in 20..<70 {
                let i = (y * width + x) * 4
                rgba[i] = 200; rgba[i + 1] = 200; rgba[i + 2] = 200
            }
        }
        let share = BodyHandOver.inkShare(rgba: rgba, width: width, height: height, band: band)
        check("thirty a channel off the surface is not ink", share == 0, "\(share)")
    }
}
