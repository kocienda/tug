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

/// A body's container: layer-backed, corner-clipped, carrying its stacking
/// order and its creation serial for `BodyHostView.sortContainers`.
final class BodyContainerView: NSView {
    var order = 0
    let serial: Int
    init(serial: Int) {
        self.serial = serial
        super.init(frame: .zero)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
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
/// So the host does not fade a container in — a fade through the floor's
/// hole would be a fade from the window's background, which is the canvas
/// showing through — it shows a placed, painted body at once, under the
/// lid, and reports `shown` to the shell, which lifts the lid in its own
/// frame. `painted` is the body's word that its first frame of real content
/// has gone to the compositor; `ready` alone is the card mounted and quiet,
/// and a container shown on `ready` can be composited empty.
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
        /// The shell has been told this showing (`shown`); cleared on hide.
        var shownReported = false
        /// The frame the last placement gave it, viewport coordinates.
        var frame: CGRect = .zero
        /// The stacking order the last placement gave it: the pane's
        /// `z-index`. Containers are kept in this order, so where two panes
        /// overlap the body in front is the pane in front.
        var z: Int = 0
        var visible = false
        /// Whether the body has been shown once. Until it has, a hidden body
        /// is hidden by layer opacity, never `isHidden`, so WebKit keeps
        /// painting the frame the showing will reveal.
        var shownOnce = false
        var deadline: DispatchWorkItem?
        var lastTermination: Date?

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
    /// `TUG_BODY_FORCE_STALL=1` suppresses the first body's `frontendReady`,
    /// so a test can watch the deadline fail it. DEBUG-only.
    private var stallNextReady = ProcessInfo.processInfo.environment["TUG_BODY_FORCE_STALL"] == "1"
    #endif

    init(window: MainWindow, hostView: BodyHostView) {
        self.window = window
        self.hostView = hostView
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
    func create(cardId: String, intent: [String: Any]) {
        if let existing = body(forCard: cardId), existing.state != .failed {
            TugLog.warn("bodies", "bodyCreate for a card that has a body; ignoring", [
                TugLog.field("card", cardId),
            ])
            return
        }
        if let spare {
            spare.cardId = cardId
            spare.intent = intent
            spare.warm = true
            armDeadline(spare)
            if spare.state == .connected { bind(spare) }
            return
        }
        guard let made = make(cardId: cardId, path: "/?body=\(cardId)") else { return }
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
    /// lost. Only on a host that makes bodies.
    func scheduleSpare() {
        guard window.bodyViewsEnabled else { return }
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
        webView.navigationDelegate = window
        webView.uiDelegate = window
        webView.allowsBackForwardNavigationGestures = false
        webView.onActivationClick = { [weak window] location in
            window?.forwardActivationClick(at: location)
        }

        serials += 1
        let container = BodyContainerView(serial: serials)
        container.wantsLayer = true
        container.layer?.masksToBounds = true
        container.layer?.cornerRadius = radius
        // Only the two corners that meet the pane's own rounded corners: the
        // content box's top corners stand under the masthead, square, and a
        // radius there showed the floor through them. The host view is
        // flipped but its layer's geometry is not, so the layer's min-Y
        // corners are the bottom ones (read off the composite: naming the
        // max-Y pair rounded the top).
        container.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
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
        guard let cardId = body.cardId, let intent = body.intent else { return }
        body.state = .bound
        body.boundAt = CACurrentMediaTime()
        let payload: [String: Any] = [
            "cardId": cardId,
            "intent": intent,
            "facts": window.bodyFacts(),
        ]
        evaluate(call: "window.__tugBridge?.onBodyBind?.", payload: payload, in: body.webView)
    }

    /// A body posted `frontendReady`: its card is mounted and quiet. It is
    /// not shown yet — that waits for `painted`.
    func didBecomeReady(_ body: Body) {
        guard let cardId = body.cardId, body.state != .failed else { return }
        #if DEBUG
        if stallNextReady {
            stallNextReady = false
            NSLog("BodyViewController: TUG_BODY_FORCE_STALL=1 — ignoring the first body's frontendReady")
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
        guard let cardId = body.cardId, body.state == .ready, !body.painted else { return }
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
        var named: [String: (CGRect, Bool, Int)] = [:]
        for entry in payload["bodies"] as? [[String: Any]] ?? [] {
            guard let cardId = entry["cardId"] as? String,
                  let frame = BodyHitRegion.rect(fromPayload: entry) else { continue }
            named[cardId] = (frame, entry["visible"] as? Bool ?? false, (entry["z"] as? NSNumber)?.intValue ?? 0)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for body in bodies {
            body.container.layer?.cornerRadius = radius
            guard let cardId = body.cardId, let (frame, visible, z) = named[cardId] else {
                body.visible = false
                applyVisibility(body)
                continue
            }
            body.frame = frame
            body.container.frame = frame
            body.visible = visible
            body.z = z
            body.container.order = z
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
        let showing = body.visible && body.state == .ready && body.painted
        guard let layer = body.container.layer else { return }
        if showing {
            let wasHidden = body.container.isHidden
            body.container.isHidden = false
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
            // Shown before: hide it as any hidden page is, so WebKit
            // throttles a parked or folded body.
            body.container.isHidden = true
            body.shownReported = false
        } else {
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
                      body.visible, body.state == .ready, body.painted else { continue }
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
    }

    private var visibleBodies: [Body] {
        // Front to back, so a point over two bodies answers the one in front.
        bodies.enumerated()
            .filter { $0.element.visible && $0.element.state == .ready && $0.element.painted }
            .sorted { a, b in a.element.z != b.element.z ? a.element.z > b.element.z : a.offset > b.offset }
            .map(\.element)
    }

    /// The body a viewport point passes through to, if any.
    func body(atViewportPoint point: CGPoint) -> Body? {
        guard let index = region.frameIndex(at: point) else { return nil }
        let visible = visibleBodies
        return index < visible.count ? visible[index] : nil
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

    /// Give up on a body: it is destroyed, and the shell mounts the card in
    /// its own document.
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
        body.intent = ["kind": "restore"]
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
        bodies.map { body in
            [
                "cardId": body.cardId ?? NSNull(),
                "state": body.state.rawValue,
                "frame": [
                    "x": body.frame.minX, "y": body.frame.minY,
                    "width": body.frame.width, "height": body.frame.height,
                ],
                "visible": body.visible && body.state == .ready && body.painted,
                "painted": body.painted,
                "z": body.z,
                "firstResponder": window.firstResponder === body.webView,
                "start": body.warm ? "warm" : "cold",
                "readyMs": body.readyMs ?? NSNull(),
                "opacity": Double(body.container.layer?.presentation()?.opacity
                    ?? body.container.layer?.opacity ?? 0),
                "url": body.webView.url?.absoluteString ?? NSNull(),
            ]
        }
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
