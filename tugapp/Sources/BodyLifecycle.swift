import AppKit
import WebKit

/// The bodies' lifecycle: every move of a body's state, and what the host
/// does with a body's process — eviction by time and by memory pressure, the
/// covers an evicted card comes back under, and the declines a pressure
/// episode keeps.
///
/// It owns its own state — the pressure level and its source, the
/// episode's declines, the covers, the delay — and reaches into the
/// controller only to remove a body, tell the shell, and look at what the
/// placement and the host's hand say of a body. The controller places views
/// and routes reports; whether a body's page lives is decided here.
final class BodyLifecycle {
    typealias Body = BodyViewController.Body
    typealias PressureLevel = MemoryPressureLevel

    private unowned let controller: BodyViewController
    private unowned let window: MainWindow

    /// The level the host last heard: from the dispatch source, or from the
    /// harness standing in for it.
    private(set) var pressure: PressureLevel = .normal
    private let pressureSource = DispatchSource.makeMemoryPressureSource(
        eventMask: [.normal, .warning, .critical], queue: .main
    )
    /// The warning's next eviction, a beat after the last one finished —
    /// its process gone, or the body kept: a level change cancels it.
    private var pendingWarningStep: DispatchWorkItem?
    /// The warning's step chain: a step under way sets the next when it
    /// finishes, so a warning said again does not start a second, and a
    /// level change ends the chain so a step finishing after it sets none.
    private var warningSteps = WarningSteps()
    /// The bodies this episode asked and that declined — shown while saving,
    /// or a save that did not answer — by serial.
    private var episode = PressureEpisode()
    /// Every cover a body stands under — brought back from an eviction, or
    /// carried through a crossing — and the last frame of each card evicted
    /// and not yet asked for again, taken as its process went. Bounded: a
    /// kept cover older than `evictAfterMs` goes, and past `coverBudgetBytes`
    /// the oldest kept covers go first. The budget counts the covers standing
    /// over bodies as well, though none of those is ever dropped for it: a
    /// standing cover is on screen, so the kept ones give way to it. Critical
    /// pressure takes no cover, drops every kept one, and refuses any
    /// snapshot still answering.
    private(set) lazy var covers: BodyCovers = {
        let covers = BodyCovers(budgetBytes: BodyLifecycle.coverBudgetBytes)
        covers.onDrop = { cardId, why in
            TugLog.info("bodies", "cover dropped", [TugLog.field("card", cardId), TugLog.field("why", why.rawValue)])
        }
        return covers
    }()
    /// What the covers may hold together, kept and standing, counted in
    /// pixel bytes — the most they could hold resident. Twenty covers of a
    /// 640 × 480 pane at one point a pixel are 25.3 MB of pixels (100.7 MB
    /// at the backing's two), and moved the footprint 1.4 MB as CoreGraphics
    /// images against 26.7 MB for the same bytes malloc'd: so twenty ordinary
    /// panes keep theirs, and window-sized ones, 5 MB each, give way past six.
    /// A crossing's cover is taken at the backing's scale, and while it
    /// stands it leaves that much less room for the kept ones.
    static let coverBudgetBytes = 32 << 20
    /// How long a body may stay hidden before it gives up its process, ms:
    /// fifteen minutes. A dormant body has stopped working but still holds
    /// its page, and a 500-turn Session body sits at about 550 MB resident,
    /// dormant or not; after this long hidden it goes, and its card comes
    /// back as an arrival, at a rebuild of about half a second. A workspace
    /// glanced away from and back to never pays the rebuild, and one left for
    /// a quarter of an hour stops holding its memory. Pressure evicts sooner;
    /// this is the quiet machine's clock.
    static let evictAfter: Double = 900_000
    /// The clock the time trigger runs to: `evictAfter`, unless the harness
    /// has shortened it (`BodyViewController.setDelays`).
    private(set) var evictAfterMs: Double = BodyLifecycle.evictAfter
    /// How long a warning waits after one eviction before it takes the next:
    /// time for the process the last one gave up to be gone, and for the
    /// level to say whether that was enough.
    static let warningStepDelay: DispatchTimeInterval = .seconds(1)
    /// How soon the clock asks again a hidden body whose page did not answer
    /// its eviction's save, ms, when that is sooner than `evictAfterMs`: a
    /// page busy for a moment is asked in a moment, not a whole delay later.
    static let unsavedRetryMs: Double = 30_000
    /// How long a body's save may hold its close, its reload for an edit, or
    /// its eviction.
    static let saveDeadline: DispatchTimeInterval = .seconds(2)

    init(controller: BodyViewController, window: MainWindow) {
        self.controller = controller
        self.window = window
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

    // MARK: - Moves

    /// Move `body`'s state, the one way any path does. A move the lifecycle
    /// does not have from where the body stands is refused, logged, and
    /// changes nothing; the caller reads the answer and does nothing either.
    /// `quietly` leaves a refusal unlogged, for a path that asks whether a
    /// move is open rather than expecting it.
    @discardableResult
    func move(_ body: Body, _ move: BodyState.Move, quietly: Bool = false) -> Bool {
        if body.life.apply(move) { return true }
        if quietly { return false }
        TugLog.warn("bodies", "refused a body's move", [
            TugLog.field("card", body.cardId ?? "spare"),
            TugLog.field("move", move.rawValue),
            TugLog.field("phase", body.life.phase.rawValue),
        ])
        return false
    }

    // MARK: - Covers

    /// A card brought back from an eviction stands under its last frame
    /// until its new page paints, and the shell is told `covered`, which is
    /// what lets it show the card from the hand-off. A card with no cover —
    /// critical pressure, a snapshot that failed or did not answer, a cover
    /// aged or budgeted out — is told nothing and arrives as any card does,
    /// under the shell's stand-in until its page paints.
    func standCover(over body: Body) {
        guard let cardId = body.cardId, let stand = covers.standCover(for: cardId, kind: .eviction) else { return }
        let cover = BodyCoverView(cover: stand.cover, frame: body.container.bounds)
        if let insets = body.insets { cover.paneInsets = insets }
        cover.autoresizingMask = [.width, .height]
        body.container.addSubview(cover, positioned: .above, relativeTo: body.webView)
        body.cover = cover
        body.stand = stand
        body.wasCovered = true
        controller.notifyShell(BodyStateReport(cardId: cardId, state: .covered))
    }

    /// The body's page has painted: a cover it was brought back under
    /// comes off, unless a crossing still holds it to its land.
    func paintTakesDownCover(_ body: Body) {
        guard let cardId = body.cardId, let stand = body.stand,
              covers.takeDown(stand, kind: .eviction, for: cardId) else { return }
        body.cover?.removeFromSuperview()
        body.cover = nil
        body.stand = nil
    }

    // MARK: - Pressure

    /// The machine says how short of memory it is. On `warning` hidden
    /// bodies give up their processes oldest-hidden first, one at a time,
    /// until the warning clears or none is left; on `critical` every body
    /// the last placement did not name visible goes at once, a pane's
    /// siblings and the spare with them, and the spare is made again once
    /// the level eases. A body placed visible is never evicted, and nothing
    /// here counts bodies.
    ///
    /// A level said again continues its episode, and a repeated warning
    /// starts no step while one is under way or due; one whose steps had run
    /// out asks again, the episode still declining each body only once.
    func memoryPressure(_ level: PressureLevel) {
        let was = pressure
        let repeated = level == was
        pressure = level
        TugLog.info("bodies", "memory pressure", [TugLog.field("level", level.rawValue)])
        episode = episode.after(was, level)
        if !repeated {
            pendingWarningStep?.cancel()
            pendingWarningStep = nil
            warningSteps.levelChanged()
        }
        switch level {
        case .normal:
            if was == .critical { controller.scheduleSpare() }
            return
        case .warning:
            // A warning keeps the spare: one critical took is made again.
            if was == .critical { controller.scheduleSpare() }
            if repeated, warningSteps.busy || pendingWarningStep != nil { return }
            evictOldestHidden()
        case .critical:
            controller.lane.cancelPendingSpare()
            if let spare = controller.spare { controller.remove(spare) }
            // The covers are memory too: their cards come back under the
            // shell's stand-in.
            covers.clear()
            for body in controller.bodies where evictable(body, siblings: true) {
                evict(body, cause: "pressure-critical")
            }
        }
    }

    /// Whether pressure may take the body's process: a ready card the last
    /// placement did not name visible ([B06]), not in the host's hand, not
    /// already going. A warning takes only a hidden page — one WebKit
    /// throttles — never a sibling, which paints behind its pane's active
    /// card. A pressure step passes over a body it was refused while it has
    /// another to ask; the clock, outside any episode, asks it regardless.
    /// A closed card's body is never asked, and nor is one whose kind may
    /// veto its close except under critical pressure: only its page can
    /// answer that guard, so the clock and a warning leave it be, and
    /// critical, which must be able to take every hidden page, takes it
    /// while the shell keeps the page's last word on the guard.
    private func evictable(_ body: Body, siblings: Bool, episode inEpisode: Bool = true) -> Bool {
        guard body.cardId != nil, body.state == .ready, !body.visible,
              !(inEpisode && episode.passesOver(body.serial)) else { return false }
        if body.guardsClose, !siblings { return false }
        if controller.isInHand(body) { return false }
        return siblings || body.shown?.value == false
    }

    /// The eviction clock, from the harness: every hidden body's clock is set
    /// again against when it was hidden.
    func setEvictAfter(ms: Double) {
        guard ms > 0, ms != evictAfterMs else { return }
        evictAfterMs = ms
        TugLog.info("bodies", "evict after", [TugLog.field("ms", String(format: "%.0f", ms))])
        for body in controller.bodies { armEviction(body) }
    }

    /// Set the time trigger's eviction for `body`: due `evictAfterMs` after
    /// it was hidden, while it stays hidden, and nothing while it is shown.
    /// Only a hidden page — a sibling paints, and keeps its process until
    /// pressure says otherwise. When it falls due the body is asked as
    /// pressure asks, so one the placement named visible is never taken
    /// ([B06]); one that cannot be asked yet — in the host's hand, or
    /// mid-eviction — is asked again a whole delay on. A kind that may veto
    /// its close has no clock, now or after a critical eviction it declined.
    func armEviction(_ body: Body) {
        body.evictDue?.cancel()
        body.evictDue = nil
        let ms = evictAfterMs
        guard body.cardId != nil, let shown = body.shown, !shown.value else { return }
        scheduleEviction(body, inMs: max(0, ms - (Date().timeIntervalSince1970 * 1000 - shown.since)))
    }

    /// The time trigger's eviction for a hidden `body`, `delay` ms from now.
    private func scheduleEviction(_ body: Body, inMs delay: Double) {
        body.evictDue?.cancel()
        body.evictDue = nil
        let ms = evictAfterMs
        guard body.life.clockArms(guardsClose: body.guardsClose), body.cardId != nil,
              body.shown?.value == false else { return }
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body else { return }
            body.evictDue = nil
            let takeable = self.evictable(body, siblings: false, episode: false)
            switch body.life.clockFalls(takeable: takeable, guardsClose: body.guardsClose) {
            case .evict: self.evict(body, cause: "hidden")
            case .again: self.scheduleEviction(body, inMs: ms)
            case .stop: break
            }
        }
        body.evictDue = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(delay.rounded())), execute: work)
    }

    /// One step of a warning: the body hidden longest gives up its process,
    /// and a beat after that eviction has finished, the next, while the
    /// warning stands. A body that declined is asked once more at a later
    /// step, once every other hidden body has been asked, and not again.
    private func evictOldestHidden() {
        guard pressure == .warning else { return }
        let candidates = controller.bodies.filter { evictable($0, siblings: false, episode: false) }
        let next = episode.next(among: candidates.map { ($0.serial, $0.shown?.since ?? 0) })
        guard let oldest = candidates.first(where: { $0.serial == next }) else { return }
        let step = warningSteps.begin()
        evict(oldest, cause: "pressure-warning") { [weak self] in
            // A step the level change ended — the warning lifted and came
            // back while its eviction saved — sets no next: the new
            // warning's own chain is running.
            guard let self, self.warningSteps.finish(step), self.pressure == .warning else { return }
            let work = DispatchWorkItem { [weak self] in
                self?.pendingWarningStep = nil
                self?.evictOldestHidden()
            }
            self.pendingWarningStep = work
            DispatchQueue.main.asyncAfter(deadline: .now() + BodyLifecycle.warningStepDelay, execute: work)
        }
    }

    // MARK: - Eviction

    /// Give a hidden body's process up: its page writes its card's state, as
    /// `destroy(save: true)` has it, the host keeps its last frame for the
    /// cover the card comes back under — except under critical pressure, or
    /// when the snapshot fails or misses its deadline — and the view goes. The shell is told
    /// `evicted` and keeps the card, which comes back as an arrival when a
    /// placement next wants it shown. A body the placement named visible
    /// while it was saving is kept, and so is one whose page did not answer
    /// the save within `saveDeadline`: an eviction loses nothing unwritten,
    /// and a kept body's clock is set again. A card closed, reloaded or
    /// terminated while it goes is left to whatever took it: the eviction
    /// finishes only while the body is still evicting under the count it
    /// began with. `done` runs once, when the eviction has finished
    /// whichever way it went — the body removed, kept or let go — so a
    /// warning's next step is timed from there.
    private func evict(_ body: Body, cause: String, then done: (() -> Void)? = nil) {
        guard let cardId = body.cardId, move(body, .evict) else {
            done?()
            return
        }
        let count = body.life.eviction
        TugLog.info("bodies", "evicting", [TugLog.field("card", cardId), TugLog.field("cause", cause)])
        var settled = false
        let settle = { [weak self, weak body] (saved: Bool) in
            guard !settled else { return }
            settled = true
            guard let self, let body, body.life.evicting(since: count) else {
                self?.abandon(cardId: cardId, phase: body?.state)
                done?()
                return
            }
            guard saved, !body.visible else {
                self.decline(body, cardId: cardId, why: saved ? "shown" : "unsaved")
                done?()
                return
            }
            // The last frame, for the cover — none under critical pressure,
            // which would make every sleeping page paint when memory is
            // shortest; the card comes back under the shell's stand-in.
            // A cover is kept only in the generation it was taken in, so a
            // critical clear while the snapshot answers refuses it.
            let generation = self.covers.generation
            let finish = { [weak self, weak body] (cover: BodyCover?) in
                defer { done?() }
                guard let self, let body, body.life.evicting(since: count) else {
                    self?.abandon(cardId: cardId, phase: body?.state)
                    return
                }
                guard !body.visible else {
                    self.decline(body, cardId: cardId, why: "shown")
                    return
                }
                if let cover { self.covers.keep(cover, for: cardId, takenIn: generation, agesAfterMs: self.evictAfterMs) }
                self.controller.remove(body)
                TugLog.info("bodies", "evicted", [
                    TugLog.field("card", cardId),
                    TugLog.field("cause", cause),
                    TugLog.field("cover", cover.map { "\($0.bytes)" } ?? "none"),
                ])
                self.controller.notifyShell(BodyStateReport(cardId: cardId, state: .evicted, cause: cause))
            }
            if self.pressure == .critical {
                finish(nil)
            } else if !body.life.painted {
                // A page that has not painted would snapshot nothing it ever
                // showed: the cover standing over it, if one does, is its
                // last frame still — kept afresh, so it ages from this
                // eviction rather than from the one that took it.
                finish(body.stand?.cover.retaken(at: Date().timeIntervalSince1970 * 1000))
            } else {
                self.takeCover(of: body, cardId: cardId, then: finish)
            }
        }
        window.hostChannel.call(.saveState, in: body.webView) { result in
            if case .success = result { settle(true) } else { settle(false) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyLifecycle.saveDeadline) { settle(false) }
    }

    /// A body whose process died while nobody could see it: its page is
    /// gone, so it is evicted with no cover and no save — removed, the shell
    /// told `evicted`, the card brought back when a placement next wants it
    /// shown. Never a reload, which under pressure would bring every hidden
    /// page back at once and outside the lane.
    func evictTerminated(_ body: Body, cardId: String) {
        TugLog.warn("bodies", "WebContent process terminated — evicted, unseen", [TugLog.field("card", cardId)])
        controller.remove(body)
        controller.notifyShell(BodyStateReport(cardId: cardId, state: .evicted, cause: "terminated"))
    }

    /// The body's last frame as a cover, at one point a pixel: `done` gets
    /// it, or nil when the snapshot failed or did not answer within
    /// `saveDeadline` — an eviction goes on without a cover rather than
    /// standing `evicting` for ever. `done` runs once. A page WebKit is not
    /// painting still answers a snapshot, which it paints for the asking.
    private func takeCover(of body: Body, cardId: String, then done: @escaping (BodyCover?) -> Void) {
        let size = body.container.bounds.size
        let surface = body.surface
        let insets = body.insets
        controller.snapshotFrame(
            of: body, cardId: cardId, size: size, scale: 1, deadline: BodyLifecycle.saveDeadline,
            purpose: "an evicted card's cover"
        ) { frame in
            done(frame.map {
                BodyCover(image: $0, size: size, surface: surface, insets: insets, takenAt: Date().timeIntervalSince1970 * 1000)
            })
        }
    }

    /// The eviction is over and the body stays: a warning's next step asks
    /// it again only once no other hidden body is left, and only once, and
    /// its clock is set again from now — sooner for a save that did not
    /// answer.
    private func decline(_ body: Body, cardId: String, why: String) {
        move(body, .decline)
        episode.decline(body.serial)
        TugLog.info("bodies", "eviction declined", [
            TugLog.field("card", cardId),
            TugLog.field("why", why),
        ])
        let ms = evictAfterMs
        scheduleEviction(body, inMs: why == "unsaved" ? min(ms, BodyLifecycle.unsavedRetryMs) : ms)
    }

    /// The body left its eviction while it was in flight — closed, reloaded
    /// or terminated — and the eviction keeps no cover and tells the shell
    /// nothing: whatever took the body speaks for it.
    private func abandon(cardId: String, phase: BodyState.Phase?) {
        TugLog.info("bodies", "eviction abandoned", [
            TugLog.field("card", cardId),
            TugLog.field("why", phase == .gone || phase == nil ? "closed" : "reloaded"),
        ])
    }
}
