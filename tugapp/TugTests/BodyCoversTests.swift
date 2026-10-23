import CoreGraphics
import XCTest

// The covers' map is their only owner: a cover the map lets go — by budget,
// by age, by its card closing, or by critical pressure's clear — frees its
// image there and then, whatever timer is still pending for it. A clear
// also refuses a cover taken before it. A body stands under one cover
// whatever its reasons, and that cover counts against the budget.
final class BodyCoversTests: XCTestCase {
    /// Whether each image made by `image(_:)` has been freed, by its tag.
    private var freed: [String: Bool] = [:]
    /// The aging timers the map has asked for, held rather than run.
    private var pending: [(ms: Double, work: () -> Void)] = []

    /// A covers map whose timers are held here, never run by a clock.
    private func covers(budget: Int = 1 << 20) -> BodyCovers {
        BodyCovers(budgetBytes: budget) { [unowned self] ms, work in pending.append((ms, work)) }
    }

    /// A cover of `width` × 4 pixels whose bytes report, under `tag`, when the image holding them is freed.
    private func cover(_ tag: String, width: Int = 4, takenAt: Double = 1) -> BodyCover {
        freed[tag] = false
        let box = Unmanaged.passRetained(Tag(tag) { [weak self] in self?.freed[tag] = true }).toOpaque()
        let bytesPerRow = width * 4
        let data = UnsafeMutableRawPointer.allocate(byteCount: bytesPerRow * 4, alignment: 16)
        let provider = CGDataProvider(dataInfo: box, data: data, size: bytesPerRow * 4) { info, data, _ in
            data.deallocate()
            Unmanaged<Tag>.fromOpaque(info!).takeRetainedValue().fire()
        }!
        let image = CGImage(
            width: width, height: 4, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )!
        return BodyCover(image: image, size: CGSize(width: width, height: 4), surface: nil, insets: nil, takenAt: takenAt)
    }

    /// Keep a fresh cover for `cardId` in `map` with an aging timer, holding no reference to it here.
    private func keepFresh(_ tag: String, in map: BodyCovers, for cardId: String, width: Int = 4, takenAt: Double = 1) {
        autoreleasepool {
            XCTAssertTrue(map.keep(cover(tag, width: width, takenAt: takenAt), for: cardId, takenIn: map.generation, agesAfterMs: 900_000))
        }
    }

    func testACoverTheMapDropsIsFreedWhileItsAgingTimerIsStillPending() {
        let map = covers()
        keepFresh("closed", in: map, for: "c1")
        XCTAssertEqual(pending.count, 1, "the cover has an aging timer pending")
        XCTAssertEqual(freed["closed"], false, "the map holds the cover")

        map.drop("c1")
        XCTAssertEqual(freed["closed"], true, "the pending timer does not hold the image")
    }

    func testACriticalClearFreesEveryCoverAtOnce() {
        let map = covers()
        keepFresh("a", in: map, for: "c1")
        keepFresh("b", in: map, for: "c2")
        map.clear()
        XCTAssertEqual(freed["a"], true)
        XCTAssertEqual(freed["b"], true)
        XCTAssertEqual(map.bytes, 0)
    }

    func testTheBudgetDropsTheOldestAndFreesIt() {
        // Each cover is 64 × 4 × 4 = 1024 bytes; the budget holds two.
        let map = covers(budget: 2048)
        var drops: [String] = []
        map.onDrop = { cardId, why in drops.append("\(cardId):\(why.rawValue)") }
        keepFresh("old", in: map, for: "c1", width: 64, takenAt: 1)
        keepFresh("mid", in: map, for: "c2", width: 64, takenAt: 2)
        keepFresh("new", in: map, for: "c3", width: 64, takenAt: 3)
        XCTAssertEqual(drops, ["c1:budget"])
        XCTAssertEqual(freed["old"], true, "the budgeted-out cover is freed though its timer is pending")
        XCTAssertEqual(freed["mid"], false)
        XCTAssertEqual(freed["new"], false)
    }

    func testAnAgedCoverGoesAndOnlyTheCoverItWasSetFor() {
        let map = covers()
        var drops: [String] = []
        map.onDrop = { cardId, why in drops.append("\(cardId):\(why.rawValue)") }
        keepFresh("first", in: map, for: "c1", takenAt: 1)
        // The card is evicted again before the first timer runs: that timer
        // is now for a cover the map no longer holds.
        keepFresh("second", in: map, for: "c1", takenAt: 2)
        XCTAssertEqual(freed["first"], true, "the replaced cover is freed at once")
        pending[0].work()
        XCTAssertEqual(freed["second"], false, "the first cover's timer leaves the second alone")
        XCTAssertGreaterThan(map.bytes, 0)
        pending[1].work()
        XCTAssertEqual(map.bytes, 0)
        XCTAssertEqual(freed["second"], true)
        XCTAssertEqual(drops, ["c1:aged"])
    }

    /// A cover stood over a body brought back, then kept again when that
    /// body is evicted before its page paints, is kept as of the second
    /// eviction: the first keeping's timer leaves it alone, and it ages a
    /// whole delay from the second.
    func testACoverKeptAgainAgesFromItsSecondKeeping() {
        let map = covers()
        var drops: [String] = []
        map.onDrop = { cardId, why in drops.append("\(cardId):\(why.rawValue)") }
        keepFresh("frame", in: map, for: "c1", takenAt: 1)
        let stand = map.standCover(for: "c1", kind: .eviction)!
        // Evicted again before the page paints: the standing frame is kept afresh.
        let again = stand.cover.retaken(at: 2)
        XCTAssertEqual(again.takenAt, 2)
        XCTAssertTrue(again.image === stand.cover.image, "the same frame")
        XCTAssertTrue(map.keep(again, for: "c1", takenIn: map.generation, agesAfterMs: 900_000))
        pending[0].work()
        XCTAssertEqual(drops, [], "the first keeping's timer does not drop the second")
        XCTAssertGreaterThan(map.bytes, 0)
        pending[1].work()
        XCTAssertEqual(drops, ["c1:aged"])
        XCTAssertEqual(map.bytes, 0)
    }

    func testACoverTakenBeforeAClearIsRefused() {
        let map = covers()
        let takenIn = map.generation
        map.clear()
        autoreleasepool {
            XCTAssertFalse(map.keep(cover("late"), for: "c1", takenIn: takenIn, agesAfterMs: 900_000))
        }
        XCTAssertEqual(map.bytes, 0)
        XCTAssertEqual(freed["late"], true, "a refused cover is held by nothing")
        XCTAssertTrue(pending.isEmpty, "and has no timer")
    }

    func testStandingAKeptCoverTakesItOutOfTheKeptMapAndTakingItDownFreesIt() {
        let map = covers()
        keepFresh("shown", in: map, for: "c1")
        var standing: BodyCovers.Stand? = map.standCover(for: "c1", kind: .eviction)
        // Dropping the card's kept cover finds none: the kept map holds it no longer.
        map.drop("c1")
        XCTAssertEqual(freed["shown"], false, "it stands over the body now")
        XCTAssertTrue(map.takeDown(standing!, kind: .eviction, for: "c1"), "the paint takes it off")
        standing = nil
        XCTAssertNil(standing)
        XCTAssertEqual(freed["shown"], true)
    }

    func testACrossingAskedOnACoveredUnpaintedBodyTakesTheStandingCoverAndItComesOffAtTheLaterEnd() {
        let map = covers()
        keepFresh("evicted", in: map, for: "c1")
        var stand: BodyCovers.Stand? = map.standCover(for: "c1", kind: .eviction)
        // Dropping the card's kept cover finds none: it stands over the body now.
        map.drop("c1")
        XCTAssertEqual(freed["evicted"], false)
        let standingBytes = map.bytes
        XCTAssertGreaterThan(standingBytes, 0, "a standing cover still counts")

        // The page has not painted: the crossing takes the cover that stands
        // rather than snapshotting a page that has shown nothing.
        let reused: Bool = {
            if case .standing(let taken) = map.crossingCover(for: "c1", painted: false) { return taken === stand }
            return false
        }()
        XCTAssertTrue(reused, "a covered body's crossing takes the cover it stands under: one cover over one body")
        XCTAssertEqual(stand?.kinds, [.eviction, .crossing])
        XCTAssertEqual(map.bytes, standingBytes, "no second cover was stood")

        // The page paints before the crossing lands: the crossing still holds it.
        XCTAssertFalse(map.takeDown(stand!, kind: .eviction, for: "c1"))
        XCTAssertEqual(stand?.kinds, [.crossing])
        XCTAssertEqual(map.bytes, standingBytes)
        // The land takes it off.
        XCTAssertTrue(map.takeDown(stand!, kind: .crossing, for: "c1"))
        XCTAssertEqual(map.bytes, 0)
        stand = nil
        XCTAssertEqual(freed["evicted"], true, "a cover taken down is held by nothing")
    }

    func testAnUnpaintedBodyUnderNoCoverKeepsItsPageAndOnlyAPaintedOneIsSnapshotted() {
        let map = covers()
        guard case .keepsPage = map.crossingCover(for: "c1", painted: false) else {
            return XCTFail("an unpainted body under no cover keeps its page")
        }
        guard case .snapshot = map.crossingCover(for: "c1", painted: true) else {
            return XCTFail("a painted body under no cover is snapshotted")
        }
        XCTAssertEqual(map.bytes, 0, "asking stood nothing")
    }

    func testTheBudgetCountsCoversStandingOverBodiesAndNeverDropsThem() {
        // Each cover is 64 × 4 × 4 = 1024 bytes; the budget holds two.
        let map = covers(budget: 2048)
        var drops: [String] = []
        map.onDrop = { cardId, why in drops.append("\(cardId):\(why.rawValue)") }
        let stand = autoreleasepool { map.standCover(for: "c0", kind: .crossing, fresh: cover("crossing", width: 64, takenAt: 0)) }
        XCTAssertNotNil(stand)
        keepFresh("old", in: map, for: "c1", width: 64, takenAt: 1)
        keepFresh("new", in: map, for: "c2", width: 64, takenAt: 2)
        XCTAssertEqual(drops, ["c1:budget"], "the standing cover's bytes leave room for one kept cover")
        XCTAssertEqual(freed["crossing"], false, "the standing cover, though oldest, is on screen and stays")
        XCTAssertEqual(map.bytes, 2048)
        map.clear()
        XCTAssertEqual(map.bytes, 1024, "a clear drops the kept covers and leaves the one standing")
    }

    func testAnOlderBodyGoingLeavesItsCardsNewerCoverStanding() {
        let map = covers()
        let old = autoreleasepool { map.standCover(for: "c1", kind: .crossing, fresh: cover("old")) }!
        XCTAssertTrue(map.takeDown(old, kind: .crossing, for: "c1"))
        keepFresh("new", in: map, for: "c1")
        XCTAssertNotNil(map.standCover(for: "c1", kind: .eviction))
        let bytes = map.bytes
        // The closed body's removal comes after its card's new body stands.
        map.release(old, for: "c1")
        XCTAssertEqual(map.bytes, bytes, "the new body keeps its cover")
        XCTAssertEqual(freed["new"], false)
    }
}

/// Fires once when the image whose bytes it was tagged to is freed.
private final class Tag {
    let name: String
    private let onFree: () -> Void
    init(_ name: String, onFree: @escaping () -> Void) {
        self.name = name
        self.onFree = onFree
    }
    func fire() { onFree() }
}
