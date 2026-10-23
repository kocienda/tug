import Foundation

/// How short of memory the machine says it is: the dispatch source's three
/// levels, or the harness standing in for it (`simulateMemoryPressure`).
enum MemoryPressureLevel: String {
    case normal, warning, critical
}

/// One body's lifecycle: the phase its page is in and the facts that ride
/// with it, moved only by `apply`, which refuses a move the lifecycle does
/// not have.
///
/// A body's flags used to be separate — an eviction in flight, a card gone,
/// a body kept across a shell reload, its first showing, its paint — and
/// every path had to remember to reset another's. Here each is the phase or
/// a fact of it, and a path that would leave them disagreeing is a move the
/// table refuses: a closed body cannot be failed at its deadline, a reloaded
/// one cannot be finished by the eviction it was in the middle of, and a
/// gone one is never loaded again.
struct BodyState: Equatable {
    enum Phase: String {
        /// Its page is loading: made, taken back by a reload, or not yet said hello.
        case loading
        /// Its page said hello and waits to be told its card.
        case connected
        /// Told its card, not yet ready.
        case bound
        /// Its card is mounted and quiet.
        case ready
        /// Its page is writing its card's state on the way to giving up its
        /// process, which no second eviction may start over.
        case evicting
        /// Given up on: its deadline passed, or its process died twice.
        case failed
        /// Its card closed, or the body otherwise went: anything still in
        /// flight for it finds it here and leaves it alone.
        case gone
    }

    enum Move: String {
        case hello, bind, ready, paint, show, keepAcrossReload, reportKept
        case evict, decline, reload, fail, close
    }

    private(set) var phase: Phase = .loading
    /// The page has posted `painted`; a reload takes it back.
    private(set) var painted = false
    /// The body has been shown once. Until it has, a hidden body is hidden
    /// by opacity, so WebKit keeps painting the frame the showing reveals; a
    /// reload takes it back.
    private(set) var shownOnce = false
    /// The body outlived a shell reload, and the reloaded shell has not yet
    /// asked for it.
    private(set) var keptAcrossShellReload = false
    /// How many evictions the body has begun: an eviction in flight finishes
    /// only while the body is still evicting under the count it began with.
    private(set) var eviction = 0

    /// The phase as the harness reads it: an evicting body is still a ready
    /// page until its eviction finishes.
    var reported: String { phase == .evicting ? Phase.ready.rawValue : phase.rawValue }

    /// The page is alive and bound to its card: it can be told things and
    /// asked to save.
    var isLive: Bool { phase == .ready || phase == .evicting }

    /// Make `move`, or refuse it and change nothing. Returns whether it was made.
    @discardableResult
    mutating func apply(_ move: Move) -> Bool {
        guard let next = after(move) else { return false }
        self = next
        return true
    }

    /// The state `move` leads to, or nil when the lifecycle has no such move from here.
    func after(_ move: Move) -> BodyState? {
        var next = self
        switch (move, phase) {
        case (.hello, .loading):
            next.phase = .connected
        // A page that says hello again — reloaded by WebKit rather than by
        // the host — is bound afresh, as it always was. One that reloads
        // itself while its eviction saves abandons the eviction: the page it
        // was saving is gone, and the clock asks the new one again once it
        // is ready.
        case (.bind, .connected), (.bind, .bound), (.bind, .ready), (.bind, .evicting):
            next.phase = .bound
        case (.ready, .bound):
            next.phase = .ready
        case (.paint, .bound), (.paint, .ready), (.paint, .evicting):
            guard !painted else { return nil }
            next.painted = true
        case (.show, _):
            guard phase != .gone, phase != .failed else { return nil }
            next.shownOnce = true
        case (.keepAcrossReload, _):
            guard phase != .gone, phase != .failed else { return nil }
            next.keptAcrossShellReload = true
        case (.reportKept, _):
            guard keptAcrossShellReload else { return nil }
            next.keptAcrossShellReload = false
        case (.evict, .ready):
            next.phase = .evicting
            next.eviction += 1
        case (.decline, .evicting):
            next.phase = .ready
        // A reload abandons an eviction in flight: the page it was saving is
        // the one the reload replaces.
        case (.reload, .loading), (.reload, .connected), (.reload, .bound), (.reload, .ready), (.reload, .evicting):
            next.phase = .loading
            next.painted = false
            next.shownOnce = false
        case (.fail, _):
            guard phase != .gone, phase != .failed else { return nil }
            next.phase = .failed
        case (.close, _):
            next.phase = .gone
        default:
            return nil
        }
        return next
    }

    /// Whether an eviction begun at `count` is still the body's own.
    func evicting(since count: Int) -> Bool {
        phase == .evicting && eviction == count
    }

    /// Whether the eviction clock may stand for the body at all: never for
    /// a gone body, and never for a kind that may veto its close, which
    /// only its page can answer — critical pressure alone takes that one.
    func clockArms(guardsClose: Bool) -> Bool {
        phase != .gone && !guardsClose
    }

    /// What the eviction clock does when it falls due.
    enum ClockFall: Equatable {
        /// Evict the body now.
        case evict
        /// The body cannot be taken yet — in the host's hand, say — so the
        /// clock is set again a whole delay on.
        case again
        /// Nothing, and no clock after it: the body is going, an eviction
        /// already under way settles its own, or it has no clock.
        case stop
    }

    /// The clock falls due for the body, which `takeable` says may or may
    /// not be evicted now.
    func clockFalls(takeable: Bool, guardsClose: Bool) -> ClockFall {
        guard clockArms(guardsClose: guardsClose) else { return .stop }
        if takeable { return .evict }
        return phase == .evicting ? .stop : .again
    }

    /// What a WebContent termination does to the body.
    enum TerminationAnswer: Equatable {
        /// Nothing: the card closed and its page was going anyway.
        case ignore
        /// The process died twice inside the window: give the body up.
        case fail
        /// A spare holds nothing: drop it and let the next be made.
        case dropSpare
        /// An evicted card's: its page is gone and nobody sees it, so it is
        /// evicted without a cover and comes back when it is wanted.
        case evict
        /// Load its page again, under the same card.
        case reload
    }

    /// What a termination does: a gone body's does nothing, a second inside
    /// the window fails it, a spare's drops it, an unseen card's is an
    /// eviction with no cover — never a reload, which under pressure would
    /// bring every hidden page back at once, outside the lane — and a seen
    /// card's reloads its page.
    func onTermination(hasCard: Bool, seen: Bool, again: Bool) -> TerminationAnswer {
        if phase == .gone { return .ignore }
        if again { return .fail }
        if !hasCard { return .dropSpare }
        return seen ? .reload : .evict
    }
}

/// One memory-pressure episode's account of the bodies it asked and that
/// declined: shown while they saved, or a save that did not answer.
///
/// A step passes over a declined body while it has another to ask, and once
/// none is left asks each declined body once more — never again in the same
/// episode, so a page that does not answer is not asked every save deadline
/// for as long as the warning stands. Bodies are named by serial, which no
/// later body takes, never by an identity a freed body hands on.
struct PressureEpisode: Equatable {
    private(set) var declined: Set<Int> = []
    private(set) var reasked: Set<Int> = []

    /// The episode standing once the machine says `level` after `was`. A
    /// level said again continues the episode, since the source may say one
    /// level more than once and a declined body is asked again once an
    /// episode, not once a delivery; only a change of level starts a new one.
    func after(_ was: MemoryPressureLevel, _ level: MemoryPressureLevel) -> PressureEpisode {
        level == was ? self : PressureEpisode()
    }

    /// A body declined.
    mutating func decline(_ serial: Int) {
        declined.insert(serial)
    }

    /// Whether a step passes over the body while it has another to ask.
    func passesOver(_ serial: Int) -> Bool {
        declined.contains(serial)
    }

    /// The body a step asks next among those it could take, each with when
    /// it was hidden: the one hidden longest that has not declined, else the
    /// one hidden longest that declined and has not been asked again — which
    /// is then counted as asked again. Nil when there is none.
    mutating func next(among candidates: [(serial: Int, hiddenSince: Double)]) -> Int? {
        let byAge = { (a: (serial: Int, hiddenSince: Double), b: (serial: Int, hiddenSince: Double)) in
            a.hiddenSince < b.hiddenSince
        }
        if let fresh = candidates.filter({ !declined.contains($0.serial) }).min(by: byAge) {
            return fresh.serial
        }
        guard let again = candidates.filter({ !reasked.contains($0.serial) }).min(by: byAge) else { return nil }
        reasked.insert(again.serial)
        return again.serial
    }
}

/// The first of an answer and its deadline, once: a question that may never
/// be answered — an eviction's snapshot of a page WebKit cannot paint — still
/// ends, with nothing, at its deadline, and an answer that comes later is
/// dropped. `schedule` is the clock, injected, so the race is a unit test.
final class AnswerOrDeadline<Value> {
    typealias Schedule = (DispatchTimeInterval, @escaping () -> Void) -> Void

    static var mainQueue: Schedule {
        { delay, fire in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: fire) }
    }

    private var done: ((Value?, Bool) -> Void)?

    /// `done` runs once: with the answer and `false`, or with nil and `true`
    /// at the deadline.
    init(
        deadline: DispatchTimeInterval,
        schedule: Schedule = AnswerOrDeadline.mainQueue,
        done: @escaping (_ value: Value?, _ timedOut: Bool) -> Void
    ) {
        self.done = done
        schedule(deadline) { self.finish(nil, timedOut: true) }
    }

    func answer(_ value: Value?) {
        finish(value, timedOut: false)
    }

    private func finish(_ value: Value?, timedOut: Bool) {
        guard let done else { return }
        self.done = nil
        done(value, timedOut)
    }
}
