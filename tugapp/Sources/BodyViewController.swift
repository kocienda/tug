import AppKit
import QuartzCore
import WebKit

/// The view every body container lives in: flipped, so a container's frame is
/// the top-left viewport rect the shell measured, filling the window's
/// container beneath the shell's web view and above the splash.
final class BodyHostView: NSView {
    override var isFlipped: Bool { true }

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

    /// Never a hit of its own: a point between bodies is the shell's, and a
    /// point inside a container is answered by the container's web view.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }
}

/// The window's content view, which holds the shell's web view, the bodies
/// and the floor. Its accessibility children are the order VoiceOver reads
/// the window in: subview order would put the bodies, beneath the shell,
/// first and in stacking order. `accessibilityOrder` replaces that with the
/// shell's view and then each showing body in the shell's pane order; nil
/// leaves AppKit's own answer, as on a host that makes no bodies.
final class DeckContainerView: NSView {
    var accessibilityOrder: [Any]? {
        didSet { NSAccessibility.post(element: self, notification: .layoutChanged) }
    }

    override func accessibilityChildren() -> [Any]? {
        accessibilityOrder ?? super.accessibilityChildren()
    }
}

/// The deck's canvas beneath the bodies: the canvas colour and the grid,
/// drawn by the host from the shell's `floorGrid` so the shell paints no
/// floor of its own and cuts nothing for a body to show through. It sits
/// above the splash and below the bodies, hidden until the shell's first
/// `floorGrid` and the window's reveal — shown at window creation, its
/// opaque canvas would cover the splash.
final class DeckFloorView: NSView {
    var grid = FloorGrid() {
        didSet { if grid != oldValue { needsDisplay = true } }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        needsDisplay = true
    }

    /// The canvas, then the horizontal lines, then the vertical ones, each
    /// composited over what is beneath — where two lines cross, the grid's
    /// alpha lands twice, as the page's two gradients do. Filled rects from
    /// `FloorGrid.lines`, never a pattern image, so no tile rounding is
    /// invented here.
    override func draw(_ dirtyRect: NSRect) {
        nsColor(grid.canvas).setFill()
        dirtyRect.fill()
        let scale = window?.backingScaleFactor ?? 2
        let lines = grid.lines(in: bounds.size, scale: scale)
        nsColor(grid.grid).setFill()
        let left = FloorGrid.roundToDevicePixel(CGFloat(grid.originX), scale: scale)
        let top = FloorGrid.roundToDevicePixel(CGFloat(grid.originY), scale: scale)
        for y in lines.ys {
            NSRect(x: left, y: y, width: bounds.width - left, height: lines.width).fill(using: .sourceOver)
        }
        for x in lines.xs {
            NSRect(x: x, y: top, width: lines.width, height: bounds.height - top).fill(using: .sourceOver)
        }
    }

    /// Never a hit: the floor is paint, and a point on it is the shell's.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func nsColor(_ c: FloorGrid.RGBA) -> NSColor {
        NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
    }
}

/// A body's container: layer-backed, corner-clipped, carrying its stacking
/// order and its creation serial for `BodyHostView.sortContainers`.
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
/// WebContent process, placed by the host beneath the transparent shell.
///
/// A body's life (`loading → connected → bound → ready → painted → visible /
/// hidden → destroyed`, with `failed` from any state before ready at the
/// deadline and on a second WebContent termination within ten seconds) is
/// kept here, and the shell hears of every transition that matters to it
/// through `window.__tugBridge.onBodyState`. The shell decides what each body
/// is for (`bodyCreate`) and where it stands (`placeBodies`); this object
/// makes the views, binds them, places them, shows them, and tears them down.
/// Its message handlers are `MainWindow`'s, which routes a message by the
/// view that sent it.
///
/// **Showing is the shell's reveal, not the host's.** A body is beneath the
/// shell page, and what the shell paints over its rect is a lid in the pane's
/// own surface colour until the body is on screen (`lib/body-placement.ts`).
/// So the host does not fade a container in — a fade would be a fade from
/// the floor beneath it, the canvas showing through — it shows a placed,
/// painted body at once, under the lid, and reports `shown` to the shell,
/// which lifts the lid in its own frame. `painted` is the body's word that
/// its first frame of real content has gone to the compositor; `ready`
/// alone is the card mounted and quiet, and a container shown on `ready`
/// can be composited empty.
///
/// **The floor is the host's.** The canvas colour and the grid beneath the
/// bodies are a `DeckFloorView` this object shows from the shell's
/// `floorGrid`, and the shell stands its own canvas down on `floorShown`.
///
/// **A body moves with its chrome.** A settle that moves a body's pane posts
/// a `beatPlan`, and `runPlan` carries the container through each beat as
/// Core Animation on the chrome's curve from the chrome's start: one track
/// per property per body over the whole plan, the container's model at the
/// landing. It reports `landed` when the track runs out, and
/// `beatsCancelled` when a placement elsewhere or a newer plan takes it.
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
        var intent: [String: Any]?
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
        var canShow: Bool { painted && (state == .ready || state == .bound) }
        /// The card draws its pane's chrome in its own page: its container
        /// is the pane's rect outset by the apron, clips no corner, wears no
        /// surface, and answers a point by the card's hit shape.
        var whole = false
        /// An inactive card of a whole card's pane, placed at the pane and
        /// hidden by opacity, never `isHidden`, so it keeps painting and a
        /// tab switch shows a page that has drawn its new chrome.
        var sibling = false
        /// A whole card's pane within its view, as the last placement said
        /// it: the apron plus what the view's growth to whole points added.
        /// Handed to the page, which lays its pane out at exactly these.
        var insets: [String: Double]?
        /// The shell has been told this showing (`shown`); cleared on hide.
        var shownReported = false
        /// The frame the last placement gave it, viewport coordinates.
        var frame: CGRect = .zero
        /// Its pane's resize handles from the last placement, viewport
        /// coordinates: the shell's points over the body.
        var grips: [CGRect] = []
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
        /// The page's surface as it last posted it, which the container wears
        /// behind a content box, never behind a whole card.
        var surface: CGColor?
        var deadline: DispatchWorkItem?
        var lastTermination: Date?
        /// The beat plan carrying the body now, until it lands or is
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
        var lastCrossing: [String: Any]?
        /// How the container's frame maps to its layer's geometry, solved at
        /// the body's last plan; nil before one.
        var mapping: LayerMapping?

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
    /// The canvas beneath the bodies; nil on a host that makes none.
    let floorView: DeckFloorView?
    /// When the window began revealing the shell over the splash, or nil
    /// before it has: until then the floor may not show, or it would cover
    /// the splash first.
    private var revealedAt: CFTimeInterval?
    /// The window's reveal fade, which the floor joins on the same clock.
    private var revealFade: CAAnimation?
    /// The shell has posted a `floorGrid`, so the floor has something to draw.
    private var floorDescribed = false
    private(set) var bodies: [Body] = []
    private(set) var region = BodyHitRegion()
    private var radius: CGFloat = 0
    /// The spare's pending creation, so a burst of readies makes one.
    private var pendingSpare: DispatchWorkItem?
    /// Creation order, for a stable stacking among bodies at one z.
    private var serials = 0
    /// A `shown` report is pending for the bodies that turned showing.
    private var shownReportScheduled = false
    #if DEBUG
    /// `TUG_BODY_FORCE_STALL=<n>` suppresses the first `n` bodies'
    /// `frontendReady`, so a test can watch the deadline fail them — once
    /// for the shell's own retry, twice for the card's placard. DEBUG-only.
    private var readiesToStall = Int(ProcessInfo.processInfo.environment["TUG_BODY_FORCE_STALL"] ?? "") ?? 0
    #endif

    init(window: MainWindow, hostView: BodyHostView, floorView: DeckFloorView?) {
        self.window = window
        self.hostView = hostView
        self.floorView = floorView
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
        body(forCard: cardId)?.webView
    }

    // MARK: - Create and bind

    /// The shell asks for a card's body. The waiting spare takes it when
    /// there is one; otherwise a body is made cold at `/?body=<cardId>`. A
    /// card that already has a body is re-bound only if it failed.
    func create(cardId: String, componentId: String, intent: [String: Any]) {
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
            armDeadline(spare)
            if spare.state == .connected { bind(spare) }
            return
        }
        guard let made = make(cardId: cardId, path: "/?body=\(cardId)") else { return }
        made.componentId = componentId
        made.intent = intent
        armDeadline(made)
    }

    /// Make the spare: a body loaded at `/?body=spare`, connected and waiting
    /// for the next card. The caller decides when.
    func createSpare() {
        guard spare == nil else { return }
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
        container.layer?.cornerRadius = radius
        // Only the two corners that meet the pane's own rounded corners: the
        // content box's top corners stand under the masthead, square, and a
        // radius there showed the floor through them. A layer's corners are
        // named in its own geometry, which follows its view's: the container
        // is flipped, so its max-Y corners are the bottom ones (an unflipped
        // container rounded its top with this pair, read off the composite).
        container.layer?.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
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
        let payload: [String: Any] = [
            "cardId": cardId,
            "componentId": componentId,
            "intent": intent,
            "facts": window.bodyFacts(),
        ]
        evaluate(call: "window.__tugBridge?.onBodyBind?.", payload: payload, in: body.webView)
        // A page bound afresh — a reload, a spare taking a card — has not
        // been told where its pane stands in its view.
        if let insets = body.insets {
            evaluate(call: "window.__tugBridge?.onCardInsets?.", payload: insets, in: body.webView)
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
        notifyShell(["cardId": cardId, "state": "ready", "readyMs": readyMs, "start": body.warm ? "warm" : "cold"])
        // The spare this body may have taken is replaced once it has painted.
        scheduleSpare()
    }

    /// A body posted `painted`: the frame carrying its card's content has
    /// gone to the compositor. From here a placement that names it visible
    /// shows it.
    func didPaint(_ body: Body) {
        guard let cardId = body.cardId, body.state == .ready || body.state == .bound, !body.painted else { return }
        body.painted = true
        TugLog.info("bodies", "painted", [TugLog.field("card", cardId)])
        notifyShell(["cardId": cardId, "state": "painted"])
        applyVisibility(body)
        reportShown()
    }

    // MARK: - Placement

    /// `placeBodies`: every body's frame and whether it shows. A body the
    /// placement does not name is hidden.
    func place(_ payload: [String: Any]) {
        if let r = (payload["radius"] as? NSNumber)?.doubleValue { radius = CGFloat(r) }
        var named: [String: (CGRect, [CGRect], Bool, Int, Int, Bool, Bool)] = [:]
        var insetsByCard: [String: [String: Double]] = [:]
        for (index, entry) in (payload["bodies"] as? [[String: Any]] ?? []).enumerated() {
            guard let cardId = entry["cardId"] as? String,
                  let frame = BodyHitRegion.rect(fromPayload: entry) else { continue }
            let grips = (entry["grips"] as? [[String: Any]] ?? []).compactMap(BodyHitRegion.rect(fromPayload:))
            named[cardId] = (
                frame, grips, entry["visible"] as? Bool ?? false, (entry["z"] as? NSNumber)?.intValue ?? 0, index,
                entry["whole"] as? Bool ?? false, entry["sibling"] as? Bool ?? false
            )
            if let insets = entry["insets"] as? [String: Any] {
                insetsByCard[cardId] = insets.compactMapValues { ($0 as? NSNumber)?.doubleValue }
            }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for body in bodies {
            // A card in the host's hand is the host's until its gesture ends:
            // the placement that lands it is the shell's commit, after.
            if let gesture, gesture.carriesView, gesture.body === body { continue }
            // And so is one a press took from its beats, until the press
            // becomes a gesture or comes up.
            if body === pressedOutOfBeats { continue }
            guard let cardId = body.cardId, let (frame, grips, visible, z, deckIndex, whole, sibling) = named[cardId] else {
                cancelBeats(body)
                body.visible = false
                body.sibling = false
                applyVisibility(body)
                continue
            }
            setWhole(body, whole)
            body.sibling = sibling
            if whole, let insets = insetsByCard[cardId], insets != body.insets {
                body.insets = insets
                evaluate(call: "window.__tugBridge?.onCardInsets?.", payload: insets, in: body.webView)
            }
            // A placement that names a carried body anywhere but its landing
            // — a drag taking its frame mid-settle — takes it from its beats.
            // The landing itself, which the shell adopts as posted, leaves
            // the beats running.
            if let beats = body.beats, !visible || !Self.near(frame, beats.landing) {
                cancelBeats(body)
            }
            body.frame = frame
            body.grips = grips
            body.container.frame = frame
            body.visible = visible
            body.z = z
            body.container.order = z
            body.deckIndex = deckIndex
            applyVisibility(body)
        }
        // The containers in the panes' order, back to front, moved in place.
        hostView.sortContainers()
        CATransaction.commit()
        refreshRegion()
        reportShown()
    }

    /// Show a painted body placed visible, at once and in full; hide
    /// anything else. The reveal the user sees is the shell's lid lifting
    /// after `shown`, so nothing here animates.
    private func applyVisibility(_ body: Body) {
        let showing = body.visible && body.canShow
        guard let layer = body.container.layer else { return }
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
                body.shownReported = false
                refreshRegion()
                return
            }
            // Shown before: hide it as any hidden page is, so WebKit
            // throttles a parked or folded body.
            body.container.isHidden = true
            body.shownReported = false
        } else {
            body.container.passesPointer = true
            layer.opacity = 0
            body.shownReported = false
        }
        refreshRegion()
    }

    /// Tell the shell of every body that is showing and has not been told
    /// of: on the next turn of the run loop, after the transaction that
    /// showed it has gone to the render server, so the shell's lid never
    /// lifts over a container the compositor has not yet drawn.
    private func reportShown() {
        if shownReportScheduled { return }
        shownReportScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.shownReportScheduled = false
            for body in self.bodies {
                guard let cardId = body.cardId, !body.shownReported,
                      body.visible, body.canShow else { continue }
                body.shownReported = true
                self.notifyShell(["cardId": cardId, "state": "shown"])
            }
        }
    }

    /// `pointerClaim`: the shell's surfaces over the bodies.
    func claim(_ payload: [String: Any]) {
        region.claim = BodyHitRegion.claim(fromPayload: payload)
    }

    private func refreshRegion() {
        region.visibleFrames = visibleBodies.map(\.frame)
        region.visibleGrips = visibleBodies.map(\.grips)
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
    private func refreshAccessibilityOrder() {
        let ordered = bodiesInDeckOrder
        let ids = ordered.compactMap(\.cardId)
        if ids == orderedAccessibility { return }
        orderedAccessibility = ids
        window.setAccessibilityOrder(bodies: ordered.map(\.webView))
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

    /// Whether a viewport point belongs to a body rather than to the shell.
    func passesThrough(_ point: CGPoint) -> Bool {
        regionNow.passesThrough(point)
    }

    /// The hit region as the screen shows it now. A whole card a settle is
    /// carrying, or that a press has taken out of one, answers where it stands
    /// on screen, not at the landing its placement names: a press on its title
    /// bar mid-slide is a press on the card, as the user sees it there.
    private var regionNow: BodyHitRegion {
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
    /// the pane is free, its resize floor, and the plan that lands it.
    struct CardPlacement: Equatable {
        var rect: CGRect
        var visible: Bool
        var sibling: Bool
        var z: Int
        var grips: Set<ResizeEdge>
        var free: Bool
        var min: CGSize
        var planId: Int?
    }

    /// The cards the last `placeCards` named, by card id. Read by the
    /// gesture tracker for its envelope; nothing is shown from it yet.
    private(set) var cardPlacements: [String: CardPlacement] = [:]
    /// The canvas the cards stand on, viewport points, and the zoom its
    /// layout is drawn at; nil before the shell has said.
    private(set) var cardCanvas: CGRect?
    private var cardZoom: CGFloat = 1
    private(set) var cardApron: CGFloat = CardGeometry.apron

    /// The gesture the host is tracking now, one at a time.
    private struct Gesture {
        let body: Body
        let cardId: String
        let kind: String
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
        var carriesView: Bool { kind != "rail" }
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

    /// `cardLand`: a card the hand carried and dropped where the shell
    /// committed nothing — back on its own place — goes back to the landing
    /// its placement already names, since no new placement will come.
    func landCard(cardId: String) {
        guard let body = body(forCard: cardId), gesture?.body !== body else { return }
        returnToLanding(body)
    }

    /// Carry a card a press held, and nothing then moved, on to its landing.
    private func returnToLanding(_ body: Body) {
        guard !Self.near(body.container.frame, body.frame) else { return }
        let landing = body.frame
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            body.container.animator().frame = landing
        }
    }

    /// `placeCards`: every card's pane rect and how its view is held. The
    /// rect is the pane's; its view is outset from it by `apron`.
    func placeCards(_ payload: [String: Any]) {
        if let apron = (payload["apron"] as? NSNumber)?.doubleValue { cardApron = CGFloat(apron) }
        if let canvas = (payload["canvas"] as? [String: Any]).flatMap(BodyHitRegion.rect(fromPayload:)) {
            cardCanvas = canvas
        }
        if let zoom = (payload["zoom"] as? NSNumber)?.doubleValue, zoom > 0 { cardZoom = CGFloat(zoom) }
        var placements: [String: CardPlacement] = [:]
        for entry in payload["cards"] as? [[String: Any]] ?? [] {
            guard let cardId = entry["cardId"] as? String,
                  let rect = BodyHitRegion.rect(fromPayload: entry) else { continue }
            let min = entry["min"] as? [String: Any]
            placements[cardId] = CardPlacement(
                rect: rect,
                visible: entry["visible"] as? Bool ?? false,
                sibling: entry["sibling"] as? Bool ?? false,
                z: (entry["z"] as? NSNumber)?.intValue ?? 0,
                grips: Set((entry["grips"] as? [String] ?? []).compactMap(ResizeEdge.init(rawValue:))),
                free: entry["free"] as? Bool ?? false,
                min: CGSize(
                    width: (min?["width"] as? NSNumber)?.doubleValue ?? 0,
                    height: (min?["height"] as? NSNumber)?.doubleValue ?? 0
                ),
                planId: (entry["planId"] as? NSNumber)?.intValue
            )
        }
        cardPlacements = placements
        refreshRegion()
    }

    /// The pointer where the window last saw it, in viewport points.
    private var pointerInViewport: CGPoint {
        hostView.convert(window.mouseLocationOutsideOfEventStream, from: nil)
    }

    /// `cardGesture` `begin`: a card's page has taken a title-bar or grip
    /// press, and the host is to carry the card until the mouse comes up. A
    /// press whose mouse-up beat the message here ends at once, as a click,
    /// so no gesture is left open waiting for an up that has already passed.
    func claimGesture(from body: Body, payload: [String: Any]) {
        guard payload["phase"] as? String == "begin", let cardId = body.cardId, gesture == nil else { return }
        let named = payload["kind"] as? String
        let kind = named == "resize" || named == "rail" ? named! : "move"
        let edge = (payload["edge"] as? String).flatMap(ResizeEdge.init(rawValue:))
        if kind != "move" && edge == nil { return }
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
        var pointer = pointerInViewport
        if let x = (payload["x"] as? NSNumber)?.doubleValue, let y = (payload["y"] as? NSNumber)?.doubleValue {
            pointer = body.webView.convert(CGPoint(x: x, y: y), to: hostView)
        }
        let others = cardPlacements
            .filter { $0.key != cardId && $0.value.visible && !$0.value.sibling }
            .map(\.value.rect)
        let tracker = CardGestureTracker(
            kind: kind == "resize" ? edge.map { .resize($0) } ?? .move : .move,
            startRect: startRect,
            startPointer: pointer,
            canvas: cardCanvas ?? hostView.bounds,
            zoom: cardZoom,
            minSize: placement?.min ?? .zero,
            free: placement?.free ?? true,
            others: others
        )
        let meta = payload["meta"] as? Bool ?? false
        let alt = payload["alt"] as? Bool ?? false
        let pressed = Gesture(
            body: body, cardId: cardId, kind: kind, edge: edge, tracker: tracker,
            containerStart: containerStart, meta: meta, alt: alt,
            last: CardGestureTracker.Step(rect: startRect, moved: false), pointer: pointer
        )
        guard leftButtonDown else {
            report(pressed, phase: "end")
            if pressedOutOfBeats === body {
                pressedOutOfBeats = nil
                returnToLanding(body)
            }
            return
        }
        gesture = pressed
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
            report(live, phase: "move")
        case .leftMouseUp:
            // The release is where the hand let go, which a quick drag's
            // merged moves may never have reported: step to it first, so a
            // press and a release apart with nothing between them is a drag.
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
            if live.carriesView { move(live) }
            gesture = nil
            report(live, phase: "end")
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
        report(live, phase: "cancel")
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

    /// Tell the shell where the gesture stands (`__tugBridge.onCardGesture`).
    private func report(_ live: Gesture, phase: String) {
        let r = live.last.rect
        var payload: [String: Any] = [
            "cardId": live.cardId,
            "kind": live.kind,
            "phase": phase,
            "rect": ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height],
            "pointer": ["x": live.pointer.x, "y": live.pointer.y],
            "start": ["x": live.tracker.startPointer.x, "y": live.tracker.startPointer.y],
            "moved": live.last.moved,
            "meta": live.meta,
            "alt": live.alt,
        ]
        if let edge = live.edge { payload["edge"] = edge.rawValue }
        if live.last.snapX != nil || live.last.snapY != nil {
            payload["snap"] = ["x": live.last.snapX.map { $0 as Any } ?? NSNull(), "y": live.last.snapY.map { $0 as Any } ?? NSNull()]
        }
        window.evaluateInShell(call: "window.__tugBridge?.onCardGesture?.", payload: payload)
    }

    // MARK: - Beats

    /// The animation keys a plan's tracks run under: one per property, so a
    /// later plan's track replaces an earlier one's, and cancelling is
    /// removing three keys.
    private static let beatKeys = ["beats-position", "beats-bounds", "beats-opacity"]

    /// `beatPlan`: carry each named body through its beats as Core
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
    func runPlan(_ payload: [String: Any]) {
        guard let plan = BeatPlan.from(payload: payload) else { return }
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        let offsetSec = window.bodyBeatOffsetPeriods * displayPeriodSec
        var showsArrival = false
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for planned in plan.bodies {
            guard let body = body(forCard: planned.cardId) else { continue }
            // A card in the host's hand is the hand's until the gesture ends.
            if let gesture, gesture.carriesView, gesture.body === body { continue }
            // An arrival rides its frame's arrive beat in: the shell posts it
            // visible from the plan and has already lifted its lid, so it is
            // shown here, in this transaction, at its landing. Its tracks
            // hold their opening values until they begin (`.backwards`), so
            // no frame shows it before the fade; and a plan the host cannot
            // run still leaves it shown where it lands.
            if planned.arrives == true, !body.visible, body.canShow {
                body.visible = true
                body.frame = planned.landing.cgRect
                body.container.frame = planned.landing.cgRect
                applyVisibility(body)
                showsArrival = true
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
            let begin = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: track.delayMs, offsetSec: offsetSec)
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
                self.notifyShell(["cardId": cardId, "state": "landed", "planId": planId, "lateMs": beats.lateMs])
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
                let from = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: beat.delayMs, offsetSec: offsetSec)
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
                let moveBegin = anchor.beginTime(startWallMs: plan.startWallMs, delayMs: firstMove, offsetSec: offsetSec)
                body.crossing = (crossing, moveBegin)
                body.lastCrossing = [
                    "planId": planId, "width": crossing.width, "height": crossing.height,
                    "readyLeadMs": NSNull(),
                ]
                // Tell the body now, in this task, so it pins its scrollers
                // and acknowledges inside a display period: one hop to its
                // page and one back, never a round trip through tugcast.
                let spanMs = planned.beats.map { $0.delayMs + $0.durationMs }.max() ?? 0
                evaluate(call: "window.__tugBridge?.onBodyCrossing?.", payload: [
                    "phase": "begin", "width": crossing.width, "height": crossing.height, "durationMs": spanMs,
                ], in: body.webView)
            }
        }
        CATransaction.commit()
        refreshRegion()
        if showsArrival { reportShown() }
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
            notifyShell(["cardId": cardId, "state": "beatsCancelled", "planId": beats.planId])
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
            notifyShell(["cardId": cardId, "state": "beatsCancelled", "planId": planId])
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
    /// floor beneath.
    func crossingReady(_ body: Body, surface: [NSNumber]?) {
        guard let crossing = body.crossing else { return }
        let leadMs = (crossing.begin - CACurrentMediaTime()) * 1000
        body.lastCrossing?["readyLeadMs"] = leadMs
        // A whole card's page is the card, chrome and all, and it wears no
        // surface behind it: given its smaller landing size now, the card
        // would stand at its landing for the whole motion over the floor the
        // container still spans. So a whole card that shrinks keeps its page
        // and the container clips it as it travels; the page takes the
        // landing size at the land. One that grows takes it now, as any
        // body does, and the container reveals it.
        let page = body.webView.frame.size
        if body.whole, crossing.size.width < page.width - 0.5 || crossing.size.height < page.height - 0.5 {
            body.lastCrossing?["heldToLand"] = true
            return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let surface, surface.count == 4, !body.whole {
            let c = surface.map { CGFloat($0.doubleValue) / 255 }
            body.container.surface = CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
            body.container.displayIfNeeded()
            body.lastCrossing?["surface"] = surface.map(\.doubleValue)
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
        body.lastCrossing?["restored"] = true
        body.webView.frame = body.container.bounds
        body.webView.autoresizingMask = Self.pageResizing
        evaluate(call: "window.__tugBridge?.onBodyCrossing?.", payload: ["phase": "land"], in: body.webView)
    }

    /// `bodySurface`: the page's background as sRGB bytes, posted when it
    /// paints and whenever its theme changes. The container wears it behind
    /// the web view for as long as the body stands.
    func setSurface(_ body: Body, surface: [NSNumber]?) {
        guard let surface, surface.count == 4 else { return }
        let c = surface.map { CGFloat($0.doubleValue) / 255 }
        body.surface = CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
        if !body.whole { body.container.surface = body.surface }
    }

    /// Hold the body's container as a whole card's view, or as a content box
    /// under the shell's chrome: a whole card's page draws its own corners
    /// and surface, and its apron must show what is beneath it.
    private func setWhole(_ body: Body, _ whole: Bool) {
        body.whole = whole
        body.container.layer?.cornerRadius = whole ? 0 : radius
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

    /// The display period of the screen the window is on, seconds: the
    /// unit the beat offset is counted in. 60 Hz when the window has no
    /// screen yet.
    private var displayPeriodSec: Double {
        let fps = window.screen?.maximumFramesPerSecond ?? 60
        return 1 / Double(max(1, fps))
    }

    /// Two rects within half a point of each other on every edge.
    private static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 0.5 && abs(a.minY - b.minY) < 0.5
            && abs(a.width - b.width) < 0.5 && abs(a.height - b.height) < 0.5
    }

    // MARK: - The floor

    /// `floorGrid`: the canvas and grid the floor draws. The floor shows
    /// once the window reveals the shell; then the shell is told
    /// `floorShown` on the next turn of the run loop, after the transaction
    /// that showed it has gone to the render server, and only then stands
    /// its own canvas down. Every `floorGrid` is answered, not only the one
    /// that shows the floor: a reloaded shell paints its own canvas over a
    /// floor already up, and waits for the answer like the first did.
    func floor(_ payload: [String: Any]) {
        guard let floorView, let grid = FloorGrid.from(payload: payload) else { return }
        floorView.grid = grid
        floorDescribed = true
        guard revealedAt != nil else { return }
        showFloor()
    }

    /// The window is revealing the shell over the splash with `fade`. The
    /// floor fades in with it, on the fade's own clock, so the splash gives
    /// way to the deck as one picture: a floor already described starts
    /// with the fade, and one described while it runs — the shell posts its
    /// grid when the deck mounts, which can land after the reveal begins —
    /// joins it mid-way at the opacity the shell has reached. After the
    /// fade a floor shows at once, beneath a shell already opaque.
    func shellDidReveal(fade: CAAnimation) {
        revealedAt = CACurrentMediaTime()
        revealFade = fade
        guard floorDescribed else { return }
        showFloor()
    }

    /// `floorShown` carries how long after the reveal began the floor
    /// showed, so a reading can tell that it never stood over the splash.
    private func showFloor() {
        guard let floorView, let revealedAt else { return }
        var sinceRevealMs: Double?
        if floorView.isHidden {
            floorView.isHidden = false
            let now = CACurrentMediaTime()
            if let layer = floorView.layer, let fade = revealFade?.copy() as? CAAnimation,
               now - revealedAt < fade.duration {
                fade.beginTime = layer.convertTime(revealedAt, from: nil)
                layer.add(fade, forKey: "revealFade")
            }
            sinceRevealMs = (now - revealedAt) * 1000
        }
        DispatchQueue.main.async { [weak self] in
            var report: [String: Any] = ["state": "floorShown"]
            if let sinceRevealMs { report["sinceRevealMs"] = sinceRevealMs }
            self?.notifyShell(report)
        }
    }

    // MARK: - Focus

    /// `bodyFocus`: the named card's body takes the keyboard, or the shell
    /// does when the card has none.
    func focus(cardId: String?) {
        keyboardCardId = cardId
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
    /// body, or the shell.
    func focusKeyboardOwner() {
        focus(cardId: keyboardCardId)
    }

    // MARK: - Teardown

    /// `bodyDestroy`. With `save`, the body writes its card's state first.
    func destroy(cardId: String, save: Bool) {
        guard let body = body(forCard: cardId) else { return }
        guard save else {
            remove(body)
            return
        }
        body.webView.evaluateJavaScript("window.tugdeck?.saveState?.()") { [weak self] _, _ in
            self?.remove(body)
        }
    }

    /// Every body, at once. Used where the window's bridge is taken down.
    func destroyAll() {
        pendingSpare?.cancel()
        pendingSpare = nil
        for body in bodies { remove(body) }
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
            body.webView.evaluateJavaScript("window.tugdeck?.saveState?.()") { _, _ in
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
        // A card going away mid-gesture takes its gesture with it.
        if gesture?.body === body { gesture = nil }
        bodies.removeAll { $0 === body }
        let controller = body.webView.configuration.userContentController
        for name in MainWindow.bridgeHandlerNames {
            controller.removeScriptMessageHandler(forName: name)
        }
        body.webView.navigationDelegate = nil
        body.webView.uiDelegate = nil
        body.webView.stopLoading()
        body.container.removeFromSuperview()
        if let cardId = body.cardId {
            window.bodyDidGoAway(cardId: cardId)
        }
        refreshRegion()
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
            notifyShell(["cardId": cardId, "state": "failed", "cause": cause])
        }
    }

    /// A body's WebContent process died. It is loaded afresh and re-bound to
    /// restore its card — `load`, not `reload()`, which a terminated view
    /// with a nil `url` ignores — once per window; a second death inside the
    /// window fails it. Returns false for a view that is not a body.
    func webContentProcessDidTerminate(_ webView: WKWebView) -> Bool {
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
        body.intent = (body.intent?["kind"] as? String) == "mount" ? ["kind": "mount"] : ["kind": "restore"]
        body.warm = false
        body.painted = false
        body.shownReported = false
        notifyShell(["cardId": cardId, "state": "terminated"])
        armDeadline(body)
        webView.load(URLRequest(url: url))
        return true
    }

    // MARK: - Harness

    /// Every body as the harness reports it, the spare included.
    func snapshot() -> [[String: Any]] {
        bodies.map { body -> [String: Any] in
            var entry: [String: Any] = [
                "cardId": body.cardId ?? NSNull(),
                "state": body.state.rawValue,
                "frame": [
                    "x": body.frame.minX, "y": body.frame.minY,
                    "width": body.frame.width, "height": body.frame.height,
                ],
                "visible": body.visible && body.canShow,
                "painted": body.painted,
                "z": body.z,
                "firstResponder": window.firstResponder === body.webView,
                "start": body.warm ? "warm" : "cold",
                "readyMs": body.readyMs ?? NSNull(),
                "opacity": Double(body.container.layer?.presentation()?.opacity
                    ?? body.container.layer?.opacity ?? 0),
                "presentedFrame": presentedFrame(body),
                "beatsPlanId": body.beats?.planId ?? NSNull(),
                "crossing": body.lastCrossing ?? NSNull(),
                "pageSize": ["width": body.webView.frame.width, "height": body.webView.frame.height],
                "beatOffsetPeriods": window.bodyBeatOffsetPeriods,
                "displayPeriodMs": displayPeriodSec * 1000,
                "url": body.webView.url?.absoluteString ?? NSNull(),
            ]
            // Set apart from the literal, which is already at the edge of
            // what the type checker will solve in reasonable time.
            entry["componentId"] = body.componentId ?? NSNull()
            return entry
        }
    }

    /// Where the render server has the body's container now, viewport
    /// coordinates: its presentation layer read back through the mapping
    /// its last plan solved; its placed frame when it has never been planned.
    private func presentedFrame(_ body: Body) -> [String: Double] {
        let rect = presentedRect(body)
        return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
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

    private func notifyShell(_ payload: [String: Any]) {
        window.evaluateInShell(call: "window.__tugBridge?.onBodyState?.", payload: payload)
    }

    private func evaluate(call function: String, payload: [String: Any], in webView: WKWebView) {
        guard let script = BodyViewController.script(calling: function, with: payload) else { return }
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                TugLog.warn("bodies", "call into a body failed", [
                    TugLog.field("call", function),
                    TugLog.field("error", error.localizedDescription),
                ])
            }
        }
    }

    /// `<function>(JSON.parse("<payload as a JSON string>"))`: the payload is
    /// serialized twice so arbitrary strings, U+2028 included, survive as a
    /// JS string literal.
    static func script(calling function: String, with payload: [String: Any]) -> String? {
        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: json, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: jsonString, options: [.fragmentsAllowed]),
              let quotedString = String(data: quoted, encoding: .utf8) else { return nil }
        return "\(function)(JSON.parse(\(quotedString)))"
    }
}
