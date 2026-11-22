#if DEBUG
import Foundation
import WebKit

// MARK: - TestHarnessBridge
//
// Top-level coordinator for the DEBUG-only in-app test harness. Owns
// the listener + connection lifecycle and binds them to a live
// `WKWebView` once MainWindow is up.
//
// Usage:
//   let bridge = TestHarnessBridge(socketPath: path)
//   bridge.start()                        // binds listener, starts accept loop
//   bridge.attach(webView: myWebView)     // hands the webView to connections
//   bridge.close()                        // closes listener + active conn
//
// The `attach` call is deferred until MainWindow exists; the listener
// itself is up earlier so clients can connect and sit idle until the
// webView is ready. Requests arriving before `attach` are held on the
// connection's read queue (we start the read handler only after attach).

final class TestHarnessBridge {
    private let socketPath: String
    private var listener: TestHarnessListener?
    private weak var pendingWebView: WKWebView?
    private var activeConnection: TestHarnessConnection?

    /// Called on the main queue when the runner driving this instance is
    /// gone. See `TestHarnessConnection.onRunnerGone`.
    var onRunnerGone: ((String) -> Void)?

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    /// Bind the Unix socket listener. Idempotent. Logs a distinctive
    /// line on security failure and does NOT throw — the app keeps
    /// booting without test mode.
    func start() {
        guard listener == nil else { return }
        let listener = TestHarnessListener(path: socketPath)
        listener.onConnection = { [weak self] connection in
            guard let self = self else { return }
            self.activeConnection = connection
            connection.onDisconnect = { [weak self] in
                guard let self = self else { return }
                if self.activeConnection === connection {
                    self.activeConnection = nil
                }
                connection.close()
            }
            connection.onRunnerGone = { [weak self] reason in
                self?.onRunnerGone?(reason)
            }
            if let webView = self.pendingWebView {
                connection.attach(webView: webView)
            }
        }
        do {
            try listener.start()
            self.listener = listener
            NSLog("tughost.test-harness.started: socket=%@", socketPath)
        } catch {
            NSLog("tughost.test-harness.start-failed: %@", String(describing: error))
            self.listener = nil
        }
    }

    /// Provide the live WKWebView to the harness. If a connection is
    /// already waiting, it starts reading immediately.
    func attach(webView: WKWebView) {
        pendingWebView = webView
        activeConnection?.attach(webView: webView)
    }

    /// Shut down the listener and any active connection. Unlinks the
    /// socket file.
    func close() {
        activeConnection?.close()
        activeConnection = nil
        listener?.close()
        listener = nil
    }

    // MARK: - Environment probe

    /// Remove what an app-test instance leaves behind when no runner is
    /// left to remove it: the per-instance sockets in `$TMPDIR` and the
    /// instance's data directory. The runner's own teardown does this when
    /// it ends a test; an instance whose runner died does it for itself as
    /// it exits, after tugcast has stopped (its graceful shutdown already
    /// tears down the instance's tmux server).
    ///
    /// Only ever an `apptest-*` instance: a dev or release instance's data
    /// directory is user state that nothing deletes.
    static func reclaimOwnAppTestInstance() {
        guard InstanceConfig.isAppTest else { return }
        let manager = FileManager.default
        var sockets = [
            InstanceConfig.notifySocketPath.path,
            NSTemporaryDirectory() + "tugcast-ctl-\(InstanceConfig.shortToken).sock",
        ]
        if let harness = envSocketPath() { sockets.append(harness) }
        for path in sockets {
            unlink(path)
        }
        // tugcast's shutdown kills the instance's private tmux server, which
        // leaves its socket file behind. Unlinked only when no server answers
        // on it, so a server that outlived the kill keeps its socket.
        let tmuxRoot = ProcessInfo.processInfo.environment["TMUX_TMPDIR"] ?? "/private/tmp"
        let tmuxSocket = "\(tmuxRoot)/tmux-\(getuid())/tug-\(InstanceConfig.shortToken)"
        if !unixSocketAnswers(tmuxSocket) {
            unlink(tmuxSocket)
        }
        let dataDir = InstanceConfig.dataDir
        guard dataDir.lastPathComponent.hasPrefix(InstanceConfig.apptestIDPrefix) else { return }
        try? manager.removeItem(at: dataDir)
    }

    /// Whether a listener accepts a connection on the Unix socket at `path`.
    private static func unixSocketAnswers(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, length) == 0 }
        }
    }

    /// Returns the socket path from `TUGAPP_TEST_SOCKET` if set and
    /// non-empty; nil otherwise. Used by `main.swift` / `AppDelegate`
    /// to decide whether to activate the harness.
    static func envSocketPath() -> String? {
        let env = ProcessInfo.processInfo.environment["TUGAPP_TEST_SOCKET"]
        guard let env = env, !env.isEmpty else { return nil }
        return env
    }
}
#endif
