import Foundation
import XCTest

// The export save panel's configuration, read without a window: what the
// Format popup lists and which filename it suggests, for `/export`'s two
// text choices and for a share's one previewed artifact. And the write itself,
// for both kinds of content.
final class ExportChoiceTests: XCTestCase {
    func testTheExportChoicesOfferMarkdownAndJSONLines() {
        let config = ExportPanelConfig.make(baseName: "tug-session-x", choices: [
            ExportChoice(title: "Markdown", ext: "md", content: .text("# S")),
            ExportChoice(title: "JSON Lines", ext: "jsonl", content: .text("{}\n")),
        ])
        check("the popup lists Markdown then JSON Lines", config.popupTitles == ["Markdown", "JSON Lines"], "\(config.popupTitles)")
        check("the filename takes the first choice's extension", config.initialFilename == "tug-session-x.md", config.initialFilename)
        check("the panel keeps its export title", config.title == "Export Session", config.title)
    }

    func testAShareSaveOffersItsOneFormat() {
        let pdf = URL(fileURLWithPath: "/tmp/tug-share/share-4.pdf")
        let config = ExportPanelConfig.make(baseName: "tug-share-tug", choices: [
            ExportChoice(title: ShareFormat.pdf.title, ext: ShareFormat.pdf.fileExtension, content: .file(pdf)),
        ])
        check("the popup lists PDF alone", config.popupTitles == ["PDF"], "\(config.popupTitles)")
        check("the filename ends .pdf", config.initialFilename == "tug-share-tug.pdf", config.initialFilename)
    }

    func testAChoiceWritesTextAndCopiesAFileOverAnExistingOne() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("export-choice-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let text = dir.appendingPathComponent("a.md")
        try writeExportChoice(ExportChoice(title: "Markdown", ext: "md", content: .text("# héllo")), to: text)
        check("text is written as UTF-8", try String(contentsOf: text, encoding: .utf8) == "# héllo")

        let source = dir.appendingPathComponent("rendered.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: source)
        let target = dir.appendingPathComponent("saved.png")
        try Data("old".utf8).write(to: target)
        try writeExportChoice(ExportChoice(title: "PNG Image", ext: "png", content: .file(source)), to: target)
        check("a file replaces what was there", try Data(contentsOf: target) == Data([0x89, 0x50, 0x4E, 0x47]))
    }
}
