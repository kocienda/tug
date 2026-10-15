import XCTest

// The host's half of the beat plan: it decodes every plan the shell's planner
// wrote into the parity fixture, moves a beat's start onto the media clock
// through one anchor, pins each beat's ends while keeping its overshoot, and
// lays a body's beats on one track that holds across a gap and never shows
// the landing early.
final class BodyBeatsTests: XCTestCase {
    private struct ParityCase: Decodable {
        var name: String
        var refused: [String]
        var plan: BeatPlan
    }

    /// The fixture `body-beat-plan.test.ts` writes, beside the shell's planner.
    private func parityCases(file: StaticString = #filePath) throws -> [String: ParityCase] {
        let url = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .appendingPathComponent("../../tugdeck/src/lib/__tests__/fixtures/beat-plan-parity.json")
            .standardizedFileURL
        let data = try Data(contentsOf: url)
        let cases = try JSONDecoder().decode([ParityCase].self, from: data)
        return Dictionary(uniqueKeysWithValues: cases.map { ($0.name, $0) })
    }

    func testEveryPlanInTheParityFixtureDecodes() throws {
        let cases = try parityCases()
        check("four cases", cases.count == 4, "\(cases.keys.sorted())")

        let slide = try XCTUnwrap(cases["flow-slide"]).plan
        check("the slide carries one body", slide.bodies.count == 1)
        let body = slide.bodies[0]
        check("its landing is the inset Last", body.landing == PlanRect(x: 121, y: 96, width: 398, height: 483), "\(body.landing)")
        check("one move beat", body.beats.map(\.kind) == ["move"])
        check("the samples survive the trip", body.beats[0].progress == [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1])
        check("no crossing on a move", body.crossing == nil)

        check("the stack move carries two bodies", try XCTUnwrap(cases["stack-move"]).plan.bodies.map(\.cardId) == ["ca", "cb"])

        let refused = try XCTUnwrap(cases["size-change-refused"])
        check("a refused size change plans no body", refused.plan.bodies.isEmpty)
        check("and names the one it refused", refused.refused == ["cs"])

        let crossing = try XCTUnwrap(cases["size-change-crossing"]).plan.bodies[0]
        check("an allowed size change carries its crossing size", crossing.crossing == PlannedBody.Size(width: 298, height: 363), "\(String(describing: crossing.crossing))")
    }

    func testAPlanArrivesAsWebKitHandsItOver() throws {
        let payload: [String: Any] = [
            "planId": 7,
            "startWallMs": 1_760_000_000_000.5,
            "bodies": [[
                "cardId": "c",
                "landing": ["x": 1, "y": 2, "width": 3, "height": 4],
                "beats": [[
                    "kind": "arrive", "delayMs": 0, "durationMs": 120,
                    "from": ["x": 1, "y": 2, "width": 3, "height": 4],
                    "to": ["x": 1, "y": 2, "width": 3, "height": 4],
                    "opacity": [0, 1], "progress": [0, 1], "easing": "ease-out",
                ]],
            ]],
        ]
        let plan = try XCTUnwrap(BeatPlan.from(payload: payload))
        check("the plan id", plan.planId == 7)
        check("the start keeps its fraction", plan.startWallMs == 1_760_000_000_000.5)
        check("the fade's easing", plan.bodies[0].beats[0].easing == "ease-out")
        check("a malformed plan is nil", BeatPlan.from(payload: ["planId": "x"]) == nil)
    }

    func testBeginTimeMovesTheStartOntoTheMediaClock() {
        let anchor = ClockAnchor(wallMs: 1_000_000, mediaTime: 50)
        let future = anchor.beginTime(startWallMs: 1_000_100, delayMs: 50, offsetSec: 0)
        check("a start 150 ms ahead begins 0.15 s ahead", abs(future - 50.15) < 1e-9, "\(future)")
        let past = anchor.beginTime(startWallMs: 999_900, delayMs: 0, offsetSec: 0)
        check("a start already past is returned past", abs(past - 49.9) < 1e-9, "\(past)")
        let offset = anchor.beginTime(startWallMs: 1_000_000, delayMs: 0, offsetSec: 1.0 / 60)
        check("the offset rides on top", abs(offset - (50 + 1.0 / 60)) < 1e-9, "\(offset)")
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
        let body = try XCTUnwrap(parityCases()["size-change-crossing"]).plan.bodies[0]
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
