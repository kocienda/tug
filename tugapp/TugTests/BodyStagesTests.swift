import AppKit
import XCTest

// The host's stages: a theme's skeleton palette decodes from what the pages
// post, and the store answers a theme it knows with its own palette and one
// it does not with the on-screen theme's.
final class BodyStagesTests: XCTestCase {
    /// The fixture `host-parity.test.ts` writes from `tugdeck/src/host/registry.ts`.
    private func toHostSamples(_ name: String, file: StaticString = #filePath) throws -> [Any] {
        let url = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .appendingPathComponent("../../tugdeck/src/host/__tests__/fixtures/host-parity.json")
            .standardizedFileURL
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let rows = try XCTUnwrap(root["toHost"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { $0["name"] as? String == name })
        return try XCTUnwrap(row["samples"] as? [Any])
    }

    private func palette(_ theme: String, canvas: String = "#101010") -> SkeletonPalette {
        SkeletonPalette(theme: theme, canvas: canvas, grid: "#202020", surface: "#303030", band: "#404040", ink: "#e0e0e0", border: "#505050")
    }

    func testAPaletteDecodesFromTheShellsAndAPagesSamples() throws {
        let theme = try toHostSamples("setTheme").compactMap { sample -> SetTheme? in
            let data = try JSONSerialization.data(withJSONObject: sample)
            return try JSONDecoder().decode(SetTheme.self, from: data)
        }.compactMap(\.palette).first
        let surface = try toHostSamples("bodySurface").compactMap { sample -> BodySurface? in
            let data = try JSONSerialization.data(withJSONObject: sample)
            return try JSONDecoder().decode(BodySurface.self, from: data)
        }.compactMap(\.palette).first
        let fromShell = try XCTUnwrap(theme, "a setTheme sample carries a palette")
        let fromPage = try XCTUnwrap(surface, "a bodySurface sample carries a palette")
        XCTAssertEqual(fromShell.theme, "ironclad")
        XCTAssertEqual(fromShell, fromPage)
        XCTAssertNotNil(SkeletonPalette.srgb(fromShell.canvas))
        XCTAssertNotNil(SkeletonPalette.srgb(fromShell.border))
    }

    func testAHexReadsAsTheSameSRGBBytes() throws {
        let color = try XCTUnwrap(SkeletonPalette.srgb("#16181d"))
        XCTAssertEqual(color.colorSpace, NSColorSpace.sRGB)
        XCTAssertEqual(Int((color.redComponent * 255).rounded()), 0x16)
        XCTAssertEqual(Int((color.greenComponent * 255).rounded()), 0x18)
        XCTAssertEqual(Int((color.blueComponent * 255).rounded()), 0x1d)
        XCTAssertNil(SkeletonPalette.srgb("#16181"))
    }

    func testAKnownThemeAnswersWithItsOwnPalette() {
        let palettes = ThemePalettes()
        palettes.noteOnScreen(palette("ironclad", canvas: "#111111"))
        palettes.note(palette("sloop", canvas: "#eeeeee"))
        XCTAssertEqual(palettes.palette(for: "sloop")?.canvas, "#eeeeee")
        XCTAssertEqual(palettes.palette(for: "ironclad")?.canvas, "#111111")
        XCTAssertEqual(palettes.onScreen?.theme, "ironclad")
    }

    func testAnUnknownThemeFallsBackToTheOnScreenPalette() {
        let palettes = ThemePalettes()
        XCTAssertNil(palettes.palette(for: "ketch"), "nothing known, nothing to fall back to")
        palettes.noteOnScreen(palette("ironclad"))
        XCTAssertEqual(palettes.palette(for: "ketch")?.theme, "ironclad")
        XCTAssertEqual(palettes.palette(for: nil)?.theme, "ironclad")
        // A page's report does not move the on-screen theme.
        palettes.note(palette("sloop"))
        XCTAssertEqual(palettes.onScreen?.theme, "ironclad")
    }

    func testAPlacementCarriesEachCardsStageAndEveryWorkspace() throws {
        let sample = try XCTUnwrap(toHostSamples("placeCards").first)
        let placement = try JSONDecoder().decode(PlaceCards.self, from: JSONSerialization.data(withJSONObject: sample))
        XCTAssertEqual(placement.activeSpaceId, "s1")
        XCTAssertEqual(placement.spaces.map(\.id), ["s1", "s2"])
        XCTAssertEqual(placement.spaces.first?.theme, "ironclad")
        XCTAssertNil(placement.spaces.last?.theme)
        let byId = Dictionary(uniqueKeysWithValues: placement.cards.map { ($0.cardId, $0) })
        let rail = try XCTUnwrap(byId["c1"])
        XCTAssertNil(rail.spaceId, "a rail member names no workspace")
        let parked = try XCTUnwrap(byId["c5"])
        XCTAssertEqual(parked.spaceId, "s2")
        XCTAssertTrue(parked.staged)
        XCTAssertFalse(parked.visible)
        XCTAssertEqual(parked.folded, true)
        XCTAssertEqual(parked.kind, "text")
        XCTAssertFalse(try XCTUnwrap(byId["c2"]).staged, "a sibling is not staged")
    }

    func testTheGroundStandsOnTheFirstPaletteAndWearsEachAfter() throws {
        let host = StageGroundHostView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
        XCTAssertNil(host.ground, "no palette, no ground")
        host.setZoom(1.25)
        host.show(palette("ironclad", canvas: "#16181d"))
        let ground = try XCTUnwrap(host.ground)
        XCTAssertEqual(ground.frame, host.bounds)
        XCTAssertEqual(ground.zoom, 1.25, "a ground stood after a zoom wears it")
        XCTAssertEqual(ground.canvas, SkeletonPalette.srgb("#16181d"))
        host.show(palette("sloop", canvas: "#eeeeee"))
        XCTAssertTrue(host.ground === ground, "a theme change re-wears the one ground")
        XCTAssertEqual(ground.canvas, SkeletonPalette.srgb("#eeeeee"))
        host.setZoom(0.8)
        XCTAssertEqual(ground.zoom, 0.8)
        XCTAssertNil(host.hitTest(NSPoint(x: 10, y: 10)), "the ground answers no point")
    }

    // MARK: - The picture policy

    private func facts(
        body: Bool = true, painted: Bool = true, stale: Bool = false, slept: Bool = false,
        evicted: Bool = false, lastFrame: Bool = false, sibling: Bool = false, failed: Bool = false,
        pastHorizon: Bool = false
    ) -> StagePicture.Facts {
        var f = StagePicture.Facts()
        f.hasBody = body
        f.contentPainted = painted
        f.stale = stale
        f.slept = slept
        f.evicted = evicted
        f.hasLastFrame = lastFrame
        f.sibling = sibling
        f.failed = failed
        f.pastHorizon = pastHorizon
        return f
    }

    func testACurrentPaintedPageIsLive() {
        XCTAssertEqual(StagePicture.choose(facts()), .live)
        XCTAssertEqual(StagePicture.choose(facts(lastFrame: true)), .live, "a kept last frame does not stand over a current page")
    }

    func testAPageThatIsNotLiveShowsItsLastFrameElseItsSkeleton() {
        XCTAssertEqual(StagePicture.choose(facts(slept: true, lastFrame: true)), .lastFrame, "a slept card with a last frame")
        XCTAssertEqual(StagePicture.choose(facts(slept: true)), .skeleton, "a slept card with none")
        XCTAssertEqual(StagePicture.choose(facts(stale: true, lastFrame: true)), .skeleton, "a stale card's last frame is behind")
        XCTAssertEqual(StagePicture.choose(facts(painted: false)), .skeleton, "a page that has not painted its content")
        XCTAssertEqual(StagePicture.choose(facts(painted: false, lastFrame: true)), .lastFrame)
    }

    func testAnEvictedCardShowsItsLastFrameUntilItsNewPagePaints() {
        XCTAssertEqual(StagePicture.choose(facts(body: false, painted: false, lastFrame: true)), .lastFrame, "no body, a kept cover")
        XCTAssertEqual(StagePicture.choose(facts(body: false, painted: false)), .skeleton, "no body, no cover")
        XCTAssertEqual(StagePicture.choose(facts(evicted: true, lastFrame: true)), .lastFrame, "brought back under its cover")
    }

    func testASiblingHasNoPictureAndAFailedPageIsShownAsItStands() {
        XCTAssertNil(StagePicture.choose(facts(sibling: true)))
        XCTAssertEqual(StagePicture.choose(facts(painted: false, failed: true)), .live)
    }

    func testAPicturePastItsHorizonGivesWayToThePage() {
        XCTAssertEqual(StagePicture.choose(facts(slept: true, lastFrame: true, pastHorizon: true)), .live)
        XCTAssertEqual(StagePicture.choose(facts(stale: true, pastHorizon: true)), .live)
        XCTAssertTrue(StagePicture.hasHorizon(facts(slept: true)), "over a page that has painted")
        XCTAssertFalse(StagePicture.hasHorizon(facts(painted: false)), "a page that never painted has nothing to reveal")
        XCTAssertFalse(StagePicture.hasHorizon(facts(body: false, painted: false)))
    }

    func testOnlyALoadingCardsSkeletonWearsTheWave() {
        XCTAssertTrue(StagePicture.loading(facts(body: false, painted: false)))
        XCTAssertTrue(StagePicture.loading(facts(painted: false)))
        XCTAssertFalse(StagePicture.loading(facts(stale: true)))
        let loading = StageSkeletonView(
            frame: NSRect(x: 0, y: 0, width: 200, height: 120), palette: palette("ironclad"),
            title: "Text", insets: nil, folded: false, zoom: 1, loading: true
        )
        XCTAssertEqual(loading.wavesAfterFrames, 2, "the wave waits two display frames")
        XCTAssertFalse(loading.waveRunning)
        let reskin = StageSkeletonView(
            frame: NSRect(x: 0, y: 0, width: 200, height: 120), palette: palette("sloop"),
            title: "Text", insets: nil, folded: false, zoom: 1, loading: false
        )
        XCTAssertNil(reskin.wavesAfterFrames, "a skeleton over a painted page wears no wave")
        reskin.setOnScreen(true)
        XCTAssertFalse(reskin.waveRunning)
        XCTAssertNil(reskin.hitTest(NSPoint(x: 10, y: 10)))
    }

    func testVisibilityFollowsTheActiveStage() {
        XCTAssertTrue(StagePicture.visible(staged: true, rail: false, spaceId: "a", activeId: "a"))
        XCTAssertFalse(StagePicture.visible(staged: true, rail: false, spaceId: "b", activeId: "a"), "a parked card")
        XCTAssertFalse(StagePicture.visible(staged: false, rail: false, spaceId: "a", activeId: "a"), "a folded-away card")
        XCTAssertTrue(StagePicture.visible(staged: true, rail: true, spaceId: nil, activeId: "a"), "a rail member")
        XCTAssertFalse(StagePicture.visible(staged: false, rail: true, spaceId: nil, activeId: "a"))
        XCTAssertTrue(StagePicture.visible(staged: true, rail: false, spaceId: nil, activeId: "a"), "no workspace named")
    }

    // MARK: - The stage set

    func testAStageStandsPerWorkspaceAndOneIsShown() throws {
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        let grounds = StageGroundHostView(frame: host.bounds)
        let palettes = ThemePalettes()
        palettes.noteOnScreen(palette("ironclad", canvas: "#111111"))
        palettes.note(palette("sloop", canvas: "#eeeeee"))
        grounds.show(try XCTUnwrap(palettes.onScreen))
        var serial = 0
        let set = StageSet(hostView: host, grounds: grounds, palettes: palettes) {
            serial += 1
            return serial
        }
        set.sync([
            StageSpace(id: "a", theme: "ironclad", focusedCardId: nil),
            StageSpace(id: "b", theme: "sloop", focusedCardId: "c2"),
        ])
        XCTAssertEqual(set.order, ["a", "b"])
        XCTAssertEqual(grounds.subviews.count, 2, "the boot ground gave way to each stage's own")
        XCTAssertTrue(set.show("a"))
        XCTAssertFalse(set.show("a"), "already shown")
        XCTAssertFalse(set.show("z"), "no such stage")
        let a = try XCTUnwrap(set.stage("a"))
        let b = try XCTUnwrap(set.stage("b"))
        XCTAssertTrue(a.view.isShown)
        XCTAssertFalse(b.view.isShown)
        XCTAssertEqual(grounds.ground?.canvas, SkeletonPalette.srgb("#111111"))
        XCTAssertTrue(set.show("b"))
        XCTAssertFalse(a.view.isShown)
        XCTAssertTrue(b.view.isShown)
        XCTAssertEqual(grounds.ground?.canvas, SkeletonPalette.srgb("#eeeeee"), "the ground is the arriving workspace's")
        XCTAssertEqual(b.focusedCardId, "c2")
        set.sync([StageSpace(id: "b", theme: "sloop", focusedCardId: nil)])
        XCTAssertNil(set.stage("a"))
        XCTAssertNil(a.view.superview, "a workspace gone takes its stage")
        XCTAssertNil(a.ground?.superview)
        XCTAssertEqual(set.activeId, "b")
        XCTAssertNil(b.view.hitTest(NSPoint(x: 10, y: 10)), "a stage answers no point of its own")
    }

    // MARK: - The cut's serials ([P06])

    /// A stage set of workspaces a–d, `a` shown.
    private func cutSet() -> StageSet {
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        var serial = 0
        let set = StageSet(hostView: host, grounds: StageGroundHostView(frame: host.bounds), palettes: ThemePalettes()) {
            serial += 1
            return serial
        }
        set.sync(["a", "b", "c", "d"].map { StageSpace(id: $0, theme: nil, focusedCardId: nil) })
        set.show("a")
        return set
    }

    /// A cut the host makes from its menu: shown, and told to the shell.
    @discardableResult
    private func hostCut(_ set: StageSet, _ id: String) -> Int? {
        guard case .cut(let serial) = set.admit(id, door: .menu) else { return nil }
        set.show(id)
        set.told(serial)
        return serial
    }

    /// A `spaceCut` from the shell, carrying `serial` or none.
    @discardableResult
    private func shellCut(_ set: StageSet, _ id: String, _ serial: Int?) -> CutAdmission {
        let admission = set.admit(id, door: .shell(serial: serial))
        if case .cut = admission { set.show(id) }
        return admission
    }

    func testACutIsIgnoredOntoTheShownStageOrAnEchoOrNoWorkspace() {
        let set = cutSet()
        XCTAssertEqual(set.admit("a", door: .menu), .ignored("already active"))
        XCTAssertEqual(set.admit("b", door: .shell(serial: 9)), .ignored("echo"), "the shell's echo of a host cut never cuts")
        XCTAssertEqual(set.admit("z", door: .menu), .ignored("unknown space"))
        XCTAssertEqual(set.admit("z", door: .page), .ignored("unknown space"))
        XCTAssertEqual(set.admit("z", door: .shell(serial: nil)), .pending, "the shell's just-made workspace waits for its placement")
        XCTAssertEqual(set.activeId, "a")
    }

    func testEveryCutTakesTheNextSerial() {
        let set = cutSet()
        XCTAssertEqual(hostCut(set, "b"), 1)
        XCTAssertEqual(set.admit("c", door: .page), .cut(serial: 2))
        set.show("c")
        XCTAssertEqual(shellCut(set, "d", 2), .ignored("echo"))
        XCTAssertEqual(set.cutSerial, 2, "an ignored cut takes no serial")
    }

    func testHostCutsWithLateEchoesEndOnTheLastCut() {
        let set = cutSet()
        hostCut(set, "b")
        hostCut(set, "c")
        XCTAssertEqual(set.toldSerial, 2)
        shellCut(set, "b", 1)
        XCTAssertEqual(set.activeId, "c", "the shell's late echo of the first cut does not cut back")
        XCTAssertEqual(set.toldSerial, 2, "an older echo leaves the last told serial outstanding")
        shellCut(set, "c", 2)
        XCTAssertEqual(set.activeId, "c")
        XCTAssertNil(set.toldSerial, "the last echo clears it")
    }

    func testAShellSwitchWhileAHostCutIsOutstandingIsIgnoredThenHonoured() {
        let set = cutSet()
        hostCut(set, "c")
        XCTAssertEqual(shellCut(set, "d", nil), .ignored("host cut outstanding"), "the shell lands on the host's choice")
        XCTAssertEqual(set.activeId, "c")
        shellCut(set, "c", 1)
        XCTAssertEqual(shellCut(set, "d", nil), .cut(serial: 2), "once the echo has cleared it, the shell's switch is followed")
        XCTAssertEqual(set.activeId, "d")
    }

    func testAShellReloadClearsAnOutstandingSerial() {
        let set = cutSet()
        hostCut(set, "b")
        set.shellReloaded()
        XCTAssertNil(set.toldSerial)
        XCTAssertEqual(shellCut(set, "c", nil), .cut(serial: 2))
    }

    func testAStageViewStacksBeneathEveryCard() {
        let stage = StageView(frame: .zero, serial: 99)
        final class Card: NSView, StackedView {
            var order = 0
            var serial = 1
        }
        XCTAssertTrue(stackedBefore(stage, Card()))
    }
}
