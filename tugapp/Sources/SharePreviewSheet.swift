import AppKit
import PDFKit

/// The sheet a share's artifact is previewed in before anything leaves the
/// machine: the scrubbed Markdown in a read-only text view, a rendered PDF in
/// a `PDFView`, or a rendered PNG in a scrolling image view, under the title
/// "Share Preview".
///
/// Its buttons say what the preview stands before. Preview… shows it with one
/// Done button; Copy, Save… or Share… on a selection not yet previewed shows
/// it with Cancel and a button named for that action, which is the user's
/// go-ahead — the page acts only on that button.
///
/// The host shows exactly the artifact the page will send — Copy, Save… and
/// Share… act on this same text or file — so what the user saw here is what
/// leaves. PDFKit pages a document of any length without a deck surface.
///
/// The sheet is sized to 60% of its parent window. It holds nothing past its
/// dismissal: the completion runs once, with whether the user went on, and
/// the window goes.
///
/// The keyboard starts on the default button (Done, or the action), not on
/// the artifact's view: a read-only text view holding first responder
/// swallows Return, so the button's Return would never fire. Escape is Done
/// when Done is the only way out, and Cancel when there is a Cancel.
final class SharePreviewSheet: NSObject {
    private let window: SharePreviewWindow
    private let completion: (Bool) -> Void
    private var finished = false
    /// What dismissing with Escape, or by any path but a button, answers.
    private let escapeGoesOn: Bool

    /// A sheet for `format`'s artifact — `text` for Markdown, the file at
    /// `path` otherwise — offering `confirm` beside Cancel, or Done alone when
    /// `confirm` is empty; nil when the file cannot be read, which the caller
    /// answers as a failed preview. `completion` hears whether the user went
    /// on (Done or `confirm`) rather than cancelling.
    init?(format: ShareFormat, text: String, path: String, confirm: String, parent: NSWindow,
          completion: @escaping (Bool) -> Void) {
        let size = NSSize(width: max(480, parent.frame.width * 0.6), height: max(360, parent.frame.height * 0.6))
        guard let content = Self.contentView(format: format, text: text, path: path) else { return nil }
        window = SharePreviewWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false
        )
        self.completion = completion
        escapeGoesOn = confirm.isEmpty
        super.init()

        window.title = "Share Preview"
        window.isReleasedWhenClosed = false

        let primary = NSButton(title: confirm.isEmpty ? "Done" : confirm, target: self, action: #selector(goOn(_:)))
        primary.keyEquivalent = "\r"
        primary.bezelStyle = .rounded
        primary.setAccessibilityIdentifier("share-preview-primary")
        let cancel: NSButton? = confirm.isEmpty
            ? nil
            : NSButton(title: "Cancel", target: self, action: #selector(cancel(_:)))
        cancel?.bezelStyle = .rounded
        cancel?.setAccessibilityIdentifier("share-preview-cancel")

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
        if let cancel {
            cancel.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(cancel)
            NSLayoutConstraint.activate([
                cancel.trailingAnchor.constraint(equalTo: primary.leadingAnchor, constant: -12),
                cancel.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
            ])
        }
        window.contentView = root
        window.initialFirstResponder = primary
        window.onCancel = { [weak self] in
            guard let self else { return }
            self.dismiss(goOn: self.escapeGoesOn)
        }
    }

    /// Present the sheet on `parent`.
    func present(on parent: NSWindow) {
        parent.beginSheet(window) { [weak self] _ in
            guard let self else { return }
            self.finish(goOn: self.escapeGoesOn)
        }
        window.makeFirstResponder(window.initialFirstResponder)
    }

    @objc private func goOn(_ sender: Any?) {
        dismiss(goOn: true)
    }

    @objc private func cancel(_ sender: Any?) {
        dismiss(goOn: false)
    }

    /// Answer first, then take the sheet down: ending the sheet runs the
    /// `beginSheet` handler, which would otherwise answer for a button it
    /// never saw.
    private func dismiss(goOn: Bool) {
        finish(goOn: goOn)
        window.sheetParent?.endSheet(window)
    }

    private func finish(goOn: Bool) {
        guard !finished else { return }
        finished = true
        window.orderOut(nil)
        completion(goOn)
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
