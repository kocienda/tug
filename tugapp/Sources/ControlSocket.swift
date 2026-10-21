import Foundation

/// Parsed control socket message
struct ControlMessage {
    let type: String
    let data: [String: Any]

    init?(json: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        self.type = type
        self.data = obj
    }
}

/// UDS server: creates socket, listens for connections
class ControlSocketListener {
    let path: String
    private var socketFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    /// Callback when a new client connects
    var onConnection: ((ControlSocketConnection) -> Void)?

    init(path: String) throws {
        self.path = path
        // Delete stale socket file
        unlink(path)
        // Create Unix domain socket
        socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else { throw POSIXError(.init(rawValue: errno)!) }
        // Bind
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutableBytes(of: &addr.sun_path) { dst in
            path.withCString { src in
                strlcpy(dst.baseAddress!.assumingMemoryBound(to: CChar.self), src, dst.count)
            }
        }
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(socketFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else { Darwin.close(socketFD); throw POSIXError(.init(rawValue: errno)!) }
        // Listen
        guard Darwin.listen(socketFD, 5) == 0 else { Darwin.close(socketFD); throw POSIXError(.init(rawValue: errno)!) }
        // Set up dispatch source for async accept
        let source = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: .global())
        source.setEventHandler { [weak self] in
            self?.handleAccept()
        }
        source.resume()
        self.acceptSource = source
    }

    private func handleAccept() {
        let clientFD = Darwin.accept(socketFD, nil, nil)
        guard clientFD >= 0 else { return }
        let connection = ControlSocketConnection(fd: clientFD)
        onConnection?(connection)
    }

    func close() {
        acceptSource?.cancel()
        acceptSource = nil
        if socketFD >= 0 {
            Darwin.close(socketFD)
            socketFD = -1
        }
        unlink(path)
    }

    deinit { close() }
}

/// Single UDS connection: read/write newline-delimited JSON messages
class ControlSocketConnection {
    private let fileHandle: FileHandle
    private var buffer = Data()

    /// Callback for each complete message received
    var onMessage: ((ControlMessage) -> Void)?

    /// Callback when connection closes (EOF or error)
    var onDisconnect: (() -> Void)?

    /// Answers a message on the socket's own read queue, without the hop to
    /// the main thread every other message takes. Return a reply to send it
    /// and consume the message; return nil to let the message go to
    /// `onMessage` as usual.
    ///
    /// This is for the one question that must be answerable while the main
    /// thread is stuck — the host state probe — so it must not touch
    /// anything main-confined. It is assigned on the main thread after
    /// reading has already begun, so it is held under a lock of its own.
    var offMainResponder: ((ControlMessage) -> [String: Any]?)? {
        get { responderLock.withLock { responder } }
        set { responderLock.withLock { responder = newValue } }
    }
    private var responder: ((ControlMessage) -> [String: Any]?)?
    private let responderLock = NSLock()

    /// Serializes writes: the off-main responder and the main thread both
    /// send, and one message must never interleave with another.
    private let writeLock = NSLock()

    init(fd: Int32) {
        self.fileHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        // Start reading
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
        // Split on newlines to extract complete JSON messages
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            buffer = Data(buffer[(newlineIndex + 1)...])  // +1 to skip the newline
            if let msg = ControlMessage(json: Data(lineData)) {
                if let reply = offMainResponder?(msg) {
                    send(reply)
                    continue
                }
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?(msg)
                }
            }
        }
    }

    /// Send a JSON message (newline-terminated).
    ///
    /// Uses `FileHandle.write(contentsOf:)` (macOS 10.15.4+) rather than
    /// the Obj-C-bridged `write(_:)`. The bridged variant raises
    /// `NSFileHandleOperationException` on a broken pipe (e.g., when
    /// the peer process has died), which Swift cannot catch — the
    /// uncaught Obj-C exception terminates the host. The Swift-throwing
    /// API surfaces the same condition as a catchable Swift error so
    /// a stale send after the peer's death drops the message instead
    /// of taking the app down. Pairs with the disconnect-side cleanup
    /// in `ProcessManager.handleDisconnect`, which clears the
    /// connection ref so callers normally hit the early-return guard
    /// in `sendControl` before reaching this method at all.
    func send(_ dict: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: dict),
              var payload = String(data: jsonData, encoding: .utf8) else { return }
        payload.append("\n")
        guard let data = payload.data(using: .utf8) else { return }
        writeLock.lock()
        defer { writeLock.unlock() }
        do {
            try fileHandle.write(contentsOf: data)
        } catch {
            NSLog(
                "ControlSocketConnection: write failed: %@",
                error.localizedDescription
            )
        }
    }

    func close() {
        fileHandle.readabilityHandler = nil
        fileHandle.closeFile()
    }
}
