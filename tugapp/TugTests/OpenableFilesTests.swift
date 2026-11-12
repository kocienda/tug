import XCTest

final class OpenableFilesTests: XCTestCase {
    private var dir: URL!

    /// The checked-in `Info.plist`, which the test runner's own bundle is not.
    private static let appInfo: [String: Any] = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Info.plist")
        let data = try! Data(contentsOf: url)
        return try! PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
    }()

    private static let extensions =
        OpenableFiles.undeclarableTextExtensions
            .union(OpenableFiles.declaredTextExtensions(in: appInfo))

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenableFilesTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: dir)
    }

    private func file(_ name: String, _ bytes: [UInt8]) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try Data(bytes).write(to: url)
        return url
    }

    private func text(_ name: String, _ body: String = "x\n") throws -> URL {
        try file(name, Array(body.utf8))
    }

    private func editable(_ url: URL) -> Bool {
        OpenableFiles.isEditable(url, extensions: Self.extensions)
    }

    func testPlistDeclaresTheCommonSourceExtensions() {
        let declared = OpenableFiles.declaredTextExtensions(in: Self.appInfo)
        for ext in ["astro", "jsx", "cjs", "less", "sass", "jsonc", "rst", "graphql", "tf", "nix", "zig", "dockerfile"] {
            XCTAssertTrue(declared.contains(ext), ext)
        }
    }

    /// Every declared extension opens even when the bytes would fail the
    /// sniff, so the declaration — not the content — is what admits it.
    func testEveryDeclaredExtensionIsEditable() throws {
        for ext in OpenableFiles.declaredTextExtensions(in: Self.appInfo) {
            let url = try file("x.\(ext)", [0, 0xFF])
            XCTAssertTrue(editable(url), ext)
        }
    }

    /// macOS types `.ts` as MPEG-2 transport stream; it is still TypeScript.
    func testTypeScriptModulesAreEditableDespiteTheirSystemType() throws {
        for ext in ["ts", "mts", "cts"] {
            XCTAssertTrue(editable(try text("x.\(ext)")), ext)
            XCTAssertTrue(OpenableFiles.isOpenable(try text("y.\(ext)")), ext)
        }
    }

    func testAstroIsOpenable() throws {
        XCTAssertTrue(OpenableFiles.isOpenable(try text("Page.astro", "---\nconst a = 1;\n---\n<p>{a}</p>\n")))
    }

    /// An extension another app saves its documents under is never claimed:
    /// declaring `pxd` as Cython stopped Pixelmator Pro opening its own files.
    func testPlistDeclaresNoContestedExtension() {
        let declared = OpenableFiles.declaredTextExtensions(in: Self.appInfo)
        for ext in OpenableFiles.contestedTextExtensions {
            XCTAssertFalse(declared.contains(ext), ext)
        }
        XCTAssertTrue(declared.contains("pyx"))
    }

    /// A contested extension opens by its bytes, whatever the system types it
    /// as: a Cython `.pxd` is text, a flat Pixelmator document is not.
    func testContestedExtensionIsSniffed() throws {
        let cython = try text("defs.pxd", "cdef extern from \"math.h\":\n    double sqrt(double x)\n")
        XCTAssertTrue(editable(cython))
        XCTAssertTrue(OpenableFiles.isOpenable(cython))
        let document = try file("picture.pxd", [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65, 0x00, 0x01])
        XCTAssertFalse(editable(document))
        XCTAssertFalse(OpenableFiles.isOpenable(document))
    }

    func testExtensionlessTextIsEditable() throws {
        for name in ["Dockerfile", "Justfile", "Procfile", ".gitignore", ".env", "CODEOWNERS"] {
            XCTAssertTrue(editable(try text(name)), name)
        }
        XCTAssertTrue(editable(try text("empty-file", "")))
    }

    func testUnknownExtensionIsSniffed() throws {
        XCTAssertTrue(editable(try text("notes.zzqq", "plain words\n")))
        XCTAssertFalse(editable(try file("blob.zzqq", [0x00, 0x01, 0x02])))
        XCTAssertFalse(editable(try file("bad.zzqq", [0x61, 0xFF, 0xFE, 0x62])))
        XCTAssertFalse(editable(try file("Blobfile", [0x7F, 0x45, 0x4C, 0x46, 0x00])))
    }

    /// A multibyte character cut by the 4 KB read is still text.
    func testMultibyteSequenceCutAtTheReadLimitIsText() throws {
        let body = String(repeating: "a", count: 4095) + "é tail\n"
        XCTAssertTrue(OpenableFiles.looksLikeText(try text("cut.zzqq", body)))
    }

    func testViewableIsOpenableButNotEditable() throws {
        let png = try file("pic.png", [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])
        XCTAssertTrue(OpenableFiles.isOpenable(png))
        XCTAssertFalse(editable(png))
    }

    func testDirectoryIsNeither() throws {
        let sub = dir.appendingPathComponent("folder.ts")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        XCTAssertFalse(editable(sub))
        XCTAssertFalse(OpenableFiles.isOpenable(sub))
    }
}
