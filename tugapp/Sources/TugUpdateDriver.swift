import Foundation
import Sparkle

/// Tug's `SPUUserDriver` — the whole of Sparkle's user interface, replaced.
///
/// Sparkle's standard driver owns windows; this one owns nothing but reply
/// closures. Each protocol callback becomes an `UpdateEvent`, the reducer in
/// `UpdateState.swift` folds it, and the resulting snapshot goes out through
/// `onSnapshot` to whoever is presenting — the app menu today, the deck's
/// pill from step 2 on. Every user decision comes back as a single
/// `UpdateAction`, and `perform(_:)` hands it to whichever closure the
/// current state happens to be holding.
///
/// The closures are the reason this class exists and the reason it is
/// careful. Sparkle hands each one over exactly once and expects it invoked
/// exactly once; a dropped reply hangs the update forever and a doubled one
/// is undefined. So every closure is *taken* — read and cleared in the same
/// move — and each callback clears the ones its own arrival has made stale.
///
/// Sparkle calls every method here on the main thread, and the protocol is
/// declared `NS_SWIFT_UI_ACTOR`, hence `@MainActor`.
///
/// References: the non-modal update brief, [B01], [B02], [B03], [B06], [B09].
@MainActor
final class TugUpdateDriver: NSObject, SPUUserDriver {
    /// Called with every snapshot that differs from the last. Never called
    /// for a byte-level download event that did not move the whole percent
    /// [B05] — the reducer decides that, not this class.
    var onSnapshot: ((UpdateSnapshot) -> Void)?

    /// Asked to start a user-initiated check. `UpdateController` wires this
    /// to `SPUUpdater.checkForUpdates()`; the driver has no updater of its
    /// own and deliberately does not get one.
    var onCheckRequested: (() -> Void)?

    /// Called when Sparkle asks for the update to be brought into focus,
    /// which it only does for a check the user started. The single exception
    /// to "nothing in the update flow takes focus" [B06].
    var onFocusRequested: (() -> Void)?

    private var machine = UpdateStateMachine()

    /// The current state. Read by the menu-title rule and by the bridge's
    /// replay on frontend-ready.
    var snapshot: UpdateSnapshot { machine.snapshot }

    // MARK: - The reply closures Sparkle hands over

    /// Cancels an in-flight user-initiated check.
    private var cancelCheck: (() -> Void)?
    /// Answers `showUpdateFound` — install, dismiss, or skip.
    private var updateChoice: ((SPUUserUpdateChoice) -> Void)?
    /// Cancels an in-flight download.
    private var cancelDownload: (() -> Void)?
    /// Answers `showReadyToInstallAndRelaunch` — install now, install on
    /// quit (dismiss), or cancel this install (skip).
    private var installChoice: ((SPUUserUpdateChoice) -> Void)?
    /// Acknowledges a terminal notice — up-to-date, an error, or a finished
    /// install. Sparkle will not proceed until it is invoked.
    private var acknowledgement: (() -> Void)?
    /// Re-sends the quit event when the app declined to terminate.
    private var retryTermination: (() -> Void)?

    // MARK: - Actions in

    /// Apply a user decision. An action the current state holds no closure
    /// for is ignored, which is the whole of the "state, not events" contract
    /// [B03]: a stale click from a deck that reloaded mid-flow does nothing
    /// rather than replying twice.
    func perform(_ action: UpdateAction) {
        switch action {
        case .install:
            if let reply = take(&updateChoice) {
                reply(.install)
            } else if let reply = take(&installChoice) {
                reply(.install)
            } else {
                logIgnored(action)
            }

        case .later, .dismiss:
            // `later` and `dismiss` are one reply with two names. At
            // `readyToInstall`, Sparkle's dismiss keeps the unpacked update
            // and installs it after the next quit [F06] — which is what the
            // popover promises. Everywhere else it is just "go away".
            if let reply = take(&updateChoice) {
                reply(.dismiss)
            } else if let reply = take(&installChoice) {
                reply(.dismiss)
            } else if let ack = take(&acknowledgement) {
                // A terminal notice — up-to-date or an error. Sparkle is
                // waiting on the acknowledgement before it finishes the
                // session; it usually follows with `dismissUpdateInstallation`
                // but not always, so clear the notice here too. Both paths
                // land on the same empty snapshot, so the overlap is a no-op.
                ack()
                publish(.dismissed)
            } else {
                logIgnored(action)
            }

        case .skip:
            if let reply = take(&updateChoice) {
                reply(.skip)
            } else if let reply = take(&installChoice) {
                // At this stage skip cancels the in-progress install without
                // skipping the version in future — Sparkle's word, not a
                // reinterpretation.
                reply(.skip)
            } else {
                logIgnored(action)
            }

        case .cancel:
            if let cancel = take(&cancelDownload) {
                cancel()
            } else if let cancel = take(&cancelCheck) {
                cancel()
            } else {
                logIgnored(action)
            }

        case .retry:
            if let retry = retryTermination {
                // Mid-install, and the app declined to quit. Sparkle says
                // this handler may be invoked more than once, so it is the
                // one closure that is not taken.
                retry()
            } else {
                // An error the user wants to try again. Acknowledge the
                // failure first — Sparkle will not start a new session while
                // the old notice is outstanding.
                take(&acknowledgement)?()
                publish(.dismissed)
                onCheckRequested?()
            }

        case .check:
            take(&acknowledgement)?()
            publish(.dismissed)
            onCheckRequested?()
        }
    }

    /// Read a closure and clear it in one move, so a reply can never be sent
    /// twice.
    private func take(_ slot: inout (() -> Void)?) -> (() -> Void)? {
        let value = slot
        slot = nil
        return value
    }

    private func take(_ slot: inout ((SPUUserUpdateChoice) -> Void)?) -> ((SPUUserUpdateChoice) -> Void)? {
        let value = slot
        slot = nil
        return value
    }

    private func logIgnored(_ action: UpdateAction) {
        NSLog("TugUpdateDriver: ignoring '%@' — state %@ holds no reply for it",
              action.rawValue, snapshot.stage.rawValue)
    }

    /// Drop every outstanding closure. Called when Sparkle tears the session
    /// down; after this, every action is ignored until a new session starts.
    private func clearReplies() {
        cancelCheck = nil
        updateChoice = nil
        cancelDownload = nil
        installChoice = nil
        acknowledgement = nil
        retryTermination = nil
    }

    // MARK: - Snapshots out

    private func publish(_ event: UpdateEvent) {
        guard let snapshot = machine.apply(event) else { return }
        onSnapshot?(snapshot)
    }

    // MARK: - SPUUserDriver

    /// Never ask. `SUEnableAutomaticChecks` in the Info.plist means Sparkle
    /// should not reach here at all; answering in code is the floor under
    /// that, because a modal "check automatically?" on second launch is the
    /// same interruption this work exists to remove [B09].
    ///
    /// Automatic *downloading* is answered `false` separately and
    /// unconditionally by `UpdateController` [F04]; saying so here as well
    /// keeps the two from disagreeing.
    func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) {
        reply(
            SUUpdatePermissionResponse(
                automaticUpdateChecks: true,
                automaticUpdateDownloading: false,
                sendSystemProfile: false
            )
        )
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        cancelCheck = cancellation
        publish(.checkStarted(userInitiated: true))
    }

    func showUpdateFound(
        with appcastItem: SUAppcastItem,
        state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
        // The check is over, whichever way it started.
        cancelCheck = nil
        updateChoice = reply

        if appcastItem.isInformationOnlyUpdate {
            // Sparkle's own instruction: never reply `install` to one of
            // these. Tug has no informational-update presentation, and
            // shipping one as a fallback for a bad release is the case it
            // exists for — so dismiss rather than offer an install that
            // cannot work.
            NSLog("TugUpdateDriver: %@ is an information-only update; dismissing",
                  appcastItem.displayVersionString)
            take(&updateChoice)?(.dismiss)
            return
        }

        // Inline notes from the appcast are available immediately; linked
        // ones arrive later through `showUpdateReleaseNotes(with:)`. Either
        // way their absence never blocks the update [B11].
        publish(
            .updateFound(
                version: appcastItem.displayVersionString,
                build: appcastItem.versionString,
                notes: appcastItem.itemDescription,
                userInitiated: state.userInitiated
            )
        )
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        let encoding: String.Encoding = {
            guard let name = downloadData.textEncodingName else { return .utf8 }
            let cfEncoding = CFStringConvertIANACharSetNameToEncoding(name as CFString)
            guard cfEncoding != kCFStringEncodingInvalidId else { return .utf8 }
            return String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cfEncoding))
        }()

        guard let text = String(data: downloadData.data, encoding: encoding) else {
            publish(.releaseNotesFailed)
            return
        }
        publish(.releaseNotesLoaded(text))
    }

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {
        NSLog("TugUpdateDriver: release notes failed to download: %@", error.localizedDescription)
        publish(.releaseNotesFailed)
    }

    func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        cancelCheck = nil
        self.acknowledgement = acknowledgement
        publish(.updateNotFound)
    }

    func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        cancelCheck = nil
        cancelDownload = nil
        updateChoice = nil
        installChoice = nil
        self.acknowledgement = acknowledgement
        publish(.failed(error.localizedDescription))
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        updateChoice = nil
        cancelDownload = cancellation
        publish(.downloadStarted)
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        publish(.downloadExpectedLength(expectedContentLength))
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        publish(.downloadReceived(length))
    }

    func showDownloadDidStartExtractingUpdate() {
        // Past the point where cancelling means anything.
        cancelDownload = nil
        publish(.extractionStarted)
    }

    func showExtractionReceivedProgress(_ progress: Double) {
        publish(.extractionProgress(progress))
    }

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        updateChoice = nil
        installChoice = reply
        publish(.readyToInstall)
    }

    func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void
    ) {
        installChoice = nil
        // Only meaningful while the app is still up; once it has terminated
        // there is nothing left to re-ask.
        retryTermination = applicationTerminated ? nil : retryTerminatingApplication
        publish(.installing(applicationTerminated: applicationTerminated))
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        // Reached only if the updater outlives the app it updated, which for
        // Tug it does not. Acknowledge so Sparkle can finish either way.
        retryTermination = nil
        acknowledgement()
        publish(.installedAndRelaunched(relaunched))
    }

    /// Sparkle's own instruction is "stop everything that could have been
    /// started" — so every closure goes and the flow returns to idle. Called
    /// on abort and on ordinary completion alike.
    func dismissUpdateInstallation() {
        clearReplies()
        publish(.dismissed)
    }

    /// The one focus exception [B06]. Sparkle calls this when the user has
    /// asked, a second time, to be shown the update they already started a
    /// check for.
    func showUpdateInFocus() {
        onFocusRequested?()
    }
}
