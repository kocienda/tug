import AppKit
import PDFKit

/// The sheet a share's artifact is previewed in before anything leaves the
/// machine: the scrubbed Markdown in a read-only text view, a rendered PDF in
/// a `PDFView`, or a rendered PNG in a scrolling image view, under the title
/// "Share Preview" with one Done button.
///
/// The host shows exactly the artifact the page will send — Copy, Save… and
/// Share… act on this same text or file — so what the user saw here is what
/// leaves. PDFKit pages a document of any length without a deck surface.
///
/// The sheet is sized to 60% of its parent window. It holds nothing past its
/// dismissal: the completion runs once, on Done, and the window goes.
///
/// The keyboard starts on Done, not on the artifact's view: a read-only text
/// view holding first responder swallows Return, so the button's Return would
/// never fire. Escape dismisses too, as it does every sheet with one way out.
final class SharePreviewSheet: NSObject {
    private let window: SharePreviewWindow
    private let completion: () -> Void
    private var finished = false

    /// A sheet for `format`'s artifact — `text` for Markdown, the file at
    /// `path` otherwise — or nil when the file cannot be read, which the
    /// caller answers as a failed preview.
    init?(format: ShareFormat, text: String, path: String, parent: NSWindow, completion: @escaping () -> Void) {
        let size = NSSize(width: max(480, parent.frame.width * 0.6), height: max(360, parent.frame.height * 0.6))
        guard let content = Self.contentView(format: format, text: text, path: path) else { return nil }
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

        let done = NSButton(title: "Done", target: self, action: #selector(done(_:)))
        done.keyEquivalent = "\r"
        done.bezelStyle = .rounded

        let root = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        done.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(content)
        root.addSubview(done)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: root.topAnchor),
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: done.topAnchor, constant: -12),
            done.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            done.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        window.contentView = root
        window.initialFirstResponder = done
        window.onCancel = { [weak self] in self?.done(nil) }
    }

    /// Present the sheet on `parent`.
    func present(on parent: NSWindow) {
        parent.beginSheet(window) { [weak self] _ in self?.finish() }
        window.makeFirstResponder(window.initialFirstResponder)
    }

    @objc private func done(_ sender: Any?) {
        window.sheetParent?.endSheet(window)
        finish()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        window.orderOut(nil)
        completion()
    }

    /// The view that shows the artifact, or nil when its file cannot be read.
    private static func contentView(format: ShareFormat, text: String, path: String) -> NSView? {
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
            view.autoScales = true
            view.displayMode = .singlePageContinuous
            return view
        case .png:
            guard let image = NSImage(contentsOfFile: path) else { return nil }
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
