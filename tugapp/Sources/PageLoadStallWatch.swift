import Foundation

// The decisions behind a page-load stall reading and the GPU-wedge notice.
//
// When macOS's shared WebKit GPU service wedges, the shell's navigation
// is the first thing in Tug to show it: a page that loads in about a third
// of a second takes fifteen, and the content process dies under it. The
// broken state cannot be proved from logs after the fact, so the host takes
// a reading of the machine while it is happening.
//
// WebKit's public API reports content-process termination but not a GPU
// process going unresponsive, so the trigger is the two signals the host
// does get: a navigation running past its budget, and a content process
// terminating while a navigation is in flight.
//
// The same signals decide the wedge. One hang — one overrun, or one
// terminated content process — only raises suspicion, because WebKit can
// recover from one and today's single reload is the right answer to it. A
// second within the window, with no healthy load between them, is a wedge:
// the machine's graphics service is stuck, a reload only adds to its load,
// and the honest act is to stop and say so.
//
// This type is the whole decision and nothing else — no clock, no timer,
// no IO — so it is tested over plain numbers. The window feeds it the
// navigation's events with the time they happened, takes a reading when it
// says to, and stops reloading when it says the service is wedged.

/// What made the watch ask for a reading.
enum PageLoadStallTrigger: Equatable {
    /// The navigation was still in flight when its budget ran out.
    case budgetElapsed(elapsed: TimeInterval)
    /// The navigation finished, but after its budget, and no reading had
    /// been taken for it yet.
    case finishedLate(elapsed: TimeInterval)
    /// The content process terminated while a navigation was in flight.
    case terminatedDuringLoad(elapsed: TimeInterval)

    /// The trigger's name as it is written into `stall.json`.
    var name: String {
        switch self {
        case .budgetElapsed: return "budget-elapsed"
        case .finishedLate: return "finished-late"
        case .terminatedDuringLoad: return "terminated-during-load"
        }
    }

    /// How long the navigation had been in flight when the trigger fired.
    var elapsed: TimeInterval {
        switch self {
        case let .budgetElapsed(elapsed), let .finishedLate(elapsed), let .terminatedDuringLoad(elapsed):
            return elapsed
        }
    }
}

/// What the evidence so far says about the machine's graphics service.
enum GpuWedgeVerdict: Equatable {
    /// A navigation finished inside its budget: whatever was suspected is over.
    case healthy
    /// One hang since the last healthy load: recover as usual.
    case suspect
    /// A second hang inside the window: stop reloading and say so.
    case wedged
}

/// What one navigation event means: a reading to take, a new verdict, both,
/// or neither.
struct PageLoadStallEvent: Equatable {
    var reading: PageLoadStallTrigger?
    var verdict: GpuWedgeVerdict?

    static let nothing = PageLoadStallEvent(reading: nil, verdict: nil)
}

/// Decides when a shell navigation has stalled badly enough to read the
/// machine, makes sure one incident is read once, and decides when the
/// stalls add up to a wedged graphics service.
///
/// An incident begins with the first trigger and lasts until a navigation
/// finishes inside its budget: the reloads and terminations a wedge throws
/// off in between are the same incident, and reading the machine again for
/// each would only add load to a machine that is already stuck.
struct PageLoadStallWatch {
    /// How long a shell navigation may run before it counts as stalled.
    /// A healthy load takes about 0.3 s; the wedged loads this exists for
    /// took 15–17 s. Eight seconds sits far above the first and well under
    /// the second, so a slow machine is not read as a wedge.
    static let loadBudget: TimeInterval = 8.0

    /// How close together two hangs must be to count as one wedge. The
    /// incident this was written from threw off its hangs fifteen seconds
    /// apart; two minutes holds a reload's worth of retries without reaching
    /// back to an unrelated hang earlier in the session.
    static let wedgeWindow: TimeInterval = 120.0

    let budget: TimeInterval
    let window: TimeInterval

    /// When the navigation now in flight started, or `nil` when none is.
    private(set) var loadStartedAt: TimeInterval?

    /// Whether the navigation in flight has already counted as a hang, so
    /// its late finish does not count it twice.
    private var overrunCounted = false

    /// Whether this incident has already had its reading.
    private(set) var incidentRead = false

    /// When each hang since the last healthy load happened.
    private var hangs: [TimeInterval] = []

    /// Whether the evidence has said the graphics service is wedged. Held
    /// until a healthy load or `clearWedge`, so a wedge is not reloaded
    /// into by the next termination.
    private(set) var isWedged = false

    init(budget: TimeInterval = PageLoadStallWatch.loadBudget, window: TimeInterval = PageLoadStallWatch.wedgeWindow) {
        self.budget = budget
        self.window = window
    }

    /// A shell navigation started. A navigation that starts while another
    /// is in flight replaces it: WebKit has abandoned the first.
    mutating func navigationStarted(at now: TimeInterval) {
        loadStartedAt = now
        overrunCounted = false
    }

    /// The navigation finished loading. Inside its budget, the incident (if
    /// there was one) is over and the service is healthy; past it, the late
    /// finish is a hang and a trigger when nothing has counted it yet.
    mutating func navigationFinished(at now: TimeInterval) -> PageLoadStallEvent {
        guard let started = loadStartedAt else { return .nothing }
        loadStartedAt = nil
        let elapsed = now - started
        if elapsed < budget {
            incidentRead = false
            clearWedge()
            return PageLoadStallEvent(reading: nil, verdict: .healthy)
        }
        let verdict = overrunCounted ? nil : hang(at: now)
        return PageLoadStallEvent(reading: fire(.finishedLate(elapsed: elapsed)), verdict: verdict)
    }

    /// Forget the hangs and the wedge: the user asked to try again, or a
    /// healthy load said it is over. The next hang only raises suspicion.
    mutating func clearWedge() {
        hangs = []
        isWedged = false
    }

    /// The navigation failed. A failure is not a stall — the launch screen
    /// already says it — so it ends the navigation and fires nothing.
    mutating func navigationFailed() {
        loadStartedAt = nil
    }

    /// The budget timer for the navigation that started at `startedAt`
    /// fired. A timer left over from a navigation that has since been
    /// replaced or finished fires nothing.
    mutating func budgetElapsed(forNavigationStartedAt startedAt: TimeInterval, at now: TimeInterval) -> PageLoadStallEvent {
        guard let started = loadStartedAt, started == startedAt else { return .nothing }
        let elapsed = now - started
        guard elapsed >= budget, !overrunCounted else { return .nothing }
        overrunCounted = true
        let verdict = hang(at: now)
        return PageLoadStallEvent(reading: fire(.budgetElapsed(elapsed: elapsed)), verdict: verdict)
    }

    /// The shell's content process terminated. Every termination is a hang
    /// for the wedge — a single one is recovered from by a reload, and a
    /// healthy reload clears it. Only one during a navigation is a reading's
    /// trigger; with the page idle it is ordinary jetsam or a crash.
    mutating func contentProcessTerminated(at now: TimeInterval) -> PageLoadStallEvent {
        let verdict = hang(at: now)
        guard let started = loadStartedAt else { return PageLoadStallEvent(reading: nil, verdict: verdict) }
        return PageLoadStallEvent(reading: fire(.terminatedDuringLoad(elapsed: now - started)), verdict: verdict)
    }

    /// Count a hang, and say what the hangs inside the window add up to.
    private mutating func hang(at now: TimeInterval) -> GpuWedgeVerdict {
        hangs = hangs.filter { now - $0 <= window }
        hangs.append(now)
        if hangs.count >= 2 { isWedged = true }
        return isWedged ? .wedged : .suspect
    }

    private mutating func fire(_ trigger: PageLoadStallTrigger) -> PageLoadStallTrigger? {
        guard !incidentRead else { return nil }
        incidentRead = true
        return trigger
    }
}

/// The pure text a stall reading is named and read by, apart from the
/// reading itself so it is tested without the app around it.
enum StallReadingText {
    /// Executable name of WebKit's GPU process, the one service the
    /// reading is for.
    static let gpuProcessName = "com.apple.WebKit.GPU"

    /// The directory name for a reading taken at `date`: sortable UTC time,
    /// the same spelling as `tugtool`'s `stall_dir_name`.
    static func directoryName(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return formatter.string(from: date)
    }

    /// The pids whose command is `name`, from `ps -o pid=,ppid=,etime=,%cpu=,rss=,comm=`
    /// output, where the command is the last column and may be a path.
    static func pids(named name: String, in psOutput: Data) -> [pid_t] {
        guard let text = String(data: psOutput, encoding: .utf8) else { return [] }
        var found: [pid_t] = []
        for line in text.split(separator: "\n") {
            let columns = line.split(separator: " ", omittingEmptySubsequences: true)
            guard columns.count >= 6, let pid = pid_t(columns[0]) else { continue }
            let command = columns[5...].joined(separator: " ")
            if command == name || command.hasSuffix("/" + name) {
                found.append(pid)
            }
        }
        return found
    }
}
