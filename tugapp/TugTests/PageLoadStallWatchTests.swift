import XCTest

final class PageLoadStallWatchTests: XCTestCase {
    private let budget = PageLoadStallWatch.loadBudget

    func testAHealthyLoadTakesNoReading() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 100)
        check("a load inside its budget fires nothing", watch.navigationFinished(at: 100.3).reading == nil)
        check("its budget timer fires nothing", watch.budgetElapsed(forNavigationStartedAt: 100, at: 100 + budget).reading == nil)
    }

    func testALoadPastItsBudgetTakesOneReading() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 100)
        let fired = watch.budgetElapsed(forNavigationStartedAt: 100, at: 100 + budget).reading
        check("the budget fires", fired == .budgetElapsed(elapsed: budget), "\(String(describing: fired))")
        check("the late finish of the same load does not read again", watch.navigationFinished(at: 115).reading == nil)
    }

    func testALateFinishWithNoTimerTakesAReading() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        let fired = watch.navigationFinished(at: 15).reading
        check("a finish past the budget fires", fired == .finishedLate(elapsed: 15), "\(String(describing: fired))")
    }

    func testATerminationDuringALoadTakesAReading() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 10)
        let fired = watch.contentProcessTerminated(at: 13).reading
        check("a termination mid-load fires", fired == .terminatedDuringLoad(elapsed: 3), "\(String(describing: fired))")
    }

    func testATerminationWithThePageIdleTakesNoReading() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        _ = watch.navigationFinished(at: 0.3).reading
        check("jetsam on an idle page fires nothing", watch.contentProcessTerminated(at: 600).reading == nil)
    }

    func testOneIncidentIsReadOnce() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        check("the first trigger fires", watch.contentProcessTerminated(at: 2).reading != nil)
        // The recovery reload is the same incident: its stall reads nothing.
        watch.navigationStarted(at: 3)
        check("the reload's termination does not", watch.contentProcessTerminated(at: 5).reading == nil)
        check("nor its budget", watch.budgetElapsed(forNavigationStartedAt: 3, at: 3 + budget).reading == nil)
    }

    func testAHealthyLoadEndsTheIncident() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        _ = watch.budgetElapsed(forNavigationStartedAt: 0, at: budget).reading
        watch.navigationStarted(at: 20)
        _ = watch.navigationFinished(at: 20.3).reading
        watch.navigationStarted(at: 1000)
        check("the next incident is read", watch.budgetElapsed(forNavigationStartedAt: 1000, at: 1000 + budget).reading != nil)
    }

    func testAStaleTimerFiresNothing() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        watch.navigationStarted(at: 5)
        check("the replaced navigation's timer fires nothing", watch.budgetElapsed(forNavigationStartedAt: 0, at: budget).reading == nil)
        check("the live one's fires", watch.budgetElapsed(forNavigationStartedAt: 5, at: 5 + budget).reading != nil)
    }

    func testAFailedLoadIsNotAStall() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        watch.navigationFailed()
        check("its budget fires nothing", watch.budgetElapsed(forNavigationStartedAt: 0, at: budget).reading == nil)
        check("a later termination fires nothing", watch.contentProcessTerminated(at: 9).reading == nil)
    }

    // MARK: The wedge

    func testOneHangIsOnlySuspected() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        let event = watch.budgetElapsed(forNavigationStartedAt: 0, at: budget)
        check("one overrun is a suspicion", event.verdict == .suspect, "\(event)")
        check("and not a wedge", !watch.isWedged)
    }

    func testOneTerminationKeepsTheOneReload() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        _ = watch.navigationFinished(at: 0.3)
        let event = watch.contentProcessTerminated(at: 600)
        check("an idle termination is a suspicion", event.verdict == .suspect, "\(event)")
        check("which leaves the reload alone", !watch.isWedged)
    }

    /// The incident this was written from: the launch's load overran, and
    /// the content process died under it.
    func testAnOverrunThenATerminationIsAWedge() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        _ = watch.budgetElapsed(forNavigationStartedAt: 0, at: budget)
        let event = watch.contentProcessTerminated(at: 15)
        check("the second hang is the wedge", event.verdict == .wedged, "\(event)")
        check("and it holds", watch.isWedged)
    }

    func testTwoTerminationsInTheWindowAreAWedge() {
        var watch = PageLoadStallWatch()
        check("the first is suspected", watch.contentProcessTerminated(at: 100).verdict == .suspect)
        check("the second is the wedge", watch.contentProcessTerminated(at: 130).verdict == .wedged)
    }

    /// The recovery reload is a freshly spawned page; that it stalls too is
    /// what says the stall is the machine's.
    func testAFreshPageThatAlsoOverrunsIsAWedge() {
        var watch = PageLoadStallWatch()
        _ = watch.contentProcessTerminated(at: 100)
        watch.navigationStarted(at: 101)
        let event = watch.budgetElapsed(forNavigationStartedAt: 101, at: 101 + budget)
        check("the reload's overrun is the wedge", event.verdict == .wedged, "\(event)")
    }

    func testALateFinishCountsItsOverrunOnce() {
        var watch = PageLoadStallWatch()
        watch.navigationStarted(at: 0)
        _ = watch.budgetElapsed(forNavigationStartedAt: 0, at: budget)
        let event = watch.navigationFinished(at: 16)
        check("the same load is not two hangs", event.verdict == nil, "\(event)")
        check("so there is no wedge", !watch.isWedged)
    }

    func testHangsFurtherApartThanTheWindowAreNoWedge() {
        var watch = PageLoadStallWatch()
        _ = watch.contentProcessTerminated(at: 0)
        let event = watch.contentProcessTerminated(at: PageLoadStallWatch.wedgeWindow + 1)
        check("an old hang has aged out", event.verdict == .suspect, "\(event)")
    }

    func testAHealthyLoadBetweenHangsClearsTheSuspicion() {
        var watch = PageLoadStallWatch()
        _ = watch.contentProcessTerminated(at: 0)
        watch.navigationStarted(at: 1)
        check("the reload is healthy", watch.navigationFinished(at: 1.3).verdict == .healthy)
        check("so the next hang is only suspected", watch.contentProcessTerminated(at: 30).verdict == .suspect)
    }

    func testAHealthyLoadEndsAWedge() {
        var watch = PageLoadStallWatch()
        _ = watch.contentProcessTerminated(at: 0)
        _ = watch.contentProcessTerminated(at: 5)
        watch.navigationStarted(at: 60)
        _ = watch.navigationFinished(at: 60.3)
        check("a healthy load says the service recovered", !watch.isWedged)
    }

    func testTryingAgainStartsTheCountOver() {
        var watch = PageLoadStallWatch()
        _ = watch.contentProcessTerminated(at: 0)
        _ = watch.contentProcessTerminated(at: 5)
        watch.clearWedge()
        check("the wedge is forgotten", !watch.isWedged)
        check("and one more hang is only suspected", watch.contentProcessTerminated(at: 10).verdict == .suspect)
    }

    func testGpuProcessesAreFoundByName() {
        let ps = """
          501     1   01:02:03  0.0  1234 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU
          777     1      10:00 12.5  4321 com.apple.WebKit.WebContent
          900   501      00:05  0.0   100 com.apple.WebKit.GPU
        """
        let pids = StallReadingText.pids(named: StallReadingText.gpuProcessName, in: Data(ps.utf8))
        check("both GPU processes and nothing else", pids == [501, 900], "\(pids)")
    }

    func testReadingDirectoriesAreNamedBySortableUtcTime() {
        let date = Date(timeIntervalSince1970: 1_792_908_659) // 2026-10-25T06:10:59Z
        check("matches tugtool's stall_dir_name", StallReadingText.directoryName(for: date) == "2026-10-25T06-10-59Z",
              StallReadingText.directoryName(for: date))
    }
}
