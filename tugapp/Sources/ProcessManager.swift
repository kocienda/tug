import AppKit
import Foundation

/// Restart decision for the supervisor loop
enum RestartDecision {
    case pending
    case restartWithBackoff
    case doNotRestart
}

/// Manages the tugcast server process lifecycle with supervisor loop
class ProcessManager {
    private var process: Process?
    private var viteProcess: Process?
    private var sourceTree: String?

    /// Control socket infrastructure
    private var controlListener: ControlSocketListener?
    private var controlConnection: ControlSocketConnection?
    /// Actual tugcast port, updated from the ready message.
    /// Initialized to 55255 (the CLI default) until the ready message
    /// reports the real per-instance port.
    private(set) var currentTugcastPort: Int = 55255
    private var tugcastPort: Int {
        get { currentTugcastPort }
        set { currentTugcastPort = newValue }
    }
    /// Per-instance app↔tugcast control socket path.
    ///
    /// Keyed on `InstanceConfig.shortToken` (a short, fixed-width hash of
    /// the instance id), NOT the tugcast port. Three reasons:
    ///   1. **Isolation.** Every instance (the developer's `app-debug`,
    ///      each `app-test` harness launch) must own a distinct control
    ///      socket. A port-keyed path collapsed to the shared legacy
    ///      `tugcast-ctl-55255.sock` for everyone (the port is 55255
    ///      until the ready message), so `ControlSocketListener.init`'s
    ///      `unlink(path)` would steal a running instance's socket —
    ///      launching an app-test then knocked the developer's debug
    ///      instance off its control channel (tugcast respawn → the
    ///      WebView's "Disconnected" banner).
    ///   2. **Stability.** A port-keyed path also *shifted* once the
    ///      ready message updated `currentTugcastPort`, diverging from
    ///      the path the listener was created with. The instance id is
    ///      frozen for the process, so this path is constant across
    ///      tugcast restarts and before/after ready.
    ///   3. **Length.** The raw instance id can't go in the path: the
    ///      harness mints `apptest-<uuid>`, and that under `$TMPDIR`
    ///      overflows `sockaddr_un.sun_path` (~104 bytes), so the bind
    ///      fails and the app never gets tugcast's ready. The hashed
    ///      token is fixed-width and short.
    private var controlSocketPath: String {
        NSTemporaryDirectory() + "tugcast-ctl-\(InstanceConfig.shortToken).sock"
    }
    private var childPID: Int32 = 0
    private var restartDecision: RestartDecision = .pending
    private var backoffSeconds: TimeInterval = 0

    /// Callback for ready message (UDS-based): passes auth URL and actual tugcast port
    var onReady: ((String, Int) -> Void)?

    /// Callback for dev_mode errors
    var onDevModeError: ((String) -> Void)?

    /// Resolved shell PATH. Access via `resolvedShellPATH` — populated by `resolveShellPATH()`.
    private static var _shellPATH: String?

    /// The user's full shell PATH. Falls back to the app's inherited PATH until
    /// `resolveShellPATH()` is called. Call `resolveShellPATH()` once the app
    /// is fully launched — it spawns a login shell and blocks for ~1s.
    static var shellPATH: String {
        return _shellPATH ?? ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    }

    /// Resolve the user's login shell PATH so child processes can find tools like tmux.
    /// Mac apps inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) — this gets the real one
    /// by launching the user's actual login shell (from /etc/passwd via dscl) in login-interactive
    /// mode and asking it to print $PATH. Blocks for ~1s — call after the window is visible.
    static func resolveShellPATH() {
        // Fast path: a previously-cached PATH that still locates tmux.
        //
        // The only thing the app strictly needs from the shell PATH is to
        // find tmux (and the sibling child-process tools — git, bun/node —
        // which live alongside it). A user's PATH is effectively constant
        // launch-to-launch, so re-deriving it every time is wasted work:
        // the login-INTERACTIVE shell spawn below sources the full `.zshrc`
        // (prompt, plugins, completions…) just to print `$PATH`, blocking
        // launch for ~250ms.
        //
        // Instead: trust the cached PATH and validate it with a filesystem
        // stat for tmux. If tmux is still there, we're done — no subprocess
        // at all. We only pay the shell spawn when tmux is NOT locatable on
        // the cached PATH (first run, tmux moved / uninstalled, or the PATH
        // genuinely changed), and we refresh the cache when we do.
        //
        // Trade-off: a tool newly installed into a PATH dir that the cache
        // doesn't yet contain (but tmux still resolves) won't be picked up
        // until the next cache miss. For Tug's stable toolchain that never
        // bites in practice; if it ever does, deleting the cache file forces
        // a re-resolve.
        // With a bundled tmux, tmux need not be on PATH at all, so the
        // tmux-presence sentinel no longer signals cache validity — trust a
        // present cache and skip the login-shell spawn. Without a bundled
        // tmux (dev build), keep the original sentinel: re-resolve if tmux
        // vanished from the cached PATH.
        if let cached = readCachedShellPATH(),
           bundledTmuxURL() != nil || which("tmux", onPath: cached) != nil {
            _shellPATH = cached
            return
        }

        let resolved = resolveShellPATHViaLoginShell()
        _shellPATH = resolved
        writeCachedShellPATH(resolved)
    }

    /// Derive the user's fully-configured PATH by spawning their login
    /// shell. The slow path behind {@link resolveShellPATH}'s cache — runs
    /// only on a cache miss.
    private static func resolveShellPATHViaLoginShell() -> String {
        // Step 1: Find the user's login shell via Directory Services
        var loginShell = "/bin/zsh" // sensible default
        let dscl = Process()
        dscl.executableURL = URL(fileURLWithPath: "/usr/bin/dscl")
        dscl.arguments = [".", "-read", "/Users/\(NSUserName())", "UserShell"]
        let dsclPipe = Pipe()
        dscl.standardOutput = dsclPipe
        dscl.standardError = Pipe()
        do {
            try dscl.run()
            dscl.waitUntilExit()
            let data = dsclPipe.fileHandleForReading.readDataToEndOfFile()
            if let output = String(data: data, encoding: .utf8) {
                // Output is "UserShell: /bin/zsh\n"
                let parts = output.split(separator: ":", maxSplits: 1)
                if parts.count == 2 {
                    let shell = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
                    if FileManager.default.isExecutableFile(atPath: shell) {
                        loginShell = shell
                    }
                }
            }
        } catch {}

        // Step 2: Launch that shell in login-interactive mode to get the fully-configured PATH.
        // -l = login shell (reads profile/rc files), -i = interactive (reads .bashrc/.zshrc),
        // -c = execute command. This picks up PATH modifications from .zprofile, .bash_profile,
        // .zshrc, .bashrc, /etc/paths, /etc/paths.d/*, path_helper, nix, homebrew, etc.
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: loginShell)
        proc.arguments = ["-lic", "printf '%s' \"$PATH\""]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let path = String(data: data, encoding: .utf8), !path.isEmpty {
                return path
            }
        } catch {}

        // Step 3: Last resort — use whatever the app inherited
        return ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    }

    /// Location of the cached shell-PATH file under the Tug app-support dir.
    private static var shellPATHCacheURL: URL {
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        return appSupport
            .appendingPathComponent("Tug", isDirectory: true)
            .appendingPathComponent("shell-path.cache")
    }

    private static func readCachedShellPATH() -> String? {
        guard let data = try? Data(contentsOf: shellPATHCacheURL),
              let raw = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func writeCachedShellPATH(_ path: String) {
        let url = shellPATHCacheURL
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? Data(path.utf8).write(to: url, options: .atomic)
    }

    /// Whether the user forced Tug to use their own PATH tmux instead of the
    /// bundled one. The escape hatch mirrors `tmux_bin()` on the Rust side.
    static var useSystemTmux: Bool {
        ProcessInfo.processInfo.environment["TUG_USE_SYSTEM_TMUX"] != nil
    }

    /// The self-contained tmux bundled inside Tug.app
    /// (`Contents/Resources/bin/tmux`), or nil when absent — e.g. dev builds
    /// run straight from DerivedData, which never ran `fetch-tmux.sh`.
    static func bundledTmuxURL() -> URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let url = resources.appendingPathComponent("bin/tmux")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    /// The bundled terminfo database (`Contents/Resources/terminfo`) carrying
    /// `tmux-256color` and friends, or nil when absent.
    static func bundledTerminfoPath() -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let path = resources.appendingPathComponent("terminfo").path
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
        return (exists && isDir.boolValue) ? path : nil
    }

    /// Check that a usable tmux exists. The bundled tmux satisfies this with
    /// nothing installed; only when it's absent (dev build / corrupt bundle)
    /// or explicitly bypassed do we require tmux on the user's PATH.
    static func checkTmux() -> Bool {
        if !useSystemTmux, bundledTmuxURL() != nil {
            return true
        }
        return which("tmux") != nil
    }

    /// Find a binary on the user's resolved shell PATH.
    static func which(_ name: String) -> String? {
        return which(name, onPath: shellPATH)
    }

    /// Find a binary on an explicit `:`-separated PATH. Used by
    /// {@link resolveShellPATH} to validate a cached PATH before it is
    /// adopted as `_shellPATH`.
    private static func which(_ name: String, onPath pathList: String) -> String? {
        for dir in pathList.components(separatedBy: ":") {
            let path = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    /// Read a string value from tugbank.
    /// Delegates to TugbankClient.shared when available; falls back to CLI.
    static func readTugbank(domain: String, key: String) -> String? {
        if let client = TugbankClient.shared {
            return client.getString(domain: domain, key: key)
        }
        guard let tugbankPath = which("tugbank") else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: tugbankPath)
        proc.arguments = ["read", domain, key]
        proc.environment = tugbankChildEnv()
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8) else { return nil }
            let value = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        } catch {
            return nil
        }
    }

    /// Read a boolean value from tugbank. Returns true if the key exists and
    /// its value is a bool true or the string "true" (case-insensitive).
    static func readTugbankBool(domain: String, key: String) -> Bool {
        if let client = TugbankClient.shared {
            return client.getBool(domain: domain, key: key)
        }
        guard let value = readTugbank(domain: domain, key: key) else { return false }
        return value.caseInsensitiveCompare("true") == .orderedSame
    }

    /// Write a string value to tugbank.
    @discardableResult
    static func writeTugbank(domain: String, key: String, value: String) -> Bool {
        if let client = TugbankClient.shared {
            return client.setString(domain: domain, key: key, value: value)
        }
        guard let tugbankPath = which("tugbank") else { return false }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: tugbankPath)
        proc.arguments = ["write", domain, key, value]
        proc.environment = tugbankChildEnv()
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// Build the environment for a `tugbank` CLI subprocess invoked
    /// as a fallback when `TugbankClient.shared` is unavailable. The
    /// child must see `TUG_INSTANCE_ID` so it opens the right
    /// per-instance database (per [D12]). Inherits the parent
    /// environment otherwise.
    private static func tugbankChildEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env[InstanceConfig.envInstanceID] = InstanceConfig.instanceId
        return env
    }

    /// Resolve tugcast binary path from bundle
    private func resolveTugcastPath() -> URL? {
        resolveBundledTool("tugcast")
    }

    /// Resolve a CLI tool shipped alongside the app executable in
    /// `Contents/MacOS/` (tugcast, tug, …). Returns nil if absent.
    private func resolveBundledTool(_ name: String) -> URL? {
        guard let executableURL = Bundle.main.executableURL else { return nil }
        let url = executableURL.deletingLastPathComponent().appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// The PATH every child of tugcast inherits: the bundle's own
    /// `Contents/MacOS/` first, then the user's shell PATH. tugcode, the
    /// claude it spawns, the plugin hooks, and the shell panes all resolve
    /// `tugutil` and its siblings from the running bundle — never from a
    /// symlink into a source checkout, and never from nothing at all on a
    /// machine that has only Tug.app installed.
    static func childPATH(shellPATH: String) -> String {
        guard let executableURL = Bundle.main.executableURL else { return shellPATH }
        let bin = executableURL.deletingLastPathComponent().path
        let rest = shellPATH.split(separator: ":").map(String.init).filter { $0 != bin }
        return ([bin] + rest).joined(separator: ":")
    }

    /// Spawn the Vite dev server with the given source tree, tugcast port, and Vite port.
    ///
    /// Under the dual-mode architecture, this method is only called when dev serving is
    /// enabled. In production mode tugcast serves the pre-built frontend directly via
    /// ServeDir; no Vite process is started. This method MUST only be called from a
    /// `devServingEnabled == true` branch in AppDelegate.
    ///
    /// Vite persists across tugcast restarts — call this only once from the onReady callback
    /// or from bridgeSetMakerMode. The duplication guard prevents re-spawning if Vite is
    /// already running.
    /// Passes `--port` explicitly so the Vite port is deterministic, and `--strictPort`
    /// so Vite fails fast if the port is occupied rather than silently binding elsewhere.
    /// Passes `TUGCAST_PORT` so `vite.config.ts` can proxy `/auth`, `/api`, `/ws` to tugcast.
    func spawnViteServer(sourceTree: String, tugcastPort: Int, vitePort: Int, devMode: Bool) {
        // Duplication guard: skip if Vite is already running (prevents duplicate servers on tugcast restarts)
        if viteProcess?.isRunning == true {
            NSLog("ProcessManager: vite server already running, skipping spawn")
            return
        }

        // Kill any orphaned process holding the port (e.g. stale Vite from a previous app launch
        // that wasn't cleaned up). Without this, --strictPort causes the new Vite to fail silently
        // while the stale server keeps serving outdated content.
        killProcessOnPort(vitePort)

        let viteBinaryPath = (sourceTree as NSString).appendingPathComponent("tugdeck/node_modules/.bin/vite")
        guard FileManager.default.isExecutableFile(atPath: viteBinaryPath) else {
            NSLog("ProcessManager: vite binary not found at %@; frontend unavailable", viteBinaryPath)
            return
        }

        let viteProc = Process()
        viteProc.executableURL = URL(fileURLWithPath: viteBinaryPath)
        if devMode {
            viteProc.arguments = ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"]
        } else {
            viteProc.arguments = ["preview", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"]
        }
        viteProc.currentDirectoryURL = URL(fileURLWithPath: (sourceTree as NSString).appendingPathComponent("tugdeck"))

        var viteEnv = ProcessInfo.processInfo.environment
        viteEnv["PATH"] = ProcessManager.shellPATH
        viteEnv["TUGCAST_PORT"] = String(tugcastPort)
        // Vite's theme plugin shells out to `tugbank read dev.tugtool.app theme`
        // (vite.config.ts) to build tug-active-theme.css. Without TUG_INSTANCE_ID
        // that read falls through to the legacy default DB (~/.tugbank.db) instead
        // of this app's per-instance DB, so the dev-rendered theme silently
        // diverges from the splash and the rest of the app (per [D12]).
        viteEnv[InstanceConfig.envInstanceID] = InstanceConfig.instanceId
        viteProc.environment = viteEnv

        viteProc.standardOutput = FileHandle.standardOutput
        viteProc.standardError = FileHandle.standardError

        // Handle Vite exit: log warning but do not auto-restart (per risk R01)
        viteProc.terminationHandler = { process in
            NSLog("ProcessManager: vite server exited with code %d", process.terminationStatus)
        }

        do {
            try viteProc.run()
            self.viteProcess = viteProc
            NSLog("ProcessManager: vite server started (pid %d, devMode=%d)", viteProc.processIdentifier, devMode ? 1 : 0)
        } catch {
            NSLog("ProcessManager: failed to start vite server: %@", error.localizedDescription)
        }
    }

    /// Kill any process listening on the given TCP port.
    ///
    /// Uses a direct socket probe to check if the port is occupied, then `lsof` to find
    /// the PID. This catches orphaned Vite processes from previous app launches that
    /// weren't cleaned up (e.g. the app was force-quit or relaunched without graceful shutdown).
    private func killProcessOnPort(_ port: Int) {
        // Quick socket probe — if nothing is listening, skip the lsof lookup entirely
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return }
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        close(sock)
        guard connected == 0 else { return }

        // Port is occupied — find the PID via lsof
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-ti", ":\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8) else { return }
            for line in output.split(separator: "\n") {
                if let pid = Int32(line.trimmingCharacters(in: .whitespaces)), pid > 0 {
                    NSLog("ProcessManager: reclaiming port %d from orphan (pid %d)", port, pid)
                    kill(pid, SIGTERM)
                    // A leftover Tug service gets its flush window before
                    // the hammer: poll for the shared stale-reclaim grace.
                    let deadline = Date().addingTimeInterval(InstanceConfig.quiesceStaleReclaimGrace)
                    while Date() < deadline, kill(pid, 0) == 0 {
                        usleep(25_000)
                    }
                    // Force-kill if still alive.
                    if kill(pid, 0) == 0 {
                        NSLog("ProcessManager: orphan (pid %d) ignored SIGTERM — SIGKILL", pid)
                        noteSigkill(
                            target: "port-orphan",
                            pid: pid,
                            after: InstanceConfig.quiesceStaleReclaimGrace
                        )
                        kill(pid, SIGKILL)
                        usleep(100_000)
                    }
                }
            }
        } catch {
            NSLog("ProcessManager: lsof failed: %@", error.localizedDescription)
        }
    }

    /// Kill the running Vite server process and wait for it to exit.
    ///
    /// Synchronous (`waitUntilExit`) so the caller can safely spawn a new Vite process
    /// immediately after without two processes competing for the same port (per risk R02).
    func killViteServer() {
        guard let proc = viteProcess else { return }
        if proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
            NSLog("ProcessManager: vite server killed (exit code %d)", proc.terminationStatus)
        }
        viteProcess = nil
    }

    /// Poll the given port until a TCP connection succeeds, the Vite process exits, or timeout expires.
    ///
    /// Runs the polling loop on a background queue and calls the completion handler
    /// on the main queue with `true` if the port became reachable, `false` on timeout
    /// or if the Vite process died before the port became ready.
    func waitForViteReady(port: Int, timeout: TimeInterval = 10, completion: @escaping (Bool) -> Void) {
        let viteProc = self.viteProcess
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(timeout)
            var ready = false
            while Date() < deadline {
                // Abort early if the Vite process already exited (e.g. port conflict with --strictPort)
                if let proc = viteProc, !proc.isRunning {
                    NSLog("ProcessManager: waitForViteReady aborting, vite process exited")
                    break
                }
                var addr = sockaddr_in()
                addr.sin_family = sa_family_t(AF_INET)
                addr.sin_port = UInt16(port).bigEndian
                addr.sin_addr.s_addr = inet_addr("127.0.0.1")
                let sock = socket(AF_INET, SOCK_STREAM, 0)
                if sock >= 0 {
                    let result = withUnsafePointer(to: &addr) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                        }
                    }
                    close(sock)
                    if result == 0 { ready = true; break }
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            DispatchQueue.main.async { completion(ready) }
        }
    }

    /// Start tugcast
    func start(sourceTree: String?) {
        self.sourceTree = sourceTree

        // Create control socket listener (persists across child restarts)
        if controlListener == nil {
            do {
                let listener = try ControlSocketListener(path: controlSocketPath)
                listener.onConnection = { [weak self] connection in
                    DispatchQueue.main.async {
                        self?.handleNewConnection(connection)
                    }
                }
                self.controlListener = listener
            } catch {
                NSLog("ProcessManager: failed to create control socket listener: %@", error.localizedDescription)
            }
        }

        startProcess()
    }

    /// Handle new UDS connection from child
    private func handleNewConnection(_ connection: ControlSocketConnection) {
        // Close previous connection (exactly-one-connection policy)
        controlConnection?.close()
        controlConnection = connection

        connection.onMessage = { [weak self] msg in
            self?.handleControlMessage(msg)
        }
        connection.onDisconnect = { [weak self] in
            self?.handleDisconnect()
        }
    }

    /// Handle control message from child
    private func handleControlMessage(_ msg: ControlMessage) {
        // Validate PID
        if let pid = msg.data["pid"] as? Int, Int32(pid) != childPID {
            NSLog("ProcessManager: ignoring message from unknown pid %d (expected %d)", pid, childPID)
            return
        }

        switch msg.type {
        case "ready":
            guard let authURL = msg.data["auth_url"] as? String else {
                NSLog("ProcessManager: ready message missing auth_url")
                return
            }
            let port = msg.data["port"] as? Int ?? 55255
            // Store actual tugcast port so controlSocketPath uses the right value
            self.tugcastPort = port
            // Reset backoff on successful ready
            backoffSeconds = 0
            NSLog("ProcessManager: ready (auth_url=%@, port=%d)", authURL, port)
            onReady?(authURL, port)
        case "dev_mode_result":
            let success = msg.data["success"] as? Bool ?? false
            if !success {
                let errorMessage = msg.data["error"] as? String ?? "Unknown error"
                onDevModeError?(errorMessage)
            }
        case "shutdown":
            guard restartDecision == .pending else {
                NSLog("ProcessManager: ignoring duplicate shutdown signal (decision already set)")
                return
            }
            let reason = msg.data["reason"] as? String ?? "unknown"
            switch reason {
            case "relaunch":
                NSLog("ProcessManager: shutdown reason=relaunch, tugrelaunch handles restart")
                // Stop vite dev server before app exit
                if let proc = viteProcess, proc.isRunning {
                    NSLog("ProcessManager: terminating vite dev server before relaunch")
                    proc.terminate()
                    proc.waitUntilExit()
                }
                viteProcess = nil
                restartDecision = .doNotRestart
            case "error":
                let message = msg.data["message"] as? String ?? ""
                NSLog("ProcessManager: shutdown reason=error, message=%@, will not restart", message)
                restartDecision = .doNotRestart
            case "normal", "restart", "reset":
                NSLog("ProcessManager: shutdown reason=%@, will restart", reason)
                restartDecision = .restartWithBackoff
            default:
                NSLog("ProcessManager: shutdown reason=%@, will not restart", reason)
                restartDecision = .doNotRestart
            }
        default:
            NSLog("ProcessManager: unknown control message type: %@", msg.type)
        }
    }

    /// Handle UDS disconnect from the tugcast child.
    ///
    /// Fires when the peer end of the control socket closes — almost
    /// always because tugcast exited (planned shutdown or unexpected
    /// death). Both cases must drop the stale `controlConnection`
    /// reference: any subsequent `sendControl` / `sendDevMode` call
    /// would otherwise pass its `guard let connection` check, reach
    /// `connection.send(...)`, and write to a broken file descriptor.
    /// Even with the Swift-throwing `write(contentsOf:)` in
    /// `ControlSocketConnection.send`, dropping the ref is the
    /// cheaper / more obvious path: there's no live peer to talk to,
    /// so callers should hit the early-return guard rather than
    /// attempt-then-log per call.
    ///
    /// The supervisor loop in `startProcess` is responsible for
    /// respawning tugcast and `handleNewConnection` will install a
    /// fresh connection when the new tugcast's UDS arrives.
    private func handleDisconnect() {
        if restartDecision == .pending {
            NSLog("ProcessManager: control socket EOF without shutdown message (unexpected death)")
            restartDecision = .restartWithBackoff
        }
        controlConnection?.close()
        controlConnection = nil
    }

    /// Send a control command to tugcast via UDS
    func sendControl(_ action: String, params: [String: Any] = [:]) {
        guard let connection = controlConnection else {
            NSLog("ProcessManager: sendControl skipped, no control connection (action: %@)", action)
            return
        }
        var msg: [String: Any] = ["type": "tell", "action": action]
        for (key, value) in params {
            msg[key] = value
        }
        connection.send(msg)
    }

    /// Send dev_mode control message to tugcast via UDS.
    ///
    /// Pass `vitePort` so tugcast can configure its origin allowlist with the actual
    /// Vite dev server port rather than relying on a hardcoded default.
    func sendDevMode(enabled: Bool, sourceTree: String?, vitePort: Int? = nil) {
        guard let connection = controlConnection else {
            NSLog("ProcessManager: sendDevMode skipped, no control connection")
            return
        }
        var msg: [String: Any] = ["type": "dev_mode", "enabled": enabled]
        if let path = sourceTree {
            msg["source_tree"] = path
        }
        if let port = vitePort {
            msg["vite_port"] = port
        }
        connection.send(msg)
    }

    /// Stop the tugcast process.
    ///
    /// Every wait in here is bounded — never a bare `waitUntilExit()`. A
    /// tugcast wedged in its flush and ignoring SIGTERM must fall
    /// through to the group SIGKILL and the quiesce report, not hang
    /// this method forever: an unbounded wait would let the one process
    /// that most needs the escalation prevent it. The ladder shares one
    /// clock: the supervisor's drain deadline starts when the shutdown
    /// request is sent, and the later rungs spend whatever remains of it.
    func stop() {
        // Stop the vite dev server first. No ledgers to flush, so it
        // gets the short reclaim grace rather than the drain deadline.
        if let proc = viteProcess, proc.isRunning {
            proc.terminate()
            if !waitForExit(proc, until: Date().addingTimeInterval(InstanceConfig.quiesceStaleReclaimGrace)) {
                noteSigkill(
                    target: "vite",
                    pid: proc.processIdentifier,
                    after: InstanceConfig.quiesceStaleReclaimGrace
                )
                kill(proc.processIdentifier, SIGKILL)
                proc.waitUntilExit() // SIGKILL cannot be ignored; returns promptly
            }
        }
        viteProcess = nil

        // Graceful shutdown: send shutdown over UDS first. The drain
        // clock starts now.
        if let connection = controlConnection {
            connection.send(["type": "shutdown"])
        }
        let drainDeadline = Date().addingTimeInterval(Self.processGroupExitGrace)

        // Give tugcast the drain window to exit from the UDS shutdown;
        // if it doesn't, SIGTERM it and grant only the short reclaim
        // grace before falling through to the group ladder.
        if let proc = process, proc.isRunning {
            if !waitForExit(proc, until: drainDeadline) {
                proc.terminate()
                _ = waitForExit(
                    proc,
                    until: Date().addingTimeInterval(InstanceConfig.quiesceStaleReclaimGrace)
                )
            }
        }

        // Kill the entire process group to clean up tugcode and any children.
        // Tugcast calls setpgid(0,0) at startup to create its own group,
        // so this won't affect the app. We always do this — even if tugcast
        // exited gracefully — because std::process::exit in tugcast doesn't
        // reliably kill children. The group already got SIGTERM from
        // tugcast's own quiesce; whatever drain time is left is theirs,
        // floored at the reclaim grace so the rung never rounds to zero.
        if let proc = process {
            let pgid = proc.processIdentifier
            kill(-pgid, SIGTERM)
            let groupDeadline = max(
                drainDeadline,
                Date().addingTimeInterval(InstanceConfig.quiesceStaleReclaimGrace)
            )
            waitForProcessGroupToExit(pgid: pgid, deadline: groupDeadline)
        }
        process = nil

        // Close control connection but keep listener (for potential restart)
        controlConnection?.close()
        controlConnection = nil

        writeQuiesceReport()
    }

    /// Poll `proc` for exit until `deadline`. Returns whether it exited.
    private func waitForExit(_ proc: Process, until deadline: Date) -> Bool {
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: Self.processGroupPollInterval)
        }
        return !proc.isRunning
    }

    /// How long the process group gets to exit on its own after SIGTERM,
    /// and how often we check. Each Tug service enforces its own 2 s
    /// `tug-quiesce` flush budget (stop accepting work → flush ledgers →
    /// exit), so a healthy group is gone well inside the shared drain
    /// deadline; a fixed 200 ms wait used to guarantee the SIGKILL landed
    /// mid-shutdown every time.
    private static let processGroupExitGrace: TimeInterval = InstanceConfig.quiesceDrainDeadline
    private static let processGroupPollInterval: TimeInterval = 0.1

    /// SIGKILLs this teardown had to fire. A quiesce that works leaves
    /// this empty; anything in it is a defect, reported to
    /// `InstanceConfig.quiesceReportPath` and asserted on by the
    /// app-test canary.
    private var quiesceEscalations: [[String: Any]] = []

    /// Record one forced kill for the shutdown report.
    private func noteSigkill(target: String, pid: pid_t, after: TimeInterval) {
        quiesceEscalations.append([
            "target": target,
            "pid": Int(pid),
            "afterMs": Int((after * 1000).rounded()),
        ])
    }

    /// Write the quiesce report at the end of every `stop()`, overwriting
    /// the previous one. `sigkills` covers every escalation this app
    /// process has had to fire since launch — a normal run leaves it
    /// empty, which is what the app-test canary asserts.
    private func writeQuiesceReport() {
        let report: [String: Any] = [
            "at": ISO8601DateFormatter().string(from: Date()),
            "drainDeadlineMs": Int(Self.processGroupExitGrace * 1000),
            "sigkills": quiesceEscalations,
        ]
        let path = InstanceConfig.quiesceReportPath
        do {
            try FileManager.default.createDirectory(
                at: path.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONSerialization.data(
                withJSONObject: report,
                options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: path, options: .atomic)
        } catch {
            NSLog("ProcessManager: cannot write quiesce report: %@", error.localizedDescription)
        }
    }

    /// Wait for the process group to drain, then SIGKILL whatever is left.
    ///
    /// `kill(-pgid, 0)` sends no signal — it only asks whether the group
    /// still exists. ESRCH means every child is gone, and that, not a
    /// timer, is what lets teardown move on. Costs nothing when the
    /// children exit fast, which is the normal case now that the deck has
    /// already interrupted and idled the sessions.
    private func waitForProcessGroupToExit(pgid: pid_t, deadline: Date) {
        let startedAt = Date()
        while Date() < deadline {
            if kill(-pgid, 0) != 0 && errno == ESRCH {
                NSLog(
                    "ProcessManager: process group %d exited gracefully after %.1fs",
                    pgid,
                    Date().timeIntervalSince(startedAt)
                )
                return
            }
            Thread.sleep(forTimeInterval: Self.processGroupPollInterval)
        }
        let waited = Date().timeIntervalSince(startedAt)
        NSLog(
            "ProcessManager: process group %d still alive after %.1fs — SIGKILL",
            pgid,
            waited
        )
        noteSigkill(target: "tugcast-process-group", pid: pgid, after: waited)
        kill(-pgid, SIGKILL)
    }

    /// Full teardown for app termination.
    ///
    /// Like `stop()` (graceful tugcast shutdown + process-group kill),
    /// but ALSO releases the control-socket listener — which `close()`
    /// unlinks. `stop()` deliberately keeps the listener alive so a
    /// `restart()` can reuse it; on the terminal path there is no
    /// restart, so we must close it or the per-instance control socket
    /// file leaks for the lifetime of the box. Call this (not `stop()`)
    /// from `applicationShouldTerminate`. Idempotent.
    func shutdown() {
        stop()
        controlListener?.close()
        controlListener = nil
    }

    /// Restart tugcast with current settings
    func restart() {
        stop()
        startProcess()
    }

    /// Internal: Start the process and supervise
    private func startProcess() {
        guard let tugcastURL = resolveTugcastPath() else {
            NSLog("ProcessManager: tugcast binary not found in app bundle")
            return
        }

        // Reset restart decision for new spawn
        restartDecision = .pending

        let proc = Process()
        proc.executableURL = tugcastURL

        // Pass the user's full shell PATH so tugcast can find git and the
        // user's own tools. Mac apps inherit a minimal PATH that doesn't
        // include Homebrew, nix, etc.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = ProcessManager.childPATH(shellPATH: ProcessManager.shellPATH)

        // Point every tmux invocation (tugcast and its panes) at the
        // self-contained tmux bundled in the app, plus its terminfo — so a
        // factory-fresh machine needs nothing installed. tmux_bin() on the
        // Rust side reads TUG_TMUX. Skipped when the user opts into their own
        // tmux, or in dev builds where no bundled tmux exists.
        if !ProcessManager.useSystemTmux, let tmux = ProcessManager.bundledTmuxURL() {
            env["TUG_TMUX"] = tmux.path
            if let terminfo = ProcessManager.bundledTerminfoPath() {
                // Bundled terminfo first; a trailing colon keeps the system
                // database as fallback for any entry we didn't bundle.
                let prior = env["TERMINFO_DIRS"] ?? ""
                env["TERMINFO_DIRS"] = prior.isEmpty ? "\(terminfo):" : "\(terminfo):\(prior)"
            }
        }

        // Per-instance identity (per [D12]). Swift owns the
        // computation; every spawned child inherits these via the
        // environment. Anyone honoring InstanceConfig — tuglog,
        // tugbank-client, session-ledger, notify-socket — uses these
        // to compute per-instance paths.
        env[InstanceConfig.envInstanceID] = InstanceConfig.instanceId
        env[InstanceConfig.envBundlePath] = InstanceConfig.bundlePath

        // tugcast::resources::source_tree() reads this to locate tugdeck/dist
        // and other bundle-relative resources. Debug and release share this
        // path. Only set when Bundle.main.resourcePath is non-nil — an empty
        // string would not be treated as "unset" by std::env::var_os on the
        // Rust side, producing a silent PathBuf::from("") → relative-path
        // failure in ServeDir rather than falling back to the dev-only
        // CARGO_MANIFEST_DIR walk.
        //
        // In the in-app harness, point at the source tree instead of the
        // bundle so a `bun run build` in tugdeck refreshes the dist tugcast
        // serves — no xcodebuild needed between iterations. Production
        // launches keep the bundle path.
        if ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] == "1",
           let path = sourceTree {
            env["TUGCAST_RESOURCE_ROOT"] = path
        } else if let resourcePath = Bundle.main.resourcePath {
            env["TUGCAST_RESOURCE_ROOT"] = resourcePath
        }
        proc.environment = env

        // Build args: only pass flags we have explicit values for.
        // Tugcast has its own CLI defaults (session=cc0, port=55255, source-tree=.)
        // so we don't duplicate them here.
        var args: [String] = []
        if let dir = sourceTree {
            args += ["--source-tree", dir]
        }
        args += ["--control-socket", controlSocketPath]
        // Check tugbank for no-auth development flag
        if Self.readTugbankBool(domain: "dev.tugtool.app", key: "no-auth") {
            args += ["--no-auth"]
            NSLog("ProcessManager: --no-auth enabled via tugbank")
        }
        // In-app harness: pass --force so tugcast can reclaim its own
        // derived port from a stale *same-instance* zombie that outlived
        // an ungraceful teardown (tugcast runs in its own process group
        // and can linger past a SIGKILLed parent until its parent-watch
        // fires). --force is identity-gated in tugcast: it only kills a
        // holder the registry confirms is THIS instance's prior tugcast —
        // never another instance or an unrelated process. See
        // force_kill_port_holder in tugcast/src/main.rs.
        if ProcessInfo.processInfo.environment["TUGAPP_APP_TEST"] == "1" {
            args += ["--force"]
        }
        proc.arguments = args

        proc.standardOutput = FileHandle.standardOutput
        proc.standardError = FileHandle.standardError

        do {
            let launchedAt = Date()
            try proc.run()
            self.process = proc
            self.childPID = proc.processIdentifier

            // Supervisor loop in background
            DispatchQueue.global(qos: .background).async { [weak self] in
                proc.waitUntilExit()
                let exitCode = proc.terminationStatus
                let lifetime = Date().timeIntervalSince(launchedAt)

                DispatchQueue.main.async {
                    guard let self = self else { return }

                    // Duplicate-launch collision (per [D07]): tugcast
                    // exits 73 within 1s when another instance with
                    // the same TUG_INSTANCE_ID already holds the
                    // hash-derived port. Two builds collide whenever
                    // they share `<profile>-<branch>` — e.g. launching a
                    // release build from a second checkout of `main`
                    // while the daily-driver release-main runs. The
                    // identity scheme has no per-checkout discriminator,
                    // so this is the only point every launch mode
                    // (the `just` recipes, Xcode Run, Finder/`open`)
                    // converges; the recipes pre-quit, but ⌘R and Finder
                    // do not, so the takeover offer must live here.
                    if exitCode == 73 && lifetime < 1.0 {
                        NSLog("ProcessManager: duplicate-identity collision (exit 73)")
                        self.process = nil
                        if self.promptDuplicateInstanceTakeover() {
                            // User chose to take over: stop the incumbent,
                            // then respawn tugcast onto the freed port.
                            self.takeOverFromIncumbent()
                        } else {
                            self.restartDecision = .doNotRestart
                            NSApp.terminate(nil)
                        }
                        return
                    }

                    // If no UDS signal arrived, treat as unexpected death
                    if self.restartDecision == .pending {
                        self.restartDecision = .restartWithBackoff
                    }

                    switch self.restartDecision {
                    case .restartWithBackoff:
                        self.backoffSeconds = self.backoffSeconds == 0 ? 1 : min(self.backoffSeconds * 2, 30)
                        NSLog("ProcessManager: restarting with %.0fs backoff", self.backoffSeconds)
                        DispatchQueue.main.asyncAfter(deadline: .now() + self.backoffSeconds) { [weak self] in
                            self?.startProcess()
                        }
                    case .doNotRestart:
                        NSLog("ProcessManager: tugcast exited with code %d, not restarting", exitCode)
                        self.process = nil
                    case .pending:
                        // Should not happen, but treat as doNotRestart
                        NSLog("ProcessManager: tugcast exited with code %d (no decision)", exitCode)
                        self.process = nil
                    }
                }
            }
        } catch {
            NSLog("ProcessManager: failed to start tugcast: %@", error.localizedDescription)
        }
    }

    /// Offer the user a takeover when a same-identity instance already
    /// holds this build's port. Returns `true` if the user chose to
    /// quit the incumbent and continue, `false` to cancel (the caller
    /// then terminates this launch).
    ///
    /// Two instances collide whenever they share `<profile>-<branch>`;
    /// the identity scheme has no per-checkout discriminator, so the
    /// fix is takeover, not coexistence. The default button quits the
    /// incumbent so a single Return key continues the launch — but it
    /// is a *choice*, guarding against an accidental double-launch
    /// silently killing a session the user is mid-work in.
    ///
    /// Reads the registry file (`$TMPDIR/tug-instances.json`) for the
    /// running PID matching `InstanceConfig.instanceId` to name it; if
    /// we can't resolve the PID the prompt still fires with a generic
    /// message — better to offer the choice than silently loop.
    private func promptDuplicateInstanceTakeover() -> Bool {
        let id = InstanceConfig.instanceId
        let pid = ProcessManager.readRunningPID(for: id)
        let alert = NSAlert()
        alert.messageText = "Another \(id) instance is already running"
        let who = pid.map { "PID \($0)" } ?? "Another process"
        alert.informativeText =
            "\(who) holds the port this build was assigned. " +
            "Tug.app cannot run two instances with the same identity. " +
            "Quit the other instance and take over, or cancel this launch."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit Other & Continue") // .alertFirstButtonReturn (default)
        alert.addButton(withTitle: "Cancel")                 // .alertSecondButtonReturn
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Stop the same-identity incumbent, then respawn tugcast onto the
    /// port it releases. Delegates the kill to the bundled `tugutil host
    /// instance stop`, which already does the graceful host-app SIGTERM
    /// → SIGKILL escalation, the PID-reuse identity guards, and the
    /// tmux-session reap — and, crucially, polls until the processes
    /// are *gone* (not merely signalled), so the port is free by the
    /// time we respawn. If tug is missing or the stop fails, the
    /// respawn simply re-collides and re-prompts; we never silently
    /// loop or kill the wrong process.
    private func takeOverFromIncumbent() {
        let id = InstanceConfig.instanceId
        if let tug = resolveBundledTool("tugutil") {
            let proc = Process()
            proc.executableURL = tug
            proc.arguments = ["host", "instance", "stop", id, "--timeout", "5"]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = ProcessManager.shellPATH // tmux / ps lookups
            proc.environment = env
            proc.standardOutput = FileHandle.standardError
            proc.standardError = FileHandle.standardError
            do {
                try proc.run()
                proc.waitUntilExit()
                NSLog("ProcessManager: takeover stop of '%@' exited %d", id, proc.terminationStatus)
            } catch {
                NSLog("ProcessManager: takeover stop failed to launch tug: %@",
                      error.localizedDescription)
            }
        } else {
            NSLog("ProcessManager: takeover requested but bundled tug not found")
        }
        // Respawn regardless: if the incumbent is gone we bind cleanly;
        // if it survived, tugcast re-collides and re-prompts.
        startProcess()
    }

    /// Read the running PID for `instanceId` out of the per-host
    /// registry file. Returns nil if the registry is absent,
    /// unreadable, or has no matching entry.
    private static func readRunningPID(for instanceId: String) -> Int? {
        let path = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("tug-instances.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let instances = json["instances"] as? [[String: Any]] else {
            return nil
        }
        for entry in instances {
            if (entry["instance_id"] as? String) == instanceId,
               let pid = entry["pid"] as? Int {
                return pid
            }
        }
        return nil
    }
}
