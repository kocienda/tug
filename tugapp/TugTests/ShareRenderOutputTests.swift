import Foundation
import PDFKit
import XCTest

// Where a share render writes, read without a window: every file under
// `NSTemporaryDirectory()/tug-share/`, in this process's own directory; the
// ids a render may carry; and the launch sweep, which takes the directories of
// processes that have ended and leaves a live one's alone.
final class ShareRenderOutputTests: XCTestCase {
    func testAnOutputLivesUnderTheTemporaryShareDirectory() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("tug-share", isDirectory: true)
        let png = ShareRenderOutput.outputURL(id: "share-render-1", format: .png, pid: 4242)
        XCTAssertEqual(png.path, root.appendingPathComponent("4242/share-render-1.png").path)
        XCTAssertTrue(png.path.hasPrefix(root.path + "/"))
        let pdf = ShareRenderOutput.outputURL(id: "share-render-1", format: .pdf)
        XCTAssertEqual(pdf.lastPathComponent, "share-render-1.pdf")
        XCTAssertEqual(
            pdf.deletingLastPathComponent().lastPathComponent,
            String(ProcessInfo.processInfo.processIdentifier)
        )
    }

    func testAnIdIsHeldToSafeCharacters() {
        XCTAssertTrue(ShareRenderOutput.isValidId("share-render-mhx2k-3"))
        XCTAssertTrue(ShareRenderOutput.isValidId("A_b-9"))
        XCTAssertFalse(ShareRenderOutput.isValidId(""))
        XCTAssertFalse(ShareRenderOutput.isValidId("../etc"))
        XCTAssertFalse(ShareRenderOutput.isValidId("a/b"))
        XCTAssertFalse(ShareRenderOutput.isValidId("a b"))
        XCTAssertFalse(ShareRenderOutput.isValidId("a&b=c"))
        XCTAssertFalse(ShareRenderOutput.isValidId("é"))
        XCTAssertFalse(ShareRenderOutput.isValidId(String(repeating: "a", count: 129)))
    }

    func testOnlyThisProcesssRenderedFilesAreArtifacts() {
        let png = ShareRenderOutput.outputURL(id: "share-render-1", format: .png, pid: 4242)
        XCTAssertTrue(ShareRenderOutput.isRenderedArtifact(path: png.path, pid: 4242))
        XCTAssertFalse(ShareRenderOutput.isRenderedArtifact(path: png.path, pid: 4243))
        let dir = ShareRenderOutput.directory(pid: 4242).path
        XCTAssertFalse(ShareRenderOutput.isRenderedArtifact(path: dir + "/../4243/x.png", pid: 4242))
        XCTAssertFalse(ShareRenderOutput.isRenderedArtifact(path: dir + "/notes.txt", pid: 4242))
        XCTAssertFalse(ShareRenderOutput.isRenderedArtifact(path: "/Users/u/.ssh/id_rsa.png", pid: 4242))
        XCTAssertFalse(ShareRenderOutput.isRenderedArtifact(path: "", pid: 4242))
    }

    func testAnImageKeepsTheDisplaysScaleUntilThePixelBudgetAndIsNeverRefused() {
        // Short and tall alike render at the display's scale inside the budget.
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 1840, width: 720, backing: 2), 2)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 24_565, width: 720, backing: 2), 2)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 86_000, width: 720, backing: 2), 2)
        // Past it, one pixel per point: still an image.
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 97_897, width: 720, backing: 2), 1)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 1_000_000, width: 720, backing: 2), 1)
        // A 1× display is 1× throughout, and a nonsense backing is too.
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 1840, width: 720, backing: 1), 1)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 1840, width: 720, backing: 0), 1)
    }

    /// A PDF of `heights.count` pages, each `width` wide and as tall as named.
    private func pdf(width: CGFloat, heights: [CGFloat]) -> Data {
        let data = NSMutableData()
        var first = CGRect(x: 0, y: 0, width: width, height: heights[0])
        let context = CGContext(consumer: CGDataConsumer(data: data)!, mediaBox: &first, nil)!
        for height in heights {
            var box = CGRect(x: 0, y: 0, width: width, height: height)
            let info = [kCGPDFContextMediaBox as String: Data(bytes: &box, count: MemoryLayout<CGRect>.size)] as CFDictionary
            context.beginPDFPage(info)
            context.setFillColor(CGColor(gray: 0.2, alpha: 1))
            context.fill(box)
            context.endPDFPage()
        }
        context.closePDF()
        return data as Data
    }

    func testAFigureDocumentIsToldFromTurnsByItsKind() {
        XCTAssertTrue(ShareRenderOutput.isFigureDocument(
            #"{"version":1,"kind":"figure","theme":"sloop","source":"{}","layers":"chart"}"#
        ))
        // A turns document has no kind.
        XCTAssertFalse(ShareRenderOutput.isFigureDocument(#"{"version":1,"theme":"sloop","width":720}"#))
        XCTAssertFalse(ShareRenderOutput.isFigureDocument(#"{"kind":"turns"}"#))
        XCTAssertFalse(ShareRenderOutput.isFigureDocument(#"{"kind":7}"#))
        XCTAssertFalse(ShareRenderOutput.isFigureDocument(#"["figure"]"#))
        XCTAssertFalse(ShareRenderOutput.isFigureDocument("not json"))
    }

    func testTurnsKeepTheirColumnAndAFigureTakesTheWidthItDrew() {
        // Turns are the column whatever the page reported.
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: 720, figure: false, column: 720), 720)
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: 1088, figure: false, column: 720), 720)
        // A figure is as wide as it drew: a narrow chart and a wide diagram.
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: 528, figure: true, column: 720), 528)
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: 1087.2, figure: true, column: 720), 1088)
        // A report that is no width leaves the column; one past the bound is held to it.
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: 0, figure: true, column: 720), 720)
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: .nan, figure: true, column: 720), 720)
        XCTAssertEqual(ShareRenderOutput.renderWidth(reported: .infinity, figure: true, column: 720), 720)
        XCTAssertEqual(
            ShareRenderOutput.renderWidth(reported: 50_000, figure: true, column: 720),
            ShareRenderOutput.figureMaxWidth
        )
        // The view starts wider than the widest chart a spec may ask for.
        XCTAssertGreaterThan(ShareRenderOutput.figureStartWidth, 1600)
    }

    func testAFiguresImageIsBudgetedByItsOwnWidth() {
        // A 1,088-wide diagram at 2× is inside the budget far past where a
        // 720-wide share would be, per point of height.
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 900, width: 1088, backing: 2), 2)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 60_000, width: 1088, backing: 2), 1)
        XCTAssertEqual(ShareRenderOutput.imageScale(height: 60_000, width: 720, backing: 2), 2)
    }

    func testThePreviewSheetIsSizedFromItsArtifact() {
        let parent = CGSize(width: 1400, height: 1000)
        let chrome = ShareRenderOutput.previewChromeWidth
        let bar = ShareRenderOutput.previewChromeHeight

        // Shared turns: the column plus the chrome, as tall as the cap, at scale 1.
        let turns = ShareRenderOutput.previewLayout(artifact: CGSize(width: 720, height: 5000), parent: parent, column: 720)
        XCTAssertEqual(turns, .init(sheet: CGSize(width: 720 + chrome, height: 760), scale: 1))

        // A narrow chart: a narrow sheet, held at the minimum, as tall as the chart needs.
        let chart = ShareRenderOutput.previewLayout(artifact: CGSize(width: 400, height: 280), parent: parent, column: 720)
        XCTAssertEqual(chart, .init(sheet: CGSize(width: 480, height: 280 + bar), scale: 1))

        // A wide diagram the parent has room for: its own width, unscaled.
        let diagram = ShareRenderOutput.previewLayout(artifact: CGSize(width: 1088, height: 600), parent: parent, column: 720)
        XCTAssertEqual(diagram, .init(sheet: CGSize(width: 1088 + chrome, height: 600 + bar), scale: 1))

        // The same diagram over a narrower parent is scaled to fit, and its height with it.
        let fitted = ShareRenderOutput.previewLayout(
            artifact: CGSize(width: 1088, height: 600), parent: CGSize(width: 1080, height: 1000), column: 720
        )
        XCTAssertEqual(fitted.sheet.width, 1000)
        XCTAssertEqual(fitted.scale, (1000 - chrome) / 1088, accuracy: 0.0001)
        XCTAssertEqual(fitted.sheet.height, (600 * fitted.scale).rounded(.up) + bar)

        // Past the floor it is not scaled further; the sheet scrolls.
        let floored = ShareRenderOutput.previewLayout(
            artifact: CGSize(width: 1600, height: 600), parent: CGSize(width: 700, height: 1000), column: 720
        )
        XCTAssertEqual(floored.scale, ShareRenderOutput.previewMinScale)
        XCTAssertEqual(floored.sheet.width, 620)

        // Text has no size of its own: the column, the full height.
        let text = ShareRenderOutput.previewLayout(artifact: nil, parent: parent, column: 720)
        XCTAssertEqual(text, .init(sheet: CGSize(width: 720 + chrome, height: 760), scale: 1))

        // A short parent bounds the height.
        let short = ShareRenderOutput.previewLayout(
            artifact: CGSize(width: 720, height: 5000), parent: CGSize(width: 1400, height: 600), column: 720
        )
        XCTAssertEqual(short.sheet.height, 440)
    }

    func testALongSharesPagesAreJoinedIntoOne() throws {
        let joined = try XCTUnwrap(ShareRenderOutput.joinedIntoOnePage(pdf(width: 720, heights: [14_400, 590])))
        let document = try XCTUnwrap(PDFDocument(data: joined))
        XCTAssertEqual(document.pageCount, 1)
        let box = try XCTUnwrap(document.page(at: 0)).bounds(for: .mediaBox)
        XCTAssertEqual(box.width, 720, accuracy: 0.5)
        XCTAssertEqual(box.height, 14_990, accuracy: 0.5)
    }

    func testAOnePagePDFAndNonsenseAreLeftAlone() {
        XCTAssertNil(ShareRenderOutput.joinedIntoOnePage(pdf(width: 720, heights: [594])))
        XCTAssertNil(ShareRenderOutput.joinedIntoOnePage(Data("not a pdf".utf8)))
    }

    func testTheSweepTakesEndedProcessesAndLeavesLiveOnes() throws {
        let manager = FileManager.default
        let live = ShareRenderOutput.directory(pid: 900_001)
        let ended = ShareRenderOutput.directory(pid: 900_002)
        let stray = ShareRenderOutput.root.appendingPathComponent("not-a-pid-\(UUID().uuidString)")
        for dir in [live, ended] {
            try manager.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data("x".utf8).write(to: dir.appendingPathComponent("a.png"))
        }
        try Data("x".utf8).write(to: stray)
        defer {
            for url in [live, ended, stray] { try? manager.removeItem(at: url) }
        }

        // Every other entry under the root reads as live, so the sweep the
        // test runs leaves whatever a real Tug process put there alone.
        ShareRenderOutput.sweepStale { pid in pid != 900_002 }

        XCTAssertTrue(manager.fileExists(atPath: live.appendingPathComponent("a.png").path))
        XCTAssertFalse(manager.fileExists(atPath: ended.path))
        XCTAssertFalse(manager.fileExists(atPath: stray.path))
    }

    func testThisProcessIsAliveAndAnImpossiblePidIsNot() {
        XCTAssertTrue(ShareRenderOutput.processIsAlive(ProcessInfo.processInfo.processIdentifier))
        XCTAssertFalse(ShareRenderOutput.processIsAlive(0))
        XCTAssertFalse(ShareRenderOutput.processIsAlive(-1))
    }
}
