import AppKit
import PDFKit
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
/// **The image** is a snapshot of the whole document at the view's backing
/// scale. A document taller than `ShareRenderOutput.maxImageHeight` answers
/// `tooTall` without a snapshot.
///
/// **The PDF** is a print operation saved to the file: no panels, zero
/// margins, the column fitted to a page of the column's width and a letter
/// page's proportion, paginated down its length, with the theme's ground
/// printed. A result PDFKit reads as no pages, or whose first page's corner
/// is transparent (printed without its ground), is replaced by one tall page
/// from `createPDF`, logged once.
///
/// **Readings**, 2026-11-13, an app-test instance at 2× in the default dark
/// theme, turns of a prompt and a reply carrying a code fence, a list and a
/// paragraph, request to answer:
///
/// - 10 turns: PDF 2.4 s (5 pages), image 2.4 s (5009 px);
/// - 50 turns: PDF 2.7 s (22 pages), image `tooTall` at 24,565 px;
/// - 200 turns: PDF 4.0–4.4 s (85 pages), image `tooTall` at 97,897 px.
///
/// About 2 s of every render is the share page's bounded wait on fonts that
/// never load (`share-main.ts`, `FACE_HORIZON_MS`), so the cost of a large
/// selection is small: neither threshold — a 200-turn PDF over 30 s, an
/// 8000-pixel snapshot failing — tripped, and the cap and the deadline stand.
/// The hidden view painted for the snapshot and for the print operation alike.
/// The dark ground prints to every page edge, so a recipient sees the card's
/// look; the print operation never fell back to `createPDF`. Pages after the
/// first start flush at the page's top edge with no inset of their own beyond
/// a row's gap, and a row may break across a page boundary — read as a
/// continuation, and accepted. The page's HTML runs about 37 KB a turn
/// (7.5 MB at 200), the size of every element's look written inline.
///
/// The print operation calls its did-run selector on its own thread; the
/// handler moves to the main queue before touching the job or the view.
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
    /// The job each running print operation saves, by the operation.
    private var printing: [ObjectIdentifier: String] = [:]

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
            if ShareRenderOutput.isTooTallForImage(height: Double(contentHeight)) {
                TugLog.info("share", "too tall for an image", [TugLog.field("id", id), TugLog.field("height", String(height))])
                job.answer?.answer(ShareRendered(
                    id: id, result: .tooTall, path: "", height: Double(contentHeight), pages: 0, html: ""
                ))
                return
            }
            size(job)
            snapshotPNG(job, height: contentHeight)
        case .pdf:
            size(job)
            window?.hostChannel.send(.shareHtmlRequest(ShareHtmlRequest(id: id)), to: view)
        }
    }

    /// The share page in `view` answered with its inline-styled HTML: print
    /// the PDF, which carries it to the requester.
    func html(id: String, html: String, from view: WKWebView) {
        guard let job = jobs[id], job.view === view, job.ready, job.format == .pdf, !job.hasHtml else { return }
        job.hasHtml = true
        printPDF(job, html: html)
    }

    /// Size the view, and the holder it stands in, to the laid-out document.
    private func size(_ job: Job) {
        job.holder.setFrameSize(NSSize(width: Self.width, height: job.height))
        job.view.setFrameSize(NSSize(width: Self.width, height: job.height))
    }

    /// A page of the column's width in a letter page's proportion.
    private static let pageSize = NSSize(width: width, height: (width * 11 / 8.5).rounded())

    private func printPDF(_ job: Job, html: String) {
        guard let window else { return }
        let id = job.id
        let url = ShareRenderOutput.outputURL(id: id, format: .pdf)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        } catch {
            TugLog.warn("share", "write failed", [TugLog.field("id", id), TugLog.field("error", error.localizedDescription)])
            job.answer?.answer(.failed(id: id))
            return
        }
        let info = NSPrintInfo()
        info.dictionary().setObject(url, forKey: NSPrintInfo.AttributeKey.jobSavingURL as NSCopying)
        info.jobDisposition = .save
        info.paperSize = Self.pageSize
        info.topMargin = 0
        info.bottomMargin = 0
        info.leftMargin = 0
        info.rightMargin = 0
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        let operation = job.view.printOperation(with: info)
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        // WebKit's print view starts at a zero frame, which prints blank.
        operation.view?.frame = job.view.bounds
        printing[ObjectIdentifier(operation)] = id
        jobHtml[id] = html
        operation.runModal(
            for: window,
            delegate: self,
            didRun: #selector(printOperationDidRun(_:success:contextInfo:)),
            contextInfo: nil
        )
    }

    /// The HTML each PDF job's page returned, carried to its answer.
    private var jobHtml: [String: String] = [:]

    /// AppKit calls this on the print operation's own thread, not the main
    /// one: everything it does — the jobs, the view's teardown, the reply —
    /// is main-thread work, so it moves there first.
    @objc private func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        let key = ObjectIdentifier(operation)
        DispatchQueue.main.async { [weak self] in
            self?.printed(key, success: success)
        }
    }

    private func printed(_ key: ObjectIdentifier, success: Bool) {
        guard let id = printing.removeValue(forKey: key), let job = jobs[id] else { return }
        let url = ShareRenderOutput.outputURL(id: id, format: .pdf)
        let html = jobHtml[id] ?? ""
        if success, let pages = Self.paintedPageCount(url) {
            job.answer?.answer(ShareRendered(
                id: id, result: .ok, path: url.path, height: Double(job.height), pages: pages, html: html
            ))
            return
        }
        TugLog.warn("share", "printed PDF is blank; rendering one tall page", [
            TugLog.field("id", id), TugLog.field("printed", String(success)),
        ])
        createPDF(job, url: url, html: html)
    }

    /// One tall page of the whole document, when the print operation printed
    /// nothing or printed without its ground.
    private func createPDF(_ job: Job, url: URL, html: String) {
        let id = job.id
        let config = WKPDFConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: Self.width, height: job.height)
        job.view.createPDF(configuration: config) { [weak self] result in
            guard let self, let job = self.jobs[id] else { return }
            do {
                let data = try result.get()
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

    /// The page count of the PDF at `url` when its first page painted its
    /// ground — a pixel near its top-left corner, drawn over transparency,
    /// is opaque — or `nil` for a file with no pages or a blank first page.
    static func paintedPageCount(_ url: URL) -> Int? {
        guard let document = PDFDocument(url: url), document.pageCount > 0,
              let page = document.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        let w = max(1, Int(bounds.width.rounded())), h = max(1, Int(bounds.height.rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.clear(CGRect(x: 0, y: 0, width: w, height: h))
        page.draw(with: .mediaBox, to: context)
        guard let data = context.data else { return nil }
        // Row 4 from the top, column 4: inside the page's corner, outside any
        // row's ink.
        let alpha = data.load(fromByteOffset: (4 * w + 4) * 4 + 3, as: UInt8.self)
        return alpha == 0 ? nil : document.pageCount
    }

    private func snapshotPNG(_ job: Job, height: CGFloat) {
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: Self.width, height: height)
        config.afterScreenUpdates = true
        let id = job.id
        job.view.takeSnapshot(with: config) { [weak self] image, error in
            guard let self, let job = self.jobs[id] else { return }
            guard let image,
                  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let data = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
                TugLog.warn("share", "snapshot failed", [
                    TugLog.field("id", id),
                    TugLog.field("error", error?.localizedDescription ?? "no image"),
                ])
                job.answer?.answer(.failed(id: id))
                return
            }
            let url = ShareRenderOutput.outputURL(id: id, format: .png)
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true
                )
                try data.write(to: url, options: .atomic)
            } catch {
                TugLog.warn("share", "write failed", [TugLog.field("id", id), TugLog.field("error", error.localizedDescription)])
                job.answer?.answer(.failed(id: id))
                return
            }
            job.answer?.answer(ShareRendered(
                id: id, result: .ok, path: url.path, height: Double(height), pages: 1, html: ""
            ))
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
        jobHtml.removeValue(forKey: id)
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
