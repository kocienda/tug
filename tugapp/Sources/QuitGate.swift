import Foundation

/// The host's half of the quit guard, for the Quit item and for ⌘Q in a body or
/// the overlay: ask the shell, under a deadline, whether it will ask the user.
///
/// A quit may be slow; it may never hang. So anything but a prompt "will ask"
/// goes on with the quit: no answer inside the deadline, a failed call, a page
/// with nothing to answer with, or "nothing to ask". "Will ask" only ends the
/// wait. The alert's outcome is not the answer, so the deadline never races a
/// person reading a dialog, and it arrives later as `confirmed()`. The host
/// does not hear a Cancel, so it holds no state for an open alert: a further
/// request asks the shell again, and the shell joins the question it has up.
///
/// The gate holds no window and no timer of its own, so its whole decision is
/// reachable from a unit test.
final class QuitGate {
    /// How long the shell has to answer. It answers at once from a live page.
    static let answerDeadline: TimeInterval = 1.0

    private enum Phase {
        case idle
        case awaitingAnswer
        case quitting
    }

    private var phase = Phase.idle
    private var cancelDeadline: (() -> Void)?

    private let ask: (@escaping (Result<PageReply, Error>) -> Void) -> Void
    private let schedule: (TimeInterval, @escaping () -> Void) -> (() -> Void)
    private let terminate: (String) -> Void

    /// - Parameters:
    ///   - ask: make the page call, reporting its reply.
    ///   - schedule: run the closure after the interval; the result cancels it.
    ///   - terminate: go on with the quit, for the reason given.
    init(
        ask: @escaping (@escaping (Result<PageReply, Error>) -> Void) -> Void,
        schedule: @escaping (TimeInterval, @escaping () -> Void) -> (() -> Void),
        terminate: @escaping (String) -> Void
    ) {
        self.ask = ask
        self.schedule = schedule
        self.terminate = terminate
    }

    /// The user asked to quit, from the Quit item or a page that is not the shell.
    func request() {
        guard phase == .idle else { return }
        phase = .awaitingAnswer
        cancelDeadline = schedule(Self.answerDeadline) { [weak self] in
            self?.quit(because: "the page did not answer in time")
        }
        ask { [weak self] reply in self?.answered(reply) }
    }

    /// The shell's guard says go on: the user chose Quit, or the work ended.
    func confirmed() {
        quit(because: "the quit guard confirmed it")
    }

    /// A quit is running, by whatever door it came, so nothing further asks.
    func terminationBegan() {
        endWait()
        phase = .quitting
    }

    private func answered(_ reply: Result<PageReply, Error>) {
        guard phase == .awaitingAnswer else { return }
        switch reply {
        case .success(.quitAnswer(let answer)):
            if answer.willAsk {
                endWait()
                phase = .idle
            } else {
                quit(because: "nothing to ask")
            }
        case .success:
            quit(because: "the page had no answer")
        case .failure:
            quit(because: "the page call failed")
        }
    }

    private func quit(because reason: String) {
        guard phase != .quitting else { return }
        endWait()
        phase = .quitting
        terminate(reason)
    }

    private func endWait() {
        cancelDeadline?()
        cancelDeadline = nil
    }
}
