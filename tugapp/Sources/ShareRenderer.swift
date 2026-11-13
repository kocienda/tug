import AppKit
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import WebKit

/// Renders shared turns to a file: one hidden web view per render, loading
/// the share page (`/?share=<id>`, `tugdeck/src/share/share-main.ts`), which
/// draws the turns through the Session card's own transcript cells.
///
/// The flow, one job per `shareRender`:
///
///  1. a page posts `shareRender { id, format, document }`;
///  2. the renderer makes a 720-point web view, puts it in the window's
///     container beneath every page (`MainWindow.placeShareView`), and loads
///     the share page from the shell's origin;
///  3. the share page posts `shareHello { id }` and is sent
///     `onShareDocument { id, document }`;
///  4. the share page mounts the document, waits for what a reader would see
///     to land, and posts `shareRenderReady { id, height }`;
///  5. the renderer sizes the view to that height and writes the file under
///     `ShareRenderOutput` — for a PDF it first asks the page
///     `onShareHtmlRequest { id }` and takes `shareRenderHtml { id, html }`,
///     the rich flavour the PDF's Copy writes — and answers the requesting
///     page `onShareRendered { id, result, path, height, pages, html }`.
///
/// The view is held by opacity, never `isHidden`: a hidden view is a hidden
/// page to WebKit, which stops painting it (the rule `BodyHostView` states),
/// and an unpainted page snapshots blank. The opacity is a holder view's, not
/// the web view's own, which a snapshot would carry. The holder stands
/// beneath the shell's view, where nothing the user sees is covered by it.
///
/// One `AnswerOrDeadline` of 60 s bounds each job: a page that never says
/// hello, a document that does not decode (the page then posts nothing), or a
/// snapshot that never returns all answer `failed` at the deadline. Every
/// answer tears the view down — its handlers off, its page stopped, out of
/// the window — so the host keeps nothing between renders. The requesting
/// page is held weakly: an answer to a page that has gone is dropped.
///
/// **The image** is the whole document, however tall. One WebKit snapshot of
/// a very tall rect is the unreliable part, so the document is photographed
/// in tiles of `tileHeight` points, top to bottom, and each is drawn into one
/// bitmap at `ShareRenderOutput.imageScale` — the view's backing scale while
/// the bitmap stays inside the pixel budget, 1× past it — which is then
/// written as a single PNG. There is no height cap: a document too large for
/// even a 1× bitmap fails to allocate and answers `failed`.
///
/// **The PDF** is one continuous page, the column's width and the document's
/// height, from `createPDF`: no page breaks, so no row, fence or line is ever
/// cut across a boundary, and the theme's ground runs edge to edge. It reads
/// as the card does — scrolled, not paged. `createPDF` itself breaks a page
/// at 14,400 points, so a longer document's pages are joined end to end into
/// one (`ShareRenderOutput.joinedIntoOnePage`).
///
/// **Readings**, 2026-11-13, an app-test instance at 2× in the default dark
/// theme, turns of a prompt and a reply carrying a code fence, a list and a
/// paragraph: 10 turns laid out at 5,009 px, 50 at 24,565 px and 200 at
/// 97,897 px, each rendered in 2.4–4.4 s. About 2 s of every render is the
/// share page's bounded wait on fonts that never load (`share-main.ts`,
/// `FACE_HORIZON_MS`), so the cost of a large selection is small. The hidden
/// view paints for the snapshot and for the PDF alike. The page's HTML runs
/// about 37 KB a turn (7.5 MB at 200), the size of every element's look
/// written inline.
final class ShareRenderer: NSObject, WKNavigationDelegate {
    /// How long one render may take, end to end.
    static let deadline: DispatchTimeInterval = .seconds(60)

    /// The column the share page lays out, in points (CSS pixels at 1×).
    static let width: CGFloat = 720

    private final class Job {
        let id: String
        let format: ShareRenderFormat
        let document: String
        let view: WKWebView
        /// The view `view` stands in, which carries the opacity.
        let holder: NSView
        weak var requester: WKWebView?
        var answer: AnswerOrDeadline<ShareRendered>?
        var ready = false
        /// The laid-out height, in CSS pixels, once the page reported it.
        var height: CGFloat = 0
        /// Whether the page's HTML has arrived, for a PDF.
        var hasHtml = false
        /// When the render was asked for, for the log's elapsed time.
        let started = Date()

        init(id: String, format: ShareRenderFormat, document: String, view: WKWebView, holder: NSView, requester: WKWebView) {
            self.id = id
            self.format = format
            self.document = document
            self.view = view
            self.holder = holder
            self.requester = requester
        }
    }

    private weak var window: MainWindow?
    private var jobs: [String: Job] = [:]

    init(window: MainWindow) {
        self.window = window
        super.init()
    }

    /// Whether `view` is one of this renderer's share pages.
    func owns(_ view: WKWebView?) -> Bool {
        guard let view else { return false }
        return jobs.values.contains { $0.view === view }
    }

    /// Start rendering `document` as `format` for the page in `requester`.
    func render(id: String, format: ShareRenderFormat, document: String, replyTo requester: WKWebView) {
        guard let window else { return }
        let refuse = { (reason: String) in
            TugLog.warn("share", "render refused", [TugLog.field("id", id), TugLog.field("reason", reason)])
            window.hostChannel.send(.shareRendered(.failed(id: id)), to: requester)
        }
        guard ShareRenderOutput.isValidId(id) else { return refuse("invalid id") }
        guard jobs[id] == nil else { return refuse("duplicate id") }
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?share=\(id)") else { return refuse("no shell origin") }

        let config = window.makeWebViewConfiguration(forShell: false)
        config.preferences.shouldPrintBackgrounds = true
        let view = WKWebView(
            frame: NSRect(x: 0, y: 0, width: Self.width, height: max(window.frame.height, 200)),
            configuration: config
        )
        view.allowsBackForwardNavigationGestures = false
        // A page that is not rendered lays nothing out, finishes no font
        // load and snapshots nothing, so under the harness — whose window
        // sits where anything covers it — this view keeps rendering, as a
        // body's does.
        if AppDelegate.harnessPidMode { MainWindow.keepRenderingWhenCovered(view) }
        view.navigationDelegate = self
        // The opacity is the holder's, never the web view's own: a snapshot
        // is the view's layer as composited, and a web view at opacity 0
        // photographs as its background with nothing drawn on it. A holder
        // at 0 hides it from the user as `BodyHostView` hides a body.
        let holder = NSView(frame: view.frame)
        holder.wantsLayer = true
        holder.layer?.opacity = 0
        holder.addSubview(view)
        let job = Job(id: id, format: format, document: document, view: view, holder: holder, requester: requester)
        job.answer = AnswerOrDeadline(deadline: Self.deadline) { [weak self] value, timedOut in
            if timedOut {
                TugLog.warn("share", "render timed out", [TugLog.field("id", id)])
            }
            self?.finish(id: id, with: value ?? .failed(id: id))
        }
        jobs[id] = job
        window.placeShareView(holder)
        TugLog.info("share", "render started", [TugLog.field("id", id), TugLog.field("format", format.rawValue)])
        view.load(bodyPageRequest(url))
    }

    /// The share page in `view` booted: send it its document.
    func hello(id: String, from view: WKWebView) {
        guard let window, let job = jobs[id], job.view === view else { return }
        TugLog.info("share", "page ready for its document", [TugLog.field("id", id)])
        window.hostChannel.send(.shareDocument(ShareDocument(id: id, document: job.document)), to: view)
    }

    /// The share page in `view` laid its document out at `height` CSS
    /// pixels: size the view to it and write the file.
    func ready(id: String, height: Double, from view: WKWebView) {
        guard let job = jobs[id], job.view === view, !job.ready else { return }
        job.ready = true
        TugLog.info("share", "page laid out", [TugLog.field("id", id), TugLog.field("height", String(height))])
        let contentHeight = max(1, ceil(height))
        job.height = contentHeight
        switch job.format {
        case .png:
            size(job)
            snapshotPNG(job, height: contentHeight)
        case .pdf:
            size(job)
            window?.hostChannel.send(.shareHtmlRequest(ShareHtmlRequest(id: id)), to: view)
        }
    }

    /// The share page in `view` answered with its inline-styled HTML: write
    /// the PDF, which carries it to the requester.
    func html(id: String, html: String, from view: WKWebView) {
        guard let job = jobs[id], job.view === view, job.ready, job.format == .pdf, !job.hasHtml else { return }
        job.hasHtml = true
        writePDF(job, html: html)
    }

    /// Size the view, and the holder it stands in, to the laid-out document.
    private func size(_ job: Job) {
        job.holder.setFrameSize(NSSize(width: Self.width, height: job.height))
        job.view.setFrameSize(NSSize(width: Self.width, height: job.height))
    }

    /// One continuous page of the whole document: the column's width, the
    /// document's height, no page breaks.
    private func writePDF(_ job: Job, html: String) {
        let id = job.id
        let url = ShareRenderOutput.outputURL(id: id, format: .pdf)
        let config = WKPDFConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: Self.width, height: job.height)
        job.view.createPDF(configuration: config) { [weak self] result in
            guard let self, let job = self.jobs[id] else { return }
            do {
                // `createPDF` breaks a page at 14,400 points; a share's PDF
                // has no breaks, so a long one's pages are joined into one.
                let made = try result.get()
                let data = ShareRenderOutput.joinedIntoOnePage(made) ?? made
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true
                )
                try data.write(to: url, options: .atomic)
                job.answer?.answer(ShareRendered(
                    id: id, result: .ok, path: url.path, height: Double(job.height),
                    pages: PDFDocument(data: data)?.pageCount ?? 1, html: html
                ))
            } catch {
                TugLog.warn("share", "createPDF failed", [TugLog.field("id", id), TugLog.field("error", error.localizedDescription)])
                job.answer?.answer(.failed(id: id))
            }
        }
    }

    /// How tall one snapshot tile is, in points. Well inside what one WebKit
    /// snapshot returns reliably at 2×.
    private static let tileHeight: CGFloat = 4096

    /// Photograph the whole document, a tile at a time, into one bitmap, and
    /// write it as a PNG.
    private func snapshotPNG(_ job: Job, height: CGFloat) {
        let id = job.id
        let backing = Double(job.view.window?.backingScaleFactor ?? 2)
        let scale = CGFloat(ShareRenderOutput.imageScale(height: Double(height), width: Double(Self.width), backing: backing))
        let pixelsWide = Int((Self.width * scale).rounded())
        let pixelsHigh = Int((height * scale).rounded())
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            TugLog.warn("share", "image too large to allocate", [
                TugLog.field("id", id), TugLog.field("pixels", "\(pixelsWide)x\(pixelsHigh)"),
            ])
            job.answer?.answer(.failed(id: id))
            return
        }
        snapshotTile(id: id, into: context, from: 0, height: height, scale: scale)
    }

    /// Photograph the tile starting `y` points down and draw it into
    /// `context`, then go on to the next; past the last, write the PNG.
    private func snapshotTile(id: String, into context: CGContext, from y: CGFloat, height: CGFloat, scale: CGFloat) {
        guard let job = jobs[id] else { return }
        guard y < height else {
            writePNG(id: id, from: context, height: height, scale: scale)
            return
        }
        let tile = min(Self.tileHeight, height - y)
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: y, width: Self.width, height: tile)
        config.afterScreenUpdates = true
        job.view.takeSnapshot(with: config) { [weak self] image, error in
            guard let self, let job = self.jobs[id] else { return }
            guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                TugLog.warn("share", "snapshot failed", [
                    TugLog.field("id", id),
                    TugLog.field("y", String(Int(y))),
                    TugLog.field("error", error?.localizedDescription ?? "no image"),
                ])
                job.answer?.answer(.failed(id: id))
                return
            }
            // The bitmap's origin is its bottom-left; the document's is its top.
            context.draw(cgImage, in: CGRect(
                x: 0, y: (height - y - tile) * scale, width: Self.width * scale, height: tile * scale
            ))
            self.snapshotTile(id: id, into: context, from: y + tile, height: height, scale: scale)
        }
    }

    /// Write the stitched bitmap as one PNG, tagged with its pixel density so
    /// a viewer shows it at the column's own size.
    private func writePNG(id: String, from context: CGContext, height: CGFloat, scale: CGFloat) {
        guard let job = jobs[id] else { return }
        let url = ShareRenderOutput.outputURL(id: id, format: .png)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
        } catch {
            TugLog.warn("share", "write failed", [TugLog.field("id", id), TugLog.field("error", error.localizedDescription)])
            job.answer?.answer(.failed(id: id))
            return
        }
        let dpi = 72 * Double(scale)
        let properties: [CFString: Any] = [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi]
        guard let image = context.makeImage(),
              let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            TugLog.warn("share", "write failed", [TugLog.field("id", id), TugLog.field("error", "no image destination")])
            job.answer?.answer(.failed(id: id))
            return
        }
        // Compressing a very tall image takes seconds: off the main thread,
        // so the app stays live, then back on it to answer.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            let written = CGImageDestinationFinalize(destination)
            DispatchQueue.main.async {
                guard let self, let job = self.jobs[id] else { return }
                guard written else {
                    TugLog.warn("share", "write failed", [TugLog.field("id", id), TugLog.field("error", "the PNG did not finalize")])
                    job.answer?.answer(.failed(id: id))
                    return
                }
                job.answer?.answer(ShareRendered(
                    id: id, result: .ok, path: url.path, height: Double(height), pages: 1, html: ""
                ))
            }
        }
    }

    // MARK: - WKNavigationDelegate

    /// The job whose view is `webView`, if any.
    private func job(for webView: WKWebView) -> Job? {
        jobs.values.first { $0.view === webView }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let job = job(for: webView) else { return }
        TugLog.info("share", "page loaded", [TugLog.field("id", job.id)])
    }

    /// A share page that cannot load will never say hello: answer now rather
    /// than at the deadline.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failLoad(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failLoad(webView, error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let job = job(for: webView) else { return }
        TugLog.warn("share", "page process ended", [TugLog.field("id", job.id)])
        job.answer?.answer(.failed(id: job.id))
    }

    private func failLoad(_ webView: WKWebView, _ error: Error) {
        guard let job = job(for: webView) else { return }
        TugLog.warn("share", "page failed to load", [
            TugLog.field("id", job.id),
            TugLog.field("error", error.localizedDescription),
        ])
        job.answer?.answer(.failed(id: job.id))
    }

    /// Answer the requester, if it is still there, and take the view down.
    private func finish(id: String, with outcome: ShareRendered) {
        guard let job = jobs.removeValue(forKey: id) else { return }
        TugLog.info("share", "render finished", [
            TugLog.field("id", id),
            TugLog.field("result", outcome.result.rawValue),
            TugLog.field("pages", String(outcome.pages)),
            TugLog.field("height", String(Int(outcome.height))),
            TugLog.field("ms", String(Int(Date().timeIntervalSince(job.started) * 1000))),
        ])
        let view = job.view
        HostChannel.unregister(from: view.configuration.userContentController)
        view.navigationDelegate = nil
        view.stopLoading()
        view.removeFromSuperview()
        job.holder.removeFromSuperview()
        if let requester = job.requester, let window {
            window.hostChannel.send(.shareRendered(outcome), to: requester)
        }
    }
}
