import CoreGraphics
import XCTest

// The covers' map is their only owner: a cover the map lets go — by budget,
// by age, by its card closing, or by critical pressure's clear — frees its
// image there and then, whatever timer is still pending for it. A clear
// also refuses a cover taken before it.
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
        XCTAssertTrue(map.has("c1"), "the first cover's timer leaves the second alone")
        pending[1].work()
        XCTAssertFalse(map.has("c1"))
        XCTAssertEqual(freed["second"], true)
        XCTAssertEqual(drops, ["c1:aged"])
    }

    func testACoverTakenBeforeAClearIsRefused() {
        let map = covers()
        let takenIn = map.generation
        map.clear()
        autoreleasepool {
            XCTAssertFalse(map.keep(cover("late"), for: "c1", takenIn: takenIn, agesAfterMs: 900_000))
        }
        XCTAssertFalse(map.has("c1"))
        XCTAssertEqual(freed["late"], true, "a refused cover is held by nothing")
        XCTAssertTrue(pending.isEmpty, "and has no timer")
    }

    func testTakingACoverHandsItToTheBodyAndTheMapHoldsItNoLonger() {
        let map = covers()
        keepFresh("shown", in: map, for: "c1")
        var standing: BodyCover? = map.take("c1")
        XCTAssertFalse(map.has("c1"))
        XCTAssertEqual(freed["shown"], false, "the body's cover view holds it now")
        standing = nil
        XCTAssertNil(standing)
        XCTAssertEqual(freed["shown"], true)
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
