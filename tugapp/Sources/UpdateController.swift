import AppKit
import Foundation
import Sparkle

/// Sparkle wrapper. Owns the `SPUUpdater` and Tug's own user driver, and
/// decides whether this bundle is allowed to update itself at all.
///
/// The updater is a bare `SPUUpdater` rather than an
/// `SPUStandardUpdaterController` because Tug presents every update state
/// itself — the pill, the popover, and the app-menu item — and Sparkle's
/// standard windows are gone [B01]. Everything below the presentation is
/// untouched: the same feed, the same signature verification, the same
/// installer.
///
/// Only the stable release identity (`dev.tugapp.app`) self-updates.
/// Debug and branch builds get rewritten bundle identifiers from
/// `assign-bundle-id.sh` and run out of DerivedData, and the nightly
/// identity has no feed of its own yet. `TUG_SPARKLE_FEED` overrides
/// both the gate and the feed URL so the update path can be exercised
/// against a locally served appcast.
///
/// References: the self-update design record, [P01], [P06], [P07]; the
/// non-modal update brief, [B01], [B07], [B09], [F04].
final class UpdateController: NSObject {
    /// Environment variable that both enables the updater and supplies
    /// the appcast URL, bypassing the bundle-identity gate.
    static let feedOverrideEnvVar = "TUG_SPARKLE_FEED"

    private static let stableBundleIdentifier = "dev.tugapp.app"

    private var updater: SPUUpdater?
    private let driver: TugUpdateDriver

    /// Sparkle's `SPUUpdater` and `SPUUserDriver` are both declared
    /// `NS_SWIFT_UI_ACTOR`, so `TugUpdateDriver` is `@MainActor` and every
    /// touch of either has to be isolated. `AppDelegate` is not, and making
    /// it so to reach one updater would be a concurrency refactor of a
    /// three-thousand-line file that nothing else here asks for. So the
    /// isolation stops at this class: every caller is already on the main
    /// thread — app launch, a menu action, a Sparkle callback — and
    /// `assumeIsolated` says so rather than hoping.
    override init() {
        driver = MainActor.assumeIsolated { TugUpdateDriver() }
        super.init()
    }

    /// Sparkle's relaunch handler, held while Tug tears itself down.
    /// Non-nil only between `shouldPostponeRelaunchForUpdate` and
    /// `resumePostponedRelaunch`.
    private var pendingRelaunchBlock: (() -> Void)?

    /// A check asked for while Sparkle was still winding down the previous
    /// session. Fired from `didFinishUpdateCycleFor`; see `requestCheck()`.
    private var pendingCheck = false

    /// Called with every update snapshot that differs from the last. The
    /// app-menu item's title reads from it today; the deck's pill reads from
    /// it once the bridge lands.
    var onSnapshot: ((UpdateSnapshot) -> Void)?

    /// Called when Sparkle asks for a user-initiated update to be brought
    /// into focus — the one place in the whole flow that may raise anything
    /// [B06].
    var onFocusRequested: (() -> Void)?

    /// The current update state. Safe to read before the updater starts, in
    /// which case it is `idle`.
    var snapshot: UpdateSnapshot { MainActor.assumeIsolated { driver.snapshot } }

    /// True once Sparkle has been started. The "Check for Updates…" menu
    /// item is hidden while this is false.
    var isActive: Bool { updater != nil }

    private var feedOverride: String? {
        guard
            let value = ProcessInfo.processInfo.environment[Self.feedOverrideEnvVar],
            !value.isEmpty
        else { return nil }
        return value
    }

    /// Start Sparkle if this bundle is eligible, otherwise do nothing.
    func startIfEligible() {
        MainActor.assumeIsolated { startIfEligibleOnMainActor() }
    }

    @MainActor
    private func startIfEligibleOnMainActor() {
        guard updater == nil else { return }

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

        driver.onSnapshot = { [weak self] snapshot in
            // Logged for the same reason the consent floor below is: this
            // flow has no window of its own any more, so without a line per
            // transition the only way to watch an update run is a debugger
            // — and the end-to-end pass against a local appcast is run on a
            // release bundle, where there is not one.
            NSLog(
                "UpdateController: %@ (version=%@ build=%@ percent=%@ userInitiated=%@)%@",
                snapshot.stage.rawValue,
                snapshot.version.isEmpty ? "-" : snapshot.version,
                snapshot.build.isEmpty ? "-" : snapshot.build,
                snapshot.percent.map(String.init) ?? "-",
                snapshot.userInitiated ? "yes" : "no",
                snapshot.message.isEmpty ? "" : " — \(snapshot.message)"
            )
            self?.onSnapshot?(snapshot)
        }
        driver.onFocusRequested = { [weak self] in
            self?.onFocusRequested?()
        }
        driver.onCheckRequested = { [weak self] in
            self?.requestCheck()
        }

        let updater = SPUUpdater(
            hostBundle: Bundle.main,
            applicationBundle: Bundle.main,
            userDriver: driver,
            delegate: self
        )

        do {
            try updater.start()
        } catch {
            // Sparkle refuses to start on a misconfigured bundle. There is
            // no alert to raise — the standard controller's job was to put
            // one up, and this work removed it — so the updater simply stays
            // inactive and the menu item stays hidden, as it does for every
            // ineligible identity.
            NSLog("UpdateController: inactive — Sparkle refused to start: %@", error.localizedDescription)
            return
        }

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
        updater.automaticallyDownloadsUpdates = false
        NSLog(
            "UpdateController: started (automaticallyDownloadsUpdates=%@, automaticallyChecksForUpdates=%@)",
            updater.automaticallyDownloadsUpdates ? "yes" : "no",
            updater.automaticallyChecksForUpdates ? "yes" : "no"
        )

        self.updater = updater
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

    /// Apply a user decision — from the app menu today, from the deck's
    /// popover once the bridge lands. Safe to call when the updater never
    /// started, and safe to call with an action the current state has no
    /// reply for; both are ignored [B03].
    func perform(_ action: UpdateAction) {
        guard updater != nil else {
            // `tugapp.log`, not `NSLog`: this is the other way a press can
            // disappear without a trace, and the trace is the point.
            TugLog.warn("update", "action requested while the updater is inactive; ignoring", [
                TugLog.field("action", action.rawValue),
            ])
            return
        }
        MainActor.assumeIsolated { driver.perform(action) }
    }

    /// Ask the deck to show the update surface, in whatever state it holds.
    ///
    /// Publishes a snapshot whose reveal counter has moved and nothing else,
    /// so the flow is untouched: revealing is not something that happens to
    /// the update. The app-menu item calls this before it decides anything
    /// [B07], and Sparkle's own `showUpdateInFocus` reaches it through
    /// `onFocusRequested`.
    func requestReveal() {
        guard updater != nil else { return }
        MainActor.assumeIsolated { driver.requestReveal() }
    }

    /// Start a check, or hold it until Sparkle can accept one.
    ///
    /// Retry and Check for Updates both arrive here with a notice still
    /// standing — that is what the user is answering — and Tug's driver
    /// acknowledges that notice immediately before asking. Sparkle's
    /// acknowledgement does not end the session: it *dispatches* the abort to
    /// the next main-loop turn, so `sessionInProgress` is still true when the
    /// ask lands and `checkForUpdates()` logs and returns having done nothing.
    /// The visible symptom is a Retry button that clears the error and never
    /// checks again.
    ///
    /// So a check asked for mid-session is held rather than dropped, and
    /// `didFinishUpdateCycleFor` — Sparkle's own "the session is over" —
    /// releases it. No timer and no retry loop: the end of a cycle is an event
    /// Sparkle already reports.
    @MainActor
    private func requestCheck() {
        guard let updater else { return }
        guard !updater.sessionInProgress else {
            pendingCheck = true
            NSLog("UpdateController: check requested while a session is in progress — held until it ends")
            return
        }
        pendingCheck = false
        updater.checkForUpdates()
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

    /// Sparkle's own signal that a session is over and a new one may start.
    /// Releases a check `requestCheck()` had to hold, on the next main-loop
    /// turn so Sparkle finishes unwinding this cycle before the next begins.
    func updater(
        _ updater: SPUUpdater,
        didFinishUpdateCycleFor updateCheck: SPUUpdateCheck,
        error: (any Error)?
    ) {
        guard pendingCheck else { return }
        pendingCheck = false
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.requestCheck() }
        }
    }
}
