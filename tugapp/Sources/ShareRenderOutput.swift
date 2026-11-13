import Foundation
import PDFKit

/// Where a share render's files live: `NSTemporaryDirectory()/tug-share/`,
/// in a directory of this process's own, so an artifact is still there for
/// Save… and Share… after its preview and is gone with the app run that made
/// it.
///
/// The per-process directory is what lets that sweep be safe. Several Tug
/// processes can run at once under one user — the user's app beside an
/// app-test's — and they share one temporary directory; a launch that cleared
/// all of `tug-share/` would take a file out from under a preview standing in
/// the other app. So a launch removes only the directories whose process is
/// gone.
///
/// Pure paths and file operations, no window: compiled into the tests too.
enum ShareRenderOutput {
    /// The most pixels an image is rendered with at the display's own scale:
    /// 250 million, a gigabyte of bitmap. An image has no height cap; this
    /// only decides how sharp a very tall one is.
    static let imagePixelBudget: Double = 250_000_000

    /// The scale an image `width` by `height` CSS pixels is rendered at:
    /// `backing` (the display's, 2 on a Retina screen) while the bitmap stays
    /// inside `imagePixelBudget`, and 1 past it — a very tall share is drawn
    /// at one pixel per point rather than refused. At 720 wide and 2× that is
    /// every image up to about 86,800 pixels tall.
    static func imageScale(height: Double, width: Double, backing: Double) -> Double {
        let scale = max(1, backing)
        return width * scale * height * scale <= imagePixelBudget ? scale : 1
    }

    /// `pdf` as one page: its pages drawn end to end, top to bottom, on a
    /// single page as wide as the widest and as tall as all of them. WebKit's
    /// `createPDF` breaks a page at 14,400 points, so a long share arrives in
    /// several; a share's PDF has no page breaks, so they are joined. The
    /// pages are redrawn as PDF content, so text stays text. Returns `nil`
    /// when there is nothing to join — one page already, or data that is not
    /// a PDF — and the caller keeps what it has.
    static func joinedIntoOnePage(_ pdf: Data) -> Data? {
        guard let document = PDFDocument(data: pdf), document.pageCount > 1 else { return nil }
        let pages = (0..<document.pageCount).compactMap { document.page(at: $0) }
        let boxes = pages.map { $0.bounds(for: .mediaBox) }
        let width = boxes.map(\.width).max() ?? 0
        let height = boxes.map(\.height).reduce(0, +)
        guard width > 0, height > 0 else { return nil }
        var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
        let joined = NSMutableData()
        guard let consumer = CGDataConsumer(data: joined),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return nil }
        context.beginPDFPage(nil)
        // PDF space rises from the bottom; the first page goes at the top.
        var top = height
        for (page, box) in zip(pages, boxes) {
            top -= box.height
            context.saveGState()
            context.translateBy(x: -box.minX, y: top - box.minY)
            page.draw(with: .mediaBox, to: context)
            context.restoreGState()
        }
        context.endPDFPage()
        context.closePDF()
        return joined as Data
    }

    /// `NSTemporaryDirectory()/tug-share/`.
    static var root: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("tug-share", isDirectory: true)
    }

    /// This process's directory under `root`.
    static func directory(pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> URL {
        root.appendingPathComponent(String(pid), isDirectory: true)
    }

    /// The file a render of `id` writes, as `<id>.<ext>`.
    static func outputURL(id: String, format: ShareRenderFormat, pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> URL {
        let ext: String
        switch format {
        case .pdf: ext = "pdf"
        case .png: ext = "png"
        }
        return directory(pid: pid).appendingPathComponent("\(id).\(ext)", isDirectory: false)
    }

    /// Whether `path` names a file a render of this process wrote: a `.pdf` or
    /// `.png` directly in its own directory, after `..` is resolved. Save…,
    /// Copy and Share… are handed the path back by the page, and send only a
    /// rendered artifact — never any other file a page could name.
    static func isRenderedArtifact(path: String, pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> Bool {
        guard path.hasPrefix("/") else { return false }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard ["pdf", "png"].contains(url.pathExtension) else { return false }
        return url.deletingLastPathComponent().path == directory(pid: pid).standardizedFileURL.path
    }

    /// Whether `id` may name a render: it becomes a file name and a query
    /// value, so it is held to letters, digits, `-` and `_`.
    static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 128 else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            (scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)) || scalar == "-" || scalar == "_"
        }
    }

    /// Remove every process directory under `root` whose process is no
    /// longer running, and anything there that is not a process directory.
    /// `isAlive` is the test's seam.
    static func sweepStale(isAlive: (Int32) -> Bool = ShareRenderOutput.processIsAlive) {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for entry in entries {
            if let pid = Int32(entry.lastPathComponent), isAlive(pid) { continue }
            try? manager.removeItem(at: entry)
        }
    }

    /// Whether a process with `pid` exists (signal 0 delivers nothing; it only
    /// checks). A process owned by another user still exists.
    static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
