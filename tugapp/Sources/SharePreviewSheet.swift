import AppKit
import PDFKit

/// The sheet a share's artifact is previewed in: the scrubbed Markdown in a
/// read-only text view, a rendered PDF in a `PDFView`, or a rendered PNG in a
/// scrolling image view, under the title "Share Preview".
///
/// It has one button, Done. The preview is its own action: Copy, Save… and
/// Share… act directly and never pass through here.
///
/// The host shows exactly the artifact the page will send — Copy, Save… and
/// Share… act on this same text or file — so what the user saw here is what
/// leaves. PDFKit pages a document of any length without a deck surface.
///
/// The sheet is sized to the artifact, not to its parent: it reads the
/// artifact's own size — a PDF's page, an image's points — and is that wide
/// plus its margins, so shared turns open on their 720-point column at
/// their own size however large the window behind it is. Nothing is stretched
/// to fill; an artifact wider than the parent leaves room for is scaled
/// down to fit, to a floor its type can still be read at, and scrolls past
/// that (`ShareRenderOutput.previewLayout`). The sheet is as tall as the
/// artifact needs, inside what its parent allows and a cap. It holds
/// nothing past its dismissal: the completion runs once and the window goes.
///
/// The keyboard starts on the default button, Done, not on
/// the artifact's view: a read-only text view holding first responder
/// swallows Return, so the button's Return would never fire. Escape is Done
/// too.
final class SharePreviewSheet: NSObject {
    private let window: SharePreviewWindow
    private let completion: () -> Void
    private var finished = false

    /// An artifact read from its text or its file, with its size in points.
    private enum Artifact {
        case text(String)
        case pdf(PDFDocument, CGSize)
        case image(NSImage, CGSize)

        /// The artifact's own size; text has none.
        var size: CGSize? {
            switch self {
            case .text: return nil
            case .pdf(_, let size), .image(_, let size): return size
            }
        }
    }

    /// A sheet for `format`'s artifact — `text` for Markdown, the file at
    /// `path` otherwise; nil when the file cannot be read, which the caller
    /// answers as a failed preview. `completion` runs once it is dismissed.
    init?(format: ShareFormat, text: String, path: String, parent: NSWindow,
          completion: @escaping () -> Void) {
        guard let artifact = Self.artifact(format: format, text: text, path: path,
                                           backing: parent.backingScaleFactor) else { return nil }
        let layout = ShareRenderOutput.previewLayout(
            artifact: artifact.size, parent: parent.frame.size, column: ShareRenderer.width
        )
        guard let content = Self.contentView(artifact, scale: layout.scale) else { return nil }
        window = SharePreviewWindow(
            contentRect: NSRect(origin: .zero, size: layout.sheet),
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false
        )
        self.completion = completion
        super.init()

        window.title = "Share Preview"
        window.isReleasedWhenClosed = false

        let primary = NSButton(title: "Done", target: self, action: #selector(done(_:)))
        primary.keyEquivalent = "\r"
        primary.bezelStyle = .rounded
        primary.setAccessibilityIdentifier("share-preview-primary")

        let root = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        primary.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(content)
        root.addSubview(primary)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: root.topAnchor),
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: primary.topAnchor, constant: -12),
            primary.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            primary.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        window.contentView = root
        window.initialFirstResponder = primary
        window.onCancel = { [weak self] in self?.dismiss() }
    }

    /// Present the sheet on `parent`.
    func present(on parent: NSWindow) {
        parent.beginSheet(window) { [weak self] _ in self?.finish() }
        window.makeFirstResponder(window.initialFirstResponder)
    }

    @objc private func done(_ sender: Any?) {
        dismiss()
    }

    /// END the sheet and let AppKit's completion finish it. The order is
    /// load-bearing: the window is ordered out only
    /// after the parent has been told the sheet ended. Ordering it out first
    /// leaves the parent's sheet session unfinished, and every sheet begun
    /// after it — a save panel, the next preview —
    /// is queued behind a sheet that is no longer there, and never shown.
    private func dismiss() {
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            finish()
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        window.orderOut(nil)
        completion()
    }

    /// The artifact for `format`, or nil when its file cannot be read.
    /// `backing` is the backing scale an image was rendered at.
    private static func artifact(format: ShareFormat, text: String, path: String, backing: CGFloat) -> Artifact? {
        switch format {
        case .markdown:
            return .text(text)
        case .pdf:
            guard let document = PDFDocument(url: URL(fileURLWithPath: path)),
                  let page = document.page(at: 0) else { return nil }
            return .pdf(document, page.bounds(for: .mediaBox).size)
        case .png:
            guard let image = NSImage(contentsOfFile: path) else { return nil }
            // The render is `backing` pixels to the point; read it in
            // points, whatever resolution the file declares.
            if let rep = image.representations.first, rep.pixelsWide > 0, backing > 0 {
                image.size = NSSize(width: CGFloat(rep.pixelsWide) / backing, height: CGFloat(rep.pixelsHigh) / backing)
            }
            return .image(image, image.size)
        }
    }

    /// The view that shows `artifact` at `scale` times its own size.
    private static func contentView(_ artifact: Artifact, scale: CGFloat) -> NSView? {
        switch artifact {
        case .text(let text):
            let scroll = NSTextView.scrollableTextView()
            guard let textView = scroll.documentView as? NSTextView else { return nil }
            textView.isEditable = false
            textView.isSelectable = true
            textView.font = .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            textView.textContainerInset = NSSize(width: 12, height: 12)
            textView.string = text
            return scroll
        case .pdf(let document, _):
            let view = PDFView()
            view.document = document
            // The page at the layout's scale: `autoScales` would stretch a
            // narrow page to the sheet's width, and its type with it.
            view.autoScales = false
            view.scaleFactor = scale
            view.displayMode = .singlePageContinuous
            view.goToFirstPage(nil)
            return view
        case .image(let image, let size):
            // An image draws at its `size`, so the layout's scale is set
            // there and the view shows it unscaled.
            image.size = NSSize(width: size.width * scale, height: size.height * scale)
            let imageView = NSImageView(image: image)
            imageView.imageScaling = .scaleNone
            imageView.frame = NSRect(origin: .zero, size: image.size)
            let scroll = NSScrollView()
            scroll.hasVerticalScroller = true
            scroll.hasHorizontalScroller = true
            scroll.documentView = imageView
            return scroll
        }
    }
}

/// A rendered share on the pasteboard: the file itself — `com.adobe.pdf` for
/// a PDF, `public.png` for an image — with `text` as
/// `public.utf8-plain-text`. What is pasted is the rendering as it was
/// drawn, and an editor that takes no picture still gets the text.
enum SharePasteboard {
    /// Write the render at `path` with `text` beside it. False, and the
    /// pasteboard untouched, when the path is not a render's or the file
    /// cannot be read.
    static func write(path: String, text: String) -> Bool {
        guard ShareRenderOutput.isRenderedArtifact(path: path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)), !data.isEmpty else { return false }
        let type: NSPasteboard.PasteboardType = path.hasSuffix(".pdf") ? .pdf : .png
        let pasteboard = NSPasteboard.general
        pasteboard.declareTypes([type, .string], owner: nil)
        pasteboard.setData(data, forType: type)
        pasteboard.setString(text, forType: .string)
        return true
    }
}

/// The preview sheet's window: Escape (`cancelOperation`) is its Done.
private final class SharePreviewWindow: NSWindow {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
