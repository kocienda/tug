import Cocoa
import UniformTypeIdentifiers

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var window: MainWindow!
    private var processManager = ProcessManager()

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
    private lazy var makerModeEnabled: Bool =
        isAppTestHarness ? false : (BuildInfo.profile == "debug")

    /// The dev-*serving* switch: maker mode, except the app-test
    /// harness always serves production. Feeds Vite spawning and the
    /// tugcast `dev_mode` wire verb (which keeps its name — it really
    /// is about serving).
    private var devServingEnabled: Bool { makerModeEnabled && !isAppTestHarness }

    private var sourceTreePath: String?
    private var lastAuthURL: String?
    private var vitePort: Int = InstanceConfig.vitePort
    private var initialLoadComplete = false
    private let appLaunchTime = Date()
    private var lastLoadTime = Date()

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
    private var frontendHasLoadedOnce = false
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
    private var makerMenu: NSMenuItem!

    /// Whether the frontend has signalled ready at least once. Gates About
    /// and Settings, both of which open a card and so need a live deck.
    /// Read by `validateMenuItem`: `autoenablesItems` is on, so a stored
    /// `isEnabled` on those items would be overridden by the validator's
    /// permissive default and the gate would never take effect.
    private var frontendReady = false

    /// Sparkle self-update. Inactive for every identity but the stable
    /// release build (or a `TUG_SPARKLE_FEED` override), in which case the
    /// "Check for Updates…" menu item stays hidden.
    private let updateController = UpdateController()
    private var checkForUpdatesMenuItem: NSMenuItem?
    /// An update found before the deck was live. Flushed to the bulletin
    /// bridge once `bridgeFrontendReady` fires, like `pendingOpenPaths`.
    private var pendingUpdateNotice: (version: String, build: String)?

    #if DEBUG
    /// In-app test harness bridge, active only when
    /// `TUGAPP_TEST_SOCKET` env var is set. DEBUG-only.
    private var testHarnessBridge: TestHarnessBridge?
    #endif

    // File menu state
    private var closeMenuItem: NSMenuItem!
    private var closeAllCardTabsMenuItem: NSMenuItem!

    // View menu state
    private var viewMenu: NSMenu!

    // Window menu state. The pane-list slice is managed in place between
    // `windowPaneListAnchor` and the following separator — the menu
    // assigned to NSApp.windowsMenu is never wholesale-rebuilt, so
    // AppKit's automatic window entries survive every open.
    private var windowMenu: NSMenu!
    private var windowPaneListAnchor: NSMenuItem?

    /// File ▸ Open Recent submenu — rebuilt on open by the NSMenuDelegate
    /// from `menuState.recentDocuments`, filtered to still-existing files.
    private var openRecentMenu: NSMenu!

    /// Cached menu-relevant frontend state, replaced wholesale on every
    /// `menuState` push from tugdeck. All pull-based menu validation
    /// (`validateMenuItem(_:)`) and dynamic menu building read from here.
    private var menuState = MenuState.empty

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

    // Theme menu state
    private var themeMenu: NSMenu!
    private var activeThemeName: String?

    /// The name of the base theme — must match BASE_THEME_NAME in tugdeck/src/theme-constants.ts.
    private let baseThemeName = "brio"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let t0 = CFAbsoluteTimeGetCurrent()
        func lap(_ label: String) {
            let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            NSLog("LAUNCH [%6.1fms] %@", ms, label)
        }

        lap("start")

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

        window.bridgeDelegate = self
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

        updateController.onScheduledUpdateFound = { [weak self] version, build in
            self?.announceUpdate(version: version, build: build)
        }
        updateController.startIfEligible()
        lap("updateController")

        buildMenuBar()
        lap("buildMenuBar")

        ProcessManager.resolveShellPATH()
        lap("resolveShellPATH")

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
            lap("onReady (tugcast port=\(port))")
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
                self.window.evaluateJavaScript(
                    "fetch('/auth?token=\(token)',{credentials:'include'}).then(function(){window.tugdeck?.reconnect?.()}).catch(function(){})"
                )
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
                        NSLog("AppDelegate: vite server did not become ready in 10s")
                    }
                    let viteURL = "http://127.0.0.1:\(self.vitePort)/auth?token=\(token)"
                    self.window.loadURL(viteURL)
                    // Notify tugcast to activate file watchers and set origin allowlist.
                    self.processManager.sendDevMode(enabled: true, sourceTree: path, vitePort: self.vitePort)
                }
            } else {
                // Production mode: load directly from tugcast. No Vite process is spawned.
                // tugcast serves pre-built dist/ files via ServeDir on port 55255.
                let tugcastURL = "http://127.0.0.1:\(port)/auth?token=\(token)"
                self.window.loadURL(tugcastURL)
                // Notify tugcast to update file watchers and clear dev_port from origin allowlist.
                self.processManager.sendDevMode(enabled: false, sourceTree: self.sourceTreePath, vitePort: self.vitePort)
            }
        }

        processManager.onDevModeError = { [weak self] message in
            guard let self = self else { return }
            self.window.bridgeDevModeError(message: message)
        }

        // Start tugcast
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
    /// persist every card, retry rejected writes — and call `completion`
    /// once, whatever happens.
    ///
    /// WKWebView fires no `visibilitychange` and no `beforeunload` on app
    /// quit, so this is the only save trigger on exit. It is called before
    /// any child process is signalled: a turn still streaming when the
    /// process group dies is a rug pull.
    private func runDeckTerminationPipeline(completion: @escaping () -> Void) {
        var settled = false
        func settle() {
            guard !settled else { return }
            settled = true
            completion()
        }

        // Degraded path: the old synchronous save. Strictly no worse than
        // what shipped before the pipeline, and the only thing left when
        // the bridge itself is broken.
        func fallbackSave() {
            self.window.evaluateJavaScript("window.tugdeck?.saveState?.()")
        }

        let deadline = DispatchWorkItem {
            NSLog(
                "AppDelegate: termination pipeline did not answer within %.0fs — saving synchronously and tearing down",
                Self.terminationPipelineDeadline
            )
            fallbackSave()
            settle()
        }
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.terminationPipelineDeadline,
            execute: deadline
        )

        NSLog("AppDelegate: applicationShouldTerminate — running the deck termination pipeline")
        window.callAsyncJavaScript("return await window.tugdeck.prepareForTermination();") { result in
            deadline.cancel()
            switch result {
            case .success(let value):
                NSLog("AppDelegate: termination verdict — %@", Self.describeVerdict(value))
            case .failure(let error):
                NSLog(
                    "AppDelegate: termination pipeline failed (%@) — saving synchronously instead",
                    error.localizedDescription
                )
                fallbackSave()
            }
            settle()
        }
    }

    /// Render the deck's verdict as one log line. Unknown or malformed
    /// shapes are logged verbatim rather than dropped — the point of the
    /// verdict is that a bad quit leaves a named trace.
    private static func describeVerdict(_ value: Any?) -> String {
        guard let verdict = value as? [String: Any] else {
            return "unreadable: \(String(describing: value))"
        }
        func ids(_ key: String) -> String {
            let list = verdict[key] as? [String] ?? []
            return list.isEmpty ? "none" : list.joined(separator: ",")
        }
        let ok = verdict["ok"] as? Bool ?? false
        let flushed = verdict["flushedCards"] as? Int ?? -1
        let layoutSaved = verdict["layoutSaved"] as? Bool ?? false
        let elapsed = verdict["elapsedMs"] as? Int ?? -1
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
        // An update-driven quit holds Sparkle's relaunch here, so the new
        // version starts only once this instance's children are gone. A
        // no-op on every other quit — and reached from every completion
        // path, including the degraded one, so an update can never stall.
        updateController.resumePostponedRelaunch()
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
    private func sendVoiceOverState() {
        let enabled = NSWorkspace.shared.isVoiceOverEnabled
        NSLog("AppDelegate: sendVoiceOverState (enabled=%d)", enabled ? 1 : 0)
        processManager.sendControl("voiceover-changed", params: ["enabled": enabled])
    }

    private func replayLifecycleState() {
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

    /// Announce an update found by a scheduled Sparkle check, queueing it
    /// when the deck has not mounted yet. Called from the gentle-reminder
    /// delegate, which may fire long before or long after first paint.
    private func announceUpdate(version: String, build: String) {
        guard frontendHasLoadedOnce, let window = window else {
            pendingUpdateNotice = (version, build)
            return
        }
        window.bridgeUpdateAvailable(version: version, build: build)
    }

    /// Flush a queued update notice once the deck is live. Called from
    /// `bridgeFrontendReady`, beside `flushPendingOpenPaths`.
    func flushPendingUpdateNotice() {
        guard let notice = pendingUpdateNotice, let window = window else { return }
        pendingUpdateNotice = nil
        window.bridgeUpdateAvailable(version: notice.version, build: notice.build)
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

    private func savePreferences() {
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

    /// Build the menu tree: structure, identifiers, selectors, and the
    /// key-equivalent literals below.
    ///
    /// Those literals are **defaults**, not the last word. The frontend's
    /// command registry is where a chord is decided, and `applyCommandChords`
    /// writes what it decides over anything spelled here — so a literal is
    /// what the menu bar shows between launch and the first menu-state push,
    /// and what stands for any item whose chord the registry does not state.
    /// Items whose chord is conditional (Save As…, the two slot-stack items)
    /// are built without one for exactly that reason.
    private func buildMenuBar() {
        let mainMenu = NSMenu()
        let appName = appDisplayName

        // Tug (App) Menu - position 0
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        let aboutItem = NSMenuItem(title: "About \(appName)", action: #selector(showAbout(_:)), keyEquivalent: "")
        aboutItem.identifier = NSUserInterfaceItemIdentifier("app.about")
        appMenu.addItem(aboutItem)
        // Hidden rather than disabled when the updater is inactive — a
        // bundle that cannot replace itself should not advertise the
        // command at all (the Maker-menu pattern).
        let checkForUpdatesItem = NSMenuItem(
            title: "Check for Updates...",
            action: #selector(checkForUpdates(_:)),
            keyEquivalent: ""
        )
        checkForUpdatesItem.identifier = NSUserInterfaceItemIdentifier("app.checkForUpdates")
        checkForUpdatesItem.isHidden = !updateController.isActive
        self.checkForUpdatesMenuItem = checkForUpdatesItem
        appMenu.addItem(checkForUpdatesItem)
        appMenu.addItem(NSMenuItem.separator())
        // Configure Tug… — reopens the wizard on an app that is already set up,
        // so install / log-in / on-device-AI stay reachable instead of being a
        // first-launch-only surface. Sends the app-level `configure-tug` control
        // frame; tugdeck's ConfigureTugRequest stops any in-flight turns (with a
        // confirm) before the app-modal wizard opens. Ordered above Log Out
        // because it is the everyday one of the three.
        let configureTugItem = NSMenuItem(title: "Configure Tug...", action: #selector(showConfigureTug(_:)), keyEquivalent: "")
        configureTugItem.identifier = NSUserInterfaceItemIdentifier("app.configureTug")
        appMenu.addItem(configureTugItem)
        // Log Out… — app-level account action. Sends the app-level `logout`
        // control frame (not a per-card command), so it works even with no card
        // open; tugdeck's TugLogout runs the confirm → logout flow. Enabled
        // always (validateMenuItem default); a no-op when already logged out
        // (TugLogout guards on the auth state).
        let logoutItem = NSMenuItem(title: "Log Out...", action: #selector(logOut(_:)), keyEquivalent: "")
        logoutItem.identifier = NSUserInterfaceItemIdentifier("app.logout")
        appMenu.addItem(logoutItem)
        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(showSettings(_:)), keyEquivalent: ",")
        settingsItem.identifier = NSUserInterfaceItemIdentifier("app.settings")
        appMenu.addItem(settingsItem)
        // Keyboard Shortcuts… — the keymap configurator, a card of its own
        // rather than a pane of Settings. No key equivalent: ⌘, belongs to
        // Settings, and this card is also reachable from a control inside
        // Settings and from the Lens.
        let keyboardItem = NSMenuItem(title: "Keyboard Shortcuts...", action: #selector(showKeyboardShortcuts(_:)), keyEquivalent: "")
        keyboardItem.identifier = NSUserInterfaceItemIdentifier("app.keyboardShortcuts")
        appMenu.addItem(keyboardItem)
        appMenu.addItem(NSMenuItem.separator())

        // Services submenu
        let servicesMenuItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesMenuItem.identifier = NSUserInterfaceItemIdentifier("app.services")
        let servicesMenu = NSMenu(title: "Services")
        servicesMenuItem.submenu = servicesMenu
        appMenu.addItem(servicesMenuItem)
        NSApp.servicesMenu = servicesMenu

        appMenu.addItem(NSMenuItem.separator())
        let hideItem = NSMenuItem(title: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hideItem.identifier = NSUserInterfaceItemIdentifier("app.hide")
        appMenu.addItem(hideItem)
        let hideOthersItem = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h", modifierMask: [.command, .option])
        hideOthersItem.identifier = NSUserInterfaceItemIdentifier("app.hideOthers")
        appMenu.addItem(hideOthersItem)
        let showAllItem = NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        showAllItem.identifier = NSUserInterfaceItemIdentifier("app.showAll")
        appMenu.addItem(showAllItem)
        appMenu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.identifier = NSUserInterfaceItemIdentifier("app.quit")
        appMenu.addItem(quitItem)

        // File Menu - position 1
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu

        // Card creation, flattened — two production card types don't need
        // a submenu. The debug-only gallery / hello-world / active-pane
        // creators live in the app-maker menu, gated at compile time on
        // BuildInfo.profile.
        fileMenu.addItem(NSMenuItem(title: "New Session", action: #selector(newSessionCard(_:)), keyEquivalent: "n").identified("file.newSessionCard"))

        // New Text File (⌥⌘N): a new untitled manual buffer — no file
        // exists until the first Save.
        fileMenu.addItem(NSMenuItem(title: "New Text File", action: #selector(newTextCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option]).identified("file.newTextCard"))

        // New Jot (⌘J): capture a thought into the Jots rail, revealing it if
        // hidden. Built with no key equivalent so `applyCommandChords` writes
        // the registry's chord onto the item — a Swift literal here would make
        // the chord unrebindable, which is the anomaly the sweep exists to
        // avoid.
        fileMenu.addItem(NSMenuItem(title: "New Jot", action: #selector(newJot(_:)), keyEquivalent: "").identified("file.newJot"))

        // Open File… (⌘O): NSOpenPanel → `open-file` Control frame. The
        // web layer reuses an existing Text card bound to the chosen
        // path or opens a new one (action-dispatch.ts `open-file`).
        fileMenu.addItem(NSMenuItem(title: "Open File…", action: #selector(openFileInEditor(_:)), keyEquivalent: "o").identified("file.openFile"))

        // Open Quickly (⇧⌘O): the deck-global fuzzy file-search popup
        // (action-dispatch.ts `open-quickly` → OpenQuicklyOverlay).
        fileMenu.addItem(NSMenuItem(title: "Open Quickly…", action: #selector(openQuickly(_:)), keyEquivalent: "o", modifierMask: [.command, .shift]).identified("file.openQuickly"))

        // Open Recent ▸ — a dynamic submenu rebuilt on open from the
        // menuState MRU, filtered to files that still exist (NSMenuDelegate
        // `menuNeedsUpdate`).
        //
        // The parent dims when the list is empty, and it dims by itself: the
        // item carries a submenu and no action, so AppKit never asks
        // `validateMenuItem` about it and instead enables it only when the
        // submenu holds an enabled item. An empty MRU builds a lone disabled
        // "No Recent Documents" placeholder, which is what makes the parent
        // dark. Keeping the submenu's contents current is therefore the whole
        // gate — an imperative `isEnabled` write here would be overwritten by
        // AppKit's own update pass. Built once now so the rule has something
        // to read before the first push, and rebuilt from `updateMenuState`
        // whenever the MRU changes.
        let openRecentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "").identified("file.openRecent")
        let openRecentSubmenu = NSMenu(title: "Open Recent")
        openRecentSubmenu.delegate = self
        openRecentItem.submenu = openRecentSubmenu
        self.openRecentMenu = openRecentSubmenu
        rebuildOpenRecentMenu(openRecentSubmenu)
        fileMenu.addItem(openRecentItem)

        // Save (⌘S): flush the focused editor's pending edits to disk
        // now. Under the Text card's live autosave there is no dirty
        // state — this is "write immediately + checkpoint", routed as a
        // `save` Control frame → responder-chain SAVE dispatch. AppKit
        // swallows ⌘S at the menubar, so the menu item must carry the
        // chord; the web keybinding-map entry covers browser-only dev.
        fileMenu.addItem(NSMenuItem(title: "Save…", action: #selector(saveActiveEditor(_:)), keyEquivalent: "s").identified("file.save"))
        // Save As… — built without ⇧⌘S. The command claims the chord only
        // while a Text card is frontmost and releases it otherwise, which the
        // frontend states in its gate and `applyCommandChords` writes: a
        // chord left on a dimmed item is eaten at the menu bar with a beep
        // instead of falling through, so a static ⇧⌘S would be dead
        // everywhere else rather than merely inapplicable.
        fileMenu.addItem(NSMenuItem(title: "Save As…", action: #selector(saveAsActiveEditor(_:)), keyEquivalent: "").identified("file.saveAs"))
        // Save a Copy… — no chord; the revert/reload verbs collide with
        // nothing either, so they stay unbound.
        fileMenu.addItem(NSMenuItem(title: "Save a Copy…", action: #selector(saveACopyActiveEditor(_:)), keyEquivalent: "").identified("file.saveACopy"))
        fileMenu.addItem(NSMenuItem(title: "Revert to Saved", action: #selector(revertActiveEditor(_:)), keyEquivalent: "").identified("file.revertToSaved"))
        fileMenu.addItem(NSMenuItem(title: "Reload from Disk", action: #selector(reloadActiveEditor(_:)), keyEquivalent: "").identified("file.reloadFromDisk"))

        fileMenu.addItem(NSMenuItem.separator())

        // Close (⌘W): routes through the web view's responder chain
        // rather than NSWindow.performClose. The custom selector sends a
        // Control frame that action-dispatch.ts turns into a `close` chain
        // dispatch, which lands on TugPane's registered handler. Without the
        // round-trip, AppKit would swallow ⌘W at the menubar and the WKWebView
        // would never see the keystroke. The web layer decides whether ⌘W
        // closes the active card or the whole pane (single-card case); the
        // label stays "Close" regardless.
        closeMenuItem = NSMenuItem(title: "Close", action: #selector(closeActiveCard(_:)), keyEquivalent: "w")
        // Stable identifier for native-menu introspection (test harness
        // `menuItemState` / `menuSnapshot`).
        closeMenuItem.identifier = NSUserInterfaceItemIdentifier("file.closeCard")
        fileMenu.addItem(closeMenuItem)

        // Close All Tabs (⌥⌘W): closes every tab in the focused pane via
        // the same `close-all` responder-chain round-trip `close` uses. Enabled
        // only when the focused pane holds more than one card — its registry
        // gate on the menuState push. The web layer pops the "Close N Tabs?"
        // confirm when any hosted card opts into confirmClose.
        closeAllCardTabsMenuItem = NSMenuItem(title: "Close All Tabs", action: #selector(closeAllCardTabs(_:)), keyEquivalent: "w", modifierMask: [.command, .option])
        closeAllCardTabsMenuItem.identifier = NSUserInterfaceItemIdentifier("file.closeAllCardTabs")
        fileMenu.addItem(closeAllCardTabsMenuItem)

        fileMenu.addItem(NSMenuItem.separator())

        // Export Session… — the session card's `/export` surface, reached
        // through the generic run-card-command round-trip. Gated by its
        // registry gate on the menuState push.
        let exportItem = NSMenuItem(title: "Export Session…", action: #selector(runCardCommand(_:)), keyEquivalent: "").identified("file.exportTranscript")
        exportItem.representedObject = "export"
        fileMenu.addItem(exportItem)

        // Edit Menu - position 2
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        // Undo / Redo target performUndo/performRedo wrappers, NOT the
        // bare `undo:` selectors AppKit would auto-validate against an
        // NSUndoManager — the web view's undoManager is per-web-view and
        // knows nothing about card activation, so unconditional
        // auto-validation kept showing a deactivated card's undo state.
        // Validation and execution are two-path, discriminated by
        // MenuState.edit.nativeUndoToken (see validateMenuItem and the
        // wrappers): chain caps + control-frame round-trip for the CM6
        // editors (card-scoped history depth + "Undo Typing" nouns), and
        // the web view's NSUndoManager — live canUndo + native selector —
        // for browser-native text controls, scoped by the token-change
        // clear. A chord on a DISABLED item is eaten at the menu bar with
        // a beep (it does NOT fall through to the web view), which is why
        // the native path must light the item rather than stay dark.
        editMenu.addItem(NSMenuItem(title: "Undo", action: #selector(performUndo(_:)), keyEquivalent: "z").identified("edit.undo"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: #selector(performRedo(_:)), keyEquivalent: "z", modifierMask: [.command, .shift]).identified("edit.redo"))
        editMenu.addItem(NSMenuItem.separator())
        // The remaining edit actions target AppDelegate wrappers
        // (performCopy / …) rather than the bare NSText selectors so that
        // `validateMenuItem(_:)` is consulted — the wrappers resolve to
        // this delegate, the native selectors would resolve to the
        // WKWebView and be validated by WebKit, which over-enables Copy /
        // Select All because a web page is always "selectable" regardless
        // of our focus state. Each wrapper re-dispatches its native AppKit
        // selector to the first responder synchronously (`NSApp.sendAction`),
        // so the system pasteboard and the in-gesture clipboard path are
        // preserved untouched — enablement is the only thing we take over,
        // pulled from each item's registry gate on the menuState push.
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(performCut(_:)), keyEquivalent: "x").identified("edit.cut"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(performCopy(_:)), keyEquivalent: "c").identified("edit.copy"))
        // Copy as Plain Text — a chain-action round-trip (NOT the native
        // NSText.copy selector). The web responder chain strips Markdown
        // from the selection and writes the plain text to the clipboard;
        // enablement rides its registry gate, which needs a selection the
        // same way Copy's does.
        // ⌥⇧⌘C — the "…as Plain Text" composed set (tuglaws/chord-tiers.md):
        // ⌥ the variant of Copy, ⇧ its counterpart, both twists at once. Its
        // twin is ⌥⇧⌘V on Paste as Plain Text below.
        editMenu.addItem(NSMenuItem(title: "Copy as Plain Text", action: #selector(performCopyAsPlainText(_:)), keyEquivalent: "c", modifierMask: [.command, .shift, .option]).identified("edit.copyAsPlainText"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(performPaste(_:)), keyEquivalent: "v").identified("edit.paste"))
        // Paste variants — chain-action round-trips (NOT the native
        // NSText.paste selector). The web responder chain reads the
        // clipboard via the native bridge, rewrites it (blockquote wrap /
        // Markdown strip), and inserts; enablement rides each item's registry
        // gate, which needs an editable surface the same way Paste's does.
        editMenu.addItem(NSMenuItem(title: "Paste as Quote", action: #selector(performPasteAsQuote(_:)), keyEquivalent: "v", modifierMask: [.command, .option]).identified("edit.pasteAsQuote"))
        // ⌥⇧⌘V — moved off ⇧⌘V to pair with the ⌥⇧⌘C copy variant.
        editMenu.addItem(NSMenuItem(title: "Paste as Plain Text", action: #selector(performPasteAsPlainText(_:)), keyEquivalent: "v", modifierMask: [.command, .shift, .option]).identified("edit.pasteAsPlainText"))
        editMenu.addItem(NSMenuItem(title: "Delete", action: #selector(performDelete(_:)), keyEquivalent: "").identified("edit.delete"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(performSelectAll(_:)), keyEquivalent: "a").identified("edit.selectAll"))
        editMenu.addItem(NSMenuItem.separator())

        // The case pair — chain-action round-trips like the paste variants:
        // the transform lives in the web responder chain, which rewrites the
        // selection in one editor transaction so undo reverts it whole. Built
        // with EMPTY key equivalents on purpose: their chords (⌥⌘U / ⌥⌘L) are
        // the command registry's, published per item in the menu-state gate,
        // and `applyCommandChords` writes them from there — a construction
        // literal here would put a second author on the same keys and would
        // survive a rebind.
        editMenu.addItem(NSMenuItem(title: "Make Uppercase", action: #selector(performMakeUppercase(_:)), keyEquivalent: "").identified("edit.makeUppercase"))
        editMenu.addItem(NSMenuItem(title: "Make Lowercase", action: #selector(performMakeLowercase(_:)), keyEquivalent: "").identified("edit.makeLowercase"))
        editMenu.addItem(NSMenuItem.separator())

        // Copy Last Response — the session card's `/copy` surface. Enablement
        // rides the command's registry gate on the menuState push.
        let copyLastItem = NSMenuItem(title: "Copy Last Response", action: #selector(runCardCommand(_:)), keyEquivalent: "").identified("edit.copyLastResponse")
        copyLastItem.representedObject = "copy"
        editMenu.addItem(copyLastItem)
        editMenu.addItem(NSMenuItem.separator())

        // Find submenu — chain-action round-trips. The previous
        // NSTextView.performFindPanelAction items never reached WKWebView
        // content (dead UI); these dispatch the web responder chain's
        // find / find-next / find-previous, handled by the focused card's
        // find session. Enablement rides each item's registry gate on the
        // menuState push: disabled until a find-capable surface is
        // focused, so the items aren't live shortcuts to a no-op while no
        // card implements find.
        let findMenuItem = NSMenuItem(title: "Find", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "Find")
        findMenuItem.submenu = findMenu
        findMenu.addItem(NSMenuItem(title: "Find...", action: #selector(performFind(_:)), keyEquivalent: "f").identified("edit.find"))
        findMenu.addItem(NSMenuItem(title: "Find Next", action: #selector(performFindNext(_:)), keyEquivalent: "g").identified("edit.findNext"))
        findMenu.addItem(NSMenuItem(title: "Find Previous", action: #selector(performFindPrevious(_:)), keyEquivalent: "g", modifierMask: [.command, .shift]).identified("edit.findPrevious"))
        // ⌘E — the selection becomes the query and the search runs. Its gate
        // is stricter than its siblings': a find-capable surface with nothing
        // selected validates it disabled.
        findMenu.addItem(NSMenuItem(title: "Use Selection for Find", action: #selector(performFindSelection(_:)), keyEquivalent: "e").identified("edit.useSelectionForFind"))
        editMenu.addItem(findMenuItem)

        // Session Menu - position 3. The session card's command surfaces,
        // first-class in the menu bar. The menu is always present and its
        // items validate to disabled without a frontmost session card
        // (stable bars with disabled items beat vanishing menus for
        // discoverability); most items are run-card-command round-trips
        // into the card's slash-command surface map.
        let sessionMenuItem = NSMenuItem()
        mainMenu.addItem(sessionMenuItem)
        let sessionMenu = NSMenu(title: "Session")
        sessionMenuItem.submenu = sessionMenu

        sessionMenu.addItem(NSMenuItem(title: "Focus Prompt", action: #selector(focusPrompt(_:)), keyEquivalent: "k").identified("session.focusPrompt"))
        // Stop has no key equivalent by design: Escape already routes
        // interrupt through the chain with dismiss-first priority
        // (popover > drag-cancel > interrupt); this item is the
        // discoverable, always-means-interrupt face of that path,
        // gated by its registry gate on the menuState push.
        sessionMenu.addItem(NSMenuItem(title: "Stop", action: #selector(stopSession(_:)), keyEquivalent: "").identified("session.stop"))
        sessionMenu.addItem(NSMenuItem.separator())

        // The composer's two affordances and transcript navigation. These were
        // chord-only until now — working commands with no discoverable door —
        // so the menu is what makes them findable.
        //
        // They are built WITHOUT key equivalents on purpose. Their chords
        // belong to the command registry, which publishes them per item in
        // the menu-state gate along with the item's enablement, and the
        // chord sweep applies them from there. Stamping a construction-time
        // literal here would put a second author on the same key equivalent
        // and would attach the chord to an item that can validate disabled —
        // where AppKit eats it with a beep instead of letting the web view
        // have it. Until the sweep runs, the frontend's own key pipeline
        // serves these chords exactly as it did before the items existed.
        sessionMenu.addItem(NSMenuItem(title: "Insert File…", action: #selector(insertFile(_:)), keyEquivalent: "").identified("session.insertFile"))
        sessionMenu.addItem(NSMenuItem(title: "Open Command Picker", action: #selector(openCommandPicker(_:)), keyEquivalent: "").identified("session.commandPicker"))

        // Go in Transcript ▸ — the four turn-navigation verbs, submenued so
        // they read as one axis rather than four rows competing with the
        // session's own verbs for the reader's attention.
        let goItem = NSMenuItem(title: "Go in Transcript", action: nil, keyEquivalent: "").identified("session.go")
        let goMenu = NSMenu(title: "Go in Transcript")
        goItem.submenu = goMenu
        goMenu.addItem(NSMenuItem(title: "Previous Turn", action: #selector(previousTurn(_:)), keyEquivalent: "").identified("session.previousTurn"))
        goMenu.addItem(NSMenuItem(title: "Next Turn", action: #selector(nextTurn(_:)), keyEquivalent: "").identified("session.nextTurn"))
        goMenu.addItem(NSMenuItem(title: "First Turn", action: #selector(firstTurn(_:)), keyEquivalent: "").identified("session.firstTurn"))
        goMenu.addItem(NSMenuItem(title: "Last Turn", action: #selector(lastTurn(_:)), keyEquivalent: "").identified("session.lastTurn"))
        sessionMenu.addItem(goItem)
        sessionMenu.addItem(NSMenuItem.separator())

        func sessionCommandItem(_ title: String, _ command: String, _ id: String) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: #selector(runCardCommand(_:)), keyEquivalent: "").identified(id)
            item.representedObject = command
            return item
        }

        // The changes group: glance, land, inspect, look back. Show/Hide the
        // Changes / History Shades ([P05], Spec S04) bracket it — the title's
        // verb rides the registry gate's title field on the menuState push, the
        // represented view name rides `representedObject`, and the toggle
        // round-trips a `toggle-{changes,history}-view` control frame.
        //
        // Commit Changes carries no chord. It is the LAND verb, not the enter
        // verb (`/commit` and ⌃⌘C-on-an-empty-composer are the doors into
        // commit mode), and it validates on the frontend's `commitReady` — mode
        // active, session idle, changeset non-empty, message written. In exactly
        // that state the composer's own submit key already lands it, and a
        // literal ⏎ here would be eaten at the menu bar instead of inserting a
        // newline for anyone whose submit key is ⇧⏎.
        let toggleChangesItem = NSMenuItem(title: "Show Session Changes", action: #selector(toggleShadeView(_:)), keyEquivalent: "c", modifierMask: [.command, .control]).identified("session.toggleChanges")
        toggleChangesItem.representedObject = "changes"
        sessionMenu.addItem(toggleChangesItem)
        sessionMenu.addItem(sessionCommandItem("Commit Changes", "commit", "session.commit"))
        sessionMenu.addItem(sessionCommandItem("Show Project Diff", "diff", "session.diff"))
        let toggleHistoryItem = NSMenuItem(title: "Show Commit History", action: #selector(toggleShadeView(_:)), keyEquivalent: "h", modifierMask: [.command, .control]).identified("session.toggleHistory")
        toggleHistoryItem.representedObject = "history"
        sessionMenu.addItem(toggleHistoryItem)
        sessionMenu.addItem(NSMenuItem.separator())

        sessionMenu.addItem(sessionCommandItem("Resume Session…", "resume", "session.resume"))
        sessionMenu.addItem(sessionCommandItem("Rename Session…", "rename", "session.rename"))
        sessionMenu.addItem(sessionCommandItem("Clear Session", "clear", "session.new"))
        sessionMenu.addItem(NSMenuItem.separator())

        // One door for model, reasoning effort, and permission mode — and a
        // state display: the registry gate pushes a live title, so this item
        // reads `AI: Fable 5 · High · Auto…` and the menu says what the AI is
        // set to. The static title here is the pre-push fallback.
        sessionMenu.addItem(sessionCommandItem("AI…", "ai", "session.ai"))
        // ⌃⌥⌘P — the advanced form of a Tug-tier command
        // (tuglaws/chord-tiers.md); the composer's Prompt route holds ⌃⌘P.
        // This menu item has to carry the same chord as the tugdeck binding
        // or it keeps swallowing it at the menu bar before the web view ever
        // sees it. It keeps a visible home now that the submenu is gone: a
        // chord without a menu item is not discoverable.
        sessionMenu.addItem(NSMenuItem(title: "Cycle Permission Mode", action: #selector(cyclePermissionModeFromMenu(_:)), keyEquivalent: "p", modifierMask: [.command, .control, .option]).identified("session.permissionMode.cycle"))
        // The tool-permission RULES editor — a different surface from the AI
        // mixer, so it keeps its own row.
        sessionMenu.addItem(sessionCommandItem("Permission Rules…", "permissions", "session.permissionRules"))
        sessionMenu.addItem(sessionCommandItem("Add Working Directory…", "add-dir", "session.addDir"))
        sessionMenu.addItem(NSMenuItem.separator())
        sessionMenu.addItem(sessionCommandItem("Rewind…", "rewind", "session.rewind"))
        sessionMenu.addItem(sessionCommandItem("Compact Conversation", "compact", "session.compact"))
        sessionMenu.addItem(NSMenuItem.separator())
        sessionMenu.addItem(sessionCommandItem("Show Context", "context", "session.context"))
        sessionMenu.addItem(sessionCommandItem("Show Usage", "usage", "session.usage"))

        // Configure ▸ — the four project/session configuration surfaces, each a
        // viewer over what this session is working with.
        let configureItem = NSMenuItem(title: "Configure", action: nil, keyEquivalent: "").identified("session.configure")
        let configureMenu = NSMenu(title: "Configure")
        configureItem.submenu = configureMenu
        configureMenu.addItem(sessionCommandItem("Skills…", "skills", "session.skills"))
        configureMenu.addItem(sessionCommandItem("Agents…", "agents", "session.agents"))
        configureMenu.addItem(sessionCommandItem("Hooks…", "hooks", "session.hooks"))
        configureMenu.addItem(sessionCommandItem("Memory…", "memory", "session.memory"))
        sessionMenu.addItem(configureItem)

        // View Menu - position 4.
        // Appearance and page zoom; rebuilt on every open in
        // menuNeedsUpdate (theme submenu + zoom enablement).
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let vMenu = NSMenu(title: "View")
        vMenu.delegate = self
        viewMenuItem.submenu = vMenu
        self.viewMenu = vMenu

        // Theme submenu — populated dynamically via NSMenuDelegate. The
        // NSMenu instance persists across View-menu rebuilds; each rebuild
        // wraps it in a fresh parent item.
        let dynamicThemeMenu = NSMenu(title: "Theme")
        dynamicThemeMenu.delegate = self
        self.themeMenu = dynamicThemeMenu

        // Window Menu - position 5. Static items are built once here and
        // never touched by the delegate; only the dynamic `window.pane.*`
        // slice (between paneListAnchor and the following separator) churns
        // in menuNeedsUpdate. NSApp.windowsMenu keeps AppKit's automatic
        // window entries at the menu tail — never removeAllItems() here.
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let wMenu = NSMenu(title: "Window")
        wMenu.delegate = self
        windowMenuItem.submenu = wMenu
        self.windowMenu = wMenu
        wMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m").identified("window.minimize"))
        wMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "").identified("window.zoom"))
        wMenu.addItem(NSMenuItem.separator())
        // Card navigation — one relationship, two axes. Previous/Next Card
        // walk the deck's visible cards side to side (every tab of every
        // front pane, one ring); Previous/Next Card in Stack rotate the
        // focused pane's slot stack front to back. The chords say the same
        // thing: ⇧⌘[/] for the lateral pair (macOS tab convention), ⌥⌘[/]
        // for the depth pair — ⌥ as the variant operator, same keys, other
        // axis. All four are chain round-trips for chords AppKit swallows
        // at the menu bar.
        wMenu.addItem(NSMenuItem(title: "Previous Card", action: #selector(previousCard(_:)), keyEquivalent: "[", modifierMask: [.command, .shift]).identified("window.previousCard"))
        wMenu.addItem(NSMenuItem(title: "Next Card", action: #selector(nextCard(_:)), keyEquivalent: "]", modifierMask: [.command, .shift]).identified("window.nextCard"))
        wMenu.addItem(NSMenuItem(title: "Previous Card in Stack", action: #selector(previousCardInStack(_:)), keyEquivalent: "[", modifierMask: [.command, .option]).identified("window.previousCardInStack"))
        wMenu.addItem(NSMenuItem(title: "Next Card in Stack", action: #selector(nextCardInStack(_:)), keyEquivalent: "]", modifierMask: [.command, .option]).identified("window.nextCardInStack"))
        // Reveal Stack is the depth pair's readable counterpart: it opens
        // the focused pane's picker to be read before choosing, where the
        // pair switches without looking. ⌘R rides the JS keymap sweep, and
        // detaches when the stack has nowhere to go.
        wMenu.addItem(NSMenuItem(title: "Reveal Stack", action: #selector(revealStack(_:)), keyEquivalent: "").identified("window.revealStack"))
        wMenu.addItem(NSMenuItem.separator())
        // The column family — how the panes standing in one slot arrange
        // themselves, and where this card stands among them. Its own group
        // directly after the card-navigation rows because moving a card among
        // the panes of a place is the same kind of act as choosing one.
        //
        // ⌃⌘S and the ⌃⌘ arrows, all with EMPTY key equivalents for the same
        // reason the width rows have them — `applyCommandChords` writes them
        // from the frontend's keymap, so the whole family stays rebindable.
        // Their gates hold the chord while the item is dark
        // (`disabledChord: "keep"`): nothing in the JS funnel wants these
        // chords, so there is nothing for a release to hand them back to, and
        // the beep is honest feedback that the column had no move to make.
        //
        // Every one of them is selection-relative — the frontend resolves the
        // Lens selection, else the Cards list's cursor, else the first
        // responder — so the move target is all the payload there is.
        wMenu.addItem(NSMenuItem(title: "Split or Stack Column", action: #selector(toggleColumnSplit(_:)), keyEquivalent: "").identified("window.columnSplit"))
        for (title, where_, id) in [
            ("Move Card Up in Column", "up", "window.columnMoveUp"),
            ("Move Card Down in Column", "down", "window.columnMoveDown"),
            ("Move Card to Top of Column", "top", "window.columnMoveTop"),
            ("Move Card to Bottom of Column", "bottom", "window.columnMoveBottom"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(moveInColumnFromMenu(_:)), keyEquivalent: "").identified(id)
            item.representedObject = where_
            wMenu.addItem(item)
        }
        wMenu.addItem(NSMenuItem.separator())
        // Bullseye — the focused card's POSTURE rather than its size: a
        // temporary reading stance, centred in the band at comfy with every
        // other surface receded, reversible by pressing again. Its own group
        // because the width rows below set a number that persists and this
        // sets a stance that does not. ⌃⌘B, same Tug tier as the width row,
        // and the key equivalent is left EMPTY for the same reason theirs
        // are — `applyCommandChords` writes it from the frontend's keymap, so
        // it stays rebindable end to end.
        wMenu.addItem(NSMenuItem(title: "Bullseye", action: #selector(toggleBullseye(_:)), keyEquivalent: "").identified("window.bullseye"))
        wMenu.addItem(NSMenuItem.separator())
        // Go to Slot 1…6 — take the reader to that slot: the band travels to
        // put it as near the middle as the strip allows, which at either end
        // is flush against it. The digit row's other reading: ⌘n sends the
        // card to a place,
        // ⌃⌘n sends the reader to one, and nothing in the arrangement moves.
        // Six rows because six-up is the largest arrangement; each is dark
        // under fit and dark past the current kind's slot count, both gated by
        // its registry entry on the menuState push.
        for n in 1...6 {
            let item = NSMenuItem(title: "Go to Slot \(n)", action: #selector(goToSlotFromMenu(_:)), keyEquivalent: "").identified("window.goToSlot.\(n)")
            item.representedObject = n
            wMenu.addItem(item)
        }
        wMenu.addItem(NSMenuItem.separator())
        // Card width — the focused card's own width, as one of the three
        // named presets, check-marked like the title bar's width popup it
        // duplicates. No key equivalents: the ⌃⌘ digits these held went to
        // Go to Slot, a verb of the reading hour, where a width is set once
        // and read at. Construction still leaves them EMPTY rather than
        // absent, because `applyCommandChords` writes whatever the frontend's
        // keymap says — so a user who binds them in the keymap pane gets the
        // rows marked without a change here.
        for (title, preset) in [("Slim", "slim"), ("Comfy", "comfy"), ("Wide", "wide")] {
            let item = NSMenuItem(title: title, action: #selector(setCardWidthFromMenu(_:)), keyEquivalent: "").identified("window.cardWidth.\(preset)")
            item.representedObject = preset
            wMenu.addItem(item)
        }
        // Anchor separator for the dynamic pane-list slice: pane items are
        // inserted directly after it (and removed by identifier prefix) on
        // every menu open. macOS hides the redundant separator pair when
        // the slice is empty.
        let paneAnchor = NSMenuItem.separator()
        self.windowPaneListAnchor = paneAnchor
        wMenu.addItem(paneAnchor)
        wMenu.addItem(NSMenuItem.separator())
        wMenu.addItem(NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f", modifierMask: [.command, .control]).identified("window.enterFullScreen"))
        wMenu.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "").identified("window.bringAllToFront"))
        NSApp.windowsMenu = wMenu

        // Maker Menu - position 6. Tooling for makers *of* the app —
        // "session" stays free to mean the Session card's domain. Hidden (not
        // disabled) behind the maker-mode gate: a *mode*, not a focus
        // state, so hide-on-gate is the right shape here.
        makerMenu = NSMenuItem()
        mainMenu.addItem(makerMenu)
        let mMenu = NSMenu(title: "Maker")
        makerMenu.submenu = mMenu
        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reload(_:)), keyEquivalent: "r", modifierMask: [.command, .shift]).identified("maker.reload")
        reloadItem.target = self
        mMenu.addItem(reloadItem)
        mMenu.addItem(NSMenuItem.separator())
        // Show DevTools (⌥⌘/) — the frontend's own inspector card. Chord left
        // to the registry's sweep, like the Session items. Placing it in the
        // Maker menu is also what keeps the chord working outside maker mode:
        // the menu is hidden then, and a hidden menu's key equivalents fall
        // through to the web view.
        mMenu.addItem(NSMenuItem(title: "Show DevTools", action: #selector(showDevTools(_:)), keyEquivalent: "").identified("maker.devTools"))
        mMenu.addItem(NSMenuItem(title: "Focus Lens", action: #selector(focusLens(_:)), keyEquivalent: "l").identified("maker.focusLens"))
        // Show Lens (⌃⌘L), Show Jots (⌃⌘J), and Show Overview (⌃⌘O) — the
        // sidebar toggles, built without key equivalents so the registry's
        // sweep supplies them and each stays rebindable. Same Maker-menu
        // placement reasoning as Show DevTools above: hidden outside maker
        // mode, so the chords fall through to the web view there.
        mMenu.addItem(NSMenuItem(title: "Show Lens", action: #selector(showLens(_:)), keyEquivalent: "").identified("maker.lens"))
        mMenu.addItem(NSMenuItem(title: "Show Jots", action: #selector(showJots(_:)), keyEquivalent: "").identified("maker.jots"))
        mMenu.addItem(NSMenuItem(title: "Show Overview", action: #selector(showOverview(_:)), keyEquivalent: "").identified("maker.overview"))
        if BuildInfo.profile == "debug" {
            // Debug-only card creators, relocated from the flattened
            // File ▸ New submenu. Compile-time gated so release bundles
            // never expose the gallery + hello-world creation surfaces.
            mMenu.addItem(NSMenuItem.separator())
            mMenu.addItem(NSMenuItem(title: "New Component Gallery Card", action: #selector(newComponentGalleryCard(_:)), keyEquivalent: "g", modifierMask: [.command, .option]).identified("maker.galleryCard"))
            mMenu.addItem(NSMenuItem(title: "New Hello World Card", action: #selector(newHelloWorldCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option, .shift]).identified("maker.helloCard"))
            // The Spikes index. No key equivalent: ⌥⌘G and ⌥⌘⇧N are taken,
            // and a chord for the design sandbox is not worth a tier.
            mMenu.addItem(NSMenuItem(title: "New Spikes Card", action: #selector(newSpikesCard(_:)), keyEquivalent: "").identified("maker.spikesCard"))
            // New Card in Active Pane (⌘T): the tab-creation chord.
            // Validated against deck state (needs a pane to add to).
            mMenu.addItem(NSMenuItem(title: "New Card in Active Pane", action: #selector(addCardToActivePane(_:)), keyEquivalent: "t").identified("maker.newCardInPane"))
        }
        mMenu.addItem(NSMenuItem.separator())
        mMenu.addItem(NSMenuItem(title: "Source Tree...", action: #selector(sourceTree(_:)), keyEquivalent: "").identified("maker.sourceTree"))
        makerMenu.isHidden = !makerModeEnabled

        // Help Menu - position 7
        let helpMenuItem = NSMenuItem()
        mainMenu.addItem(helpMenuItem)
        let helpMenu = NSMenu(title: "Help")
        helpMenuItem.submenu = helpMenu
        // Keyboard Shortcuts & Commands — the session card's `/help` sheet via
        // run-card-command. Gated by its registry gate on the menuState push.
        let shortcutsItem = NSMenuItem(title: "Keyboard Shortcuts & Commands", action: #selector(runCardCommand(_:)), keyEquivalent: "").identified("help.shortcuts")
        shortcutsItem.representedObject = "help"
        helpMenu.addItem(shortcutsItem)
        helpMenu.addItem(NSMenuItem.separator())
        helpMenu.addItem(NSMenuItem(title: "Project Home", action: #selector(openProjectHome(_:)), keyEquivalent: "").identified("help.projectHome"))
        helpMenu.addItem(NSMenuItem(title: "GitHub", action: #selector(openGitHub(_:)), keyEquivalent: "").identified("help.github"))
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Actions

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
        updateController.checkForUpdates()
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

    @objc private func selectTheme(_ sender: NSMenuItem) {
        let name = sender.representedObject as? String ?? sender.title
        activeThemeName = name
        sendControl("set-theme", params: ["theme": name])
    }

    @objc func openProjectHome(_ sender: Any?) {
        if let url = URL(string: "https://tugtool.dev") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openGitHub(_ sender: Any?) {
        if let url = URL(string: "https://github.com/tugtool/tugtool") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func reload(_ sender: Any) {
        sendControl("reload")
    }

    /// Toggle the Lens — the persistent right-edge rail in tugdeck.
    /// Routes through the standard `sendControl` channel so tugdeck's
    /// action-dispatch picks it up the same way other menu-driven RPCs do.
    @objc private func showLens(_ sender: Any) {
        sendControl("toggle-lens")
    }

    /// Show or hide the Jots rail — the Lens toggle's sibling.
    @objc private func showJots(_ sender: Any) {
        sendControl("toggle-jots")
    }

    /// Show or hide the Overview rail — the third of the sidebar toggles.
    @objc private func showOverview(_ sender: Any) {
        sendControl("toggle-overview")
    }

    /// Create a jot and land the caret in it, revealing the Jots rail if it is
    /// hidden. Focus goes to the web view first: ⌘J fires as a menu key
    /// equivalent even when the native title bar holds focus, where the new
    /// row's caret claim would otherwise be invisible.
    @objc private func newJot(_ sender: Any) {
        window.focusWebView()
        sendControl("new-jot")
    }

    /// Move keyboard focus into the Lens (opening it if hidden), or back out
    /// if it already holds focus. ⌘L is a menu key equivalent so it fires
    /// whenever the app is active — even when the native title bar (not the
    /// web view) holds focus, where a web-level ⌘L keybinding never sees the
    /// event. Mirrors tugdeck's ⌘L `focus-lens` keybinding for browser-dev.
    @objc private func focusLens(_ sender: Any) {
        // Land OS keyboard focus in the web view first — ⌘L fires as a menu key
        // equivalent even when the native title bar holds focus, where a DOM
        // focus change alone would be invisible (the keyboard would still be
        // aimed at the title bar).
        window.focusWebView()
        sendControl("focus-lens")
    }

    // The zoom commands go to the frontmost document surface when there is
    // one and scale the whole web view otherwise. The branch lives at
    // invocation rather than at menu-build time because a key equivalent
    // fires the selector without rebuilding the menu.

    @objc private func actualSize(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-actual")
            return
        }
        window.actualSize()
    }

    @objc private func zoomIn(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-in")
            return
        }
        window.zoomIn()
    }

    @objc private func zoomOut(_ sender: Any?) {
        if menuState.document != nil {
            sendControl("zoom-out")
            return
        }
        window.zoomOut()
    }

    @objc private func focusPaneFromMenu(_ sender: NSMenuItem) {
        guard let paneId = sender.representedObject as? String else { return }
        sendControl("focus-pane", params: ["paneId": paneId])
    }

    @objc private func newComponentGalleryCard(_ sender: Any?) {
        sendControl("show-component-gallery")
    }

    @objc private func newHelloWorldCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "hello"])
    }

    @objc private func newSpikesCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "spike-home"])
    }

    @objc private func newSessionCard(_ sender: Any) {
        sendControl("show-card", params: ["component": "session"])
    }

    @objc private func openFileInEditor(_ sender: Any) {
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

    @objc private func openQuickly(_ sender: Any) {
        sendControl("open-quickly")
    }

    @objc private func openRecentDocument(_ sender: Any) {
        guard let item = sender as? NSMenuItem,
              let path = item.representedObject as? String else { return }
        sendControl("open-file", params: ["path": path])
    }

    @objc private func clearRecentDocuments(_ sender: Any) {
        sendControl("clear-recent-documents")
    }

    @objc private func saveActiveEditor(_ sender: Any) {
        // Bare chain-action name "save" (Both-category identity action,
        // same convention as "close").
        sendControl("save")
    }

    @objc private func saveAsActiveEditor(_ sender: Any) {
        sendControl("save-as")
    }

    @objc private func saveACopyActiveEditor(_ sender: Any) {
        sendControl("save-a-copy")
    }

    @objc private func revertActiveEditor(_ sender: Any) {
        sendControl("revert-to-saved")
    }

    @objc private func reloadActiveEditor(_ sender: Any) {
        sendControl("reload-from-disk")
    }

    @objc private func newTextCard(_ sender: Any) {
        sendControl("new-text-card")
    }

    @objc private func nextTheme(_ sender: Any) {
        sendControl("next-theme")
    }

    @objc private func addCardToActivePane(_ sender: Any) {
        sendControl("add-card-to-active-pane")
    }

    @objc private func closeActiveCard(_ sender: Any) {
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

    @objc private func closeAllCardTabs(_ sender: Any) {
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
    @objc private func runCardCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        sendControl("run-card-command", params: ["name": name])
    }

    // Session menu actions.

    @objc private func focusPrompt(_ sender: Any?) {
        sendControl("focus-prompt")
    }

    @objc private func stopSession(_ sender: Any?) {
        sendControl("interrupt-session")
    }

    /// Session ▸ Insert File… — choose a file and mention it in the focused
    /// prompt entry. Unlike Open File…, no content types are declared: a
    /// prompt may name any file, and the panel is picking a path to talk
    /// about rather than a document this app has to render. The frame is
    /// dispatched first-responder in tugdeck, so the composer that holds
    /// focus is the one that receives the path.
    @objc private func insertFile(_ sender: Any?) {
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
    @objc private func previousTurn(_ sender: Any?) {
        sendControl("previous-turn")
    }

    @objc private func nextTurn(_ sender: Any?) {
        sendControl("next-turn")
    }

    @objc private func firstTurn(_ sender: Any?) {
        sendControl("first-turn")
    }

    @objc private func lastTurn(_ sender: Any?) {
        sendControl("last-turn")
    }

    @objc private func openCommandPicker(_ sender: Any?) {
        sendControl("open-command-picker")
    }

    @objc private func keyboardFocus(_ sender: Any?) {
        sendControl("cycle-focus-mode")
    }

    @objc private func nextKeyboardFocus(_ sender: Any?) {
        sendControl("next-keyboard-focus")
    }

    @objc private func previousKeyboardFocus(_ sender: Any?) {
        sendControl("previous-keyboard-focus")
    }

    @objc private func showDevTools(_ sender: Any?) {
        sendControl("show-devtools")
    }

    @objc private func cyclePermissionModeFromMenu(_ sender: Any?) {
        sendControl("cycle-permission-mode")
    }

    /// Show/Hide Changes / History ([P05], Spec S04). The represented view name
    /// selects the control frame; tugdeck's card-content responder toggles the
    /// matching Shade.
    @objc private func toggleShadeView(_ sender: NSMenuItem) {
        guard let view = sender.representedObject as? String else { return }
        sendControl(view == "history" ? "toggle-history-view" : "toggle-changes-view")
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
    @objc private func performUndo(_ sender: Any?) {
        if menuState.edit.nativeUndoToken != 0 {
            NSApp.sendAction(Selector(("undo:")), to: nil, from: sender)
        } else {
            sendControl("undo")
        }
    }

    @objc private func performRedo(_ sender: Any?) {
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
    @objc private func performCut(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: sender)
    }

    @objc private func performCopy(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: sender)
    }

    @objc private func performPaste(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: sender)
    }

    // Edit ▸ Copy as Plain Text — a chain-action round-trip. Unlike Copy,
    // this does NOT re-dispatch NSText.copy: the Markdown-strip transform
    // lives in the web responder chain, which writes the plain text to the
    // clipboard. An unhandled dispatch is a silent no-op (no selection).
    @objc private func performCopyAsPlainText(_ sender: Any?) {
        sendControl("copy-as-plain-text")
    }

    @objc private func performDelete(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.delete(_:)), to: nil, from: sender)
    }

    @objc private func performSelectAll(_ sender: Any?) {
        NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: sender)
    }

    // Edit ▸ Paste as Quote / Paste as Plain Text — chain-action
    // round-trips. Unlike Cut/Copy/Paste, these do NOT re-dispatch a
    // native NSText selector: the transform (blockquote wrap / Markdown
    // strip) lives in the web responder chain, which reads the clipboard
    // via the native bridge before inserting. An unhandled dispatch is a
    // silent no-op (no editable surface focused).
    @objc private func performPasteAsQuote(_ sender: Any?) {
        sendControl("paste-as-quote")
    }

    @objc private func performPasteAsPlainText(_ sender: Any?) {
        sendControl("paste-as-plain-text")
    }

    // Edit ▸ Make Uppercase / Make Lowercase — chain-action round-trips.
    // The case transform is applied to the focused surface's selection by
    // the web responder chain; an unhandled dispatch is a silent no-op (no
    // editable surface focused, or nothing selected).
    @objc private func performMakeUppercase(_ sender: Any?) {
        sendControl("make-uppercase")
    }

    @objc private func performMakeLowercase(_ sender: Any?) {
        sendControl("make-lowercase")
    }

    // Edit ▸ Find — chain-action round-trips (the web responder chain's
    // find session owns the semantics; an unhandled dispatch is a no-op).
    @objc private func performFind(_ sender: Any?) {
        sendControl("find")
    }

    @objc private func performFindNext(_ sender: Any?) {
        sendControl("find-next")
    }

    @objc private func performFindPrevious(_ sender: Any?) {
        sendControl("find-previous")
    }

    @objc private func performFindSelection(_ sender: Any?) {
        sendControl("find-selection")
    }

    // Window ▸ card / pane navigation — chain-action round-trips for the
    // chords the menu bar now swallows.
    @objc private func previousCard(_ sender: Any?) {
        sendControl("previous-tab")
    }

    @objc private func nextCard(_ sender: Any?) {
        sendControl("next-tab")
    }

    @objc private func revealStack(_ sender: Any) {
        sendControl("reveal-stack")
    }

    @objc private func previousCardInStack(_ sender: Any?) {
        sendControl("previous-stack-card")
    }

    @objc private func nextCardInStack(_ sender: Any?) {
        sendControl("next-stack-card")
    }

    /// Window ▸ Slim / Comfy / Wide. The preset rides `representedObject`;
    /// enablement and the check mark ride each item's registry gate on the
    /// menuState push, exactly as the Permission Mode radio group does.
    @objc private func setCardWidthFromMenu(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        sendControl("set-pane-width", params: ["preset": preset])
    }

    /// Window ▸ Go to Slot N. The slot number rides `representedObject`.
    /// Unlike every other item in this group it is NOT selection-relative —
    /// centering moves the band, not a card — so the payload is the whole
    /// question and the frontend resolves nothing. Enablement rides the item's
    /// registry gate on the menuState push: dark under fit, and dark for a
    /// slot the current arrangement does not have.
    @objc private func goToSlotFromMenu(_ sender: NSMenuItem) {
        guard let slot = sender.representedObject as? Int else { return }
        sendControl("go-to-slot", params: ["value": slot])
    }

    /// Window ▸ Bullseye. No payload — the command is selection-relative, and
    /// the frontend's deck canvas is the one responder that can name which
    /// pane the selection is in. The check mark and the enablement both ride
    /// this item's registry gate on the menuState push, so the mark can never
    /// disagree with what the deck is actually showing.
    @objc private func toggleBullseye(_ sender: Any?) {
        sendControl("toggle-bullseye")
    }

    /// Window ▸ Split or Stack Column. No payload, for the same reason
    /// Bullseye carries none: which slot divides is the frontend's answer, and
    /// it resolves it from the layout selection the chord resolves too.
    @objc private func toggleColumnSplit(_ sender: Any?) {
        sendControl("toggle-column-split")
    }

    /// Window ▸ Move Card Up / Down / to Top / to Bottom of Column. The target
    /// rides `representedObject`; which card travels is again the frontend's
    /// answer. Enablement rides each item's registry gate on the menuState
    /// push, so an item is dark exactly when `moveInColumn` would refuse.
    @objc private func moveInColumnFromMenu(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        sendControl("move-in-column", params: ["value": target])
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
    private func applyCommandChords(in menu: NSMenu? = nil) {
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

    @objc private func sourceTree(_ sender: Any) {
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
    private func updateDevInfoOverlay() {
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

    /// Replace the cached menu state from the frontend (called by
    /// MainWindow on every `menuState` message).
    func updateMenuState(_ payload: [String: Any]) {
        let previousToken = menuState.edit.nativeUndoToken
        menuState = MenuState(payload: payload)

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
        if let openRecentMenu { rebuildOpenRecentMenu(openRecentMenu) }

        // Every chord the frontend states, written across the whole tree.
        // Here — outside AppKit's key-equivalent scan — and never in
        // validateMenuItem.
        applyCommandChords()
    }

    /// Tolerance for page-zoom bound comparisons. Stepping by 0.1 accumulates
    /// IEEE rounding error, so the Zoom In / Zoom Out / Actual Size gates
    /// compare against the bounds with this slack.
    private let pageZoomEpsilon: CGFloat = 0.005

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
            if let on = gate.state { menuItem.state = on ? .on : .off }
            if let enabled = gate.enabled { return enabled }
        }

        switch id {
        // App tier. About, Settings, and Keyboard Shortcuts each open a card,
        // so all three need a deck to open it into — dark until the frontend
        // has signalled ready.
        case "app.about", "app.settings", "app.keyboardShortcuts":
            return frontendReady
        // View zoom. Reads `window.currentPageZoom` live rather than the
        // pushed state: page zoom is the host's own property, changed by
        // these very commands, and the read is a synchronous accessor so it
        // is safe inside the validator.
        //
        // A document surface owns its own zoom range, which the host cannot
        // see, so the page-zoom bounds stop being the right gate while one is
        // frontmost — the items stay live and the surface clamps.
        //
        // Floating-point tolerance: stepping by 0.1 accumulates IEEE rounding
        // error (0.6000000000000001 etc.), so the bound comparisons carry a
        // small epsilon to avoid spurious disables right at the limits.
        case "view.actualSize":
            if menuState.document != nil { return true }
            return abs(window.currentPageZoom - MainWindow.defaultPageZoom) > pageZoomEpsilon
        case "view.zoomIn", "view.zoomInAlias":
            if menuState.document != nil { return true }
            return window.currentPageZoom < MainWindow.maxPageZoom - pageZoomEpsilon
        case "view.zoomOut":
            if menuState.document != nil { return true }
            return window.currentPageZoom > MainWindow.minPageZoom + pageZoomEpsilon
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

// MARK: - BridgeDelegate

extension AppDelegate: BridgeDelegate {
    func bridgeChooseSourceTree(completion: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose the tugtool mono-repo root directory"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                completion(nil)
                return
            }
            if !TugConfig.isValidSourceTree(url) {
                let markers = TugConfig.sourceTreeMarkers.joined(separator: "\n  ")
                let alert = NSAlert()
                alert.messageText = "Invalid Source Tree"
                alert.informativeText = "The selected directory is not a tugtool repo.\nExpected to find:\n  \(markers)"
                alert.alertStyle = .warning
                alert.runModal()
                completion(nil)
                return
            }
            self.sourceTreePath = url.path
            self.savePreferences()
            self.updateDevInfoOverlay()
            // Re-send dev_mode if serving is already enabled (per D12)
            if self.devServingEnabled {
                self.processManager.sendDevMode(enabled: true, sourceTree: url.path, vitePort: self.vitePort)
            }
            completion(url.path)
        }
    }

    func bridgeChoosePath(kind: String, initialPath: String?, suggestedName: String?, completion: @escaping (String?) -> Void) {
        // `save` kind: an NSSavePanel choosing a NEW file path (the File
        // card's Move To… / Save As…). The panel returns the path only —
        // the web layer performs the write through its own fs surface.
        if kind == "save" {
            let panel = NSSavePanel()
            panel.message = "Choose where to save the file"
            panel.prompt = "Save"
            if let initialPath = initialPath, !initialPath.isEmpty {
                let resolved = (initialPath as NSString).expandingTildeInPath
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: resolved, isDirectory: &isDir), isDir.boolValue {
                    panel.directoryURL = URL(fileURLWithPath: resolved)
                } else {
                    panel.nameFieldStringValue = (resolved as NSString).lastPathComponent
                    panel.directoryURL = URL(fileURLWithPath: resolved).deletingLastPathComponent()
                }
            } else if let sourceTree = ProcessManager.readTugbank(
                domain: TugConfig.domain, key: TugConfig.keySourceTreePath
            ), !sourceTree.isEmpty {
                // No hint (an untitled buffer): default to the project root,
                // not the OS default (Desktop).
                panel.directoryURL = URL(fileURLWithPath: sourceTree)
            }
            // Pre-fill the untitled buffer's session name ("Untitled-2") when
            // no path hint set one.
            if panel.nameFieldStringValue.isEmpty,
               let suggestedName = suggestedName, !suggestedName.isEmpty {
                panel.nameFieldStringValue = suggestedName
            }
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else {
                    completion(nil)
                    return
                }
                completion(url.path)
            }
            return
        }
        let wantFile = kind == "file"
        let panel = NSOpenPanel()
        panel.canChooseFiles = wantFile
        // Directories are always navigable; in directory mode they're also the
        // selectable result. In file mode the user descends dirs to pick a file.
        panel.canChooseDirectories = !wantFile
        panel.allowsMultipleSelection = false
        panel.message = wantFile ? "Choose a file" : "Choose a directory"
        panel.prompt = "Choose"
        // This chooser feeds text contexts only, so it stays restricted to
        // text UTIs even though Tug can now view images and PDFs elsewhere.
        if wantFile {
            panel.allowedContentTypes = AppDelegate.editableContentTypes
        }
        if let initialPath = initialPath, !initialPath.isEmpty {
            var isDir: ObjCBool = false
            let resolved = (initialPath as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: resolved, isDirectory: &isDir), isDir.boolValue {
                panel.directoryURL = URL(fileURLWithPath: resolved)
            }
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                completion(nil)
                return
            }
            completion(url.path)
        }
    }

    func bridgeGetSettings(completion: @escaping (Bool, String?) -> Void) {
        completion(makerModeEnabled, sourceTreePath)
    }


    func bridgeFrontendReady() {
        DispatchQueue.main.async {
            self.frontendReady = true

            // Open any files the OS handed us before the deck was live
            // (cold launch by dropping a file on the icon). Control frames
            // reach the renderer now that frontendReady has fired.
            self.flushPendingOpenPaths()

            // An update Sparkle found before the deck was live — the
            // scheduled check can land during launch.
            self.flushPendingUpdateNotice()

            // Current VoiceOver state, on mount and on every reconnect —
            // the frontend's keyboard-access mode converges without
            // waiting for a toggle.
            self.sendVoiceOverState()

            // First frontendReady is the initial mount — no replay
            // needed (the OS hasn't told tugdeck anything that needs
            // re-asserting yet) and the WebView is already painted by
            // `revealWebView` upstream.
            if !self.frontendHasLoadedOnce {
                self.frontendHasLoadedOnce = true
                return
            }

            // Subsequent frontendReady fires are post-reconnect
            // resyncs: tugcast went away, came back, tugdeck's
            // WebSocket re-handshook, and `signalReady()` fired
            // again. By this moment the WebSocket is open and
            // tugdeck is subscribed to CONTROL — so control frames
            // sent here actually reach the renderer (unlike
            // frames sent from `processManager.onReady`, which
            // would be dispatched into a tugcast broadcast with
            // no live subscribers and silently dropped).
            //
            // Replay the current OS-level app-lifecycle state.
            // Lifecycle frames sent during the outage hit the
            // cleared `controlConnection` early-return and were
            // dropped, so the tugdeck-side `AppLifecycle`
            // singleton holds whatever it last saw before the
            // close — possibly out of sync with the OS.
            // Replay re-asserts current truth.
            self.replayLifecycleState()
        }
    }

    func bridgeDevModeError(message: String) {
        window.bridgeDevModeError(message: message)
    }

    func bridgeSetTheme(color: String) {
        ProcessManager.writeTugbank(domain: TugConfig.domain, key: TugConfig.keyWindowBackground, value: color)
        window.updateBackgroundColor(color)
    }

    func bridgeDevBadge(backend: Bool, app: Bool) {
        // Restart Server and Relaunch App items removed; badge logic is a no-op.
        _ = backend
        _ = app
    }

    func bridgePageDidLoad() {
        lastLoadTime = Date()
        updateDevInfoOverlay()
    }

    func bridgeHmrUpdate() {
        lastLoadTime = Date()
        updateDevInfoOverlay()
    }
}

// MARK: - NSMenuDelegate (dynamic View + Theme menus)

extension AppDelegate: NSMenuDelegate {
    /// Menu rebuilds are the sweep's second writer.
    ///
    /// Every rebuild below reconstructs its items from construction-time
    /// `keyEquivalent` literals, and `updateMenuState` only fires when the
    /// frontend's serialized projection changes — so a rebuild that happens
    /// after a rebind would restore the literal and keep it until some
    /// unrelated state change came along. Each rebuild therefore re-sweeps
    /// the menu it just rebuilt, which is why `applyCommandChords` is not
    /// single-site.
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === viewMenu {
            rebuildViewMenu(menu)
            return
        }
        if menu === windowMenu {
            rebuildWindowPaneList(menu)
            return
        }
        if menu === openRecentMenu {
            rebuildOpenRecentMenu(menu)
            return
        }
        guard menu === themeMenu else { return }
        menu.removeAllItems()

        // Which theme is current comes from the push. The web layer changes
        // the theme by paths this side never sees (keyboard Next Theme, the
        // Settings pane), so a value cached at selection time would go stale
        // — which is why this used to re-read tugbank on every open, a
        // subprocess read on the path that must finish before the menu can
        // draw. The frontend now republishes on every change instead.
        // Empty means no push has landed yet; the base theme is what the
        // frontend boots into, so the checkmark starts there rather than
        // nowhere.
        activeThemeName =
            menuState.activeTheme.isEmpty ? baseThemeName : menuState.activeTheme

        // Read theme names directly from shipped CSS files on disk, plus each
        // theme's mode from its header comment. sourceTreePath is the tugtool
        // repo root; themes are at tugdeck/styles/themes/*.css, base is "brio".
        // The header's first line carries "— dark theme" / "— light theme",
        // so the menu can group them without a separate manifest.
        var themeNames = Set<String>([baseThemeName])
        var darkThemes = Set<String>()
        if let root = sourceTreePath {
            let themesDir = (root as NSString).appendingPathComponent("tugdeck/styles/themes")
            if let files = try? FileManager.default.contentsOfDirectory(atPath: themesDir) {
                for file in files where file.hasSuffix(".css") {
                    let name = (file as NSString).deletingPathExtension
                    themeNames.insert(name)
                    let path = (themesDir as NSString).appendingPathComponent(file)
                    // Light themes are the exception; default to dark when the
                    // header is unreadable or unmarked.
                    let header = (try? String(contentsOfFile: path, encoding: .utf8))?.prefix(200) ?? ""
                    if !header.localizedCaseInsensitiveContains("light theme") {
                        darkThemes.insert(name)
                    }
                }
            }
        }

        // Group: dark themes first, then light themes. Within each group the
        // base theme sorts first, then alphabetical.
        func sortGroup(_ names: [String]) -> [String] {
            names.sorted { a, b in
                if a.lowercased() == baseThemeName { return true }
                if b.lowercased() == baseThemeName { return false }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }
        }
        let dark = sortGroup(themeNames.filter { darkThemes.contains($0) })
        let light = sortGroup(themeNames.filter { !darkThemes.contains($0) })

        func addThemeItem(_ name: String) {
            let item = NSMenuItem(title: name.capitalized, action: #selector(selectTheme(_:)), keyEquivalent: "").identified("view.theme.\(name)")
            item.representedObject = name
            item.state = (name == activeThemeName) ? .on : .off
            menu.addItem(item)
        }
        for name in dark { addThemeItem(name) }
        if !dark.isEmpty && !light.isEmpty {
            menu.addItem(NSMenuItem.separator())
        }
        for name in light { addThemeItem(name) }

        // If no themes found, show a placeholder
        if menu.items.isEmpty {
            let placeholder = NSMenuItem(title: "No themes found", action: nil, keyEquivalent: "")
            placeholder.isEnabled = false
            menu.addItem(placeholder)
        }

        // Separator + Next Theme
        menu.addItem(NSMenuItem.separator())
        let nextItem = NSMenuItem(title: "Next Theme", action: #selector(nextTheme(_:)), keyEquivalent: "t", modifierMask: [.command, .control]).identified("view.nextTheme")
        menu.addItem(nextItem)

        applyCommandChords(in: menu)
    }

    /// Rebuild the View menu: the theme submenu and page-zoom commands.
    /// Zoom enablement is not computed here — `autoenablesItems` is on, so a
    /// stored `isEnabled` is overridden by the validator's permissive
    /// default. The zoom predicates live in `validateMenuItem`, which reads
    /// `window.currentPageZoom` synchronously the same way this did.
    private func rebuildViewMenu(_ menu: NSMenu) {
        menu.removeAllItems()

        // Theme submenu — the persistent themeMenu NSMenu (its own
        // NSMenuDelegate repopulates it on open), wrapped in a fresh
        // parent item per rebuild.
        let themeMenuItem = NSMenuItem(title: "Theme", action: nil, keyEquivalent: "").identified("view.theme")
        themeMenuItem.submenu = themeMenu
        menu.addItem(themeMenuItem)

        // Zoom commands — Safari-style. Drive `webView.pageZoom` so the
        // entire page scales uniformly. `Actual Size` (⌘0) returns to
        // 100%; `Zoom In` (⌘+) / `Zoom Out` (⌘-) step in 10%
        // increments bounded at 50%–200%. The hidden ⌘= alias mirrors
        // Safari's ergonomic shortcut so users don't have to hold
        // Shift to zoom in.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Actual Size", action: #selector(actualSize(_:)), keyEquivalent: "0").identified("view.actualSize"))
        menu.addItem(NSMenuItem(title: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "+").identified("view.zoomIn"))
        // ⌘= alias for Zoom In — visible item displays ⌘+, this hidden
        // sibling accepts ⌘= (no-shift) for ergonomic parity with
        // Safari. `allowsKeyEquivalentWhenHidden` keeps the shortcut
        // live even though the item is suppressed from the visible
        // menu. Both fire the same action.
        let zoomInAliasItem = NSMenuItem(title: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=").identified("view.zoomInAlias")
        zoomInAliasItem.isHidden = true
        zoomInAliasItem.allowsKeyEquivalentWhenHidden = true
        menu.addItem(zoomInAliasItem)
        menu.addItem(NSMenuItem(title: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-").identified("view.zoomOut"))

        // Keyboard focus — the ring's two directions. Built WITHOUT key
        // equivalents and left that way: ⇥ / ⇧⇥ are what perform these, but
        // AppKit scans key equivalents before the web view sees a keydown, so a
        // literal "\t" here would confiscate Tab app-wide — above the frontend's
        // focus-walk precedence ladder, above an editor accepting a completion
        // with Tab, above every native fallback. The items are the discoverable
        // face of a chord that has to keep resolving in JS, the same bargain
        // Session ▸ Stop takes with Escape.
        menu.addItem(NSMenuItem.separator())
        // Keyboard Focus mode — the same bargain one step further. ⌥⇥ toggles
        // it, and the glyph rides the TITLE rather than `keyEquivalent`: a real
        // key equivalent would confiscate ⌥⇥ app-wide, above the frontend's
        // ladder and above the Settings ▸ Keyboard chord capture, which has to
        // be able to record ⌥⇥ itself. So the item is discoverable and the
        // chord keeps resolving in JS ([P11]).
        menu.addItem(NSMenuItem(title: "Keyboard Focus\t⌥⇥", action: #selector(keyboardFocus(_:)), keyEquivalent: "").identified("view.keyboardFocus"))
        menu.addItem(NSMenuItem(title: "Previous Keyboard Focus", action: #selector(previousKeyboardFocus(_:)), keyEquivalent: "").identified("view.previousKeyboardFocus"))
        menu.addItem(NSMenuItem(title: "Next Keyboard Focus", action: #selector(nextKeyboardFocus(_:)), keyEquivalent: "").identified("view.nextKeyboardFocus"))

        // The sweep writes `keyEquivalent` and the modifier mask only, so the
        // alias item's `allowsKeyEquivalentWhenHidden` survives it.
        applyCommandChords(in: menu)
    }

    /// Rebuild File ▸ Open Recent from the MRU, filtered to files that
    /// still exist and capped at 10. Each item carries its absolute path
    /// in `representedObject`; a trailing Clear Menu empties the list.
    /// Existence is checked here, at open time, so a since-deleted file
    /// simply doesn't appear.
    private func rebuildOpenRecentMenu(_ menu: NSMenu) {
        // On every exit path, so "each rebuild tail sweeps" holds as an
        // invariant rather than an incident of which path ran.
        defer { applyCommandChords(in: menu) }
        menu.removeAllItems()
        let fm = FileManager.default
        var shown = 0
        for path in menuState.recentDocuments {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else { continue }
            let item = NSMenuItem(
                title: (path as NSString).lastPathComponent,
                action: #selector(openRecentDocument(_:)),
                keyEquivalent: ""
            ).identified("file.openRecent.\(shown)")
            item.representedObject = path
            item.toolTip = path
            menu.addItem(item)
            shown += 1
            if shown >= 10 { break }
        }
        if shown == 0 {
            let empty = NSMenuItem(title: "No Recent Documents", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Clear Menu", action: #selector(clearRecentDocuments(_:)), keyEquivalent: "").identified("file.openRecent.clear"))
    }

    /// Refresh the Window menu's dynamic pane-list slice in place: remove
    /// exactly the `window.pane.*` items, then re-insert the current panes
    /// (checkmark on the focused one) directly after the anchor separator.
    /// Sectioned management — never a wholesale rebuild — because this menu
    /// is NSApp.windowsMenu and AppKit owns auto-added window entries in it.
    private func rebuildWindowPaneList(_ menu: NSMenu) {
        defer { applyCommandChords(in: menu) }
        for item in menu.items where item.identifier?.rawValue.hasPrefix("window.pane.") == true {
            menu.removeItem(item)
        }
        guard let anchor = windowPaneListAnchor, !menuState.panes.isEmpty else { return }
        var index = menu.index(of: anchor) + 1
        for (n, pane) in menuState.panes.enumerated() {
            // Positional identifiers: the harness addresses slots, not pane
            // ids (which are session-random).
            let item = NSMenuItem(title: pane.title, action: #selector(focusPaneFromMenu(_:)), keyEquivalent: "").identified("window.pane.\(n)")
            item.representedObject = pane.id
            item.state = pane.focused ? .on : .off
            menu.insertItem(item, at: index)
            index += 1
        }
    }
}

// Helper extension for menu items with modifier masks
extension NSMenuItem {
    convenience init(title: String, action: Selector?, keyEquivalent: String, modifierMask: NSEvent.ModifierFlags) {
        self.init(title: title, action: action, keyEquivalent: keyEquivalent)
        self.keyEquivalentModifierMask = modifierMask
    }

    /// Tag the item with its stable, namespaced introspection identifier.
    /// The test harness (`menuSnapshot` / `menuItemState`) addresses items
    /// by identifier, and `validateMenuItem(_:)` switches on it — identity
    /// never rides the (flippable, localizable) title. Returns self so
    /// build sites can tag inline.
    @discardableResult
    func identified(_ id: String) -> NSMenuItem {
        identifier = NSUserInterfaceItemIdentifier(id)
        return self
    }
}

// MARK: - MenuState

/// Menu-relevant frontend state, pushed by tugdeck's host-menu-state
/// aggregator on every menu-relevant change. Wire contract with
/// `tugdeck/src/lib/host-menu-state.ts` — keep both sides in sync.
///
/// Decoding is defensive throughout: a missing or mistyped field reads
/// as its inert value (empty list, nil block, false flag), so menu
/// validation degrades to "disabled" rather than crashing on a
/// malformed payload. Before the first push arrives (app boot,
/// pre-frontendReady) the cache is `.empty`, and `validateMenuItem`'s
/// default branch reads the empty `commands` block as cold start —
/// every identified item without an explicit case validates disabled
/// until the frontend has answered once. Migrating an item's tier out
/// of the validator therefore cannot flip its splash-screen posture
/// from disabled to enabled.
struct MenuState {
    /// One pane entry, z-order topmost first.
    struct Pane {
        let id: String
        let title: String
        let focused: Bool
    }

    /// Session-card session state; nil unless the active card is a session card.
    struct Session {
        let cardId: String
        let sessionBound: Bool
        /// The model / effort / permission-mode settings may be changed
        /// (session idle — `canSubmit`). Gates the AI item and the Cycle
        /// Permission Mode item so a change can never race a running turn,
        /// matching the disabled Z4B chip.
        ///
        /// The AI item's live TITLE does not come through here: it is composed
        /// frontend-side and arrives as the registry gate's `title`, which
        /// `validateMenuItem` already applies generically to any item.
        let canChangeSettings: Bool
    }

    /// A document surface's claim on the zoom commands; nil unless the
    /// frontmost card hosts one. The claim exists because AppKit resolves a
    /// menu key equivalent before the WKWebView sees a keydown: ⌘+ / ⌘- / ⌘0
    /// can never be handled web-side, so a surface that wants them says so
    /// here and the delegate forwards the command instead of scaling the page.
    struct Document {
        let cardId: String
    }

    /// Undo / Redo capabilities of the current first responder, projected
    /// from the web responder chain's `validateAction` (the suite's
    /// single source of truth for whether the focused surface handles an
    /// edit action). All false when nothing focused handles edits (e.g.
    /// only the Settings card up).
    ///
    /// Undo / Redo ride this block — NOT AppKit's automatic NSUndoManager
    /// validation — because the web view's undoManager is per-web-view: it
    /// accumulates the whole view's edit history and knows nothing about
    /// card activation, so a deactivated card's undo state would keep
    /// showing in the menu. The chain is card-scoped by construction;
    /// editors report their own history depth through `validateAction`,
    /// plus a menu-title noun (`undoLabel` / `redoLabel` → "Undo Typing").
    ///
    /// Native text controls take a third path: when `nativeUndoToken` is
    /// non-zero (a browser-native input/textarea is focused) the delegate
    /// validates Undo/Redo LIVE from the web view's NSUndoManager and
    /// executes the native selectors. The token changes per focused
    /// control; the delegate clears the stack on every change
    /// (`updateMenuState`), which is what keeps the per-web-view native
    /// stack card-safe.
    struct Edit {
        let undo: Bool
        let redo: Bool
        let undoLabel: String
        let redoLabel: String
        let nativeUndoToken: Int

        /// Nothing focused handles any edit action.
        static let disabled = Edit(
            undo: false, redo: false,
            undoLabel: "", redoLabel: "", nativeUndoToken: 0
        )
    }

    /// One menu item's gate, projected from the web command registry and
    /// keyed on the wire by the item's `NSUserInterfaceItemIdentifier`.
    ///
    /// The registry is the frontend's table of user-invocable commands, and
    /// every fact this struct carries is one the frontend already had to
    /// know to dispatch the command. Sending them together is what lets the
    /// validator's first tier be four lines and lets a hand-rolled case be
    /// deleted the moment its command starts publishing a gate — never both
    /// at once, so there is one definition of an item's enablement.
    /// A chord in the host's alphabet: the key-equivalent character plus the
    /// four modifier flags. The frontend performs the whole
    /// `KeyboardEvent.code` → key-equivalent conversion, so this side spells
    /// neither alphabet and only assembles the mask.
    struct ChordSpec {
        let keyEquivalent: String
        let command: Bool
        let shift: Bool
        let option: Bool
        let control: Bool

        var modifierMask: NSEvent.ModifierFlags {
            var mask: NSEvent.ModifierFlags = []
            if command { mask.insert(.command) }
            if shift { mask.insert(.shift) }
            if option { mask.insert(.option) }
            if control { mask.insert(.control) }
            return mask
        }
    }

    struct CommandGate {
        /// nil means the command states no opinion on enablement and the
        /// hand-rolled tier below still owns the item. A gate can carry a
        /// chord and nothing else: View ▸ Zoom In takes its chord from the
        /// registry while its predicate stays here, because it reads
        /// `window.currentPageZoom` — host state the frontend cannot see.
        let enabled: Bool?
        /// Checkmark; nil means the item does not participate in the check
        /// column, and its state is left as constructed.
        let state: Bool?
        /// Dynamic title; nil means keep the title the menu was built with.
        let title: String?

        /// What the sweep does with this item's key equivalent. Three states,
        /// all load-bearing: `absent` is the answer for every item whose
        /// chord the frontend's table does not state (its constructed literal
        /// stands), `detach` releases the chord so it falls through to the
        /// web view, and `apply` writes one.
        enum ChordField {
            case absent
            case detach
            case apply(ChordSpec)
        }
        let chord: ChordField
    }

    var panes: [Pane] = []
    var session: Session?
    /// A frontmost surface that owns zoom for itself (the viewer card's PDF
    /// branch). Present means View ▸ Zoom In / Zoom Out / Actual Size scale
    /// that document instead of the whole web view.
    var document: Document?
    var edit: Edit = .disabled
    /// Per-item gates from the command registry, keyed by item identifier.
    /// Empty before the first push and for every item that has not moved
    /// yet — an absent gate means "ask the hand-rolled tier below".
    var commands: [String: CommandGate] = [:]
    /// Recent-document paths (newest first) for File ▸ Open Recent. The
    /// submenu delegate filters these to files that still exist.
    var recentDocuments: [String] = []
    /// The active theme's name — the Theme submenu's checkmark. The
    /// submenu's membership is still a filesystem scan (genuinely dynamic);
    /// only which one is current rides the push.
    var activeTheme: String = ""
    /// The frontend's Keyboard pane is recording a chord; the host parks
    /// every key equivalent for the span so bound chords fall through to
    /// the web view to be captured instead of firing.
    var captureArmed: Bool = false

    static let empty = MenuState()

    init() {}

    init(payload: [String: Any]) {
        captureArmed = payload["captureArmed"] as? Bool ?? false
        if let rawPanes = payload["panes"] as? [[String: Any]] {
            panes = rawPanes.compactMap { entry in
                guard let id = entry["id"] as? String else { return nil }
                return Pane(
                    id: id,
                    title: entry["title"] as? String ?? "Untitled",
                    focused: entry["focused"] as? Bool ?? false
                )
            }
        }
        if let rawSession = payload["session"] as? [String: Any],
           let cardId = rawSession["cardId"] as? String {
            session = Session(
                cardId: cardId,
                sessionBound: rawSession["sessionBound"] as? Bool ?? false,
                // Fail open: a parse miss keeps the settings items enabled
                // rather than stranding a dead AI door.
                canChangeSettings: rawSession["canChangeSettings"] as? Bool ?? true
            )
        }
        if let rawDocument = payload["document"] as? [String: Any],
           let cardId = rawDocument["cardId"] as? String {
            document = Document(cardId: cardId)
        }
        if let rawRecents = payload["recentDocuments"] as? [String] {
            recentDocuments = rawRecents
        }
        activeTheme = payload["activeTheme"] as? String ?? ""
        if let rawEdit = payload["edit"] as? [String: Any] {
            edit = Edit(
                undo: rawEdit["undo"] as? Bool ?? false,
                redo: rawEdit["redo"] as? Bool ?? false,
                undoLabel: rawEdit["undoLabel"] as? String ?? "",
                redoLabel: rawEdit["redoLabel"] as? String ?? "",
                nativeUndoToken: rawEdit["nativeUndoToken"] as? Int ?? 0
            )
        }
        if let rawCommands = payload["commands"] as? [String: Any] {
            for (itemId, rawGate) in rawCommands {
                // A gate that cannot be read at all is dropped rather than
                // defaulted: an unreadable gate is not a claim of "enabled",
                // and dropping it leaves the item on whichever tier still
                // owns it.
                guard let gate = rawGate as? [String: Any] else { continue }
                // The three chord states have to be read apart, and only the
                // key's *presence* separates the first two: a missing key is
                // "leave the item alone", while an explicit JSON null (which
                // arrives as NSNull) is "release the chord". Reading it with
                // `as? [String: Any]` alone would collapse them and turn every
                // detach into a no-op.
                let chordField: CommandGate.ChordField
                if let rawChord = gate["chord"] {
                    if let spec = rawChord as? [String: Any],
                       let keyEquivalent = spec["keyEquivalent"] as? String {
                        chordField = .apply(ChordSpec(
                            keyEquivalent: keyEquivalent,
                            command: spec["command"] as? Bool ?? false,
                            shift: spec["shift"] as? Bool ?? false,
                            option: spec["option"] as? Bool ?? false,
                            control: spec["control"] as? Bool ?? false
                        ))
                    } else {
                        // Null, or a spec too malformed to apply. Detaching is
                        // the safe reading of both: an unreadable chord must
                        // not leave a stale one standing.
                        chordField = .detach
                    }
                } else {
                    chordField = .absent
                }
                commands[itemId] = CommandGate(
                    enabled: gate["enabled"] as? Bool,
                    state: gate["state"] as? Bool,
                    title: gate["title"] as? String,
                    chord: chordField
                )
            }
        }
    }
}
