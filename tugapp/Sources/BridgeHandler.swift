import Cocoa
import UniformTypeIdentifiers

/// The window's `BridgeDelegate`: the host side of every bridge callback
/// WebKit raises.
///
/// Owned by `AppDelegate`, which hands it to the window as the window's
/// (weak) `bridgeDelegate`. The window and the process manager are held
/// weakly; everything else it reads or advances — the launch stage, the
/// preferences, the frontend-ready flags — is the delegate's state, read
/// through a weak reference to it.
final class BridgeHandler: BridgeDelegate {
    private weak var delegate: AppDelegate?
    private weak var window: MainWindow?
    private weak var processManager: ProcessManager?

    init(delegate: AppDelegate, window: MainWindow, processManager: ProcessManager) {
        self.delegate = delegate
        self.window = window
        self.processManager = processManager
    }

    func bridgeChooseSourceTree(completion: @escaping (String?) -> Void) {
        guard let window else {
            completion(nil)
            return
        }
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
            if let delegate = self.delegate {
                delegate.sourceTreePath = url.path
                delegate.savePreferences()
                delegate.updateDevInfoOverlay()
                // Re-send dev_mode if serving is already enabled (per D12)
                if delegate.devServingEnabled {
                    self.processManager?.sendDevMode(enabled: true, sourceTree: url.path, vitePort: delegate.vitePort)
                }
            }
            completion(url.path)
        }
    }

    func bridgeChoosePath(kind: String, initialPath: String?, suggestedName: String?, completion: @escaping (String?) -> Void) {
        guard let window else {
            completion(nil)
            return
        }
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
        // `insert` kind: Session ▸ Insert File…'s own panel, for the ⇧⌘I
        // chord, which the deck catches before AppKit's menu scan and so
        // reaches here instead of `insertFile(_:)`. Any file at all — a
        // prompt may name anything, and an image becomes an attachment — so
        // no content types, unlike the text-only `file` kind below.
        if kind == "insert" {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.message = "Choose a file to insert"
            panel.prompt = "Insert"
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
        // Directory mode picks a destination, which may not exist yet — a
        // fresh project root is a folder the user makes here or not at all.
        panel.canCreateDirectories = !wantFile
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
        completion(delegate?.makerModeEnabled ?? false, delegate?.sourceTreePath)
    }


    func bridgeFrontendReady() {
        DispatchQueue.main.async {
            guard let delegate = self.delegate else { return }
            delegate.frontendReady = true

            // Open any files the OS handed us before the deck was live
            // (cold launch by dropping a file on the icon). Control frames
            // reach the renderer now that frontendReady has fired.
            delegate.flushPendingOpenPaths()

            // The update state, replayed rather than queued: whatever
            // Sparkle found before the deck was live is still true now, and
            // a deck that reloaded mid-download is caught up by this one
            // line [B03]. Sends `idle` when there is nothing to say, which
            // is what clears a stale pill after a reload.
            self.window?.bridgeUpdateState(delegate.updateController.snapshot)

            // Current VoiceOver state, on mount and on every reconnect —
            // the frontend's keyboard-access mode converges without
            // waiting for a toggle.
            delegate.sendVoiceOverState()

            // The network-path hint starts here and nowhere earlier: nothing
            // at launch reads it, and a framework that had to answer before
            // the splash cleared would be one more launch dependency of
            // exactly the kind this arc removed. Idempotent — a reconnect's
            // second call re-publishes the current report to a store that
            // reloaded empty, rather than stacking a monitor.
            delegate.networkPathMonitor.start { [weak self] report in
                self?.window?.bridgeNetworkPath(report)
            }

            // First frontendReady is the initial mount — no replay
            // needed (the OS hasn't told tugdeck anything that needs
            // re-asserting yet) and the WebView is already painted by
            // `revealWebView` upstream.
            //
            // Except in harness pid mode, where the activation is announced
            // in-process at launch, before any control connection exists to
            // carry it, and never again by the OS. A real activation lands
            // after this point as its own frame, and a foreground page seeds
            // its active bit from `document.hasFocus()` at construction; a
            // pid-mode page is constructed before WebKit reads the real key
            // window active, so it is told now, the first moment a control
            // frame reaches it.
            if !delegate.frontendHasLoadedOnce {
                delegate.frontendHasLoadedOnce = true
                if AppDelegate.harnessPidMode { delegate.replayLifecycleState() }
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
            delegate.replayLifecycleState()
        }
    }

    func bridgeSetTheme(color: String) {
        ProcessManager.writeTugbank(domain: TugConfig.domain, key: TugConfig.keyWindowBackground, value: color)
        window?.updateBackgroundColor(color)
    }

    func bridgePageDidLoad() {
        delegate?.lastLoadTime = Date()
        delegate?.updateDevInfoOverlay()
    }

    func bridgeHmrUpdate() {
        delegate?.lastLoadTime = Date()
        delegate?.updateDevInfoOverlay()
    }

    func bridgeLaunchStageName() -> String {
        (delegate?.launchStage ?? .starting).rawValue
    }

    /// Re-run what the current stage was waiting on.
    ///
    /// Each arm is the same call the launch sequence made, so a Retry after
    /// a transient failure reaches exactly the state a healthy launch would
    /// have. The window has already put the spinner back and re-armed its
    /// deadline, so an arm that stalls again produces the screen again.
    func bridgeRetryLaunchStage() {
        guard let delegate, let processManager else { return }
        TugLog.info("launch", "retry", [TugLog.field("stage", delegate.launchStage.rawValue)])
        switch delegate.launchStage {
        case .starting, .resolvingPath:
            // A PATH that never resolved leaves everything after it unrun,
            // so this arm resumes the sequence rather than repeating one call.
            ProcessManager.resolveShellPATH()
            delegate.launchStage = .startingTugcast
            processManager.start(sourceTree: delegate.sourceTreePath)
        case .startingTugcast:
            processManager.start(sourceTree: delegate.sourceTreePath)
        case .loadingInterface, .waitingForInterface:
            // The URL the interface was loaded from, and never the launch's
            // auth URL once its one-time token is spent: a debug bundle
            // loads from Vite's origin, and a Retry that went back to
            // tugcast's `/auth` was refused with a 403 every time.
            guard let url = window?.interfaceRetryURL() ?? delegate.lastAuthURL else {
                // No ready ever arrived, so there is no URL to go back to;
                // the stage is misread and tugcast is the thing to re-run.
                processManager.start(sourceTree: delegate.sourceTreePath)
                return
            }
            delegate.launchStage = .waitingForInterface
            window?.loadURL(url)
        }
    }
}
