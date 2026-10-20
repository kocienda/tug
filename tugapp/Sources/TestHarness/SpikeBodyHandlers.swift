#if DEBUG
import AppKit
import CryptoKit
import WebKit

// MARK: - SpikeBodyHandlers
//
// The `spikeBody` harness verb: one child WKWebView, with a configuration of
// its own, placed over the deck's view where a card stands. It exists to
// answer one question before any body
// view is built — does a page in its own WebContent process keep its frames
// while the deck's main thread is stalled — and the reading it returns is the
// one the stage is gated on (at0737).
//
// The child loads `/?body=spike` (`tugdeck/src/body/spike-page.ts`), which
// animates, appends a log line every frame, records its rAF times and counts
// its pointerdowns. Its content controller carries `spikeReady` and
// `pageFault` and nothing else: the deck's `frontendReady` reveals the shell
// and announces its launch, and nothing here may do either.
//
// `run` stalls the deck with a synchronous loop evaluated into it and, over
// the stall, takes three readings that each could pass while the user saw
// judder, so all three are taken:
//   - the child's own rAF ticks over the whole stall (its frame production);
//   - the host display link sampling the container's presentation layer while
//     a Core Animation translate runs on it, over the stall's first half
//     (the render server's);
//   - composited window captures cropped to the child's rect, over the
//     stall's second half (the window's truth).
// The translate and the captures take different halves because a moving
// container makes every crop of it differ, which would read the render
// server's motion as the child's paint.
//
// DEBUG-only; the body views replace the placement half of it.

final class SpikeBodyHandlers: NSObject, WKScriptMessageHandler {
    /// The child's frame, top-left origin, in the window's content points.
    static let childFrame = NSRect(x: 200, y: 200, width: 600, height: 400)
    /// How long a cold child may take to say it painted.
    static let readyDeadlineMs = 10_000
    /// The run's lead-in before the stall, which also gives the child's own
    /// frame period to judge it by.
    static let leadInMs = 200
    /// How long after the stall the run waits before reading.
    static let tailMs = 200
    /// The capture cadence of the burst.
    static let burstIntervalMs = 16

    private weak var window: MainWindow?
    private var host: NSView?
    private var container: NSView?
    private var webView: WKWebView?
    private var createdAt: CFTimeInterval = 0
    private var pendingCreate: ((Result<[String: Any], SpikeError>) -> Void)?
    private var createDeadline: DispatchWorkItem?

    struct SpikeError: Error {
        let name: String
        let message: String
    }

    init(window: MainWindow) {
        self.window = window
    }

    /// The container's layer, for `hostFrames {layer: "spike"}`.
    var containerLayer: CALayer? { container?.layer }

    // MARK: create

    func create(completion: @escaping (Result<[String: Any], SpikeError>) -> Void) {
        destroy()
        guard let window, let origin = window.shellOrigin else {
            completion(.failure(SpikeError(name: "SpikeError", message: "the deck has loaded no page yet")))
            return
        }
        let controller = WKUserContentController()
        controller.add(self, name: "spikeReady")
        controller.add(self, name: "pageFault")
        let config = WKWebViewConfiguration()
        applyWebKitFeatureOverrides(to: config.preferences)
        config.userContentController = controller
        PageFaultScript.install(into: config)
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        if TestHarnessBridge.envSocketPath() != nil {
            TestHarnessUserScript.install(into: config)
        }

        let shellContainer = window.shellContainerView
        let host = SpikeHostView(frame: shellContainer.bounds)
        host.autoresizingMask = [.width, .height]
        host.wantsLayer = true
        let container = NSView(frame: Self.childFrame)
        container.wantsLayer = true
        container.layer?.masksToBounds = true
        container.layer?.cornerRadius = 8
        let webView = SpikeWebView(frame: container.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        host.addSubview(container)
        window.insertAboveShell(host)
        self.host = host
        self.container = container
        self.webView = webView

        createdAt = CACurrentMediaTime()
        pendingCreate = completion
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, let pending = self.pendingCreate else { return }
            self.pendingCreate = nil
            pending(.failure(SpikeError(
                name: "SpikeTimeoutError",
                message: "the spike page did not report painted within \(Self.readyDeadlineMs) ms"
            )))
        }
        createDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.readyDeadlineMs), execute: deadline)
        if let url = URL(string: "\(origin)/?body=spike") {
            webView.load(URLRequest(url: url))
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "spikeReady":
            guard let pending = pendingCreate else { return }
            pendingCreate = nil
            createDeadline?.cancel()
            createDeadline = nil
            let frame = Self.childFrame
            pending(.success([
                "coldMs": (CACurrentMediaTime() - createdAt) * 1000,
                "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
            ]))
        case "pageFault":
            PageFaultScript.log(message.body)
        default:
            break
        }
    }

    // MARK: run

    func run(stallMs: Int, translatePx: Double, completion: @escaping (Result<[String: Any], SpikeError>) -> Void) {
        guard let window, let webView, let container, let layer = container.layer else {
            completion(.failure(SpikeError(name: "SpikeError", message: "no spike: call create first")))
            return
        }
        let meter = window.hostFrameMeter
        let halfMs = stallMs / 2
        meter.arm(windowMs: Self.leadInMs + stallMs + Self.tailMs, sampling: layer)
        webView.evaluateJavaScript("window.__tugBodySpike.start()") { _, error in
            if let error { NSLog("spikeBody: start failed: %@", error.localizedDescription) }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.leadInMs)) { [weak self] in
            guard let self else { return }
            let stallStartMs = meter.msSinceArm(CACurrentMediaTime())
            // The deck's main thread, held. Not awaited: the reply would only
            // come after the loop, and nothing here waits on it.
            window.evaluateJavaScript(
                "(()=>{const t=performance.now();while(performance.now()-t<\(stallMs)){}return 1})()"
            ) { _, _ in }

            // First half: the render server moves the container.
            let x = layer.position.x
            let translate = CABasicAnimation(keyPath: "position.x")
            translate.fromValue = x
            translate.toValue = x + CGFloat(translatePx)
            translate.duration = 0.25
            translate.autoreverses = true
            translate.repeatCount = Float(halfMs) / 500
            layer.add(translate, forKey: "spike-translate")

            // Second half: composited captures of the still container.
            let windowNumber = CGWindowID(window.windowNumber)
            let crop = self.pixelRect(of: container, in: window)
            var burst: (pairs: Int, differing: Int) = (0, 0)
            let burstDone = DispatchGroup()
            burstDone.enter()
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(halfMs)) {
                burst = Self.captureBurst(windowNumber: windowNumber, crop: crop, durationMs: stallMs - halfMs)
                burstDone.leave()
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(stallMs + Self.tailMs)) {
                burstDone.notify(queue: .main) {
                    webView.evaluateJavaScript("JSON.stringify(window.__tugBodySpike.read())") { result, error in
                        guard let json = result as? String,
                              let data = json.data(using: .utf8),
                              let child = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                            completion(.failure(SpikeError(
                                name: "SpikeError",
                                message: "the child's reading failed: \(error?.localizedDescription ?? "no value")"
                            )))
                            return
                        }
                        completion(.success(self.reading(
                            meter: meter,
                            child: child,
                            stallStartMs: stallStartMs,
                            stallMs: Double(stallMs),
                            burst: burst
                        )))
                    }
                }
            }
        }
    }

    private func reading(
        meter: HostFrameMeter,
        child: [String: Any],
        stallStartMs: Double,
        stallMs: Double,
        burst: (pairs: Int, differing: Int)
    ) -> [String: Any] {
        let stallEndMs = stallStartMs + stallMs
        // The child's ticks are on its own clock, from its `start()`, which
        // the host called as it armed the meter: the stall is the same span
        // on both, to within the call's delivery.
        let ticks = (child["ticks"] as? [NSNumber])?.map(\.doubleValue) ?? []
        let leadIn = ticks.filter { $0 < stallStartMs }
        let childPeriod = FrameMeterStats.medianIntervalMs(leadIn) ?? meter.periodMs
        let childStats = FrameMeterStats.summarize(
            timestampsMs: ticks, periodMs: childPeriod,
            windowStartMs: stallStartMs, windowEndMs: stallEndMs
        )
        return [
            "meter": meter.read(fromMs: stallStartMs, toMs: stallEndMs).filter { $0.key != "samples" },
            "presentationAdvancedRatio": meter.presentationAdvancedRatio(
                fromMs: stallStartMs, toMs: stallStartMs + stallMs / 2),
            "child": [
                "periodMs": childPeriod,
                "ticks": childStats.ticks,
                "expectedTicks": childStats.expectedTicks,
                "worstGapMs": childStats.worstGapMs,
                "pointerdowns": (child["pointerdowns"] as? NSNumber)?.intValue ?? 0,
            ] as [String: Any],
            "burst": ["pairs": burst.pairs, "differing": burst.differing],
        ]
    }

    /// The child's rect in the window capture's pixels, inset off its rounded
    /// corners. A `.boundsIgnoreFraming` capture is the window's frame, top
    /// down; view coordinates are window coordinates, bottom up.
    private func pixelRect(of view: NSView, in window: NSWindow) -> CGRect {
        let inWindow = view.convert(view.bounds, to: nil).insetBy(dx: 10, dy: 10)
        let scale = window.backingScaleFactor
        return CGRect(
            x: inWindow.minX * scale,
            y: (window.frame.height - inWindow.maxY) * scale,
            width: inWindow.width * scale,
            height: inWindow.height * scale
        ).integral
    }

    /// Capture the window every `burstIntervalMs` for `durationMs`, hashing
    /// the crop each time, and count the consecutive pairs that differ. Off
    /// the main thread: the point is to observe, not to load the thread the
    /// display link ticks on.
    private static func captureBurst(windowNumber: CGWindowID, crop: CGRect, durationMs: Int) -> (pairs: Int, differing: Int) {
        let end = CACurrentMediaTime() + Double(durationMs) / 1000
        var previous: Insecure.MD5Digest?
        var pairs = 0
        var differing = 0
        while CACurrentMediaTime() < end {
            let t0 = CACurrentMediaTime()
            if let image = captureOwnWindowImage(windowNumber),
               let digest = digest(of: image, crop: crop) {
                if let previous {
                    pairs += 1
                    if previous != digest { differing += 1 }
                }
                previous = digest
            }
            let remaining = Double(burstIntervalMs) / 1000 - (CACurrentMediaTime() - t0)
            if remaining > 0 { usleep(UInt32(remaining * 1_000_000)) }
        }
        return (pairs, differing)
    }

    private static func digest(of image: CGImage, crop: CGRect) -> Insecure.MD5Digest? {
        guard let cropped = image.cropping(to: crop) else { return nil }
        let width = cropped.width
        let height = cropped.height
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let bytes = context.data else { return nil }
        return Insecure.MD5.hash(data: UnsafeRawBufferPointer(start: bytes, count: width * height * 4))
    }

    // MARK: destroy

    func destroy() {
        createDeadline?.cancel()
        createDeadline = nil
        if let pending = pendingCreate {
            pendingCreate = nil
            pending(.failure(SpikeError(name: "SpikeError", message: "destroyed before it painted")))
        }
        guard let webView else { return }
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "spikeReady")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pageFault")
        host?.removeFromSuperview()
        host = nil
        container = nil
        self.webView = nil
    }
}

/// Top-left origin, so the child's frame reads like the page's rects. It
/// covers the window over the deck, so a point outside the child is no hit
/// of its own and reaches the deck beneath.
private final class SpikeHostView: NSView {
    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }
}

/// The child takes the first mouse: in harness pid mode the app is never
/// activated, so every click arrives as one.
private final class SpikeWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
#endif
