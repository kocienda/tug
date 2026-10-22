import AppKit

/// The host's hand: a card carried by its title bar or a grip, a rail's edge
/// dragged with its ghost and its spring, and a whole card a press took out
/// of its beats. One gesture at a time, from a page's `begin` until the
/// mouse comes up, Escape, or the window losing the mouse; each step is told
/// to the shell (`onCardGesture`), which commits it.
///
/// It owns the gesture and the press, and reads the last placement from the
/// controller, which leaves a card in the hand alone until its commit lands.
final class CardGestureCarrier {
    typealias Body = BodyViewController.Body

    private unowned let controller: BodyViewController
    private unowned let window: MainWindow

    init(controller: BodyViewController, window: MainWindow) {
        self.controller = controller
        self.window = window
    }

    private var bodies: [Body] { controller.bodies }
    private var hostView: BodyHostView { controller.hostView }
    private var cardPlacements: [String: BodyViewController.CardPlacement] { controller.cardPlacements }

    /// The gesture the host is tracking now, one at a time. Every kind
    /// carries its views: a move or a resize the card in hand's, and a
    /// rail's edge (`rail`) every member of the rail and every content card
    /// beside it, drawn at the aim the host reports with each step, which
    /// the shell's rail draft previews its stand-ins at.
    private struct Gesture {
        let body: Body
        let cardId: String
        let kind: CardGestureKind
        let edge: ResizeEdge?
        /// A move's or a resize's arithmetic; for a rail's edge it answers
        /// only the press point, and `rail` carries the steps.
        var tracker: CardGestureTracker
        /// The container's frame at the press, which every step moves by the
        /// pane rect's own travel.
        let containerStart: CGRect
        var meta: Bool
        var alt: Bool
        var last: CardGestureTracker.Step
        var pointer: CGPoint
        /// A rail's edge in hand; nil for a move or a resize.
        var rail: RailHand?
        /// Every body the gesture holds: the card in hand, or every card of
        /// the rail's panes and of the panes beside it, siblings included. A
        /// placement and a plan leave them where the hand has them.
        let held: [Body]

        func holds(_ body: Body) -> Bool { held.contains { $0 === body } }
    }
    private var gesture: Gesture?

    /// A rail width drag in the host's hand: the aim it tracks, the footprint
    /// its ghost grows from, and the spring a release past a limit runs. It
    /// moves no card: the release commits the width, and the settle the
    /// commit runs carries the members and the cards beside the rail.
    private struct RailHand {
        var tracker: RailWidthTracker
        let view: RailView
        /// The pane rect of the member pressed, viewport points.
        let startRect: CGRect
        /// The union of the moving members' pane rects at the press, viewport
        /// points: the footprint the ghost grows from.
        let panes: CGRect
        /// How long a release past a limit springs back, ms; 0 for none.
        let springMs: Double
        var springing = false
        var last: RailWidthTracker.Step
    }

    /// The spring's curve, `rail-width.ts`'s `LIMIT_SPRING_EASING`: a cubic
    /// Bézier's control points.
    private static let railSpringCurve = (x1: 0.33, y1: 1.0, x2: 0.68, y2: 1.0)
    /// The spring running now, so a tick that outlived its spring does nothing.
    private var springSerial = 0
    /// The display link stepping the spring, while one runs.
    private var springLink: CADisplayLink?

    /// Whether the gesture holds `body`.
    func holds(_ body: Body) -> Bool {
        gesture?.holds(body) == true
    }

    /// Whether the body is in the host's hand — a gesture's, or pressed out
    /// of its beats — which no eviction takes.
    func isInHand(_ body: Body) -> Bool {
        holds(body) || body === pressedOutOfBeats
    }

    /// Whether a placement or a plan leaves `body` alone: the gesture holds
    /// it, or the shell's rail draft does and the shell has not yet released.
    func isHeld(_ body: Body) -> Bool {
        if holds(body) { return true }
        return body.cardId.map(controller.placementHeld.contains) ?? false
    }

    /// Whether the host is tracking a card's drag or resize.
    var isLive: Bool { gesture != nil }

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
    private(set) weak var pressedOutOfBeats: Body?

    /// A press on a whole card a settle is carrying stops it where the user
    /// sees it, before the press is dispatched: AppKit routes the press by
    /// the view's frame, which a beat leaves at the landing while only the
    /// layer moves, so a card left in its beats would not get the press that
    /// lands on it.
    private func takeFromBeats(at point: CGPoint) {
        guard let body = controller.body(atViewportPoint: point), body.whole, body.beats != nil else { return }
        let shown = controller.presentedRect(body)
        controller.beats.cancel(body)
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

    /// A body going away mid-gesture takes its gesture with it: a rail's
    /// drag takes its ghost away, or commits the spring the hand released.
    func letGo(of body: Body) {
        guard let live = gesture, live.holds(body) else { return }
        if live.rail != nil { cancel() } else { gesture = nil }
    }

    /// `cardGesture` `begin`: a card's page has taken a title-bar or grip
    /// press, and the host is to carry the card until the mouse comes up. A
    /// press whose mouse-up beat the message here ends at once, as a click,
    /// so no gesture is left open waiting for an up that has already passed.
    func claim(from body: Body, begin: CardGestureBegin) {
        guard let cardId = body.cardId, gesture == nil else { return }
        let kind = begin.kind
        let edge = begin.edge
        if kind != .move && edge == nil { return }
        // A rail's edge is carried over the rail the placement seats the
        // card on, within the bounds it names for that rail.
        let seat = cardPlacements[cardId]?.rail
        let limits = seat.flatMap { $0.side == .left ? controller.railLimits.left : controller.railLimits.right }
        if kind == .rail, limits == nil {
            TugLog.warn("bodies", "a rail's edge pressed on a card the placement seats on no rail; ignoring", [
                TugLog.field("card", cardId),
            ])
            return
        }
        // The press brings its card forward at once, as the shell's
        // activation of it will: until that placement arrives, a card pressed
        // from under a neighbour would travel under it. A Cmd-press moves a
        // card without raising it, as a background window moves.
        if !begin.meta { raise(body) }
        let placement = cardPlacements[cardId]
        // A card a settle is carrying is taken where the user sees it: its
        // beats stop, its container holds the presented frame, and the hand
        // moves it from there rather than from the landing it was bound for.
        let containerStart = standOutOfBeats(body)
        // A card lifted out of a rail by its title bar or a grip travels
        // above the rail, as a card of the host view: reparented now that
        // nothing animates on its layer, and stacked where `raise` put it.
        if kind != .rail, body.container.superview is RailView {
            controller.reparent(body, into: hostView)
            controller.sortStacking()
        }
        let startRect = body.whole
            ? containerStart.insetBy(dx: controller.cardApron, dy: controller.cardApron)
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
            canvas: controller.cardCanvas ?? hostView.bounds,
            zoom: controller.cardZoom,
            minSize: placement?.min ?? .zero,
            // A card holding a height in its slot stops at its run's end,
            // not the canvas's: held past it, the edge stands there.
            maxSize: placement?.maxHeight.map { CGSize(width: CGFloat.greatestFiniteMagnitude, height: $0) },
            free: placement?.free ?? true,
            gap: controller.cardGap,
            others: others
        )
        var hand: RailHand?
        var held = [body]
        if kind == .rail, let seat, let limits {
            let built = railHand(side: seat.side, limits: limits, startRect: startRect, pointer: pointer, springMs: begin.springMs ?? 0)
            hand = built.hand
            held = built.held
        }
        let pressed = Gesture(
            body: body, cardId: cardId, kind: kind, edge: edge, tracker: tracker,
            containerStart: containerStart, meta: begin.meta, alt: begin.alt,
            last: CardGestureTracker.Step(rect: startRect, moved: false), pointer: pointer,
            rail: hand, held: held
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
        if let hand { askRailEdge(hand, page: body) }
    }

    /// Take `body` from any beats running on it, its container standing
    /// where the user sees it; answers that frame.
    private func standOutOfBeats(_ body: Body) -> CGRect {
        guard body.beats != nil else { return body.container.frame }
        let shown = controller.presentedRect(body)
        controller.beats.cancel(body)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.container.frame = shown
        CATransaction.commit()
        return shown
    }

    /// The hand for a rail's edge pressed on `side` with the pressed member's
    /// pane at `startRect`, and every body it holds. The members are every
    /// card the placement seats on the side, the carried cards every one
    /// with a travel; both are held with their inactive siblings, which are
    /// not moved. The snap targets are the visible panes neither moves.
    private func railHand(
        side: RailSide, limits: RailWidthLimits, startRect: CGRect, pointer: CGPoint, springMs: Double
    ) -> (hand: RailHand, held: [Body]) {
        var held: [Body] = []
        var panes: [CGRect] = []
        for other in bodies {
            guard let id = other.cardId, let placement = cardPlacements[id] else { continue }
            let moves = placement.visible && !placement.sibling
            // A card a settle is carrying stands still where the press finds it.
            if let seat = placement.rail, seat.side == side {
                held.append(other)
                if moves {
                    _ = standOutOfBeats(other)
                    panes.append(placement.rect)
                }
            } else if placement.rail == nil, placement.railTravel != nil {
                held.append(other)
                if moves { _ = standOutOfBeats(other) }
            }
        }
        let others = CardGeometry.railSnapTargets(side: side, cardPlacements.values.map {
            .init(rect: $0.rect, visible: $0.visible, sibling: $0.sibling, rail: $0.rail, travel: $0.railTravel)
        })
        let tracker = RailWidthTracker(
            side: side, startWidth: startRect.width / controller.cardZoom,
            pinnedEdge: side == .left ? startRect.minX : startRect.maxX,
            startPointer: pointer, limits: limits, canvas: controller.cardCanvas ?? hostView.bounds,
            zoom: controller.cardZoom, gap: controller.cardGap, others: others
        )
        let hand = RailHand(
            tracker: tracker, view: controller.railView(for: side), startRect: startRect,
            panes: panes.isEmpty ? startRect : RailView.union(of: panes),
            springMs: springMs,
            last: RailWidthTracker.Step(aim: tracker.startAim, moved: false)
        )
        return (hand, held)
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
        controller.sortStacking()
    }

    /// A mouse event while a gesture is live: a drag steps it, an up ends it.
    func track(_ event: NSEvent) {
        // A rail springing back is the hand's no longer: the mouse it let go
        // of is done, and a new press's drag is not this gesture's to step.
        guard var live = gesture, live.rail?.springing != true else { return }
        switch event.type {
        case .leftMouseDragged:
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            live.meta = event.modifierFlags.contains(.command)
            live.alt = event.modifierFlags.contains(.option)
            if var hand = live.rail {
                hand.last = hand.tracker.step(pointer: live.pointer, alt: live.alt)
                live.rail = hand
                gesture = live
                if hand.last.moved { moveRail(hand, shown: hand.last.aim.shown, limit: hand.last.aim.limit != nil) }
            } else {
                live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
                gesture = live
                move(live)
            }
            report(live, phase: .move)
        case .leftMouseUp:
            // The release is where the hand let go, which a quick drag's
            // merged moves may never have reported: step to it first, so a
            // press and a release apart with nothing between them is a drag.
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            var springs = false
            if var hand = live.rail {
                hand.last = hand.tracker.step(pointer: live.pointer, alt: live.alt)
                if hand.last.moved { moveRail(hand, shown: hand.last.aim.shown, limit: hand.last.aim.limit != nil) }
                // Released past a limit, the ghost springs back to it, and the
                // hand keeps the rail until it arrives: the release is said
                // to the shell, and the width committed, when the spring lands.
                let aim = hand.last.aim
                springs = hand.last.moved && aim.limit != nil && hand.springMs > 0 && abs(aim.shown - aim.width) > 0.5
                hand.springing = springs
                live.rail = hand
            } else {
                live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
                move(live)
            }
            gesture = springs ? live : nil
            report(live, phase: springs ? .move : .end)
            if springs, let hand = live.rail { springRail(hand) }
            if !springs, let hand = live.rail { landRail(hand) }
            if pressedOutOfBeats === live.body {
                pressedOutOfBeats = nil
                // A hold that went nowhere commits nothing, so no placement
                // will come to land the card: it lands itself.
                // A rail's travel is its own tracker's, not the press's.
                if !(live.rail?.last.moved ?? live.last.moved) { returnToLanding(live.body) }
            }
        default:
            break
        }
    }

    /// End the gesture with nothing committed: Escape, or the window losing
    /// the mouse. The card goes back where the press found it.
    func cancel() {
        guard let live = gesture else { return }
        // The hand already let go of a springing rail: what it released is
        // owed its commit, whatever interrupts the spring.
        if live.rail?.springing == true {
            finishSpring()
            return
        }
        gesture = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let hand = live.rail {
            landRail(hand)
        } else {
            live.body.container.frame = live.containerStart
        }
        CATransaction.commit()
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
        var r = live.last.rect
        var moved = live.last.moved
        var snapX = live.last.snapX
        var snapY = live.last.snapY
        var aim: RailAimReport?
        // A rail's edge: the pressed member's pane at the width drawn, and the aim.
        if let hand = live.rail {
            r = railFrame(hand.startRect, hand, shown: hand.last.aim.shown)
            moved = hand.last.moved
            snapX = hand.last.snapX
            snapY = nil
            let a = hand.last.aim
            aim = RailAimReport(width: Double(a.width), shown: Double(a.shown), limit: a.limit?.rawValue)
        }
        let snapped = snapX != nil || snapY != nil
        let report = CardGestureReport(
            cardId: live.cardId,
            kind: live.kind,
            phase: phase,
            rect: PlanRect(x: r.minX, y: r.minY, width: r.width, height: r.height),
            pointer: .init(x: live.pointer.x, y: live.pointer.y),
            start: .init(x: live.tracker.startPointer.x, y: live.tracker.startPointer.y),
            moved: moved,
            meta: live.meta,
            alt: live.alt,
            edge: live.edge,
            snap: snapped ? .init(x: snapX.map(Double.init), y: snapY.map(Double.init)) : nil,
            rail: aim
        )
        window.sendToShell(.cardGesture(report))
    }

    /// A member's frame, `start` at the press, with the rail drawn at
    /// `shown`: widened at the deck-facing edge by the rail's growth.
    private func railFrame(_ start: CGRect, _ hand: RailHand, shown: CGFloat) -> CGRect {
        let points = (shown - hand.tracker.startWidth) * hand.tracker.zoom
        var r = start
        r.size.width += points
        if hand.tracker.side == .right { r.origin.x -= points }
        return r
    }

    /// The press on a rail's edge: the pressed member's page is asked for the
    /// colours its edge paints in, which the ghost wears once they arrive.
    private func askRailEdge(_ hand: RailHand, page body: Body) {
        let ghost = hand.view.ghost
        window.hostChannel.call(.railEdge, in: body.webView) { result in
            guard case .success(.railEdge(let colors)) = result else { return }
            ghost.colors = colors
        }
    }

    /// A step of the hand on a rail's edge, or of the spring a release past a
    /// limit runs: the ghost stands at the footprint the rail would take at
    /// `shown`, its edge in the limit's colour for a hand pressing past one.
    /// Nothing on the deck moves while the hand is down: not a member, not
    /// its page, not the cards beside the rail.
    private func moveRail(_ hand: RailHand, shown: CGFloat, limit: Bool) {
        let growth = (shown - hand.tracker.startWidth) * hand.tracker.zoom
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        hand.view.ghost.pastLimit = limit
        hand.view.standGhost(RailView.ghostFrame(side: hand.tracker.side, panes: hand.panes, growth: growth), in: hostView)
        CATransaction.commit()
    }

    /// The hand has let go, or the gesture was cancelled: the ghost goes, and
    /// every card still stands where the press found it. A release's commit
    /// lands the width through the settle it runs (`runPlan`), whose beats
    /// carry each member and each card beside the rail, every page that
    /// changes size pinned at its landing and clipped as it moves; a cancel
    /// commits nothing, and nothing moved to be put back.
    private func landRail(_ hand: RailHand) {
        springLink?.invalidate()
        springLink = nil
        hand.view.removeGhost()
    }

    /// A release past a limit: the ghost springs from where the hand left it
    /// to the limit, over the span the body page posted at the press, on the
    /// shell's spring curve, through the same step the hand's moves take, so
    /// the spring is in step as the drag is. The hand keeps the rail until
    /// the spring arrives.
    private func springRail(_ hand: RailHand) {
        springSerial += 1
        let serial = springSerial
        let from = hand.last.aim.shown
        let to = hand.last.aim.width
        let begin = CACurrentMediaTime()
        let duration = hand.springMs / 1000
        let curve = Self.railSpringCurve
        let tick = RailSpringTick { [weak self] link in
            guard let self, serial == self.springSerial, let hand = self.gesture?.rail, hand.springing else {
                link.invalidate()
                return
            }
            let t = min(1, max(0, (link.targetTimestamp - begin) / duration))
            let eased = CardGeometry.cubicBezier(t, x1: curve.x1, y1: curve.y1, x2: curve.x2, y2: curve.y2)
            self.moveRail(hand, shown: from + (to - from) * CGFloat(eased), limit: false)
            if t >= 1 { self.finishSpring(serial: serial) }
        }
        let link = hostView.displayLink(target: tick, selector: #selector(RailSpringTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        springLink = link
    }

    /// The spring is over, naturally or cut short: the ghost goes, the hand
    /// lets go, and the release is said to the shell at the limit, which
    /// commits it. `serial` names the spring a tick is for; nil finishes the
    /// one running now.
    private func finishSpring(serial: Int? = nil) {
        guard var live = gesture, var hand = live.rail, hand.springing else { return }
        if let serial, serial != springSerial { return }
        gesture = nil
        landRail(hand)
        hand.last.aim.shown = hand.last.aim.width
        live.rail = hand
        report(live, phase: .end)
    }
}
