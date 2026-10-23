import AppKit

/// The beats runner: a settle's `cardPlan`, carried through each card's
/// container as Core Animation on the chrome's clock, and the crossing a
/// plan that resizes a card's page runs beside it.
///
/// `BodyBeats` is the arithmetic, Foundation-only so the tests compile it;
/// this runs it. What a running plan holds lives on the body it carries —
/// its beats, its crossing and its mapping — so the runner keeps nothing of
/// its own past the plans in hand: a solving plan, between its receipt and
/// its start.
final class BodyBeatsRunner {
    typealias Body = BodyViewController.Body

    /// How a body's page follows its container outside a crossing.
    static let pageResizing: NSView.AutoresizingMask = [.width, .height]
    /// The animation keys a plan's tracks run under: one per property, so a
    /// later plan's track replaces an earlier one's, and cancelling is
    /// removing three keys.
    private static let beatKeys = ["beats-position", "beats-bounds", "beats-opacity"]

    /// How long a solving plan waits for its cards to say `crossingSolved`
    /// before it starts without them, ms — and a crossing cover's snapshot
    /// deadline. The shell's `SOLVE_GUARD_MS` mirrors it.
    ///
    /// A page that never answers is what the guard is for; a page that does
    /// answer is given the time it takes. A whole card with a long real
    /// transcript lays itself out at its new size in 250–340 ms from the
    /// plan's receipt (read on the user's deck, 2026-10-23), which a 250 ms
    /// guard turned into the old motion — the page's answer, and the split
    /// cover it carries, arriving after the plan had started.
    static let solveGuardMs: Double = 600

    /// The key a covered fold's band ride runs under, on the page and on the
    /// cover's mask.
    private static let bandKey = "crossing-band"

    /// A solving plan between its receipt and its start: every card it put
    /// tracks on, the cards it still awaits, when it arrived (media time),
    /// and the guard that starts it without them ([L27]: cancelled when the
    /// plan starts).
    private final class PlanSolve {
        let planId: Int
        let receivedAt: CFTimeInterval
        var carried: [Carried] = []
        var awaited: Set<ObjectIdentifier> = []
        var guardItem: DispatchWorkItem?
        init(planId: Int, receivedAt: CFTimeInterval) {
            self.planId = planId
            self.receivedAt = receivedAt
        }
    }

    /// One card a solving plan put tracks on, with what re-adding them takes.
    private struct Carried {
        weak var body: Body?
        let layer: CALayer
        let planned: PlannedCard
        let track: BodyBeats.Track
        let mapping: LayerMapping
    }

    /// Every solving plan not yet started, by its id.
    private var solves: [Int: PlanSolve] = [:]

    private unowned let controller: BodyViewController
    private unowned let window: MainWindow

    init(controller: BodyViewController, window: MainWindow) {
        self.controller = controller
        self.window = window
    }

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
    ///
    /// A plan that `solves` lays each crossing card's page out at its
    /// landing size before the motion: the card is told `begin` with
    /// `solve`, and the plan starts once every such card has said
    /// `crossingSolved`, or at `solveGuardMs`. A whole card that shrinks is
    /// told only once its last frame stands over it as a cover, so the
    /// page's resize is never seen. Its tracks are added here all the same,
    /// with a provisional begin at the guard's horizon, so `.backwards`
    /// holds every container at First and `body.beats` claims it from the
    /// receipt — the placement naming the plan, `reconcileRails` and the
    /// press path all see it as the plan's — and `startPlan` re-adds them
    /// with the real begin. The provisional track is the guard: a solve
    /// that never answers starts at its horizon.
    func run(_ plan: CardPlan) {
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        let solve = plan.solves ? PlanSolve(planId: plan.planId, receivedAt: anchor.mediaTime) : nil
        // A solving plan's provisional begin is two display periods past the
        // guard, so the guard's own start, a period ahead of now, always
        // replaces the tracks before they have begun.
        let startWallMs = solve == nil
            ? plan.startWallMs
            : anchor.wallMs + Self.solveGuardMs + 2 * controller.displayPeriodSec * 1000
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for planned in plan.cards {
            guard let body = controller.body(forCard: planned.cardId) else { continue }
            // A card in the host's hand is the hand's until the gesture ends.
            if controller.carrier.isHeld(body) { continue }
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
                controller.applyVisibility(body)
            }
            guard body.visible, body.canShow,
                  let layer = body.container.layer,
                  let track = BodyBeats.planTrack(planned.beats) else {
                TugLog.info("bodies", "plan declined a body", [
                    TugLog.field("card", planned.cardId),
                    TugLog.field("visible", body.visible),
                    TugLog.field("can_show", body.canShow),
                    TugLog.field("state", body.life.reported),
                ])
                decline(body, planId: plan.planId, landing: planned.landing.cgRect)
                continue
            }
            // A track of no duration — a split's revealed member, landing at
            // its tile before the first frame, or a pane the settle jumps,
            // one that stood behind another — has nothing to run. In a
            // solving plan a crossing card's page is solved all the same: its
            // container stands at its landing at once, behind the survivor
            // that z-order keeps in front, and its crossing ends when the
            // plan starts, its track's end being its start. Anywhere else the
            // body is stood at its landing: it has landed, not lost its beats.
            let instant = track.durationMs <= 0
            guard !instant || (solve != nil && planned.crossing != nil) else {
                land(body, planId: plan.planId, landing: planned.landing.cgRect)
                continue
            }
            cancel(body)
            let landing = planned.landing.cgRect
            let crossing = planned.crossing.map { CGSize(width: $0.width, height: $0.height) }
            guard let mapping = probeMapping(body, landing: landing, holdPage: crossing != nil) else {
                NSLog("BodyBeatsRunner: no layer mapping for %@; its beats are not run", planned.cardId)
                decline(body, planId: plan.planId, landing: landing)
                continue
            }
            body.mapping = mapping
            let planId = plan.planId
            let lateMs = instant ? 0 : addTracks(
                body, layer: layer, planned: planned, track: track, mapping: mapping,
                anchor: anchor, startWallMs: startWallMs, planId: planId
            )
            solve?.carried.append(Carried(body: body, layer: layer, planned: planned, track: track, mapping: mapping))
            body.beats = (planId, landing, lateMs)
            body.frame = landing
            if let crossing {
                let moveBegin = anchor.beginTime(startWallMs: startWallMs, delayMs: Self.firstMoveMs(planned, track))
                // A whole card's page is the card, chrome and all, and it
                // wears no surface behind it: given its smaller landing size
                // bare, the card would stand at its landing for the whole
                // motion over the canvas the container still spans. So a
                // whole card that changes size takes its new size only under
                // its cover — which, split at the row the page names, hangs
                // its head from the top and its tail from the moving edge
                // (`rideSplit`) — and with none it keeps its page to the land.
                //
                // A card that stands at First for the whole motion and lands
                // only at its end — a stack's retiring member, held at its
                // tile while the survivor grows over it — shows its First face
                // throughout, whatever its size does, so it takes its new size
                // under a cover too.
                let page = body.webView.frame.size
                let resizesWhole = body.whole
                    && (abs(crossing.width - page.width) > 0.5 || abs(crossing.height - page.height) > 0.5)
                let holdsFirst = !instant && Self.firstMoveMs(planned, track) >= track.delayMs + track.durationMs
                let covers = resizesWhole || holdsFirst
                body.crossing = (crossing, moveBegin, covers && solve == nil)
                body.lastCrossing = CrossingAccount(planId: planId, size: crossing)
                body.lastCrossing?.receivedAt = anchor.mediaTime
                // Tell the body now, in this task, so it pins its scrollers
                // and acknowledges inside a display period: one hop to its
                // page and one back, never a round trip through tugcast.
                let spanMs = planned.beats.map { $0.delayMs + $0.durationMs }.max() ?? 0
                let begin = BodyCrossing(phase: .begin, width: crossing.width, height: crossing.height, durationMs: spanMs)
                if let solve {
                    solve.awaited.insert(ObjectIdentifier(body))
                    if covers {
                        coverForCrossing(body, planId: planId, begin: begin)
                    } else {
                        var solving = begin
                        solving.solve = true
                        controller.send(.bodyCrossing(solving), to: body)
                    }
                } else {
                    controller.send(.bodyCrossing(begin), to: body)
                }
            }
        }
        CATransaction.commit()
        controller.refreshRegion()
        if let solve {
            solves[solve.planId] = solve
            if solve.awaited.isEmpty {
                // Every card was declined or carried no crossing: nothing to wait for.
                startPlan(solve.planId, timedOut: false)
            } else {
                let planId = solve.planId
                let item = DispatchWorkItem { [weak self] in self?.startPlan(planId, timedOut: true) }
                solve.guardItem = item
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(Self.solveGuardMs)), execute: item)
            }
        }
    }

    /// Stand a whole card's last frame over its page, then tell it its
    /// solving crossing: in the snapshot's completion, so the page's
    /// `crossingReady`, and the resize it permits, can never come before the
    /// cover stands. The frame is the page's First size — the web view's,
    /// which `probeMapping` held, never the container's, already the landing
    /// — at the screen's backing scale, and the cover does not clip: the
    /// container's own clip, which its bounds track drives, shrinks it. A
    /// snapshot that fails or misses `solveGuardMs` stands no cover: the card
    /// is told `begin` without `solve`, is not awaited, and keeps its page to
    /// the land.
    ///
    /// The covers decide where the cover comes from (`BodyCovers`). A body
    /// already standing under one — brought back from an eviction, its page
    /// not yet painted — takes that one, and is told at once; one that has
    /// not painted and stands under none is never snapshotted, and keeps its
    /// page as a failed snapshot would.
    private func coverForCrossing(_ body: Body, planId: Int, begin: BodyCrossing) {
        guard let cardId = body.cardId else { return }
        let size = body.webView.frame.size
        let covers = controller.lifecycle.covers
        switch covers.crossingCover(for: cardId, painted: body.painted) {
        case .standing(let stand):
            // Brought back from an eviction and not yet painted, the body
            // stands under its last frame already, and the crossing takes
            // that cover rather than a second one: it comes off at the
            // later of the paint and the land.
            body.lastCrossing?.cover = .standing
            holdForCrossing(body, stand: stand, size: size)
            var solving = begin
            solving.solve = true
            controller.send(.bodyCrossing(solving), to: body)
            return
        case .keepsPage:
            // A page that has not painted would snapshot nothing it ever showed.
            body.lastCrossing?.cover = .keptPage
            keepPage(body, planId: planId, begin: begin)
            return
        case .snapshot:
            break
        }
        let asked = CACurrentMediaTime()
        controller.snapshotFrame(
            of: body, cardId: cardId, size: size, scale: window.backingScaleFactor,
            deadline: .milliseconds(Int(Self.solveGuardMs)), purpose: "a crossing's cover"
        ) { [weak self, weak body] image in
            guard let self, let body, body.state != .gone else { return }
            // Cancelled or carried on by a newer plan while the snapshot ran:
            // there is no crossing of this plan's left to cover.
            guard body.crossing != nil, body.lastCrossing?.planId == planId else { return }
            guard let image, let stand = covers.standCover(
                for: cardId, kind: .crossing,
                fresh: BodyCover(
                    image: image, size: size, surface: body.surface, insets: body.insets,
                    takenAt: Date().timeIntervalSince1970 * 1000
                )
            ) else {
                body.lastCrossing?.cover = .keptPage
                self.keepPage(body, planId: planId, begin: begin)
                return
            }
            body.lastCrossing?.cover = .snapshot
            body.lastCrossing?.snapshotMs = (CACurrentMediaTime() - asked) * 1000
            body.lastCrossing?.coverPixels = CGSize(width: image.width, height: image.height)
            TugLog.info("bodies", "a crossing's cover stands", [
                TugLog.field("card", cardId),
                TugLog.field("plan", "\(planId)"),
                TugLog.field("snapshot_ms", String(format: "%.1f", (CACurrentMediaTime() - asked) * 1000)),
                TugLog.field("pixels", "\(image.width)x\(image.height)"),
            ])
            self.holdForCrossing(body, stand: stand, size: size)
            var solving = begin
            solving.solve = true
            self.controller.send(.bodyCrossing(solving), to: body)
        }
    }

    /// Stand `stand`'s cover over `body` for its crossing, at the page's
    /// First size, pinned top-left: the view already standing, or one made
    /// for it. A body stands under one cover view whatever its reasons.
    private func holdForCrossing(_ body: Body, stand: BodyCovers.Stand, size: CGSize) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let cover = body.cover ?? BodyCoverView(cover: stand.cover, frame: CGRect(origin: .zero, size: size))
        if cover.superview == nil {
            body.container.addSubview(cover, positioned: .above, relativeTo: body.webView)
        }
        cover.autoresizingMask = []
        cover.frame = CGRect(origin: .zero, size: size)
        CATransaction.commit()
        body.cover = cover
        body.stand = stand
    }

    /// No cover can stand for the crossing: the card is told `begin` without
    /// `solve`, is not awaited, and keeps its page to the land.
    private func keepPage(_ body: Body, planId: Int, begin: BodyCrossing) {
        body.crossing?.keepsPage = true
        controller.send(.bodyCrossing(begin), to: body)
        dropFromSolve(body, planId: planId)
    }

    /// Carry a covered fold's bottom band on `track`, from the plan's start,
    /// beside the container's own tracks (`BodyBeats.bandRide`). The page
    /// rides bottom-pinned and is masked to its band, so only the band and
    /// the card's bottom edge show of it; the cover is masked to what shows
    /// above the band. Both models are the land's — the page at its place,
    /// the cover down to the band — so the land moves nothing, and the cover
    /// comes off over a page that shows exactly what it did.
    private func rideBand(
        _ body: Body, band: BodyBeats.CrossingBand, track: BodyBeats.Track, anchor: ClockAnchor, startWallMs: Double
    ) {
        guard let cover = body.crossingCover, let coverLayer = cover.layer, let page = body.webView.layer,
              let landing = body.beats?.landing else { return }
        let ride = BodyBeats.bandRide(track, band: band, landingHeight: Double(landing.height))
        let begin = anchor.beginTime(startWallMs: startWallMs, delayMs: track.delayMs)

        guard let positions = Self.positions(of: body.webView, atTops: ride.pageOffsets) else { return }
        page.removeAnimation(forKey: Self.bandKey)
        page.add(Self.keyframes(
            "position", values: positions,
            keyTimes: ride.keyTimes, timings: ride.timings, durationMs: track.durationMs,
            begin: page.convertTime(begin, from: nil)
        ), forKey: Self.bandKey)
        let pageMask = CALayer()
        pageMask.backgroundColor = CGColor(gray: 0, alpha: 1)
        let pageSize = body.webView.bounds.size
        pageMask.frame = body.webView.convertToLayer(CGRect(
            x: 0, y: pageSize.height - band.reach, width: pageSize.width, height: band.reach
        ))
        page.mask = pageMask

        let width = cover.bounds.width
        let rects = ride.coverHeights.map { cover.convertToLayer(CGRect(x: 0, y: 0, width: width, height: max(0, $0))) }
        let coverMask = CALayer()
        coverMask.backgroundColor = CGColor(gray: 0, alpha: 1)
        coverMask.anchorPoint = .zero
        if let last = rects.last {
            coverMask.position = last.origin
            coverMask.bounds = CGRect(origin: .zero, size: last.size)
        }
        coverLayer.mask = coverMask
        let coverBegin = coverMask.convertTime(begin, from: nil)
        coverMask.add(Self.keyframes(
            "position", values: rects.map { NSValue(point: $0.origin) },
            keyTimes: ride.keyTimes, timings: ride.timings, durationMs: track.durationMs, begin: coverBegin
        ), forKey: Self.bandKey + "-position")
        coverMask.add(Self.keyframes(
            "bounds", values: rects.map { NSValue(rect: CGRect(origin: .zero, size: $0.size)) },
            keyTimes: ride.keyTimes, timings: ride.timings, durationMs: track.durationMs, begin: coverBegin
        ), forKey: Self.bandKey + "-bounds")
    }

    /// Carry a covered whole card's split picture on `track`, from the plan's
    /// start (`BodyBeats.splitRide`). The cover is cut at the split: what is
    /// above stays where it stands, and what is below rides the bottom edge
    /// as a second cover under the first, masked to the tail and moved with
    /// the edge. A page whose content follows its bottom rides the edge too,
    /// so where the cover's tail does not reach the page shows the same rows
    /// in the same place; one that does not stays where it stands, its rows
    /// at the top where the cover's head shows them. Every model is the
    /// land's — the page at its place, the tail at the landing's edge — so
    /// the land moves nothing, and the covers come off over a page that
    /// shows exactly what they did.
    ///
    /// A following page that grows carries no tail: the page's own bottom
    /// rows ride the edge and are the honest picture, where the cover's
    /// would be the smaller form's — an unfold's folded strip, say.
    private func rideSplit(
        _ body: Body, split: BodyBeats.CoverSplit, track: BodyBeats.Track, anchor: ClockAnchor, startWallMs: Double
    ) {
        guard let cover = body.crossingCover, let coverLayer = cover.layer, let landing = body.beats?.landing else { return }
        let size = cover.frame.size
        let ride = BodyBeats.splitRide(track, split: split, coverHeight: Double(size.height), landingHeight: Double(landing.height))
        let begin = anchor.beginTime(startWallMs: startWallMs, delayMs: track.delayMs)
        let splitY = CGFloat(split.splitY)

        let head = CALayer()
        head.backgroundColor = CGColor(gray: 0, alpha: 1)
        head.frame = cover.convertToLayer(CGRect(x: 0, y: 0, width: size.width, height: splitY))
        coverLayer.mask = head

        let insets = cover.paneInsets
        // The pane's columns, from its top down past either form's bottom:
        // the moving edge is the only bottom, and the container clips there.
        let pane = CGRect(
            x: insets?.left ?? 0, y: insets?.top ?? 0,
            width: size.width - (insets?.left ?? 0) - (insets?.right ?? 0), height: 2 * max(size.height, landing.height)
        )
        let grows = landing.height > size.height + 0.5
        if !(split.follows && grows) {
            rideTail(body, cover: cover, splitY: splitY, pane: pane, ride: ride, track: track, begin: begin)
        }

        guard split.follows, let page = body.webView.layer,
              let pagePositions = Self.positions(of: body.webView, atTops: ride.pageOffsets) else { return }
        page.removeAnimation(forKey: Self.bandKey)
        page.add(Self.keyframes(
            "position", values: pagePositions, keyTimes: track.keyTimes, timings: track.timings,
            durationMs: track.durationMs, begin: page.convertTime(begin, from: nil)
        ), forKey: Self.bandKey)
        let bounds = body.webView.bounds
        Self.mask(
            page, of: body.webView, to: ride.pageOffsets.map { bounds.intersection(pane.offsetBy(dx: 0, dy: -CGFloat($0))) },
            track: track, begin: begin
        )
    }

    /// The split cover's tail: a second cover under the first, cut above
    /// `splitY`, its frame's bottom on the moving edge.
    private func rideTail(
        _ body: Body, cover: BodyCoverView, splitY: CGFloat, pane: CGRect, ride: BodyBeats.SplitRide,
        track: BodyBeats.Track, begin: CFTimeInterval
    ) {
        let size = cover.frame.size
        // Under the head, so the rows it carries up pass behind the masthead
        // rather than over it.
        let tail = cover.twin()
        tail.autoresizingMask = []
        body.container.addSubview(tail, positioned: .below, relativeTo: cover)
        body.crossingTail = tail
        guard let tailLayer = tail.layer else { return }
        // What rides is clipped to the pane as it stands in the container —
        // the apron around the pane is transparent in the frame, and rows
        // passing behind it would show through — by a mask that moves
        // against the ride, so the clip stands still while its layer moves.
        guard let positions = Self.positions(of: tail, atTops: ride.tailTops), let last = ride.tailTops.last else { return }
        tailLayer.add(Self.keyframes(
            "position", values: positions, keyTimes: track.keyTimes, timings: track.timings,
            durationMs: track.durationMs, begin: tailLayer.convertTime(begin, from: nil)
        ), forKey: Self.bandKey)
        tail.frame.origin.y = CGFloat(last)
        let rows = CGRect(x: 0, y: splitY, width: size.width, height: size.height - splitY)
        Self.mask(
            tailLayer, of: tail, to: ride.tailTops.map { rows.intersection(pane.offsetBy(dx: 0, dy: -CGFloat($0))) },
            track: track, begin: begin
        )
    }

    /// Mask `layer` to `rects` — in `view`'s own coordinates, one per key of
    /// `track` — moving the mask from one to the next on the track's clock,
    /// its model the last.
    private static func mask(_ layer: CALayer, of view: NSView, to rects: [CGRect], track: BodyBeats.Track, begin: CFTimeInterval) {
        let converted = rects.map { view.convertToLayer($0.isNull ? .zero : $0) }
        let mask = CALayer()
        mask.backgroundColor = CGColor(gray: 0, alpha: 1)
        mask.anchorPoint = .zero
        if let last = converted.last {
            mask.position = last.origin
            mask.bounds = CGRect(origin: .zero, size: last.size)
        }
        layer.mask = mask
        let local = mask.convertTime(begin, from: nil)
        mask.add(keyframes(
            "position", values: converted.map { NSValue(point: $0.origin) },
            keyTimes: track.keyTimes, timings: track.timings, durationMs: track.durationMs, begin: local
        ), forKey: bandKey + "-position")
        mask.add(keyframes(
            "bounds", values: converted.map { NSValue(rect: CGRect(origin: .zero, size: $0.size)) },
            keyTimes: track.keyTimes, timings: track.timings, durationMs: track.durationMs, begin: local
        ), forKey: bandKey + "-bounds")
    }

    /// The positions `view`'s layer takes with the view's top at each of
    /// `tops`, read from the layer rather than assumed — the view is moved
    /// down a point and its layer read, as `probeMapping` reads the
    /// container's — and nil when the frame does not move the layer.
    private static func positions(of view: NSView, atTops tops: [Double]) -> [NSValue]? {
        guard let layer = view.layer else { return nil }
        let held = view.frame
        let base = layer.position
        view.frame = held.offsetBy(dx: 0, dy: 1)
        let perPoint = layer.position.y - base.y
        view.frame = held
        guard abs(perPoint) > 0.5 else { return nil }
        return tops.map { NSValue(point: CGPoint(x: base.x, y: base.y + perPoint * ($0 - Double(held.minY)))) }
    }

    /// `crossingSolved`: the body is laid out at its crossing size. Its plan
    /// starts once it awaits no other card. Late — the plan started or the
    /// crossing was cancelled — it is ignored.
    ///
    /// A covered fold's page names its folded form's bottom band, in CSS px:
    /// it is kept in the container's points, scaled by the page's own size
    /// against its viewport, for `startPlan` to carry. Any other covered
    /// change of a whole card's height names where its picture splits, kept
    /// the same way.
    func crossingSolved(_ body: Body, band: CrossingSolved.Band?, anchor: CrossingSolved.Anchor?) {
        guard body.crossing != nil, let planId = body.lastCrossing?.planId else { return }
        guard let solve = solves[planId], solve.awaited.remove(ObjectIdentifier(body)) != nil else {
            // Its plan started without it: the guard ran out first. Said in
            // the log with how late it was, which is what tunes the guard.
            if let receivedAt = body.lastCrossing?.receivedAt, body.lastCrossing?.solved != true, let cardId = body.cardId {
                TugLog.warn("bodies", "a card solved after its plan started", [
                    TugLog.field("card", cardId),
                    TugLog.field("plan", "\(planId)"),
                    TugLog.field("since_receipt_ms", String(format: "%.1f", (CACurrentMediaTime() - receivedAt) * 1000)),
                    TugLog.field("snapshot_ms", body.lastCrossing?.snapshotMs.map { String(format: "%.1f", $0) } ?? "none"),
                ])
            }
            return
        }
        body.lastCrossing?.solved = true
        body.lastCrossing?.solveMs = (CACurrentMediaTime() - solve.receivedAt) * 1000
        if let band, let cover = body.crossingCover, band.viewport > 0 {
            body.crossingBand = BodyBeats.CrossingBand(
                restFromBottom: band.restFromBottom, top: band.top, height: band.height, viewport: band.viewport,
                scale: Double(body.webView.frame.height) / band.viewport, coverHeight: Double(cover.frame.height)
            )
            body.lastCrossing?.band = body.crossingBand
        } else if let anchor, let cover = body.crossingCover, anchor.viewport > 0 {
            body.crossingSplit = BodyBeats.CoverSplit(
                splitTop: anchor.splitTop, follows: anchor.follows, viewport: anchor.viewport,
                scale: Double(body.webView.frame.height) / anchor.viewport, coverHeight: Double(cover.frame.height)
            )
            body.lastCrossing?.split = body.crossingSplit
        }
        if solve.awaited.isEmpty { startPlan(planId, timedOut: false) }
    }

    /// The plan no longer waits on `body`: its crossing was cancelled, or its
    /// cover could not be taken.
    private func dropFromSolve(_ body: Body, planId: Int) {
        guard let solve = solves[planId], solve.awaited.remove(ObjectIdentifier(body)) != nil else { return }
        if solve.awaited.isEmpty { startPlan(planId, timedOut: false) }
    }

    /// Add `planned`'s tracks to `body`'s container under the beat keys —
    /// replacing any there, whose delegate is then told `finished: false` and
    /// does nothing — beginning at `startWallMs` through `anchor`, and arm
    /// the window's frame meters on the beats that move it. Returns how late
    /// the start reached the host, ms.
    private func addTracks(
        _ body: Body, layer: CALayer, planned: PlannedCard, track: BodyBeats.Track, mapping: LayerMapping,
        anchor: ClockAnchor, startWallMs: Double, planId: Int
    ) -> Double {
        let begin = anchor.beginTime(startWallMs: startWallMs, delayMs: track.delayMs)
        let lateMs = max(0, anchor.mediaTime - begin) * 1000
        let localBegin = layer.convertTime(begin, from: nil)
        let position = Self.keyframes(
            "position", values: track.rects.map { NSValue(point: mapping.position(of: $0)) },
            track: track, begin: localBegin
        )
        position.delegate = BeatTrackDelegate { [weak self, weak body] (finished: Bool) in
            guard let self, let body, finished, let beats = body.beats, beats.planId == planId,
                  let cardId = body.cardId else { return }
            body.beats = nil
            self.endCrossing(body)
            self.controller.notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: beats.lateMs))
            // A card a settle carried into or out of a rail joins its
            // rail's view, or leaves it, now that nothing animates on it.
            self.controller.reconcileRails()
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
        // A reading of the window armed now samples this container under
        // its card id, over the beats that move it; tracks added again drop
        // the spans of the ones they replace, none of which had begun.
        let moving = planned.beats.filter { $0.from != $0.to }.map { beat in
            let from = anchor.beginTime(startWallMs: startWallMs, delayMs: beat.delayMs)
            return (from: from, to: from + beat.durationMs / 1000)
        }
        for meter in window.armedFrameMeters {
            meter.cut(named: planned.cardId, at: anchor.mediaTime)
            meter.track(layer, named: planned.cardId, active: moving)
        }
        return lateMs
    }

    /// The delay of the first beat that moves the box: a prepare beat ahead
    /// of it holds First, and the page at its final size is clipped there
    /// exactly as before the plan. A crossing's lead is measured to it.
    private static func firstMoveMs(_ planned: PlannedCard, _ track: BodyBeats.Track) -> Double {
        planned.beats.first { $0.from != $0.to }?.delayMs ?? track.delayMs
    }

    /// The solve is over — every card answered or dropped out, or the guard
    /// ran out — and the plan starts: one display period from now, so the
    /// shell hears `planStarted` before the start rather than after it, and
    /// every card the plan still carries has its tracks added again on that
    /// begin, in one transaction, replacing the provisional ones.
    ///
    /// A card with a track of no duration lands here instead: its container
    /// already stands at its landing, so its crossing ends in the same
    /// transaction — the cover off, the page following its container — and
    /// the shell is told it landed.
    private func startPlan(_ planId: Int, timedOut: Bool) {
        guard let solve = solves.removeValue(forKey: planId) else { return }
        solve.guardItem?.cancel()
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        let solveMs = (anchor.mediaTime - solve.receivedAt) * 1000
        let startWallMs = anchor.wallMs + controller.displayPeriodSec * 1000
        var landed: [String] = []
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for carried in solve.carried {
            // A card a newer plan or a placement took since is not this plan's.
            guard let body = carried.body, let beats = body.beats, beats.planId == planId else { continue }
            if carried.track.durationMs <= 0 {
                body.beats = nil
                endCrossing(body)
                if let cardId = body.cardId { landed.append(cardId) }
                continue
            }
            let lateMs = addTracks(
                body, layer: carried.layer, planned: carried.planned, track: carried.track,
                mapping: carried.mapping, anchor: anchor, startWallMs: startWallMs, planId: planId
            )
            body.beats = (planId, beats.landing, lateMs)
            body.crossing?.begin = anchor.beginTime(
                startWallMs: startWallMs, delayMs: Self.firstMoveMs(carried.planned, carried.track)
            )
            if let band = body.crossingBand {
                rideBand(body, band: band, track: carried.track, anchor: anchor, startWallMs: startWallMs)
            } else if let split = body.crossingSplit {
                rideSplit(body, split: split, track: carried.track, anchor: anchor, startWallMs: startWallMs)
            }
        }
        CATransaction.commit()
        for cardId in landed {
            controller.notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: 0))
        }
        if !landed.isEmpty { controller.reconcileRails() }
        if timedOut {
            TugLog.warn("bodies", "a plan's solve ran out its guard; it starts without every card", [
                TugLog.field("plan", "\(planId)"),
                TugLog.field("awaited", "\(solve.awaited.count)"),
                TugLog.field("guard_ms", "\(Int(Self.solveGuardMs))"),
            ])
        }
        window.sendToShell(.planStarted(PlanStarted(
            planId: planId, startWallMs: startWallMs, solveMs: solveMs, timedOut: timedOut
        )))
    }

    /// Take a body's beats off, and tell the shell when a plan was carrying it.
    func cancel(_ body: Body) {
        guard let beats = body.beats else { return }
        body.beats = nil
        for key in Self.beatKeys { body.container.layer?.removeAnimation(forKey: key) }
        endCrossing(body)
        dropFromSolve(body, planId: beats.planId)
        if let cardId = body.cardId {
            // A reading of the window stops judging the beats the body lost.
            for meter in window.armedFrameMeters {
                meter.cut(named: cardId, at: CACurrentMediaTime())
            }
            controller.notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: beats.planId))
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
        cancel(body)
        standAtLanding(body, landing)
        if let cardId = body.cardId {
            controller.notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: planId))
        }
    }

    /// A body whose plan spans no time stands at its landing at once, and the
    /// shell is told it landed, as its beats would have said at their end.
    private func land(_ body: Body, planId: Int, landing: CGRect) {
        cancel(body)
        standAtLanding(body, landing)
        if let cardId = body.cardId {
            controller.notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: 0))
        }
        controller.reconcileRails()
    }

    private func standAtLanding(_ body: Body, _ landing: CGRect) {
        body.frame = landing
        body.container.frame = landing
        body.webView.frame = body.container.bounds
        body.webView.autoresizingMask = Self.pageResizing
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

    /// `crossingReady`: the body has pinned its scrollers for the crossing
    /// its plan began. Its page takes the landing size now, once, top-left
    /// pinned in the flipped container, growing or shrinking, while the
    /// container's own track holds First; the container clips it to the
    /// rect the track has reached, and a whole card that shrinks does so
    /// under its cover. One that keeps its page — no cover could be taken —
    /// is resized at the land. Late or stale — the beats already landed or
    /// were cancelled — it is ignored, the page already restored.
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
        if crossing.keepsPage { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let surface, !body.whole {
            body.container.surface = BodyViewController.color(surface)
            body.container.displayIfNeeded()
            body.lastCrossing?.surface = surface
        }
        body.webView.autoresizingMask = []
        body.webView.frame = CGRect(origin: .zero, size: crossing.size)
        CATransaction.commit()
    }

    /// The crossing is over: the cover comes off and the page follows its
    /// container again. A solved page is the landing size already, so the
    /// land resizes nothing; only a page that never took its crossing size —
    /// one kept to the land, or one that never said ready — is given the
    /// container's bounds here.
    private func endCrossing(_ body: Body) {
        guard let crossing = body.crossing else { return }
        body.crossing = nil
        body.lastCrossing?.restored = true
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let bounds = body.container.bounds
        let page = body.webView.frame.size
        if crossing.keepsPage || abs(page.width - bounds.width) > 0.5 || abs(page.height - bounds.height) > 0.5 {
            body.webView.frame = bounds
        }
        body.webView.autoresizingMask = Self.pageResizing
        if let stand = body.stand, let cardId = body.cardId, let cover = body.cover, stand.kinds.contains(.crossing) {
            if controller.lifecycle.covers.takeDown(stand, kind: .crossing, for: cardId) {
                cover.removeFromSuperview()
                body.cover = nil
                body.stand = nil
            } else {
                // Its page has not painted since it was brought back: the
                // cover stays for that, following its container again.
                cover.layer?.mask = nil
                cover.frame = body.container.bounds
                cover.autoresizingMask = [.width, .height]
            }
        }
        if body.crossingBand != nil || body.crossingSplit != nil {
            body.crossingBand = nil
            body.crossingSplit = nil
            body.webView.layer?.removeAnimation(forKey: Self.bandKey)
            body.webView.layer?.mask = nil
        }
        body.crossingTail?.removeFromSuperview()
        body.crossingTail = nil
        CATransaction.commit()
        controller.send(.bodyCrossing(.land), to: body)
    }

    private static func keyframes(_ keyPath: String, values: [Any], track: BodyBeats.Track, begin: CFTimeInterval) -> CAKeyframeAnimation {
        keyframes(keyPath, values: values, keyTimes: track.keyTimes, timings: track.timings, durationMs: track.durationMs, begin: begin)
    }

    private static func keyframes(
        _ keyPath: String, values: [Any], keyTimes: [Double], timings: [BodyBeats.Timing],
        durationMs: Double, begin: CFTimeInterval
    ) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = keyTimes.map { NSNumber(value: $0) }
        animation.timingFunctions = timings.map(timingFunction)
        animation.calculationMode = .linear
        animation.duration = durationMs / 1000
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
}
