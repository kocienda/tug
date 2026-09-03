import Foundation

/// The app's log file, written beside tugcast's in the same format.
///
/// Tug's logs live in the per-instance `Logs/` directory
/// (`InstanceConfig.logDir`), and until now only the Rust side could write
/// there: `NSLog` goes to Console, which is not where anyone reads Tug's logs
/// and not where `just logs-debug` looks. This writes `tugapp.log.<UTC-date>`
/// into that directory, so one command shows the whole system and one parser
/// reads both halves of it.
///
/// It is a **separate file** rather than an append to `tugcast.log.*` because
/// tugcast's `tracing_appender` owns that file's rotation and buffering; a
/// second process writing into it would race the rotation. Same directory,
/// same format, same UTC rolling boundary makes the two files one log for
/// reading purposes without making them one file for writing purposes.
///
/// The facility is general. Per-request instrumentation was its first client,
/// not its subject — the app's existing `NSLog` call sites are free to move
/// here.
///
/// Writes are serialized on a private queue and dispatched asynchronously, so
/// no caller ever waits on file I/O. A crash can therefore lose the last few
/// lines; that is the trade for never putting a file write on a latency path.
enum TugLog {
    /// Severity, ordered so a threshold is a comparison.
    ///
    /// The labels are tuglog's, right-aligned to five characters, which is what
    /// makes a `tugapp.log` line and a `tugcast.log` line column-align.
    enum Level: Int, Comparable {
        case debug = 0
        case info = 1
        case warn = 2
        case error = 3

        var label: String {
            switch self {
            case .debug: return "DEBUG"
            case .info: return " INFO"
            case .warn: return " WARN"
            case .error: return "ERROR"
            }
        }

        init?(name: String) {
            switch name.lowercased() {
            case "debug", "trace": self = .debug
            case "info": self = .info
            case "warn", "warning": self = .warn
            case "error": self = .error
            default: return nil
            }
        }

        static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    /// One `key=value` pair. Call sites build their fields with this so the
    /// spacing and ordering are the writer's business rather than each caller's.
    static func field(_ key: String, _ value: CustomStringConvertible) -> String {
        "\(key)=\(value)"
    }

    static func debug(_ subsystem: String, _ message: String, _ fields: [String] = []) {
        write(.debug, subsystem, message, fields)
    }

    static func info(_ subsystem: String, _ message: String, _ fields: [String] = []) {
        write(.info, subsystem, message, fields)
    }

    static func warn(_ subsystem: String, _ message: String, _ fields: [String] = []) {
        write(.warn, subsystem, message, fields)
    }

    static func error(_ subsystem: String, _ message: String, _ fields: [String] = []) {
        write(.error, subsystem, message, fields)
    }

    /// Announce the file, mirroring tuglog's `tuglog initialized` line.
    ///
    /// Called once at launch so the file is never zero-length and names its own
    /// path — the question "where is the app writing?" is answered by the first
    /// line of the answer.
    static func start() {
        info("tuglog", "tuglog initialized", [field("name", "tugapp"), field("log_dir", directory.path)])
    }

    // MARK: - Internals

    /// The threshold, read once from `TUG_LOG`, mirroring tuglog's `RUST_LOG`.
    private static let threshold: Level = {
        let name = ProcessInfo.processInfo.environment["TUG_LOG"] ?? ""
        return Level(name: name) ?? .info
    }()

    private static let directory = InstanceConfig.logDir

    private static let queue = DispatchQueue(label: "dev.tugapp.tuglog")

    /// ISO8601 to the second; the microseconds are appended by `stamp` because
    /// `DateFormatter` resolves no finer than milliseconds and the format
    /// `tracing_subscriber` writes has six digits.
    private static let seconds: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private static func stamp(_ date: Date) -> String {
        let epoch = date.timeIntervalSince1970
        let micros = Int((epoch - epoch.rounded(.down)) * 1_000_000) % 1_000_000
        return String(format: "%@.%06dZ", seconds.string(from: date), micros)
    }

    /// The UTC day, which is how `tracing_appender::rolling::daily` names its
    /// files — so the two logs roll at the same instant.
    private static let days: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    /// Open handle and the day it belongs to. Both are touched only on `queue`.
    private static var handle: FileHandle?
    private static var openDay: String?

    private static func write(_ level: Level, _ subsystem: String, _ message: String, _ fields: [String]) {
        guard level >= threshold else { return }
        let now = Date()
        let line = ([
            "\(stamp(now)) \(level.label) tugapp::\(subsystem): \(message)",
        ] + fields).joined(separator: " ") + "\n"
        queue.async {
            guard let handle = handle(for: days.string(from: now)) else { return }
            try? handle.write(contentsOf: Data(line.utf8))
        }
    }

    /// The append handle for one UTC day, opened once and reopened when the day
    /// turns under a long-running app. Queue-confined.
    private static func handle(for day: String) -> FileHandle? {
        if let open = handle, openDay == day {
            return open
        }
        try? handle?.close()
        handle = nil
        openDay = nil

        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("tugapp.log.\(day)")
        if !FileManager.default.fileExists(atPath: path.path) {
            FileManager.default.createFile(atPath: path.path, contents: nil)
        }
        guard let opened = try? FileHandle(forWritingTo: path) else { return nil }
        _ = try? opened.seekToEnd()
        handle = opened
        openDay = day
        return opened
    }
}
