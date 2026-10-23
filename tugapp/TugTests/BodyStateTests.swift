import XCTest

// A body's lifecycle is one state moved only by its table: each fault a
// stray flag once allowed — a closed card failed at its deadline, an
// eviction finishing on a reloaded page, a closed card's page reloaded, an
// unseen page reloaded outside the lane, a declined page asked for the
// whole of an episode — is a move the table refuses or an answer it gives.
final class BodyStateTests: XCTestCase {
    /// A state reached by `moves` from a new body, each of which must be made.
    private func state(_ moves: BodyState.Move...) -> BodyState {
        var state = BodyState()
        for move in moves {
            XCTAssertTrue(state.apply(move), "\(move) from \(state.phase)")
        }
        return state
    }

    // MARK: - The table

    func testABodyGoesFromLoadingToReadyByItsMoves() {
        let ready = state(.hello, .bind, .ready)
        XCTAssertEqual(ready.phase, .ready)
        XCTAssertFalse(ready.painted)
    }

    func testMovesOutOfOrderAreRefusedAndChangeNothing() {
        var state = BodyState()
        XCTAssertFalse(state.apply(.bind), "bound before hello")
        XCTAssertFalse(state.apply(.ready), "ready before bind")
        XCTAssertFalse(state.apply(.evict), "evicted before ready")
        XCTAssertFalse(state.apply(.decline), "declined with no eviction")
        XCTAssertEqual(state, BodyState())
    }

    func testAPageIsPaintedOnce() {
        var state = self.state(.hello, .bind, .paint)
        XCTAssertTrue(state.painted)
        XCTAssertFalse(state.apply(.paint))
        XCTAssertFalse(BodyState().after(.paint) != nil, "a loading page has nothing to paint")
    }

    func testAPageThatSaysHelloAgainIsBoundAfresh() {
        let state = self.state(.hello, .bind, .ready, .bind)
        XCTAssertEqual(state.phase, .bound)
    }

    func testAnEvictingBodyReadsAsALiveReadyPage() {
        let evicting = state(.hello, .bind, .ready, .evict)
        XCTAssertEqual(evicting.phase, .evicting)
        XCTAssertEqual(evicting.reported, "ready")
        XCTAssertTrue(evicting.isLive)
        XCTAssertFalse(evicting.after(.evict) != nil, "no second eviction over the first")
    }

    func testADeclinedEvictionLeavesTheBodyReady() {
        let kept = state(.hello, .bind, .ready, .evict, .decline)
        XCTAssertEqual(kept.phase, .ready)
        XCTAssertFalse(kept.evicting(since: kept.eviction))
    }

    func testKeptAcrossAReloadIsReportedOnce() {
        var state = self.state(.hello, .bind, .ready, .keepAcrossReload)
        XCTAssertTrue(state.keptAcrossShellReload)
        XCTAssertTrue(state.apply(.reportKept))
        XCTAssertFalse(state.keptAcrossShellReload)
        XCTAssertFalse(state.apply(.reportKept))
    }

    // MARK: - The faults

    /// A closed card's ready deadline, firing after the close, finds a move
    /// it cannot make, so the shell is never told a closed card failed.
    func testAClosedBodyCannotFail() {
        var state = self.state(.hello, .bind, .close)
        XCTAssertEqual(state.phase, .gone)
        XCTAssertFalse(state.apply(.fail))
        XCTAssertFalse(state.apply(.ready))
        XCTAssertFalse(state.apply(.reload), "a closed card's page is never loaded again")
        XCTAssertTrue(state.apply(.close), "closing twice is closing once")
    }

    func testAFailedBodyIsNotFailedAgain() {
        var state = self.state(.fail)
        XCTAssertFalse(state.apply(.fail))
        XCTAssertTrue(state.apply(.close))
    }

    /// A reload or a close in the middle of an eviction leaves it: the
    /// eviction in flight finds the body no longer evicting under its count,
    /// and lets it be.
    func testAReloadAbandonsAnEvictionInFlight() {
        var state = self.state(.hello, .bind, .ready, .paint, .show, .evict)
        let begun = state.eviction
        XCTAssertTrue(state.evicting(since: begun))
        XCTAssertTrue(state.apply(.reload))
        XCTAssertEqual(state.phase, .loading)
        XCTAssertFalse(state.painted)
        XCTAssertFalse(state.shownOnce)
        XCTAssertFalse(state.evicting(since: begun))
    }

    func testANewerEvictionIsNotTheOldOnes() {
        var state = self.state(.hello, .bind, .ready, .evict)
        let first = state.eviction
        XCTAssertTrue(state.apply(.decline))
        XCTAssertTrue(state.apply(.evict))
        XCTAssertFalse(state.evicting(since: first))
        XCTAssertTrue(state.evicting(since: state.eviction))
    }

    /// A close in the middle of an eviction leaves it too: the eviction's
    /// end finds the body gone, keeps no cover and tells the shell nothing,
    /// and the close alone removes it.
    func testACloseAbandonsAnEvictionInFlight() {
        var state = self.state(.hello, .bind, .ready, .evict)
        let begun = state.eviction
        XCTAssertTrue(state.apply(.close))
        XCTAssertEqual(state.phase, .gone)
        XCTAssertFalse(state.evicting(since: begun))
        XCTAssertFalse(state.apply(.decline), "a closed body is never handed back from its eviction")
    }

    /// A page that reloads itself while its eviction saves — WebKit's own
    /// reload, which says hello again without the host's `reload` — is bound,
    /// and the eviction in flight finds it no longer evicting under its
    /// count and lets it be.
    func testAPageBoundAgainMidEvictionAbandonsTheEviction() {
        var state = self.state(.hello, .bind, .ready, .evict)
        let begun = state.eviction
        XCTAssertTrue(state.apply(.bind), "the page that said hello again is bound")
        XCTAssertEqual(state.phase, .bound)
        XCTAssertFalse(state.evicting(since: begun))
        XCTAssertFalse(state.apply(.decline), "the abandoned eviction cannot hand the body back")
        XCTAssertTrue(state.apply(.ready))
        XCTAssertTrue(state.apply(.evict), "once ready the clock may ask it again")
    }

    // MARK: - The eviction clock

    /// A kind that may veto its close has no clock: none is armed for it,
    /// whatever it declined, and one falling due for it sets no other.
    func testAGuardedKindHasNoClockAndNoneFallsAgain() {
        let ready = state(.hello, .bind, .ready)
        XCTAssertFalse(ready.clockArms(guardsClose: true))
        XCTAssertTrue(ready.clockArms(guardsClose: false))
        let declined = state(.hello, .bind, .ready, .evict, .decline)
        XCTAssertFalse(declined.clockArms(guardsClose: true), "a critical eviction it declined arms nothing")
        XCTAssertEqual(ready.clockFalls(takeable: false, guardsClose: true), .stop)
        XCTAssertEqual(ready.clockFalls(takeable: true, guardsClose: true), .stop)
    }

    func testTheClockEvictsATakeableBodyAndAsksAnUntakeableOneAgain() {
        let ready = state(.hello, .bind, .ready)
        XCTAssertEqual(ready.clockFalls(takeable: true, guardsClose: false), .evict)
        XCTAssertEqual(ready.clockFalls(takeable: false, guardsClose: false), .again, "in the host's hand: asked a delay on")
        let evicting = state(.hello, .bind, .ready, .evict)
        XCTAssertEqual(evicting.clockFalls(takeable: false, guardsClose: false), .stop, "an eviction under way settles its own")
        let gone = state(.hello, .bind, .ready, .close)
        XCTAssertFalse(gone.clockArms(guardsClose: false))
        XCTAssertEqual(gone.clockFalls(takeable: false, guardsClose: false), .stop)
    }

    func testATerminationOfAClosedBodyDoesNothing() {
        let gone = state(.hello, .bind, .ready, .close)
        XCTAssertEqual(gone.onTermination(hasCard: true, seen: true, again: false), .ignore)
        XCTAssertEqual(gone.onTermination(hasCard: true, seen: false, again: true), .ignore)
    }

    func testATerminationOfAnUnseenCardIsAnEvictionNotAReload() {
        let ready = state(.hello, .bind, .ready)
        XCTAssertEqual(ready.onTermination(hasCard: true, seen: false, again: false), .evict)
        XCTAssertEqual(ready.onTermination(hasCard: true, seen: true, again: false), .reload)
        let loading = BodyState()
        XCTAssertEqual(loading.onTermination(hasCard: true, seen: false, again: false), .evict, "a page still loading too")
    }

    func testASecondTerminationFailsAndASparesIsDropped() {
        let ready = state(.hello, .bind, .ready)
        XCTAssertEqual(ready.onTermination(hasCard: true, seen: true, again: true), .fail)
        XCTAssertEqual(state(.hello).onTermination(hasCard: false, seen: false, again: false), .dropSpare)
    }

    // MARK: - A pressure episode

    func testAStepAsksTheOldestHiddenBodyThatHasNotDeclined() {
        var episode = PressureEpisode()
        episode.decline(1)
        XCTAssertEqual(episode.next(among: [(1, 10), (2, 20), (3, 30)]), 2)
        XCTAssertTrue(episode.passesOver(1))
        XCTAssertFalse(episode.passesOver(2))
    }

    /// Once only declined bodies are left, each is asked once more and never
    /// again in the same episode.
    func testADeclinedBodyIsAskedAgainAtMostOnce() {
        var episode = PressureEpisode()
        episode.decline(1)
        episode.decline(2)
        let left: [(serial: Int, hiddenSince: Double)] = [(1, 10), (2, 20)]
        XCTAssertEqual(episode.next(among: left), 1)
        episode.decline(1)
        XCTAssertEqual(episode.next(among: left), 2)
        episode.decline(2)
        XCTAssertNil(episode.next(among: left), "the episode has asked each declined body once more")
    }

    /// The source may say one level more than once: the episode goes on, so
    /// a declined body is not asked afresh by a delivery; a new level starts
    /// a new one.
    func testALevelSaidAgainContinuesItsEpisodeAndOnlyAChangeStartsOne() {
        var episode = PressureEpisode()
        episode.decline(1)
        let left: [(serial: Int, hiddenSince: Double)] = [(1, 10)]
        XCTAssertEqual(episode.next(among: left), 1)
        episode = episode.after(.warning, .warning)
        XCTAssertTrue(episode.passesOver(1), "the repeated warning keeps what the episode heard")
        XCTAssertNil(episode.next(among: left), "and asks the declined body no third time")
        XCTAssertEqual(episode.after(.warning, .critical), PressureEpisode())
        XCTAssertEqual(episode.after(.critical, .warning), PressureEpisode())
    }

    /// An eviction's snapshot that never answers ends at its deadline, with
    /// no cover; one that answers first is taken; and whichever comes second
    /// is dropped. The clock is a hand-run one.
    func testASnapshotThatNeverAnswersEndsAtItsDeadline() {
        var due: [(DispatchTimeInterval, () -> Void)] = []
        let clock: AnswerOrDeadline<Int>.Schedule = { delay, fire in due.append((delay, fire)) }

        var heard: [(Int?, Bool)] = []
        let silent = AnswerOrDeadline<Int>(deadline: .seconds(2), schedule: clock) { heard.append(($0, $1)) }
        XCTAssertEqual(due.count, 1, "the deadline is set when the question is asked")
        XCTAssertEqual(due[0].0, .seconds(2))
        XCTAssertTrue(heard.isEmpty)
        due[0].1()
        XCTAssertEqual(heard.count, 1)
        XCTAssertNil(heard[0].0)
        XCTAssertTrue(heard[0].1, "the deadline, not an answer, ended it")
        silent.answer(7)
        XCTAssertEqual(heard.count, 1, "an answer after the deadline is dropped")

        heard = []
        let prompt = AnswerOrDeadline<Int>(deadline: .seconds(2), schedule: clock) { heard.append(($0, $1)) }
        prompt.answer(5)
        due[1].1()
        XCTAssertEqual(heard.count, 1, "the deadline after an answer is dropped")
        XCTAssertEqual(heard[0].0, 5)
        XCTAssertFalse(heard[0].1)
    }

    /// Bodies are named by serial, which no later body takes: a new body
    /// that comes along is a stranger to the episode's declines.
    func testDeclinesAreKeptBySerial() {
        var episode = PressureEpisode()
        episode.decline(7)
        XCTAssertEqual(episode.next(among: [(7, 1), (8, 2)]), 8)
        XCTAssertEqual(episode.declined, [7])
    }
}
