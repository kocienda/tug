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
/// restores stock WebKit behavior for a control arm. Every web view the host
/// makes takes the same overrides, the spike's child page included.
func applyWebKitFeatureOverrides(to preferences: WKPreferences) {
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
    func bridgeSetTheme(color: String)
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
final class ClickThroughWebView: WKWebView {
    /// For a body's view: whether the shell has named this view's card for
    /// the keyboard. Nil for the shell's own view, which is never gated.
    /// Read by the window's `makeFirstResponder`.
    var keyboardNamed: (() -> Bool)?

    /// Whether the event being dispatched now is a mouse-down inside this
    /// view: the user's own click, which takes the keyboard wherever it
    /// lands. A stale event is not one — the location of a click made
    /// seconds ago says nothing about a view since placed under it.
    ///
    /// Read from the event the window is dispatching, ahead of
    /// `NSApp.currentEvent`: that names only an event that came through the
    /// app's queue, and a click handed to the window's `sendEvent` directly
    /// (the harness's own-pid mode) would read as no click at all, so the
    /// view it landed in could never take the keyboard from a body the
    /// shell had named.
    var liveClickInside: Bool {
        guard let event = (window as? MainWindow)?.dispatchingEvent ?? NSApp.currentEvent,
              event.window === window else { return false }
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            return ProcessInfo.processInfo.systemUptime - event.timestamp < 0.5
                && bounds.contains(convert(event.locationInWindow, from: nil))
        default:
            return false
        }
    }
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

    /// Whether a point in the superview's coordinates belongs to a view
    /// beneath this one. The overlay stands over the whole window and is
    /// transparent outside what it claims; a click there is the card's or
    /// the shell's beneath, so the overlay's view answers no hit and AppKit
    /// tries the views below.
    var passesThrough: ((NSPoint) -> Bool)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        if let passesThrough, passesThrough(point) { return nil }
        return super.hitTest(point)
    }

    // MARK: - Drags beneath the overlay
    //
    // AppKit finds a drag's destination without asking `hitTest`: the
    // overlay's view covers the window, so every drag arrives there, from
    // Finder and from the window alike. The overlay's view hands each call
    // to the view a click at the pointer would reach — the body beneath it,
    // or the shell's view where no card is — and WebKit turns the forwarded
    // call into that page's own `dragenter`/`dragover`/`drop` with the drag's
    // pasteboard on `dataTransfer`. Where the overlay claims the pointer the
    // call is its own. A body's view and the shell's have no `dragTarget`,
    // so every call either is handed is answered by WebKit.

    /// The web view beneath this one a drag at a point in window
    /// coordinates belongs to, or nil where the drag is this view's.
    var dragTarget: ((NSPoint) -> WKWebView?)?

    /// Who holds the drag in progress: the view that was last sent
    /// `draggingEntered`, and is owed the exit or the drop.
    private enum DragHolder {
        case none
        case own
        case other(WKWebView)
    }

    private var dragHolder: DragHolder = .none

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        dragHolder = .none
        return routeDrag(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        routeDrag(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        leaveDrag(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        switch dragHolder {
        case .other(let view): return view.prepareForDragOperation(sender)
        case .own, .none: return super.prepareForDragOperation(sender)
        }
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        switch dragHolder {
        case .other(let view): return view.performDragOperation(sender)
        case .own, .none: return super.performDragOperation(sender)
        }
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        switch dragHolder {
        case .other(let view): view.concludeDragOperation(sender)
        case .own, .none: super.concludeDragOperation(sender)
        }
        dragHolder = .none
    }

    /// Send the call to whoever is under the pointer now. A move from one
    /// holder to another exits the first and enters the second, so each page
    /// sees a whole `dragenter` … `dragleave` of its own.
    private func routeDrag(_ sender: NSDraggingInfo) -> NSDragOperation {
        let target = dragTarget?(sender.draggingLocation)
        switch (dragHolder, target) {
        case (.own, nil):
            return super.draggingUpdated(sender)
        case (.other(let held), let view?) where held === view:
            return view.draggingUpdated(sender)
        default:
            leaveDrag(sender)
            if let target {
                dragHolder = .other(target)
                return target.draggingEntered(sender)
            }
            dragHolder = .own
            return super.draggingEntered(sender)
        }
    }

    private func leaveDrag(_ sender: NSDraggingInfo?) {
        switch dragHolder {
        case .none: break
        case .own: super.draggingExited(sender)
        case .other(let view): view.draggingExited(sender)
        }
        dragHolder = .none
    }

    /// Harness pid mode (`TUGAPP_NATIVE_EVENT_MODE=pid`) needs no exception
    /// here: its window is really key, so AppKit asks this question for the
    /// same click it asks it for in the field — one into a window that is not
    /// key, which the harness makes only by resigning the app
    /// (`HarnessLifecycle`).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
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

    // MARK: - Writing-direction key bindings
    //
    // Cocoa's StandardKeyBinding.dict binds ⌃⌘↓ / ⌃⌘← / ⌃⌘→ to
    // `makeBaseWritingDirectionNatural:` / `RightToLeft:` / `LeftToRight:`, and
    // those chords are the deck's own: ⌃⌘↓ is Move Card Down in Column and
    // ⌃⌘←/→ show and hide a side. `AppDelegate` allows the bindings (see
    // `NSAllowsBaseWritingDirectionKeyBindings` there), which is what stops
    // AppKit beeping at them; the selector then reaches this view. While the
    // page handles the keydown it is discarded with it. When it does not,
    // WebKit sends the command back here, and WKWebView answers the three
    // `makeTextWritingDirection…:` actions but none of the base ones.
    //
    // Answered here as deliberate no-ops. The deck never sets a paragraph's base
    // direction from the keyboard, so nothing is lost by declining it quietly.

    override func makeBaseWritingDirectionNatural(_ sender: Any?) {}
    override func makeBaseWritingDirectionLeftToRight(_ sender: Any?) {}
    override func makeBaseWritingDirectionRightToLeft(_ sender: Any?) {}
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
    /// The one microphone. Constructed once the web view exists, because its
    /// `emit` closure pushes across the bridge; it holds no audio resources
    /// until a `start` arrives, so a window that never dictates never touches
    /// the input node.
    private var dictationEngine: DictationEngine!
    /// The `.scrollWheel` local monitor feeding `bridgeScrollPhase`; removed
    /// in `cleanupBridge`.
    private var scrollPhaseMonitor: Any?
    /// The meter the harness arms (`hostFrames`); a page's own request gets a
    /// meter of its own, held in `pageFrameMeters` until it is answered.
    private(set) lazy var hostFrameMeter = HostFrameMeter(view: containerView)
    private var pageFrameMeters: [String: HostFrameMeter] = [:]
    /// Every meter reading the window now — the harness's and each page's —
    /// so a beat plan that arrives during a reading can name its bodies to
    /// it (`BodyViewController.runPlan`).
    var armedFrameMeters: [HostFrameMeter] {
        ([hostFrameMeter] + pageFrameMeters.values).filter(\.isArmed)
    }
    /// Every body view: created, placed, focused and destroyed at the shell's
    /// word. Made in `init`, after the container exists.
    private(set) var bodies: BodyViewController!
    /// The view that made each live dictation claim, by its id: every event
    /// goes back to the page whose claim it is. A claim superseded by
    /// another page's `start` hears its own `ended` there, not in the page
    /// that took the mic. A terminal event lets the entry go.
    private let dictationTargets = NSMapTable<NSString, WKWebView>.strongToWeakObjects()
    #if DEBUG
    /// The display-rate spike's child page (`spikeBody`), made on first use.
    /// DEBUG-only.
    private var spikeBodyStorage: SpikeBodyHandlers?
    var spikeBody: SpikeBodyHandlers {
        if let spikeBodyStorage { return spikeBodyStorage }
        let made = SpikeBodyHandlers(window: self)
        spikeBodyStorage = made
        return made
    }
    #endif
    private var devInfoOverlay: DevInfoOverlayView?
    private var devInfoLabel: NSTextField?
    weak var bridgeDelegate: BridgeDelegate?
    private var bridgeCleaned = false

    /// Last URL handed to `loadURL`, so a recovery reload has somewhere
    /// to go when the dead WebContent process left `webView.url` nil.
    private var lastLoadedURLString: String?

    /// Whether the shell has finished a navigation past `/auth`: tugcast
    /// took the launch's one-time token and set the session cookie. From
    /// then on the token is spent — loading its URL again earns a 403 —
    /// and the page's origin root is where a fresh load goes.
    private var interfaceAuthenticated = false

    /// Where Retry sends the shell while the launch waits on the interface:
    /// the URL the interface was loaded from — Vite's origin in a debug
    /// bundle, tugcast's otherwise — as its auth URL until the token has
    /// been exchanged, and as that origin's root after. `nil` when the
    /// interface was never loaded.
    func interfaceRetryURL() -> String? {
        guard let urlString = lastLoadedURLString else { return nil }
        guard interfaceAuthenticated, var components = URLComponents(string: urlString) else {
            return urlString
        }
        components.path = "/"
        components.query = nil
        return components.string
    }

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

    /// The harness's visible tier (`TUGAPP_HARNESS_VISIBLE=1`, pid mode only):
    /// the launch needs a rendering viewport, not an active app. WebKit
    /// suspends `requestAnimationFrame` in an occluded window, and the
    /// background launch's window sits a level below normal where anything
    /// covers it. Every pid-mode launch turns occlusion detection off, so the
    /// tier changes the launch only where that switch is missing: the window
    /// is then ordered front at normal level without activating.
    static let harnessVisibleViewport = ProcessInfo.processInfo.environment["TUGAPP_HARNESS_VISIBLE"] == "1"

    /// Whether pid mode's occlusion switch took on the shell's web view. When
    /// it did not — a WebKit without the SPI — the visible tier in
    /// `AppDelegate` falls back to ordering the window front at normal level
    /// without activating.
    private(set) var harnessRendersWhenCovered = false

    /// Keep `webView` rendering while its window is covered, by turning off
    /// WebKit's window-occlusion detection — the one input of
    /// `WebViewImpl::isViewVisible` that reads `NSWindow.occlusionState`.
    /// Private SPI (`_setWindowOcclusionDetectionEnabled:`), reached by
    /// selector so a WebKit without it declines rather than crashes; accepted
    /// for test mode only, and called for every web view of a pid-mode
    /// launch, whose window sits a level below normal where anything covers
    /// it. Returns whether the switch was there to throw.
    @discardableResult
    static func keepRenderingWhenCovered(_ webView: WKWebView) -> Bool {
        let setter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        guard webView.responds(to: setter), let imp = webView.method(for: setter) else { return false }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(imp, to: Setter.self)(webView, setter, false)
        return true
    }

    /// How long the splash may hold before the app says what it is waiting
    /// on. Twenty seconds is long enough that no healthy launch reaches it,
    /// even on a slow or heavily loaded machine — the recorded laps put a
    /// cold reveal under a second on a fast one — and short enough that a
    /// stalled one is answered while the user is still looking at it. Ten
    /// seconds proved too tight: a slower machine mid-launch is still
    /// healthy, and the "stuck" surface it earned there was a false alarm.
    /// It must exceed `ProcessManager.viteReadyTimeout`, which the debug
    /// bundle's launch waits out inside this window.
    ///
    /// The spinner it replaces had no deadline at all: a tugcast that never
    /// came up, a DNS lookup that never returned, an interface that never
    /// signalled ready all produced the same endless animation, and the
    /// only exit was force-quitting the app.
    static let splashDeadlineMs = 20_000

    /// The deadline when the interface is served by Vite (a debug bundle).
    /// Vite serves the deck as some 1,800 unbundled modules, and a cold
    /// first launch after a build — nothing transformed, nothing cached —
    /// was recorded revealing at 24 s on a healthy machine (2026-10-21),
    /// past the 20 s above. A warm one reveals in about 7 s. Matched by the
    /// deck's own boot-await horizon in dev (`BOOT_AWAIT_HORIZON_MS` in
    /// `main.tsx`).
    static let viteSplashDeadlineMs = 60_000

    /// The deadline this launch runs under: `splashDeadlineMs`, or
    /// `viteSplashDeadlineMs` when the host serves through Vite. Set by the
    /// host before it arms the deadline.
    var activeSplashDeadlineMs = MainWindow.splashDeadlineMs

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
    // The host owns the factor — the View menu, its chords, the bounds and
    // the persistence — and the deck applies it: a `transform: scale(f)` on
    // its root, sized to the window ÷ f (`tugdeck/src/lib/page-zoom-store.ts`).
    // `webView.pageZoom` is never written and stays 1.0: WebKit floors every
    // face at 9 zoomed px under it, so below 90 % the type stopped shrinking
    // while the boxes kept going, and no host door lifts that floor. The
    // user's chosen zoom persists to `UserDefaults` and is reapplied on
    // launch, before the web view is revealed.
    //
    // The factor is one of `pageZoomLevels`, and Zoom In / Zoom Out step along
    // them rather than by a fixed increment: fine steps near 100 %, where the
    // choice is about comfort, coarse ones toward the ends, where it is about
    // fitting more deck or reading from further back. The deck holds the same
    // list (`PAGE_ZOOM_LEVELS` in `tugdeck/src/lib/page-zoom-store.ts` — keep
    // the two in lockstep), and the Layout card's Zoom row offers the four
    // everyday ones from it (`PAGE_ZOOM_ROW_LEVELS`). The
    // ends are the bounds. Only the app-test harness sets a factor between
    // levels (`applyPageZoom`), for geometry it wants to read at any scale.
    private static let pageZoomDefaultsKey = "WebViewPageZoom"
    /// The last factor other than 100 %, which Toggle Actual Size returns to.
    private static let pageZoomAwayDefaultsKey = "WebViewPageZoomAway"
    static let pageZoomLevels: [CGFloat] = [0.5, 0.7, 0.8, 0.9, 1.0, 1.25, 1.5, 2.0]
    static let minPageZoom: CGFloat = pageZoomLevels.first!
    static let maxPageZoom: CGFloat = pageZoomLevels.last!
    static let defaultPageZoom: CGFloat = 1.0

    /// The level nearest `zoom` — what a persisted factor from before the
    /// levels, or one between them, is read as.
    static func nearestPageZoomLevel(_ zoom: CGFloat) -> CGFloat {
        return pageZoomLevels.min(by: { abs($0 - zoom) < abs($1 - zoom) })!
    }

    /// Comparison slack for factors: a level read back from `Double` is not
    /// bit-identical to the literal.
    static let pageZoomEpsilon: CGFloat = 0.005

    /// The View › Zoom factor the deck is drawn at — stored state, applied by
    /// the deck to its own root. Never `webView.pageZoom`.
    private var zoomFactor: CGFloat = MainWindow.defaultPageZoom

    /// The last factor other than 100 % the user chose, or nil if they never
    /// have. Toggle Actual Size (⌥⌘0) goes there from 100 %.
    private(set) var pageZoomAway: CGFloat?

    /// Whether a zoom choice is written to `UserDefaults`. Not under the
    /// app-test harness, which drives the View menu and the Layout card's
    /// Zoom row like a user and must not move the user's own zoom.
    private let persistsPageZoom =
        ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] != "1"

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

        // The app going inactive or hidden takes the mouse a carried gesture
        // waits on, whether or not this window is told it resigned key.
        for name in [NSApplication.didResignActiveNotification, NSApplication.didHideNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.bodies?.cancelGesture() }
            }
        }

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

        let config = makeWebViewConfiguration(forShell: true)
        contentController = config.userContentController

        let clickThroughWebView = ClickThroughWebView(frame: .zero, configuration: config)
        clickThroughWebView.onActivationClick = { [weak self] location in
            self?.forwardActivationClick(at: location)
        }
        webView = clickThroughWebView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if AppDelegate.harnessPidMode {
            harnessRendersWhenCovered = MainWindow.keepRenderingWhenCovered(webView)
        }
        webView.allowsBackForwardNavigationGestures = false

        // The microphone, wired to the bridge. `audioDisabled` under the
        // app-test harness: no automated run engages the mic ([P06]), and the
        // no-audio branch still answers `ready`, `ended { stopped }` and
        // `ended { superseded }`, so the ordering rules stay testable ([P01]).
        dictationEngine = DictationEngine(
            audioDisabled: ProcessInfo.processInfo.environment["TUGAPP_TEST_SOCKET"] != nil,
            emit: { [weak self] event in self?.bridgeDictationEvent(event) }
        )

        // The trackpad's phase edges, which `WheelEvent` does not carry. The
        // monitor observes and returns every event untouched; see
        // `bridgeScrollPhase`.
        scrollPhaseMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) {
            [weak self] event in
            if let self, event.window === self {
                self.bridgeScrollPhase(of: event)
            }
            return event
        }

        // Suppress WKWebView's default white background. The webView starts
        // hidden and is revealed by frontendReady after JS applies the theme.
        webView.setValue(false, forKey: "drawsBackground")
        webView.isHidden = true

        // Restore the user's last page-zoom selection from UserDefaults. The
        // deck receives it on `frontendReady`, ahead of the reveal, and
        // applies it to its root (`bridgePageZoom`); `webView.pageZoom` is
        // left at 1.0. `object(forKey:)` returns nil for an unset key (first
        // launch); the factor stays 1.0 in that case. A persisted value that
        // is not a level (from before the levels, or a future range change)
        // is read as the nearest one, not discarded — the next zoom action
        // re-writes it back to defaults.
        //
        // The app-test harness pins 1.0 instead of restoring. A stray ⌘+ in
        // one app-test window would otherwise change the geometry of every
        // later run. Test geometry is the harness's to control
        // (`setPageZoom`), not a persisted user preference's.
        if ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] == "1" {
            zoomFactor = MainWindow.defaultPageZoom
        } else if let saved = UserDefaults.standard.object(forKey: MainWindow.pageZoomDefaultsKey) as? Double {
            zoomFactor = MainWindow.nearestPageZoomLevel(CGFloat(saved))
        }
        if persistsPageZoom,
           let away = UserDefaults.standard.object(forKey: MainWindow.pageZoomAwayDefaultsKey) as? Double {
            let level = MainWindow.nearestPageZoomLevel(CGFloat(away))
            if abs(level - MainWindow.defaultPageZoom) > MainWindow.pageZoomEpsilon {
                pageZoomAway = level
            }
        }

        // Container view holds both the WebView and any snapshot overlays.
        // The snapshot overlay is a sibling of the WebView (not a child) so
        // it is unaffected by WKWebView's compositing during navigation.
        containerView = DeckContainerView(frame: contentRect)
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
        // The cards stand over the shell, which paints the deck's canvas and
        // grid beneath them; the overlay, made later, stands over both.
        let bodyHost = BodyHostView(frame: containerView.bounds)
        bodyHost.autoresizingMask = [.width, .height]
        containerView.addSubview(bodyHost, positioned: .above, relativeTo: webView)
        bodies = BodyViewController(window: self, hostView: bodyHost)
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
            deadline: .now() + TimeInterval(activeSplashDeadlineMs) / 1000,
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
            reason ?? "It has been waiting \(activeSplashDeadlineMs / 1000) seconds.")
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
    /// the Y-down, top-left-origin point the DOM uses, and it is the viewport
    /// point as it stands: View › Zoom is a transform on the deck root, never
    /// `pageZoom`, so there is no scale between the two (the inverse of
    /// `CoordMapping.viewportToScreen`). Points outside the web view — the
    /// title bar, the resize margins — activate nothing.
    func forwardActivationClick(at locationInWindow: NSPoint) {
        let viewLocal = webView.convert(locationInWindow, from: nil)
        guard webView.bounds.contains(viewLocal) else { return }
        hostChannel.send(.activationClick(ActivationClick(x: Double(viewLocal.x), y: Double(viewLocal.y))), to: webView)
    }

    /// Load URL in webview
    func loadURL(_ urlString: String) {
        NSLog("MainWindow: loadURL called with %@", urlString)
        guard let url = URL(string: urlString) else { return }
        lastLoadedURLString = urlString
        let request = URLRequest(url: url)
        webView.load(request)
    }

    /// Evaluate JavaScript in the current page context: the harness's door,
    /// and the frame burst's read of the page. A message to the page goes
    /// through `hostChannel` instead.
    // host-channel: diagnostic read
    func evaluateJavaScript(_ script: String, completionHandler: ((Any?, Error?) -> Void)? = nil) {
        // host-channel: diagnostic read
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
    // host-channel: diagnostic read
    func callAsyncJavaScript(
        _ body: String,
        completionHandler: @escaping @MainActor @Sendable (Result<Any, Error>) -> Void
    ) {
        // host-channel: diagnostic read
        webView.callAsyncJavaScript(
            body,
            arguments: [:],
            in: nil,
            in: .page,
            completionHandler: completionHandler
        )
    }

    /// Every view the quit asks to prepare: the shell, then each body that
    /// is bound and ready, labelled for the verdict line.
    func terminationViews() -> [(label: String, webView: WKWebView)] {
        [("shell", webView)] + (bodies?.terminable ?? []).map { ("body:\($0.cardId)", $0.webView) }
    }

    /// The event `sendEvent` is dispatching now, for a view asking whether it
    /// is the target of a live click (`ClickThroughWebView.liveClickInside`).
    private(set) var dispatchingEvent: NSEvent?

    override func sendEvent(_ event: NSEvent) {
        let prior = dispatchingEvent
        dispatchingEvent = event
        defer { dispatchingEvent = prior }
        // The left button's state as this window has seen it, which a card's
        // `cardGesture` begin is read against: the page's message can arrive
        // after the up it was pressed for.
        if event.type == .leftMouseDown || event.type == .leftMouseUp {
            // A press also takes a card a settle is carrying from its beats,
            // where it shows, so the press reaches the card it lands on.
            let viewport = BodyGeometry.flipped(
                containerView.convert(event.locationInWindow, from: nil), inHeight: containerView.bounds.height
            )
            bodies?.noteLeftButton(down: event.type == .leftMouseDown, atViewport: viewport)
        }
        // A card drag or resize the host is tracking takes each drag and the
        // up before the page that started it sees them, so the card moves in
        // the same commit as the event; the page still gets them, and ignores
        // moves once it has handed the gesture over. Escape cancels it, and
        // goes no further.
        if let bodies, bodies.gestureLive {
            switch event.type {
            case .leftMouseDragged, .leftMouseUp:
                bodies.track(event)
            case .keyDown where event.keyCode == MainWindow.escapeKeyCode:
                bodies.cancelGesture()
                return
            default:
                break
            }
        }
        super.sendEvent(event)
    }

    /// The Escape key's virtual key code.
    private static let escapeKeyCode: UInt16 = 53

    /// A window that loses key loses the mouse-up a tracked gesture waits on.
    override func resignKey() {
        bodies?.cancelGesture()
        super.resignKey()
    }

    #if DEBUG
    /// The no-responder beep's one chokepoint. AppKit raises the beep for a
    /// `keyDown:` that reaches the end of the responder chain unhandled by
    /// calling this. The test-mode tripwire records it and swallows it so the
    /// run stays silent; outside the harness it is not armed, so the beep plays
    /// for a real user. See `TestHarness/BeepTripwire.swift`.
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)),
           BeepTripwire.shared.record(origin: "noResponder(for: keyDown:)") {
            return
        }
        super.noResponder(for: eventSelector)
    }
    #endif

    /// Make the WKWebView the window's first responder so keyboard focus lands
    /// inside the web content. A menu key equivalent (⌘L) fires even when the
    /// native title bar — not the web view — holds focus; a DOM focus change
    /// dispatched into tugdeck is invisible while the OS keyboard focus sits on
    /// the title bar, so the caller pairs this with the control dispatch.
    /// The keyboard goes where the shell names it, or where the user
    /// clicks, and nowhere else. A page's own DOM focus asks the window to
    /// make its view first responder — WebKit's `makeFirstResponder`, which
    /// consults no `acceptsFirstResponder` — and it asks without the shell:
    /// a body told it was the key card a beat ago focused its stop after
    /// the shell had named another card, and took the keyboard from it
    /// (row 6's reading: a sidebar shown from the menu). Refusing here,
    /// before `super` resigns anyone, leaves the keyboard where it was.
    @discardableResult
    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        if let view = responder as? ClickThroughWebView, let named = view.keyboardNamed,
           !named(), !view.liveClickInside {
            return false
        }
        return super.makeFirstResponder(responder)
    }

    func focusWebView() {
        makeFirstResponder(webView)
    }

    // MARK: - Page zoom API

    /// Current zoom factor (1.0 == actual size).
    var currentPageZoom: CGFloat {
        return zoomFactor
    }

    /// Set page zoom to the level nearest `zoom` and persist it to
    /// UserDefaults so the choice survives across launches. A level other
    /// than 100 % is also remembered as where Toggle Actual Size returns.
    func setPageZoom(_ zoom: CGFloat) {
        let level = applyPageZoom(MainWindow.nearestPageZoomLevel(zoom))
        if abs(level - MainWindow.defaultPageZoom) > MainWindow.pageZoomEpsilon {
            pageZoomAway = level
        }
        guard persistsPageZoom else { return }
        UserDefaults.standard.set(Double(level), forKey: MainWindow.pageZoomDefaultsKey)
        if let away = pageZoomAway {
            UserDefaults.standard.set(Double(away), forKey: MainWindow.pageZoomAwayDefaultsKey)
        }
    }

    /// Set the zoom factor, clamped, and have the deck apply it. Returns the
    /// factor taken. Persists nothing — the View menu's `setPageZoom` does,
    /// and the app-test harness calls this directly so its zoom stays
    /// per-launch.
    ///
    /// One awaited bridge call: the deck writes its root's transform and size
    /// inside `onPageZoomApply`, waits until the new factor has painted and
    /// whatever it re-tunes in answer has landed, and resolves. `completion`
    /// runs on the main queue then — immediately when the factor did not
    /// move. The stored factor moves at once, so the menu validator and a
    /// second chord read the target, never the factor being left.
    @discardableResult
    func applyPageZoom(_ zoom: CGFloat, completion: (() -> Void)? = nil) -> CGFloat {
        let clamped = max(MainWindow.minPageZoom, min(MainWindow.maxPageZoom, zoom))
        if abs(clamped - zoomFactor) < 0.0001 {
            completion?()
            return zoomFactor
        }
        zoomFactor = clamped
        hostChannel.call(.pageZoomApply(factor: Double(clamped)), in: webView) { _ in
            completion?()
        }
        return clamped
    }

    /// Tell the deck the standing factor, with no transition. Sent on every
    /// `frontendReady` ahead of the reveal — the same in-order IPC carries it
    /// before the view is unhidden — so a deck that loads or reloads at a
    /// persisted zoom is never seen at 100 %.
    func bridgePageZoom() {
        hostChannel.send(.pageZoom(PageZoom(factor: Double(zoomFactor))), to: webView)
    }

    /// Reset to 100%.
    func actualSize() {
        setPageZoom(MainWindow.defaultPageZoom)
    }

    /// Step up to the next level, stopping at `maxPageZoom`.
    func zoomIn() {
        let current = currentPageZoom
        guard let next = MainWindow.pageZoomLevels.first(where: { $0 > current + MainWindow.pageZoomEpsilon }) else { return }
        setPageZoom(next)
    }

    /// Step down to the previous level, stopping at `minPageZoom`.
    func zoomOut() {
        let current = currentPageZoom
        guard let next = MainWindow.pageZoomLevels.last(where: { $0 < current - MainWindow.pageZoomEpsilon }) else { return }
        setPageZoom(next)
    }

    /// Whether Toggle Actual Size has somewhere to go: away from 100 %, or
    /// back to a level the user chose before.
    var canToggleActualSize: Bool {
        return abs(currentPageZoom - MainWindow.defaultPageZoom) > MainWindow.pageZoomEpsilon
            || pageZoomAway != nil
    }

    /// ⌥⌘0: to 100 % from any other level, and from 100 % back to the last
    /// other level chosen. One chord for "let me see it at actual size" and
    /// "put it back".
    func toggleActualSize() {
        if abs(currentPageZoom - MainWindow.defaultPageZoom) > MainWindow.pageZoomEpsilon {
            setPageZoom(MainWindow.defaultPageZoom)
        } else if let away = pageZoomAway {
            setPageZoom(away)
        }
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
            zoom: (function(){ var d = document.getElementById('deck-container'); return d && d.offsetWidth > 0 ? d.getBoundingClientRect().width / d.offsetWidth : 1; })(),
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
        // host-channel: diagnostic read
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
                if let cg = captureOwnWindowImage(wid) {
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
            let meta = BurstTimes(count: count, intervalMs: intervalMs, times: times)
            if let data = try? JSONEncoder().encode(meta) {
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

    /// The spike's seam into the window: the view a child page is placed in
    /// is inserted directly over the deck's view, beneath the cards and the
    /// overlay, where a body stands. DEBUG-only; the body views replace it.
    func insertAboveShell(_ view: NSView) {
        containerView.addSubview(view, positioned: .above, relativeTo: webView)
    }

    /// The view the deck's web view sits in.
    var shellContainerView: NSView { containerView }
    #endif

    /// Scheme, host and port of the page the deck loaded, which every other
    /// page the host makes is served from.
    var shellOrigin: String? {
        guard let url = webView.url ?? lastLoadedURLString.flatMap(URL.init(string:)),
              let scheme = url.scheme, let host = url.host else { return nil }
        return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    /// A point in the container's coordinates as the shell's viewport has
    /// it: top-left origin, which is every page's, the overlay's included.
    func viewportPoint(_ point: NSPoint) -> CGPoint {
        BodyGeometry.flipped(point, inHeight: containerView.bounds.height)
    }

    /// Stand `view` over the shell's and every card's, across the whole
    /// container: the overlay's place.
    func placeOverCards(_ view: NSView, above cards: NSView) {
        view.frame = containerView.bounds
        view.autoresizingMask = [.width, .height]
        containerView.addSubview(view, positioned: .above, relativeTo: cards)
    }

    /// The web view beneath the overlay a drag at a window point belongs to:
    /// the visible body a click there would reach, or the shell's.
    func dragTargetBeneathOverlay(at locationInWindow: NSPoint) -> WKWebView {
        guard let bodies else { return webView }
        let inContainer = containerView.convert(locationInWindow, from: nil)
        let viewport = BodyGeometry.flipped(inContainer, inHeight: containerView.bounds.height)
        return bodies.body(atViewportPoint: viewport)?.webView ?? webView
    }

    /// VoiceOver's order for the window: the shell's view, which holds the
    /// deck's own chrome, then each showing card in the deck's reading
    /// order, left to right and down a column, as the shell posts them, then
    /// the overlay, which holds what stands over them all.
    func setAccessibilityOrder(bodies: [WKWebView], overlay: NSView?) {
        (containerView as? DeckContainerView)?.accessibilityOrder =
            [webView as Any] + bodies.map { $0 as Any } + (overlay.map { [$0 as Any] } ?? [])
    }

    // MARK: - Bodies

    /// The one handler every page's content controller carries. The shell's
    /// configuration and every body's register every `ToHostName` with it,
    /// so a body speaks the same channel as the shell; it reads which view
    /// sent a message, refuses the shell-only names from a body, and hands
    /// the decoded message to `receive(_:from:)`.
    private(set) lazy var hostChannel = HostChannel(window: self)

    /// One page's configuration: a fresh content controller carrying every
    /// bridge handler, the WebKit feature overrides, the page-fault forwarder
    /// and, under the harness, the test-mode script. The shell's alone also
    /// carries the host's capabilities.
    ///
    /// No Web Inspector, in any build. `developerExtrasEnabled` stays off so
    /// the context menu carries no Inspect Element, and `isInspectable` is
    /// never set so Safari's Develop menu cannot attach either. The
    /// frontend's own inspector is the DevTools card (⌥⌘/).
    func makeWebViewConfiguration(forShell: Bool) -> WKWebViewConfiguration {
        let controller = WKUserContentController()
        hostChannel.register(on: controller)
        let config = WKWebViewConfiguration()
        applyWebKitFeatureOverrides(to: config.preferences)
        config.userContentController = controller
        // The page's own faults, forwarded to tugapp.log — the only
        // console this app has. See `PageFaultScript`.
        PageFaultScript.install(into: config)
        if #available(macOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        if forShell {
            HostCapabilitiesScript.install(into: config)
        }
        #if DEBUG
        // Test harness: when TUGAPP_TEST_SOCKET is set, inject
        // `window.__tugTestMode = true` at atDocumentStart so the page sees
        // the flag before its first script tag executes.
        if TestHarnessBridge.envSocketPath() != nil {
            TestHarnessUserScript.install(into: config)
        }
        #endif
        return config
    }

    /// What a body is told about the deck when it is bound, before the
    /// shell's own facts reach it over the bus.
    func bodyFacts() -> BindFacts {
        BindFacts(
            theme: (NSApp.delegate as? AppDelegate)?.menuState.activeTheme ?? "",
            zoom: Double(zoomFactor),
            keyboardAccess: NSApp.isFullKeyboardAccessEnabled,
            appActive: NSApp.isActive
        )
    }

    /// Send the shell `message`.
    func sendToShell(_ message: ToPage) {
        hostChannel.send(message, to: webView)
    }

    /// Every view that holds a page: the shell, then each body.
    var pageViews: [WKWebView] {
        [webView] + (bodies?.webViews ?? [])
    }

    /// A body is gone: whatever the host kept for its card goes with it.
    func bodyDidGoAway(cardId: String) {
        (NSApp.delegate as? AppDelegate)?.dropBodyMenuState(cardId: cardId)
    }

    /// The web view's editing NSUndoManager — the platform stack WebKit
    /// feeds when the user edits a browser-native text control. The
    /// app delegate validates Edit ▸ Undo/Redo from it (and clears it on
    /// native-control blur) while `MenuState.edit.nativeUndoToken` is
    /// non-zero. See AppDelegate's Edit-menu construction for the
    /// card-specific undo design.
    func editingUndoManager() -> UndoManager? {
        // The key body's, when the keyboard is in one: each web view keeps
        // its own native-control undo stack.
        if let responder = firstResponder as? NSView,
           let body = bodies?.bodies.first(where: { responder.isDescendant(of: $0.webView) }) {
            return body.webView.undoManager
        }
        return webView.undoManager
    }

    /// Ironclad canvas color — final fallback when no other source is available.
    /// Must match --tugx-host-canvas-color in tugdeck/styles/themes/ironclad.css.
    static let defaultBackgroundHex = "#16181d"

    /// Resolve the startup background color from the active theme's CSS file.
    /// Reads the theme name and source tree path from tugbank, then parses
    /// --tugx-host-canvas-color directly from the theme's CSS on disk.
    /// Falls back to the tugbank-cached value, then to ironclad's hardcoded color.
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

    /// The shell's page over `rect` (the shell view's points, which are
    /// viewport points) as the shell's web process next renders it:
    /// `afterScreenUpdates` makes the answer wait for a rendering update
    /// that includes every commit made before the call, so the image holds
    /// what the shell has committed — a switch's stand-ins, in its theme.
    /// Answers nil on an error or no image. The body controller's hand-over
    /// retires its faces on this answer; the web view stays private.
    func snapshotShell(rect: CGRect, completion: @escaping (CGImage?) -> Void) {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { image, error in
            if let error {
                TugLog.warn("bodies", "shell snapshot failed", [TugLog.field("error", error.localizedDescription)])
            }
            var proposed = CGRect(origin: .zero, size: image?.size ?? .zero)
            completion(image?.cgImage(forProposedRect: &proposed, context: nil, hints: nil))
        }
    }

    /// Capture the window's composite — the shell and every body beneath it —
    /// as one static snapshot over the container, so the user sees a frozen
    /// frame during shutdown instead of disconnect banners, theme flashes, or
    /// blank screens, in any view. Every web view stays alive underneath for
    /// its `prepareForTermination()` and `saveState()` to execute. When the
    /// window server cannot answer, the shell's own snapshot covers it as
    /// before.
    func freezeForShutdown(completion: @escaping () -> Void) {
        if let composite = containerComposite() {
            let overlay = NSImageView(frame: containerView.bounds)
            overlay.image = composite
            overlay.imageScaling = .scaleAxesIndependently
            overlay.autoresizingMask = [.width, .height]
            containerView.addSubview(overlay, positioned: .above, relativeTo: nil)
            completion()
            return
        }
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            guard let self = self else {
                completion()
                return
            }
            if let image = image {
                // Over the container, not inside the shell's view: the cards
                // stand over the shell, and would show through a snapshot
                // placed beneath them.
                let overlay = NSImageView(frame: self.containerView.bounds)
                overlay.image = image
                overlay.imageScaling = .scaleNone
                overlay.autoresizingMask = [.width, .height]
                self.containerView.addSubview(overlay, positioned: .above, relativeTo: nil)
            } else {
                // Snapshot failed — fall back to hiding the WebView.
                self.webView.isHidden = true
            }
            completion()
        }
    }

    /// Tag used to identify the reload snapshot overlay.
    private static let reloadSnapshotTag = 9999

    /// The container's region of the window as the window server composites
    /// it, bodies included — a view-level snapshot sees only its own view.
    private func containerComposite() -> NSImage? {
        guard let image = captureOwnWindowImage(CGWindowID(windowNumber)) else { return nil }
        let scale = CGFloat(image.width) / max(frame.width, 1)
        let inWindow = containerView.convert(containerView.bounds, to: nil)
        let crop = CGRect(
            x: inWindow.minX * scale,
            y: (frame.height - inWindow.maxY) * scale,
            width: inWindow.width * scale,
            height: inWindow.height * scale
        ).integral
        guard let cropped = image.cropping(to: crop) else { return nil }
        return NSImage(cgImage: cropped, size: containerView.bounds.size)
    }

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

    /// Deliver a request's reply in the view that asked (the shell when none
    /// is named), on the next main-queue turn: a trash or restore result, a
    /// thumbnail, a frame reading.
    private func reply(_ message: ToPage, in target: WKWebView? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.hostChannel.send(message, to: target ?? self.webView)
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
        HostChannel.unregister(from: contentController)
        // Every body's controller holds this window too.
        bodies?.destroyAll()
        for meter in pageFrameMeters.values { meter.stop() }
        pageFrameMeters.removeAll()
        #if DEBUG
        spikeBodyStorage?.destroy()
        #endif
        // Give the microphone back before the deck it was reporting to is
        // gone. `shutdown` emits nothing: there is nobody left to tell.
        dictationEngine?.shutdown()
        if let scrollPhaseMonitor {
            NSEvent.removeMonitor(scrollPhaseMonitor)
            self.scrollPhaseMonitor = nil
        }
        bridgeCleaned = true
    }

    deinit {
        cleanupBridge()
    }

    /// Hand the deck the current update state.
    ///
    /// Called on every transition, and again on `bridgeFrontendReady` — which
    /// is what lets the deck reload mid-download and be caught up by the next
    /// line rather than by a queue [B03]. Nothing here is an event, so a
    /// replay is indistinguishable from the transition that produced it, and
    /// a snapshot delivered twice costs nothing.
    ///
    /// Release notes are arbitrary HTML or Markdown; the channel serializes
    /// the snapshot so any text survives.
    func bridgeUpdateState(_ snapshot: UpdateSnapshot) {
        hostChannel.send(.updateState(snapshot), to: webView)
    }

    /// Push one dictation event to the deck.
    ///
    /// Unlike `bridgeUpdateState`, what crosses here is an **event** and not
    /// state, so there is nothing to replay: a deck that reloads mid-session
    /// has thrown away the claim the events were for, and the next thing it
    /// does is claim the mic again with a fresh id. Spec S03's ordering is the
    /// engine's to keep; this is only the wire.
    ///
    /// The payload carries recognised speech — arbitrary text, quotes and
    /// all — which the channel serializes.
    func bridgeDictationEvent(_ event: DictationEvent) {
        let key = event.id as NSString
        let target: WKWebView = dictationTargets.object(forKey: key) ?? webView
        switch event {
        case .ended, .refused: dictationTargets.removeObject(forKey: key)
        default: break
        }
        hostChannel.send(.dictation(event), to: target)
    }

    /// Push a trackpad scroll's phase edge to the deck.
    ///
    /// `WheelEvent` carries deltas and nothing about whether the fingers are
    /// down, so the deck's only end for a wheel gesture would otherwise be a
    /// quiet. Only the three edges the deck acts on cross: `touched` (fingers
    /// down), `lifted` (fingers up) and `momentum` (the first delta macOS
    /// sends on the hand's behalf). Every other event — the deltas between
    /// edges, and every event of a mouse wheel, whose phases are empty —
    /// sends nothing; the deltas reach the page through the DOM as always.
    /// Receiver: `tugdeck/src/lib/scroll-phase-bridge.ts`.
    private func bridgeScrollPhase(of event: NSEvent) {
        let edge: ScrollPhaseEdge
        if event.phase.contains(.began) || event.phase.contains(.mayBegin) {
            edge = .touched
        } else if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            edge = .lifted
        } else if event.momentumPhase.contains(.began) {
            edge = .momentum
        } else {
            return
        }
        // To the view under the pointer: a body the wheel is over takes its
        // own phase edges.
        let inContainer = containerView.convert(event.locationInWindow, from: nil)
        let viewport = BodyGeometry.flipped(inContainer, inHeight: containerView.bounds.height)
        let target: WKWebView = bodies?.body(atViewportPoint: viewport)?.webView ?? webView
        hostChannel.send(.scrollPhase(edge), to: target)
    }

    /// Hand the deck the host's network-path report.
    ///
    /// A **hint**, and the callback name says so nowhere near strongly enough
    /// — `NetworkPathMonitor`'s docstring carries the argument, and
    /// `network-path-store.ts` carries it again on the receiving side. The one
    /// line worth repeating here: `satisfied` is not an assurance, because
    /// captive wifi reports it while nothing gets through.
    func bridgeNetworkPath(_ report: NetworkPathReport) {
        hostChannel.send(.networkPath(report), to: webView)
    }

    /// Present the `/export` save panel ([#step-13c]) as a sheet on this
    /// window. The accessory File Format popup selects which content
    /// (markdown / JSON Lines) is written; the popup index — not the typed
    /// extension — is authoritative at write time. Calls back
    /// `onExportDone({id, result: "saved" | "canceled"})`.
    private func presentExportPanel(requestId: String, baseName: String,
                                    markdown: String, jsonl: String,
                                    replyTo target: WKWebView) {
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
            var result = ExportDone.Result.canceled
            if response == .OK, let url = panel.url {
                let content = popup.indexOfSelectedItem == 0 ? markdown : jsonl
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    result = .saved
                } catch {
                    NSLog("MainWindow: export write failed: %@", error.localizedDescription)
                }
            }
            self.hostChannel.send(.exportDone(ExportDone(id: requestId, result: result)), to: target)
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

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A body's load is the body's business; the launch's lap and the
        // page-loaded callback are the shell's alone.
        guard webView === self.webView else {
            let isOverlay = bodies?.overlayView.map { $0 === webView } ?? false
            TugLog.info("bodies", "page loaded", [
                TugLog.field("card", isOverlay ? "overlay" : bodies?.body(for: webView)?.cardId ?? "spare"),
            ])
            return
        }
        NSLog("MainWindow: didFinish navigation at %@", Date() as CVarArg)
        if let path = webView.url?.path, !path.isEmpty, path != "/auth" {
            interfaceAuthenticated = true
        }
        // The lap between `loadURL` and `frontendReady`: with this line a
        // stall at "waiting for the interface" says whether the page ever
        // finished loading, which is the half of the question `didFail`
        // cannot answer.
        TugLog.info("launch", "page loaded", [
            TugLog.field(
                "ms",
                String(
                    format: "%.1f",
                    (CFAbsoluteTimeGetCurrent() - AppDelegate.launchStartedAt) * 1000
                )
            ),
            TugLog.field("url", webView.url?.absoluteString ?? ""),
        ])
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
        // The cards and the overlay fade in with the shell over the splash
        // rather than covering it before.
        bodies?.shellDidReveal(fade: anim)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            // The shell, unless the deck has already given a body the
            // keyboard — a restore can hand a card to a body before this
            // fires, and the shell taking it back would strand the keys.
            if let bodies = self.bodies {
                bodies.focusKeyboardOwner()
            } else {
                self.makeFirstResponder(self.webView)
            }
            // Remove the startup spinner after the WebView is fully revealed.
            self.spinnerView?.removeFromSuperview()
            self.spinnerView = nil
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else {
            logBodyNavigationFailure(webView, error: error)
            return
        }
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
        guard webView === self.webView else {
            logBodyNavigationFailure(webView, error: error)
            return
        }
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
        // A body recovers itself; the window's own reload is the shell's.
        if bodies?.webContentProcessDidTerminate(webView) == true { return }
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
        if navigationAction.navigationType == .reload, webView === self.webView {
            decisionHandler(.cancel)
            freezeForReload { [weak self] in
                // The bodies stay, each its card's page: the reloaded shell
                // re-adopts them on the bus's hello and its restore pass.
                self?.bodies?.keepAcrossShellReload()
                guard let self else { return }
                self.hostChannel.call(.saveState, in: self.webView) { [weak self] _ in
                    if let url = self?.webView.url {
                        self?.webView.load(URLRequest(url: url))
                    }
                }
            }
            return
        }

        // A card's body reloading itself — the dev server scoped an edit to
        // the bodies — saves its card and is loaded afresh under it, rather
        // than coming back bound with the intent it was first made for.
        if navigationAction.navigationType == .reload, webView !== self.webView,
           bodies?.reloadForEdit(webView) == true {
            decisionHandler(.cancel)
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

    /// A body's navigation failed. Logged; its ready deadline decides what
    /// becomes of it, so a body that never loads still fails toward the
    /// shell rather than leaving a hole.
    private func logBodyNavigationFailure(_ webView: WKWebView, error: Error) {
        TugLog.error("bodies", "navigation failed", [
            TugLog.field("card", bodies?.body(for: webView)?.cardId ?? "spare"),
            TugLog.field("error", error.localizedDescription),
        ])
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

// MARK: - Host messages

extension MainWindow {
    /// The page `view` is — the shell, or a live body — or nil for a view
    /// already torn down.
    func hostSender(for view: WKWebView?) -> HostSender? {
        if view === webView { return .shell(webView) }
        if let overlay = bodies?.overlayView, view === overlay { return .overlay(overlay) }
        return bodies?.body(for: view).map { .body($0) }
    }

    /// One message a page posted, decoded by `HostChannel`, from `sender`.
    func receive(_ message: ToHost, from sender: HostSender) {
        let fromBody = sender.body
        let replyView = sender.replyView
        switch message {
        case .sourceTree:
            // The delegate persists the choice and re-sends dev mode; the
            // page reads the tree through `getSettings`, as it does after
            // Maker ▸ Source Tree…, so nothing is sent back.
            bridgeDelegate?.bridgeChooseSourceTree { _ in }
        case .choosePath(let request):
            // TugFileChooser "Browse…" picker. The web layer sends a request
            // id, an optional starting path, and a `kind` (directory, file,
            // save, insert); we open the panel and call back
            // window.__tugBridge.onPathChosen({id, path|null}). The id lets
            // concurrent pickers resolve independently.
            bridgeDelegate?.bridgeChoosePath(
                kind: request.kind.rawValue, initialPath: request.initialPath, suggestedName: request.suggestedName
            ) { [weak self] path in
                guard let self = self else { return }
                self.hostChannel.send(.pathChosen(PathChosen(id: request.id, path: path)), to: replyView)
            }
        case .getSettings:
            bridgeDelegate?.bridgeGetSettings { [weak self] makerMode, sourceTree in
                guard let self = self else { return }
                self.hostChannel.send(.settingsLoaded(SettingsLoaded(makerMode: makerMode, sourceTree: sourceTree)), to: replyView)
            }
        case .lookUpInDictionary(let lookup):
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
            // The point comes in as it is. A WKWebView's coordinate system is
            // Y-down from the top-left — the same space the viewport rect was
            // measured in, with View › Zoom's transform already applied. Only
            // the font size is scaled: it is the computed style, in layout px,
            // and the callout is redrawn over glyphs drawn at the zoom factor.
            guard !lookup.text.isEmpty else { return }
            let anchor = NSPoint(x: lookup.x, y: lookup.y)
            let font = MainWindow.definitionFont(
                families: lookup.fontFamily,
                size: lookup.fontSize * Double(zoomFactor),
                bold: lookup.bold,
                italic: lookup.italic
            )
            let defined = NSAttributedString(string: lookup.text, attributes: [.font: font])
            replyView.showDefinition(for: defined, at: anchor)
        case .openPath(let open):
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
            //
            // Any existing path may open — the user clicked it — but a file
            // is only created in the user's own space (`BridgePathGuard`);
            // Claude Code's memory files under `~/.claude/` are why the root
            // is not narrower.
            let rawPath = open.path
            guard !rawPath.isEmpty else { return }
            let url: URL
            switch BridgePathGuard.user.forOpening(rawPath) {
            case .success(let resolved): url = resolved
            case .failure(let refusal):
                TugLog.warn("bridge", "openPath refused", [TugLog.field("reason", refusal.reason)])
                return
            }
            let expanded = url.path
            let fm = FileManager.default
            switch open.kind {
            case .reveal:
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
            case .folder:
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
            case .file:
                if !fm.fileExists(atPath: expanded) {
                    if case .failure(let refusal) = BridgePathGuard.user.forCreating(rawPath) {
                        TugLog.warn("bridge", "openPath refused", [TugLog.field("reason", refusal.reason)])
                        return
                    }
                    try? fm.createDirectory(at: url.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
                    fm.createFile(atPath: expanded, contents: nil)
                }
                NSWorkspace.shared.open(url)
            }
        case .trashPath(let request):
            // Move an attachment to the macOS Trash. `NSWorkspace.recycle`
            // reports the destination URL, and that URL is the entire restore
            // mechanism — `restorePath` moves the file back from it, so undo
            // never needs Finder's Put Back to be programmatically drivable.
            // Trashing rather than unlinking also means Put Back works for a
            // user who never presses Cmd-Z.
            //
            // JS-side contract: post {requestId, path} and wait for
            // `onTrashResult`. See os-trash.ts.
            //
            // Only a path in the user's own space is recycled
            // (`BridgePathGuard`); a refusal replies `ok: false` so the deck
            // settles rather than timing out.
            let requestId = request.requestId
            guard !request.path.isEmpty else { return }
            let url: URL
            switch BridgePathGuard.user.forTrashing(request.path) {
            case .success(let resolved): url = resolved
            case .failure(let refusal):
                TugLog.warn("bridge", "trashPath refused", [TugLog.field("reason", refusal.reason)])
                reply(.trashResult(.failed(requestId: requestId, error: refusal.reason)), in: replyView)
                return
            }
            NSWorkspace.shared.recycle([url]) { [weak self] newURLs, error in
                guard let self = self else { return }
                if let error = error {
                    self.reply(.trashResult(.failed(requestId: requestId, error: error.localizedDescription)), in: replyView)
                    return
                }
                guard let trashed = newURLs[url] else {
                    self.reply(.trashResult(.failed(requestId: requestId, error: "no trashed URL reported")), in: replyView)
                    return
                }
                self.reply(.trashResult(.trashed(requestId: requestId, trashedPath: trashed.path)), in: replyView)
            }
        case .restorePath(let request):
            // The symmetric half of `trashPath`, and it has to live here: the
            // fs route family has no move verb, and /api/fs/write is a text
            // writer that would corrupt binary bytes. The host already holds
            // the trashed URL it minted, so the restore is one moveItem.
            // The source must be in the user's Trash and the destination in
            // the user's own space (`BridgePathGuard`).
            let requestId = request.requestId
            guard !request.trashedPath.isEmpty, !request.destination.isEmpty else { return }
            let from: URL
            let wanted: URL
            switch BridgePathGuard.user.forRestoring(trashed: request.trashedPath, destination: request.destination) {
            case .success(let pair): (from, wanted) = (pair.from, pair.to)
            case .failure(let refusal):
                TugLog.warn("bridge", "restorePath refused", [TugLog.field("reason", refusal.reason)])
                reply(.trashResult(.failed(requestId: requestId, error: refusal.reason)), in: replyView)
                return
            }
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: wanted.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                // Something may have taken the name back while the file sat in
                // the Trash. Suffix rather than overwrite, and report where it
                // actually landed so the deck can rewrite the re-inserted link.
                let target = Self.unoccupiedURL(for: wanted, fileManager: fm)
                try fm.moveItem(at: from, to: target)
                reply(.trashResult(.restored(requestId: requestId, restoredPath: target.path)), in: replyView)
            } catch {
                reply(.trashResult(.failed(requestId: requestId, error: error.localizedDescription)), in: replyView)
            }
        case .thumbnailPath(let asked):
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
            // `onThumbnail`. A file with no thumbnail at all replies with a
            // null dataUrl rather than staying silent, so the caller settles
            // instead of timing out.
            guard !asked.path.isEmpty else { return }
            let points = asked.size
            let url = URL(fileURLWithPath: (asked.path as NSString).expandingTildeInPath)
            let scale = replyView.window?.backingScaleFactor ?? 2
            let request = QLThumbnailGenerator.Request(
                fileAt: url,
                size: CGSize(width: points, height: points),
                scale: scale,
                representationTypes: .all)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) {
                [weak self] representation, _ in
                guard let self = self else { return }
                let dataUrl = representation.flatMap { Self.pngDataURL(for: $0.cgImage) }
                self.reply(.thumbnail(Thumbnail(requestId: asked.requestId, dataUrl: dataUrl)), in: replyView)
            }
        case .updateAction(let action):
            // The deck's one way to answer the update flow — the pill's and
            // the popover's controls all arrive here [B03]. The host maps the
            // name onto whichever Sparkle reply closure the current state
            // holds, and ignores one the state has no closure for, so a stale
            // click from a deck that reloaded mid-flow does nothing rather
            // than replying twice.
            if let appDelegate = NSApp.delegate as? AppDelegate {
                appDelegate.performUpdateAction(action)
            }

        case .dictation(let request):
            // Spec S01: `{ id, verb }`, and the engine owns everything after
            // that — which session is live, whether a second start supersedes
            // the first, and every refusal the machine can hand back. The host
            // is where "one composer holds the mic" is enforced, so a deck
            // that lost track cannot leave two taps on the input node.
            // The events of a claim go back to the page that made it.
            if request.verb == .start { dictationTargets.setObject(replyView, forKey: request.id as NSString) }
            dictationEngine.handle(verb: request.verb, id: request.id)

        case .exportSession(let export):
            // `/export` ([#step-13c]) — save the session transcript to a
            // user-chosen file. The web layer builds BOTH renderings
            // (markdown + JSON Lines) and sends them with a default base
            // name; the host runs an NSSavePanel whose File Format popup
            // chooses which content is written. Sibling of `openPath` (the
            // host owns the panel + file write; the content is the web
            // layer's). Calls back `onExportDone(id, "saved" | "canceled")`.
            presentExportPanel(requestId: export.id, baseName: export.baseName,
                               markdown: export.markdown, jsonl: export.jsonl, replyTo: replyView)
        case .frontendReady:
            // A body's ready is its own: it has painted its card. The
            // launch's reveal and lifecycle replay are the shell's.
            if let fromBody {
                bodies.didBecomeReady(fromBody)
                return
            }
            #if DEBUG
            if LaunchStall.forced == .frontend, !suppressedFirstFrontendReady {
                suppressedFirstFrontendReady = true
                NSLog("MainWindow: TUG_FORCE_LAUNCH_STALL=frontend — ignoring the first frontendReady")
                return
            }
            #endif
            bridgePageZoom()
            revealWebView()
            bridgeDelegate?.bridgeFrontendReady()
            // The spare is made a beat after the shell has painted, so the
            // first card the user opens can bind a body already warm.
            bodies.scheduleSpare()
        case .pageFault(let fault):
            PageFaultScript.log(fault)
        case .frontendLaunchStalled(let stalled):
            // The deck bounded its own boot awaits and one of them ran past
            // its horizon. It has not given up — the await is still running
            // — so this only names the wait, which is more than the splash
            // could say on its own.
            TugLog.warn("launch", "frontend boot await ran past its horizon", [
                TugLog.field("waiting_on", stalled.waitingOn),
            ])
            mountLaunchFailure(
                stage: "\(LaunchStage.waitingForInterface.rawValue): \(stalled.waitingOn)",
                reason: "The interface loaded but has not finished starting up."
            )
        case .launchLap(let lap):
            // The deck's own boot, step by step, on the page's clock: a
            // launch that stalls is read as the last lap that arrived.
            var fields = [
                TugLog.field("name", lap.name),
                TugLog.field("ms", String(format: "%.1f", lap.ms)),
            ]
            if let detail = lap.detail { fields.append(TugLog.field("detail", detail)) }
            TugLog.info("launch", "deck lap", fields)
        case .setTheme(let theme):
            bridgeDelegate?.bridgeSetTheme(color: theme.color)
        case .pageZoom(let zoom):
            // The Layout card's Zoom row: a level, chosen directly. The same
            // path as the View menu's, so it persists and is remembered for
            // Toggle Actual Size exactly as a chord would be.
            setPageZoom(CGFloat(zoom.factor))
        case .clipboardRead(let request):
            // Native clipboard bridge. Read NSPasteboard directly and call
            // back to JavaScript with the contents. This exists because
            // Safari's JavaScript Clipboard API (navigator.clipboard.readText /
            // .read) triggers a floating "Paste" permission popup on every
            // invocation, and in Safari 16.4+ document.execCommand("paste")
            // on contentEditable triggers the same popup. Reading via
            // NSPasteboard on the native side is the only way to supply
            // clipboard data to JavaScript without the popup.
            //
            // JS-side contract: post {requestId} and wait for
            // `onClipboardRead` with {requestId, text, html, atoms}. See
            // tug-native-clipboard.ts.
            //
            // `atoms` carries the Tug-private atom sidecar JSON when the
            // clipboard was last written by a Tug copy (via clipboardWrite),
            // empty otherwise. This is the robust Tug-to-Tug channel — it
            // bypasses WebKit's HTML sanitizer and custom-MIME repacking
            // entirely.
            let pasteboard = NSPasteboard.general
            // The text may carry quotes, backslashes, control characters and
            // line separators; the channel serializes it so all of them
            // survive.
            let contents = ClipboardContents(
                requestId: request.requestId,
                text: pasteboard.string(forType: .string) ?? "",
                html: pasteboard.string(forType: .html) ?? "",
                atoms: pasteboard.string(forType: tugAtomsPasteboardType) ?? ""
            )
            hostChannel.send(.clipboardRead(contents), to: replyView)
        case .clipboardWrite(let write):
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
            let (text, atoms, html) = (write.text, write.atoms, write.html)
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
        case .clipboardWriteImage(let write):
            // Native image-clipboard bridge. The WKWebView's JS Clipboard
            // image write (navigator.clipboard.write + ClipboardItem) is
            // unreliable in this app — the same reason clipboardRead is
            // bridged. Writing image bytes to NSPasteboard natively is the
            // dependable path. Fire-and-forget: the web layer posts the
            // base64-encoded image bytes; the host decodes and writes an
            // NSImage to the general pasteboard so any app can paste it.
            // JS-side contract: post {base64}. See tug-native-clipboard.ts.
            guard let data = Data(base64Encoded: write.base64),
                  let image = NSImage(data: data) else {
                NSLog("MainWindow: clipboardWriteImage bytes are not an image")
                return
            }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.writeObjects([image])
        case .menuState(let post):
            // Menu-relevant state pushed from a page's host-menu-state
            // aggregator. AppDelegate keeps the shell's and each body's, and
            // merges the key card's body into the shell's.
            guard let appDelegate = NSApp.delegate as? AppDelegate else { return }
            switch (post, fromBody) {
            case (.body(let blocks), let body?):
                if let cardId = body.cardId {
                    appDelegate.updateBodyMenuState(cardId: cardId, blocks: blocks)
                }
            case (.shell(let state), nil):
                appDelegate.updateMenuState(state)
            case (.shell, _?), (.body, nil):
                // The shell posts its whole state and a body its card's
                // blocks; either out of place says the page is not the page
                // it claims to be.
                TugLog.warn("menu", "menuState from the wrong page; ignoring", [
                    TugLog.field("from", fromBody == nil ? "shell" : "body"),
                ])
            }
        case .hmrUpdate(let update):
            // How long an incremental update took to land in each page,
            // from Vite's own stamp for it: on a deck of a dozen pages an
            // edit lands a dozen times, and this is its number.
            let sinceVite = Date().timeIntervalSince1970 * 1000 - update.viteAt
            TugLog.info("hmr", "update landed", [
                TugLog.field("page", sender.pageName),
                TugLog.field("since_vite_ms", String(format: "%.0f", sinceVite)),
                TugLog.field("modules", String(update.modules)),
            ])
            // The dev-info overlay's load time is the shell's.
            if sender.isShell { bridgeDelegate?.bridgeHmrUpdate() }
        case .hostFrames(let request):
            // `window.__tugMotion.hostFrames(windowMs)`: the window's frames
            // over the next `windowMs`, read by the host's display link, so a
            // page can ask what was shown while it was itself busy. Each
            // request gets its own meter; the reply goes to
            // `__tugBridge.onHostFrames` when its window closes.
            let requestId = request.requestId
            // Held to a minute: past any reading a page asks for, and inside
            // what `Int` can hold, which a page's number need not be.
            let windowMs = Int(min(max(request.windowMs, 0), 60_000))
            let meter = HostFrameMeter(view: containerView)
            pageFrameMeters[requestId] = meter
            meter.arm(windowMs: windowMs)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(windowMs + 50)) { [weak self] in
                guard let self, let meter = self.pageFrameMeters.removeValue(forKey: requestId) else { return }
                self.reply(.hostFrames(HostFramesReply(requestId: requestId, reading: meter.read())))
            }
        case .bodyHello:
            // A body's page is connected; it waits to be told its card.
            if let fromBody { bodies.didSayHello(fromBody) }
        case .painted:
            // A body's first frame of real content has gone to the
            // compositor: it may be shown. The shell never posts this.
            if let fromBody { bodies.didPaint(fromBody) }
        case .bodyCreate(let create):
            // The shell always names the kind: a body is bound to mount it.
            guard !create.componentId.isEmpty else {
                TugLog.error("bodies", "bodyCreate named no componentId; refusing", [
                    TugLog.field("card", create.cardId),
                ])
                return
            }
            bodies.create(cardId: create.cardId, componentId: create.componentId, intent: create.intent)
        case .placeCards(let placement):
            // The shell's placement of every card's view.
            bodies.placeCards(placement)
        case .cardGesture(let begin):
            // A card's page has taken a title-bar or grip press for the host
            // to carry. The shell never posts this.
            guard let fromBody else { return }
            bodies.claimGesture(from: fromBody, begin: begin)
        case .bodyDestroy(let destroy):
            bodies.destroy(cardId: destroy.cardId, save: destroy.save)
        case .bodyEvictAfter(let evictAfter):
            bodies.setEvictAfter(ms: evictAfter.ms)
        case .bodyFocus(let focus):
            bodies.focus(cardId: focus.cardId)
        case .overlayCreate:
            bodies.createOverlay()
        case .overlayClaim(let claim):
            bodies.overlayClaimed(claim)
        case .cardPlan(let plan):
            bodies.runPlan(plan)
        case .crossingReady(let ready):
            // A body has pinned its scrollers for its crossing: its page
            // may take its final size. The shell never posts this.
            if let fromBody { bodies.crossingReady(fromBody, surface: ready.surface) }
        case .bodySurface(let surface):
            // A body's page background, for its container to wear behind
            // the web view. The shell never posts this.
            if let fromBody { bodies.setSurface(fromBody, surface: surface.surface) }
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

/// A frame burst's `times.json`: how many frames, at what interval, and the
/// absolute time each capture began.
struct BurstTimes: Encodable {
    var count: Int
    var intervalMs: Int
    var times: [Double]
}

/// One composited image of a window this process owns, as the window server
/// painted it. `CGWindowListCreateImage` is deprecated in favor of
/// ScreenCaptureKit, but ScreenCaptureKit needs a Screen Recording grant even
/// for the caller's own window, and this call does not — which is the whole
/// reason the frame-burst diagnostic and the harness capture can run on a
/// user's machine unprompted. The symbol is resolved at run time so the
/// deprecation does not fail a warnings-clean build; nil if it is ever gone.
func captureOwnWindowImage(_ windowID: CGWindowID) -> CGImage? {
    typealias CreateImage = @convention(c) (
        CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption
    ) -> Unmanaged<CGImage>?
    let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
    guard let symbol = dlsym(rtldDefault, "CGWindowListCreateImage") else { return nil }
    let create = unsafeBitCast(symbol, to: CreateImage.self)
    return create(
        .null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming, .bestResolution]
    )?.takeRetainedValue()
}
