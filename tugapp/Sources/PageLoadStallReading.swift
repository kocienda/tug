import Darwin
import Foundation

// A reading of the machine, taken while a shell page load is stalled.
//
// `PageLoadStallWatch` decides when; this writes what. The reading lands in
// `<data-dir>/stalls/<UTC time>/`, beside the readings `tugtool host instance
// quit` writes for a slow quit, and in the same shape: one file per reading
// and a `stall.json` that names them, says why the reading was taken, and
// records each reading's exit status or error. An app-test instance writes
// it instead under the directory its runner names (`apptestStallRoot`),
// starting with a `trigger.json` the runner halts its batch on.
//
// The readings:
//
// - `unified-log.txt`: the last three minutes of unified-log lines from the
//   WebKit processes and from Tug itself, which is where a GPU process being
//   declared unresponsive is written.
// - `footprint-<pid>.txt`: `footprint` of Tug, its content process, and its
//   GPU process — or, when WebKit does not name the GPU process, of every
//   WebKit GPU process on the machine, since the wedge is shared.
// - `processes.txt`: every process, with its parent, age, CPU and memory.
// - `apptest-gate.txt`: who holds the app-test gate, if anyone.
//
// All of it runs off the main thread, every reading at once, each under its
// own deadline, so the reading is bounded no matter what the wedge does to
// the commands it runs.

/// What the window knows about the stall when it asks for a reading.
struct PageLoadStallContext {
    let trigger: PageLoadStallTrigger
    let url: String?
    let hostPid: pid_t
    let contentPid: pid_t?
    let gpuPid: pid_t?
}

enum PageLoadStallReading {
    /// The longest any one reading may run. `log show` is the slow one; a
    /// wedged machine can make it slower still, and a reading that never
    /// finishes is worth less than one that is cut short.
    static let readingDeadline: TimeInterval = 20.0

    /// The app-test gate's well-known port. Mirrors `APPTEST_GATE_PORT` in
    /// `tugrust/crates/tugcore/src/ports.rs`; the gate's holder answers every
    /// connection with one JSON greeting line naming itself.
    static let apptestGatePort: UInt16 = 55600

    /// The most GPU processes footprinted when WebKit does not say which is
    /// Tug's. Each `footprint` costs a second or so.
    static let maxGpuFootprints = 6

    private static let queue = DispatchQueue(label: "dev.tugapp.page-load-stall-reading", qos: .utility)

    /// Take a reading in the background. `done` is called on the main queue
    /// with the directory written, or `nil` when the directory could not be
    /// made.
    static func capture(_ context: PageLoadStallContext, done: @escaping (URL?) -> Void) {
        let instance = InstanceConfig.instanceId
        let shared = apptestStallRoot
        let root = shared ?? InstanceConfig.dataDir.appendingPathComponent("stalls", isDirectory: true)
        queue.async {
            let dir = write(context, root: root, instance: instance, prefixed: shared != nil)
            DispatchQueue.main.async { done(dir) }
        }
    }

    /// Where an app-test instance writes its readings instead of its own
    /// data directory: the directory the app-test runner names in
    /// `TUG_APPTEST_STALL_DIR`. An app-test instance's data directory is
    /// reclaimed when its file ends, and the reading is wanted after a
    /// reboot, so the runner keeps one directory that outlives both and
    /// watches it — a reading there is what halts a batch on a wedged GPU
    /// service. `nil` for every instance that is not an app-test one.
    static var apptestStallRoot: URL? {
        guard InstanceConfig.isAppTest,
              let path = ProcessInfo.processInfo.environment["TUG_APPTEST_STALL_DIR"], !path.isEmpty
        else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private static func write(_ context: PageLoadStallContext, root: URL, instance: String, prefixed: Bool) -> URL? {
        let at = Date()
        let name = StallReadingText.directoryName(for: at)
        // Many instances share the runner's directory, so there each reading
        // is named for its instance too.
        let dir = root.appendingPathComponent(prefixed ? "\(instance)-\(name)" : name, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            TugLog.error("stall", "could not make the stall directory", [
                TugLog.field("dir", dir.path),
                TugLog.field("error", error.localizedDescription),
            ])
            return nil
        }

        // What fired, written before the slow readings: a runner watching
        // for it halts on this file alone, and the instance may be closed
        // before the readings below finish.
        let trigger: [String: Any] = [
            "kind": "page-load",
            "instance": instance,
            "trigger": context.trigger.name,
            "elapsed_ms": Int(context.trigger.elapsed * 1000),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: trigger, options: [.sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("trigger.json"))
        }

        let processes = run("/bin/ps", ["-axww", "-o", "pid=,ppid=,etime=,%cpu=,rss=,comm="])
        try? processes.output.write(to: dir.appendingPathComponent("processes.txt"))

        // Tug's own GPU process when WebKit names it; otherwise every GPU
        // process on the machine, because the wedge is the machine's.
        var gpuPids: [pid_t] = context.gpuPid.map { [$0] } ?? []
        if gpuPids.isEmpty {
            gpuPids = Array(StallReadingText.pids(named: StallReadingText.gpuProcessName, in: processes.output).prefix(maxGpuFootprints))
        }
        var footprintPids: [pid_t] = [context.hostPid]
        if let content = context.contentPid { footprintPids.append(content) }
        footprintPids.append(contentsOf: gpuPids.filter { !footprintPids.contains($0) })

        let group = DispatchGroup()
        let lock = NSLock()
        var results: [String: Any] = [:]
        func record(_ key: String, _ value: Any) {
            lock.lock()
            results[key] = value
            lock.unlock()
        }

        group.enter()
        DispatchQueue.global(qos: .utility).async {
            let name = ProcessInfo.processInfo.processName
            let predicate = "process BEGINSWITH \"com.apple.WebKit\" OR process == \"\(name)\" OR eventMessage CONTAINS \"GPUProcess\""
            let result = run("/usr/bin/log", ["show", "--last", "3m", "--style", "compact", "--predicate", predicate])
            try? result.output.write(to: dir.appendingPathComponent("unified-log.txt"))
            record("unified_log", result.summary(file: "unified-log.txt"))
            group.leave()
        }

        for pid in footprintPids {
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                let file = "footprint-\(pid).txt"
                let result = run("/usr/bin/footprint", ["\(pid)"])
                try? result.output.write(to: dir.appendingPathComponent(file))
                record("footprint-\(pid)", result.summary(file: file))
                group.leave()
            }
        }

        group.enter()
        DispatchQueue.global(qos: .utility).async {
            let holder = readGateHolder()
            try? Data((holder ?? "not held\n").utf8).write(to: dir.appendingPathComponent("apptest-gate.txt"))
            record("apptest_gate", ["file": "apptest-gate.txt", "held": holder != nil])
            group.leave()
        }

        // Each reading enforces its own deadline; this one is the backstop
        // for a reading that wedges somewhere its own deadline cannot reach.
        if group.wait(timeout: .now() + readingDeadline + 5) == .timedOut {
            record("incomplete", true)
        }

        lock.lock()
        let readings = results
        lock.unlock()
        var stall: [String: Any] = [
            "kind": "page-load",
            "captured_at": ISO8601DateFormatter().string(from: at),
            "instance": instance,
            "trigger": context.trigger.name,
            "elapsed_ms": Int(context.trigger.elapsed * 1000),
            "budget_ms": Int(PageLoadStallWatch.loadBudget * 1000),
            "host_pid": Int(context.hostPid),
            "gpu_pid_named_by_webkit": context.gpuPid != nil,
            "gpu_pids": gpuPids.map { Int($0) },
            "processes": processes.summary(file: "processes.txt"),
            "readings": readings,
        ]
        if let url = context.url { stall["url"] = url }
        if let content = context.contentPid { stall["content_pid"] = Int(content) }
        if let data = try? JSONSerialization.data(withJSONObject: stall, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("stall.json"))
        }
        return dir
    }

    // MARK: - Running a reading

    private struct RunResult {
        let output: Data
        let exit: Int32?
        let error: String?

        func summary(file: String) -> [String: Any] {
            var summary: [String: Any] = ["file": file]
            if let exit { summary["exit"] = Int(exit) }
            if let error { summary["error"] = error }
            return summary
        }
    }

    /// Run `path` with `arguments` under the reading deadline, collecting
    /// standard output and standard error together. A command still running
    /// at the deadline is terminated and its partial output kept.
    private static func run(_ path: String, _ arguments: [String]) -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        let collected = NSMutableData()
        // The reader may still be appending when the wait below gives up on
        // it (a child that ignores SIGTERM holds the pipe open), so every
        // touch of the buffer is under one lock.
        let collectedLock = NSLock()
        let readDone = DispatchSemaphore(value: 0)
        let reader = pipe.fileHandleForReading
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                collectedLock.lock()
                collected.append(chunk)
                collectedLock.unlock()
            }
            readDone.signal()
        }

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            try? pipe.fileHandleForWriting.close()
            readDone.wait()
            return RunResult(output: Data(), exit: nil, error: error.localizedDescription)
        }
        var timedOut = false
        if exited.wait(timeout: .now() + readingDeadline) == .timedOut {
            timedOut = true
            process.terminate()
            _ = exited.wait(timeout: .now() + 2)
        }
        try? pipe.fileHandleForWriting.close()
        _ = readDone.wait(timeout: .now() + 2)
        collectedLock.lock()
        let output = Data(referencing: collected)
        collectedLock.unlock()
        return RunResult(
            output: output,
            exit: process.isRunning ? nil : process.terminationStatus,
            error: timedOut ? "timed out after \(Int(readingDeadline)) s" : nil
        )
    }

    /// The app-test gate's holder greeting, or `nil` when nothing holds it.
    /// Connecting reads the holder's live metadata; closing the connection
    /// leaves the holder exactly as it was.
    private static func readGateHolder() -> String? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = apptestGatePort.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: 1024)
        let count = recv(fd, &buffer, buffer.count, 0)
        guard count > 0 else { return "held, but the holder sent no greeting\n" }
        return String(decoding: buffer[0..<count], as: UTF8.self)
    }
}
