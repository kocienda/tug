import AppKit
import Foundation
import Sparkle

/// Sparkle wrapper. Owns the `SPUStandardUpdaterController` and decides
/// whether this bundle is allowed to update itself at all.
///
/// Only the stable release identity (`dev.tugtool.app`) self-updates.
/// Debug and branch builds get rewritten bundle identifiers from
/// `assign-bundle-id.sh` and run out of DerivedData, and the nightly
/// identity has no feed of its own yet. `TUG_SPARKLE_FEED` overrides
/// both the gate and the feed URL so the update path can be exercised
/// against a locally served appcast.
///
/// References: the self-update design record, [P01], [P06], [P07].
final class UpdateController: NSObject {
    /// Environment variable that both enables the updater and supplies
    /// the appcast URL, bypassing the bundle-identity gate.
    static let feedOverrideEnvVar = "TUG_SPARKLE_FEED"

    private static let stableBundleIdentifier = "dev.tugtool.app"

    private var updaterController: SPUStandardUpdaterController?

    /// Sparkle's relaunch handler, held while Tug tears itself down.
    /// Non-nil only between `shouldPostponeRelaunchForUpdate` and
    /// `resumePostponedRelaunch`.
    private var pendingRelaunchBlock: (() -> Void)?

    /// Called with an update's `(displayVersion, build)` when a scheduled
    /// check finds one and the delegate — not Sparkle — is showing it.
    var onScheduledUpdateFound: ((String, String) -> Void)?

    /// True once Sparkle has been started. The "Check for Updates…" menu
    /// item is hidden while this is false.
    var isActive: Bool { updaterController != nil }

    private var feedOverride: String? {
        guard
            let value = ProcessInfo.processInfo.environment[Self.feedOverrideEnvVar],
            !value.isEmpty
        else { return nil }
        return value
    }

    /// Start Sparkle if this bundle is eligible, otherwise do nothing.
    func startIfEligible() {
        guard updaterController == nil else { return }

        if let feed = feedOverride {
            NSLog("UpdateController: starting with feed override \(feed)")
        } else {
            guard Bundle.main.bundleIdentifier == Self.stableBundleIdentifier else {
                NSLog(
                    "UpdateController: inactive — bundle identifier "
                        + "'\(Bundle.main.bundleIdentifier ?? "nil")' is not the stable release identity"
                )
                return
            }
            guard hasFeedConfiguration else {
                NSLog("UpdateController: inactive — SUFeedURL / SUPublicEDKey are not both set in Info.plist")
                return
            }
        }

        let controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: self
        )

        // Consent is not negotiable, and it must not rest on the
        // driver-delegate handoff alone: a release-configuration bundle was
        // observed downloading and installing a scheduled update in place,
        // with no bulletin and no Sparkle window, while the identical code
        // in a debug bundle correctly deferred. Whatever explains that
        // divergence, an updater that is explicitly forbidden from
        // downloading unattended cannot reach the install path. Set after
        // the updater has started so it survives Sparkle's own defaults
        // reading, and logged so the state is observable in a release
        // bundle without a debugger.
        controller.updater.automaticallyDownloadsUpdates = false
        NSLog(
            "UpdateController: started (automaticallyDownloadsUpdates=%@, automaticallyChecksForUpdates=%@)",
            controller.updater.automaticallyDownloadsUpdates ? "yes" : "no",
            controller.updater.automaticallyChecksForUpdates ? "yes" : "no"
        )

        updaterController = controller
    }

    /// Let Sparkle relaunch the freshly installed app. Called by
    /// `AppDelegate` at the very end of termination, immediately before it
    /// replies to `applicationShouldTerminate` — so the new instance never
    /// boots while the old one's children still hold sockets and ports.
    ///
    /// Invokes the handler exactly once (it is cleared first), and is a
    /// no-op on every quit that is not an update install.
    func resumePostponedRelaunch() {
        guard let block = pendingRelaunchBlock else { return }
        pendingRelaunchBlock = nil
        NSLog("UpdateController: teardown complete — releasing the postponed relaunch")
        block()
    }

    /// Bring Sparkle's standard update flow into focus. Safe to call when
    /// the updater never started.
    func checkForUpdates() {
        guard let updaterController else {
            NSLog("UpdateController: check requested while inactive; ignoring")
            return
        }
        updaterController.checkForUpdates(nil)
    }

    /// Both keys must be present for Sparkle to have a feed to fetch and a
    /// key to verify signatures against. A bundle built before the feed was
    /// configured stays inactive rather than starting a half-configured
    /// updater.
    private var hasFeedConfiguration: Bool {
        func nonEmptyString(_ key: String) -> Bool {
            let value = Bundle.main.object(forInfoDictionaryKey: key) as? String
            return !(value ?? "").isEmpty
        }
        return nonEmptyString("SUFeedURL") && nonEmptyString("SUPublicEDKey")
    }
}

// MARK: - SPUUpdaterDelegate

extension UpdateController: SPUUpdaterDelegate {
    /// Returning nil lets the Info.plist `SUFeedURL` rule, which is the
    /// sanctioned way to override the feed (`setFeedURL` is discouraged).
    func feedURLString(for updater: SPUUpdater) -> String? {
        feedOverride
    }

    /// Hold the relaunch until Tug's own termination has finished.
    ///
    /// Sparkle quits the app through the normal `NSApp.terminate` path, so
    /// the termination pipeline already runs — but without this the
    /// relaunched instance can start booting while the outgoing one is
    /// still shutting down its children, racing them for the instance's
    /// control socket and port.
    func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        NSLog(
            "UpdateController: postponing relaunch for %@ until teardown completes",
            item.displayVersionString
        )
        pendingRelaunchBlock = installHandler
        return true
    }
}

// MARK: - SPUStandardUserDriverDelegate

extension UpdateController: SPUStandardUserDriverDelegate {
    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// User-initiated checks never reach here — Sparkle always handles those.
    /// Scheduled finds are handed to the deck instead of Sparkle's alert,
    /// unless nothing is listening, in which case Sparkle's own alert is
    /// still better than a silently swallowed update.
    func standardUserDriverShouldHandleShowingScheduledUpdate(
        _ update: SUAppcastItem,
        andInImmediateFocus immediateFocus: Bool
    ) -> Bool {
        let handled = onScheduledUpdateFound == nil
        NSLog(
            "UpdateController: scheduled update %@ — sparkle shows it: %@",
            update.displayVersionString,
            handled ? "yes" : "no"
        )
        return handled
    }

    func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool,
        forUpdate update: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        NSLog(
            "UpdateController: will show update %@ (sparkle handles: %@, userInitiated: %@)",
            update.displayVersionString,
            handleShowingUpdate ? "yes" : "no",
            state.userInitiated ? "yes" : "no"
        )
        guard !handleShowingUpdate else { return }
        onScheduledUpdateFound?(update.displayVersionString, update.versionString)
    }
}
