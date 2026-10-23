import AppKit

/// The cards waiting for a page, and the spare.
///
/// A card asked for when no spare stands waits here for a cold body at
/// `/?body=<cardId>`, and the lane makes pages for waiting cards while fewer
/// than `width` are loading: a shown card before a hidden one, then the
/// deck's reading order, then the order they were asked in. The spare is made
/// only once the lane is idle, since a page loading beside the one the user
/// waits for slows both. The lane owns its queue and the spare's timing; the
/// controller makes the views and places them.
final class BodyLane {
    typealias Body = BodyViewController.Body

    /// How long after the shell's launch, and after each bound body's ready,
    /// the spare is made: late enough to stay out of the way of the page
    /// that just painted.
    static let spareDelay: DispatchTimeInterval = .seconds(1)
    /// How many cards' pages load at once. Every page fetches the deck's
    /// whole module graph through the one connection pool the app's pages
    /// share, so a page's load grows with how many are loading beside it:
    /// on a warm six-card launch, six at once all painted at 4.8 s; two at
    /// a time painted the first two at 2.2 s and the last at 5.5 s, three
    /// at a time the first three at 2.9 s and the last at 5.2 s. The whole
    /// is the same either way; the width decides how soon the first cards
    /// are live. Read against the launch's `deck-populated` lap.
    static let width = 2
    /// How long a card asked for before the shell has placed it waits for
    /// that placement, which says whether it is shown and where it reads,
    /// before the lane takes it in the order it was asked for.
    static let placementWait: DispatchTimeInterval = .milliseconds(100)

    private unowned let controller: BodyViewController

    /// A card whose page is not yet made: asked for, and waiting in the lane.
    private struct Entry {
        let cardId: String
        var componentId: String
        var intent: JSONObject
        var guardsClose: Bool
        let askedAt: CFTimeInterval
        let serial: Int
    }
    /// The cards waiting for a page, in the order they were asked for.
    private var lane: [Entry] = []
    private var serials = 0
    /// The lane's wait for a placement (`placementWait`).
    private var pendingDrain: DispatchWorkItem?
    /// The spare's pending creation, so a burst of readies makes one.
    private var pendingSpare: DispatchWorkItem?

    init(controller: BodyViewController) {
        self.controller = controller
    }

    private var bodies: [Body] { controller.bodies }

    /// No card is waiting for a page.
    var isEmpty: Bool { lane.isEmpty }

    /// No card's page is waiting in the lane or loading.
    var isIdle: Bool { lane.isEmpty && inFlight == 0 }

    /// `cardId` waits for a page. Asked for again while it waits, it keeps
    /// its place and takes what it was asked for last.
    func ask(cardId: String, componentId: String, intent: JSONObject, guardsClose: Bool) {
        if let index = lane.firstIndex(where: { $0.cardId == cardId }) {
            lane[index].componentId = componentId
            lane[index].intent = intent
            lane[index].guardsClose = guardsClose
            return
        }
        serials += 1
        lane.append(Entry(
            cardId: cardId, componentId: componentId, intent: intent, guardsClose: guardsClose,
            askedAt: CACurrentMediaTime(), serial: serials
        ))
        if controller.cardPlacements[cardId] != nil { drain() } else { scheduleDrain() }
    }

    /// A card closed while it waited has no page to make.
    func forget(cardId: String) {
        lane.removeAll { $0.cardId == cardId }
    }

    /// Nothing waits in the lane: the bodies are all going.
    func clear() {
        pendingDrain?.cancel()
        pendingDrain = nil
        lane.removeAll()
    }

    /// The cards whose pages are loading: made, not yet ready. The spare is
    /// not one: it holds no card.
    private var inFlight: Int {
        bodies.filter { body in
            body.cardId != nil && (body.state == .loading || body.state == .connected || body.state == .bound)
        }.count
    }

    /// The next card the lane makes a page for: a shown card before a hidden
    /// one, then the deck's reading order, then the order it was asked for.
    /// A card the shell has not placed yet reads as hidden and last.
    private func next() -> Int? {
        func key(_ entry: Entry) -> (Int, Int, Int) {
            let shown = controller.cardPlacements[entry.cardId]?.visible == true ? 0 : 1
            return (shown, controller.placedEntries[entry.cardId]?.deckIndex ?? Int.max, entry.serial)
        }
        return lane.indices.min { key(lane[$0]) < key(lane[$1]) }
    }

    /// Make pages for waiting cards while fewer than `width` are loading.
    /// Run when a card is asked for, when a placement lands, and when a page
    /// leaves the lane: ready, failed at its deadline, or gone.
    func drain() {
        pendingDrain?.cancel()
        pendingDrain = nil
        while inFlight < BodyLane.width, let index = next() {
            let entry = lane.remove(at: index)
            make(entry)
        }
    }

    /// Drain once the shell's placement has had a moment to arrive.
    private func scheduleDrain() {
        guard pendingDrain == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.pendingDrain = nil
            self?.drain()
        }
        pendingDrain = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyLane.placementWait, execute: work)
    }

    private func make(_ entry: Entry) {
        guard let made = controller.make(cardId: entry.cardId, path: "/?body=\(entry.cardId)") else {
            // No page could be made for it: the shell hears the card failed,
            // as at a missed deadline, and decides whether to ask again,
            // rather than waiting on a page that will never come.
            controller.notifyShell(BodyStateReport(cardId: entry.cardId, state: .failed, cause: "no page could be made"))
            return
        }
        made.componentId = entry.componentId
        made.intent = entry.intent
        made.guardsClose = entry.guardsClose
        // The card has been dark since it was asked for, not since its page
        // left the lane.
        made.askedAt = entry.askedAt
        controller.lifecycle.standCover(over: made)
        controller.armDeadline(made)
        // The shell placed the card while it waited, and will not again
        // until something moves: the page stands where that placement put it.
        if let (placed, deckIndex) = controller.placedEntries[entry.cardId] {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            controller.place(made, placed, deckIndex: deckIndex)
            // Into its rail's view if it is a rail member, and stacked.
            controller.reconcileRails()
            CATransaction.commit()
            controller.refreshRegion()
        }
    }

    // MARK: - The spare

    /// Make the spare: a body loaded at `/?body=spare`, connected and waiting
    /// for the next card. The caller decides when, and the lane has the last
    /// word: while a card's page is waiting or loading the spare would compete
    /// with the page the user is waiting for, so it is not made until the lane
    /// has drained, and the lane's last departure schedules it again.
    func createSpare() {
        // Critical pressure took the spare; the next arrival is cold.
        guard controller.spare == nil, controller.lifecycle.pressure != .critical else { return }
        guard isIdle else { return }
        _ = controller.make(cardId: nil, path: "/?body=spare")
    }

    /// Make the spare a beat from now, if there is none by then: after the
    /// shell's launch, after a bound body's ready, after the lane's last page
    /// leaves it, and after the spare is lost.
    func scheduleSpare() {
        pendingSpare?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSpare = nil
            self?.createSpare()
        }
        pendingSpare = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyLane.spareDelay, execute: work)
    }

    /// A spare asked for is not made after all: critical pressure takes it,
    /// or the window is going.
    func cancelPendingSpare() {
        pendingSpare?.cancel()
        pendingSpare = nil
    }
}
