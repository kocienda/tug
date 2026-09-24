import Cocoa
import QuickLookThumbnailing
import WebKit

/// Tug-private NSPasteboard type carrying the atom sidecar JSON for
/// Tug-to-Tug prompt copy/paste. A reverse-DNS UTI we own; other apps
/// ignore it (Tug→other-app copy still rides on `.string`), and unlike a
/// JS-set custom MIME it is not swallowed by WebKit's
/// `com.apple.WebKit.custom-pasteboard-data` archive blob — the web layer
/// never touches the pasteboard for atom copies, the native bridge writes
/// and reads this type directly. See `tug-native-clipboard.ts` and
/// `clipboard-filters.ts`.
private let tugAtomsPasteboardType = NSPasteboard.PasteboardType("dev.tugapp.prompt-atoms")

/// The WebKit feature settings Tug ships with, applied at configuration
/// time via the `_setEnabled:forFeature:` SPI (keys from
/// `WKPreferences._features`). Cohort retention holds just-scrolled-past
/// tiles for a grace period; disabling it cuts the flick-scroll graphics
/// transient by ~67MB mean / ~92MB max with rest coverage unchanged
/// (measured, the scrolling memory-diet record, experiment G4-AB).
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
    func bridgeGetSettings(completion: @escaping (Bool, String?) -> Void)
    func bridgeFrontendReady()
    func bridgeDevModeError(message: String)
    func bridgeSetTheme(color: String)
    func bridgeDevBadge(backend: Bool, app: Bool)
    func bridgePageDidLoad()
    func bridgeHmrUpdate()
    /// The coarse stage the launch has reached, for the splash failure
    /// screen's one-line statement of what the app is waiting on.
    func bridgeLaunchStageName() -> String
    /// Re-run whatever the current launch stage was waiting on. The host
    /// owns the launch sequence; the window owns the screen that offers
    /// the retry.
    func bridgeRetryLaunchStage()
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
    /// The centered content of the splash — the icon-and-wave stack at
    /// launch, the failure screen after a deadline or a navigation error.
    /// Swapped by `setSplashContent`, which is the only writer.
    private var splashContent: NSView?
    /// The icon-and-wave stack, kept after a failure screen replaces it so
    /// Retry can put the spinner back rather than build a second one.
    private var splashSpinnerStack: NSView?
    private var splashWave: WaveProgressView?
    /// The armed splash deadline, or nil when nothing is waiting on the
    /// interface. Armed by the event that opens the wait (the splash
    /// mounting, a Retry) and cancelled by the one that closes it
    /// (`revealWebView`) — never by polling `webView.isHidden`.
    private var splashDeadline: DispatchWorkItem?
    /// True once the failure screen is up, so a deadline that fires behind
    /// a navigation error does not rebuild the screen underneath itself.
    private var launchFailureMounted = false
    #if DEBUG
    /// `TUG_FORCE_LAUNCH_STALL=frontend` suppresses the first `frontendReady`
    /// and no other, so a Retry's reload can still reveal. DEBUG-only.
    private var suppressedFirstFrontendReady = false
    #endif
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

    /// How long the splash may hold before the app says what it is waiting
    /// on. Ten seconds is long enough that no healthy launch reaches it —
    /// the recorded laps put a cold reveal under a second — and short
    /// enough that a stalled one is answered while the user is still
    /// looking at it.
    ///
    /// The spinner it replaces had no deadline at all: a tugcast that never
    /// came up, a DNS lookup that never returned, an interface that never
    /// signalled ready all produced the same endless animation, and the
    /// only exit was force-quitting the app.
    static let splashDeadlineMs = 10_000

    /// `splashDeadlineMs` as the interval `DispatchQueue` wants.
    static var splashDeadlineInterval: TimeInterval {
        TimeInterval(splashDeadlineMs) / 1000
    }

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
        contentController.add(self, name: "getSettings")
        contentController.add(self, name: "frontendReady")
        contentController.add(self, name: "frontendLaunchStalled")
        contentController.add(self, name: "setTheme")
        contentController.add(self, name: "devBadge")
        contentController.add(self, name: "clipboardRead")
        contentController.add(self, name: "clipboardWrite")
        contentController.add(self, name: "clipboardWriteImage")
        contentController.add(self, name: "menuState")
        contentController.add(self, name: "hmrUpdate")
        contentController.add(self, name: "openPath")
        contentController.add(self, name: "lookUpInDictionary")
        contentController.add(self, name: "trashPath")
        contentController.add(self, name: "restorePath")
        contentController.add(self, name: "thumbnailPath")
        contentController.add(self, name: "exportSession")
        contentController.add(self, name: "updateAction")

        // Configure WKWebView
        // No Web Inspector, in any build. `developerExtrasEnabled` stays off
        // so the context menu carries no Inspect Element, and `isInspectable`
        // is never set so Safari's Develop menu cannot attach either. The
        // frontend's own inspector is the DevTools card (⌥⌘/).
        let config = WKWebViewConfiguration()
        applyWebKitFeatureOverrides(to: config.preferences)
        config.userContentController = contentController

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

        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: iconSize),
            iconView.heightAnchor.constraint(equalToConstant: iconSize),
            wave.widthAnchor.constraint(equalToConstant: wave.intrinsicContentSize.width),
            wave.heightAnchor.constraint(equalToConstant: waveSize),
        ])

        wave.startAnimating()
        containerView.addSubview(splashView, positioned: .below, relativeTo: webView)
        self.spinnerView = splashView
        self.splashSpinnerStack = stack
        self.splashWave = wave
        setSplashContent(stack)

        self.contentView = containerView
        // Background color is set by AppDelegate after init, not here.
    }

    // MARK: - The splash, its deadline, and its failure screen

    /// Centre one view in the splash, removing whatever was there.
    ///
    /// The splash has exactly one piece of content at a time — the spinner
    /// stack or the failure screen — and this is the only thing that puts
    /// either there, so the two can never be up at once.
    private func setSplashContent(_ view: NSView) {
        guard let splash = spinnerView else { return }
        splashContent?.removeFromSuperview()
        splashContent = view
        view.translatesAutoresizingMaskIntoConstraints = false
        splash.addSubview(view)
        NSLayoutConstraint.activate([
            view.centerXAnchor.constraint(equalTo: splash.centerXAnchor),
            view.centerYAnchor.constraint(equalTo: splash.centerYAnchor),
        ])
    }

    /// Open the wait: the splash is up, and it has until the deadline to
    /// become an interface.
    ///
    /// Idempotent — a second arm replaces the first, which is what a Retry
    /// wants. Cancelled in `revealWebView`, the one event that closes this
    /// wait; nothing here watches `webView.isHidden`.
    func armSplashDeadline() {
        splashDeadline?.cancel()
        guard spinnerView != nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.mountLaunchFailure(
                stage: self.bridgeDelegate?.bridgeLaunchStageName() ?? "starting",
                reason: nil
            )
        }
        splashDeadline = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + MainWindow.splashDeadlineInterval,
            execute: work
        )
    }

    /// Put the launch's stall on screen: what it is waiting on, and two
    /// ways out of it.
    ///
    /// Mounted by the deadline, by a navigation failure, and by a tugcast
    /// that keeps exiting. It swaps the spinner inside the existing splash
    /// container and **does not touch the WebView**, which may yet load —
    /// a page that arrives late still reveals normally over the top of
    /// this, because `revealWebView` is unchanged by it.
    func mountLaunchFailure(stage: String, reason: String?) {
        // Nothing to say once the interface is up: the splash is gone and
        // the deck raises its own surfaces. This is also what scopes the
        // repeated-respawn route to launch — a tugcast dying in a loop an
        // hour in reaches here and is refused.
        guard spinnerView != nil, webView.isHidden else { return }
        guard !launchFailureMounted else { return }
        launchFailureMounted = true
        splashDeadline?.cancel()
        splashDeadline = nil
        splashWave?.stopAnimating()

        TugLog.error("launch", "stalled", [
            TugLog.field("stage", stage),
            TugLog.field("reason", reason ?? "no reason given"),
        ])

        let title = NSTextField(labelWithString: "Tug is stuck \(stage).")
        title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        title.alignment = .center

        let detail = NSTextField(wrappingLabelWithString:
            reason ?? "It has been waiting \(MainWindow.splashDeadlineMs / 1000) seconds.")
        detail.font = NSFont.systemFont(ofSize: 12)
        detail.alignment = .center
        detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 360

        let retry = NSButton(title: "Retry", target: self, action: #selector(retryLaunchStage))
        retry.bezelStyle = .rounded
        retry.keyEquivalent = "\r"
        let showLog = NSButton(title: "Show Log", target: self, action: #selector(showLaunchLog))
        showLog.bezelStyle = .rounded

        let buttons = NSStackView(views: [retry, showLog])
        buttons.orientation = .horizontal
        buttons.spacing = 12

        let stack = NSStackView(views: [title, detail, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        NSLayoutConstraint.activate([
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
        ])
        setSplashContent(stack)
    }

    /// Put the spinner back and re-open the wait, then ask the host to
    /// re-run the stage. A second stall produces the screen again rather
    /// than an endless spinner, because the deadline is re-armed here.
    @objc private func retryLaunchStage() {
        launchFailureMounted = false
        if let spinner = splashSpinnerStack {
            setSplashContent(spinner)
        }
        splashWave?.startAnimating()
        armSplashDeadline()
        bridgeDelegate?.bridgeRetryLaunchStage()
    }

    /// Reveal today's `tugapp.log.<UTC-date>` in Finder — the file every
    /// launch lap, and the `launch stalled` line above, was written to.
    @objc private func showLaunchLog() {
        NSWorkspace.shared.activateFileViewerSelecting([TugLog.currentFileURL])
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


    // MARK: - Frame burst (diagnostic)

    /// Capture this window as the window server composited it, `count` times
    /// at `intervalMs`, into `/tmp/tug-frames-<stamp>/`. This is UI-process
    /// side: a busy or frozen web process does not stall it, and an animation
    /// the compositor is driving is seen where it actually is — which a
    /// `takeSnapshot` (a web-process paint) cannot show. An app may capture
    /// its own window without a Screen Recording grant. Beside the frames,
    /// `rects.json` locates every composer dot host and masthead dot in page
    /// coordinates, with the animation each one is running, so a script can
    /// crop the regions that matter and diff them frame to frame.
    ///
    /// The loop runs off the main thread on purpose: the point is to observe
    /// the deck, not to add a main-thread burst to what it is already doing.
    func captureFrameBurst(
        count: Int = 30,
        intervalMs: Int = 80,
        completion: @escaping (URL?) -> Void
    ) {
        let stamp = Int(Date().timeIntervalSince1970)
        let dir = URL(fileURLWithPath: "/tmp/tug-frames-\(stamp)")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            NSLog("captureFrameBurst: cannot create %@: %@", dir.path, error.localizedDescription)
            completion(nil)
            return
        }
        let rectsScript = """
        (function(){
          function r(el){ var b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
          function anim(dot){ var a = dot && dot.getAnimations()[0]; return a ? { name: a.animationName, playState: a.playState, startTime: a.startTime, currentTime: a.currentTime } : null; }
          return JSON.stringify({
            innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
            hosts: Array.from(document.querySelectorAll('.cm-tug-session-dot-host')).map(function(h){
              var root = h.querySelector('[data-slot="tug-progress-pulsing-dot"]');
              return { rect: r(h), session: h.getAttribute('data-session-id'), missing: h.getAttribute('data-missing'),
                selected: h.getAttribute('data-selected'), state: root && root.getAttribute('data-state'),
                breathing: !!(root && root.dataset.breathing !== undefined),
                animation: anim(root && root.querySelector('.tug-progress-pulsing-dot-dot')) };
            }),
            mastheads: Array.from(document.querySelectorAll('[data-slot="session-masthead"] [data-slot="tug-progress-pulsing-dot"]')).map(function(m){
              return { rect: r(m), state: m.getAttribute('data-state'), breathing: m.dataset.breathing !== undefined,
                animation: anim(m.querySelector('.tug-progress-pulsing-dot-dot')) };
            })
          });
        })()
        """
        evaluateJavaScript(rectsScript) { result, error in
            if let json = result as? String {
                try? json.write(to: dir.appendingPathComponent("rects.json"), atomically: true, encoding: .utf8)
            } else if let error = error {
                NSLog("captureFrameBurst: rects failed: %@", error.localizedDescription)
            }
        }
        let wid = CGWindowID(windowNumber)
        DispatchQueue.global(qos: .userInitiated).async {
            var times: [Double] = []
            let encode = DispatchQueue(label: "dev.tugapp.frame-burst.encode")
            let group = DispatchGroup()
            for index in 0..<count {
                let t0 = CFAbsoluteTimeGetCurrent()
                if let cg = CGWindowListCreateImage(
                    .null, .optionIncludingWindow, wid, [.boundsIgnoreFraming, .bestResolution]
                ) {
                    let target = dir.appendingPathComponent(String(format: "frame-%02d.png", index))
                    group.enter()
                    encode.async {
                        let rep = NSBitmapImageRep(cgImage: cg)
                        if let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: target)
                        }
                        group.leave()
                    }
                }
                times.append(t0)
                let elapsed = CFAbsoluteTimeGetCurrent() - t0
                let remaining = Double(intervalMs) / 1000 - elapsed
                if remaining > 0 { usleep(UInt32(remaining * 1_000_000)) }
            }
            group.wait()
            let meta: [String: Any] = ["count": count, "intervalMs": intervalMs, "times": times]
            if let data = try? JSONSerialization.data(withJSONObject: meta) {
                try? data.write(to: dir.appendingPathComponent("times.json"))
            }
            DispatchQueue.main.async { completion(dir) }
        }
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

    /// `wanted` if nothing is there, else the same name with `-2`, `-3`, …
    /// before the extension. Mirrors tugcast's `resolve_collision_name`, so a
    /// restored asset is named the way an attached one would have been.
    static func unoccupiedURL(for wanted: URL, fileManager fm: FileManager) -> URL {
        if !fm.fileExists(atPath: wanted.path) { return wanted }
        let dir = wanted.deletingLastPathComponent()
        let stem = wanted.deletingPathExtension().lastPathComponent
        let ext = wanted.pathExtension
        var n = 2
        while true {
            let name = ext.isEmpty ? "\(stem)-\(n)" : "\(stem)-\(n).\(ext)"
            let candidate = dir.appendingPathComponent(name)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            n += 1
        }
    }

    /// Deliver a trash/restore result to JavaScript. Same double-serialization
    /// as `clipboardRead`: JSON for the payload, then JSON again to produce a
    /// valid JS string literal (U+2028 / U+2029 are legal in JSON and not in
    /// JS source text).
    func replyToTrashRequest(_ payload: [String: Any]) {
        replyToBridgeRequest(payload, callback: "__tugTrashCallback")
    }

    /// Deliver a QuickLook thumbnail result to JavaScript. See `os-thumbnail.ts`.
    func replyToThumbnailRequest(_ payload: [String: Any]) {
        replyToBridgeRequest(payload, callback: "__tugThumbnailCallback")
    }

    /// Deliver a request/reply bridge result to the named JS callback.
    private func replyToBridgeRequest(_ payload: [String: Any], callback: String) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8),
              let quotedData = try? JSONSerialization.data(withJSONObject: jsonString,
                                                          options: [.fragmentsAllowed]),
              let quotedString = String(data: quotedData, encoding: .utf8) else {
            NSLog("MainWindow: JSON serialization failed for %@ reply", callback)
            return
        }
        let script = "window.\(callback)?.(JSON.parse(\(quotedString)))"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script) { _, error in
                if let error = error {
                    NSLog("MainWindow: evaluateJavaScript failed for %@ reply: %@",
                          callback, error.localizedDescription)
                }
            }
        }
    }

    /// A PNG data URL for `image`, or nil when the encode fails.
    static func pngDataURL(for image: CGImage) -> String? {
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    /// The font to draw a Look Up in Dictionary callout in: the nearest AppKit
    /// can get to the font the selection is drawn in on the page.
    ///
    /// `families` is a CSS `font-family` list, which names candidates in
    /// preference order and ends in a generic. Most of Tug's stack is bundled
    /// with the web layer rather than installed, so `NSFont(name:)` will
    /// usually miss every entry and the system font at the right SIZE is the
    /// answer — size is what sets the ascent, and the ascent is what decides
    /// whether the callout lands on the word. The family walk is what makes an
    /// installed face (a user's own monospace pick, say) match exactly when it
    /// is there to be matched.
    static func definitionFont(
        families: String,
        size: Double,
        bold: Bool,
        italic: Bool
    ) -> NSFont {
        // AppKit's own default when the page reported nothing usable.
        let points = size > 0 ? CGFloat(size) : NSFont.systemFontSize
        var base: NSFont?
        for candidate in families.split(separator: ",") {
            let name = candidate
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if name.isEmpty { continue }
            if let found = NSFont(name: name, size: points) {
                base = found
                break
            }
        }
        let font = base ?? NSFont.systemFont(ofSize: points)
        var traits: NSFontDescriptor.SymbolicTraits = []
        if bold { traits.insert(.bold) }
        if italic { traits.insert(.italic) }
        if traits.isEmpty { return font }
        let descriptor = font.fontDescriptor.withSymbolicTraits(traits)
        return NSFont(descriptor: descriptor, size: points) ?? font
    }

    /// Clean up WKScriptMessageHandler registrations to break retain cycle
    func cleanupBridge() {
        guard !bridgeCleaned else { return }
        contentController.removeScriptMessageHandler(forName: "sourceTree")
        contentController.removeScriptMessageHandler(forName: "choosePath")
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
        contentController.removeScriptMessageHandler(forName: "lookUpInDictionary")
        contentController.removeScriptMessageHandler(forName: "trashPath")
        contentController.removeScriptMessageHandler(forName: "restorePath")
        contentController.removeScriptMessageHandler(forName: "thumbnailPath")
        contentController.removeScriptMessageHandler(forName: "exportSession")
        contentController.removeScriptMessageHandler(forName: "updateAction")
        bridgeCleaned = true
    }

    deinit {
        cleanupBridge()
    }

    /// Escape a string for safe embedding in JavaScript
    private func escapeForJS(_ str: String) -> String {
        str.replacingOccurrences(of: "\\", with: "\\\\")
           .replacingOccurrences(of: "'", with: "\\'")
           .replacingOccurrences(of: "\n", with: "\\n")
    }

    /// Hand the deck the current update state.
    ///
    /// Called on every transition, and again on `bridgeFrontendReady` — which
    /// is what lets the deck reload mid-download and be caught up by the next
    /// line rather than by a queue [B03]. Nothing here is an event, so a
    /// replay is indistinguishable from the transition that produced it, and
    /// a snapshot delivered twice costs nothing.
    ///
    /// Serialized through JSON rather than interpolated: release notes are
    /// arbitrary HTML or Markdown, and `escapeForJS` handles three characters.
    func bridgeUpdateState(_ snapshot: UpdateSnapshot) {
        guard
            let jsonData = try? JSONSerialization.data(withJSONObject: snapshot.jsonObject),
            let jsonString = String(data: jsonData, encoding: .utf8),
            let quotedData = try? JSONSerialization.data(
                withJSONObject: jsonString, options: [.fragmentsAllowed]),
            let quotedString = String(data: quotedData, encoding: .utf8)
        else {
            NSLog("MainWindow: JSON serialization failed for onUpdateState")
            return
        }
        webView.evaluateJavaScript(
            "window.__tugBridge?.onUpdateState?.(JSON.parse(\(quotedString)))"
        ) { _, error in
            if let error = error {
                NSLog(
                    "MainWindow: evaluateJavaScript failed for onUpdateState: %@",
                    error.localizedDescription
                )
            }
        }
    }

    /// Hand the deck the host's network-path report.
    ///
    /// A **hint**, and the callback name says so nowhere near strongly enough
    /// — `NetworkPathMonitor`'s docstring carries the argument, and
    /// `network-path-store.ts` carries it again on the receiving side. The one
    /// line worth repeating here: `satisfied` is not an assurance, because
    /// captive wifi reports it while nothing gets through.
    func bridgeNetworkPath(status: String, isExpensive: Bool, isConstrained: Bool) {
        let statusArg = escapeForJS(status)
        webView.evaluateJavaScript(
            "window.__tugBridge?.onNetworkPath?.({status: '\(statusArg)', "
                + "isExpensive: \(isExpensive), isConstrained: \(isConstrained)})"
        ) { _, error in
            if let error = error {
                NSLog(
                    "MainWindow: evaluateJavaScript failed for onNetworkPath: %@",
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
        // The event that closes the wait the splash opened. Cancelling here
        // and arming at the mount is the whole of the deadline's lifecycle
        // — nothing polls, and a reveal that beats the deadline leaves no
        // timer behind to fire into a live interface.
        splashDeadline?.cancel()
        splashDeadline = nil
        // The launch's last line. Either the log holds a reveal or it does
        // not, and "it does not" is the whole of the diagnosis for a launch
        // that never finished — read against the last `launch` line's
        // `stage` field, which names what it was waiting on.
        TugLog.info("launch", "reveal", [
            TugLog.field(
                "ms",
                String(
                    format: "%.1f",
                    (CFAbsoluteTimeGetCurrent() - AppDelegate.launchStartedAt) * 1000
                )
            ),
            TugLog.field("hidden_before", webView.isHidden),
        ])

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
        TugLog.error("webview", "navigation failed", [
            TugLog.field("error", error.localizedDescription),
        ])
        // A failure during launch has no deadline worth waiting out: the
        // navigation is already over. `mountLaunchFailure` refuses once the
        // interface is up, so a failure after the reveal only logs.
        mountLaunchFailure(
            stage: bridgeDelegate?.bridgeLaunchStageName() ?? "loading interface",
            reason: error.localizedDescription
        )
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("Navigation failed (provisional): %@", error.localizedDescription)
        // The provisional failure is the launch-relevant one: it means the
        // page never began loading, so a splash that is still up has this
        // line behind it and nothing else.
        TugLog.error("webview", "provisional navigation failed", [
            TugLog.field("error", error.localizedDescription),
        ])
        mountLaunchFailure(
            stage: bridgeDelegate?.bridgeLaunchStageName() ?? "loading interface",
            reason: error.localizedDescription
        )
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
            TugLog.error("webview", "WebContent process terminated again — not reloading", [
                TugLog.field("since_s", String(format: "%.1f", now.timeIntervalSince(previous))),
            ])
            return
        }

        NSLog("MainWindow: WebContent process terminated — reloading")
        TugLog.warn("webview", "WebContent process terminated — reloading")
        if webView.url != nil {
            webView.reload()
        } else if let urlString = lastLoadedURLString {
            // A terminated process can leave `url` nil, and `reload()`
            // on a webview with no URL does nothing at all.
            loadURL(urlString)
        } else {
            NSLog("MainWindow: no URL to reload after WebContent termination")
            TugLog.error("webview", "no URL to reload after WebContent termination")
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
        case "lookUpInDictionary":
            // Look Up in Dictionary. The web layer sends the selected text and
            // the viewport (CSS) point its panel should anchor to; AppKit's
            // `showDefinition(for:at:)` puts up the system definition panel —
            // Dictionary, Thesaurus, whatever else the user has enabled —
            // exactly as a native text view would.
            //
            // `showDefinition` does not merely place a panel — it redraws the
            // string as a yellow callout over the word, measured from the
            // attributed string's own attributes and positioned from `at:`,
            // which is the BASELINE ORIGIN of the first character. Both halves
            // have to be right or the callout sits off the word, so the web
            // layer sends the baseline it measured and the selection's font
            // travels with it.
            //
            // Only the scale changes on the way in. A WKWebView's coordinate
            // system is Y-down from the top-left — the same space the viewport
            // rect was measured in — but `pageZoom` stands between CSS px and
            // view points, so a reader who has pressed ⌘+ still gets the
            // callout on the word rather than a fraction of the way up it.
            guard let body = message.body as? [String: Any],
                  let text = body["text"] as? String, !text.isEmpty else { return }
            let zoom = webView.pageZoom
            let anchor = NSPoint(
                x: ((body["x"] as? Double) ?? 0) * zoom,
                y: ((body["y"] as? Double) ?? 0) * zoom
            )
            let font = MainWindow.definitionFont(
                families: (body["fontFamily"] as? String) ?? "",
                size: ((body["fontSize"] as? Double) ?? 0) * zoom,
                bold: (body["bold"] as? Bool) ?? false,
                italic: (body["italic"] as? Bool) ?? false
            )
            let defined = NSAttributedString(string: text, attributes: [.font: font])
            webView.showDefinition(for: defined, at: anchor)
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
        case "trashPath":
            // Move an attachment to the macOS Trash. `NSWorkspace.recycle`
            // reports the destination URL, and that URL is the entire restore
            // mechanism — `restorePath` moves the file back from it, so undo
            // never needs Finder's Put Back to be programmatically drivable.
            // Trashing rather than unlinking also means Put Back works for a
            // user who never presses Cmd-Z.
            //
            // JS-side contract: post {requestId, path} and wait for
            // window.__tugTrashCallback({requestId, ok, trashedPath, error}).
            // See os-trash.ts.
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let rawPath = body["path"] as? String, !rawPath.isEmpty else { return }
            let url = URL(fileURLWithPath: (rawPath as NSString).expandingTildeInPath)
            NSWorkspace.shared.recycle([url]) { [weak self] newURLs, error in
                guard let self = self else { return }
                if let error = error {
                    self.replyToTrashRequest(["requestId": requestId, "ok": false,
                                              "error": error.localizedDescription])
                    return
                }
                guard let trashed = newURLs[url] else {
                    self.replyToTrashRequest(["requestId": requestId, "ok": false,
                                              "error": "no trashed URL reported"])
                    return
                }
                self.replyToTrashRequest(["requestId": requestId, "ok": true,
                                          "trashedPath": trashed.path])
            }
        case "restorePath":
            // The symmetric half of `trashPath`, and it has to live here: the
            // fs route family has no move verb, and /api/fs/write is a text
            // writer that would corrupt binary bytes. The host already holds
            // the trashed URL it minted, so the restore is one moveItem.
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let trashedPath = body["trashedPath"] as? String, !trashedPath.isEmpty,
                  let destinationPath = body["destination"] as? String, !destinationPath.isEmpty
            else { return }
            let from = URL(fileURLWithPath: (trashedPath as NSString).expandingTildeInPath)
            let wanted = URL(fileURLWithPath: (destinationPath as NSString).expandingTildeInPath)
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: wanted.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                // Something may have taken the name back while the file sat in
                // the Trash. Suffix rather than overwrite, and report where it
                // actually landed so the deck can rewrite the re-inserted link.
                let target = Self.unoccupiedURL(for: wanted, fileManager: fm)
                try fm.moveItem(at: from, to: target)
                replyToTrashRequest(["requestId": requestId, "ok": true,
                                     "restoredPath": target.path])
            } catch {
                replyToTrashRequest(["requestId": requestId, "ok": false,
                                     "error": error.localizedDescription])
            }
        case "thumbnailPath":
            // A QuickLook thumbnail for a non-image attachment. A .txt, a .pdf,
            // a .key — the system already knows how to draw a preview of each,
            // and QuickLook is the only way to ask: it runs the owning app's
            // thumbnail extension out of process. Nothing in the web layer can
            // do this, which is why it is a bridge rather than a route.
            //
            // `.all` rather than `.thumbnail`, so a file whose type has no
            // content preview still comes back with its document icon instead
            // of nothing — that icon names the file's kind, which is strictly
            // more than the deck's generic glyph says.
            //
            // JS-side contract: post {requestId, path, size} and wait for
            // window.__tugThumbnailCallback({requestId, dataUrl}). A file with
            // no thumbnail at all replies with a null dataUrl rather than
            // staying silent, so the caller settles instead of timing out.
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let rawPath = body["path"] as? String, !rawPath.isEmpty else { return }
            let points = (body["size"] as? Double) ?? 64
            let url = URL(fileURLWithPath: (rawPath as NSString).expandingTildeInPath)
            let scale = webView.window?.backingScaleFactor ?? 2
            let request = QLThumbnailGenerator.Request(
                fileAt: url,
                size: CGSize(width: points, height: points),
                scale: scale,
                representationTypes: .all)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) {
                [weak self] representation, _ in
                guard let self = self else { return }
                let dataUrl = representation.flatMap { Self.pngDataURL(for: $0.cgImage) }
                self.replyToThumbnailRequest([
                    "requestId": requestId,
                    // NSNull, not a nil Optional: JSONSerialization refuses the
                    // latter outright and the reply would never be delivered.
                    "dataUrl": dataUrl ?? NSNull(),
                ])
            }
        case "updateAction":
            // The deck's one way to answer the update flow — the pill's and
            // the popover's controls all arrive here [B03]. The host maps the
            // name onto whichever Sparkle reply closure the current state
            // holds, and ignores one the state has no closure for, so a stale
            // click from a deck that reloaded mid-flow does nothing rather
            // than replying twice.
            guard let name = message.body as? String,
                  let action = UpdateAction(rawValue: name) else {
                // To `tugapp.log` rather than `NSLog`: a press that vanishes
                // here is indistinguishable from a dead button, and the line
                // that says otherwise has to be in the log somebody reads.
                TugLog.warn("update", "updateAction with an unreadable body; ignoring", [
                    TugLog.field("body", String(describing: message.body)),
                ])
                return
            }
            if let appDelegate = NSApp.delegate as? AppDelegate {
                appDelegate.performUpdateAction(action)
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
            #if DEBUG
            if LaunchStall.forced == .frontend, !suppressedFirstFrontendReady {
                suppressedFirstFrontendReady = true
                NSLog("MainWindow: TUG_FORCE_LAUNCH_STALL=frontend — ignoring the first frontendReady")
                return
            }
            #endif
            revealWebView()
            bridgeDelegate?.bridgeFrontendReady()
        case "frontendLaunchStalled":
            // The deck bounded its own boot awaits and one of them ran past
            // its horizon. It has not given up — the await is still running
            // — so this only names the wait, which is more than the splash
            // could say on its own.
            let waitingOn = (message.body as? [String: Any])?["waitingOn"] as? String
            TugLog.warn("launch", "frontend boot await ran past its horizon", [
                TugLog.field("waiting_on", waitingOn ?? "unknown"),
            ])
            mountLaunchFailure(
                stage: "\(LaunchStage.waitingForInterface.rawValue): \(waitingOn ?? "unknown")",
                reason: "The interface loaded but has not finished starting up."
            )
        case "setTheme":
            guard let body = message.body as? [String: Any],
                  let color = body["color"] as? String else { return }
            bridgeDelegate?.bridgeSetTheme(color: color)
        case "devBadge":
            guard let body = message.body as? [String: Any] else { return }
            let backend = body["backend"] as? Bool ?? false
            let app = body["app"] as? Bool ?? false
            bridgeDelegate?.bridgeDevBadge(backend: backend, app: app)
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
            // our private `dev.tugapp.prompt-atoms` type for Tug-to-Tug paste.
            // Fire-and-forget; NSPasteboard writes synchronously.
            // JS-side contract: post {text, atoms, html}. `atoms` is "" when
            // the selection carried no atoms; `html` is "" for a surface with
            // no rich-text flavor to offer. A surface that renders its text
            // sends both: owning the whole write is the only way to carry a
            // sidecar, and a write that carried only `.string` would silently
            // strip formatting an external paste used to get.
            // See tug-native-clipboard.ts.
            guard let body = message.body as? [String: Any],
                  let text = body["text"] as? String else {
                NSLog("MainWindow: clipboardWrite invalid payload")
                return
            }
            let atoms = body["atoms"] as? String ?? ""
            let html = body["html"] as? String ?? ""
            let pasteboard = NSPasteboard.general
            var types: [NSPasteboard.PasteboardType] = [.string]
            if !html.isEmpty { types.append(.html) }
            if !atoms.isEmpty { types.append(tugAtomsPasteboardType) }
            // declareTypes clears the pasteboard and declares ownership of
            // the listed types in one step, so the subsequent setString
            // calls are guaranteed to take.
            pasteboard.declareTypes(types, owner: nil)
            pasteboard.setString(text, forType: .string)
            if !html.isEmpty {
                pasteboard.setString(html, forType: .html)
            }
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
