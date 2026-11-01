import XCTest

final class QuitGateTests: XCTestCase {
    private struct CallFailed: Error {}

    /// A gate whose page call and deadline the test drives by hand.
    private final class Harness {
        var asks = 0
        var reply: ((Result<PageReply, Error>) -> Void)?
        var scheduled: [TimeInterval] = []
        var fire: (() -> Void)?
        var cancels = 0
        var reasons: [String] = []
        lazy var gate = QuitGate(
            ask: { [unowned self] reply in
                self.asks += 1
                self.reply = reply
            },
            schedule: { [unowned self] interval, fire in
                self.scheduled.append(interval)
                self.fire = fire
                return { [unowned self] in self.cancels += 1 }
            },
            terminate: { [unowned self] reason in self.reasons.append(reason) }
        )

        func answer(willAsk: Bool) {
            reply?(.success(.quitAnswer(QuitAnswer(willAsk: willAsk))))
        }
    }

    func testARequestAsksUnderTheDeadline() {
        let h = Harness()
        h.gate.request()
        check("the page was asked once", h.asks == 1)
        check("the wait has its deadline", h.scheduled == [QuitGate.answerDeadline])
        check("nothing has quit yet", h.reasons.isEmpty)
    }

    func testNoAnswerByTheDeadlineQuits() {
        let h = Harness()
        h.gate.request()
        h.fire?()
        check("the deadline quits", h.reasons.count == 1, "\(h.reasons)")
    }

    func testAFailedCallQuits() {
        let h = Harness()
        h.gate.request()
        h.reply?(.failure(CallFailed()))
        check("a failure quits", h.reasons.count == 1, "\(h.reasons)")
    }

    func testAPageWithNoAnswerQuits() {
        let h = Harness()
        h.gate.request()
        h.reply?(.success(.nothing))
        check("no answer quits", h.reasons.count == 1, "\(h.reasons)")
    }

    func testNothingToAskQuitsAndEndsTheDeadline() {
        let h = Harness()
        h.gate.request()
        h.answer(willAsk: false)
        check("nothing to ask quits", h.reasons == ["nothing to ask"], "\(h.reasons)")
        check("the deadline is cancelled", h.cancels == 1)
    }

    func testWillAskEndsTheWaitWithoutQuitting() {
        let h = Harness()
        h.gate.request()
        h.answer(willAsk: true)
        check("the deadline is cancelled", h.cancels == 1)
        check("nothing quit", h.reasons.isEmpty, "\(h.reasons)")
    }

    func testTheOutcomeArrivesLaterAsConfirmed() {
        let h = Harness()
        h.gate.request()
        h.answer(willAsk: true)
        h.gate.confirmed()
        check("confirming quits", h.reasons.count == 1, "\(h.reasons)")
    }

    func testARequestAfterWillAskAsksAgainBecauseACancelIsNeverHeard() {
        let h = Harness()
        h.gate.request()
        h.answer(willAsk: true)
        h.gate.request()
        check("the page was asked again", h.asks == 2)
    }

    func testARequestDuringTheWaitAsksNothingMore() {
        let h = Harness()
        h.gate.request()
        h.gate.request()
        check("one ask", h.asks == 1)
        check("one deadline", h.scheduled.count == 1)
    }

    func testOnceQuittingNothingFurtherHappens() {
        let h = Harness()
        h.gate.request()
        h.answer(willAsk: true)
        h.gate.confirmed()
        h.gate.confirmed()
        h.gate.request()
        check("quit once", h.reasons.count == 1, "\(h.reasons)")
        check("the page was not asked again", h.asks == 1)
    }

    func testALateAnswerAfterTheDeadlineChangesNothing() {
        let h = Harness()
        h.gate.request()
        h.fire?()
        h.answer(willAsk: true)
        h.gate.request()
        check("quit once", h.reasons.count == 1, "\(h.reasons)")
        check("no further ask", h.asks == 1)
    }

    func testAQuitByAnotherDoorStopsTheGate() {
        let h = Harness()
        h.gate.request()
        h.gate.terminationBegan()
        check("the wait ended", h.cancels == 1)
        h.answer(willAsk: false)
        h.gate.confirmed()
        h.gate.request()
        check("the gate terminates nothing itself", h.reasons.isEmpty, "\(h.reasons)")
        check("no further ask", h.asks == 1)
    }
}
