import Cocoa
import WebKit

/// Tug-private NSPasteboard type carrying the atom sidecar JSON for
/// Tug-to-Tug prompt copy/paste. A reverse-DNS UTI we own; other apps
/// ignore it (Tug→other-app copy still rides on `.string`), and unlike a
/// JS-set custom MIME it is not swallowed by WebKit's
/// `com.apple.WebKit.custom-pasteboard-data` archive blob — the web layer
/// never touches the pasteboard for atom copies, the native bridge writes
/// and reads this type directly. See `tug-native-clipboard.ts` and
/// `clipboard-filters.ts`.
private let tugAtomsPasteboardType = NSPasteboard.PasteboardType("dev.tug.prompt-atoms")

/// The WebKit feature settings Tug ships with, applied at configuration
/// time via the `_setEnabled:forFeature:` SPI (keys from
/// `WKPreferences._features`). Cohort retention holds just-scrolled-past
/// tiles for a grace period; disabling it cuts the flick-scroll graphics
/// transient by ~67MB mean / ~92MB max with rest coverage unchanged
/// (measured, roadmap/scrolling-memory-diet.md#g4-ab).
private let defaultWebKitFeatureSpec = "TemporaryTileCohortRetentionEnabled=0"

/// Applies `defaultWebKitFeatureSpec`, or the `TUG_WK_FEATURES`
/// environment override ("Key=0,Key2=1") when present — the lab A/B hook;
/// the app-test harness forwards every `TUG*` variable. An env spec
/// replaces the default wholesale, so `TemporaryTileCohortRetentionEnabled=1`
/// restores stock WebKit behavior for a control arm.
private func applyWebKitFeatureOverrides(to preferences: WKPreferences) {
    let spec = ProcessInfo.processInfo.environment["TUG_WK_FEATURES"]
        ?? defaultWebKitFeatureSpec
    guard !spec.isEmpty else { return }
    let featuresSel = NSSelectorFromString("_features")
    let setSel = NSSelectorFromString("_setEnabled:forFeature:")
    guard WKPreferences.responds(to: featuresSel),
          preferences.responds(to: setSel),
          let features = WKPreferences.perform(featuresSel)?.takeUnretainedValue() as? [NSObject]
    else {
        NSLog("TUG_WK_FEATURES: WKPreferences feature SPI unavailable; overrides ignored")
        return
    }
    typealias SetEnabledForFeature = @convention(c) (NSObject, Selector, Bool, NSObject) -> Void
    let setImpl = unsafeBitCast(
        preferences.method(for: setSel), to: SetEnabledForFeature.self)
    for entry in spec.split(separator: ",") {
        let parts = entry.split(separator: "=", maxSplits: 1)
        guard parts.count == 2, let value = ["0": false, "1": true][String(parts[1])] else {
            NSLog("TUG_WK_FEATURES: malformed entry '%@'", String(entry))
            continue
        }
        let key = String(parts[0])
        guard let feature = features.first(where: { ($0.value(forKey: "key") as? String) == key }) else {
            NSLog("TUG_WK_FEATURES: unknown feature key '%@'", key)
            continue
        }
        setImpl(preferences, setSel, value, feature)
        NSLog("TUG_WK_FEATURES: %@ = %@", key, value ? "1" : "0")
    }
}

/// Protocol for bridge callbacks from WebKit to AppDelegate
protocol BridgeDelegate: AnyObject {
    func bridgeChooseSourceTree(completion: @escaping (String?) -> Void)
    func bridgeChoosePath(kind: String, initialPath: String?, suggestedName: String?, completion: @escaping (String?) -> Void)
    func bridgeSetMakerMode(enabled: Bool, completion: @escaping (Bool) -> Void)
    func bridgeGetSettings(completion: @escaping (Bool, String?) -> Void)
    func bridgeFrontendReady()
    func bridgeDevModeError(message: String)
    func bridgeSetTheme(color: String)
    func bridgeDevBadge(backend: Bool, app: Bool)
    func bridgeIsMakerMode() -> Bool
    func bridgePageDidLoad()
    func bridgeHmrUpdate()
}

/// Pass-through container so the dev-info overlay does not block clicks
/// to the WebView underneath.
private final class DevInfoOverlayView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// WaveProgressView — Swift port of tugdeck's TugProgressWave glyph (the
/// three-bar "wave" that TugProgressIndicator renders in its `wave` variant).
///
/// Three vertical bars pulse in a staggered cycle. The rest pose is
/// short-long-short (outer bars at 0.5, middle bar at 1.0); each bar scales
/// toward the inverse pose at its pulse peak, producing the wave silhouette.
/// Geometry and motion mirror
/// `tugdeck/src/components/tugways/internal/tug-progress-wave.{tsx,css}`
/// exactly, parameterized by `size` (bar height in pt) so the call site can
/// pick any scale.
///
/// The web glyph runs as a WAAPI animation whose effect easing (`ease-in-out`)
/// is applied to the cycle progress, then the per-bar keyframes are
/// interpolated linearly. That exact curve is baked here into a densely
/// sampled `CAKeyframeAnimation`, so Core Animation reproduces the same motion
/// (GPU-driven, no display-link bookkeeping).
private final class WaveProgressView: NSView {
    // Mirror of the TSX module constants.
    private static let barCount = 3
    private static let barWidthRatio: CGFloat = 0.15
    private static let gapToWidthRatio: CGFloat = 0.8
    private static let sideBarRatio = 0.5            // outer bars' rest scale
    private static let shrinkTo = 0.5                // middle bar's peak scale
    private static let cycleSeconds: CFTimeInterval = 0.96
    private static let pulseWindowRatio = 600.0 / 960.0
    private static let pulseStaggerRatio = 180.0 / 960.0
    private static let sampleCount = 120

    private let size: CGFloat
    private let barColor: NSColor
    private var barLayers: [CALayer] = []

    init(size: CGFloat, color: NSColor) {
        self.size = size
        self.barColor = color
        super.init(frame: NSRect(origin: .zero, size: WaveProgressView.intrinsicSize(for: size)))
        wantsLayer = true
        buildBars()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { WaveProgressView.intrinsicSize(for: size) }

    private static func intrinsicSize(for size: CGFloat) -> NSSize {
        let barWidth = size * barWidthRatio
        let gap = barWidth * gapToWidthRatio
        let totalWidth = CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * gap
        return NSSize(width: totalWidth, height: size)
    }

    // MARK: Geometry

    private func buildBars() {
        let barWidth = size * Self.barWidthRatio
        // CSS uses a fixed 1px radius at the canonical 16px size; scale it so
        // the corner softness reads the same at any size (capped at half-width).
        let radius = min(barWidth / 2, size / 16.0)
        let cg = barColor.cgColor
        for i in 0..<Self.barCount {
            let bar = CALayer()
            bar.backgroundColor = cg
            bar.cornerRadius = radius
            bar.bounds = CGRect(x: 0, y: 0, width: barWidth, height: size)
            bar.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            // Seed the rest pose so the silhouette is correct before the
            // animation's first frame and after it is removed.
            bar.setValue(Self.barScales(i).rest, forKeyPath: "transform.scale.y")
            layer?.addSublayer(bar)
            barLayers.append(bar)
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let barWidth = size * Self.barWidthRatio
        let gap = barWidth * Self.gapToWidthRatio
        let totalWidth = CGFloat(Self.barCount) * barWidth + CGFloat(Self.barCount - 1) * gap
        let startX = (bounds.width - totalWidth) / 2
        let centerY = bounds.height / 2
        for (i, bar) in barLayers.enumerated() {
            let centerX = startX + CGFloat(i) * (barWidth + gap) + barWidth / 2
            bar.position = CGPoint(x: centerX, y: centerY)
        }
    }

    // MARK: Motion

    func startAnimating() {
        let n = Self.sampleCount
        for (i, bar) in barLayers.enumerated() {
            var values: [CGFloat] = []
            var keyTimes: [NSNumber] = []
            values.reserveCapacity(n)
            keyTimes.reserveCapacity(n)
            for k in 0..<n {
                let p = Double(k) / Double(n - 1)
                // WAAPI applies the effect easing to cycle progress first, then
                // interpolates the keyframes linearly at that transformed time.
                values.append(CGFloat(Self.waveValue(i, Self.easeInOut(p))))
                keyTimes.append(NSNumber(value: p))
            }
            let anim = CAKeyframeAnimation(keyPath: "transform.scale.y")
            anim.values = values
            anim.keyTimes = keyTimes
            anim.calculationMode = .linear
            anim.duration = Self.cycleSeconds
            anim.repeatCount = .infinity
            anim.isRemovedOnCompletion = false
            bar.add(anim, forKey: "wave")
        }
    }

    func stopAnimating() {
        for bar in barLayers { bar.removeAnimation(forKey: "wave") }
    }

    // MARK: Wave math (faithful to tug-progress-wave.tsx)

    /// Per-bar (rest, peak) scaleY pair. The middle bar sits tall and dips at
    /// the peak; the outer bars sit short and grow — the inverse motion is the
    /// wave.
    private static func barScales(_ index: Int) -> (rest: Double, peak: Double) {
        if index == 1 { return (1.0, shrinkTo) }
        return (sideBarRatio, 1.0)
    }

    /// scaleY for bar `index` at transformed (eased) cycle progress `q`.
    private static func waveValue(_ index: Int, _ q: Double) -> Double {
        let offset = Double(index) * pulseStaggerRatio
        let start = clamp01(offset)
        let mid = clamp01(offset + pulseWindowRatio / 2)
        let end = clamp01(offset + pulseWindowRatio)
        let s = barScales(index)
        if q <= start { return s.rest }
        if q < mid { return lerp(s.rest, s.peak, (q - start) / (mid - start)) }
        if q < end { return lerp(s.peak, s.rest, (q - mid) / (end - mid)) }
        return s.rest
    }

    private static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    private static func clamp01(_ n: Double) -> Double { min(1, max(0, n)) }

    /// CSS `ease-in-out` == cubic-bezier(0.42, 0, 0.58, 1). Returns y for the
    /// given x via Newton-Raphson on the curve's x(t).
    private static func easeInOut(_ x: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        let x1 = 0.42, y1 = 0.0, x2 = 0.58, y2 = 1.0
        let cx = 3 * x1, bx = 3 * (x2 - x1) - 3 * x1, ax = 1 - 3 * x2 + 3 * x1
        let cy = 3 * y1, by = 3 * (y2 - y1) - 3 * y1, ay = 1 - 3 * y2 + 3 * y1
        func curveX(_ t: Double) -> Double { ((ax * t + bx) * t + cx) * t }
        func curveY(_ t: Double) -> Double { ((ay * t + by) * t + cy) * t }
        func dCurveX(_ t: Double) -> Double { (3 * ax * t + 2 * bx) * t + cx }
        var t = x
        for _ in 0..<8 {
            let err = curveX(t) - x
            if abs(err) < 1e-6 { break }
            let d = dCurveX(t)
            if abs(d) < 1e-6 { break }
            t -= err / d
        }
        return curveY(t)
    }
}

/// The deck's web view, with click-through on activation.
///
/// A click into a backgrounded app is the app's to interpret. AppKit's default
/// — a view that refuses first mouse — discards it above the window entirely
/// (it never reaches `NSWindow.sendEvent`), so the deck comes forward with
/// whatever card was active when the app was backgrounded, no matter which card
/// the user aimed at. Accepting first mouse is what makes the event reachable.
///
/// The click is then consumed here rather than handed to the page: `mouseDown`
/// reports the location and returns without calling super, and the rest of the
/// gesture is swallowed with it so the page never sees an unpaired release. The
/// deck realizes the activation half only — the click that raises the app makes
/// the card under it active, and does not press the button or place the caret
/// it happens to land on. Every later click is an ordinary one.
private final class ClickThroughWebView: WKWebView {
    /// Receives the activating click's location in window coordinates.
    var onActivationClick: ((NSPoint) -> Void)?

    /// The event AppKit asked about in `acceptsFirstMouse`, identified by event
    /// number. AppKit asks that question for exactly one event — the click that
    /// arrives while the app or the window is inactive — so matching the number
    /// in `mouseDown` names the activating click precisely. A clock-based guess
    /// cannot: the activation notification lands before the click, so any time
    /// window wide enough to cover the real event also swallows an ordinary
    /// click made moments after a ⌘-Tab.
    private var firstMouseEventNumber: Int?

    private var swallowingGesture = false

    /// Harness pid mode (`TUGAPP_NATIVE_EVENT_MODE=pid`) drives the app
    /// without ever activating it, so every click arrives as a first
    /// mouse. Swallowing them as activation clicks would eat the whole
    /// test run's mouse stream — in this mode the click is an ordinary
    /// one and passes through to the page.
    private let harnessPidMode =
        ProcessInfo.processInfo.environment["TUGAPP_NATIVE_EVENT_MODE"] == "pid"

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        if harnessPidMode { return true }
        firstMouseEventNumber = event?.eventNumber
        return true
    }

    override func mouseDown(with event: NSEvent) {
        if firstMouseEventNumber == event.eventNumber {
            firstMouseEventNumber = nil
            swallowingGesture = true
            onActivationClick?(event.locationInWindow)
            return
        }
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        if swallowingGesture { return }
        super.mouseDragged(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        if swallowingGesture {
            swallowingGesture = false
            return
        }
        super.mouseUp(with: event)
    }
}

/// Main window containing the WKWebView for tugdeck dashboard
class MainWindow: NSWindow, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private var containerView: NSView!
    private var spinnerView: NSView?
    private var contentController: WKUserContentController!
    private var devInfoOverlay: DevInfoOverlayView?
    private var devInfoLabel: NSTextField?
    weak var bridgeDelegate: BridgeDelegate?
    private var bridgeCleaned = false

    /// Last URL handed to `loadURL`, so a recovery reload has somewhere
    /// to go when the dead WebContent process left `webView.url` nil.
    private var lastLoadedURLString: String?

    /// When the WebContent process was last observed dying. Used to
    /// refuse a second reload on the heels of the first — a page that
    /// kills its content process on load would otherwise reload
    /// forever.
    private var lastWebContentTerminationAt: Date?

    /// Harness pid mode (`TUGAPP_NATIVE_EVENT_MODE=pid`) drives the app without
    /// ever activating it. See {@link order(_:relativeTo:)}.
    private let harnessPidMode =
        ProcessInfo.processInfo.environment["TUGAPP_NATIVE_EVENT_MODE"] == "pid"

    /// The window level a harness-driven window sits at: one step below the
    /// normal level, so it can never come out above the user's windows.
    ///
    /// Suppressing activation is not enough on its own. Delivering a click into
    /// the window makes AppKit raise it, and that raise does not go through
    /// `order(_:relativeTo:)`, `orderFrontRegardless()`, or `setIsVisible(_:)` —
    /// a probe on all three during a real run recorded exactly one call, the
    /// deliberate `orderBack` at launch, while the window observably rose above
    /// the user's a second later. So the raise cannot be intercepted at the
    /// ordering API, and overriding it is a game of whack-a-mole against AppKit
    /// internals besides.
    ///
    /// Sitting the window one level down makes the question moot: a raise still
    /// happens, it just happens *within* a level that is entirely beneath every
    /// ordinary window on screen. Nothing in pid mode needs the window on top —
    /// keys arrive by `postToPid` and mouse events are rebuilt as `NSEvent`s
    /// dispatched straight into the window, so neither consults WindowServer's
    /// z-order or hit-testing.
    ///
    /// This matters at run scale: one launch per test file meant a core tier put
    /// twenty windows through whatever the user was looking at, and a sweep
    /// hundreds.
    static let harnessBackgroundLevel = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)

    /// Keep the harness's window off the top of the user's screen.
    ///
    /// The level above is the load-bearing half; this catches the explicit
    /// `orderFront` / `makeKeyAndOrderFront` calls so the window does not even
    /// rise to the top of its own level. Only "front" is rewritten, and only to
    /// "back": `orderOut` and explicit relative ordering still mean what they say.
    override func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        if harnessPidMode, place == .above, otherWin == 0 {
            super.order(.below, relativeTo: 0)
            return
        }
        super.order(place, relativeTo: otherWin)
    }

    // MARK: - Page zoom (View > Actual Size / Zoom In / Zoom Out)
    //
    // The View menu's zoom commands drive `webView.pageZoom` directly —
    // the same machinery Safari's View > Zoom uses. Setting `pageZoom`
    // scales the entire page uniformly (layout, text, images, SVG) so
    // the web frontend doesn't need a parallel scaling system. The
    // user's chosen zoom persists to `UserDefaults` and is reapplied on
    // launch in `init`. Bounds and step match the menu's expectations:
    // 50%–200% in 10% increments.
    private static let pageZoomDefaultsKey = "WebViewPageZoom"
    static let minPageZoom: CGFloat = 0.5
    static let maxPageZoom: CGFloat = 2.0
    static let pageZoomStep: CGFloat = 0.1
    static let defaultPageZoom: CGFloat = 1.0

    /// Minimum content size the user can resize the window down to.
    /// The Session card + the canvas need this much room to lay out without
    /// clipping the prompt area or stat row.
    static let minWindowSize = NSSize(width: 1200, height: 1000)

    /// Fraction of the main screen's visible frame that the default
    /// (first-launch) window occupies, and the cap applied to a
    /// restored frame at every subsequent launch. Visible frame
    /// excludes the menu bar and dock so 80% remains breathable.
    static let defaultScreenFraction: CGFloat = 0.8

    /// Breathing room left between the window and the edges of the
    /// visible frame when the window has to be sized/positioned to fit
    /// the display. Avoids a window pinned flush against the screen
    /// edge, which reads as a layout glitch rather than a deliberate fit.
    static let screenEdgeMargin: CGFloat = 3

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)

        self.title = "Tug"
        self.minSize = MainWindow.minWindowSize

        // Restore the window frame saved by AppKit under
        // `NSWindow Frame MainWindow` in NSUserDefaults, then apply
        // a fit-to-screen pass.
        //
        // - First launch (no saved frame): size to 80% of the main
        //   screen's visible frame (floored at `minWindowSize`) and
        //   center.
        // - Subsequent launches: restore, then clamp to 80% of the
        //   current main screen — covers the "moved from 27\" monitor
        //   back to laptop" case where the saved frame exceeds the
        //   new display.
        //
        // setFrameAutosaveName then registers automatic save-on-
        // move/resize.
        let autosaveName: NSWindow.FrameAutosaveName = "MainWindow"
        let restored = self.setFrameUsingName(autosaveName)
        MainWindow.applyScreenFitConstraints(to: self, restored: restored)
        self.setFrameAutosaveName(autosaveName)

        // Configure WKUserContentController for script message handlers
        contentController = WKUserContentController()
        contentController.add(self, name: "sourceTree")
        contentController.add(self, name: "choosePath")
        contentController.add(self, name: "setMakerMode")
        contentController.add(self, name: "getSettings")
        contentController.add(self, name: "frontendReady")
        contentController.add(self, name: "setTheme")
        contentController.add(self, name: "devBadge")
        contentController.add(self, name: "clipboardRead")
        contentController.add(self, name: "clipboardWrite")
        contentController.add(self, name: "clipboardWriteImage")
        contentController.add(self, name: "menuState")
        contentController.add(self, name: "hmrUpdate")
        contentController.add(self, name: "openPath")
        contentController.add(self, name: "exportSession")
        contentController.add(self, name: "checkForUpdates")
        contentController.add(self, name: "localModel")

        // Configure WKWebView
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        applyWebKitFeatureOverrides(to: config.preferences)
        config.userContentController = contentController
        // A process pool owned by this window, not shared. WebKit hosts
        // web views from the same pool in the same WebContent process, so
        // a second deck window built through this initializer would share
        // one main thread with the first and each would stall the other.
        // Constructing the pool here makes the isolation structural, so it
        // cannot be lost later by an unrelated change; the app builds one
        // window today, so nothing observable changes yet.
        config.processPool = WKProcessPool()

        // Allow localhost access
        if #available(macOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        #if DEBUG
        // Test harness: when TUGAPP_TEST_SOCKET is set, inject
        // `window.__tugTestMode = true` at atDocumentStart so
        // tugdeck's main.tsx sees the flag before its first script
        // tag executes. See Spec [#s05-wkuserscript-injection].
        if TestHarnessBridge.envSocketPath() != nil {
            TestHarnessUserScript.install(into: config)
        }
        #endif

        let clickThroughWebView = ClickThroughWebView(frame: .zero, configuration: config)
        clickThroughWebView.onActivationClick = { [weak self] location in
            self?.forwardActivationClick(at: location)
        }
        webView = clickThroughWebView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        // Suppress WKWebView's default white background. The webView starts
        // hidden and is revealed by frontendReady after JS applies the theme.
        webView.setValue(false, forKey: "drawsBackground")
        webView.isHidden = true

        // Restore the user's last page-zoom selection from UserDefaults.
        // `object(forKey:)` returns nil for an unset key (first launch);
        // we leave `webView.pageZoom` at its default 1.0 in that case.
        // A persisted value outside the bounds (e.g. from a future range
        // change) is clamped, not discarded — the next zoom action
        // re-writes the clamped value back to defaults.
        //
        // The app-test harness pins 1.0 instead of restoring. Native
        // gestures are posted in CSS viewport coordinates and land through
        // `CoordMapping.viewportToScreen`; a non-unity zoom scales every
        // landing away from its target, and the error grows with distance
        // from the origin, so a stray ⌘+ in one app-test window silently
        // mis-aims every gesture in every later run. Test geometry is the
        // harness's to control, not a persisted user preference's.
        if ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] == "1" {
            webView.pageZoom = 1.0
        } else if let saved = UserDefaults.standard.object(forKey: MainWindow.pageZoomDefaultsKey) as? Double {
            let clamped = max(MainWindow.minPageZoom, min(MainWindow.maxPageZoom, CGFloat(saved)))
            webView.pageZoom = clamped
        }

        // Container view holds both the WebView and any snapshot overlays.
        // The snapshot overlay is a sibling of the WebView (not a child) so
        // it is unaffected by WKWebView's compositing during navigation.
        containerView = NSView(frame: contentRect)
        containerView.autoresizingMask = [.width, .height]
        containerView.addSubview(webView)
        webView.frame = containerView.bounds
        webView.autoresizingMask = [.width, .height]

        // Startup splash: app icon + indeterminate spinner, visible until
        // frontendReady fires. Sits behind the WebView in the container.
        // Uses Auto Layout so the stack stays centered regardless of the
        // window size restored from setFrameAutosaveName.
        let splashView = NSView(frame: containerView.bounds)
        splashView.autoresizingMask = [.width, .height]

        let iconSize: CGFloat = 128
        let iconView = NSImageView()
        iconView.translatesAutoresizingMaskIntoConstraints = false
        let icon = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
        icon.size = NSSize(width: iconSize, height: iconSize)
        iconView.image = icon
        iconView.imageScaling = .scaleNone

        // Determine light/dark appearance from the startup background color
        // so the wave renders with a fill that reads against the splash.
        let bgHex = MainWindow.resolveStartupBackgroundHex()
        let bgColor = NSColor(hexString: bgHex) ?? NSColor.black
        var brightness: CGFloat = 0
        bgColor.usingColorSpace(.sRGB)?.getHue(nil, saturation: nil, brightness: &brightness, alpha: nil)
        splashView.appearance = NSAppearance(named: brightness < 0.5 ? .darkAqua : .aqua)

        // Swift port of tugdeck's TugProgressWave (the in-app `wave` glyph),
        // scaled up for the launch interstitial in place of the stock spinner.
        let waveSize: CGFloat = 32
        let waveColor: NSColor = brightness < 0.5
            ? NSColor.white.withAlphaComponent(0.85)
            : NSColor.black.withAlphaComponent(0.85)
        let wave = WaveProgressView(size: waveSize, color: waveColor)
        wave.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [iconView, wave])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        splashView.addSubview(stack)

        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: iconSize),
            iconView.heightAnchor.constraint(equalToConstant: iconSize),
            wave.widthAnchor.constraint(equalToConstant: wave.intrinsicContentSize.width),
            wave.heightAnchor.constraint(equalToConstant: waveSize),
            stack.centerXAnchor.constraint(equalTo: splashView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: splashView.centerYAnchor),
        ])

        wave.startAnimating()
        containerView.addSubview(splashView, positioned: .below, relativeTo: webView)
        self.spinnerView = splashView

        self.contentView = containerView
        // Background color is set by AppDelegate after init, not here.
    }

    // MARK: - Click-through activation

    /// Convert a window-local AppKit point into viewport (CSS) coordinates and
    /// hand it to the deck. `WKWebView` is a flipped view, so `convert` returns
    /// the Y-down, top-left-origin point the DOM uses; a CSS px is `pageZoom`
    /// view points, so the result is scaled back out of the zoom (the inverse
    /// of `CoordMapping.viewportToScreen`). Points outside the web view — the
    /// title bar, the resize margins — activate nothing.
    private func forwardActivationClick(at locationInWindow: NSPoint) {
        let viewLocal = webView.convert(locationInWindow, from: nil)
        guard webView.bounds.contains(viewLocal) else { return }
        let zoom = webView.pageZoom > 0 ? webView.pageZoom : 1.0
        let x = viewLocal.x / zoom
        let y = viewLocal.y / zoom
        webView.evaluateJavaScript(
            "window.__tugBridge?.onActivationClick?.(\(x), \(y))",
        ) { _, error in
            if let error = error {
                NSLog(
                    "MainWindow: evaluateJavaScript failed for onActivationClick: %@",
                    error.localizedDescription,
                )
            }
        }
    }

    /// Load URL in webview
    func loadURL(_ urlString: String) {
        NSLog("MainWindow: loadURL called with %@", urlString)
        guard let url = URL(string: urlString) else { return }
        lastLoadedURLString = urlString
        let request = URLRequest(url: url)
        webView.load(request)
    }

    /// Evaluate JavaScript in the current page context.
    func evaluateJavaScript(_ script: String, completionHandler: ((Any?, Error?) -> Void)? = nil) {
        webView.evaluateJavaScript(script, completionHandler: completionHandler)
    }

    /// Run `body` as an async JavaScript function and call back with the
    /// value its promise resolves to.
    ///
    /// Unlike `evaluateJavaScript`, WebKit awaits the returned promise
    /// natively, so the deck can do genuinely asynchronous work — awaited
    /// `fetch` with a status check, a bounded wait on a session — and the
    /// host still learns the outcome. The quit path is the reason this
    /// exists: it needs the deck's verdict, not just "the call returned".
    func callAsyncJavaScript(
        _ body: String,
        completionHandler: @escaping @MainActor @Sendable (Result<Any, Error>) -> Void
    ) {
        webView.callAsyncJavaScript(
            body,
            arguments: [:],
            in: nil,
            in: .page,
            completionHandler: completionHandler
        )
    }

    /// Make the WKWebView the window's first responder so keyboard focus lands
    /// inside the web content. A menu key equivalent (⌘L) fires even when the
    /// native title bar — not the web view — holds focus; a DOM focus change
    /// dispatched into tugdeck is invisible while the OS keyboard focus sits on
    /// the title bar, so the caller pairs this with the control dispatch.
    func focusWebView() {
        makeFirstResponder(webView)
    }

    // MARK: - Page zoom API

    /// Current zoom factor (1.0 == actual size).
    var currentPageZoom: CGFloat {
        return webView.pageZoom
    }

    /// Set page zoom to an exact value, clamped to [minPageZoom, maxPageZoom],
    /// and persist to UserDefaults so the choice survives across launches.
    func setPageZoom(_ zoom: CGFloat) {
        let clamped = max(MainWindow.minPageZoom, min(MainWindow.maxPageZoom, zoom))
        webView.pageZoom = clamped
        UserDefaults.standard.set(Double(clamped), forKey: MainWindow.pageZoomDefaultsKey)
    }

    /// Reset to 100%.
    func actualSize() {
        setPageZoom(MainWindow.defaultPageZoom)
    }

    /// Step up by one increment, capped at `maxPageZoom`.
    func zoomIn() {
        setPageZoom(currentPageZoom + MainWindow.pageZoomStep)
    }

    /// Step down by one increment, floored at `minPageZoom`.
    func zoomOut() {
        setPageZoom(currentPageZoom - MainWindow.pageZoomStep)
    }


    #if DEBUG
    /// Test-harness accessor: hand the live WKWebView to
    /// `TestHarnessBridge` so it can forward `evalJS` /
    /// `waitForCondition` RPCs. DEBUG-only.
    func testHarnessWebView() -> WKWebView {
        return webView
    }
    #endif

    /// The web view's editing NSUndoManager — the platform stack WebKit
    /// feeds when the user edits a browser-native text control. The
    /// app delegate validates Edit ▸ Undo/Redo from it (and clears it on
    /// native-control blur) while `MenuState.edit.nativeUndoToken` is
    /// non-zero. See AppDelegate's Edit-menu construction for the
    /// card-specific undo design.
    func editingUndoManager() -> UndoManager? {
        return webView.undoManager
    }

    /// Open web inspector
    func openWebInspector() {
        guard let inspector = webView.value(forKey: "_inspector") as? NSObject else { return }
        inspector.perform(NSSelectorFromString("show"))
    }

    /// Brio canvas color — final fallback when no other source is available.
    /// Must match --tugx-host-canvas-color in tugdeck/styles/themes/brio.css.
    static let defaultBackgroundHex = "#16181d"

    /// Resolve the startup background color from the active theme's CSS file.
    /// Reads the theme name and source tree path from tugbank, then parses
    /// --tugx-host-canvas-color directly from the theme's CSS on disk.
    /// Falls back to the tugbank-cached value, then to brio's hardcoded color.
    ///
    /// `theme` is the single source of truth for which theme is active;
    /// `window-background` is only a derived color cache for the native splash
    /// in builds where the theme CSS isn't on disk (shipped production, no
    /// source tree). To keep the two keys from ever disagreeing, whenever we
    /// can read the authoritative color from the theme's CSS we write it back
    /// to the cache — so a stale cache (e.g. from an external `tugbank write`
    /// of `theme` while the app was closed) self-corrects at every startup.
    static func resolveStartupBackgroundHex() -> String {
        // 1. Try to derive from the theme's CSS file on disk
        if let theme = ProcessManager.readTugbank(domain: TugConfig.domain, key: "theme"),
           let sourceTree = ProcessManager.readTugbank(domain: TugConfig.domain, key: TugConfig.keySourceTreePath) {
            let cssPath = (sourceTree as NSString)
                .appendingPathComponent("tugdeck/styles/themes/\(theme).css")
            if let css = try? String(contentsOfFile: cssPath, encoding: .utf8),
               let color = parseHostCanvasColor(css) {
                // Refresh the derived cache so it always tracks `theme`.
                ProcessManager.writeTugbank(
                    domain: TugConfig.domain, key: TugConfig.keyWindowBackground, value: color)
                return color
            }
        }
        // 2. Fall back to cached value from last bridge call
        if let cached = ProcessManager.readTugbank(domain: TugConfig.domain, key: TugConfig.keyWindowBackground) {
            return cached
        }
        // 3. Final fallback
        return defaultBackgroundHex
    }

    /// Parse --tugx-host-canvas-color from a CSS string. Returns the #rrggbb value or nil.
    /// Same logic as parseHostCanvasColor in tugdeck/vite.config.ts.
    private static func parseHostCanvasColor(_ css: String) -> String? {
        // Strip block comments
        let withoutComments = css.replacingOccurrences(
            of: "/\\*[\\s\\S]*?\\*/",
            with: " ",
            options: .regularExpression
        )
        // Match --tugx-host-canvas-color: #rrggbb;
        let pattern = "--tugx-host-canvas-color\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: withoutComments, range: NSRange(withoutComments.startIndex..., in: withoutComments)),
              let colorRange = Range(match.range(at: 1), in: withoutComments) else {
            return nil
        }
        return String(withoutComments[colorRange]).lowercased()
    }

    /// Update the window background color from a CSS hex string (e.g. "#1c1e22").
    func updateBackgroundColor(_ hex: String) {
        self.backgroundColor = NSColor(hexString: hex) ?? NSColor(hexString: MainWindow.defaultBackgroundHex)!
    }

    /// Show or hide a small dev-info overlay in the bottom-left corner of
    /// the canvas. Pass an empty string to hide. Lazily constructs the
    /// overlay on first use.
    func setDevInfo(text: String) {
        if text.isEmpty {
            devInfoOverlay?.isHidden = true
            return
        }
        if devInfoOverlay == nil {
            let overlay = DevInfoOverlayView()
            overlay.translatesAutoresizingMaskIntoConstraints = false
            overlay.wantsLayer = true
            overlay.layer?.backgroundColor = NSColor(white: 0, alpha: 0.55).cgColor
            overlay.layer?.cornerRadius = 3

            let label = NSTextField(labelWithString: "")
            label.translatesAutoresizingMaskIntoConstraints = false
            label.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
            label.textColor = NSColor.white
            label.isBordered = false
            label.drawsBackground = false
            label.isEditable = false
            label.isSelectable = false
            overlay.addSubview(label)

            containerView.addSubview(overlay)
            NSLayoutConstraint.activate([
                label.topAnchor.constraint(equalTo: overlay.topAnchor, constant: 3),
                label.bottomAnchor.constraint(equalTo: overlay.bottomAnchor, constant: -3),
                label.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 6),
                label.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -6),
                overlay.leadingAnchor.constraint(equalTo: webView.leadingAnchor, constant: 8),
                overlay.bottomAnchor.constraint(equalTo: webView.bottomAnchor, constant: -8),
            ])
            devInfoOverlay = overlay
            devInfoLabel = label
        }
        devInfoLabel?.stringValue = text
        devInfoOverlay?.isHidden = false
    }

    /// Capture the current WebView content as a static snapshot and overlay it,
    /// so the user sees a frozen frame during shutdown instead of disconnect
    /// banners, theme flashes, or blank screens. The WebView stays alive
    /// underneath for `window.tugdeck.saveState()` to execute.
    func freezeForShutdown(completion: @escaping () -> Void) {
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            guard let self = self else {
                completion()
                return
            }
            if let image = image {
                let overlay = NSImageView(frame: self.webView.bounds)
                overlay.image = image
                overlay.imageScaling = .scaleNone
                overlay.autoresizingMask = [.width, .height]
                self.webView.addSubview(overlay)
            } else {
                // Snapshot failed — fall back to hiding the WebView.
                self.webView.isHidden = true
            }
            completion()
        }
    }

    /// Tag used to identify the reload snapshot overlay.
    private static let reloadSnapshotTag = 9999

    /// Capture the current WebView content as a snapshot overlay so the user
    /// sees a frozen frame while the page reloads. The overlay is added to
    /// the container view (sibling of the WebView, not a child) so WKWebView's
    /// compositing during navigation cannot cause it to flicker. Removed by
    /// thawAfterReload() when frontendReady fires.
    func freezeForReload(completion: @escaping () -> Void) {
        // Snapshot the entire window contents so the capture includes
        // everything visible — web content, native scrollbars, all of it.
        guard let contentView = self.contentView,
              let bitmapRep = contentView.bitmapImageRepForCachingDisplay(in: contentView.bounds) else {
            completion()
            return
        }
        contentView.cacheDisplay(in: contentView.bounds, to: bitmapRep)
        let image = NSImage(size: contentView.bounds.size)
        image.addRepresentation(bitmapRep)

        let overlay = NSImageView(frame: containerView.bounds)
        overlay.image = image
        overlay.imageScaling = .scaleNone
        overlay.autoresizingMask = [.width, .height]
        overlay.tag = MainWindow.reloadSnapshotTag
        containerView.addSubview(overlay)
        completion()
    }

    /// Remove the reload snapshot overlay with a brief crossfade so the
    /// freshly-loaded content appears smoothly.
    func thawAfterReload() {
        guard let overlay = containerView.viewWithTag(MainWindow.reloadSnapshotTag) else { return }
        overlay.wantsLayer = true
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1
        anim.toValue = 0
        anim.duration = 0.15
        anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
        anim.isRemovedOnCompletion = false
        anim.fillMode = .forwards
        overlay.layer?.add(anim, forKey: "thawFade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            overlay.removeFromSuperview()
        }
    }

    /// Clean up WKScriptMessageHandler registrations to break retain cycle
    func cleanupBridge() {
        guard !bridgeCleaned else { return }
        contentController.removeScriptMessageHandler(forName: "sourceTree")
        contentController.removeScriptMessageHandler(forName: "choosePath")
        contentController.removeScriptMessageHandler(forName: "setMakerMode")
        contentController.removeScriptMessageHandler(forName: "getSettings")
        contentController.removeScriptMessageHandler(forName: "frontendReady")
        contentController.removeScriptMessageHandler(forName: "setTheme")
        contentController.removeScriptMessageHandler(forName: "devBadge")
        contentController.removeScriptMessageHandler(forName: "clipboardRead")
        contentController.removeScriptMessageHandler(forName: "clipboardWrite")
        contentController.removeScriptMessageHandler(forName: "clipboardWriteImage")
        contentController.removeScriptMessageHandler(forName: "menuState")
        contentController.removeScriptMessageHandler(forName: "hmrUpdate")
        contentController.removeScriptMessageHandler(forName: "openPath")
        contentController.removeScriptMessageHandler(forName: "exportSession")
        contentController.removeScriptMessageHandler(forName: "checkForUpdates")
        contentController.removeScriptMessageHandler(forName: "localModel")
        bridgeCleaned = true
    }

    deinit {
        cleanupBridge()
    }

    /// Escape a string for safe embedding in JavaScript
    /// Hand a local-model answer back to the web layer.
    ///
    /// Model output is arbitrary text, so the payload goes through JSON twice
    /// — once for the object, once to make it a valid JS string literal — the
    /// same shape the clipboard bridge uses for the same reason.
    private func replyLocalModel(requestId: String, reply: LocalModelReply) {
        var payload: [String: Any] = [
            "requestId": requestId,
            "ok": reply.ok,
            "done": true,
        ]
        if let verdict = reply.verdict { payload["verdict"] = verdict }
        if let text = reply.text { payload["text"] = text }
        if let error = reply.error { payload["error"] = error }
        if let availability = reply.availability {
            var value: [String: Any] = ["ready": availability.ready]
            if let backend = availability.backend { value["backend"] = backend }
            if let reason = availability.reason { value["reason"] = reason }
            payload["availability"] = value
        }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8),
              let quotedData = try? JSONSerialization.data(
                withJSONObject: jsonString, options: [.fragmentsAllowed]),
              let quoted = String(data: quotedData, encoding: .utf8) else {
            NSLog("MainWindow: JSON serialization failed for localModel")
            return
        }
        webView.evaluateJavaScript(
            "window.__tugBridge?.onLocalModelResult?.(JSON.parse(\(quoted)))"
        ) { _, error in
            if let error = error {
                NSLog(
                    "MainWindow: evaluateJavaScript failed for localModel: %@",
                    error.localizedDescription
                )
            }
        }
    }

    private func escapeForJS(_ str: String) -> String {
        str.replacingOccurrences(of: "\\", with: "\\\\")
           .replacingOccurrences(of: "'", with: "\\'")
           .replacingOccurrences(of: "\n", with: "\\n")
    }

    /// Tell the deck that a scheduled Sparkle check found a new version, so
    /// it can announce it as a bulletin instead of Sparkle's alert window.
    /// The bulletin's action posts back to the `checkForUpdates` handler.
    func bridgeUpdateAvailable(version: String, build: String) {
        let versionArg = escapeForJS(version)
        let buildArg = escapeForJS(build)
        webView.evaluateJavaScript(
            "window.__tugBridge?.onUpdateAvailable?.({version: '\(versionArg)', build: '\(buildArg)'})"
        ) { _, error in
            if let error = error {
                NSLog(
                    "MainWindow: evaluateJavaScript failed for onUpdateAvailable: %@",
                    error.localizedDescription
                )
            }
        }
    }

    /// Present the `/export` save panel ([#step-13c]) as a sheet on this
    /// window. The accessory File Format popup selects which content
    /// (markdown / JSON Lines) is written; the popup index — not the typed
    /// extension — is authoritative at write time. Calls back
    /// `onExportDone(id, "saved" | "canceled")`.
    private func presentExportPanel(requestId: String, baseName: String,
                                    markdown: String, jsonl: String) {
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.title = "Export Session"
        panel.nameFieldLabel = "Export As:"
        panel.nameFieldStringValue = "\(baseName).md"

        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 200, height: 25))
        popup.addItems(withTitles: ["Markdown", "JSON Lines"])
        popup.target = self
        popup.action = #selector(exportFormatChanged(_:))

        let label = NSTextField(labelWithString: "Format:")
        let stack = NSStackView(views: [label, popup])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        panel.accessoryView = stack

        panel.beginSheetModal(for: self) { [weak self] response in
            guard let self = self else { return }
            var result = "canceled"
            if response == .OK, let url = panel.url {
                let content = popup.indexOfSelectedItem == 0 ? markdown : jsonl
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    result = "saved"
                } catch {
                    NSLog("MainWindow: export write failed: %@", error.localizedDescription)
                }
            }
            let idArg = self.escapeForJS(requestId)
            self.webView.evaluateJavaScript(
                "window.__tugBridge?.onExportDone?.('\(idArg)', '\(result)')"
            ) { _, error in
                if let error = error {
                    NSLog("MainWindow: evaluateJavaScript failed for exportSession: %@", error.localizedDescription)
                }
            }
        }
    }

    /// File Format popup changed — swap the save panel's filename extension to
    /// match (cosmetic; the popup index drives the written content at OK time).
    @objc private func exportFormatChanged(_ sender: NSPopUpButton) {
        guard let panel = sender.window as? NSSavePanel else { return }
        let ext = sender.indexOfSelectedItem == 0 ? "md" : "jsonl"
        let base = (panel.nameFieldStringValue as NSString).deletingPathExtension
        panel.nameFieldStringValue = "\(base).\(ext)"
    }

    /// Send dev mode error to frontend
    func bridgeDevModeError(message: String) {
        let escaped = escapeForJS(message)
        webView.evaluateJavaScript("window.__tugBridge?.onDevModeError?.('\(escaped)')") { _, error in
            if let error = error {
                NSLog("MainWindow: evaluateJavaScript failed for bridgeDevModeError: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("MainWindow: didFinish navigation at %@", Date() as CVarArg)
        // WebView is NOT revealed here — we wait for frontendReady so the theme
        // and all visual state is applied before the user sees anything.
        bridgeDelegate?.bridgePageDidLoad()
    }

    /// Reveal the WebView. Called from frontendReady bridge message, which fires
    /// after JS has applied the theme, sent the canvas color, and constructed the
    /// DeckManager. This eliminates the flash of unstyled/default-themed content
    /// that would occur if we revealed on didFinishNavigation.
    func revealWebView() {
        NSLog("MainWindow: revealWebView called (isHidden=%d)", webView.isHidden ? 1 : 0)

        // If a reload snapshot overlay is present, hold it for 0.5s so the
        // WebView content is fully composited before the crossfade begins.
        if containerView.viewWithTag(MainWindow.reloadSnapshotTag) != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                self.thawAfterReload()
            }
            return
        }

        guard webView.isHidden else { return }
        webView.wantsLayer = true
        webView.layer?.opacity = 0
        webView.isHidden = false

        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 0
        anim.toValue = 1
        anim.duration = 0.2
        anim.timingFunction = CAMediaTimingFunction(name: .easeIn)
        anim.isRemovedOnCompletion = false
        anim.fillMode = .forwards
        webView.layer?.add(anim, forKey: "revealFade")
        webView.layer?.opacity = 1

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.makeFirstResponder(self.webView)
            // Remove the startup spinner after the WebView is fully revealed.
            self.spinnerView?.removeFromSuperview()
            self.spinnerView = nil
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("Navigation failed: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("Navigation failed (provisional): %@", error.localizedDescription)
    }

    /// The WebContent process died — jetsam under memory pressure, or a
    /// crash. Reload the page.
    ///
    /// Without this the window simply goes blank and stays blank: there
    /// is no recovery of any kind, and the symptom is indistinguishable
    /// from a transport close even though nothing about the wire is
    /// wrong. Logging it distinctly is half the value — this event was
    /// previously invisible.
    ///
    /// The reload is a genuine full recovery: the deck re-resumes every
    /// card from JSONL on load. Whatever was typed but unsent is gone,
    /// but it was gone the moment the process died — the reload only
    /// restores a usable window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        let previous = lastWebContentTerminationAt
        lastWebContentTerminationAt = now

        // A page that kills its content process while loading would
        // otherwise reload in a tight loop. One recovery attempt per
        // quiet period; past that, leave the window blank and say so.
        if let previous, now.timeIntervalSince(previous) < 10.0 {
            NSLog(
                "MainWindow: WebContent process terminated again after %.1fs — not reloading",
                now.timeIntervalSince(previous),
            )
            return
        }

        NSLog("MainWindow: WebContent process terminated — reloading")
        if webView.url != nil {
            webView.reload()
        } else if let urlString = lastLoadedURLString {
            // A terminated process can leave `url` nil, and `reload()`
            // on a webview with no URL does nothing at all.
            loadURL(urlString)
        } else {
            NSLog("MainWindow: no URL to reload after WebContent termination")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Intercept reload navigation: freeze the display as a snapshot overlay,
        // save state via JS bridge BEFORE the page tears down, then reload.
        // The snapshot keeps cards visible during teardown/rebuild. It is removed
        // by revealWebView() when frontendReady fires after the reload completes.
        if navigationAction.navigationType == .reload {
            decisionHandler(.cancel)
            freezeForReload { [weak self] in
                self?.webView.evaluateJavaScript("window.tugdeck?.saveState?.()") { [weak self] _, _ in
                    if let url = self?.webView.url {
                        self?.webView.load(URLRequest(url: url))
                    }
                }
            }
            return
        }

        // A clicked link to anything other than the app's own origin opens
        // in the system browser, never inside our webview — a transcript URL
        // (markdown link or a bare URL the transcript annotator linkified) must
        // not navigate the app away from the Session card. Same-origin http(s)
        // navigation (e.g. an in-page `#fragment`) is left to load normally.
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased() {
            let sameOriginHttp =
                (scheme == "http" || scheme == "https") && url.host == webView.url?.host
            if !sameOriginHttp {
                decisionHandler(.cancel)
                if MainWindow.externalLinkSchemes.contains(scheme) {
                    NSWorkspace.shared.open(url)
                }
                return
            }
        }
        decisionHandler(.allow)
    }

    /// Schemes a transcript link is allowed to hand to the system handler.
    /// DOMPurify already strips dangerous URI schemes (`javascript:`,
    /// `data:`) from rendered markdown, and the transcript annotator only emits
    /// http(s); this allowlist is the host-side backstop so a clicked link
    /// can only reach the browser, mail, or phone handler — never an
    /// arbitrary registered URL scheme.
    private static let externalLinkSchemes: Set<String> = ["http", "https", "mailto", "tel"]

    // MARK: - WKUIDelegate

    /// Safety net for links that would open a new window (`target="_blank"`
    /// or `window.open`): WKWebView has no place to put a second window, so
    /// without this it silently drops them. We instead route an allowed
    /// scheme to the system browser and create no webview. Ordinary
    /// transcript links carry no `target` and go through `decidePolicyFor`;
    /// this only catches the new-window path.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           MainWindow.externalLinkSchemes.contains(scheme) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// Handle <input type="file"> — without this, file inputs are silently ignored in WKWebView.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// Handle blob URL downloads (e.g. Export JSON) — without this, <a download> navigates instead of downloading.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           let contentDisposition = response.value(forHTTPHeaderField: "Content-Disposition"),
           contentDisposition.contains("attachment") {
            decisionHandler(.download)
            return
        }
        // For blob: URLs triggered by <a download>, WKWebView reports them as non-main-frame
        // navigations with a blob scheme. Convert these to downloads.
        if navigationResponse.response.url?.scheme == "blob" {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - Screen-fit sizing

    /// Apply the dev/prod canvas sizing policy: first launch sizes
    /// to 80% of the main screen's visible frame and centers; every
    /// subsequent launch caps the restored frame to that same target
    /// so a "saved on big monitor, opened on laptop" frame is brought
    /// back on-screen.
    ///
    /// The target is floored at `minWindowSize` but then capped to the
    /// visible frame, so a display smaller than `minWindowSize` still
    /// yields a window that fits entirely on-screen rather than one
    /// forced larger than the display. The window's resize minimum
    /// (`minSize`) is lowered to match for the same reason. Finally the
    /// origin is clamped into the visible frame so no edge — top, bottom,
    /// or side — overhangs the display.
    static func applyScreenFitConstraints(to window: NSWindow, restored: Bool) {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else {
            if !restored {
                window.center()
            }
            return
        }
        let visible = screen.visibleFrame
        // The region the window is allowed to occupy: the visible frame
        // inset by `screenEdgeMargin` on every side, so a fitted window
        // keeps a small gap from the screen edges instead of sitting flush.
        let fit = visible.insetBy(dx: screenEdgeMargin, dy: screenEdgeMargin)

        // The resize minimum must never exceed the fit region, or the window
        // could not be made to fit a laptop smaller than `minWindowSize`.
        let minW = min(minWindowSize.width, fit.width)
        let minH = min(minWindowSize.height, fit.height)
        window.minSize = NSSize(width: minW, height: minH)

        // 80% of the visible frame, floored at the (already display-capped)
        // minimum and capped at the inset fit region.
        let targetW = min(fit.width, max(visible.width * defaultScreenFraction, minW))
        let targetH = min(fit.height, max(visible.height * defaultScreenFraction, minH))

        var frame = window.frame
        if restored {
            frame.size.width = min(frame.size.width, targetW)
            frame.size.height = min(frame.size.height, targetH)
            frame.origin = clampOrigin(frame: frame, into: fit)
            window.setFrame(frame, display: false)
        } else {
            frame.size = NSSize(width: targetW, height: targetH)
            window.setFrame(frame, display: false)
            window.center()
        }
    }

    /// Shift `frame`'s origin so the whole rect lies within `region`.
    /// `frame` is assumed no larger than `region` in either dimension
    /// (the caller caps the size first), so the clamp can always satisfy
    /// both edges.
    private static func clampOrigin(frame: NSRect, into region: NSRect) -> NSPoint {
        var x = frame.origin.x
        var y = frame.origin.y
        x = min(x, region.maxX - frame.width)
        x = max(x, region.minX)
        y = min(y, region.maxY - frame.height)
        y = max(y, region.minY)
        return NSPoint(x: x, y: y)
    }
}

// MARK: - WKScriptMessageHandler

extension MainWindow: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "sourceTree":
            bridgeDelegate?.bridgeChooseSourceTree { [weak self] path in
                guard let self = self else { return }
                if let path = path {
                    let escaped = self.escapeForJS(path)
                    self.webView.evaluateJavaScript("window.__tugBridge?.onSourceTreeSelected?.('\(escaped)')") { _, error in
                        if let error = error {
                            NSLog("MainWindow: evaluateJavaScript failed for sourceTree (selected): %@", error.localizedDescription)
                        }
                    }
                } else {
                    self.webView.evaluateJavaScript("window.__tugBridge?.onSourceTreeCancelled?.()") { _, error in
                        if let error = error {
                            NSLog("MainWindow: evaluateJavaScript failed for sourceTree (cancelled): %@", error.localizedDescription)
                        }
                    }
                }
            }
        case "choosePath":
            // TugFileChooser "Browse…" picker. The web layer sends a request
            // id, an optional starting path, and a `kind` ("directory"|"file");
            // we open an NSOpenPanel and call back
            // window.__tugBridge.onPathChosen(id, path|null). The id lets
            // concurrent pickers resolve independently.
            guard let body = message.body as? [String: Any],
                  let requestId = body["id"] as? String else { return }
            let initialPath = body["initialPath"] as? String
            let suggestedName = body["suggestedName"] as? String
            let kind = (body["kind"] as? String) ?? "directory"
            bridgeDelegate?.bridgeChoosePath(kind: kind, initialPath: initialPath, suggestedName: suggestedName) { [weak self] path in
                guard let self = self else { return }
                let idArg = self.escapeForJS(requestId)
                let pathArg: String
                if let path = path {
                    pathArg = "'\(self.escapeForJS(path))'"
                } else {
                    pathArg = "null"
                }
                self.webView.evaluateJavaScript("window.__tugBridge?.onPathChosen?.('\(idArg)', \(pathArg))") { _, error in
                    if let error = error {
                        NSLog("MainWindow: evaluateJavaScript failed for choosePath: %@", error.localizedDescription)
                    }
                }
            }
        case "setMakerMode":
            guard let body = message.body as? [String: Any],
                  let enabled = body["enabled"] as? Bool else { return }
            bridgeDelegate?.bridgeSetMakerMode(enabled: enabled) { [weak self] confirmed in
                guard let self = self else { return }
                self.webView.evaluateJavaScript("window.__tugBridge?.onMakerModeChanged?.(\(confirmed))") { _, error in
                    if let error = error {
                        NSLog("MainWindow: evaluateJavaScript failed for setMakerMode: %@", error.localizedDescription)
                    }
                }
            }
        case "getSettings":
            bridgeDelegate?.bridgeGetSettings { [weak self] makerMode, sourceTree in
                guard let self = self else { return }
                let stValue: String
                if let st = sourceTree {
                    stValue = "'\(self.escapeForJS(st))'"
                } else {
                    stValue = "null"
                }
                self.webView.evaluateJavaScript("window.__tugBridge?.onSettingsLoaded?.({makerMode: \(makerMode), sourceTree: \(stValue)})") { _, error in
                    if let error = error {
                        NSLog("MainWindow: evaluateJavaScript failed for getSettings: %@", error.localizedDescription)
                    }
                }
            }
        case "openPath":
            // `/memory` ([#step-12a]) — hand a memory path to the OS. The web
            // layer sends a `~`-relative or absolute path plus a `kind`; we
            // expand the tilde (the web layer has no home dir) and route via
            // NSWorkspace. `kind == "file"`: open in the default editor,
            // CREATING it (with parent dirs) if absent — matching Claude
            // Code's "open memory" behavior so a not-yet-written CLAUDE.md
            // still opens to edit. `kind == "folder"`: open in Finder if it
            // exists, else reveal its parent (never auto-create a folder — a
            // wrong path must not mint an empty directory). No content
            // write-back; editing happens in the OS app.
            guard let body = message.body as? [String: Any],
                  let rawPath = body["path"] as? String, !rawPath.isEmpty else { return }
            let kind = (body["kind"] as? String) ?? "file"
            let expanded = (rawPath as NSString).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded)
            let fm = FileManager.default
            if kind == "reveal" {
                // Open Finder with the file itself selected inside its
                // folder (not merely the folder open). Falls back to opening
                // the deepest existing ancestor if the exact path is gone.
                if fm.fileExists(atPath: expanded) {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } else {
                    var dir = url.deletingLastPathComponent()
                    while !fm.fileExists(atPath: dir.path) && dir.pathComponents.count > 1 {
                        dir = dir.deletingLastPathComponent()
                    }
                    NSWorkspace.shared.open(dir)
                }
            } else if kind == "folder" {
                // Open the folder in Finder. If the exact path doesn't exist
                // (e.g. the auto-memory folder before claude has reported its
                // resolved cwd, so the encoding is still best-effort), walk up
                // to the deepest existing ancestor and open that — a useful
                // landing spot rather than a dead click. Never auto-create.
                var dir = url
                while !fm.fileExists(atPath: dir.path) && dir.pathComponents.count > 1 {
                    dir = dir.deletingLastPathComponent()
                }
                NSWorkspace.shared.open(dir)
            } else {
                if !fm.fileExists(atPath: expanded) {
                    try? fm.createDirectory(at: url.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
                    fm.createFile(atPath: expanded, contents: nil)
                }
                NSWorkspace.shared.open(url)
            }
        case "checkForUpdates":
            // The update bulletin's action. Brings Sparkle's standard update
            // flow into focus; a no-op when the updater never started (debug
            // and branch identities, and the app-test harness).
            if let appDelegate = NSApp.delegate as? AppDelegate {
                appDelegate.checkForUpdates(nil)
            }

        case "exportSession":
            // `/export` ([#step-13c]) — save the session transcript to a
            // user-chosen file. The web layer builds BOTH renderings
            // (markdown + JSON Lines) and sends them with a default base
            // name; the host runs an NSSavePanel whose File Format popup
            // chooses which content is written. Sibling of `openPath` (the
            // host owns the panel + file write; the content is the web
            // layer's). Calls back `onExportDone(id, "saved" | "canceled")`.
            guard let body = message.body as? [String: Any],
                  let requestId = body["id"] as? String else { return }
            let baseName = (body["baseName"] as? String) ?? "tug-session"
            let markdown = (body["markdown"] as? String) ?? ""
            let jsonl = (body["jsonl"] as? String) ?? ""
            presentExportPanel(requestId: requestId, baseName: baseName,
                               markdown: markdown, jsonl: jsonl)
        case "frontendReady":
            revealWebView()
            bridgeDelegate?.bridgeFrontendReady()
        case "setTheme":
            guard let body = message.body as? [String: Any],
                  let color = body["color"] as? String else { return }
            bridgeDelegate?.bridgeSetTheme(color: color)
        case "devBadge":
            guard let body = message.body as? [String: Any] else { return }
            let backend = body["backend"] as? Bool ?? false
            let app = body["app"] as? Bool ?? false
            bridgeDelegate?.bridgeDevBadge(backend: backend, app: app)
        case "localModel":
            // On-device inference for the web layer. Every task is
            // request/reply keyed by `requestId`: the deck posts here and
            // resolves its promise when onLocalModelResult fires, so several
            // requests can be in flight without ordering constraints.
            //
            // A malformed payload still answers — a caller waiting on a
            // requestId must never be left hanging.
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String else {
                NSLog("MainWindow: localModel request missing requestId")
                return
            }
            let task = (body["task"] as? String) ?? ""
            let kind: LocalModelRequest.Kind?
            switch task {
            case "classify":
                let labels = (body["labels"] as? [String]) ?? ["shell", "prompt"]
                let grammar = body["grammar"] as? String
                kind = (body["text"] as? String).map {
                    .classify(text: $0, labels: labels, grammar: grammar)
                }
            case "summarize":
                kind = (body["prompt"] as? String).map { .summarize(prompt: $0) }
            case "generate":
                kind = (body["prompt"] as? String).map {
                    .generate(prompt: $0, maxTokens: body["maxTokens"] as? Int)
                }
            case "availability":
                kind = .availability
            case "prewarm":
                kind = .prewarm
            default:
                kind = nil
            }
            guard let kind = kind else {
                replyLocalModel(requestId: requestId, reply: .failure("malformed \(task) request"))
                return
            }
            Task { [weak self] in
                let reply = await LocalModelService.shared.handle(
                    LocalModelRequest(requestId: requestId, kind: kind, transport: .bridge))
                await MainActor.run {
                    self?.replyLocalModel(requestId: requestId, reply: reply)
                }
            }
        case "clipboardRead":
            // Native clipboard bridge. Read NSPasteboard directly and call
            // back to JavaScript with the contents. This exists because
            // Safari's JavaScript Clipboard API (navigator.clipboard.readText /
            // .read) triggers a floating "Paste" permission popup on every
            // invocation, and in Safari 16.4+ document.execCommand("paste")
            // on contentEditable triggers the same popup. Reading via
            // NSPasteboard on the native side is the only way to supply
            // clipboard data to JavaScript without the popup.
            //
            // JS-side contract: post {requestId} and wait for a callback
            // on window.__tugNativeClipboardCallback(data) where data is
            // {requestId, text, html, atoms}. See tug-native-clipboard.ts.
            //
            // `atoms` carries the Tug-private atom sidecar JSON when the
            // clipboard was last written by a Tug copy (via clipboardWrite),
            // empty otherwise. This is the robust Tug-to-Tug channel — it
            // bypasses WebKit's HTML sanitizer and custom-MIME repacking
            // entirely.
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String else { return }
            let pasteboard = NSPasteboard.general
            let text = pasteboard.string(forType: .string) ?? ""
            let html = pasteboard.string(forType: .html) ?? ""
            let atoms = pasteboard.string(forType: tugAtomsPasteboardType) ?? ""
            // Use JSON to pass arbitrary clipboard contents through the
            // evaluateJavaScript string safely — the text may contain
            // quotes, backslashes, control chars, and line separators
            // that would otherwise break a manually-escaped JS literal.
            let payload: [String: Any] = [
                "requestId": requestId,
                "text": text,
                "html": html,
                "atoms": atoms
            ]
            guard let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let jsonString = String(data: jsonData, encoding: .utf8) else {
                NSLog("MainWindow: JSON serialization failed for clipboardRead")
                return
            }
            // JSON-serialize the JSON once more to produce a valid JS
            // string literal (handles \u2028 / \u2029 which JSON allows
            // but JS does not in source text).
            guard let quotedJsonData = try? JSONSerialization.data(withJSONObject: jsonString, options: [.fragmentsAllowed]),
                  let quotedJsonString = String(data: quotedJsonData, encoding: .utf8) else {
                NSLog("MainWindow: JSON quoting failed for clipboardRead")
                return
            }
            let script = "window.__tugNativeClipboardCallback?.(JSON.parse(\(quotedJsonString)))"
            self.webView.evaluateJavaScript(script) { _, error in
                if let error = error {
                    NSLog("MainWindow: evaluateJavaScript failed for clipboardRead: %@", error.localizedDescription)
                }
            }
        case "clipboardWrite":
            // Native clipboard-write bridge for Tug prompt copy/cut. The
            // web layer never writes atom-bearing selections through the
            // DOM copy event (WebKit's pasteboard normalization swallows
            // custom MIME types and sanitizes HTML, dropping atom data).
            // Instead it hands us the plain-text fallback plus the atom
            // sidecar JSON, and we own the entire NSPasteboard write: the
            // readable text on `.string` for external apps, the sidecar on
            // our private `dev.tug.prompt-atoms` type for Tug-to-Tug paste.
            // Fire-and-forget; NSPasteboard writes synchronously.
            // JS-side contract: post {text, atoms}. `atoms` is "" when the
            // selection carried no atoms. See tug-native-clipboard.ts.
            guard let body = message.body as? [String: Any],
                  let text = body["text"] as? String else {
                NSLog("MainWindow: clipboardWrite invalid payload")
                return
            }
            let atoms = body["atoms"] as? String ?? ""
            let pasteboard = NSPasteboard.general
            var types: [NSPasteboard.PasteboardType] = [.string]
            if !atoms.isEmpty { types.append(tugAtomsPasteboardType) }
            // declareTypes clears the pasteboard and declares ownership of
            // the listed types in one step, so the subsequent setString
            // calls are guaranteed to take.
            pasteboard.declareTypes(types, owner: nil)
            pasteboard.setString(text, forType: .string)
            if !atoms.isEmpty {
                pasteboard.setString(atoms, forType: tugAtomsPasteboardType)
            }
        case "clipboardWriteImage":
            // Native image-clipboard bridge. The WKWebView's JS Clipboard
            // image write (navigator.clipboard.write + ClipboardItem) is
            // unreliable in this app — the same reason clipboardRead is
            // bridged. Writing image bytes to NSPasteboard natively is the
            // dependable path. Fire-and-forget: the web layer posts the
            // base64-encoded image bytes; the host decodes and writes an
            // NSImage to the general pasteboard so any app can paste it.
            // JS-side contract: post {base64}. See tug-native-clipboard.ts.
            guard let body = message.body as? [String: Any],
                  let base64 = body["base64"] as? String,
                  let data = Data(base64Encoded: base64),
                  let image = NSImage(data: data) else {
                NSLog("MainWindow: clipboardWriteImage invalid payload")
                return
            }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.writeObjects([image])
        case "menuState":
            // Menu-relevant state pushed from the frontend's host-menu-state
            // aggregator. Cache it on AppDelegate for menu validation and
            // the dynamic pane list.
            if let payload = message.body as? [String: Any],
               let appDelegate = NSApp.delegate as? AppDelegate {
                appDelegate.updateMenuState(payload)
            }
        case "hmrUpdate":
            bridgeDelegate?.bridgeHmrUpdate()
        default:
            NSLog("MainWindow: unknown script message: %@", message.name)
        }
    }
}

// MARK: - WKDownloadDelegate

extension MainWindow: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.begin { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }
}

// MARK: - NSColor hex parsing

private extension NSColor {
    /// Create an NSColor from a CSS hex string (e.g. "#1c1e22" or "1c1e22").
    convenience init?(hexString hex: String) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") {
            cleaned.removeFirst()
        }
        guard cleaned.count == 6 else { return nil }
        var rgb: UInt64 = 0
        guard Scanner(string: cleaned).scanHexInt64(&rgb) else { return nil }
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
            green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
            blue: CGFloat(rgb & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
}
