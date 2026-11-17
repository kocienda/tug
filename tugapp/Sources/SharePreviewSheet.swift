import AppKit
import PDFKit
import UniformTypeIdentifiers

/// The sheet a share's artifact is previewed in: the scrubbed Markdown in a
/// read-only text view, a rendered PDF in a `PDFView`, or a rendered PNG in a
/// scrolling image view, under the title "Share Preview".
///
/// It has one button, Done. The preview is its own action: Copy, Save… and
/// Share… act directly and never pass through here.
///
/// **A figure's sheet has the exits too.** A chart or a diagram shared from
/// its header arrives as two renders of the one figure, a PNG and a PDF, and
/// has no shade beside it to hold its actions. So that sheet carries them: a
/// PNG or PDF choice, which swaps the artifact shown, and Copy, Save… and
/// Share… over the one chosen, each done here in the host. Copy writes the
/// file with the figure's spec as its plain-text flavour, as the header's
/// Copy does; Save… runs a save panel on this sheet; Share… anchors the
/// system picker at its button.
///
/// The host shows exactly the artifact the page will send — Copy, Save… and
/// Share… act on this same text or file — so what the user saw here is what
/// leaves. PDFKit pages a document of any length without a deck surface.
///
/// The sheet is sized to the artifact, not to its parent: it reads the
/// artifact's own size — a PDF's page, an image's points — and is that wide
/// plus its margins, so shared turns open on their 720-point column, a
/// narrow chart on a narrow sheet and a wide diagram on a wide one, each at
/// its own size however large the window behind it is. Nothing is stretched
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

    /// Where the artifact shown stands; a figure's format choice swaps it.
    private let holder = NSView()
    /// One view per artifact: one, or a figure's PNG then PDF.
    private let views: [NSView]
    /// The figure whose exits this sheet carries; nil for a share's preview.
    private let figure: ShareFigure?
    private var formatControl: NSSegmentedControl?
    private var copyButton: NSButton?
    private var picker: NSSharingServicePicker?

    /// The narrowest a sheet with the exits row can be and hold it.
    private static let exitsMinWidth: CGFloat = 540
    /// How long Copy reads "Copied" after a copy.
    private static let copiedSeconds: TimeInterval = 1.2

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
    convenience init?(format: ShareFormat, text: String, path: String, parent: NSWindow,
                      completion: @escaping () -> Void) {
        guard let artifact = Self.artifact(format: format, text: text, path: path,
                                           backing: parent.backingScaleFactor) else { return nil }
        self.init(artifacts: [artifact], figure: nil, parent: parent, completion: completion)
    }

    /// A sheet for a figure's two renders, with the format choice and the
    /// exits; nil when either file cannot be read.
    convenience init?(figure: ShareFigure, parent: NSWindow, completion: @escaping () -> Void) {
        let backing = parent.backingScaleFactor
        guard let png = Self.artifact(format: .png, text: "", path: figure.png, backing: backing),
              let pdf = Self.artifact(format: .pdf, text: "", path: figure.pdf, backing: backing) else { return nil }
        self.init(artifacts: [png, pdf], figure: figure, parent: parent, completion: completion)
    }

    /// The sheet over `artifacts`, the first shown. They are renders of one
    /// thing, so the first's size lays the sheet out for all of them.
    private init?(artifacts: [Artifact], figure: ShareFigure?, parent: NSWindow,
                  completion: @escaping () -> Void) {
        guard let first = artifacts.first else { return nil }
        let layout = ShareRenderOutput.previewLayout(
            artifact: first.size, parent: parent.frame.size, column: ShareRenderer.width
        )
        let contents = artifacts.compactMap { Self.contentView($0, scale: layout.scale) }
        guard contents.count == artifacts.count else { return nil }
        views = contents
        self.figure = figure
        let width = figure == nil ? layout.sheet.width : max(layout.sheet.width, Self.exitsMinWidth)
        window = SharePreviewWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: width, height: layout.sheet.height)),
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
        holder.translatesAutoresizingMaskIntoConstraints = false
        primary.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(holder)
        root.addSubview(primary)
        NSLayoutConstraint.activate([
            holder.topAnchor.constraint(equalTo: root.topAnchor),
            holder.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            holder.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            holder.bottomAnchor.constraint(equalTo: primary.topAnchor, constant: -12),
            primary.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            primary.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        if figure != nil { addExits(to: root, before: primary) }
        show(0)
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

    /// Put the artifact at `index` in the holder, in place of the one there.
    private func show(_ index: Int) {
        guard views.indices.contains(index) else { return }
        holder.subviews.forEach { $0.removeFromSuperview() }
        let view = views[index]
        view.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
    }

    // MARK: - A figure's exits

    /// The format choice at the leading edge of the button row, and Copy,
    /// Save… and Share… before Done.
    private func addExits(to root: NSView, before primary: NSButton) {
        let format = NSSegmentedControl(labels: ["PNG", "PDF"], trackingMode: .selectOne,
                                        target: self, action: #selector(formatChanged(_:)))
        format.selectedSegment = 0
        format.setAccessibilityIdentifier("share-preview-format")
        formatControl = format

        let copy = NSButton(title: "Copy", target: self, action: #selector(copyChosen(_:)))
        copy.setAccessibilityIdentifier("share-preview-copy")
        copyButton = copy
        let save = NSButton(title: "Save…", target: self, action: #selector(saveChosen(_:)))
        save.setAccessibilityIdentifier("share-preview-save")
        let share = NSButton(title: "Share…", target: self, action: #selector(shareChosen(_:)))
        share.setAccessibilityIdentifier("share-preview-share")
        let exits = NSStackView(views: [copy, save, share])
        exits.orientation = .horizontal
        exits.spacing = 8
        for button in [copy, save, share] { button.bezelStyle = .rounded }

        format.translatesAutoresizingMaskIntoConstraints = false
        exits.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(format)
        root.addSubview(exits)
        NSLayoutConstraint.activate([
            format.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            format.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
            exits.trailingAnchor.constraint(equalTo: primary.leadingAnchor, constant: -8),
            exits.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
            exits.leadingAnchor.constraint(greaterThanOrEqualTo: format.trailingAnchor, constant: 16),
            // "Copied" is the longer of Copy's two titles; the row holds still.
            copy.widthAnchor.constraint(greaterThanOrEqualToConstant: 76),
        ])
    }

    /// The chosen render: its file and its format.
    private var chosen: (path: String, format: ShareFormat)? {
        guard let figure else { return nil }
        return formatControl?.selectedSegment == 1 ? (figure.pdf, .pdf) : (figure.png, .png)
    }

    @objc private func formatChanged(_ sender: NSSegmentedControl) {
        show(sender.selectedSegment)
    }

    @objc private func copyChosen(_ sender: Any?) {
        guard let figure, let chosen else { return }
        guard SharePasteboard.write(path: chosen.path, text: figure.text) else {
            TugLog.warn("share", "the preview's Copy could not read the file", [TugLog.field("format", chosen.format.rawValue)])
            NSSound.beep()
            return
        }
        copyButton?.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.copiedSeconds) { [weak self] in
            self?.copyButton?.title = "Copy"
        }
    }

    /// Save the chosen render through a save panel on this sheet. The
    /// parent already has a sheet — this one — so a panel begun on it would
    /// wait behind it and never show.
    @objc private func saveChosen(_ sender: Any?) {
        guard let figure, let chosen else { return }
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.title = ExportPanelConfig.shareSaveTitle
        panel.nameFieldLabel = "Save As:"
        panel.nameFieldStringValue = "\(figure.baseName).\(chosen.format.fileExtension)"
        panel.allowedContentTypes = [chosen.format == .pdf ? UTType.pdf : UTType.png]
        // The panel is out of this process; its presentation is said here,
        // as the export panel's is.
        TugLog.info("export", "save panel shown", [TugLog.field("title", panel.title)])
        panel.beginSheetModal(for: window) { [weak self] response in
            TugLog.info("export", "save panel ended", [
                TugLog.field("title", panel.title),
                TugLog.field("response", response == .OK ? "ok" : "cancel"),
            ])
            guard response == .OK, let url = panel.url else { return }
            let choice = ExportChoice(title: chosen.format.title, ext: chosen.format.fileExtension,
                                      content: .file(URL(fileURLWithPath: chosen.path)))
            do {
                try writeExportChoice(choice, to: url)
            } catch {
                TugLog.warn("export", "write failed", [TugLog.field("error", error.localizedDescription)])
                guard let self else { return }
                NSAlert(error: error).beginSheetModal(for: self.window)
            }
        }
    }

    @objc private func shareChosen(_ sender: NSButton) {
        guard let chosen else { return }
        let picker = NSSharingServicePicker(items: [URL(fileURLWithPath: chosen.path) as NSURL])
        picker.delegate = self
        self.picker = picker
        picker.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
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

extension SharePreviewSheet: NSSharingServicePickerDelegate {
    /// The picker is done — a service chosen, or `nil` when it was dismissed —
    /// so the sheet lets it go.
    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        if picker === sharingServicePicker { picker = nil }
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
