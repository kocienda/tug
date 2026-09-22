import Foundation

/// The update flow's state machine, with no Sparkle in it.
///
/// Tug presents every update state itself now — Sparkle's standard windows
/// are gone — so the flow has to be something that can be reasoned about and
/// tested without an updater, a feed, or a network. That is what this file
/// is: `UpdateEvent` in, `UpdateSnapshot` out, and nothing imported but
/// Foundation. `TugUpdateDriver` is the glue that turns Sparkle's
/// `SPUUserDriver` callbacks into events and hands the snapshots on; it holds
/// the reply closures and no state of its own.
///
/// Foundation-only is load-bearing rather than tidy: `tests/update/` runs
/// this exact source through `swift -` concatenated with its driver, the same
/// idiom `BranchSlug` and `ShellPathResolver` use. An AppKit or Sparkle import
/// here would end that.
///
/// References: the non-modal update brief, [B02], [B03], [B05], [B07].

/// The states an update can be in, as the menu and the deck see it.
///
/// One case per distinguishable thing the user could be told. `installing`
/// and `readyToInstall` are separate because only the latter has a decision
/// in it; `upToDate` and `idle` are separate because only the former is
/// worth showing.
enum UpdateStage: String {
    /// Nothing to say. No pill, and the menu offers a check.
    case idle
    /// A user-initiated check is in flight and can be cancelled.
    case checking
    /// An update was found and is waiting on the user.
    case available
    /// The archive is coming down.
    case downloading
    /// The archive is unpacking.
    case extracting
    /// Unpacked and waiting on the user to relaunch.
    case readyToInstall
    /// The installer is running; the app is on its way out.
    case installing
    /// A check finished and found nothing.
    case upToDate
    /// The check, the download, or the install failed.
    case error
}

/// What the user can ask for. One vocabulary, shared by the menu door and
/// (from step 2) the deck's `updateAction` message — which is why it is a
/// `String` raw value.
///
/// Whether an action does anything depends on which reply closure the driver
/// is currently holding; an action the state has no closure for is ignored
/// rather than queued [B03].
enum UpdateAction: String {
    /// Begin, resume, or finish the update.
    case install
    /// Put it off. At `readyToInstall` this leaves Sparkle to install on the
    /// next quit rather than cancelling anything [F06].
    case later
    /// Skip this version and stop being told about it.
    case skip
    /// Abort an in-flight check or download.
    case cancel
    /// Acknowledge a failure and check again.
    case retry
    /// Make the current notice go away.
    case dismiss
    /// Start a user-initiated check.
    case check
}

/// Everything a presentation layer needs to draw the update, and nothing else.
///
/// Deliberately `Equatable` and deliberately carrying progress as a *whole
/// percent* rather than a byte count: two byte-level download events inside
/// the same percent produce an equal snapshot, so the "publish only on a
/// whole-percent change" rule [B05] falls out of equality rather than being a
/// throttle anybody has to maintain. The running byte counts live in
/// `UpdateStateMachine`, out of the snapshot, for exactly that reason.
struct UpdateSnapshot: Equatable {
    /// Where the flow is.
    var stage: UpdateStage = .idle
    /// The update's display version (`displayVersionString`), empty when
    /// there is no update in hand.
    var version: String = ""
    /// The update's build (`versionString`), empty when there is none.
    var build: String = ""
    /// Release notes, as HTML or Markdown, once they are known. `nil` while
    /// they are still coming, when the appcast carried none, or when the
    /// download failed — none of which blocks the update [B11].
    var releaseNotes: String?
    /// True when release notes were expected and failed to arrive. The
    /// presentation says nothing about it; it exists so the absence of notes
    /// can be told apart from notes that were never offered.
    var releaseNotesFailed: Bool = false
    /// True when the user asked for this check. Only a user-initiated flow
    /// may open the popover [B06].
    var userInitiated: Bool = false
    /// Download or extraction progress, 0...100, or `nil` when the stage has
    /// no progress or the total is not yet known.
    var percent: Int?
    /// The failure text in `error`, empty in every other stage.
    var message: String = ""

    /// Whether the current stage holds something the user can call off.
    /// Extraction and installation are past the point of no return.
    var isCancellable: Bool {
        stage == .checking || stage == .downloading
    }

    /// The app-menu item's title, which tracks the flow so the menu is a
    /// complete second door and not just a way to start one [B07].
    ///
    /// `appName` is passed in rather than read from the bundle so this file
    /// stays Foundation-only and the titles stay testable.
    func menuTitle(appName: String) -> String {
        switch stage {
        case .idle, .upToDate, .error:
            return "Check for Updates..."
        case .checking:
            return "Checking for Updates..."
        case .available:
            return "Update to \(appName) \(version)..."
        case .downloading, .extracting:
            return "Downloading \(appName) \(version)..."
        case .readyToInstall:
            return "Install and Relaunch"
        case .installing:
            return "Installing \(appName) \(version)..."
        }
    }

    /// What choosing the menu item does, or `nil` when the item should be
    /// disabled because the flow is mid-transfer and there is nothing to
    /// decide.
    var menuCommand: UpdateAction? {
        switch stage {
        case .idle, .upToDate, .error:
            return .check
        case .available, .readyToInstall:
            return .install
        case .checking, .downloading, .extracting, .installing:
            return nil
        }
    }

    /// The snapshot as the deck receives it, through
    /// `__tugBridge.onUpdateState` [B03].
    ///
    /// What crosses the bridge is *state*, never an event — which is the
    /// whole reason a deck reload needs no queue: the host replays the
    /// current snapshot and the deck is caught up, however many transitions
    /// it missed. So this carries what is true now and nothing about how it
    /// got here.
    ///
    /// `NSNull` rather than a nil Optional: `JSONSerialization` refuses the
    /// latter outright and the whole payload would go undelivered.
    var jsonObject: [String: Any] {
        [
            "stage": stage.rawValue,
            "version": version,
            "build": build,
            "releaseNotes": releaseNotes ?? NSNull(),
            "releaseNotesFailed": releaseNotesFailed,
            "userInitiated": userInitiated,
            "percent": percent ?? NSNull(),
            "message": message,
            "cancellable": isCancellable,
        ]
    }
}

/// One per `SPUUserDriver` callback that says something about the flow, plus
/// `dismissed` for Sparkle tearing the session down.
enum UpdateEvent: Equatable {
    /// A check began. Sparkle only announces user-initiated checks; a
    /// scheduled one says nothing until it finds something.
    case checkStarted(userInitiated: Bool)
    /// An update was found.
    case updateFound(version: String, build: String, notes: String?, userInitiated: Bool)
    /// Linked release notes arrived.
    case releaseNotesLoaded(String)
    /// Linked release notes failed to arrive. Never fatal [B11].
    case releaseNotesFailed
    /// The download began.
    case downloadStarted
    /// The download's total size became known.
    case downloadExpectedLength(UInt64)
    /// A chunk arrived. The length is incremental, as Sparkle reports it.
    case downloadReceived(UInt64)
    /// Extraction began.
    case extractionStarted
    /// Extraction progress, 0.0...1.0.
    case extractionProgress(Double)
    /// The update is unpacked and waiting on a relaunch.
    case readyToInstall
    /// The installer is running.
    case installing(applicationTerminated: Bool)
    /// The install finished with the updater still alive — which for Tug,
    /// whose updater dies with the app, effectively never happens.
    case installedAndRelaunched(Bool)
    /// A check finished and found nothing.
    case updateNotFound
    /// Something failed.
    case failed(String)
    /// Sparkle tore the session down, or the user made the notice go away.
    case dismissed
}

/// The reducer, plus the two byte counters that are deliberately not in the
/// snapshot.
///
/// `apply` returns the new snapshot only when it actually changed, which is
/// the whole of the progress-publishing rule [B05]: a `downloadReceived` that
/// does not move the whole percent returns `nil` and nothing crosses the
/// bridge.
struct UpdateStateMachine {
    private(set) var snapshot = UpdateSnapshot()

    /// Bytes received so far. Sparkle reports increments, not totals.
    private var receivedBytes: UInt64 = 0
    /// The download's total, or 0 while it is unknown — in which case
    /// progress stays `nil` rather than pretending to be 0%.
    private var expectedBytes: UInt64 = 0

    init() {}

    /// Fold one event in. Returns the new snapshot when it differs from the
    /// previous one, `nil` when the event changed nothing worth publishing.
    @discardableResult
    mutating func apply(_ event: UpdateEvent) -> UpdateSnapshot? {
        let before = snapshot
        reduce(event)
        return snapshot == before ? nil : snapshot
    }

    private mutating func reduce(_ event: UpdateEvent) {
        switch event {
        case let .checkStarted(userInitiated):
            resetTransfer()
            snapshot = UpdateSnapshot(stage: .checking, userInitiated: userInitiated)

        case let .updateFound(version, build, notes, userInitiated):
            resetTransfer()
            snapshot = UpdateSnapshot(
                stage: .available,
                version: version,
                build: build,
                releaseNotes: notes,
                userInitiated: userInitiated
            )

        case let .releaseNotesLoaded(notes):
            // Notes can land after the user has already started the download,
            // so this never moves the stage — only the text.
            snapshot.releaseNotes = notes
            snapshot.releaseNotesFailed = false

        case .releaseNotesFailed:
            snapshot.releaseNotes = nil
            snapshot.releaseNotesFailed = true

        case .downloadStarted:
            resetTransfer()
            snapshot.stage = .downloading
            snapshot.percent = nil
            snapshot.message = ""

        case let .downloadExpectedLength(total):
            expectedBytes = total
            snapshot.percent = downloadPercent()

        case let .downloadReceived(length):
            receivedBytes &+= length
            snapshot.percent = downloadPercent()

        case .extractionStarted:
            snapshot.stage = .extracting
            snapshot.percent = 0

        case let .extractionProgress(progress):
            snapshot.stage = .extracting
            snapshot.percent = clampedPercent(progress * 100)

        case .readyToInstall:
            snapshot.stage = .readyToInstall
            snapshot.percent = nil

        case .installing:
            snapshot.stage = .installing
            snapshot.percent = nil

        case .installedAndRelaunched:
            // The new version is running; there is nothing left to say.
            resetTransfer()
            snapshot = UpdateSnapshot()

        case .updateNotFound:
            resetTransfer()
            snapshot = UpdateSnapshot(stage: .upToDate, userInitiated: snapshot.userInitiated)

        case let .failed(message):
            resetTransfer()
            snapshot = UpdateSnapshot(
                stage: .error,
                version: snapshot.version,
                build: snapshot.build,
                userInitiated: snapshot.userInitiated,
                message: message
            )

        case .dismissed:
            resetTransfer()
            snapshot = UpdateSnapshot()
        }
    }

    private mutating func resetTransfer() {
        receivedBytes = 0
        expectedBytes = 0
    }

    /// `nil` until the total is known — a progress bar that sits at 0%
    /// because nobody has said how long the file is says something false.
    private func downloadPercent() -> Int? {
        guard expectedBytes > 0 else { return nil }
        return clampedPercent(Double(receivedBytes) * 100 / Double(expectedBytes))
    }

    private func clampedPercent(_ value: Double) -> Int {
        guard value.isFinite else { return 0 }
        return min(100, max(0, Int(value)))
    }
}
