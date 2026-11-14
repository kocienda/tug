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
/// The sheet is sized to the artifact, not to its parent: a share renders
/// `ShareRenderer.width` points wide, and the sheet is that wide plus
/// its margins, so the artifact is shown at its own size — the size the
/// transcript's type is read at — however large the window behind it is. A
/// PDF is shown at scale 1 and an image at its point size, neither stretched
/// to fill. The sheet is as tall as its parent allows, up to a cap. It holds
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

    /// Room beside the artifact for the scroller and the view's own margins.
    private static let chromeWidth: CGFloat = 48
    /// The tallest the sheet opens, whatever its parent's height.
    private static let maxHeight: CGFloat = 760

    /// A sheet for `format`'s artifact — `text` for Markdown, the file at
    /// `path` otherwise; nil when the file cannot be read, which the caller
    /// answers as a failed preview. `completion` runs once it is dismissed.
    init?(format: ShareFormat, text: String, path: String, parent: NSWindow,
          completion: @escaping () -> Void) {
        let size = NSSize(
            width: min(ShareRenderer.width + Self.chromeWidth, max(480, parent.frame.width - 80)),
            height: min(Self.maxHeight, max(360, parent.frame.height - 160))
        )
        guard let content = Self.contentView(format: format, text: text, path: path,
                                             scale: parent.backingScaleFactor) else { return nil }
        window = SharePreviewWindow(
            contentRect: NSRect(origin: .zero, size: size),
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

    /// The view that shows the artifact at its own size, or nil when its file
    /// cannot be read. `scale` is the backing scale an image was rendered at.
    private static func contentView(format: ShareFormat, text: String, path: String, scale: CGFloat) -> NSView? {
        switch format {
        case .markdown:
            let scroll = NSTextView.scrollableTextView()
            guard let textView = scroll.documentView as? NSTextView else { return nil }
            textView.isEditable = false
            textView.isSelectable = true
            textView.font = .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            textView.textContainerInset = NSSize(width: 12, height: 12)
            textView.string = text
            return scroll
        case .pdf:
            guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else { return nil }
            let view = PDFView()
            view.document = document
            // The page at its own size: `autoScales` would stretch a
            // 720-point page to the sheet's width, and its type with it.
            view.autoScales = false
            view.scaleFactor = 1
            view.displayMode = .singlePageContinuous
            view.goToFirstPage(nil)
            return view
        case .png:
            guard let image = NSImage(contentsOfFile: path) else { return nil }
            // The render is `scale` pixels to the point; show it in points,
            // whatever resolution the file declares.
            if let rep = image.representations.first, rep.pixelsWide > 0, scale > 0 {
                image.size = NSSize(width: CGFloat(rep.pixelsWide) / scale, height: CGFloat(rep.pixelsHigh) / scale)
            }
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

/// The preview sheet's window: Escape (`cancelOperation`) is its Done.
private final class SharePreviewWindow: NSWindow {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
