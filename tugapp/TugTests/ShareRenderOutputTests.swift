import Foundation
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

    func testAnImageIsTooTallOnlyPastEightThousandPixels() {
        XCTAssertFalse(ShareRenderOutput.isTooTallForImage(height: 1840))
        XCTAssertFalse(ShareRenderOutput.isTooTallForImage(height: 8000))
        XCTAssertTrue(ShareRenderOutput.isTooTallForImage(height: 8000.5))
        XCTAssertTrue(ShareRenderOutput.isTooTallForImage(height: 9000))
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
