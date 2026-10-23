import XCTest

// The host's half of the card plan: it decodes every plan the shell's planner
// wrote into the parity fixture, moves a beat's start onto the media clock
// through one anchor, pins each beat's ends while keeping its overshoot, and
// lays a card's beats on one track that holds across a gap and never shows
// the landing early.
final class BodyBeatsTests: XCTestCase {
    private struct ParityCase: Decodable {
        var name: String
        var refused: [String]
        var plan: CardPlan
    }

    /// The fixture `card-plan.test.ts` writes, beside the shell's planner.
    private func parityCases(file: StaticString = #filePath) throws -> [String: ParityCase] {
        let url = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .appendingPathComponent("../../tugdeck/src/lib/__tests__/fixtures/card-plan-parity.json")
            .standardizedFileURL
        let data = try Data(contentsOf: url)
        let cases = try JSONDecoder().decode([ParityCase].self, from: data)
        return Dictionary(uniqueKeysWithValues: cases.map { ($0.name, $0) })
    }

    func testEveryPlanInTheParityFixtureDecodes() throws {
        let cases = try parityCases()
        check("five cases", cases.count == 5, "\(cases.keys.sorted())")

        let slide = try XCTUnwrap(cases["flow-slide"]).plan
        check("the slide carries one card", slide.cards.count == 1)
        let card = slide.cards[0]
        check("its landing is the whole view at Last", card.landing == PlanRect(x: 110, y: 50, width: 420, height: 540), "\(card.landing)")
        check("one move beat", card.beats.map(\.kind) == ["move"])
        check("the samples survive the trip", card.beats[0].progress == [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1])
        check("no crossing on a move", card.crossing == nil)

        check("the stack move carries two cards", try XCTUnwrap(cases["stack-move"]).plan.cards.map(\.cardId) == ["ca", "cb"])

        let stale = try XCTUnwrap(cases["stale-placement"])
        check("a stale placement plans no card", stale.plan.cards.isEmpty)
        check("and names the one it refused", stale.refused == ["cs"])

        let crossing = try XCTUnwrap(cases["size-change"]).plan.cards[0]
        check("a size change solves", try XCTUnwrap(cases["size-change"]).plan.solves)
        check("a slide does not", !slide.solves)
        check("a size change carries its crossing size", crossing.crossing == PlannedCard.Size(width: 320, height: 420), "\(String(describing: crossing.crossing))")
        check("a moving card is not an arrival", crossing.arrives == nil)

        let arrival = try XCTUnwrap(cases["arrival"]).plan.cards[0]
        check("an arrival says so, for the host to show it with its tracks", arrival.arrives == true)
        check("it rides one arrive beat", arrival.beats.map(\.kind) == ["arrive"])
        check("and fades in", arrival.beats[0].opacity == [0, 1], "\(String(describing: arrival.beats[0].opacity))")
    }

    func testAPlanDecodesFromThePagesJSON() throws {
        let json = Data(#"""
            {"planId":7,"startWallMs":1760000000000.5,"solves":false,"cards":[{"cardId":"c",
             "landing":{"x":1,"y":2,"width":3,"height":4},
             "beats":[{"kind":"arrive","delayMs":0,"durationMs":120,
                       "from":{"x":1,"y":2,"width":3,"height":4},"to":{"x":1,"y":2,"width":3,"height":4},
                       "opacity":[0,1],"progress":[0,1],"easing":"ease-out"}]}]}
            """#.utf8)
        guard case .success(.cardPlan(let plan)) = ToHost.decode(name: "cardPlan", data: json) else {
            return XCTFail("the plan does not decode")
        }
        check("the plan id", plan.planId == 7)
        check("the start keeps its fraction", plan.startWallMs == 1_760_000_000_000.5)
        check("the fade's easing", plan.cards[0].beats[0].easing == "ease-out")
        let malformed = ToHost.decode(name: "cardPlan", data: Data(#"{"planId":"x"}"#.utf8))
        check("a malformed plan is refused", { if case .failure = malformed { return true } else { return false } }())
    }

    func testASolvingPlanDecodesAndOneWithoutTheFlagIsRefused() throws {
        let json = Data(#"""
            {"planId":8,"startWallMs":1760000000000,"solves":true,"cards":[{"cardId":"c",
             "landing":{"x":0,"y":0,"width":320,"height":420},"crossing":{"width":320,"height":420},
             "beats":[{"kind":"shrink","delayMs":0,"durationMs":240,
                       "from":{"x":0,"y":0,"width":620,"height":420},"to":{"x":0,"y":0,"width":320,"height":420},
                       "progress":[0,1]}]}]}
            """#.utf8)
        guard case .success(.cardPlan(let plan)) = ToHost.decode(name: "cardPlan", data: json) else {
            return XCTFail("the solving plan does not decode")
        }
        check("it solves", plan.solves)
        check("its card carries the crossing", plan.cards[0].crossing == PlannedCard.Size(width: 320, height: 420))
        let unflagged = ToHost.decode(name: "cardPlan", data: Data(#"{"planId":8,"startWallMs":0,"cards":[]}"#.utf8))
        check("a plan that does not say whether it solves is refused", { if case .failure = unflagged { return true } else { return false } }())
    }

    func testBeginTimeMovesTheStartOntoTheMediaClock() {
        let anchor = ClockAnchor(wallMs: 1_000_000, mediaTime: 50)
        let future = anchor.beginTime(startWallMs: 1_000_100, delayMs: 50)
        check("a start 150 ms ahead begins 0.15 s ahead", abs(future - 50.15) < 1e-9, "\(future)")
        let past = anchor.beginTime(startWallMs: 999_900, delayMs: 0)
        check("a start already past is returned past", abs(past - 49.9) < 1e-9, "\(past)")
    }

    func testLayerValuesPinTheEndsAndKeepTheOvershoot() {
        let from = CGRect(x: 100, y: 0, width: 200, height: 100)
        let to = CGRect(x: 0, y: 0, width: 200, height: 100)
        let values = BodyBeats.layerValues(from: from, to: to, progress: [0.01, 0.5, 1.04, 0.99])
        check("one value per sample", values.count == 4)
        check("the first is from exactly", values[0] == from, "\(values[0])")
        check("the last is to exactly", values[3] == to, "\(values[3])")
        check("a sample between goes halfway", abs(values[1].minX - 50) < 1e-9)
        check("the overshoot carries past to", abs(values[2].minX - -4) < 1e-9, "\(values[2])")
    }

    func testShrinkThenMoveIsOneTrackFromThePrepareDelay() throws {
        let body = try XCTUnwrap(parityCases()["size-change"]).plan.cards[0]
        let shrink = body.beats[0]
        let move = body.beats[1]
        let track = try XCTUnwrap(BodyBeats.planTrack(body.beats))
        check("the track begins at the first beat's delay", track.delayMs == 40)
        check("and spans to the last beat's end", track.durationMs == 500, "\(track.durationMs)")
        check("one key time per value", track.keyTimes.count == track.rects.count)
        check("one timing per segment", track.timings.count == track.rects.count - 1)
        check("the key times never go back", zip(track.keyTimes, track.keyTimes.dropFirst()).allSatisfy { $0 <= $1 }, "\(track.keyTimes)")
        check("they start at 0 and end at 1", track.keyTimes.first == 0 && track.keyTimes.last == 1)
        check("the shared point is written once", track.rects.count == shrink.progress.count + move.progress.count - 1)
        let seam = try XCTUnwrap(track.keyTimes.firstIndex { abs($0 - 0.4) < 1e-9 })
        check("at the shrink's end the track is the shrink's to", track.rects[seam] == shrink.to.cgRect, "\(track.rects[seam])")
        check("which is the move's from", track.rects[seam] == move.from.cgRect)
        check("the track ends at the landing", track.rects.last == body.landing.cgRect)
        check("no opacity track when no beat fades", track.opacities == nil)
        check("a sampled beat is linear between samples", track.timings.allSatisfy { $0 == .linear })
    }

    func testAGapBetweenBeatsHoldsTheEarlierTo() throws {
        let a = PlanRect(x: 0, y: 0, width: 300, height: 200)
        let b = PlanRect(x: 0, y: 0, width: 200, height: 200)
        let c = PlanRect(x: 100, y: 0, width: 200, height: 200)
        let beats = [
            BodyBeat(kind: "move", delayMs: 300, durationMs: 100, from: b, to: c, opacity: nil, progress: [0, 0.6, 1], easing: nil),
            BodyBeat(kind: "shrink", delayMs: 0, durationMs: 200, from: a, to: b, opacity: [1, 0.5], progress: [0, 1], easing: "ease-in"),
        ]
        let track = try XCTUnwrap(BodyBeats.planTrack(beats))
        check("beats are taken in time order", track.rects.first == a.cgRect)
        check("the span is the first start to the last end", track.durationMs == 400)
        check("five values: two for the fade, three for the move", track.rects.count == 5, "\(track.rects)")
        check("the gap opens on the shrink's to", track.rects[1] == b.cgRect && abs(track.keyTimes[1] - 0.5) < 1e-9)
        check("and holds it until the move begins", track.rects[2] == b.cgRect && abs(track.keyTimes[2] - 0.75) < 1e-9)
        check("the fade rides its keyword, the gap and the samples are linear", track.timings == [.easing("ease-in"), .linear, .linear, .linear], "\(track.timings)")
        check("an opacity track when any beat fades, held by a beat that does not", track.opacities == [1, 0.5, 0.5, 0.5, 0.5], "\(String(describing: track.opacities))")
    }

    func testAZeroLengthBeatIsATrackOfNoDuration() throws {
        // A split's revealed member: from the stacked rect to its tile before
        // the first frame. A track of no duration is the shape a solving plan
        // places at its landing rather than declines.
        let stacked = PlanRect(x: 0, y: 0, width: 400, height: 800)
        let tile = PlanRect(x: 0, y: 400, width: 400, height: 400)
        let beats = [BodyBeat(kind: "move", delayMs: 0, durationMs: 0, from: stacked, to: tile, opacity: nil, progress: [0, 1], easing: nil)]
        let track = try XCTUnwrap(BodyBeats.planTrack(beats))
        check("the track has no duration", track.durationMs == 0, "\(track.durationMs)")
        check("and ends at the tile", track.rects.last == tile.cgRect)
    }

    func testAHoldThenALandStandsAtFirstForTheWholeSpan() throws {
        // A stack's retiring member: held at its tile for the settle's span,
        // landing at the full run at the span's end.
        let tile = PlanRect(x: 0, y: 400, width: 400, height: 400)
        let run = PlanRect(x: 0, y: 0, width: 400, height: 800)
        let beats = [
            BodyBeat(kind: "move", delayMs: 0, durationMs: 420, from: tile, to: tile, opacity: nil, progress: [0, 1], easing: nil),
            BodyBeat(kind: "move", delayMs: 420, durationMs: 0, from: tile, to: run, opacity: nil, progress: [0, 1], easing: nil),
        ]
        let track = try XCTUnwrap(BodyBeats.planTrack(beats))
        check("the track spans the hold", track.durationMs == 420, "\(track.durationMs)")
        check("it stands at the tile until the span's end", track.rects.dropLast().allSatisfy { $0 == tile.cgRect }, "\(track.rects)")
        check("and lands at the full run there", track.rects.last == run.cgRect && track.keyTimes.last == 1)
        check("the key times never go back", zip(track.keyTimes, track.keyTimes.dropFirst()).allSatisfy { $0 <= $1 }, "\(track.keyTimes)")
        check("one timing per segment", track.timings.count == track.rects.count - 1)
    }

    func testAFoldsBandHoldsItsRestThenRidesTheEdge() {
        // A fold from 600 to 150: Z2 stands at 500 in the open card, 40 tall,
        // with a 10-point bottom edge below it in the folded one.
        let track = BodyBeats.Track(
            delayMs: 0, durationMs: 300, keyTimes: [0, 0.33, 0.66, 1],
            rects: [600, 400, 200, 150].map { CGRect(x: 0, y: 0, width: 400, height: $0) },
            opacities: nil, timings: [.linear, .linear, .linear]
        )
        let band = BodyBeats.CrossingBand(restTop: 500, height: 40, reach: 50)
        let ride = BodyBeats.bandRide(track, band: band, landingHeight: 150)
        check("one key is put at each side of the hand-over", ride.keyTimes.count == 6, "\(ride.keyTimes)")
        check("the hand-over is where the edge reaches the band's rest", abs(ride.keyTimes[1] - 0.0825) < 1e-9, "\(ride.keyTimes)")
        check("the key times never go back", zip(ride.keyTimes, ride.keyTimes.dropFirst()).allSatisfy { $0 <= $1 })
        check("one timing per segment", ride.timings.count == ride.keyTimes.count - 1)
        check("the page's bottom rides the container's", ride.pageOffsets == [450, 400, 400, 250, 50, 0], "\(ride.pageOffsets)")
        check(
            "the cover shows down to the edge's cap, then to the band's top",
            ride.coverHeights == [590, 540, 500, 350, 150, 100], "\(ride.coverHeights)"
        )
        check(
            "a reading that would put the band past the cover is refused",
            BodyBeats.CrossingBand(restFromBottom: 10, top: 0, height: 40, viewport: 100, scale: 1, coverHeight: 600) == nil
        )
    }

    func testASplitCoverHangsItsTailFromTheEdgeAndItsHeadFromTheTop() throws {
        // A card of 600 shrinking to 300 under its cover.
        let track = BodyBeats.Track(
            delayMs: 0, durationMs: 300, keyTimes: [0, 0.5, 1],
            rects: [600, 400, 300].map { CGRect(x: 0, y: 0, width: 400, height: $0) },
            opacities: nil, timings: [.linear, .linear]
        )
        let following = try XCTUnwrap(BodyBeats.CoverSplit(splitTop: 48, follows: true, viewport: 300, scale: 1, coverHeight: 600))
        check("a following card splits at its scroller's top", following.splitY == 48)
        let ride = BodyBeats.splitRide(track, split: following, coverHeight: 600, landingHeight: 300)
        check("the tail frame's bottom is on the edge", ride.tailTops == [0, -200, -300], "\(ride.tailTops)")
        check("and so is the page's", ride.pageOffsets == [300, 100, 0], "\(ride.pageOffsets)")
        let topped = try XCTUnwrap(BodyBeats.CoverSplit(splitTop: 240, follows: false, viewport: 300, scale: 1, coverHeight: 600))
        check("a scrolled-up card splits at its band, fixed from the bottom", topped.splitY == 540, "\(topped.splitY)")
        check("and its page stays put", BodyBeats.splitRide(track, split: topped, coverHeight: 600, landingHeight: 300).pageOffsets == [0, 0, 0])
        check("a split at the cover's top is refused", BodyBeats.CoverSplit(splitTop: 0, follows: true, viewport: 300, scale: 1, coverHeight: 600) == nil)
    }

    func testTheLayerMappingIsSolvedFromThreeFramesAndInverts() throws {
        // A flipped geometry with a centred anchor, as a layer in an unflipped
        // superlayer of height 800 would report it: nothing here assumes it.
        let height: CGFloat = 800
        func layerPosition(_ r: CGRect) -> CGPoint {
            CGPoint(x: r.minX + r.width / 2, y: height - r.minY - r.height / 2)
        }
        let base = CGRect(x: 120, y: 60, width: 400, height: 300)
        let mapping = try XCTUnwrap(LayerMapping.solve(
            base: base,
            at: layerPosition(base),
            moved: layerPosition(base.offsetBy(dx: 1, dy: 1)),
            grown: layerPosition(CGRect(x: 120, y: 60, width: 401, height: 301)),
            boundsOrigin: .zero
        ))
        let elsewhere = CGRect(x: -35.5, y: 412.25, width: 380, height: 250)
        let p = mapping.position(of: elsewhere)
        check("a frame maps to the layer's position", abs(p.x - layerPosition(elsewhere).x) < 1e-9 && abs(p.y - layerPosition(elsewhere).y) < 1e-9, "\(p)")
        check("bounds take the frame's size", mapping.bounds(of: elsewhere) == CGRect(x: 0, y: 0, width: 380, height: 250))
        let back = mapping.frame(position: p, bounds: mapping.bounds(of: elsewhere))
        check("and the position reads back as the frame", abs(back.minX - elsewhere.minX) < 1e-9 && abs(back.minY - elsewhere.minY) < 1e-9, "\(back)")
        check("a layer that did not move has no mapping", LayerMapping.solve(
            base: base, at: .zero, moved: .zero, grown: .zero, boundsOrigin: .zero
        ) == nil)
    }
}
