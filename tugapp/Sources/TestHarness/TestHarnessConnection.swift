#if DEBUG
import AppKit
import ApplicationServices
import Foundation
import WebKit

// MARK: - TestHarnessConnection
//
// Per-connection NDJSON handler for the in-app test harness. Reads one
// JSON request per line, dispatches by `method`, writes one response
// per line. Single-client model — the listener only ever hands us one
// connection at a time.
//
// Dispatch table (in-app bridge RPC):
//   - `version` — respond `{ id, ok: true, value: "1.0.0" }`
//   - `evalJS` — forward to `WKWebView.evaluateJavaScript`; hard
//     server-side timeout (default 5000ms). Script throws serialize
//     to `{ ok: false, error: { name: "EvalError", message, stack? } }`.
//   - `waitForCondition` — server-side poll loop calling
//     `evaluateJavaScript` at `pollMs ?? 16` intervals until truthy
//     or `timeoutMs ?? 2000` elapsed.
//
// `webView` is injected by the bridge at construction time; we call
// `evaluateJavaScript` on the main thread (WebKit contract).

final class TestHarnessConnection {
    /// Surface version reported by the `version` RPC. Must match
    /// `SURFACE_VERSION` in `tugdeck/src/test-surface.ts`.
    ///
    /// `1.1.0` (2026-04-24): adds native-gesture and
    /// keyboard verbs to the dispatch table (`nativeClick`,
    /// `nativeDoubleClick`, `nativeRightClick`, `nativeDrag`,
    /// `nativeMouseDown`, `nativeMouseUp`, `nativeKey`, `nativeType`,
    /// `holdModifier`), the accessibility preflight verb
    /// (`checkAccessibilityPermission`), and the Swift-side
    /// introspection verb (`getElementScreenBounds`). The additive
    /// `__tug.*` introspection group lives on the JS side and does
    /// not widen the RPC surface (see `tugdeck/src/test-surface.ts`).
    /// Existing `version` / `evalJS` / `waitForCondition` verbs are
    /// unchanged. Major version still `1`, so harnesses built against
    /// `1.0.0` continue to handshake cleanly against `1.1.0` (minor
    /// version is additive).
    ///
    /// `1.2.0` (harness extensions): adds the four
    /// app-lifecycle simulation verbs (`simulateAppResign`,
    /// `simulateAppBecomeActive`, `simulateAppHide`,
    /// `simulateAppUnhide`). Each invokes the matching `NSApp`
    /// primitive on main and waits up to 1000ms for the
    /// corresponding `NSApplication.did...Notification` to fire;
    /// timeout surfaces as `AppLifecycleTimeoutError`. Additive;
    /// major stays `1`.
    ///
    /// `1.3.0` (harness extensions): adds the harness-owned
    /// tugcode subprocess lifecycle verbs (`startTugcode` /
    /// `stopTugcode`). Later versions extend `startTugcode`'s payload with the
    /// `--stub-transcript=<fd>` branch and add transcript-seeding
    /// verbs. Additive; major stays `1`.
    ///
    /// `1.4.0` (harness extensions): `startTugcode`'s
    /// payload gains an optional `transcript` field carrying the
    /// stub-replay document. When present (and `mode == "stub"`),
    /// the Swift handler writes it to a temp file under $TMPDIR
    /// and passes `--stub-transcript=<path>` to tugcode, which
    /// routes through its deterministic replay engine. The plan's
    /// originally-separate `seedTugcodeTranscript` /
    /// `seedTugcodeError` verbs are folded into `startTugcode`'s
    /// opts. Additive;
    /// major stays `1`.
    ///
    /// `1.5.0`: adds the
    /// `quitGracefully` verb. Schedules `NSApp.terminate(nil)` on
    /// main, which fires the full `applicationShouldTerminate`
    /// path including `window.tugdeck.saveState()`. Distinct from
    /// `simulateApp*` verbs in that the connection is expected to
    /// be torn down by `applicationShouldTerminate`'s completion
    /// handler — the response is written before terminate runs;
    /// callers await `subprocess.exited` for the real signal.
    /// Additive; major stays `1`.
    ///
    /// `1.6.0`: adds native-menu introspection verbs
    /// (`menuSnapshot`, `menuItemState`). Both walk `NSApp.mainMenu`
    /// on main and report each item's *validated* enabled state
    /// (resolved through `NSMenuItemValidation`, as AppKit does at
    /// open / key-equivalent time). Additive; major stays `1`.
    ///
    /// `1.7.0`: menu snapshot nodes gain `state` (the raw
    /// `NSControl.StateValue` — 1 = checked), captured AFTER the
    /// validation sweep so validators that refresh radio checkmarks
    /// (the permission-mode submenu) are reflected. Additive; major
    /// stays `1`.
    ///
    /// `1.9.0`: adds `stopTugcast` / `startTugcast` — one deliberate
    /// tugcast outage, held open for as long as the test wants. The
    /// app, its window and the loaded page all survive it, so what a
    /// test observes across the window is the deck's own reconnect
    /// healing. Additive; major stays `1`.
    static let surfaceVersion = "1.9.0"

    private let fileHandle: FileHandle
    private var buffer = Data()
    private weak var webView: WKWebView?

    /// Per-connection tugcode subprocess lifecycle holder. Spawned
    /// via `startTugcode` RPC and torn down on `close()` so a
    /// disconnect (or graceful Tug.app quit) doesn't leak a child.
    private let tugcodeLifecycle = TugcodeLifecycleHandlers()

    var onDisconnect: (() -> Void)?

    init(fd: Int32) {
        self.fileHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    /// Attach a WKWebView for `evalJS` / `waitForCondition` dispatch.
    /// Called by `TestHarnessBridge` after the MainWindow is up.
    func attach(webView: WKWebView) {
        self.webView = webView
        startReading()
    }

    /// Start reading NDJSON from the client. Called once the webView
    /// is attached so we never try to dispatch before there's anything
    /// to evaluate against.
    private func startReading() {
        fileHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                // EOF
                DispatchQueue.main.async { self?.onDisconnect?() }
                handle.readabilityHandler = nil
                return
            }
            self?.processData(data)
        }
    }

    private func processData(_ data: Data) {
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            buffer = Data(buffer[(newlineIndex + 1)...])
            dispatchLine(Data(lineData))
        }
    }

    private func dispatchLine(_ line: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            // Malformed line — cannot extract an id; log and drop.
            NSLog("tughost.test-harness.malformed-request")
            return
        }
        guard let id = obj["id"] as? Int,
              let method = obj["method"] as? String else {
            NSLog("tughost.test-harness.missing-id-or-method")
            return
        }

        switch method {
        case "version":
            respond(id: id, ok: true, payload: ["value": Self.surfaceVersion])
        case "getHostPid":
            // PID of this GUI app process. The harness launches Tug.app
            // via `open -n -W`, so the subprocess handle it holds is the
            // `open` wrapper, not the app — it has no other way to learn
            // the app's PID. Reporting it here lets `App.close()` signal
            // the app directly, which is race-free (works before tugcast
            // has registered in the instance registry) and tears down the
            // window the user sees; tugcast then self-exits via its
            // parent-watch.
            respond(id: id, ok: true, payload: ["value": Int(ProcessInfo.processInfo.processIdentifier)])
        case "evalJS":
            guard let script = obj["script"] as? String else {
                respondError(id: id, name: "ProtocolError", message: "evalJS: missing 'script'")
                return
            }
            let timeoutMs = (obj["timeoutMs"] as? Int) ?? 5000
            dispatchEvalJS(id: id, script: script, timeoutMs: timeoutMs)
        case "waitForCondition":
            guard let script = obj["script"] as? String else {
                respondError(id: id, name: "ProtocolError", message: "waitForCondition: missing 'script'")
                return
            }
            let timeoutMs = (obj["timeoutMs"] as? Int) ?? 2000
            let pollMs = (obj["pollMs"] as? Int) ?? 16
            dispatchWaitForCondition(id: id, script: script, timeoutMs: timeoutMs, pollMs: pollMs)
        case "nativeClick",
             "nativeDoubleClick",
             "nativeRightClick",
             "nativeDrag",
             "nativeDragWithoutRelease",
             "nativeMouseDown",
             "nativeMouseUp",
             "nativeKey",
             "nativeType",
             "holdModifier",
             "pressHeldModifiers",
             "releaseHeldModifiers":
            dispatchNativeVerb(id: id, verbObj: obj)
        case "checkAccessibilityPermission":
            dispatchCheckAccessibilityPermission(id: id, verbObj: obj)
        case "simulateAppResign",
             "simulateAppBecomeActive",
             "simulateAppHide",
             "simulateAppUnhide",
             "quitGracefully":
            dispatchAppLifecycleVerb(id: id, method: method, verbObj: obj)
        case "startTugcode",
             "stopTugcode",
             "writeTugcodeStdin":
            dispatchTugcodeLifecycleVerb(id: id, method: method, verbObj: obj)
        case "stopTugcast",
             "startTugcast":
            dispatchTugcastLifecycleVerb(id: id, method: method)
        case "getElementScreenBounds":
            guard let selector = obj["selector"] as? String else {
                respondError(id: id, name: "ProtocolError", message: "getElementScreenBounds: missing 'selector'")
                return
            }
            dispatchGetElementScreenBounds(id: id, selector: selector)
        case "menuSnapshot":
            dispatchMenuSnapshot(id: id)
        case "menuItemState":
            guard let identifier = obj["identifier"] as? String else {
                respondError(id: id, name: "ProtocolError", message: "menuItemState: missing 'identifier'")
                return
            }
            dispatchMenuItemState(id: id, identifier: identifier)
        case "screenshot":
            dispatchScreenshot(id: id)
        case "captureWindow":
            dispatchCaptureWindow(id: id)
        default:
            respondError(id: id, name: "NotImplemented", message: "Unknown method: \(method)")
        }
    }

    // MARK: - Accessibility preflight ([D03])

    /// Probe the macOS Accessibility-permission bit for this process
    /// and return `{ trusted, bundlePath, bundleId }`.
    ///
    /// On first call per launch, `prompt: true` instructs macOS to
    /// show the "open System Settings → Privacy & Security →
    /// Accessibility" dialog if the grant is missing. The call itself
    /// returns immediately with the current state; the dialog is
    /// non-blocking. Subsequent calls within the same process skip
    /// the dialog (macOS rate-limits it).
    ///
    /// `bundlePath` / `bundleId` are echoed back so the TS side can
    /// render an actionable error message naming exactly which binary
    /// the user must grant. Bundle path ≠ the Mach-O exec path the
    /// user usually sees — TCC keys grants on the bundle, not the
    /// exec, and the user needs to drag the `.app` (not the inner
    /// binary) into the Accessibility list.
    private func dispatchCheckAccessibilityPermission(id: Int, verbObj: [String: Any]) {
        // Must be on the main thread — `AXIsProcessTrustedWithOptions`
        // with `prompt: true` spins up UI on the main run loop. The
        // readabilityHandler that invokes us runs on a background
        // thread, so hop explicitly.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // `prompt` defaults to true so a fresh install sees the
            // System Settings dialog on the first preflight call.
            // Tests that want a silent probe (to re-check after a
            // grant without nuisance-popup) can pass `{ prompt: false }`.
            let prompt = (verbObj["prompt"] as? Bool) ?? true
            let key = "AXTrustedCheckOptionPrompt"
            let options: NSDictionary = [key: prompt]
            // Re-invoke the Accessibility API with the prompt option.
            // The CF cast matches `AXIsProcessTrustedWithOptions`'
            // signature (takes a CFDictionary).
            let trusted = AXIsProcessTrustedWithOptions(options as CFDictionary)

            let bundle = Bundle.main
            let bundlePath = bundle.bundlePath
            let bundleId = bundle.bundleIdentifier ?? "<unknown>"

            let payload: [String: Any] = [
                "value": [
                    "trusted": trusted,
                    "bundlePath": bundlePath,
                    "bundleId": bundleId,
                ] as [String: Any],
            ]
            self.respond(id: id, ok: true, payload: payload)
        }
    }

    // MARK: - Swift-side introspection: getElementScreenBounds

    /// Resolve `selector` → `getBoundingClientRect()` via `evalJS`,
    /// then convert the rect's corners into screen CG coords via
    /// `CoordMapping.viewportToScreen`.
    ///
    /// Response shape: `{ x, y, width, height }` in CG screen coords,
    /// where `{x, y}` is the top-left corner. Dimensions come from the
    /// corner-to-corner difference after both corners are converted
    /// (so a width/height derived directly from viewport units gets
    /// applied AFTER the Y-flip, not before — the top/bottom corners
    /// swap on the CG axis, so the Y-span is preserved exactly).
    ///
    /// Error modes:
    /// - No matching element → `EvalError` from the inner `evalJS` (the
    ///   JS throws a recognizable error the harness translates).
    /// - Element's rect has a corner outside the WKWebView viewport →
    ///   `CoordinateOutOfBoundsError` with the offending viewport
    ///   corner. Useful signal: the element is offscreen due to scroll
    ///   or a layout bug.
    /// - WKWebView detached → `AppCrashedError`.
    private func dispatchGetElementScreenBounds(id: Int, selector: String) {
        guard let webView = webView else {
            respondError(id: id, name: "AppCrashedError", message: "WKWebView unavailable")
            return
        }
        // Inline script: query selector, throw on miss, serialize rect
        // as a plain object. JSON-stringify-safe. The `Array` return
        // shape wraps x/y/width/height so the WKWebView marshals them
        // consistently across versions (some 10.x WebKits flatten Float
        // fields awkwardly when returned as objects at top level).
        let escaped = selector
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        (function() {
          var el = document.querySelector("\(escaped)");
          if (el === null) {
            throw new Error("[tug] getElementScreenBounds: selector matched no element: \(escaped)");
          }
          var r = el.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height];
        })()
        """
        let completionState = EvalCompletionState()
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script) { [weak self] result, error in
                guard let self = self else { return }
                guard completionState.markCompleted() else { return }
                if let error = error as NSError? {
                    let jsMessage = error.userInfo["WKJavaScriptExceptionMessage"] as? String
                        ?? error.localizedDescription
                    self.respondError(id: id, name: "EvalError", message: jsMessage)
                    return
                }
                guard let arr = result as? [Any], arr.count == 4,
                      let x = (arr[0] as? NSNumber)?.doubleValue ?? (arr[0] as? Double),
                      let y = (arr[1] as? NSNumber)?.doubleValue ?? (arr[1] as? Double),
                      let w = (arr[2] as? NSNumber)?.doubleValue ?? (arr[2] as? Double),
                      let h = (arr[3] as? NSNumber)?.doubleValue ?? (arr[3] as? Double) else {
                    self.respondError(
                        id: id,
                        name: "ProtocolError",
                        message: "getElementScreenBounds: expected [x,y,w,h] from page, got: \(result ?? "nil")",
                    )
                    return
                }
                // Convert top-left and bottom-right corners. The CG
                // top-left corner is the AppKit point whose Y is the
                // smallest (flip inverts Y ordering), so we take the
                // min of the two converted Ys to get the real "top".
                let topLeft = CGPoint(x: x, y: y)
                let bottomRight = CGPoint(x: x + w, y: y + h)
                guard let cgTL = CoordMapping.viewportToScreen(topLeft, in: webView) else {
                    self.respondError(
                        id: id,
                        name: "CoordinateOutOfBoundsError",
                        message: "top-left viewport corner (\(x), \(y)) is outside the WKWebView's visible frame",
                    )
                    return
                }
                guard let cgBR = CoordMapping.viewportToScreen(bottomRight, in: webView) else {
                    self.respondError(
                        id: id,
                        name: "CoordinateOutOfBoundsError",
                        message: "bottom-right viewport corner (\(x + w), \(y + h)) is outside the WKWebView's visible frame",
                    )
                    return
                }
                let outX = min(cgTL.x, cgBR.x)
                let outY = min(cgTL.y, cgBR.y)
                let outW = abs(cgBR.x - cgTL.x)
                let outH = abs(cgBR.y - cgTL.y)
                let rect: [String: Any] = [
                    "x": outX,
                    "y": outY,
                    "width": outW,
                    "height": outH,
                ]
                self.respond(id: id, ok: true, payload: ["value": rect])
            }
        }
    }

    // MARK: - Screenshot capture

    /// Render the WKWebView's current contents to a PNG and write it to a
    /// temp file, returning the file path. Uses `WKWebView.takeSnapshot`,
    /// which captures the rendered web content directly — no Screen
    /// Recording permission, no separate display capture. The harness
    /// reads the file and is responsible for deleting it.
    private func dispatchScreenshot(id: Int) {
        guard let webView = webView else {
            respondError(id: id, name: "AppCrashedError", message: "WKWebView unavailable")
            return
        }
        let completionState = EvalCompletionState()
        DispatchQueue.main.async {
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = true
            webView.takeSnapshot(with: config) { [weak self] image, error in
                guard let self = self else { return }
                guard completionState.markCompleted() else { return }
                if let error = error {
                    self.respondError(id: id, name: "ScreenshotError", message: error.localizedDescription)
                    return
                }
                guard let image = image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    self.respondError(id: id, name: "ScreenshotError", message: "PNG encoding failed")
                    return
                }
                let path = (NSTemporaryDirectory() as NSString)
                    .appendingPathComponent("tugapp-screenshot-\(UUID().uuidString).png")
                do {
                    try png.write(to: URL(fileURLWithPath: path))
                } catch {
                    self.respondError(
                        id: id, name: "ScreenshotError",
                        message: "write failed: \(error.localizedDescription)")
                    return
                }
                self.respond(id: id, ok: true, payload: ["value": ["path": path]])
            }
        }
    }

    /// Capture the harness window as the window server composited it. This
    /// is UI-process side: a frozen or busy web process does not stall it,
    /// and an animation the compositor is driving is seen where it actually
    /// is, which `takeSnapshot` — a web-process paint — cannot show. An app
    /// may capture its own window without a Screen Recording grant.
    private func dispatchCaptureWindow(id: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let window = self.webView?.window else {
                self.respondError(id: id, name: "CaptureError", message: "no window")
                return
            }
            let wid = CGWindowID(window.windowNumber)
            guard let cg = CGWindowListCreateImage(
                .null, .optionIncludingWindow, wid, [.boundsIgnoreFraming, .bestResolution]
            ) else {
                self.respondError(id: id, name: "CaptureError", message: "CGWindowListCreateImage returned nil")
                return
            }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let png = rep.representation(using: .png, properties: [:]) else {
                self.respondError(id: id, name: "CaptureError", message: "PNG encoding failed")
                return
            }
            let path = (NSTemporaryDirectory() as NSString)
                .appendingPathComponent("tugapp-capture-\(UUID().uuidString).png")
            do {
                try png.write(to: URL(fileURLWithPath: path))
            } catch {
                self.respondError(id: id, name: "CaptureError", message: "write failed: \(error.localizedDescription)")
                return
            }
            let content = window.contentView?.bounds.size ?? .zero
            self.respond(id: id, ok: true, payload: ["value": [
                "path": path,
                "width": cg.width,
                "height": cg.height,
                "contentWidth": Double(content.width),
                "contentHeight": Double(content.height),
            ]])
        }
    }

    // MARK: - Native menu introspection

    /// Full recursive snapshot of `NSApp.mainMenu` as a nested tree. Each
    /// node reports its title, identifier, *validated* enabled state (run
    /// through the same NSMenuItemValidation path AppKit uses at display /
    /// key-equivalent time), hidden flag, key equivalent, and submenu. Lets
    /// the harness assert menu-validation outcomes without entering a real
    /// tracking session.
    private func dispatchMenuSnapshot(id: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let mainMenu = NSApp.mainMenu else {
                self.respondError(id: id, name: "NoMainMenu", message: "NSApp.mainMenu is nil")
                return
            }
            let tree = self.snapshotMenu(mainMenu)
            self.respond(id: id, ok: true, payload: ["value": tree])
        }
    }

    /// Targeted lookup of a single menu item by its
    /// `NSUserInterfaceItemIdentifier`. Returns `{ found: false }` when no
    /// item carries the identifier, else the item's snapshot node merged
    /// with `found: true` (submenu children trimmed for a compact payload).
    private func dispatchMenuItemState(id: Int, identifier: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let mainMenu = NSApp.mainMenu else {
                self.respondError(id: id, name: "NoMainMenu", message: "NSApp.mainMenu is nil")
                return
            }
            let tree = self.snapshotMenu(mainMenu)
            if var found = Self.findByIdentifier(tree, identifier) {
                found["found"] = true
                found.removeValue(forKey: "submenu")
                self.respond(id: id, ok: true, payload: ["value": found])
            } else {
                self.respond(id: id, ok: true, payload: ["value": ["found": false]])
            }
        }
    }

    /// Recursively serialize a menu. Must run on the main thread.
    ///
    /// Run the delegate's `menuNeedsUpdate` first: menus with an
    /// `NSMenuDelegate` build their contents there, and AppKit calls it when
    /// the menu is about to be displayed. Without it the View body, the theme
    /// list, Open Recent's entries, and the `window.pane.*` slice are absent
    /// from every snapshot — `menuItemState` answers `found: false` for items
    /// that plainly exist on screen. Calling the delegate directly rather
    /// than `NSMenu.update()` because `update()` does not run the callout
    /// synchronously, so a snapshot taken in the same turn still sees the
    /// stale tree.
    private func snapshotMenu(_ menu: NSMenu) -> [[String: Any]] {
        menu.delegate?.menuNeedsUpdate?(menu)
        var items: [[String: Any]] = []
        for item in menu.items {
            // Validate before reading `state`: validators may refresh
            // radio checkmarks as part of the sweep (the permission-mode
            // submenu does), exactly as they would on a real menu open.
            let enabled = validatedEnabled(item)
            var entry: [String: Any] = [
                "title": item.title,
                "enabled": enabled,
                "hidden": item.isHidden,
                "separator": item.isSeparatorItem,
                "keyEquivalent": item.keyEquivalent,
                "modifierMask": Int(item.keyEquivalentModifierMask.rawValue),
                "state": item.state.rawValue,
            ]
            if let ident = item.identifier?.rawValue { entry["identifier"] = ident }
            if let action = item.action { entry["action"] = NSStringFromSelector(action) }
            if let submenu = item.submenu {
                entry["submenu"] = snapshotMenu(submenu)
            }
            items.append(entry)
        }
        return items
    }

    /// The *validated* enabled state of a menu item — what AppKit would
    /// compute when the menu opens or the key equivalent fires. For an
    /// auto-enabling menu (the default) with a nil-target action, this
    /// resolves the responder-chain target exactly as AppKit does and asks
    /// its `NSMenuItemValidation`. Items in a manual-enabling menu, or with
    /// no resolvable target, fall back to their stored / disabled state.
    private func validatedEnabled(_ item: NSMenuItem) -> Bool {
        if item.isSeparatorItem { return false }
        let autoenables = item.menu?.autoenablesItems ?? true
        // A parent item carries AppKit's own `submenuAction:`, which resolves
        // to a target that implements no validator — so the action path below
        // would answer `true` for every submenu in the bar, including one
        // standing over an empty list. AppKit's actual rule for an
        // auto-enabling menu is that a submenu item is enabled when its
        // submenu holds at least one enabled item; model that instead.
        if autoenables, let submenu = item.submenu {
            submenu.delegate?.menuNeedsUpdate?(submenu)
            return submenu.items.contains { validatedEnabled($0) }
        }
        guard autoenables, let action = item.action else {
            return item.isEnabled
        }
        guard let target = NSApp.target(forAction: action, to: item.target, from: item) else {
            return false
        }
        if let validator = target as? NSMenuItemValidation {
            return validator.validateMenuItem(item)
        }
        // Target handles the action but offers no validator → AppKit
        // leaves it enabled.
        return true
    }

    /// Depth-first search of a snapshot tree for the node whose
    /// `identifier` matches.
    private static func findByIdentifier(
        _ items: [[String: Any]],
        _ identifier: String,
    ) -> [String: Any]? {
        for item in items {
            if (item["identifier"] as? String) == identifier {
                return item
            }
            if let sub = item["submenu"] as? [[String: Any]],
               let hit = findByIdentifier(sub, identifier) {
                return hit
            }
        }
        return nil
    }

    // MARK: - Tugcode subprocess lifecycle verbs

    /// Top-level dispatch for `startTugcode` / `stopTugcode`. The
    /// underlying `Process` API blocks briefly during `run()` /
    /// `terminate()` (waitUntilExit on SIGKILL fallback), so we
    /// hop to a background queue to keep the WebKit run loop
    /// responsive. Errors translate via `TugcodeLifecycleError`'s
    /// `wireName` to the typed `TugcodeLaunchError` on the harness
    /// side.
    private func dispatchTugcodeLifecycleVerb(
        id: Int,
        method: String,
        verbObj: [String: Any],
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                switch method {
                case "startTugcode":
                    let mode = (verbObj["mode"] as? String) ?? "stub"
                    let binaryPath = verbObj["binaryPath"] as? String
                    let logFilePath = verbObj["logFilePath"] as? String
                    // The harness ferries the transcript as a JSON
                    // dict (already parsed JS-side); re-encode it
                    // here so Swift can drop a single string into
                    // the temp file. Avoids piping bytes through a
                    // separate fd-inheritance path.
                    let transcriptJson: String?
                    if let transcriptObj = verbObj["transcript"] {
                        guard JSONSerialization.isValidJSONObject(transcriptObj) else {
                            self.respondError(
                                id: id,
                                name: "ProtocolError",
                                message: "startTugcode: transcript is not a JSON-serializable object",
                            )
                            return
                        }
                        do {
                            let data = try JSONSerialization.data(
                                withJSONObject: transcriptObj,
                            )
                            transcriptJson = String(data: data, encoding: .utf8)
                        } catch {
                            self.respondError(
                                id: id,
                                name: "ProtocolError",
                                message: "startTugcode: transcript re-serialize failed: \(error)",
                            )
                            return
                        }
                    } else {
                        transcriptJson = nil
                    }
                    let dir = verbObj["dir"] as? String
                    let pid = try self.tugcodeLifecycle.start(
                        mode: mode,
                        binaryPath: binaryPath,
                        logFilePath: logFilePath,
                        transcriptJson: transcriptJson,
                        dir: dir,
                    )
                    self.respond(id: id, ok: true, payload: ["value": ["pid": Int(pid)] as [String: Any]])
                case "stopTugcode":
                    self.tugcodeLifecycle.stop()
                    self.respond(id: id, ok: true, payload: ["value": NSNull()])
                case "writeTugcodeStdin":
                    guard let line = verbObj["line"] as? String else {
                        self.respondError(
                            id: id,
                            name: "ProtocolError",
                            message: "writeTugcodeStdin: missing 'line' string",
                        )
                        return
                    }
                    try self.tugcodeLifecycle.writeStdinLine(line)
                    self.respond(id: id, ok: true, payload: ["value": NSNull()])
                default:
                    self.respondError(
                        id: id,
                        name: "ProtocolError",
                        message: "unsupported tugcode-lifecycle method: \"\(method)\"",
                    )
                }
            } catch let error as TugcodeLifecycleError {
                self.respondError(id: id, name: error.wireName, message: error.description)
            } catch {
                self.respondError(
                    id: id,
                    name: "TugcodeLifecycleError",
                    message: "\(error)",
                )
            }
        }
    }

    // MARK: - Tugcast outage verbs

    /// Top-level dispatch for `stopTugcast` / `startTugcast` — the two
    /// halves of one deliberate tugcast outage, with the window between
    /// them belonging to the test rather than to a timer.
    ///
    /// Tug.app, its window and the loaded page all survive: `onReady`'s
    /// restart branch re-authenticates in place, so what a test observes
    /// across the window is the deck's own reconnect healing (the
    /// `connectionDidOpen` re-`watch` in `file-watch-client.ts`) rather
    /// than a fresh page that would have re-read everything anyway.
    ///
    /// Reaches the private `ProcessManager` through the AppDelegate's two
    /// DEBUG-only passthroughs. `stopTugcast` blocks for as long as the
    /// quiesce ladder takes (up to the 4 s drain deadline), which is why
    /// the work hops to a background queue and marshals onto main with
    /// `sync` — the response is not written until the child is actually
    /// gone, so a test that writes the watched file next knows nothing was
    /// watching it.
    private func dispatchTugcastLifecycleVerb(id: Int, method: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let reached: Bool = DispatchQueue.main.sync {
                guard let delegate = NSApp.delegate as? AppDelegate else { return false }
                if method == "stopTugcast" {
                    delegate.harnessStopTugcast()
                } else {
                    delegate.harnessStartTugcast()
                }
                return true
            }
            if reached {
                self.respond(id: id, ok: true, payload: ["value": NSNull()])
            } else {
                self.respondError(
                    id: id,
                    name: "ProtocolError",
                    message: "\(method): no AppDelegate to reach the ProcessManager through",
                )
            }
        }
    }

    // MARK: - App-lifecycle verbs

    /// Top-level dispatch for the `simulateApp*` verb family. Each
    /// verb invokes the matching `NSApp` primitive on main and waits
    /// up to 1000ms (or the wire-supplied `timeoutMs`) for the
    /// corresponding `NSApplication.did...Notification` to fire.
    ///
    /// Bounces through `DispatchQueue.global(qos: .userInitiated).async`
    /// so the main run loop stays free to deliver the notification —
    /// the helper inside `AppLifecycleHandlers` marshals the trigger
    /// onto main synchronously and parks on a `DispatchSemaphore`
    /// from the background queue while the notification fires on
    /// main and signals.
    private func dispatchAppLifecycleVerb(
        id: Int,
        method: String,
        verbObj: [String: Any],
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try AppLifecycleHandlers.dispatch(method: method, verbObj: verbObj)
                self.respond(id: id, ok: true, payload: ["value": NSNull()])
            } catch let error as AppLifecycleError {
                self.respondError(id: id, name: error.wireName, message: error.description)
            } catch {
                self.respondError(
                    id: id,
                    name: "AppLifecycleError",
                    message: "\(error)",
                )
            }
        }
    }

    // MARK: - Native verbs

    /// Top-level dispatch for the native-event verb family. Builds a
    /// `NativeEventHandlers` instance, runs the verb on the main
    /// thread, and writes a single response based on the outcome.
    ///
    /// Every native verb bounces through `DispatchQueue.main.async`
    /// — the verbs touch `NSApp.activate`, `CGEvent.post`, and the
    /// shared `webView` reference, all of which require the main
    /// thread (Cocoa contract). The Bun-side `waitForCondition`
    /// that follows most verb calls also runs against the same
    /// main-thread `evaluateJavaScript` path, so queuing in order
    /// keeps event delivery and JS polling naturally sequenced.
    private func dispatchNativeVerb(id: Int, verbObj: [String: Any]) {
        guard let webView = webView else {
            respondError(id: id, name: "AppCrashedError", message: "WKWebView unavailable")
            return
        }
        // CRITICAL: native verbs post CGEvents and sleep between them
        // (see `nativeDrag`'s interpolation loop). Running them on the
        // main thread blocks WebKit's run loop — which means WebKit
        // cannot dispatch the posted events to JS until our handler
        // returns. That causes all events in a burst to arrive
        // coalesced by WebKit's event merger (documented behavior for
        // rapid consecutive mousemoves), collapsing an 8-step drag
        // into one `mousemove` at the destination and breaking drag-
        // selection extension.
        //
        // Post from a background queue so the main thread stays on
        // the run loop and WebKit can dispatch events as they arrive.
        // CGEvent.post is thread-safe — it goes to the windowserver
        // via an IOHIDEventTap, not through any app-local state.
        //
        // Coord resolution and `NSApp.activate` still need the main
        // thread (see `NativeEventHandlers.activateSelf` /
        // `resolveScreenPoint`). Those calls marshal onto main
        // synchronously via DispatchQueue.main.sync inside
        // `NativeEventHandlers`.
        let handlers = NativeEventHandlers(webView: webView)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.executeNativeVerb(verbObj, handlers: handlers)
                self.respond(id: id, ok: true, payload: ["value": NSNull()])
            } catch let error as NativeEventError {
                self.respondError(id: id, name: error.wireName, message: error.description)
            } catch {
                self.respondError(
                    id: id,
                    name: "NativeEventError",
                    message: "\(error)",
                )
            }
        }
    }

    /// Execute a single native verb given its wire-form JSON and a
    /// pre-built `NativeEventHandlers`. Throws `NativeEventError`
    /// for typed failures; callers (top-level dispatch OR
    /// `holdModifier`'s inner-verb loop) translate to RPC responses.
    ///
    /// Two callers:
    ///   1. `dispatchNativeVerb` — top-level; writes a response.
    ///   2. `executeHoldModifier` — inner; re-throws so the parent's
    ///      response reflects any inner failure, with the modifier-
    ///      release `defer` still running to avoid stuck modifiers.
    fileprivate func executeNativeVerb(
        _ verbObj: [String: Any],
        handlers: NativeEventHandlers,
    ) throws {
        guard let method = verbObj["method"] as? String else {
            throw NativeEventError.protocolError("missing 'method' in inner verb")
        }

        switch method {
        case "nativeClick":
            let vp = try Self.parsePoint(verbObj["viewportPoint"], field: "viewportPoint")
            let button = try Self.parseButton(verbObj["button"])
            let clickCount = (verbObj["clickCount"] as? Int) ?? 1
            let downDelay = (verbObj["mouseDownDelayMs"] as? Int) ?? 20
            let upDelay = (verbObj["mouseUpDelayMs"] as? Int) ?? 20
            let activateFirst = (verbObj["activateFirst"] as? Bool) ?? true
            try handlers.nativeClick(
                viewportPoint: vp,
                button: button,
                clickCount: clickCount,
                mouseDownDelayMs: downDelay,
                mouseUpDelayMs: upDelay,
                activateFirst: activateFirst,
            )

        case "nativeDoubleClick":
            let vp = try Self.parsePoint(verbObj["viewportPoint"], field: "viewportPoint")
            let button = try Self.parseButton(verbObj["button"])
            try handlers.nativeDoubleClick(viewportPoint: vp, button: button)

        case "nativeRightClick":
            let vp = try Self.parsePoint(verbObj["viewportPoint"], field: "viewportPoint")
            try handlers.nativeRightClick(viewportPoint: vp)

        case "nativeDrag":
            let from = try Self.parsePoint(verbObj["from"], field: "from")
            let to = try Self.parsePoint(verbObj["to"], field: "to")
            let button = try Self.parseButton(verbObj["button"])
            let downDelay = (verbObj["mouseDownDelayMs"] as? Int) ?? 20
            let upDelay = (verbObj["mouseUpDelayMs"] as? Int) ?? 20
            let steps = (verbObj["interpolationSteps"] as? Int) ?? 8
            try handlers.nativeDrag(
                from: from,
                to: to,
                button: button,
                mouseDownDelayMs: downDelay,
                mouseUpDelayMs: upDelay,
                interpolationSteps: steps,
            )

        case "nativeDragWithoutRelease":
            // Same wire shape as nativeDrag — `mouseUpDelayMs` is
            // accepted for symmetry but unused (no mouseUp posted).
            let from = try Self.parsePoint(verbObj["from"], field: "from")
            let to = try Self.parsePoint(verbObj["to"], field: "to")
            let button = try Self.parseButton(verbObj["button"])
            let downDelay = (verbObj["mouseDownDelayMs"] as? Int) ?? 20
            let upDelay = (verbObj["mouseUpDelayMs"] as? Int) ?? 20
            let steps = (verbObj["interpolationSteps"] as? Int) ?? 8
            try handlers.nativeDragWithoutRelease(
                from: from,
                to: to,
                button: button,
                mouseDownDelayMs: downDelay,
                mouseUpDelayMs: upDelay,
                interpolationSteps: steps,
            )

        case "nativeMouseDown":
            let vp = try Self.parsePoint(verbObj["viewportPoint"], field: "viewportPoint")
            let button = try Self.parseButton(verbObj["button"])
            try handlers.nativeMouseDown(viewportPoint: vp, button: button)

        case "nativeMouseUp":
            let vp = try Self.parsePoint(verbObj["viewportPoint"], field: "viewportPoint")
            let button = try Self.parseButton(verbObj["button"])
            try handlers.nativeMouseUp(viewportPoint: vp, button: button)

        case "nativeKey":
            guard let key = verbObj["key"] as? String else {
                throw NativeEventError.protocolError("nativeKey: missing 'key'")
            }
            let modifiers = try Self.parseModifiers(verbObj["modifiers"])
            try handlers.nativeKey(key: key, modifiers: modifiers)

        case "nativeType":
            guard let text = verbObj["text"] as? String else {
                throw NativeEventError.protocolError("nativeType: missing 'text'")
            }
            try handlers.nativeType(text: text)

        case "holdModifier":
            try executeHoldModifier(verbObj: verbObj, handlers: handlers)

        // The persistent-hold pair ([#chord-ring]'s test dependency): unlike
        // `holdModifier`, these are two separate round trips, so the test can
        // `evalJS` the UI while the modifier is down.
        case "pressHeldModifiers":
            handlers.pressHeldModifiers(try Self.parseModifiers(verbObj["modifiers"]))

        case "releaseHeldModifiers":
            handlers.releaseHeldModifiers(try Self.parseModifiers(verbObj["modifiers"]))

        default:
            throw NativeEventError.protocolError(
                "unsupported inner verb method: \"\(method)\"",
            )
        }
    }

    /// Press the requested modifiers, dispatch each inner verb in
    /// order via `executeNativeVerb` (recursive), release modifiers
    /// in reverse order. Inner-verb failures propagate up; the
    /// modifier release still runs via `defer` inside
    /// `handlers.holdModifier`, so a failed inner leaves no modifier
    /// held.
    ///
    /// Recursion depth is bounded in practice (inner `holdModifier`
    /// scopes are unusual for test harnesses), but we don't enforce
    /// a depth limit — a test that hits infinite recursion crashes
    /// with a stack overflow and the test author notices.
    private func executeHoldModifier(
        verbObj: [String: Any],
        handlers: NativeEventHandlers,
    ) throws {
        let modifiers = try Self.parseModifiers(verbObj["modifiers"])
        guard let innerVerbs = verbObj["innerVerbs"] as? [[String: Any]] else {
            throw NativeEventError.protocolError(
                "holdModifier: missing 'innerVerbs' (expected array of verb objects)",
            )
        }
        try handlers.holdModifier(modifiers: modifiers) { [self] in
            for inner in innerVerbs {
                try self.executeNativeVerb(inner, handlers: handlers)
            }
        }
    }

    // MARK: - Native verb arg parsers

    /// Parse a `{ x, y }` point from a wire dict. Accepts both
    /// `NSNumber`-backed JSON numbers and Swift `Double`s — both
    /// shapes survive `JSONSerialization` depending on magnitude
    /// and fractional part.
    private static func parsePoint(_ raw: Any?, field: String) throws -> CGPoint {
        guard let dict = raw as? [String: Any] else {
            throw NativeEventError.protocolError(
                "missing or malformed '\(field)' (expected {x, y} object)",
            )
        }
        let xNum = (dict["x"] as? NSNumber)?.doubleValue ?? (dict["x"] as? Double)
        let yNum = (dict["y"] as? NSNumber)?.doubleValue ?? (dict["y"] as? Double)
        guard let x = xNum, let y = yNum else {
            throw NativeEventError.protocolError(
                "'\(field)' missing x/y numeric fields",
            )
        }
        return CGPoint(x: x, y: y)
    }

    /// Parse a `"left"` / `"right"` button string. Missing field
    /// defaults to `.left` so bare click/drag calls don't need to
    /// specify it.
    private static func parseButton(_ raw: Any?) throws -> MouseButton {
        guard let str = raw as? String else {
            return .left
        }
        guard let button = MouseButton(rawValue: str) else {
            throw NativeEventError.protocolError(
                "invalid button \"\(str)\" (expected \"left\" or \"right\")",
            )
        }
        return button
    }

    /// Parse an array of modifier names into `[ModifierKey]`. Missing
    /// field defaults to an empty array.
    private static func parseModifiers(_ raw: Any?) throws -> [ModifierKey] {
        guard let arr = raw as? [String] else {
            if raw == nil {
                return []
            }
            throw NativeEventError.protocolError(
                "'modifiers' must be an array of strings (cmd/shift/alt/ctrl)",
            )
        }
        return try arr.map { name in
            guard let mod = ModifierKey(rawValue: name) else {
                throw NativeEventError.protocolError(
                    "invalid modifier \"\(name)\" (expected one of: cmd, shift, alt, ctrl)",
                )
            }
            return mod
        }
    }

    // MARK: - evalJS

    private func dispatchEvalJS(id: Int, script: String, timeoutMs: Int) {
        guard let webView = webView else {
            respondError(id: id, name: "AppCrashedError", message: "WKWebView unavailable")
            return
        }
        let completionState = EvalCompletionState()
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script) { [weak self] result, error in
                guard let self = self else { return }
                guard completionState.markCompleted() else {
                    return // Timer already fired; drop the belated completion.
                }
                if let error = error as NSError? {
                    // `localizedDescription` is always the generic
                    // "A JavaScript exception occurred"; the useful
                    // details live in the WKJavaScriptException* keys.
                    let jsMessage = error.userInfo["WKJavaScriptExceptionMessage"] as? String
                    let line = error.userInfo["WKJavaScriptExceptionLineNumber"] as? Int
                    let column = error.userInfo["WKJavaScriptExceptionColumnNumber"] as? Int
                    let detailed: String
                    if let jsMessage = jsMessage {
                        if let line = line, let column = column {
                            detailed = "\(jsMessage) (line \(line), col \(column))"
                        } else {
                            detailed = jsMessage
                        }
                    } else {
                        detailed = error.localizedDescription
                    }
                    self.respondError(
                        id: id,
                        name: "EvalError",
                        message: detailed,
                        stack: error.userInfo["WKJavaScriptExceptionStackTrace"] as? String
                    )
                    return
                }
                self.respondWithSerialized(id: id, jsValue: result)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
            guard let self = self else { return }
            guard completionState.markTimedOut() else { return }
            self.respondError(
                id: id,
                name: "TimeoutError",
                message: "evalJS exceeded \(timeoutMs)ms"
            )
        }
    }

    // MARK: - waitForCondition

    private func dispatchWaitForCondition(id: Int, script: String, timeoutMs: Int, pollMs: Int) {
        guard let webView = webView else {
            respondError(id: id, name: "AppCrashedError", message: "WKWebView unavailable")
            return
        }
        let pollState = PollState()
        let deadline = DispatchTime.now() + .milliseconds(timeoutMs)

        func poll() {
            guard !pollState.isCompleted else { return }
            if DispatchTime.now() >= deadline {
                guard pollState.markCompleted() else { return }
                respondError(
                    id: id,
                    name: "TimeoutError",
                    message: "waitForCondition exceeded \(timeoutMs)ms"
                )
                return
            }
            DispatchQueue.main.async {
                webView.evaluateJavaScript(script) { [weak self] result, error in
                    guard let self = self else { return }
                    if pollState.isCompleted { return }
                    if let error = error as NSError? {
                        guard pollState.markCompleted() else { return }
                        self.respondError(
                            id: id,
                            name: "EvalError",
                            message: error.localizedDescription
                        )
                        return
                    }
                    if Self.isTruthy(result) {
                        guard pollState.markCompleted() else { return }
                        self.respondWithSerialized(id: id, jsValue: result)
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(pollMs)) {
                        poll()
                    }
                }
            }
        }
        poll()
    }

    /// JS truthiness for the values `evaluateJavaScript` returns.
    /// Returns `false` for nil, `NSNull`, `false`, `0`, `""`.
    static func isTruthy(_ value: Any?) -> Bool {
        guard let v = value else { return false }
        if v is NSNull { return false }
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber {
            // NSNumber may carry a boolean; treat 0 and false as falsy.
            if CFNumberGetType(n) == .charType { return n.boolValue }
            return n.doubleValue != 0
        }
        if let s = v as? String { return !s.isEmpty }
        return true
    }

    // MARK: - Response writers

    private func respond(id: Int, ok: Bool, payload: [String: Any]) {
        var obj: [String: Any] = ["id": id, "ok": ok]
        for (k, v) in payload { obj[k] = v }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: obj),
              var payloadStr = String(data: jsonData, encoding: .utf8) else {
            NSLog("tughost.test-harness.response-serialize-failed id=%d", id)
            return
        }
        payloadStr.append("\n")
        if let data = payloadStr.data(using: .utf8) {
            fileHandle.write(data)
        }
    }

    private func respondError(id: Int, name: String, message: String, stack: String? = nil) {
        var error: [String: Any] = ["name": name, "message": message]
        if let stack = stack { error["stack"] = stack }
        respond(id: id, ok: false, payload: ["error": error])
    }

    /// Serialize a JS return value into the `{ ok: true, value }`
    /// shape. Non-serializable values become `SerializationError`.
    private func respondWithSerialized(id: Int, jsValue: Any?) {
        let normalized: Any = jsValue ?? NSNull()
        // JSONSerialization accepts only arrays or dictionaries at the
        // top level; wrap into a dictionary so we can extract the
        // encoded scalar safely.
        let wrapper: [String: Any] = ["value": normalized]
        if !JSONSerialization.isValidJSONObject(wrapper) {
            respondError(
                id: id,
                name: "SerializationError",
                message: "evalJS return value is not JSON-serializable"
            )
            return
        }
        respond(id: id, ok: true, payload: ["value": normalized])
    }

    func close() {
        // A test that threw mid-hold never issued its release, and a modifier
        // left down at the windowserver outlives this process — the next
        // keystroke on the machine becomes a system chord. Backstop the pair
        // here, where every disconnect passes.
        if let webView = webView {
            NativeEventHandlers(webView: webView).releaseAllHeldModifiers()
        }
        // Tear down any running tugcode child first so a graceful
        // disconnect (or AppDelegate.applicationShouldTerminate)
        // doesn't leak a zombie subprocess past the test.
        tugcodeLifecycle.stop()
        fileHandle.readabilityHandler = nil
        fileHandle.closeFile()
    }
}

// MARK: - Completion-state guards
//
// Both `evalJS` and `waitForCondition` have a race between a timer
// (fires timeout) and a completion handler (fires value/error). We
// need exactly one winner; the loser drops silently.

private final class EvalCompletionState {
    private var completed = false
    private let lock = NSLock()

    /// Returns true if we won the race to report completion.
    func markCompleted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if completed { return false }
        completed = true
        return true
    }

    func markTimedOut() -> Bool { markCompleted() }
}

private final class PollState {
    private var completed = false
    private let lock = NSLock()

    var isCompleted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return completed
    }

    func markCompleted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if completed { return false }
        completed = true
        return true
    }
}
#endif
