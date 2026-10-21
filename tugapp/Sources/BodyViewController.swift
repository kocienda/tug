import AppKit
import QuartzCore
import WebKit

/// The view every body container lives in: flipped, so a container's frame is
/// the top-left viewport rect the shell measured, filling the window's
/// container over the shell's web view and beneath the overlay's.
///
/// Held at opacity zero until the window reveals the shell, then faded in on
/// the reveal's own clock: a card shown before the reveal would stand over
/// the splash. Opacity, never `isHidden`, so every body keeps painting.
final class BodyHostView: NSView {
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.opacity = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// Put the containers in their `order`, in place, and only when the
    /// order has changed. `sortSubviews` moves nothing out of the hierarchy,
    /// so a body web view that is the window's first responder stays it —
    /// `addSubview(_:positioned:relativeTo:)` on a view already present
    /// removes it first, and a removal resigns the first responder inside it
    /// to the window. And a sort that changes nothing is skipped outright:
    /// re-ordering layer-backed subviews re-parents their layers, which ends
    /// any animation running on them, and every placement used to pay that
    /// whether or not a pane had moved in front of another.
    func sortContainers() {
        let current = subviews.compactMap { $0 as? BodyContainerView }
        let sorted = current.sorted { a, b in
            a.order != b.order ? a.order < b.order : a.serial < b.serial
        }
        if current.elementsEqual(sorted, by: ===) { return }
        sortSubviews({ a, b, _ in
            let za = (a as? BodyContainerView)?.order ?? 0
            let zb = (b as? BodyContainerView)?.order ?? 0
            if za != zb { return za < zb ? .orderedAscending : .orderedDescending }
            let ia = (a as? BodyContainerView)?.serial ?? 0
            let ib = (b as? BodyContainerView)?.serial ?? 0
            return ia < ib ? .orderedAscending : ia > ib ? .orderedDescending : .orderedSame
        }, context: nil)
    }

    /// The container a point in this view's coordinates — the viewport's —
    /// belongs to, by the cards' hit shapes front to back, or nil when no
    /// card claims it.
    var containerAt: ((NSPoint) -> NSView?)?

    /// Never a hit of its own, and never a container's but by the cards' hit
    /// shapes: the shell's view lies beneath, so a point no card claims —
    /// between cards, on a card's bare apron, on a seam the shell keeps over
    /// a card, or under a claim the shell has posted — answers nil and
    /// AppKit carries it on to the shell. A whole card's view reaches past
    /// its pane by the apron, and two cards a gap apart overlap there, so
    /// which card a point is is its hit shape's answer (`CardHitShape`), not
    /// the frames': the band past a pane's edge is that card's only where it
    /// offers a grip, and a press on a card's grip is never taken by the
    /// bare apron of the card beside it.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let containerAt, let container = containerAt(convert(point, from: superview)) else { return nil }
        return container.hitTest(convert(point, from: superview))
    }
}

/// The window's content view, which holds the shell's web view, the cards
/// over it and the overlay over them. Its accessibility children are the
/// order VoiceOver reads the window in: subview order would put the cards
/// in stacking order. `accessibilityOrder` replaces that with the shell's
/// view, then each showing card in the shell's pane order, then the
/// overlay; nil leaves AppKit's own answer, as on a host that makes no
/// bodies.
final class DeckContainerView: NSView {
    var accessibilityOrder: [Any]? {
        didSet { NSAccessibility.post(element: self, notification: .layoutChanged) }
    }

    override func accessibilityChildren() -> [Any]? {
        accessibilityOrder ?? super.accessibilityChildren()
    }
}

/// A body's container: layer-backed and clipped to its bounds, carrying its
/// stacking order and its creation serial for `BodyHostView.sortContainers`.
///
/// Flipped, so the web view's top-left is its origin: while a crossing
/// animates the container's bounds, the page stays pinned at the top and
/// the container clips its bottom edge, never its masthead edge.
final class BodyContainerView: NSView {
    var order = 0
    let serial: Int
    override var isFlipped: Bool { true }
    /// The page's surface the container wears behind its web view, or nil
    /// before the page has said it. The web view draws no background of its
    /// own, so a remainder of the view the page's layout viewport does not
    /// reach reads this colour, never WebKit's white, and through a crossing
    /// a box larger than the page reads it too.
    /// A layer-backed view's layer is AppKit's to draw, so the colour goes
    /// on in `updateLayer` rather than straight onto the layer.
    var surface: CGColor? {
        didSet { needsDisplay = true }
    }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.backgroundColor = surface
    }
    /// Set while the container shows nothing but stays in the tree — a
    /// sibling behind its pane's active card, or a body not yet shown, each
    /// at opacity zero. Such a view stands where a showing one does, so a
    /// point there must reach the card that is seen, never the one that is not.
    var passesPointer = false
    override func hitTest(_ point: NSPoint) -> NSView? {
        passesPointer ? nil : super.hitTest(point)
    }
    init(serial: Int) {
        self.serial = serial
        super.init(frame: .zero)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
}

/// The last frame of an evicted card, stood over the body made to bring it
/// back until that body has painted: the card shows as it last stood, never
/// the floor through a pane whose page is still loading. Draws the image and
/// answers no point, so a press reaches the page beneath it.
final class BodyCoverView: NSView {
    init(image: CGImage, frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.contents = image
        layer?.contentsGravity = .resize
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Calls back when a body's position track stops: `finished` when it ran to
/// its end, not when a placement or a newer plan removed it.
final class BeatTrackDelegate: NSObject, CAAnimationDelegate {
    private let onStop: (Bool) -> Void
    init(onStop: @escaping (Bool) -> Void) {
        self.onStop = onStop
    }
    func animationDidStop(_ anim: CAAnimation, finished flag: Bool) {
        onStop(flag)
    }
}

/// Every body: a card's content in a WKWebView of its own, in its own
/// WebContent process, placed by the host over the shell's page.
///
/// A body's life (`loading → connected → bound → ready → painted → visible /
/// hidden → destroyed`, with `failed` from any state before ready at the
/// deadline and on a second WebContent termination within ten seconds) is
/// kept here, and the shell hears of every transition that matters to it
/// through `window.__tugBridge.onBodyState`. The shell decides what each body
/// is for (`bodyCreate`) and where it stands (`placeCards`); this object
/// makes the views, binds them, places them, shows them, and tears them down.
/// Its message handlers are `MainWindow`'s, which routes a message by the
/// view that sent it.
///
/// **A card shows once it has painted.** The cards stand over the shell's
/// page, which paints the canvas and its grid beneath them, so the host
/// shows a placed card the moment its page says `painted` — its first chrome
/// frame has gone to the compositor — and never before: `ready` alone is the
/// card mounted and quiet, and a container shown on `ready` can be
/// composited empty.
///
/// **A card moves with its stand-in.** A settle that moves a card's stand-in
/// posts a `cardPlan`, and `runPlan` carries the whole container through each
/// beat as Core Animation on the chrome's curve from the chrome's start: one
/// track per property per card over the whole plan, the container's model at
/// the landing. It reports `landed` when the track runs out, and
/// `beatsCancelled` when a placement that does not name the plan, or a newer
/// plan, takes it.
final class BodyViewController {
    enum State: String {
        case loading
        case connected
        case bound
        case ready
        case failed
    }

    /// One body. A spare has no card until it is bound to one.
    final class Body {
        var cardId: String?
        let webView: ClickThroughWebView
        let container: BodyContainerView
        var state: State = .loading
        /// What the body is to do once bound: the deck's `BodyIntent`.
        var intent: JSONObject?
        /// The kind of card it holds once bound: the deck's `componentId`.
        var componentId: String?
        /// When the body was bound to its card, for `readyMs`.
        var boundAt: CFTimeInterval?
        /// Whether this body began as the spare, for the ready line's
        /// `warm` / `cold`.
        var warm = false
        /// Bind → ready, once ready.
        var readyMs: Double?
        /// The body has posted `painted`: its first frame of real content
        /// has gone to the compositor. Cleared when its page is reloaded.
        var painted = false
        /// Whether the body may be shown: it has painted, and its card is
        /// bound or ready. A card that draws its own chrome paints its first
        /// chrome frame before it is ready, and shows from there, its content
        /// lidded in its own page.
        ///
        /// A body brought back from an eviction may be shown from its
        /// hand-off: its cover stands until it has painted.
        var canShow: Bool {
            if cover != nil { return state != .failed }
            return painted && (state == .ready || state == .bound)
        }
        /// The card's last frame before its eviction, over the web view until
        /// the page paints; nil for any body not brought back from one.
        var cover: BodyCoverView?
        /// The card draws its pane's chrome in its own page: its container
        /// is the pane's rect outset by the apron, wears no surface, and
        /// answers a point by the card's hit shape. Every placed card is.
        var whole = false
        /// An inactive card of a whole card's pane, placed at the pane and
        /// hidden by opacity, never `isHidden`, so it keeps painting and a
        /// tab switch shows a page that has drawn its new chrome.
        var sibling = false
        /// A whole card's pane within its view, as the last placement said
        /// it: the apron plus what the view's growth to whole points added.
        /// Handed to the page, which lays its pane out at exactly these.
        var insets: CardInsets?
        /// The frame the last placement gave it, viewport coordinates.
        var frame: CGRect = .zero
        /// The shell's own controls over the card from the last placement
        /// (the place seams), viewport coordinates: the shell's points.
        var shellControls: [CGRect] = []
        /// The stacking order the last placement gave it: the pane's
        /// `z-index`. Containers are kept in this order, so where two panes
        /// overlap the body in front is the pane in front.
        var z: Int = 0
        /// Where the last placement listed it: the shell's document order of
        /// its pane, which is the order the shell's own cards are read in.
        var deckIndex: Int = 0
        var visible = false
        /// Whether the body has been shown once. Until it has, a hidden body
        /// is hidden by layer opacity, never `isHidden`, so WebKit keeps
        /// painting the frame the showing will reveal.
        var shownOnce = false
        /// Whether the container paints — not hidden by `isHidden`; a
        /// sibling at opacity 0 paints — and since when, wall-clock ms.
        var shown: (value: Bool, since: Double)?
        /// The `shown` its page was last told; nil until the page is bound,
        /// and again when a reload binds a new one.
        var toldShown: Bool?
        /// The time trigger's eviction, armed while the body is hidden and
        /// due `evictAfterMs` after it was hidden.
        var evictDue: DispatchWorkItem?
        /// The page's surface as it last posted it, which the container wears
        /// behind a content box, never behind a whole card.
        var surface: CGColor?
        var deadline: DispatchWorkItem?
        var lastTermination: Date?
        /// The card plan carrying the body now, until it lands or is
        /// cancelled: the plan's id, the rect it lands at, and how late the
        /// plan reached the host.
        var beats: (planId: Int, landing: CGRect, lateMs: Double)?
        /// The size the plan carrying the body takes its page to, and when
        /// its first moving beat begins (media time), until the beats land or are
        /// cancelled; nil when the plan does not resize the body. The page
        /// keeps its old size until the body has pinned its scrollers and
        /// posted `crossingReady`.
        var crossing: (size: CGSize, begin: CFTimeInterval)?
        /// The last crossing's account, for the harness: its plan, its size,
        /// and how far ahead of the first beat the body was ready.
        var lastCrossing: CrossingAccount?
        /// How the container's frame maps to its layer's geometry, solved at
        /// the body's last plan; nil before one.
        var mapping: LayerMapping?
        /// The body's page is writing its card's state on the way to an
        /// eviction, which no second eviction may start over.
        var evicting = false

        init(cardId: String?, webView: ClickThroughWebView, container: BodyContainerView) {
            self.cardId = cardId
            self.webView = webView
            self.container = container
        }
    }

    /// How long a body has to report ready after it is asked for, unless
    /// the harness shortens it (`BodyGeometry.readyDeadlineMs`).
    static let readyDeadlineMs = BodyGeometry.readyDeadlineMs(
        environment: ProcessInfo.processInfo.environment,
        fallback: 10_000
    )
    /// How long after the shell's launch, and after each bound body's ready,
    /// the spare is made: late enough to stay out of the way of the page
    /// that just painted.
    static let spareDelay: DispatchTimeInterval = .seconds(1)
    /// A second WebContent termination inside this window fails the body.
    static let terminationWindow: TimeInterval = 10

    private unowned let window: MainWindow
    let hostView: BodyHostView
    /// When the window began revealing the shell over the splash, or nil
    /// before it has: until then the overlay is held transparent, or it
    /// would stand over the splash.
    private var revealedAt: CFTimeInterval?
    private(set) var bodies: [Body] = [] {
        // The host state probe reports the count off the main thread.
        didSet { HostRunLoopWatch.shared.noteBodyCount(bodies.count) }
    }
    private(set) var region = CardHitRegion()
    /// The spare's pending creation, so a burst of readies makes one.
    private var pendingSpare: DispatchWorkItem?
    /// Creation order, for a stable stacking among bodies at one z.
    private var serials = 0
    #if DEBUG
    /// `TUG_BODY_FORCE_STALL=<n>` suppresses the first `n` bodies'
    /// `frontendReady`, so a test can watch the deadline fail them — once
    /// for the shell's own retry, twice for the card's placard. DEBUG-only.
    private var readiesToStall = Int(ProcessInfo.processInfo.environment["TUG_BODY_FORCE_STALL"] ?? "") ?? 0
    #endif

    /// How short of memory the machine says it is.
    enum PressureLevel: String {
        case normal
        case warning
        case critical
    }
    /// The level the host last heard, and when, wall-clock ms: from the
    /// dispatch source, or from the harness standing in for it.
    private(set) var pressure: (level: PressureLevel, at: Double) = (.normal, 0)
    private let pressureSource = DispatchSource.makeMemoryPressureSource(
        eventMask: [.normal, .warning, .critical], queue: .main
    )
    /// The warning's next eviction, a beat after the last one's process
    /// went: a level change cancels it.
    private var pendingWarningStep: DispatchWorkItem?
    /// Bodies this pressure episode could not evict — shown while saving,
    /// or a save that did not answer — which it does not ask again.
    private var declined: Set<ObjectIdentifier> = []
    /// The last frame of each card evicted and not yet asked for again, taken
    /// as its process went: the cover its next body stands under.
    private var covers: [String: CGImage] = [:]
    /// How long a body may stay hidden before it gives up its process, ms:
    /// the reader's `evictAfterMs`, which the shell tells the host. Nil until
    /// it has, and no body is evicted by time before then.
    private(set) var evictAfterMs: Double?
    /// How long a warning waits after one eviction before it takes the next:
    /// time for the process the last one gave up to be gone, and for the
    /// level to say whether that was enough.
    static let warningStepDelay: DispatchTimeInterval = .seconds(1)

    init(window: MainWindow, hostView: BodyHostView) {
        self.window = window
        self.hostView = hostView
        hostView.containerAt = { [weak self] point in
            self?.body(atViewportPoint: CGPoint(x: point.x, y: point.y))?.container
        }
        pressureSource.setEventHandler { [weak self] in
            guard let self else { return }
            let event = self.pressureSource.data
            self.memoryPressure(
                event.contains(.critical) ? .critical : event.contains(.warning) ? .warning : .normal
            )
        }
        pressureSource.activate()
    }

    deinit {
        pressureSource.cancel()
    }

    // MARK: - Lookup

    func body(for webView: WKWebView?) -> Body? {
        guard let webView else { return nil }
        return bodies.first { $0.webView === webView }
    }

    func body(forCard cardId: String) -> Body? {
        bodies.first { $0.cardId == cardId }
    }

    var spare: Body? {
        bodies.first { $0.cardId == nil && $0.state != .failed }
    }

    var webViews: [WKWebView] { bodies.map(\.webView) }

    /// The web view of the card's body, whatever its state — what the
    /// harness evaluates and clicks in when a verb names a card.
    func view(for cardId: String) -> WKWebView? {
        if cardId == Self.overlayCardId { return overlayView }
        return body(forCard: cardId)?.webView
    }

    // MARK: - The overlay

    /// The card id the overlay page answers to — on the bus, and to the
    /// harness's `card` — which no card of the deck ever takes
    /// (`tugdeck/src/lib/overlay-card.ts`).
    static let overlayCardId = "deck-overlay"

    /// The overlay's view: above the shell and every card, transparent, and
    /// passing every point outside its claim to the view beneath ([B07]).
    private(set) var overlayView: ClickThroughWebView?
    /// Where the overlay takes the pointer, as it last posted (`overlayClaim`).
    private var overlayClaim: CardHitRegion.Claim = .none
    /// What had the keyboard when a modal in the overlay took it, to give it back to.
    private weak var keysBeforeOverlay: NSResponder?

    /// `overlayCreate`: make the overlay's view and load its page. Idempotent.
    ///
    /// It draws no background, and until the window reveals the shell its
    /// layer is transparent: a hidden view is a hidden page to WebKit, which
    /// would stop painting it, so it is held by opacity as a body is. It
    /// stands over every card, so every drag into the window reaches it, and
    /// it hands each one on to the view a click there would reach.
    func createOverlay() {
        guard overlayView == nil else { return }
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?overlay=\(Self.overlayCardId)") else {
            TugLog.error("bodies", "no shell origin to load the overlay from", [])
            return
        }
        let config = window.makeWebViewConfiguration(forShell: false)
        let view = ClickThroughWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = window
        view.uiDelegate = window
        view.allowsBackForwardNavigationGestures = false
        view.passesThrough = { [weak self] point in
            guard let self else { return true }
            return !self.overlayClaims(self.window.viewportPoint(point))
        }
        view.dragTarget = { [weak self] locationInWindow in
            guard let self, let container = self.hostView.superview else { return nil }
            let point = container.convert(locationInWindow, from: nil)
            if self.overlayClaims(self.window.viewportPoint(point)) { return nil }
            return self.window.dragTargetBeneathOverlay(at: locationInWindow)
        }
        view.wantsLayer = true
        if revealedAt == nil { view.layer?.opacity = 0 }
        window.placeOverCards(view, above: hostView)
        overlayView = view
        refreshAccessibilityOrder(force: true)
        view.load(URLRequest(url: url))
    }

    /// Whether the overlay takes the pointer at a viewport point.
    func overlayClaims(_ point: CGPoint) -> Bool {
        switch overlayClaim {
        case .all: return true
        case .rects(let rects): return rects.contains { $0.contains(point) }
        case .none: return false
        }
    }

    /// `overlayClaim`: where the overlay takes the pointer now. A claim of
    /// the whole window is a modal standing, and the modal takes the
    /// keyboard for its span; when it goes, the keyboard goes back to what
    /// had it, or to whoever the shell last named.
    func overlayClaimed(_ claim: CardHitRegion.Claim) {
        let wasAll = overlayClaim == .all
        overlayClaim = claim
        guard let view = overlayView else { return }
        let isAll = claim == .all
        if isAll && !wasAll {
            if window.firstResponder !== view { keysBeforeOverlay = window.firstResponder }
            window.makeFirstResponder(view)
        } else if wasAll && !isAll, window.firstResponder === view {
            if let before = keysBeforeOverlay, (before as? NSView)?.window === window {
                window.makeFirstResponder(before)
            } else {
                focus(cardId: keyboardCardId)
            }
            keysBeforeOverlay = nil
        }
    }

    /// Take the overlay's view down: its handlers off, its page stopped.
    private func removeOverlay() {
        guard let view = overlayView else { return }
        overlayView = nil
        if overlayClaim == .all, window.firstResponder === view { window.focusWebView() }
        overlayClaim = .none
        keysBeforeOverlay = nil
        HostChannel.unregister(from: view.configuration.userContentController)
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.stopLoading()
        view.removeFromSuperview()
        refreshAccessibilityOrder(force: true)
    }

    /// The overlay and the cards are shown with the shell, on the reveal's
    /// own clock.
    private func revealOverlay(fade: CAAnimation) {
        if let layer = hostView.layer, layer.opacity == 0 {
            layer.add(fade, forKey: "revealFade")
            layer.opacity = 1
        }
        guard let layer = overlayView?.layer, layer.opacity == 0 else { return }
        layer.add(fade, forKey: "revealFade")
        layer.opacity = 1
    }

    // MARK: - Create and bind

    /// The shell asks for a card's body. The waiting spare takes it when
    /// there is one; otherwise a body is made cold at `/?body=<cardId>`. A
    /// card that already has a body is re-bound only if it failed.
    func create(cardId: String, componentId: String, intent: JSONObject) {
        if let existing = body(forCard: cardId), existing.state != .failed {
            TugLog.warn("bodies", "bodyCreate for a card that has a body; ignoring", [
                TugLog.field("card", cardId),
            ])
            return
        }
        if let spare {
            spare.cardId = cardId
            spare.componentId = componentId
            spare.intent = intent
            spare.warm = true
            standCover(over: spare)
            armDeadline(spare)
            if spare.state == .connected { bind(spare) }
            return
        }
        guard let made = make(cardId: cardId, path: "/?body=\(cardId)") else { return }
        made.componentId = componentId
        made.intent = intent
        standCover(over: made)
        armDeadline(made)
    }

    /// A card brought back from an eviction stands under its last frame
    /// until its new page paints.
    private func standCover(over body: Body) {
        guard let cardId = body.cardId, let image = covers.removeValue(forKey: cardId) else { return }
        let cover = BodyCoverView(image: image, frame: body.container.bounds)
        cover.autoresizingMask = [.width, .height]
        body.container.addSubview(cover, positioned: .above, relativeTo: body.webView)
        body.cover = cover
    }

    /// Make the spare: a body loaded at `/?body=spare`, connected and waiting
    /// for the next card. The caller decides when.
    func createSpare() {
        // Critical pressure took the spare; the next arrival is cold.
        guard spare == nil, pressure.level != .critical else { return }
        _ = make(cardId: nil, path: "/?body=spare")
    }

    /// Make the spare a beat from now, if there is none by then: after the
    /// shell's launch, after a bound body's ready, and after the spare is
    /// lost.
    func scheduleSpare() {
        pendingSpare?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSpare = nil
            self?.createSpare()
        }
        pendingSpare = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.spareDelay, execute: work)
    }

    private func make(cardId: String?, path: String) -> Body? {
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + path) else {
            TugLog.error("bodies", "no shell origin to load a body from", [
                TugLog.field("card", cardId ?? "spare"),
            ])
            return nil
        }
        let config = window.makeWebViewConfiguration(forShell: false)
        let webView = ClickThroughWebView(frame: .zero, configuration: config)
        // No backing of its own: what the page does not paint is the
        // container's surface, the pane's colour, rather than white.
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = window
        webView.uiDelegate = window
        webView.allowsBackForwardNavigationGestures = false
        webView.onActivationClick = { [weak window] location in
            window?.forwardActivationClick(at: location)
        }
        webView.keyboardNamed = { [weak self, weak webView] in
            guard let self, let webView, let cardId = self.body(for: webView)?.cardId else { return false }
            return self.keyboardCardId == cardId
        }

        serials += 1
        let container = BodyContainerView(serial: serials)
        container.wantsLayer = true
        container.layer?.masksToBounds = true
        // Hidden by opacity until the first fade: a hidden view is a hidden
        // page to WebKit, which would stop painting it.
        container.layer?.opacity = 0
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        hostView.addSubview(container)

        let body = Body(cardId: cardId, webView: webView, container: container)
        bodies.append(body)
        webView.load(URLRequest(url: url))
        return body
    }

    /// A body's page is connected and ready to be told what it is for.
    func didSayHello(_ body: Body) {
        if body.state == .loading { body.state = .connected }
        if body.cardId != nil, body.intent != nil { bind(body) }
    }

    private func bind(_ body: Body) {
        guard let cardId = body.cardId, let componentId = body.componentId,
              let intent = body.intent else { return }
        body.state = .bound
        body.boundAt = CACurrentMediaTime()
        send(.bodyBind(BodyBind(cardId: cardId, componentId: componentId, intent: intent, facts: window.bodyFacts())), to: body)
        // A page bound afresh has not heard whether it is shown.
        body.toldShown = nil
        reportVisibility(body)
        // A page bound afresh — a reload, a spare taking a card — has not
        // been told where its pane stands in its view.
        if let insets = body.insets {
            send(.cardInsets(insets), to: body)
        }
    }

    /// A body posted `frontendReady`: its card is mounted and quiet. It is
    /// not shown yet — that waits for `painted`.
    func didBecomeReady(_ body: Body) {
        guard let cardId = body.cardId, body.state != .failed else { return }
        #if DEBUG
        if readiesToStall > 0 {
            readiesToStall -= 1
            NSLog("BodyViewController: TUG_BODY_FORCE_STALL — ignoring a body's frontendReady")
            return
        }
        #endif
        body.deadline?.cancel()
        body.deadline = nil
        body.state = .ready
        let readyMs = body.boundAt.map { (CACurrentMediaTime() - $0) * 1000 } ?? 0
        body.readyMs = readyMs
        TugLog.info("bodies", "ready", [
            TugLog.field("card", cardId),
            TugLog.field("ms", String(format: "%.1f", readyMs)),
            TugLog.field("start", body.warm ? "warm" : "cold"),
        ])
        notifyShell(BodyStateReport(cardId: cardId, state: .ready, readyMs: readyMs, start: body.warm ? .warm : .cold))
        // A body hidden before it was ready has had its clock running.
        armEviction(body)
        // The spare this body may have taken is replaced once it has painted.
        scheduleSpare()
    }

    /// A body posted `painted`: the frame carrying its card's content has
    /// gone to the compositor. From here a placement that names it visible
    /// shows it.
    func didPaint(_ body: Body) {
        guard let cardId = body.cardId, body.state == .ready || body.state == .bound, !body.painted else { return }
        body.painted = true
        // A body brought back from an eviction is its own page from here.
        body.cover?.removeFromSuperview()
        body.cover = nil
        TugLog.info("bodies", "painted", [TugLog.field("card", cardId)])
        notifyShell(BodyStateReport(cardId: cardId, state: .painted))
        applyVisibility(body)
    }

    // MARK: - Placement

    /// Show a painted body placed visible, at once and in full; hide
    /// anything else. Nothing here animates.
    private func applyVisibility(_ body: Body) {
        let showing = body.visible && body.canShow
        guard let layer = body.container.layer else { return }
        defer { reportVisibility(body) }
        if showing {
            let wasHidden = body.container.isHidden
            body.container.isHidden = false
            body.container.passesPointer = false
            body.shownOnce = true
            layer.opacity = 1
            // Hiding a view that held the keyboard made AppKit hand it to
            // the window, and nothing in the shell changed for it to hand
            // it back: the deck's first responder is still this card. So a
            // body the shell last named for the keyboard takes it again the
            // moment it is shown — a fold's unfold, a slide's land — unless
            // the shell has since named another owner (row 6's reading).
            if wasHidden, let cardId = body.cardId, keyboardCardId == cardId,
               window.firstResponder !== body.webView {
                window.makeFirstResponder(body.webView)
            }
        } else if body.shownOnce {
            if body.sibling {
                // A sibling behind the pane's active card: transparent, still
                // painting, never a hidden page.
                body.container.isHidden = false
                body.container.passesPointer = true
                layer.opacity = 0
                refreshRegion()
                return
            }
            // Shown before: hide it as any hidden page is, so WebKit
            // throttles a parked or folded body.
            body.container.isHidden = true
        } else {
            // Not shown yet: transparent, still painting, never a hidden
            // page. A page loaded into a hidden view runs no frame callback,
            // and `painted` is said after two of them.
            body.container.isHidden = false
            body.container.passesPointer = true
            layer.opacity = 0
        }
        refreshRegion()
    }

    /// Tell a bound body's page whether it is shown, when that has changed
    /// since it was last told. Shown is the container painting: a sibling at
    /// opacity 0 is shown, a body hidden by `isHidden` is not.
    private func reportVisibility(_ body: Body) {
        let shown = !body.container.isHidden
        if body.shown?.value != shown {
            body.shown = (shown, Date().timeIntervalSince1970 * 1000)
            armEviction(body)
        }
        guard let current = body.shown, body.state == .bound || body.state == .ready,
              body.toldShown != current.value else { return }
        body.toldShown = current.value
        send(.bodyVisibility(BodyVisibility(shown: current.value, since: current.since)), to: body)
    }

    private func refreshRegion() {
        region.visibleFrames = visibleBodies.map(\.frame)
        region.visibleGrips = visibleBodies.map(\.shellControls)
        region.visibleShapes = visibleBodies.map { body in
            guard body.whole, let cardId = body.cardId else { return nil }
            return CardHitShape(
                paneRect: body.frame.insetBy(dx: cardApron, dy: cardApron),
                apron: cardApron,
                grips: cardPlacements[cardId]?.grips ?? []
            )
        }
        refreshAccessibilityOrder()
    }

    /// The showing bodies in the order the shell posts them — the deck's
    /// reading order — which the window reads after the shell's own view.
    var bodiesInDeckOrder: [Body] {
        bodies
            .filter { $0.visible && $0.canShow }
            .sorted { $0.deckIndex < $1.deckIndex }
    }

    private var orderedAccessibility: [String] = []

    /// Hand the window its reading order, only when it changed.
    private func refreshAccessibilityOrder(force: Bool = false) {
        let ordered = bodiesInDeckOrder
        let ids = ordered.compactMap(\.cardId)
        if !force && ids == orderedAccessibility { return }
        orderedAccessibility = ids
        window.setAccessibilityOrder(bodies: ordered.map(\.webView), overlay: overlayView)
    }

    private var visibleBodies: [Body] {
        // Front to back, so a point over two bodies answers the one in front.
        bodies.enumerated()
            .filter { $0.element.visible && $0.element.canShow }
            .sorted { a, b in a.element.z != b.element.z ? a.element.z > b.element.z : a.offset > b.offset }
            .map(\.element)
    }

    /// The body a viewport point passes through to, if any.
    func body(atViewportPoint point: CGPoint) -> Body? {
        guard let index = regionNow.frameIndex(at: point) else { return nil }
        let visible = visibleBodies
        return index < visible.count ? visible[index] : nil
    }

    /// The hit region as the screen shows it now. A whole card a settle is
    /// carrying, or that a press has taken out of one, answers where it stands
    /// on screen, not at the landing its placement names: a press on its title
    /// bar mid-slide is a press on the card, as the user sees it there.
    private var regionNow: CardHitRegion {
        let visible = visibleBodies
        let shownElsewhere = { (body: Body) -> Bool in
            body.whole && (body.beats != nil || body === self.pressedOutOfBeats)
        }
        guard visible.contains(where: shownElsewhere) else { return region }
        var now = region
        for (index, body) in visible.enumerated() where shownElsewhere(body) {
            let shown = presentedRect(body)
            if index < now.visibleFrames.count { now.visibleFrames[index] = shown }
            if index < now.visibleShapes.count, var shape = now.visibleShapes[index] {
                shape.paneRect = shown.insetBy(dx: cardApron, dy: cardApron)
                now.visibleShapes[index] = shape
            }
        }
        return now
    }

    // MARK: - Cards in hand

    /// What the last `placeCards` said of one card: its pane rect, whether
    /// it shows, its stacking, the edges its pane offers as grips, whether
    /// the pane is free, and its resize floor.
    struct CardPlacement: Equatable {
        var rect: CGRect
        var visible: Bool
        var sibling: Bool
        var z: Int
        var grips: Set<ResizeEdge>
        var free: Bool
        var min: CGSize
        /// The resize ceiling, when the arrangement holds one (a slot's run).
        var maxHeight: CGFloat?
    }

    /// The cards the last `placeCards` named, by card id. Read by the
    /// gesture tracker for its envelope; nothing is shown from it yet.
    private(set) var cardPlacements: [String: CardPlacement] = [:]
    /// The canvas the cards stand on, viewport points, and the zoom its
    /// layout is drawn at; nil before the shell has said.
    private(set) var cardCanvas: CGRect?
    private var cardZoom: CGFloat = 1
    /// The deck's card gap the last `placeCards` named, layout px.
    private var cardGap: CGFloat = 0
    private(set) var cardApron: CGFloat = CardGeometry.apron

    /// The gesture the host is tracking now, one at a time.
    private struct Gesture {
        let body: Body
        let cardId: String
        let kind: CardGestureKind
        let edge: ResizeEdge?
        var tracker: CardGestureTracker
        /// The container's frame at the press, which every step moves by the
        /// pane rect's own travel.
        let containerStart: CGRect
        var meta: Bool
        var alt: Bool
        var last: CardGestureTracker.Step
        var pointer: CGPoint
        /// Whether the host moves the card's view. A rail's edge drag
        /// (`rail`) is the shell's draft: the host reports the pointer, and
        /// the shell's placements move every member of the rail.
        var carriesView: Bool { kind != .rail }
    }
    private var gesture: Gesture?

    /// Whether the host is tracking a card's drag or resize.
    var gestureLive: Bool { gesture != nil }

    /// Whether the left button is down, as the window last saw it: every
    /// press and release passes `MainWindow.sendEvent`, whatever posted it,
    /// where `NSEvent.pressedMouseButtons` reads only the hardware's state.
    private var leftButtonDown = false

    func noteLeftButton(down: Bool, atViewport point: CGPoint? = nil) {
        leftButtonDown = down
        if down, let point {
            takeFromBeats(at: point)
        } else if !down, let body = pressedOutOfBeats, gesture?.body !== body {
            // The press never became a gesture (a click in the content, or a
            // title-bar click whose `begin` has yet to arrive): the card goes
            // on to the landing its settle was bound for.
            pressedOutOfBeats = nil
            returnToLanding(body)
        }
    }

    /// A whole card a press took out of its beats, held where the press
    /// found it until a gesture claims it or the mouse comes up.
    private weak var pressedOutOfBeats: Body?

    /// A press on a whole card a settle is carrying stops it where the user
    /// sees it, before the press is dispatched: AppKit routes the press by
    /// the view's frame, which a beat leaves at the landing while only the
    /// layer moves, so a card left in its beats would not get the press that
    /// lands on it.
    private func takeFromBeats(at point: CGPoint) {
        guard let body = body(atViewportPoint: point), body.whole, body.beats != nil else { return }
        let shown = presentedRect(body)
        cancelBeats(body)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.container.frame = shown
        CATransaction.commit()
        pressedOutOfBeats = body
    }

    /// Carry a card a press held, and nothing then moved, on to its landing.
    private func returnToLanding(_ body: Body) {
        guard body.container.frame != body.frame else { return }
        let landing = body.frame
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            body.container.animator().frame = landing
        }
    }

    /// `placeCards`: every card's view, whether it shows, how it stacks, and
    /// how the hand holds it. The rect is the pane's, which the gesture
    /// carries; the view is the pane outset by `apron`, grown to whole
    /// points. A body the placement does not name is hidden.
    func placeCards(_ placement: PlaceCards) {
        cardApron = CGFloat(placement.apron)
        // A canvas the shell does not show leaves the last one standing.
        if let canvas = placement.canvas { cardCanvas = canvas.cgRect }
        if placement.zoom > 0 { cardZoom = CGFloat(placement.zoom) }
        if placement.gap >= 0 { cardGap = CGFloat(placement.gap) }
        var placements: [String: CardPlacement] = [:]
        // Each named card with where the placement lists it: the deck's
        // reading order, which is the window's VoiceOver order.
        var named: [String: (entry: CardPlacementEntry, deckIndex: Int)] = [:]
        for (index, entry) in placement.cards.enumerated() {
            named[entry.cardId] = (entry, index)
            placements[entry.cardId] = CardPlacement(
                rect: entry.rect,
                visible: entry.visible,
                sibling: entry.sibling == true,
                z: Int(entry.z),
                grips: Set(entry.grips),
                free: entry.free,
                min: CGSize(width: entry.min.width, height: entry.min.height),
                maxHeight: entry.maxHeight.map { CGFloat($0) }
            )
        }
        cardPlacements = placements
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for body in bodies {
            // A card in the host's hand is the host's until its gesture ends:
            // the placement that lands it is the shell's commit, after.
            if let gesture, gesture.carriesView, gesture.body === body { continue }
            // And so is one a press took from its beats, until the press
            // becomes a gesture or comes up.
            if body === pressedOutOfBeats { continue }
            guard let cardId = body.cardId, let (entry, deckIndex) = named[cardId] else {
                cancelBeats(body)
                body.visible = false
                body.sibling = false
                applyVisibility(body)
                continue
            }
            let frame = entry.view.cgRect
            let visible = entry.visible
            setWhole(body, true)
            body.sibling = entry.sibling == true
            if entry.insets != body.insets {
                body.insets = entry.insets
                send(.cardInsets(entry.insets), to: body)
            }
            // A placement that names the plan carrying the card is its
            // landing, which the shell adopted as posted: the beats run on.
            // One that names no plan, or another — a drag taking its frame
            // mid-settle, a measurement after the plan — takes the card from
            // its beats. The id decides, never the rect ([B11]).
            if let beats = body.beats, !visible || entry.planId != beats.planId {
                cancelBeats(body)
            }
            body.frame = frame
            body.shellControls = entry.shell.map(\.cgRect)
            body.container.frame = frame
            body.visible = visible
            body.z = Int(entry.z)
            body.container.order = body.z
            body.deckIndex = deckIndex
            applyVisibility(body)
        }
        // The containers in the panes' order, back to front, moved in place.
        hostView.sortContainers()
        CATransaction.commit()
        refreshRegion()
    }

    /// `cardGesture` `begin`: a card's page has taken a title-bar or grip
    /// press, and the host is to carry the card until the mouse comes up. A
    /// press whose mouse-up beat the message here ends at once, as a click,
    /// so no gesture is left open waiting for an up that has already passed.
    func claimGesture(from body: Body, begin: CardGestureBegin) {
        guard let cardId = body.cardId, gesture == nil else { return }
        let kind = begin.kind
        let edge = begin.edge
        if kind != .move && edge == nil { return }
        // The press brings its card forward at once, as the shell's
        // activation of it will: until that placement arrives, a card pressed
        // from under a neighbour would travel under it. A Cmd-press moves a
        // card without raising it, as a background window moves.
        if !begin.meta { raise(body) }
        let placement = cardPlacements[cardId]
        // A card a settle is carrying is taken where the user sees it: its
        // beats stop, its container holds the presented frame, and the hand
        // moves it from there rather than from the landing it was bound for.
        var containerStart = body.container.frame
        if body.beats != nil {
            containerStart = presentedRect(body)
            cancelBeats(body)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            body.container.frame = containerStart
            CATransaction.commit()
        }
        let startRect = body.whole
            ? containerStart.insetBy(dx: cardApron, dy: cardApron)
            : (placement?.rect ?? body.frame)
        // Where the press landed, as the page saw it: the window's mouse
        // location has moved on by the time `begin` arrives, and a press the
        // window was sent rather than the hand made never moves it at all.
        let pointer = body.webView.convert(CGPoint(x: begin.x, y: begin.y), to: hostView)
        let others = cardPlacements
            .filter { $0.key != cardId && $0.value.visible && !$0.value.sibling }
            .map(\.value.rect)
        let tracker = CardGestureTracker(
            kind: kind == .resize ? edge.map { .resize($0) } ?? .move : .move,
            startRect: startRect,
            startPointer: pointer,
            canvas: cardCanvas ?? hostView.bounds,
            zoom: cardZoom,
            minSize: placement?.min ?? .zero,
            // A card holding a height in its slot stops at its run's end,
            // not the canvas's: held past it, the edge stands there.
            maxSize: placement?.maxHeight.map { CGSize(width: CGFloat.greatestFiniteMagnitude, height: $0) },
            free: placement?.free ?? true,
            gap: cardGap,
            others: others
        )
        let pressed = Gesture(
            body: body, cardId: cardId, kind: kind, edge: edge, tracker: tracker,
            containerStart: containerStart, meta: begin.meta, alt: begin.alt,
            last: CardGestureTracker.Step(rect: startRect, moved: false), pointer: pointer
        )
        guard leftButtonDown else {
            report(pressed, phase: .end)
            if pressedOutOfBeats === body {
                pressedOutOfBeats = nil
                returnToLanding(body)
            }
            return
        }
        gesture = pressed
    }

    /// Stack `body`'s container in front of every other, ahead of the
    /// placement that will say so: the next `placeCards` restores the
    /// shell's order, which by then has this card in front.
    private func raise(_ body: Body) {
        let top = bodies.filter { $0 !== body }.map(\.container.order).max() ?? body.container.order
        if body.container.order > top { return }
        // Its stacking with it: a placement skips a card in the hand, so
        // this is the card's order until the gesture's commit places it.
        body.z = top + 1
        body.container.order = body.z
        hostView.sortContainers()
    }

    /// A mouse event while a gesture is live: a drag steps it, an up ends it.
    func track(_ event: NSEvent) {
        guard var live = gesture else { return }
        switch event.type {
        case .leftMouseDragged:
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            live.meta = event.modifierFlags.contains(.command)
            live.alt = event.modifierFlags.contains(.option)
            live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
            gesture = live
            if live.carriesView { move(live) }
            report(live, phase: .move)
        case .leftMouseUp:
            // The release is where the hand let go, which a quick drag's
            // merged moves may never have reported: step to it first, so a
            // press and a release apart with nothing between them is a drag.
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
            if live.carriesView { move(live) }
            gesture = nil
            report(live, phase: .end)
            if pressedOutOfBeats === live.body {
                pressedOutOfBeats = nil
                // A hold that went nowhere commits nothing, so no placement
                // will come to land the card: it lands itself.
                if !live.last.moved { returnToLanding(live.body) }
            }
        default:
            break
        }
    }

    /// End the gesture with nothing committed: Escape, or the window losing
    /// the mouse. The card goes back where the press found it.
    func cancelGesture() {
        guard let live = gesture else { return }
        gesture = nil
        if live.carriesView {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            live.body.container.frame = live.containerStart
            CATransaction.commit()
        }
        report(live, phase: .cancel)
        if pressedOutOfBeats === live.body {
            pressedOutOfBeats = nil
            returnToLanding(live.body)
        }
    }

    /// Carry the card's container by the pane rect's travel, in one
    /// transaction with nothing animating.
    private func move(_ live: Gesture) {
        let start = live.tracker.startRect
        let rect = live.last.rect
        let from = live.containerStart
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        live.body.container.frame = CGRect(
            x: from.minX + (rect.minX - start.minX),
            y: from.minY + (rect.minY - start.minY),
            width: from.width + (rect.width - start.width),
            height: from.height + (rect.height - start.height)
        )
        CATransaction.commit()
    }

    /// Tell the shell where the gesture stands (`onCardGesture`).
    private func report(_ live: Gesture, phase: CardGestureReport.Phase) {
        let r = live.last.rect
        let snapped = live.last.snapX != nil || live.last.snapY != nil
        let report = CardGestureReport(
            cardId: live.cardId,
            kind: live.kind,
            phase: phase,
            rect: PlanRect(x: r.minX, y: r.minY, width: r.width, height: r.height),
            pointer: .init(x: live.pointer.x, y: live.pointer.y),
            start: .init(x: live.tracker.startPointer.x, y: live.tracker.startPointer.y),
            moved: live.last.moved,
            meta: live.meta,
            alt: live.alt,
            edge: live.edge,
            snap: snapped ? .init(x: live.last.snapX.map(Double.init), y: live.last.snapY.map(Double.init)) : nil
        )
        window.sendToShell(.cardGesture(report))
    }

    // MARK: - Beats

    /// The animation keys a plan's tracks run under: one per property, so a
    /// later plan's track replaces an earlier one's, and cancelling is
    /// removing three keys.
    private static let beatKeys = ["beats-position", "beats-bounds", "beats-opacity"]

    /// `cardPlan`: carry each named card through its beats as Core
    /// Animation, on the chrome's clock. One anchor pair of the wall and
    /// media clocks is read for the whole plan, so every body's start is the
    /// shell's start moved onto the render server's clock.
    ///
    /// Each body runs one track per property over the whole plan — never an
    /// animation per beat, which would show the container's model value,
    /// the landing, between beats and through a prepare delay. The track
    /// holds the first beat's opening rect from now until it begins
    /// (`fillMode = .backwards`), and the container's model is the landing,
    /// so when the track ends nothing moves.
    func runPlan(_ plan: CardPlan) {
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for planned in plan.cards {
            guard let body = body(forCard: planned.cardId) else { continue }
            // A card in the host's hand is the hand's until the gesture ends.
            if let gesture, gesture.carriesView, gesture.body === body { continue }
            // An arrival rides its frame's arrive beat in: the shell posts it
            // visible from the plan, so it is shown here, in this
            // transaction, at its landing. Its tracks
            // hold their opening values until they begin (`.backwards`), so
            // no frame shows it before the fade; and a plan the host cannot
            // run still leaves it shown where it lands.
            if planned.arrives == true, !body.visible, body.canShow {
                body.visible = true
                body.frame = planned.landing.cgRect
                body.container.frame = planned.landing.cgRect
                applyVisibility(body)
            }
            guard body.visible, body.canShow,
                  let layer = body.container.layer,
                  let track = BodyBeats.planTrack(planned.beats), track.durationMs > 0 else {
                decline(body, planId: plan.planId, landing: planned.landing.cgRect)
                continue
            }
            cancelBeats(body)
            let landing = planned.landing.cgRect
            let crossing = planned.crossing.map { CGSize(width: $0.width, height: $0.height) }
            guard let mapping = probeMapping(body, landing: landing, holdPage: crossing != nil) else {
                NSLog("BodyViewController: no layer mapping for %@; its beats are not run", planned.cardId)
                decline(body, planId: plan.planId, landing: landing)
                continue
            }
            body.mapping = mapping
            let begin = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: track.delayMs)
            let lateMs = max(0, anchor.mediaTime - begin) * 1000
            let localBegin = layer.convertTime(begin, from: nil)
            let position = Self.keyframes(
                "position", values: track.rects.map { NSValue(point: mapping.position(of: $0)) },
                track: track, begin: localBegin
            )
            let planId = plan.planId
            position.delegate = BeatTrackDelegate { [weak self, weak body] (finished: Bool) in
                guard let self, let body, finished, let beats = body.beats, beats.planId == planId,
                      let cardId = body.cardId else { return }
                body.beats = nil
                self.endCrossing(body)
                self.notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: beats.lateMs))
            }
            layer.add(position, forKey: Self.beatKeys[0])
            layer.add(Self.keyframes(
                "bounds", values: track.rects.map { NSValue(rect: mapping.bounds(of: $0)) },
                track: track, begin: localBegin
            ), forKey: Self.beatKeys[1])
            if let opacities = track.opacities {
                layer.add(Self.keyframes(
                    "opacity", values: opacities.map { NSNumber(value: $0) }, track: track, begin: localBegin
                ), forKey: Self.beatKeys[2])
            }
            body.beats = (planId, landing, lateMs)
            body.frame = landing
            // A reading of the window armed now samples this container under
            // its card id, over the beats that move it.
            let moving = planned.beats.filter { $0.from != $0.to }.map { beat in
                let from = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: beat.delayMs)
                return (from: from, to: from + beat.durationMs / 1000)
            }
            for meter in window.armedFrameMeters {
                meter.track(layer, named: planned.cardId, active: moving)
            }
            if let crossing {
                // The lead is measured to the first beat that moves the box:
                // a prepare beat ahead of it holds First, and the page at its
                // final size is clipped there exactly as before the plan.
                let firstMove = planned.beats.first { $0.from != $0.to }?.delayMs ?? track.delayMs
                let moveBegin = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: firstMove)
                body.crossing = (crossing, moveBegin)
                body.lastCrossing = CrossingAccount(planId: planId, size: crossing)
                // Tell the body now, in this task, so it pins its scrollers
                // and acknowledges inside a display period: one hop to its
                // page and one back, never a round trip through tugcast.
                let spanMs = planned.beats.map { $0.delayMs + $0.durationMs }.max() ?? 0
                send(.bodyCrossing(BodyCrossing(
                    phase: .begin, width: crossing.width, height: crossing.height, durationMs: spanMs
                )), to: body)
            }
        }
        CATransaction.commit()
        refreshRegion()
    }

    /// Take a body's beats off, and tell the shell when a plan was carrying it.
    private func cancelBeats(_ body: Body) {
        guard let beats = body.beats else { return }
        body.beats = nil
        for key in Self.beatKeys { body.container.layer?.removeAnimation(forKey: key) }
        endCrossing(body)
        if let cardId = body.cardId {
            // A reading of the window stops judging the beats the body lost.
            for meter in window.armedFrameMeters {
                meter.cut(named: cardId, at: CACurrentMediaTime())
            }
            notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: beats.planId))
        }
    }

    /// A body the plan names that the host cannot carry — not shown, not
    /// painted, or with no track or mapping to run — is placed at its
    /// landing at once, and the shell is told its beats were cancelled.
    /// The shell adopted the landing as posted when it sent the plan, so
    /// the land's measurement reads the same rect and posts nothing: left
    /// where it stood, the body would stay at First under a pane that has
    /// moved, until some later placement happened to differ.
    private func decline(_ body: Body, planId: Int, landing: CGRect) {
        cancelBeats(body)
        body.frame = landing
        body.container.frame = landing
        body.webView.frame = body.container.bounds
        body.webView.autoresizingMask = Self.pageResizing
        if let cardId = body.cardId {
            notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: planId))
        }
    }

    /// Solve the container's frame-to-layer mapping by setting it to three
    /// frames about `landing` and reading its layer after each, and leave it
    /// at `landing`, its model value for the plan. The web view's
    /// autoresizing is off for the probe, so the page is never resized by
    /// it: the web view is set once, to the landing's bounds — or, for a
    /// body the plan carries to a new size (`holdPage`), left at the size it
    /// has, with autoresizing off, until the body is ready for the new one.
    private func probeMapping(_ body: Body, landing: CGRect, holdPage: Bool) -> LayerMapping? {
        guard let layer = body.container.layer else { return nil }
        let container = body.container
        let held = body.webView.frame.size
        body.webView.autoresizingMask = []
        defer {
            container.frame = landing
            if holdPage {
                body.webView.frame = CGRect(origin: .zero, size: held)
            } else {
                body.webView.frame = container.bounds
                body.webView.autoresizingMask = Self.pageResizing
            }
        }
        container.frame = landing
        let base = layer.position
        let origin = layer.bounds.origin
        container.frame = landing.offsetBy(dx: 1, dy: 1)
        let moved = layer.position
        container.frame = CGRect(x: landing.minX, y: landing.minY, width: landing.width + 1, height: landing.height + 1)
        let grown = layer.position
        return LayerMapping.solve(base: landing, at: base, moved: moved, grown: grown, boundsOrigin: origin)
    }

    /// How a body's page follows its container outside a crossing.
    static let pageResizing: NSView.AutoresizingMask = [.width, .height]

    /// `crossingReady`: the body has pinned its scrollers for the crossing
    /// its plan began. Its page takes the landing size now, once, top-left
    /// pinned in the flipped container, while the container's own track is
    /// still at First or in its prepare beat; the container clips it to the
    /// rect the track has reached. Late or stale — the beats already landed
    /// or were cancelled — it is ignored, the page already restored.
    ///
    /// `surface` is the page's own background as sRGB bytes. The container
    /// wears it already (`setSurface`), and the crossing re-reads it: a box
    /// that shrinks is larger than the page until its track lands, and the
    /// strip the page does not reach is the body's surface rather than the
    /// canvas beneath.
    func crossingReady(_ body: Body, surface: [Double]?) {
        guard let crossing = body.crossing else { return }
        let leadMs = (crossing.begin - CACurrentMediaTime()) * 1000
        body.lastCrossing?.readyLeadMs = leadMs
        // A whole card's page is the card, chrome and all, and it wears no
        // surface behind it: given its smaller landing size now, the card
        // would stand at its landing for the whole motion over the canvas the
        // container still spans. So a whole card that shrinks keeps its page
        // and the container clips it as it travels; the page takes the
        // landing size at the land. One that grows takes it now, as any
        // body does, and the container reveals it.
        let page = body.webView.frame.size
        if body.whole, crossing.size.width < page.width - 0.5 || crossing.size.height < page.height - 0.5 {
            body.lastCrossing?.heldToLand = true
            return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let surface, !body.whole {
            body.container.surface = Self.color(surface)
            body.container.displayIfNeeded()
            body.lastCrossing?.surface = surface
        }
        body.webView.autoresizingMask = []
        body.webView.frame = CGRect(origin: .zero, size: crossing.size)
        CATransaction.commit()
    }

    /// The crossing is over: the page follows its container again, at the
    /// container's own bounds, and the body restores what it pinned.
    private func endCrossing(_ body: Body) {
        guard body.crossing != nil else { return }
        body.crossing = nil
        body.lastCrossing?.restored = true
        body.webView.frame = body.container.bounds
        body.webView.autoresizingMask = Self.pageResizing
        send(.bodyCrossing(.land), to: body)
    }

    /// `bodySurface`: the page's background as sRGB bytes, posted when it
    /// paints and whenever its theme changes. The container wears it behind
    /// the web view for as long as the body stands.
    func setSurface(_ body: Body, surface: [Double]?) {
        guard let surface else { return }
        body.surface = Self.color(surface)
        if !body.whole { body.container.surface = body.surface }
    }

    /// Four sRGB bytes, which the surface's decode has checked, as a colour.
    private static func color(_ bytes: [Double]) -> CGColor {
        let c = bytes.map { CGFloat($0) / 255 }
        return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
    }

    /// Hold the body's container as a whole card's view: its page draws its
    /// own corners and surface, and its apron must show what is beneath it.
    private func setWhole(_ body: Body, _ whole: Bool) {
        body.whole = whole
        body.container.surface = whole ? nil : body.surface
    }

    private static func keyframes(_ keyPath: String, values: [Any], track: BodyBeats.Track, begin: CFTimeInterval) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = track.keyTimes.map { NSNumber(value: $0) }
        animation.timingFunctions = track.timings.map(timingFunction)
        animation.calculationMode = .linear
        animation.duration = track.durationMs / 1000
        animation.beginTime = begin
        animation.fillMode = .backwards
        animation.isRemovedOnCompletion = true
        return animation
    }

    /// A segment's timing: linear between samples, or a fade's CSS keyword.
    private static func timingFunction(_ timing: BodyBeats.Timing) -> CAMediaTimingFunction {
        switch timing {
        case .linear:
            return CAMediaTimingFunction(name: .linear)
        case .easing(let keyword):
            switch keyword {
            case "ease": return CAMediaTimingFunction(name: .default)
            case "ease-in": return CAMediaTimingFunction(name: .easeIn)
            case "ease-out": return CAMediaTimingFunction(name: .easeOut)
            case "ease-in-out": return CAMediaTimingFunction(name: .easeInEaseOut)
            default: return CAMediaTimingFunction(name: .linear)
            }
        }
    }

    /// The display period of the screen the window is on, seconds, which the
    /// harness reads beside a body's frames. 60 Hz when the window has no
    /// screen yet.
    private var displayPeriodSec: Double {
        let fps = window.screen?.maximumFramesPerSecond ?? 60
        return 1 / Double(max(1, fps))
    }

    // MARK: - The reveal

    /// The window is revealing the shell over the splash with `fade`. The
    /// cards and the overlay fade in with it, on the fade's own clock, so
    /// the splash gives way to the deck as one picture.
    func shellDidReveal(fade: CAAnimation) {
        revealedAt = CACurrentMediaTime()
        revealOverlay(fade: fade)
    }

    // MARK: - Focus

    /// `bodyFocus`: the named card's body takes the keyboard, or the shell
    /// does when the card has none.
    func focus(cardId: String?) {
        keyboardCardId = cardId
        // A modal standing in the overlay keeps the keyboard: the card named
        // now has it once the modal goes (`overlayClaimed`).
        if overlayClaim == .all, overlayView != nil { return }
        if let cardId, let body = body(forCard: cardId) {
            window.makeFirstResponder(body.webView)
        } else {
            window.focusWebView()
        }
    }

    /// The card whose body the shell last gave the keyboard to, or nil for
    /// the shell. What the host's own focus moves — the launch reveal's —
    /// defer to, so they do not take the keyboard back from a body.
    private(set) var keyboardCardId: String?

    /// Give the keyboard to whoever the shell last named: that card's
    /// body, or the shell — or the overlay, while a modal stands in it.
    func focusKeyboardOwner() {
        if overlayClaim == .all, let overlayView {
            window.makeFirstResponder(overlayView)
            return
        }
        focus(cardId: keyboardCardId)
    }

    // MARK: - Teardown

    /// `bodyDestroy`. With `save`, the body writes its card's state first.
    func destroy(cardId: String, save: Bool) {
        covers.removeValue(forKey: cardId)
        guard let body = body(forCard: cardId) else { return }
        guard save else {
            remove(body)
            return
        }
        window.hostChannel.call(.saveState, in: body.webView) { [weak self] _ in
            self?.remove(body)
        }
    }

    /// Every body, at once, and the overlay with them. Used where the
    /// window's bridge is taken down, and before the shell reloads: the
    /// overlay is the shell's page's, and the reloaded shell asks for it
    /// again (`overlayCreate`), so nothing it held in memory outlives the
    /// deck it was drawn for.
    func destroyAll() {
        pendingSpare?.cancel()
        pendingSpare = nil
        covers.removeAll()
        for body in bodies { remove(body) }
        removeOverlay()
    }

    /// Every body writes its card's state, then every body goes — the shell
    /// is about to reload, and its restore pass makes them again. A body
    /// that does not answer within `saveDeadline` goes unsaved rather than
    /// holding the reload. `completion` runs once.
    func saveAndDestroyAll(completion: @escaping () -> Void) {
        pendingSpare?.cancel()
        pendingSpare = nil
        let bound = bodies.filter { $0.cardId != nil && $0.state == .ready }
        var waiting = bound.count
        var finished = false
        let finish = { [weak self] in
            guard !finished else { return }
            finished = true
            self?.destroyAll()
            completion()
        }
        guard waiting > 0 else {
            finish()
            return
        }
        for body in bound {
            window.hostChannel.call(.saveState, in: body.webView) { _ in
                waiting -= 1
                if waiting == 0 { finish() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.saveDeadline) { finish() }
    }

    /// How long a reload waits on the bodies' saves.
    static let saveDeadline: DispatchTimeInterval = .seconds(2)

    /// The bodies that can answer `prepareForTermination()`: bound and ready.
    var terminable: [(cardId: String, webView: WKWebView)] {
        bodies.compactMap { body in
            guard let cardId = body.cardId, body.state == .ready else { return nil }
            return (cardId, body.webView)
        }
    }

    private func remove(_ body: Body) {
        body.deadline?.cancel()
        body.deadline = nil
        body.evictDue?.cancel()
        body.evictDue = nil
        // A card going away mid-gesture takes its gesture with it.
        if gesture?.body === body { gesture = nil }
        bodies.removeAll { $0 === body }
        let controller = body.webView.configuration.userContentController
        HostChannel.unregister(from: controller)
        body.webView.navigationDelegate = nil
        body.webView.uiDelegate = nil
        body.webView.stopLoading()
        body.container.removeFromSuperview()
        if let cardId = body.cardId {
            window.bodyDidGoAway(cardId: cardId)
        }
        refreshRegion()
    }

    // MARK: - Eviction

    /// The machine says how short of memory it is. On `warning` hidden
    /// bodies give up their processes oldest-hidden first, one at a time,
    /// until the warning clears or none is left; on `critical` every body
    /// the last placement did not name visible goes at once, a pane's
    /// siblings and the spare with them, and the spare is made again once
    /// the level eases. A body placed visible is never evicted, and nothing
    /// here counts bodies.
    func memoryPressure(_ level: PressureLevel) {
        let was = pressure.level
        pressure = (level, Date().timeIntervalSince1970 * 1000)
        TugLog.info("bodies", "memory pressure", [TugLog.field("level", level.rawValue)])
        window.sendToShell(.bodyPressure(BodyPressure(level: BodyPressure.Level(rawValue: level.rawValue) ?? .normal, at: pressure.at)))
        pendingWarningStep?.cancel()
        pendingWarningStep = nil
        declined = []
        switch level {
        case .normal:
            if was == .critical { scheduleSpare() }
            return
        case .warning:
            // A warning keeps the spare: one critical took is made again.
            if was == .critical { scheduleSpare() }
            evictOldestHidden()
        case .critical:
            pendingSpare?.cancel()
            pendingSpare = nil
            if let spare { remove(spare) }
            for body in bodies where evictable(body, siblings: true) {
                evict(body, cause: "pressure-critical")
            }
        }
    }

    /// Whether pressure may take the body's process: a ready card the last
    /// placement did not name visible ([B06]), not in the host's hand, not
    /// already going. A warning takes only a hidden page — one WebKit
    /// throttles — never a sibling, which paints behind its pane's active
    /// card. A pressure episode does not ask again a body it was refused;
    /// the clock, outside any episode, does.
    private func evictable(_ body: Body, siblings: Bool, episode: Bool = true) -> Bool {
        guard body.cardId != nil, body.state == .ready, !body.visible, !body.evicting,
              !(episode && declined.contains(ObjectIdentifier(body))) else { return false }
        if gesture?.body === body || body === pressedOutOfBeats { return false }
        return siblings || body.shown?.value == false
    }

    /// The reader's `evictAfterMs`, from the shell: every hidden body's clock
    /// is set again against when it was hidden.
    func setEvictAfter(ms: Double) {
        guard ms > 0, ms != evictAfterMs else { return }
        evictAfterMs = ms
        TugLog.info("bodies", "evict after", [TugLog.field("ms", String(format: "%.0f", ms))])
        for body in bodies { armEviction(body) }
    }

    /// Set the time trigger's eviction for `body`: due `evictAfterMs` after
    /// it was hidden, while it stays hidden, and nothing while it is shown.
    /// Only a hidden page — a sibling paints, and keeps its process until
    /// pressure says otherwise. When it falls due the body is asked as
    /// pressure asks, so one the placement named visible is never taken
    /// ([B06]).
    private func armEviction(_ body: Body) {
        body.evictDue?.cancel()
        body.evictDue = nil
        guard let ms = evictAfterMs, body.cardId != nil, let shown = body.shown, !shown.value else { return }
        let remaining = max(0, ms - (Date().timeIntervalSince1970 * 1000 - shown.since))
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body else { return }
            body.evictDue = nil
            guard self.evictable(body, siblings: false, episode: false) else { return }
            self.evict(body, cause: "hidden")
        }
        body.evictDue = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(remaining.rounded())), execute: work)
    }

    /// One step of a warning: the body hidden longest gives up its process,
    /// and a beat after it has, the next, while the warning stands.
    private func evictOldestHidden() {
        guard pressure.level == .warning else { return }
        let oldest = bodies
            .filter { evictable($0, siblings: false) }
            .min { ($0.shown?.since ?? 0) < ($1.shown?.since ?? 0) }
        guard let oldest else { return }
        evict(oldest, cause: "pressure-warning") { [weak self] in
            guard let self, self.pressure.level == .warning else { return }
            let work = DispatchWorkItem { [weak self] in
                self?.pendingWarningStep = nil
                self?.evictOldestHidden()
            }
            self.pendingWarningStep = work
            DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.warningStepDelay, execute: work)
        }
    }

    /// Give a hidden body's process up: its page writes its card's state, as
    /// `destroy(save: true)` has it, the host keeps its last frame for the
    /// cover the card comes back under, and the view goes. The shell is told
    /// `evicted` and keeps the card, which comes back as an arrival when a
    /// placement next wants it shown. A body the placement named visible
    /// while it was saving is kept, and so is one whose page did not answer
    /// the save within `saveDeadline`: an eviction loses nothing unwritten.
    /// `done` runs once, whichever way it went.
    private func evict(_ body: Body, cause: String, then done: (() -> Void)? = nil) {
        guard let cardId = body.cardId else { return }
        body.evicting = true
        var settled = false
        let settle = { [weak self, weak body] (saved: Bool) in
            guard !settled else { return }
            settled = true
            defer { done?() }
            guard let self, let body, self.bodies.contains(where: { $0 === body }) else { return }
            guard saved, !body.visible else {
                self.decline(body, cardId: cardId, why: saved ? "shown" : "unsaved")
                return
            }
            // The last frame, for the cover. A page WebKit is not painting
            // still answers a snapshot, which it paints for the asking.
            body.webView.takeSnapshot(with: nil) { [weak self, weak body] image, error in
                guard let self, let body, self.bodies.contains(where: { $0 === body }) else { return }
                body.evicting = false
                guard !body.visible else {
                    self.decline(body, cardId: cardId, why: "shown")
                    return
                }
                if let frame = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    self.covers[cardId] = frame
                } else {
                    TugLog.warn("bodies", "no last frame for an evicted card's cover", [
                        TugLog.field("card", cardId),
                        TugLog.field("error", error.map { String(describing: $0) } ?? "none"),
                    ])
                }
                self.remove(body)
                TugLog.info("bodies", "evicted", [
                    TugLog.field("card", cardId),
                    TugLog.field("cause", cause),
                ])
                self.notifyShell(BodyStateReport(cardId: cardId, state: .evicted, cause: cause))
            }
        }
        window.hostChannel.call(.saveState, in: body.webView) { result in
            if case .success = result { settle(true) } else { settle(false) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.saveDeadline) { settle(false) }
    }

    /// This pressure episode will not ask `body` again.
    private func decline(_ body: Body, cardId: String, why: String) {
        body.evicting = false
        declined.insert(ObjectIdentifier(body))
        TugLog.info("bodies", "eviction declined", [
            TugLog.field("card", cardId),
            TugLog.field("why", why),
        ])
    }

    // MARK: - Failure

    private func armDeadline(_ body: Body) {
        body.deadline?.cancel()
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body, body.state != .ready else { return }
            self.fail(body, cause: "deadline")
        }
        body.deadline = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(BodyViewController.readyDeadlineMs),
            execute: work
        )
    }

    /// Give up on a body: it is destroyed, and the shell decides whether to
    /// ask for the card's body again.
    private func fail(_ body: Body, cause: String) {
        let cardId = body.cardId
        TugLog.error("bodies", "failed", [
            TugLog.field("card", cardId ?? "spare"),
            TugLog.field("cause", cause),
        ])
        body.state = .failed
        remove(body)
        if let cardId {
            notifyShell(BodyStateReport(cardId: cardId, state: .failed, cause: cause))
        }
    }

    /// A body's WebContent process died. It is loaded afresh and re-bound to
    /// restore its card — `load`, not `reload()`, which a terminated view
    /// with a nil `url` ignores — once per window; a second death inside the
    /// window fails it. Returns false for a view that is not a body.
    func webContentProcessDidTerminate(_ webView: WKWebView) -> Bool {
        // The overlay holds nothing a reload loses: its page asks the shell
        // for everything it shows again when it says hello. Loaded afresh, as
        // a body is, since a terminated view's `reload()` may find no URL;
        // and a modal that held the keyboard is gone with the page, so the
        // keyboard goes back to whoever the shell last named.
        if let overlayView, webView === overlayView {
            let heldKeys = overlayClaim == .all && window.firstResponder === overlayView
            overlayClaim = .none
            keysBeforeOverlay = nil
            if heldKeys { focus(cardId: keyboardCardId) }
            if let origin = window.shellOrigin,
               let url = URL(string: origin + "/?overlay=\(Self.overlayCardId)") {
                overlayView.load(URLRequest(url: url))
            }
            return true
        }
        guard let body = body(for: webView) else { return false }
        let now = Date()
        if let previous = body.lastTermination,
           now.timeIntervalSince(previous) < BodyViewController.terminationWindow {
            fail(body, cause: "terminated twice")
            return true
        }
        body.lastTermination = now
        guard let cardId = body.cardId else {
            // A spare holds nothing; drop it, and let the next one be made.
            remove(body)
            scheduleSpare()
            return true
        }
        TugLog.warn("bodies", "WebContent process terminated — reloading", [
            TugLog.field("card", cardId),
        ])
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?body=\(cardId)") else {
            fail(body, cause: "no origin to reload from")
            return true
        }
        body.state = .loading
        // Its card restores as it would at launch: a Session card from the
        // ledger, a kind with no session by mounting again. The kind is kept.
        body.intent = JSONObject(["kind": .string(body.intent?["kind"] == .string("mount") ? "mount" : "restore")])
        body.warm = false
        body.painted = false
        // The new page paints into a view that was shown: unhidden and
        // transparent until it says `painted`, as a page never shown is —
        // hidden, it would never get the frames `painted` waits on.
        body.shownOnce = false
        applyVisibility(body)
        notifyShell(BodyStateReport(cardId: cardId, state: .terminated))
        armDeadline(body)
        webView.load(URLRequest(url: url))
        return true
    }

    // MARK: - Harness

    /// Every body as the harness reports it, the spare included.
    func snapshot() -> [JSONValue] {
        bodies.map { body -> JSONValue in
            let opacity = body.container.layer?.presentation()?.opacity ?? body.container.layer?.opacity ?? 0
            var entry: [String: JSONValue] = [:]
            entry["cardId"] = body.cardId.map(JSONValue.string) ?? .null
            entry["componentId"] = body.componentId.map(JSONValue.string) ?? .null
            entry["state"] = .string(body.state.rawValue)
            entry["frame"] = Self.json(body.frame)
            entry["visible"] = .bool(body.visible && body.canShow)
            entry["shown"] = .bool(!body.container.isHidden)
            entry["painted"] = .bool(body.painted)
            entry["covered"] = .bool(body.cover != nil)
            entry["z"] = .number(Double(body.z))
            entry["firstResponder"] = .bool(window.firstResponder === body.webView)
            entry["start"] = .string(body.warm ? "warm" : "cold")
            entry["readyMs"] = body.readyMs.map(JSONValue.number) ?? .null
            entry["opacity"] = .number(Double(opacity))
            entry["presentedFrame"] = Self.json(presentedRect(body))
            entry["beatsPlanId"] = body.beats.map { .number(Double($0.planId)) } ?? .null
            entry["crossing"] = body.lastCrossing?.json ?? .null
            entry["pageSize"] = .object([
                "width": .number(body.webView.frame.width), "height": .number(body.webView.frame.height),
            ])
            entry["displayPeriodMs"] = .number(displayPeriodSec * 1000)
            entry["url"] = body.webView.url.map { .string($0.absoluteString) } ?? .null
            return .object(entry)
        }
    }

    /// A rect as the harness reads one: `{x, y, width, height}`.
    private static func json(_ rect: CGRect) -> JSONValue {
        .object([
            "x": .number(rect.minX), "y": .number(rect.minY),
            "width": .number(rect.width), "height": .number(rect.height),
        ])
    }

    /// The container where the user sees it: its live frame, which a card in
    /// the host's hand holds away from its last placement, or its
    /// presentation layer's read through the mapping a plan solved.
    private func presentedRect(_ body: Body) -> CGRect {
        // The container as it stands, which a card in the host's hand holds
        // away from its last placement; the presentation layer's, mapped,
        // once a plan has solved the mapping.
        var rect = body.container.frame
        if let mapping = body.mapping, let presented = body.container.layer?.presentation() {
            rect = mapping.frame(position: presented.position, bounds: presented.bounds)
        }
        return rect
    }

    // MARK: - Calls into pages

    private func notifyShell(_ report: BodyStateReport) {
        window.sendToShell(.bodyState(report))
    }

    private func send(_ message: ToPage, to body: Body) {
        window.hostChannel.send(message, to: body.webView)
    }
}

/// A body's last crossing, as the harness reads it: its plan and size, how
/// far ahead of the first moving beat the body was ready, whether a whole
/// card that shrinks kept its page to the land, the surface it wore, and
/// whether the page was given back its container's bounds.
struct CrossingAccount: Equatable {
    var planId: Int
    var size: CGSize
    var readyLeadMs: Double?
    var heldToLand = false
    var surface: [Double]?
    var restored = false

    init(planId: Int, size: CGSize) {
        self.planId = planId
        self.size = size
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "planId": .number(Double(planId)),
            "width": .number(size.width),
            "height": .number(size.height),
            "readyLeadMs": readyLeadMs.map(JSONValue.number) ?? .null,
        ]
        if heldToLand { fields["heldToLand"] = .bool(true) }
        if let surface { fields["surface"] = .array(surface.map(JSONValue.number)) }
        if restored { fields["restored"] = .bool(true) }
        return .object(fields)
    }
}
