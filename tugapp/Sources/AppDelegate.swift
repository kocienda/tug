import Cocoa
import UniformTypeIdentifiers
import WebKit

/// The coarse stages a launch passes through, in order.
///
/// Distinct from the fine-grained lap labels: a lap names one call that
/// finished, and there are a dozen of them, most of which take under a
/// millisecond. A stage names **what the app is waiting on**, which is the
/// only thing worth telling a user whose launch never finished. The mapping
/// between the two is written out at the lap sites rather than derived from
/// the label text, so renaming a lap cannot silently rename a stage.
enum LaunchStage: String {
    case starting = "starting"
    case resolvingPath = "resolving PATH"
    case startingTugcast = "starting tugcast"
    case loadingInterface = "loading interface"
    case waitingForInterface = "waiting for the interface"
}

#if DEBUG
/// A launch stage deliberately left incomplete, named by
/// `TUG_FORCE_LAUNCH_STALL`.
///
/// The splash deadline cannot be tested from a unit test — it wants a
/// window, a run loop and ten seconds — so the proof is a real launch that
/// stalls on purpose. Each case skips exactly the call that *completes* its
/// stage and nothing else, so the app is left in the state a broken machine
/// would leave it in: the stage stands, the splash holds, and the deadline
/// is the only thing that moves.
///
/// The skip is at the launch call site only, never in the retry path, so
/// Retry recovers a forced stall exactly as it would recover a real one —
/// which is what makes the button's behaviour observable at all. The one
/// exception is `frontend`, which suppresses only the *first* `frontendReady`
/// for the same reason: a reload has to be able to succeed.
///
/// DEBUG-only; zero bytes of it ship in a release bundle.
enum LaunchStall: String {
    case path
    case tugcast
    case load
    case frontend

    static let forced: LaunchStall? = {
        guard let name = ProcessInfo.processInfo.environment["TUG_FORCE_LAUNCH_STALL"],
              !name.isEmpty else { return nil }
        let stall = LaunchStall(rawValue: name)
        if stall == nil {
            NSLog("AppDelegate: TUG_FORCE_LAUNCH_STALL=%@ is not a stage — ignoring", name)
        }
        return stall
    }()
}
#endif

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    /// Origin of the launch clock every `launch` log line measures against.
    ///
    /// A static because the reveal happens in `MainWindow`, long after
    /// `applicationDidFinishLaunching` returns and with no lap function in
    /// scope, and one launch has exactly one origin.
    static var launchStartedAt: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()

    /// The coarse stage the launch has reached. Advanced by `lap` at the
    /// sites that enter a new one, and read by nothing yet — it is the fact
    /// a launch that never finishes needs to be able to name.
    var launchStage: LaunchStage = .starting

    private var window: MainWindow!
    private var processManager = ProcessManager()
    /// The window's bridge delegate. The window holds it weakly, so this
    /// is the reference that keeps it alive.
    private var bridgeHandler: BridgeHandler?

    /// True when the app-test harness drives this launch. The harness
    /// pins production *serving* (tugcast's prebuilt `dist/`, no Vite —
    /// ~700ms faster cold launch), and reads as non-maker so menu-
    /// structure assertions don't depend on the build profile.
    private let isAppTestHarness = ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] == "1"

    /// Maker mode — the gate on the app-maker tooling: the Maker menu,
    /// the dev-info overlay, and (outside the app-test harness) dev
    /// serving via Vite. Derived from the build profile baked into
    /// Info.plist by capture-build-info.sh: on in debug bundles, absent
    /// from release ones. There is no setting — a maker is someone
    /// running a debug build. The tugcast wire keeps its `dev_mode`
    /// verbs — see the boundary note at the `sendDevMode` feed sites.
    lazy var makerModeEnabled: Bool =
        isAppTestHarness ? false : (BuildInfo.profile == "debug")

    /// The dev-*serving* switch: maker mode, except the app-test
    /// harness always serves production. Feeds Vite spawning and the
    /// tugcast `dev_mode` wire verb (which keeps its name — it really
    /// is about serving).
    var devServingEnabled: Bool { makerModeEnabled && !isAppTestHarness }

    var sourceTreePath: String?
    var lastAuthURL: String?
    var vitePort: Int = InstanceConfig.vitePort
    private var initialLoadComplete = false
    private let appLaunchTime = Date()
    var lastLoadTime = Date()

    /// Tracks whether `bridgeFrontendReady` has fired at least once.
    ///
    /// `bridgeFrontendReady` fires every time tugdeck dispatches its
    /// `signalReady()`, which fires on every `connectionDidOpen` —
    /// initial app boot AND every reconnect. To distinguish the two,
    /// keep a flag: the first frontendReady is mount; every
    /// subsequent one is a reconnect.
    ///
    /// Used to gate the post-reconnect lifecycle replay — re-fire
    /// the current OS app-lifecycle state through the
    /// `app-lifecycle` control frame so the tugdeck-side
    /// `AppLifecycle` singleton converges on truth after frames
    /// dropped during the outage. Not wanted on the initial mount:
    /// the OS hasn't told tugdeck anything yet that needs replaying,
    /// and the first paint is driven by `revealWebView` in
    /// `MainWindow.bridgeFrontendReady`.
    var frontendHasLoadedOnce = false
    /// Text files handed to the app (Dock/Finder open, "Open With…") before
    /// the deck is live. Flushed to `open-file` control frames once
    /// `bridgeFrontendReady` fires; opened immediately when already live.
    private var pendingOpenPaths: [String] = []
    /// KVO handle for `NSWorkspace.shared.isVoiceOverEnabled`. The signal
    /// rides the `voiceover-changed` control frame so tugdeck can flip its
    /// keyboard-access mode (the focus-follows accessibility mirror); the
    /// current state is also re-sent on every `bridgeFrontendReady` so a
    /// fresh or reconnected frontend converges without waiting for a
    /// toggle.
    private var voiceOverObservation: NSKeyValueObservation?

    /// Whether the frontend has signalled ready at least once. Gates About
    /// and Settings, both of which open a card and so need a live deck.
    /// Read by `validateMenuItem`: `autoenablesItems` is on, so a stored
    /// `isEnabled` on those items would be overridden by the validator's
    /// permissive default and the gate would never take effect.
    var frontendReady = false

    /// Sparkle self-update. Inactive for every identity but the stable
    /// release build (or a `TUG_SPARKLE_FEED` override), in which case the
    /// "Check for Updates…" menu item stays hidden.
    let updateController = UpdateController()

    /// The host's network-path hint, started on the first
    /// `bridgeFrontendReady` and never before. See `NetworkPathMonitor` for
    /// why it starts late and why `satisfied` is not an assurance.
    let networkPathMonitor = NetworkPathMonitor()

    #if DEBUG
    /// In-app test harness bridge, active only when
    /// `TUGAPP_TEST_SOCKET` env var is set. DEBUG-only.
    private var testHarnessBridge: TestHarnessBridge?
    #endif

    /// The menu bar, built on first touch — `installMenuBar` at launch — and
    /// the delegate that rebuilds its dynamic menus on open.
    private lazy var menuStateSync = MenuStateSync(
        menus: MenuBarBuilder(
            appName: appDisplayName,
            checkForUpdatesTitle: updateController.snapshot.menuTitle(appName: appDisplayName),
            updaterActive: updateController.isActive,
            makerMode: makerModeEnabled,
            debugProfile: BuildInfo.profile == "debug",
            reloadTarget: self
        ).build(),
        delegate: self
    )
    private var menus: MenuHandles { menuStateSync.menus }

    /// Cached menu-relevant frontend state, replaced wholesale on every
    /// `menuState` push from tugdeck. All pull-based menu validation
    /// (`validateMenuItem(_:)`) and dynamic menu building read from here.
    private(set) var menuState = MenuState.empty
    /// The last payload each page pushed: the shell's, and each body's by
    /// card. `menuState` is their merge for the key card.
    private var shellMenuPayload: [String: Any] = [:]
    private var bodyMenuPayloads: [String: [String: Any]] = [:]

    /// UTIs a Text card can **edit** — text and everything that conforms to it
    /// (source code, JSON, XML, Markdown, …). The `choosePath` bridge panel
    /// restricts to these: its callers choose files into text contexts.
    static let editableContentTypes: [UTType] = [.text, .sourceCode, .plainText]

    /// UTIs a viewer card can **display** — read-only, and enumerated one by
    /// one rather than tested against `public.image`. Camera RAW conforms to
    /// `public.image` but WebKit's `<img>` cannot reliably decode it, and Tug
    /// should only offer what it can actually render. Mirrors the extension
    /// table in `tugdeck/src/lib/file-kinds.ts` and tugcast's `fs_blob.rs`.
    ///
    /// AVIF has no `UTType` static, so it is constructed by identifier;
    /// `compactMap` drops it on an OS that doesn't know the type rather than
    /// trapping.
    static let viewableContentTypes: [UTType] = [
        UTType.png,
        UTType.jpeg,
        UTType.gif,
        UTType.webP,
        UTType.heic,
        UTType.heif,
        UTType("public.avif") ?? UTType(filenameExtension: "avif"),
        UTType.tiff,
        UTType.bmp,
        UTType.ico,
        UTType.pdf,
    ].compactMap { $0 }

    /// Everything Tug will open by any route — the union the Open File… panel
    /// and the OS open path accept. Editing is the narrower claim; opening is
    /// the wider one.
    static let openableContentTypes: [UTType] =
        editableContentTypes + viewableContentTypes


    func applicationDidFinishLaunching(_ notification: Notification) {
        let t0 = CFAbsoluteTimeGetCurrent()
        AppDelegate.launchStartedAt = t0
        // Every lap goes to the log file as well as Console. Console is not
        // where anyone reads Tug's logs and not where `just logs-debug`
        // looks, so a launch that stalled used to leave no durable trace of
        // how far it got — the report arrived with nothing to read.
        //
        // `entering:` advances the coarse stage, and only at the sites that
        // begin a new one; passing nothing leaves the stage where it was.
        //
        // `TugLog.start()` runs a few lines below, but `lap("start")` still
        // lands in the file: `TugLog` needs no initialization — `start()`
        // only writes the announcement line — so the first lap is written
        // ahead of it rather than lost. The file therefore opens with the
        // lap, then `tuglog initialized`, then the rest.
        func lap(_ label: String, entering stage: LaunchStage? = nil) {
            let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            if let stage { self.launchStage = stage }
            NSLog("LAUNCH [%6.1fms] %@", ms, label)
            TugLog.info("launch", label, [
                TugLog.field("ms", String(format: "%.1f", ms)),
                TugLog.field("stage", self.launchStage.rawValue),
            ])
        }

        lap("start", entering: .starting)

        // Cocoa's StandardKeyBinding.dict binds ⌃⌘↓ / ⌃⌘← / ⌃⌘→ to the
        // writing-direction commands (`makeBaseWritingDirectionNatural:` and
        // friends), and WebKit runs every keydown through that table in the UI
        // process BEFORE the page sees it. With `NSUseWritingDirectionKeyBindings`
        // off — which it is on any Mac with no bidirectional input source —
        // `-[NSTextInputContext doCommandBySelector:completionHandler:]` answers
        // those selectors with NSBeep and never forwards them, so ⌃⌘↓ (Move Card
        // Down in Column) moved the card and beeped. Allowing the bindings makes
        // AppKit hand the selector to the web view instead, where it is
        // collected as a keypress command the page's preventDefault discards
        // (and `ClickThroughWebView` answers the leftover as a no-op). The key
        // is what `NSUseWritingDirectionKeyBindings` reads, ahead of the global
        // `AppleTextDirection`. Registered rather than set: it is the app's
        // behaviour, not a preference anyone edits.
        UserDefaults.standard.register(defaults: [
            "NSAllowsBaseWritingDirectionKeyBindings": true,
        ])

        // Harness pid mode: run as an accessory. A `.regular` app
        // activates itself once it finishes launching and has a visible
        // window — `open -g` only suppresses the initial activation
        // request, so without this the app takes the user's focus ~10ms
        // after `processManager.start` returns, before any test verb
        // runs. An accessory app never activates on its own, and its
        // windows still render, so gestures and screenshots are
        // unaffected. Foreground tests launch in session mode and keep
        // the regular policy.
        if ProcessInfo.processInfo.environment["TUGAPP_NATIVE_EVENT_MODE"] == "pid" {
            NSApp.setActivationPolicy(.accessory)
        }

        TugLog.start()

        // Tug has no native window tabbing — cards and panes are Tug's own
        // navigation model, not NSWindow tabs. Disabling automatic tabbing
        // keeps AppKit from injecting the Show Previous/Next Tab, Move Tab
        // to New Window, and Merge All Windows items into the Window menu.
        NSWindow.allowsAutomaticWindowTabbing = false

        assertQuitPathIsReachable()

        // Per-instance tugbank DB at `InstanceConfig.tugbankDbPath`.
        // TUGBANK_PATH still takes precedence as a harness override so
        // app-tests can point at a temp DB without rebuilding.
        let dbPath: String
        if let envPath = ProcessInfo.processInfo.environment["TUGBANK_PATH"],
           !envPath.isEmpty {
            dbPath = envPath
        } else {
            dbPath = InstanceConfig.tugbankDbPath.path
        }
        // Ensure the parent directory exists. On first launch of a new
        // identity the per-instance data dir doesn't yet exist; sqlite3
        // open would otherwise fail with ENOENT.
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: dbPath).deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        TugbankClient.configure(path: dbPath)
        lap("TugbankClient.configure")

        // Placeholder rect — `MainWindow.init` overrides this
        // immediately (restored autosave frame, else 80% of the main
        // screen's visible frame, clamped to `minWindowSize`).
        let initialRect = NSRect(x: 0, y: 0, width: 1, height: 1)
        window = MainWindow(
            contentRect: initialRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        lap("MainWindow init")

        let bgHex = MainWindow.resolveStartupBackgroundHex()
        lap("resolveStartupBackgroundHex → \(bgHex)")

        window.updateBackgroundColor(bgHex)
        if ProcessInfo.processInfo.environment["TUGAPP_NATIVE_EVENT_MODE"] == "pid" {
            // Harness pid mode drives the app in the background — put the
            // window on screen without taking key status or stealing the
            // user's active app. Making the window key here does not buy
            // `document.hasFocus()`: WebKit ties that to application
            // activation, and taking key status changes what an
            // activation click means.
            //
            // `orderBack`, not `orderFront`. Suppressing activation keeps the
            // keyboard where the user left it, but an ordered-front window
            // still lands on top of whatever they are looking at — and a run
            // is one launch per test file, so a core tier put twenty windows
            // through the user's screen. Nothing in this mode needs to be on
            // top: keys go by `postToPid` and mouse events are rebuilt as
            // `NSEvent`s and dispatched straight into the window, so neither
            // consults WindowServer's z-order.
            //
            // The level is what actually holds the line — AppKit raises the
            // window on click by a route no ordering override sees, and a raise
            // inside a below-normal level stays below every ordinary window.
            window.level = MainWindow.harnessBackgroundLevel
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        lap("window visible")

        let bridgeHandler = BridgeHandler(delegate: self, window: window, processManager: processManager)
        self.bridgeHandler = bridgeHandler
        window.bridgeDelegate = bridgeHandler
        // The splash went up in `MainWindow.init`; the deadline is armed
        // here because the screen it mounts asks the delegate which stage
        // stalled, and this is the line that makes the delegate exist.
        window.armSplashDeadline()
        loadPreferences()
        lap("loadPreferences")

        refreshInitialProjectPathHint()
        lap("refreshInitialProjectPathHint")

        updateDevInfoOverlay()

        #if DEBUG
        // In-app test harness: if TUGAPP_TEST_SOCKET is set, start
        // the Unix-socket listener and hand it the live WKWebView.
        // All gated by `#if DEBUG`; zero bytes ship to release.
        if let socketPath = TestHarnessBridge.envSocketPath() {
            let bridge = TestHarnessBridge(socketPath: socketPath)
            bridge.start()
            bridge.attach(webView: window.testHarnessWebView())
            self.testHarnessBridge = bridge
            lap("testHarnessBridge started")
        }
        #endif

        // Every update transition goes to the deck as a snapshot, and the
        // current one is replayed on `bridgeFrontendReady`. Nothing is
        // queued: an update found before the deck was live is still true
        // when it mounts, so the replay says it [B03].
        updateController.onSnapshot = { [weak self] snapshot in
            guard let self, let window = self.window else { return }
            window.bridgeUpdateState(snapshot)
        }
        // Sparkle's one sanctioned "bring the update into focus" callback
        // [B06]. It fires when the user asks a second time to be shown a
        // check they already started, which is the same thing the menu item
        // asks for — so it reaches the same reveal, and the seam that had no
        // consumer has one.
        updateController.onFocusRequested = { [weak self] in
            self?.updateController.requestReveal()
        }
        updateController.startIfEligible()
        lap("updateController")

        installMenuBar()
        lap("buildMenuBar", entering: .resolvingPath)

        #if DEBUG
        if LaunchStall.forced == .path {
            NSLog("AppDelegate: TUG_FORCE_LAUNCH_STALL=path — not resolving PATH")
            return
        }
        #endif

        ProcessManager.resolveShellPATH()
        lap("resolveShellPATH", entering: .startingTugcast)

        if !ProcessManager.checkTmux() {
            let alert = NSAlert()
            alert.messageText = "tmux Required"
            alert.informativeText = "tmux is required but was not found in PATH.\nInstall it with: brew install tmux"
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        // VoiceOver detection: observe the workspace flag for live
        // toggles. The current state is (re)sent on every
        // `bridgeFrontendReady`, so the observation only needs to cover
        // changes while the frontend is up.
        voiceOverObservation = NSWorkspace.shared.observe(
            \.isVoiceOverEnabled, options: [.new]
        ) { [weak self] _, _ in
            DispatchQueue.main.async { self?.sendVoiceOverState() }
        }

        // Setup process manager
        processManager.onReady = { [weak self] url, port in
            guard let self = self else { return }
            lap("onReady (tugcast port=\(port))", entering: .loadingInterface)
            self.lastAuthURL = url

            // Extract the auth token from the ready URL so both paths can construct their load URL.
            let token = url.components(separatedBy: "token=").dropFirst().first?.components(separatedBy: "&").first ?? ""

            if self.initialLoadComplete {
                // Tugcast restarted — silently re-authenticate without a full page reload.
                // The fetch sets the new session cookie; the WebSocket reconnection loop
                // in connection.ts will pick it up on its next attempt.
                //
                // Lifecycle replay is NOT triggered here. At this point
                // the tugdeck WebSocket is still down; tugcast's
                // broadcast channel (`dispatch_action` in `actions.rs`)
                // silently drops frames sent to a feed with no
                // subscribers. The replay is scheduled in
                // `bridgeFrontendReady` instead (gated on a
                // `frontendHasLoadedOnce` flag), which fires after
                // tugdeck's `signalReady()` runs on every
                // `connectionDidOpen` — the post-reconnect frontendReady
                // is the first moment a subscribed client exists.
                NSLog("AppDelegate: tugcast restarted, re-authenticating silently (no page reload)")
                // The shell and every body hold a socket of their own to the
                // restarted tugcast; each re-authenticates and reconnects.
                for view in self.window.pageViews {
                    self.window.hostChannel.call(.reauthenticate(token: token), in: view)
                }
                // Maker mode is the user-facing name; the tugcast wire
                // verb stays `dev_mode` — it genuinely is the
                // dev-*serving* switch (Vite, watchers, allowlist).
                self.processManager.sendDevMode(
                    enabled: self.devServingEnabled,
                    sourceTree: self.sourceTreePath,
                    vitePort: self.vitePort
                )
                return
            }
            self.initialLoadComplete = true

            #if DEBUG
            if LaunchStall.forced == .load {
                NSLog("AppDelegate: TUG_FORCE_LAUNCH_STALL=load — not loading the interface")
                return
            }
            #endif

            if self.devServingEnabled {
                // Maker mode serves the frontend from the tugtool source via
                // Vite, so it genuinely needs a source tree. Maker mode is a
                // dev-only feature, hidden in distributed builds.
                guard let path = self.sourceTreePath else {
                    let alert = NSAlert()
                    alert.messageText = "Source Tree Required for Maker Mode"
                    alert.informativeText = "Maker mode serves the frontend from the tugtool source.\nGo to Maker > Source Tree… to set one, or turn Maker mode off."
                    alert.alertStyle = .warning
                    alert.runModal()
                    return
                }
                // Dev mode: spawn Vite (HMR), wait for it, then load from the Vite port.
                // The duplication guard inside spawnViteServer prevents re-spawning on tugcast restarts.
                self.processManager.spawnViteServer(sourceTree: path, tugcastPort: port, vitePort: self.vitePort, devMode: true)
                self.processManager.waitForViteReady(port: self.vitePort) { [weak self] ready in
                    guard let self = self else { return }
                    if !ready {
                        NSLog("AppDelegate: vite server did not become ready in %.0fs", ProcessManager.viteReadyTimeout)
                        TugLog.warn("launch", "vite server did not become ready", [
                            TugLog.field("port", self.vitePort),
                            TugLog.field("waited_s", Int(ProcessManager.viteReadyTimeout)),
                        ])
                    }
                    let viteURL = "http://127.0.0.1:\(self.vitePort)/auth?token=\(token)"
                    self.window.loadURL(viteURL)
                    lap("loadURL (vite)", entering: .waitingForInterface)
                    // Notify tugcast to activate file watchers and set origin allowlist.
                    self.processManager.sendDevMode(enabled: true, sourceTree: path, vitePort: self.vitePort)
                }
            } else {
                // Production mode: load directly from tugcast. No Vite process is spawned.
                // tugcast serves pre-built dist/ files via ServeDir on port 55255.
                let tugcastURL = "http://127.0.0.1:\(port)/auth?token=\(token)"
                self.window.loadURL(tugcastURL)
                lap("loadURL (tugcast)", entering: .waitingForInterface)
                // Notify tugcast to update file watchers and clear dev_port from origin allowlist.
                self.processManager.sendDevMode(enabled: false, sourceTree: self.sourceTreePath, vitePort: self.vitePort)
            }
        }

        processManager.onDevModeError = { [weak self] message in
            guard let self = self else { return }
            self.window.bridgeDevModeError(message: message)
        }

        // A tugcast that keeps dying is a launch that will never finish, and
        // the backoff alone says nothing on screen. Past the threshold the
        // splash stops pretending and names it. `mountLaunchFailure` refuses
        // once the interface is up, so a respawn loop after the reveal is
        // still only a log line.
        processManager.onRepeatedRespawn = { [weak self] attempts, exitCode in
            guard let self = self else { return }
            self.window.mountLaunchFailure(
                stage: LaunchStage.startingTugcast.rawValue,
                reason: "tugcast has exited \(attempts) times in a row (last exit code \(exitCode))."
            )
        }

        // Start tugcast
        #if DEBUG
        if LaunchStall.forced == .tugcast {
            NSLog("AppDelegate: TUG_FORCE_LAUNCH_STALL=tugcast — not starting tugcast")
            return
        }
        #endif
        processManager.start(sourceTree: sourceTreePath)
        lap("processManager.start returned")
    }

    /// Fail loudly if the bundle ever declares support for sudden or
    /// automatic termination.
    ///
    /// Neither key is in Info.plist, which is what makes everything below
    /// work: with sudden termination disabled, macOS runs
    /// `applicationShouldTerminate` on every exit including logout and
    /// restart, so the deck always gets to save. Adding either key would
    /// let the OS kill the process outright, silently taking the whole
    /// termination pipeline out of the picture — a change whose damage is
    /// invisible until someone loses work. This catches it at first launch
    /// instead.
    private func assertQuitPathIsReachable() {
        for key in ["NSSupportsSuddenTermination", "NSSupportsAutomaticTermination"] {
            guard Bundle.main.object(forInfoDictionaryKey: key) != nil else { continue }
            NSLog(
                "AppDelegate: FATAL CONFIGURATION — Info.plist declares %@; the OS may terminate "
                    + "the app without running applicationShouldTerminate, so unsaved work will be lost. "
                    + "Remove the key.",
                key
            )
            assertionFailure("Info.plist must not declare \(key) — it bypasses the termination pipeline")
        }
    }

    /// Outer bound on the deck's termination pipeline. The deck's own
    /// phases are bounded well inside this (a 5 s interrupt await and a 5 s
    /// flush-retry budget); this covers the bridge itself going wrong — a
    /// dead WebView, a JS exception, a promise that never settles. On expiry
    /// the host degrades to the old synchronous `saveState` and tears down.
    /// A quit may be slow; it may never hang.
    private static let terminationPipelineDeadline: TimeInterval = 12.0

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Freeze the WebView with a snapshot overlay so the user never sees
        // teardown artifacts (disconnect banners, theme flashes, blank screens).
        // The snapshot covers the WebView while save + cleanup run underneath.
        window.freezeForShutdown { [weak self] in
            guard let self = self else { return }
            self.runDeckTerminationPipeline {
                self.tearDownAndReplyToTerminate()
            }
        }
        return .terminateLater
    }

    /// Run the deck's half of the quit — interrupt live turns, capture and
    /// persist every card, retry rejected writes — in the shell and in every
    /// ready body at once, and call `completion` once, whatever happens.
    ///
    /// Each view prepares its own cards: the shell its in-page cards and its
    /// layout, each body its one card. They run concurrently under the one
    /// deadline, and a view that fails or has not answered by it is saved
    /// synchronously instead. The verdict line names every view's result.
    ///
    /// WKWebView fires no `visibilitychange` and no `beforeunload` on app
    /// quit, so this is the only save trigger on exit. It is called before
    /// any child process is signalled: a turn still streaming when the
    /// process group dies is a rug pull.
    private func runDeckTerminationPipeline(completion: @escaping () -> Void) {
        let views = window.terminationViews()
        var verdicts: [String: String] = [:]
        var settled = false
        func settle() {
            guard !settled else { return }
            settled = true
            let line = views.map { "\($0.label): \(verdicts[$0.label] ?? "no answer")" }.joined(separator: " | ")
            NSLog("AppDelegate: termination verdicts — %@", line)
            // The instance's own log keeps it too, beside the run it ends.
            TugLog.info("app", "termination verdicts", [TugLog.field("views", line)])
            completion()
        }

        // Degraded path: the old synchronous save, in one view. Strictly no
        // worse than what shipped before the pipeline, and the only thing
        // left when that view's bridge is broken.
        func fallbackSave(_ webView: WKWebView) {
            window.hostChannel.call(.saveState, in: webView)
        }

        let deadline = DispatchWorkItem {
            NSLog(
                "AppDelegate: termination pipeline did not answer within %.0fs — saving the silent views synchronously and tearing down",
                Self.terminationPipelineDeadline
            )
            for view in views where verdicts[view.label] == nil {
                fallbackSave(view.webView)
            }
            settle()
        }
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.terminationPipelineDeadline,
            execute: deadline
        )

        NSLog("AppDelegate: applicationShouldTerminate — running the deck termination pipeline in %d view(s)", views.count)
        for view in views {
            window.hostChannel.call(.prepareForTermination, in: view.webView) { result in
                guard !settled else { return }
                switch result {
                case .success(.null):
                    // The page has no `prepareForTermination` to answer with.
                    verdicts[view.label] = "no answer from the page — saved synchronously"
                    fallbackSave(view.webView)
                case .success(let value):
                    verdicts[view.label] = Self.describeVerdict(value)
                case .failure(let error):
                    verdicts[view.label] = "failed (\(error.localizedDescription)) — saved synchronously"
                    fallbackSave(view.webView)
                }
                if verdicts.count == views.count {
                    deadline.cancel()
                    settle()
                }
            }
        }
    }

    /// Render the deck's verdict as one log line. Unknown or malformed
    /// shapes are logged verbatim rather than dropped — the point of the
    /// verdict is that a bad quit leaves a named trace.
    private static func describeVerdict(_ value: JSONValue) -> String {
        guard case .object(let verdict) = value else {
            return "unreadable: \(value)"
        }
        func ids(_ key: String) -> String {
            guard case .array(let entries)? = verdict[key] else { return "none" }
            let list = entries.compactMap { entry -> String? in
                if case .string(let id) = entry { return id }
                return nil
            }
            return list.isEmpty ? "none" : list.joined(separator: ",")
        }
        func flag(_ key: String) -> Bool {
            if case .bool(let value)? = verdict[key] { return value }
            return false
        }
        func count(_ key: String) -> Int {
            if case .number(let value)? = verdict[key] { return Int(value) }
            return -1
        }
        let ok = flag("ok")
        let flushed = count("flushedCards")
        let layoutSaved = flag("layoutSaved")
        let elapsed = count("elapsedMs")
        return "ok=\(ok) interrupted=\(ids("interrupted")) unacknowledged=\(ids("unacknowledged")) "
            + "flushedCards=\(flushed) failedCards=\(ids("failedCards")) "
            + "layoutSaved=\(layoutSaved) elapsedMs=\(elapsed)"
    }

    /// Tear down the bridge and the child processes, then let AppKit finish
    /// the quit. Reached from exactly one place — the pipeline's single
    /// settle — so the reply is sent once.
    private func tearDownAndReplyToTerminate() {
        window.cleanupBridge()
        processManager.shutdown()
        #if DEBUG
        testHarnessBridge?.close()
        testHarnessBridge = nil
        #endif
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    // MARK: - App lifecycle (NSApplicationDelegate)
    //
    // All eight notifications route through a single `app-lifecycle`
    // control frame. The tugdeck-side `AppLifecycle` singleton
    // dispatches to every registered observer (selection-guard dim /
    // restore, deck.saveAndFlush on resign, the cascade layer added
    // in Step 7, etc.). Uniform shape: `params: ["event": "<name>"]`.

    func applicationWillBecomeActive(_ notification: Notification) {
        NSLog("AppDelegate: applicationWillBecomeActive")
        processManager.sendControl("app-lifecycle", params: ["event": "willBecomeActive"])
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        NSLog("AppDelegate: applicationDidBecomeActive")
        processManager.sendControl("app-lifecycle", params: ["event": "didBecomeActive"])
    }

    func applicationWillResignActive(_ notification: Notification) {
        NSLog("AppDelegate: applicationWillResignActive")
        processManager.sendControl("app-lifecycle", params: ["event": "willResignActive"])
    }

    func applicationDidResignActive(_ notification: Notification) {
        NSLog("AppDelegate: applicationDidResignActive")
        processManager.sendControl("app-lifecycle", params: ["event": "didResignActive"])
    }

    func applicationWillHide(_ notification: Notification) {
        NSLog("AppDelegate: applicationWillHide")
        processManager.sendControl("app-lifecycle", params: ["event": "willHide"])
    }

    func applicationDidHide(_ notification: Notification) {
        NSLog("AppDelegate: applicationDidHide")
        processManager.sendControl("app-lifecycle", params: ["event": "didHide"])
    }

    func applicationWillUnhide(_ notification: Notification) {
        NSLog("AppDelegate: applicationWillUnhide")
        processManager.sendControl("app-lifecycle", params: ["event": "willUnhide"])
    }

    func applicationDidUnhide(_ notification: Notification) {
        NSLog("AppDelegate: applicationDidUnhide")
        processManager.sendControl("app-lifecycle", params: ["event": "didUnhide"])
    }

    /// Re-fire the current OS-level app-lifecycle state through the
    /// `app-lifecycle` control frame.
    ///
    /// Called from `processManager.onReady`'s tugcast-restart branch.
    /// While tugcast was dead, every `applicationDidBecomeActive` /
    /// `applicationDidResignActive` / `applicationDidHide` /
    /// `applicationDidUnhide` notification fired into a `sendControl`
    /// call that hit the `guard let connection = controlConnection`
    /// early-return (because `handleDisconnect` cleared the ref to
    /// avoid the broken-pipe crash). The tugdeck-side `AppLifecycle`
    /// singleton therefore holds whatever state was last successfully
    /// delivered before the outage, which can disagree with the OS's
    /// current state if the user Cmd-Tabbed during the outage.
    ///
    /// This method dispatches the matching `did*` frames for the
    /// CURRENT OS state — not the history. The tugdeck-side observers
    /// (selection-guard, focus-cascade, deck.saveAndFlush) are
    /// idempotent under repeated `did*` events: each one is a
    /// state-derivation that re-runs cleanly. Don't replay `will*`
    /// frames — those mark transitions, not steady states, and
    /// have no meaning in a replay context.
    ///
    /// `replayed: true` rides on each frame so the tugdeck-side log
    /// can distinguish a replay from a literal OS notification — the
    /// observer behavior is the same; the discriminator is for
    /// diagnostics.
    /// Send the current VoiceOver state through the `voiceover-changed`
    /// control frame. tugdeck flips its keyboard-access mode on it: on →
    /// the focus-follows accessibility mirror (real DOM focus tracks the
    /// engine's key view, the pattern every assistive tech handles); off →
    /// back to standard, unless the user persisted accessibility mode
    /// themselves. Idempotent on the receiving side, so re-sends on
    /// reconnect are safe.
    func sendVoiceOverState() {
        let enabled = NSWorkspace.shared.isVoiceOverEnabled
        NSLog("AppDelegate: sendVoiceOverState (enabled=%d)", enabled ? 1 : 0)
        processManager.sendControl("voiceover-changed", params: ["enabled": enabled])
    }

    func replayLifecycleState() {
        let active = NSApp.isActive
        let hidden = NSApp.isHidden
        NSLog(
            "AppDelegate: replayLifecycleState (active=%d hidden=%d)",
            active ? 1 : 0,
            hidden ? 1 : 0
        )
        // Active/resign: send whichever matches NSApp.isActive.
        let activeEvent = active ? "didBecomeActive" : "didResignActive"
        processManager.sendControl(
            "app-lifecycle",
            params: ["event": activeEvent, "replayed": true]
        )
        // Hide/unhide: an app that's been Cmd-H'd is also `isHidden`
        // and conventionally not `isActive`. Sending both is correct:
        // the two axes are orthogonal in AppKit and the tugdeck-side
        // observers ignore the dimensions they don't care about.
        let hiddenEvent = hidden ? "didHide" : "didUnhide"
        processManager.sendControl(
            "app-lifecycle",
            params: ["event": hiddenEvent, "replayed": true]
        )
    }

    #if DEBUG
    /// Harness-only: put this instance's tugcast down, and bring it back.
    ///
    /// The `ProcessManager` is private to the delegate, and these are the two
    /// halves of one outage the harness verbs (`stopTugcast` / `startTugcast`)
    /// reach through. Nothing about the window, the loaded page or the
    /// harness's own socket is touched: `onReady`'s restart branch
    /// re-authenticates the page in place, so the deck's buffers survive the
    /// outage and the reconnect heal is what the test gets to observe.
    func harnessStopTugcast() {
        processManager.stopForHarness()
    }

    /// See `harnessStopTugcast()`. Returns once the child is spawned; the
    /// page's WebSocket reconnects on its own loop after that.
    func harnessStartTugcast() {
        processManager.startAgainForHarness()
    }
    #endif

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    /// Files handed to the app by the OS: dropped on the Dock icon, opened
    /// from Finder ("Open With Tug"), or double-clicked when Tug is the
    /// handler. Each text file opens in a Text card. If the deck isn't live
    /// yet (cold launch by opening a file), the paths queue and flush on
    /// `bridgeFrontendReady`.
    func application(_ application: NSApplication, open urls: [URL]) {
        openFilesFromOS(urls)
    }

    /// Open each supported file in `urls` — the OS open path (Dock-icon drop,
    /// Finder "Open With", double-click). Text lands in a Text card, an image
    /// or PDF in a viewer card; the deck routes by kind. Unsupported files and
    /// folders are ignored; opens made before the deck is live queue and flush
    /// on `bridgeFrontendReady`.
    func openFilesFromOS(_ urls: [URL]) {
        for url in urls where url.isFileURL {
            guard AppDelegate.isOpenableFile(url) else { continue }
            let path = url.path
            if frontendHasLoadedOnce {
                sendControl("open-file", params: ["path": path])
            } else {
                pendingOpenPaths.append(path)
            }
        }
    }

    /// Flush any queued open paths once the deck is live. Called from
    /// `bridgeFrontendReady`.
    func flushPendingOpenPaths() {
        guard !pendingOpenPaths.isEmpty else { return }
        let paths = pendingOpenPaths
        pendingOpenPaths.removeAll()
        for path in paths {
            sendControl("open-file", params: ["path": path])
        }
    }

    /// Apply an update decision the deck posted through `updateAction`.
    /// Ignored when the updater never started, and ignored by the driver
    /// when the current state holds no reply for it [B03].
    func performUpdateAction(_ action: UpdateAction) {
        updateController.perform(action)
    }

    /// Whether `url` is a file Tug can open in any card — a regular file whose
    /// UTI conforms to one of {@link openableContentTypes}, editable or
    /// viewable. Guards the OS open path so a folder or an unsupported file
    /// handed to the app is ignored.
    ///
    /// Conformance rather than equality on the viewable side too: a subtype
    /// UTI (a vendor's own JPEG flavor, say) conforms to `public.jpeg` and is
    /// the same bytes to a decoder, so it should open.
    static func isOpenableFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]),
              values.isRegularFile == true,
              let type = values.contentType else { return false }
        return openableContentTypes.contains { type.conforms(to: $0) }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return false
    }

    // MARK: - Preferences

    private func loadPreferences() {
        // Per-instance tugbank starts empty on a fresh identity, so
        // `source-tree-path` falls back to the build-time value: a
        // fresh dev instance lights up with its source tree wired, and
        // a fresh prod instance gets the user-picker flow. Maker mode
        // is not read here — it is derived from the build profile.
        sourceTreePath = ProcessManager.readTugbank(
            domain: TugConfig.domain, key: TugConfig.keySourceTreePath
        )
        if sourceTreePath == nil, let buildTimePath = BuildInfo.sourceTree {
            sourceTreePath = buildTimePath
        }
    }

    func savePreferences() {
        if let path = sourceTreePath {
            ProcessManager.writeTugbank(domain: TugConfig.domain, key: TugConfig.keySourceTreePath, value: path)
        }
    }

    /// Refresh the Session picker's "initial project path" hint so a first-
    /// time user (no Recent Project Paths yet) has a sensible default
    /// they can hit Open on without typing. Debug builds point at the
    /// repo source tree; release builds point at `$HOME`. Written every
    /// launch — it's a derived hint, not user preference.
    private func refreshInitialProjectPathHint() {
        let value: String
        if BuildInfo.profile == "debug", let tree = sourceTreePath {
            value = tree
        } else {
            value = NSHomeDirectory()
        }
        ProcessManager.writeTugbank(
            domain: TugConfig.domain,
            key: TugConfig.keyInitialProjectPath,
            value: value
        )
    }

    // MARK: - Menu Bar

    /// The running variant's display name — "Tug", "Tug-debug",
    /// "Tug-apptest", "Tug-worktree", etc. Read from the bundle, the
    /// same source AppKit uses for the app-menu title (so "About …",
    /// "Hide …", and "Quit …" match the title exactly). The name keys
    /// are stamped per-variant at build time by assign-bundle-id.sh;
    /// never hardcoded here. Falls back to the process name if both
    /// bundle keys are somehow absent.
    private var appDisplayName: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? ProcessInfo.processInfo.processName
    }

    /// Build the menu bar and install it on `NSApp`. The structure, the
    /// identifiers, and the default chords are `MenuBarBuilder`'s.
    private func installMenuBar() {
        NSApp.servicesMenu = menus.servicesMenu
        // Built once here so the Open Recent parent's enablement has a
        // submenu to read before the first menu-state push.
        menuStateSync.rebuildOpenRecentMenu(menus.openRecentMenu)
        NSApp.windowsMenu = menus.windowMenu
        NSApp.helpMenu = menus.helpMenu
        NSApp.mainMenu = menus.mainMenu
    }

    // MARK: - Actions

    /// Help ▸ Capture Frames (Diagnostic): thirty composited frames of the
    /// main window at ~80ms, written under /tmp and revealed in Finder.
    @objc func captureFramesDiagnostic(_ sender: Any?) {
        window.captureFrameBurst { dir in
            guard let dir = dir else { return }
            NSLog("Capture Frames: wrote %@", dir.path)
            NSWorkspace.shared.activateFileViewerSelecting([dir])
        }
    }

    /// One command for Settings, whichever door the user came through.
    /// The menu item used to send `show-card {component: "settings"}` while
    /// ⌘, dispatched `show-settings` on the web responder chain — two paths
    /// to one card, and only the chain path claimed focus and re-centered
    /// the card. The menu now sends the same command the chord does.
    @objc func showSettings(_ sender: Any?) {
        sendControl("show-settings")
    }

    /// The keymap configurator's card. Sends the command rather than
    /// `show-card` for the same reason Settings does: the chain path is the
    /// one that claims focus and re-centers.
    @objc func showKeyboardShortcuts(_ sender: Any?) {
        sendControl("show-keyboard-shortcuts")
    }

    @objc func showConfigureTug(_ sender: Any?) {
        sendControl("configure-tug")
    }

    @objc func logOut(_ sender: Any?) {
        sendControl("logout")
    }

    @objc func checkForUpdates(_ sender: Any?) {
        // Reveal, and nothing else [B05]. The item is one door onto the
        // wizard, and a door does not decide what is on the other side of it:
        // it used to reveal and then `perform(menuCommand)`, which at
        // `available` meant choosing *Update to Tug 0.8.3…* started the
        // download outright, with no dialog in between [F05]. Every decision
        // the flow offers now lives on a row of `UpdateTug`, where the user
        // can see what they are agreeing to before they agree to it.
        //
        // Unconditional, and enabled in every stage including `idle` — where
        // the wizard opens on its Check row with nothing having happened yet.
        updateController.requestReveal()
    }

    @objc func showAbout(_ sender: Any?) {
        // The About card reads its identity from this payload (parked in
        // tugdeck's appInfoStore) — version/build/copyright from
        // Info.plist, the rest from BuildInfo, plus the running
        // bundle's app icon as a data URL (so debug/nightly builds show
        // their own icon). All constant for the process lifetime.
        let info = Bundle.main.infoDictionary ?? [:]
        sendControl("show-card", params: [
            "component": "about",
            // The variant's display name (e.g. "Tug-debug"), the same
            // dynamic source the menu bar and app-menu items use — never
            // hardcoded. The About card's wordmark and title bar read it.
            "name": appDisplayName,
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "commit": BuildInfo.commit,
            "branch": BuildInfo.branch,
            "profile": BuildInfo.profile,
            "copyright": info["NSHumanReadableCopyright"] as? String ?? "",
            "icon": Self.appIconDataURL,
        ])
    }

    /// The running app's icon rendered to a 256px PNG data URL for the
    /// About card. Computed once — the icon never changes within a
    /// process lifetime. Empty string when no icon can be rendered
    /// (the card falls back to its placeholder glyph).
    private static let appIconDataURL: String = {
        guard let icon = NSApp.applicationIconImage else { return "" }
        var rect = NSRect(x: 0, y: 0, width: 256, height: 256)
        guard let cg = icon.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            return ""
        }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
        return "data:image/png;base64," + png.base64EncodedString()
    }()

    @objc func selectTheme(_ sender: NSMenuItem) {
        let name = sender.representedObject as? String ?? sender.title
        menuStateSync.activeThemeName = name
        sendControl("set-theme", params: ["theme": name])
    }

    @objc func openProjectHome(_ sender: Any?) {
        if let url = URL(string: "https://tugtool.dev") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openGitHub(_ sender: Any?) {
        if let url = URL(string: "https://github.com/kocienda/tug") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func reload(_ sender: Any) {
        sendControl("reload")
    }

    /// Show or hide the Jots rail. Routes through the standard `sendControl`
    /// channel so tugdeck's action-dispatch picks it up the same way other
    /// menu-driven RPCs do.
    @objc func showJots(_ sender: Any) {
        sendControl("toggle-jots")
    }

    /// Show or hide the Arcs rail — another of the sidebar toggles.
    @objc func showArcs(_ sender: Any) {
        sendControl("toggle-arcs")
    }

    /// Show or hide the Cards rail — another of the sidebar toggles.
    @objc func showCards(_ sender: Any) {
        sendControl("toggle-cards")
    }

    /// Show or hide the Layout rail — another of the sidebar toggles.
    @objc func showLayout(_ sender: Any) {
        sendControl("toggle-layout")
    }

    /// Show or hide the Overview rail — the third of the sidebar toggles.
    @objc func showOverview(_ sender: Any) {
        sendControl("toggle-overview")
    }

    /// Maker ▸ Show Left / Right Rail. The side rides `representedObject`;
    /// which members the rail brings back is the frontend's answer, read off
    /// what was standing when the side was last hidden.
    @objc func toggleRailFromMenu(_ sender: NSMenuItem) {
        guard let side = sender.representedObject as? String else { return }
        sendControl("toggle-rail", params: ["value": side])
    }

    /// View ▸ Resize Sidebars to Fit. One run of the rails' only remaining
    /// vertical algorithm: each card is stood at the height its content asks
    /// for, and the result is kept as the hand's own division from there on.
    @objc func resizeSidebarsToFit(_ sender: Any) {
        sendControl("resize-sidebars-to-fit")
    }

    /// View ▸ Hide Sidebars / Show Sidebars. Both of the deck's edges on one
    /// gesture: with anything standing on either side the frontend clears them
    /// and remembers what stood where, and with nothing standing it puts that
    /// memory back. The row's title says which of the two the next press is.
    @objc func toggleSidebars(_ sender: Any) {
        sendControl("toggle-sidebars")
    }

    /// Create a jot and land the caret in it, revealing the Jots rail if it is
    /// hidden. Focus goes to the web view first: ⌘J fires as a menu key
    /// equivalent even when the native title bar holds focus, where the new
    /// row's caret claim would otherwise be invisible.
    @objc func newJot(_ sender: Any) {
        window.focusWebView()
        sendControl("new-jot")
    }

    // The zoom commands go to the frontmost document surface when there is
    // one and scale the whole web view otherwise. The branch lives at
    // invocation rather than at menu-build time because a key equivalent
    // fires the selector without rebuilding the menu.

    @objc func actualSize(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-actual")
            return
        }
        window.actualSize()
    }

    @objc func zoomIn(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-in")
            return
        }
        window.zoomIn()
    }

    @objc func zoomOut(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-out")
            return
        }
        window.zoomOut()
    }

    // Page zoom only, document surface or not: a document's own zoom has no
    // remembered level to go back to, and ⌥⌘0 is about the deck.
    @objc func toggleActualSize(_ sender: Any?) {
        window.toggleActualSize()
    }

    @objc func focusPaneFromMenu(_ sender: NSMenuItem) {
        guard let paneId = sender.representedObject as? String else { return }
        sendControl("focus-pane", params: ["paneId": paneId])
    }

    @objc func activateSpaceFromMenu(_ sender: NSMenuItem) {
        guard let spaceId = sender.representedObject as? String else { return }
        sendControl("activate-space", params: ["spaceId": spaceId])
    }

    // The four workspace verbs, each sent with NO parameters — and the
    // absence is the whole design. Every one of these controls takes an
    // optional `spaceId`: present, it is the row a right-click or a `···`
    // landed on; absent, the verb acts on the ACTIVE workspace, which is the
    // only workspace a menu-bar item can name. One verb with two doors,
    // rather than two verbs whose titles drift apart.

    @objc func newWorkspaceFromMenu(_ sender: Any?) {
        sendControl("new-space")
    }

    @objc func renameWorkspaceFromMenu(_ sender: Any?) {
        sendControl("rename-space")
    }

    @objc func duplicateWorkspaceFromMenu(_ sender: Any?) {
        sendControl("duplicate-space")
    }

    @objc func deleteWorkspaceFromMenu(_ sender: Any?) {
        sendControl("delete-space")
    }

    @objc func newComponentGalleryCard(_ sender: Any?) {
        sendControl("show-component-gallery")
    }

    @objc func newHelloWorldCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "hello"])
    }

    @objc func newSpikesCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "spike-home"])
    }

    @objc func newSessionCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "session"])
    }

    @objc func openFileInEditor(_ sender: Any) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = AppDelegate.openableContentTypes
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.sendControl("open-file", params: ["path": url.path])
        }
    }

    @objc func openQuickly(_ sender: Any) {
        sendControl("open-quickly")
    }

    @objc func openRecentDocument(_ sender: Any) {
        guard let item = sender as? NSMenuItem,
              let path = item.representedObject as? String else { return }
        sendControl("open-file", params: ["path": path])
    }

    @objc func clearRecentDocuments(_ sender: Any) {
        sendControl("clear-recent-documents")
    }

    @objc func saveActiveEditor(_ sender: Any) {
        // Bare chain-action name "save" (Both-category identity action,
        // same convention as "close").
        sendControl("save")
    }

    @objc func saveAsActiveEditor(_ sender: Any) {
        sendControl("save-as")
    }

    @objc func saveACopyActiveEditor(_ sender: Any) {
        sendControl("save-a-copy")
    }

    @objc func revertActiveEditor(_ sender: Any) {
        sendControl("revert-to-saved")
    }

    @objc func reloadActiveEditor(_ sender: Any) {
        sendControl("reload-from-disk")
    }

    @objc func newTextCard(_ sender: Any) {
        sendControl("new-text-card")
    }

    @objc func nextTheme(_ sender: Any) {
        sendControl("next-theme")
    }

    @objc func applyThemeToAllWorkspaces(_ sender: Any) {
        sendControl("apply-theme-to-all-workspaces")
    }

    @objc func addCardToActivePane(_ sender: Any) {
        sendControl("add-card-to-active-pane")
    }

    @objc func closeActiveCard(_ sender: Any) {
        // Wire format is the bare chain-action name "close" (a Both-
        // category identity action — see tugdeck/src/action-dispatch.ts
        // and tuglaws/action-naming.md). The Swift method name stays
        // as `closeActiveCard` because it still describes what the
        // method does: close the active card via the responder chain.
        // In a multi-card pane the chain's handler removes the active
        // card from the pane; in a single-card pane it removes the last
        // card (pane goes away). Either way, "close the active card" is the right
        // mental model at the dispatch site.
        sendControl("close")
    }

    @objc func closeAllCardTabs(_ sender: Any) {
        // Wire format is the bare chain-action name "close-all". The web
        // layer's responder chain walks it to the focused pane, which
        // closes every hosted tab — popping the "Close N Tabs?" confirm
        // first when any of its cards opts into confirmClose. Enablement
        // rides the command's registry gate on the menuState push: only a
        // multi-card focused pane makes this command meaningful.
        sendControl("close-all")
    }

    /// One selector for every menu item whose action is a session-card local
    /// slash command: the command name rides `representedObject`, and the
    /// frame re-enters the card's slash-command surface map key-card-scoped
    /// in tugdeck — byte-identical to typing the command. Items send no
    /// args (bare `rename` opens the seeded one-field sheet, etc.).
    @objc func runCardCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        sendControl("run-card-command", params: ["name": name])
    }

    // Session menu actions.

    @objc func focusPrompt(_ sender: Any?) {
        sendControl("focus-prompt")
    }

    @objc func stopSession(_ sender: Any?) {
        sendControl("interrupt-session")
    }

    /// Session ▸ Insert File… — choose a file and mention it in the focused
    /// prompt entry. Unlike Open File…, no content types are declared: a
    /// prompt may name any file, and the panel is picking a path to talk
    /// about rather than a document this app has to render. The frame is
    /// dispatched first-responder in tugdeck, so the composer that holds
    /// focus is the one that receives the path.
    @objc func insertFile(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose a file to insert"
        panel.prompt = "Insert"
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.sendControl("insert-file", params: ["path": url.path])
        }
    }

    // Transcript navigation and the session card's keyboard affordances —
    // chain round-trips through the command funnel, which routes each wire
    // to the key card by its registry entry.
    @objc func previousTurn(_ sender: Any?) {
        sendControl("previous-turn")
    }

    @objc func nextTurn(_ sender: Any?) {
        sendControl("next-turn")
    }

    @objc func firstTurn(_ sender: Any?) {
        sendControl("first-turn")
    }

    @objc func lastTurn(_ sender: Any?) {
        sendControl("last-turn")
    }

    @objc func openCommandPicker(_ sender: Any?) {
        sendControl("open-command-picker")
    }

    @objc func toggleDictation(_ sender: Any?) {
        sendControl("toggle-dictation")
    }

    @objc func stopDictationAndSend(_ sender: Any?) {
        sendControl("stop-dictation-and-send")
    }

    @objc func keyboardFocus(_ sender: Any?) {
        sendControl("cycle-focus-mode")
    }

    @objc func nextKeyboardFocus(_ sender: Any?) {
        sendControl("next-keyboard-focus")
    }

    @objc func previousKeyboardFocus(_ sender: Any?) {
        sendControl("previous-keyboard-focus")
    }

    @objc func showDevTools(_ sender: Any?) {
        sendControl("show-devtools")
    }

    @objc func cyclePermissionModeFromMenu(_ sender: Any?) {
        sendControl("cycle-permission-mode")
    }

    /// Show/Hide Changes / History ([P05], Spec S04). The represented view name
    /// selects the control frame; tugdeck's card-content responder toggles the
    /// matching Shade.
    @objc func toggleShadeView(_ sender: NSMenuItem) {
        guard let view = sender.representedObject as? String else { return }
        sendControl(view == "history" ? "toggle-history-view" : "toggle-changes-view")
    }

    // View ▸ Fold Card. One control name for the pane-scoped verb; the key
    // card's pane answers it on the frontend and lands the deck commit.
    @objc func toggleCardFold(_ sender: NSMenuItem) {
        sendControl("toggle-card-fold")
    }

    // Edit ▸ Undo / Redo — two execution paths, matching the two
    // validation sources (see validateMenuItem):
    //   - Native text control focused: drive the web view's NSUndoManager
    //     through the native selector — the only route to a browser-native
    //     input's undo stack. Card-safety comes from the token-change
    //     clear in updateMenuState, not from avoiding the manager.
    //   - Otherwise: chain round-trip to the focused editor's own history
    //     (CM6). Undo isn't gesture-sensitive the way the clipboard is,
    //     so the async control-frame round-trip is fine.
    @objc func performUndo(_ sender: Any?) {
        if menuState.edit.nativeUndoToken != 0 {
            NSApp.sendAction(Selector(("undo:")), to: nil, from: sender)
        } else {
            sendControl("undo")
        }
    }

    @objc func performRedo(_ sender: Any?) {
        if menuState.edit.nativeUndoToken != 0 {
            NSApp.sendAction(Selector(("redo:")), to: nil, from: sender)
        } else {
            sendControl("redo")
        }
    }

    // Edit ▸ clipboard actions — thin AppDelegate wrappers that re-dispatch
    // the native AppKit selector to the first responder. Routing through
    // these (instead of binding the menu item directly to the native
    // selector) puts validation under `validateMenuItem(_:)` / MenuState
    // while leaving the action itself byte-identical to what AppKit would
    // have done: a synchronous responder-chain send that the WKWebView
    // services natively (system pasteboard, in-gesture clipboard).
    @objc func performCut(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: sender)
    }

    @objc func performCopy(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: sender)
    }

    @objc func performPaste(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: sender)
    }

    // Edit ▸ Copy as Plain Text — a chain-action round-trip. Unlike Copy,
    // this does NOT re-dispatch NSText.copy: the Markdown-strip transform
    // lives in the web responder chain, which writes the plain text to the
    // clipboard. An unhandled dispatch is a silent no-op (no selection).
    @objc func performCopyAsPlainText(_ sender: Any?) {
        sendControl("copy-as-plain-text")
    }

    @objc func performDelete(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.delete(_:)), to: nil, from: sender)
    }

    @objc func performSelectAll(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: sender)
    }

    // Edit ▸ Paste as Quote / Paste as Plain Text — chain-action
    // round-trips. Unlike Cut/Copy/Paste, these do NOT re-dispatch a
    // native NSText selector: the transform (blockquote wrap / Markdown
    // strip) lives in the web responder chain, which reads the clipboard
    // via the native bridge before inserting. An unhandled dispatch is a
    // silent no-op (no editable surface focused).
    @objc func performPasteAsQuote(_ sender: Any?) {
        sendControl("paste-as-quote")
    }

    @objc func performPasteAsPlainText(_ sender: Any?) {
        sendControl("paste-as-plain-text")
    }

    // Edit ▸ Make Uppercase / Make Lowercase — chain-action round-trips.
    // The case transform is applied to the focused surface's selection by
    // the web responder chain; an unhandled dispatch is a silent no-op (no
    // editable surface focused, or nothing selected).
    @objc func performMakeUppercase(_ sender: Any?) {
        sendControl("make-uppercase")
    }

    @objc func performMakeLowercase(_ sender: Any?) {
        sendControl("make-lowercase")
    }

    // Edit ▸ Quote / Unquote — chain-action round-trips. The CM6 editors
    // change the quote level of the lines the selection touches; an
    // unhandled dispatch is a silent no-op (no editor focused).
    @objc func performQuoteLines(_ sender: Any?) {
        sendControl("quote-lines")
    }

    @objc func performUnquoteLines(_ sender: Any?) {
        sendControl("unquote-lines")
    }

    // Edit ▸ Find — chain-action round-trips (the web responder chain's
    // find session owns the semantics; an unhandled dispatch is a no-op).
    @objc func performFind(_ sender: Any?) {
        sendControl("find")
    }

    @objc func performFindNext(_ sender: Any?) {
        sendControl("find-next")
    }

    @objc func performFindPrevious(_ sender: Any?) {
        sendControl("find-previous")
    }

    @objc func performFindSelection(_ sender: Any?) {
        sendControl("find-selection")
    }

    // Go ▸ card navigation — chain-action round-trips for the
    // chords the menu bar now swallows.
    @objc func previousCard(_ sender: Any?) {
        sendControl("previous-tab")
    }

    @objc func nextCard(_ sender: Any?) {
        sendControl("next-tab")
    }

    @objc func revealStack(_ sender: Any) {
        sendControl("reveal-stack")
    }

    @objc func previousCardInStack(_ sender: Any?) {
        sendControl("previous-stack-card")
    }

    @objc func nextCardInStack(_ sender: Any?) {
        sendControl("next-stack-card")
    }

    /// View ▸ Slim / Comfy / Wide. The preset rides `representedObject`;
    /// enablement and the check mark ride each item's registry gate on the
    /// menuState push, exactly as the Permission Mode radio group does.
    @objc func setCardWidthFromMenu(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        sendControl("set-pane-width", params: ["preset": preset])
    }

    /// Go ▸ Go to Slot N. The slot number rides `representedObject`.
    /// Unlike every other item in this group it is NOT selection-relative —
    /// centering moves the band, not a card — so the payload is the whole
    /// question and the frontend resolves nothing. Enablement rides the item's
    /// registry gate on the menuState push: dark under fit, and dark for a
    /// slot the current arrangement does not have.
    @objc func goToSlotFromMenu(_ sender: NSMenuItem) {
        guard let slot = sender.representedObject as? Int else { return }
        sendControl("go-to-slot", params: ["value": slot])
    }

    /// View ▸ ⟨Card⟩ ▸ Left / Right. Both halves of the address ride
    /// `representedObject` together, the shape the column-move rows use with
    /// one value instead of two. Enablement and the radio mark ride each
    /// item's registry gate on the menuState push: the pair is dark while the
    /// card is hidden, and the side the card stands on carries the check.
    ///
    /// It sends the same `set-sidebar-side` the Layout card's own controls
    /// send, so the two surfaces drive one store and cannot disagree.
    @objc func setSidebarSideFromMenu(_ sender: NSMenuItem) {
        guard let address = sender.representedObject as? [String: String],
              let componentId = address["componentId"],
              let side = address["side"] else { return }
        sendControl("set-sidebar-side", params: ["componentId": componentId, "side": side])
    }

    /// View ▸ Bullseye. No payload — the command is selection-relative, and
    /// the frontend's deck canvas is the one responder that can name which
    /// pane the selection is in. The check mark and the enablement both ride
    /// this item's registry gate on the menuState push, so the mark can never
    /// disagree with what the deck is actually showing.
    @objc func toggleBullseye(_ sender: Any?) {
        sendControl("toggle-bullseye")
    }

    /// Window ▸ Split or Stack Column. No payload, for the same reason
    /// Bullseye carries none: which slot divides is the frontend's answer, and
    /// it resolves it from the layout selection the chord resolves too.
    ///
    /// The title is the registry gate's dynamic one, and the item is dark only
    /// when the layout selection resolves to no column at all: a slot one card
    /// deep still splits, which arms the place for the card that arrives next.
    @objc func toggleColumnSplit(_ sender: Any?) {
        sendControl("toggle-column-split")
    }

    /// Window ▸ Move Card Up / Down / to Top / to Bottom of Column. The target
    /// rides `representedObject`; which card travels is again the frontend's
    /// answer. Enablement rides each item's registry gate on the menuState
    /// push, so an item is dark exactly when `moveInColumn` would refuse.
    @objc func moveInColumnFromMenu(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        sendControl("move-in-column", params: ["value": target])
    }

    /// Go ▸ Focus Card Left / Right / Above / Below. The direction rides
    /// `representedObject`, the shape the column-move rows use. NOT
    /// selection-relative, unlike those: the frontend reads the first responder,
    /// because the verb moves the keyboard rather than a card. Enablement rides
    /// each item's registry gate on the menuState push, answered per direction,
    /// so a row is dark exactly when the arrangement has nothing that way.
    @objc func focusCardFromMenu(_ sender: NSMenuItem) {
        guard let direction = sender.representedObject as? String else { return }
        sendControl("focus-card", params: ["value": direction])
    }

    /// Write every key equivalent the frontend's keymap states, recursively
    /// from `NSApp.mainMenu` (or from one submenu after a rebuild).
    ///
    /// This is the whole native half of funnel #2. `tugapp/Sources` contains
    /// no `performKeyEquivalent` override, no `NSEvent` monitor and no
    /// `keyDown` override, so every native key claim in the app is an
    /// `NSMenuItem` key equivalent — which makes this sweep complete coverage
    /// rather than a partial measure, and means nothing can hold a chord the
    /// keymap cannot see.
    ///
    /// The gate's chord field is three-state and all three are used:
    /// *absent* leaves the item's constructed key equivalent alone (the right
    /// answer for every item whose chord the table does not state), *detach*
    /// clears it, and a spec applies it. Detach is what lets a command claim
    /// a chord only while it is applicable — ⌘R when the stack has somewhere
    /// to go, ⇧⌘S while a Text card is frontmost — instead of eating the
    /// chord with a beep from a dimmed item.
    ///
    /// Called from `updateMenuState(_:)` and from the tail of every menu
    /// rebuild, never from `validateMenuItem(_:)`: that runs inside AppKit's
    /// closed-menu key-equivalent scan, where mutating a key equivalent is
    /// undefined.
    ///
    /// No index of items is kept — the walk finds them by identifier every
    /// time — so a rebuilt submenu cannot leave a stale reference behind.
    func applyCommandChords(in menu: NSMenu? = nil) {
        guard let root = menu ?? NSApp.mainMenu else { return }
        // While a chord capture is armed the whole tree stays parked; a
        // rebuild that lands mid-capture re-parks its fresh construction
        // literals instead of letting them claim keys the capture surface
        // is trying to read.
        if captureArmed {
            parkKeyEquivalents(in: root)
            return
        }
        for item in root.items {
            if let id = item.identifier?.rawValue,
               let gate = menuState.commands[id] {
                switch gate.chord {
                case .absent:
                    break
                case .detach:
                    item.keyEquivalent = ""
                    item.keyEquivalentModifierMask = []
                case .apply(let spec):
                    item.keyEquivalent = spec.keyEquivalent
                    item.keyEquivalentModifierMask = spec.modifierMask
                }
            }
            if let submenu = item.submenu { applyCommandChords(in: submenu) }
        }
    }

    /// Whether the frontend's Keyboard pane is recording a chord. While it
    /// is, every key the user presses is an answer to "what should this
    /// command be bound to" — and AppKit's key-equivalent scan resolves a
    /// menu chord before the web view ever sees the keydown, so the only way
    /// to let a bound chord through to be recorded is to take it off the
    /// menu for the span. `setCaptureArmed` parks every key equivalent in
    /// the tree on arm and restores them on disarm; the frontend's push
    /// carries the flag both ways, so a crash mid-capture heals on the next
    /// push rather than stranding a chordless menu bar.
    private var captureArmed = false

    /// The key equivalents `parkKeyEquivalents` cleared, with their masks,
    /// so disarming can put every construction-time literal back exactly.
    /// Gate-driven chords are re-applied by the sweep after restore, so a
    /// stale parked value can never outlive the next `applyCommandChords`.
    private var parkedKeyEquivalents: [(NSMenuItem, String, NSEvent.ModifierFlags)] = []

    private func setCaptureArmed(_ armed: Bool) {
        guard armed != captureArmed else { return }
        captureArmed = armed
        if armed {
            parkKeyEquivalents()
        } else {
            for (item, key, mask) in parkedKeyEquivalents {
                item.keyEquivalent = key
                item.keyEquivalentModifierMask = mask
            }
            parkedKeyEquivalents.removeAll()
            applyCommandChords()
        }
    }

    /// Clear every key equivalent under `menu` (the whole tree by default),
    /// remembering each so `setCaptureArmed(false)` can restore it. Items
    /// already parked read as empty and are skipped, so a mid-capture menu
    /// rebuild parks only its own fresh literals.
    private func parkKeyEquivalents(in menu: NSMenu? = nil) {
        guard let root = menu ?? NSApp.mainMenu else { return }
        for item in root.items {
            if !item.keyEquivalent.isEmpty {
                parkedKeyEquivalents.append(
                    (item, item.keyEquivalent, item.keyEquivalentModifierMask))
                item.keyEquivalent = ""
                item.keyEquivalentModifierMask = []
            }
            if let submenu = item.submenu { parkKeyEquivalents(in: submenu) }
        }
    }

    @objc func sourceTree(_ sender: Any) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose the tugtool mono-repo root directory"

        if panel.runModal() == .OK, let url = panel.url {
            if !TugConfig.isValidSourceTree(url) {
                let markers = TugConfig.sourceTreeMarkers.joined(separator: "\n  ")
                let alert = NSAlert()
                alert.messageText = "Invalid Source Tree"
                alert.informativeText = "The selected directory is not a tugtool repo.\nExpected to find:\n  \(markers)"
                alert.alertStyle = .warning
                alert.runModal()
                return
            }

            sourceTreePath = url.path
            savePreferences()
            updateDevInfoOverlay()
        }
    }

    /// Read the short git revision of the source tree. Returns nil when the
    /// path is missing, not a git repo, or git is unavailable on PATH.
    private func gitShortRev(at path: String) -> String? {
        return runGit(at: path, args: ["rev-parse", "--short", "HEAD"])
    }

    /// Read the current git branch of the source tree. Returns nil when the
    /// path is missing, not a git repo, detached HEAD, or git is unavailable.
    private func gitBranch(at path: String) -> String? {
        guard let value = runGit(at: path, args: ["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return nil
        }
        return value == "HEAD" ? nil : value
    }

    private func runGit(at path: String, args: [String]) -> String? {
        guard let gitPath = ProcessManager.which("git") else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: gitPath)
        proc.arguments = ["-C", path] + args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let value = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return value.isEmpty ? nil : value
        } catch {
            return nil
        }
    }

    /// Update the bottom-left dev-info overlay. Hidden when maker mode is off.
    func updateDevInfoOverlay() {
        guard makerModeEnabled else {
            window.setDevInfo(text: "")
            return
        }
        let branch: String
        let rev: String
        if let path = sourceTreePath {
            branch = gitBranch(at: path) ?? "unknown"
            rev = gitShortRev(at: path) ?? "unknown"
        } else {
            branch = "unknown"
            rev = "unknown"
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let buildStamp = formatter.string(from: appLaunchTime)
        let loadStamp = formatter.string(from: lastLoadTime)
        window.setDevInfo(text: "\(branch) · \(rev) · build \(buildStamp) · load \(loadStamp)")
    }

    /// Replace the shell's menu payload (called by MainWindow on every
    /// `menuState` message from the shell).
    func updateMenuState(_ payload: [String: Any]) {
        shellMenuPayload = payload
        applyMenuPayloads()
    }

    /// Replace one body's menu payload: its card-scoped blocks, which win
    /// while its card is the key card.
    func updateBodyMenuState(cardId: String, payload: [String: Any]) {
        bodyMenuPayloads[cardId] = payload
        applyMenuPayloads()
    }

    /// A body went away; its card's blocks go with it.
    func dropBodyMenuState(cardId: String) {
        guard bodyMenuPayloads.removeValue(forKey: cardId) != nil else { return }
        applyMenuPayloads()
    }

    /// Rebuild `menuState` from the shell's payload and the key card's body.
    private func applyMenuPayloads() {
        let previousToken = menuState.edit.nativeUndoToken
        menuState = MenuState(payload: MenuState.merged(shell: shellMenuPayload, bodies: bodyMenuPayloads))

        // Native-control undo scoping: the web view's NSUndoManager is
        // per-web-view, so its contents must never outlive focus in one
        // native text control. The frontend changes `nativeUndoToken`
        // whenever the focused native control changes (and zeroes it on
        // blur); clearing here on every change confines the native undo
        // stack to the control the user is in right now.
        if menuState.edit.nativeUndoToken != previousToken {
            window.editingUndoManager()?.removeAllActions()
        }

        // Park or restore the tree's key equivalents before any sweep below
        // touches them, so a rebuild and the sweep both see the settled
        // armed state.
        setCaptureArmed(menuState.captureArmed)

        // Rebuild Open Recent here, where the MRU arrives, and not only when
        // the submenu opens: the parent item's enablement is AppKit's own
        // "does this submenu hold an enabled item" rule, so an out-of-date
        // submenu leaves the parent live over an empty list.
        menuStateSync.rebuildOpenRecentMenu(menus.openRecentMenu)

        // Every chord the frontend states, written across the whole tree.
        // Here — outside AppKit's key-equivalent scan — and never in
        // validateMenuItem.
        applyCommandChords()
    }

    /// Tolerance for page-zoom bound comparisons: a level read back from
    /// `Double` is not bit-identical to its literal, so the Zoom In / Zoom
    /// Out / Actual Size gates compare against the bounds with this slack.
    private let pageZoomEpsilon: CGFloat = MainWindow.pageZoomEpsilon

    /// Auto-enable hook (`autoenablesItems` is on by default). Consulted
    /// for menu items whose nil-target action resolves to this delegate.
    ///
    /// Enablement is pull-based from the cached MenuState, keyed on the
    /// item's stable identifier (identity never rides the title). Almost
    /// every item is answered by the first tier below, from the gate its
    /// own command published. What remains here are the items whose truth
    /// is not the frontend's:
    ///
    /// - **Host-owned live state.** The View zoom bounds read
    ///   `window.currentPageZoom`, and Undo / Redo read the web view's
    ///   NSUndoManager while a native text control is focused.
    /// - **Host-owned readiness.** About and Settings each open a card, so
    ///   both wait on the frontend having signalled ready.
    /// - **Menu structure with no command behind it.** The Permission Mode
    ///   submenu parent.
    ///
    /// Anything without a predicate here stays enabled.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let id = menuItem.identifier?.rawValue else { return true }

        // An app modal freezes the deck's card count [B01]. The Open Recent
        // entries are built per open by `rebuildOpenRecentMenu` and carry no
        // registry gate of their own — their identifiers are positional
        // (`file.openRecent.0`…), so no table could carry them — and the
        // prefix is the whole of their rule. It takes in `file.openRecent.
        // clear` too, whose registry gate says the same thing through
        // `changesCardCount`; one item answered twice with one answer is
        // cheaper than a prefix with a hole in it.
        if menuState.appModalOpen, id.hasPrefix("file.openRecent.") {
            return false
        }

        // Registry tier, ahead of everything hand-rolled. A command that
        // publishes a gate has answered for itself — enablement, checkmark,
        // and dynamic title all come from the one table the frontend
        // dispatches from, so the item cannot be lit here and dead there.
        // Items that have not moved yet publish no gate and fall through.
        //
        // A gate carrying only a chord answers nothing here: the chord half
        // migrates on its own schedule, and the item keeps whichever tier
        // below still owns its enablement.
        if let gate = menuState.commands[id] {
            if let title = gate.title { menuItem.title = title }
            if let mark = gate.state { menuItem.state = mark.stateValue }
            if let enabled = gate.enabled { return enabled }
        }

        switch id {
        // App tier. About, Settings, and Keyboard Shortcuts each open a card,
        // so all three need a deck to open it into — dark until the frontend
        // has signalled ready.
        case "app.about", "app.settings", "app.keyboardShortcuts":
            // …and dark under an app modal, which all three would open a card
            // behind [B03]. The rule is "anything that changes the card
            // count", with no exceptions — a list with exceptions is a list
            // somebody forgets to add to.
            return frontendReady && !menuState.appModalOpen
        // New Session and New Jot each put a card on the deck. Host-owned:
        // `newSessionCard` has no registry entry at all, and New Jot's entry
        // publishes only a chord, so neither is answered by the tier above.
        case "file.newSessionCard", "file.newJot":
            return !menuState.appModalOpen
        // The update door's title AND enablement, set here during the
        // validation sweep for the same reason Undo / Redo are: the live
        // truth is the driver's snapshot, which no pushed frontend state can
        // see. The item is one door onto the whole flow [B07], so its title
        // names the decision the current state actually offers, and it goes
        // dark only while the flow is mid-transfer and there is nothing to
        // decide.
        case "app.checkForUpdates":
            let snapshot = updateController.snapshot
            menuItem.title = snapshot.menuTitle(appName: appDisplayName)
            // Always enabled while the updater is running. Raising the wizard
            // is the item's whole job [B05] and every stage can do it, so
            // there is no stage in which the item has nothing to do. It used
            // to go grey through `checking`, `downloading`, `extracting` and
            // `installing` — the stages a user is most likely to want to look
            // at.
            return true
        // View zoom. Reads `window.currentPageZoom` live rather than the
        // pushed state: page zoom is the host's own property, changed by
        // these very commands, and the read is a synchronous accessor so it
        // is safe inside the validator.
        //
        // A document surface owns its own zoom range, which the host cannot
        // see, so the page-zoom bounds stop being the right gate while one is
        // frontmost — the items stay live and the surface clamps.
        //
        // Floating-point tolerance: a level that has round-tripped through
        // `Double` is not bit-identical to its literal, so the bound
        // comparisons carry a small epsilon to avoid spurious disables right
        // at the limits.
        case "view.actualSize":
            if menuState.document != nil { return true }
            return abs(window.currentPageZoom - MainWindow.defaultPageZoom) > pageZoomEpsilon
        case "view.zoomIn", "view.zoomInAlias":
            if menuState.document != nil { return true }
            return window.currentPageZoom < MainWindow.maxPageZoom - pageZoomEpsilon
        case "view.zoomOut":
            if menuState.document != nil { return true }
            return window.currentPageZoom > MainWindow.minPageZoom + pageZoomEpsilon
        case "view.toggleActualSize":
            return window.canToggleActualSize
        // Undo / Redo: titles AND enablement set here, during the
        // validation sweep (the sanctioned AppKit pattern; identity never
        // rides the title). They are the one Edit pair the registry does
        // not gate, because one of their two sources is live AppKit state
        // the frontend cannot see.
        // Two sources, discriminated by nativeUndoToken:
        //   - Native text control focused (token != 0): the web view's
        //     NSUndoManager is the live truth — canUndo/canRedo and its
        //     own localized menu titles ("Undo Typing"). The stack is
        //     cleared on every token change (updateMenuState), so what it
        //     reports is always scoped to the focused control.
        //   - Otherwise: the chain caps (focused editor's history depth)
        //     plus the editor-published noun ("Typing", "Paste", …).
        case "edit.undo":
            if menuState.edit.nativeUndoToken != 0,
               let um = window.editingUndoManager() {
                menuItem.title = um.canUndo ? um.undoMenuItemTitle : "Undo"
                return um.canUndo
            }
            menuItem.title = menuState.edit.undoLabel.isEmpty
                ? "Undo" : "Undo \(menuState.edit.undoLabel)"
            return menuState.edit.undo
        case "edit.redo":
            if menuState.edit.nativeUndoToken != 0,
               let um = window.editingUndoManager() {
                menuItem.title = um.canRedo ? um.redoMenuItemTitle : "Redo"
                return um.canRedo
            }
            menuItem.title = menuState.edit.redoLabel.isEmpty
                ? "Redo" : "Redo \(menuState.edit.redoLabel)"
            return menuState.edit.redo
        default:
            // Cold start reads as disabled. Before the first push the
            // `commands` block is empty, and the items the registry tier
            // answers post-push would otherwise all fall through to `true`
            // here — lighting the whole Session and File menus during the
            // splash, against a frontend that is not listening yet. Once a
            // push has arrived, an identified item with no gate and no case
            // above genuinely has no predicate and stays enabled.
            return !menuState.commands.isEmpty
        }
    }

    // MARK: - UDS control commands

    private func sendControl(_ action: String, params: [String: Any] = [:]) {
        processManager.sendControl(action, params: params)
    }
}

// MARK: - MenuBarActions

/// Every selector `MenuBarBuilder` names is implemented above; this is the
/// line that makes the compiler check it.
extension AppDelegate: MenuBarActions {}

// MARK: - MenuState, drawn in AppKit

// `MenuState` is Foundation-only so the TugTests bundle compiles it; these
// two translations into AppKit's types are the whole of what the menu needs
// beyond it.

extension MenuState.ChordSpec {
    var modifierMask: NSEvent.ModifierFlags {
        var mask: NSEvent.ModifierFlags = []
        if command { mask.insert(.command) }
        if shift { mask.insert(.shift) }
        if option { mask.insert(.option) }
        if control { mask.insert(.control) }
        return mask
    }
}

extension MenuState.CommandGate.Mark {
    var stateValue: NSControl.StateValue {
        switch self {
        case .off: return .off
        case .on: return .on
        case .mixed: return .mixed
        }
    }
}
