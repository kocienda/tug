import Foundation
import SQLite3

// MARK: - TugbankValue

/// A typed value stored in a tugbank domain.
/// Matches the Rust `Value` enum and the SQL column encoding.
enum TugbankValue {
    case null
    case bool(Bool)
    case i64(Int64)
    case f64(Double)
    case string(String)
    case json(Any)

    // value_kind discriminators (must match tugbank-core/src/value.rs)
    static let kindNull: Int32 = 0
    static let kindBool: Int32 = 1
    static let kindI64: Int32 = 2
    static let kindF64: Int32 = 3
    static let kindString: Int32 = 4
    static let kindBytes: Int32 = 5
    static let kindJson: Int32 = 6

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}

// MARK: - TugbankClient

/// Native SQLite client for the tugbank defaults store.
///
/// Opens the per-instance tugbank DB (`InstanceConfig.tugbankDbPath`)
/// directly via the system libsqlite3. No Rust FFI, no external
/// dependencies. Reads and writes use the same schema as tugbank-core
/// (domains/entries tables, value_kind discriminator).
///
/// After a write, sends a datagram to the per-instance tugcast
/// notification socket (`InstanceConfig.notifySocketPath`) so other
/// processes can react.
final class TugbankClient {

    /// Shared singleton. Call `configure(path:)` once before accessing.
    private(set) static var shared: TugbankClient?

    /// Configure the shared instance. Returns the client, or nil on failure.
    @discardableResult
    static func configure(path: String) -> TugbankClient? {
        guard shared == nil else { return shared }
        guard let client = TugbankClient(path: path) else { return nil }
        shared = client
        return client
    }

    // MARK: Private state

    private var db: OpaquePointer?

    // MARK: Init / Deinit

    private init?(path: String) {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            if db != nil { sqlite3_close(db) }
            return nil
        }
        // Apply pragmas (must match tugbank-core/src/schema.rs)
        sqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA foreign_keys = ON", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA busy_timeout = 5000", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA synchronous = NORMAL", nil, nil, nil)
    }

    deinit {
        if db != nil { sqlite3_close(db) }
    }

    // MARK: Public API

    /// Read a single value from a domain.
    func get(domain: String, key: String) -> TugbankValue? {
        let sql = "SELECT value_kind, value_i64, value_f64, value_text FROM entries WHERE domain = ? AND key = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (domain as NSString).utf8String, -1, nil)
        sqlite3_bind_text(stmt, 2, (key as NSString).utf8String, -1, nil)

        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return decodeRow(stmt)
    }

    /// Write a value to a domain. Sends a notification datagram after success.
    @discardableResult
    func set(domain: String, key: String, value: TugbankValue) -> Bool {
        let now = ISO8601DateFormatter().string(from: Date())

        // BEGIN IMMEDIATE
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }

        // Ensure domain row exists
        let domainSQL = "INSERT OR IGNORE INTO domains (name, generation, updated_at) VALUES (?, 0, ?)"
        if !execBind(domainSQL, bindings: { stmt in
            sqlite3_bind_text(stmt, 1, (domain as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (now as NSString).utf8String, -1, nil)
        }) {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            return false
        }

        // Upsert the entry
        let upsertSQL = """
            INSERT INTO entries (domain, key, value_kind, value_i64, value_f64, value_text, value_blob, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT(domain, key) DO UPDATE SET
              value_kind = excluded.value_kind, value_i64 = excluded.value_i64,
              value_f64 = excluded.value_f64, value_text = excluded.value_text,
              value_blob = excluded.value_blob, updated_at = excluded.updated_at
            """
        let (kind, i64v, f64v, textv) = encodeValue(value)
        if !execBind(upsertSQL, bindings: { stmt in
            sqlite3_bind_text(stmt, 1, (domain as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (key as NSString).utf8String, -1, nil)
            sqlite3_bind_int(stmt, 3, kind)
            if let v = i64v { sqlite3_bind_int64(stmt, 4, v) } else { sqlite3_bind_null(stmt, 4) }
            if let v = f64v { sqlite3_bind_double(stmt, 5, v) } else { sqlite3_bind_null(stmt, 5) }
            if let v = textv { sqlite3_bind_text(stmt, 6, (v as NSString).utf8String, -1, nil) } else { sqlite3_bind_null(stmt, 6) }
            sqlite3_bind_text(stmt, 7, (now as NSString).utf8String, -1, nil)
        }) {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            return false
        }

        // Bump generation
        let genSQL = "UPDATE domains SET generation = generation + 1, updated_at = ? WHERE name = ?"
        if !execBind(genSQL, bindings: { stmt in
            sqlite3_bind_text(stmt, 1, (now as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (domain as NSString).utf8String, -1, nil)
        }) {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            return false
        }

        // COMMIT
        guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            return false
        }

        // Notify tugcast
        broadcastDomainChanged(domain)
        return true
    }

    /// List all domain names.
    func listDomains() -> [String] {
        let sql = "SELECT name FROM domains ORDER BY name"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }

        var domains: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let cstr = sqlite3_column_text(stmt, 0) {
                domains.append(String(cString: cstr))
            }
        }
        return domains
    }

    // MARK: Convenience

    func getString(domain: String, key: String) -> String? {
        return get(domain: domain, key: key)?.stringValue
    }

    func getBool(domain: String, key: String) -> Bool {
        guard let value = get(domain: domain, key: key) else { return false }
        switch value {
        case .bool(let b): return b
        case .string(let s): return s.caseInsensitiveCompare("true") == .orderedSame
        default: return false
        }
    }

    /// A number: an `f64` or `i64` as it is, or a string that reads as one.
    func getDouble(domain: String, key: String) -> Double? {
        guard let value = get(domain: domain, key: key) else { return nil }
        switch value {
        case .f64(let d): return d
        case .i64(let i): return Double(i)
        case .string(let s): return Double(s.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    @discardableResult
    func setString(domain: String, key: String, value: String) -> Bool {
        return set(domain: domain, key: key, value: .string(value))
    }

    @discardableResult
    func setBool(domain: String, key: String, value: Bool) -> Bool {
        return set(domain: domain, key: key, value: .bool(value))
    }

    // MARK: Private — value encoding/decoding

    private func encodeValue(_ value: TugbankValue) -> (Int32, Int64?, Double?, String?) {
        switch value {
        case .null:
            return (TugbankValue.kindNull, nil, nil, nil)
        case .bool(let b):
            return (TugbankValue.kindBool, b ? 1 : 0, nil, nil)
        case .i64(let n):
            return (TugbankValue.kindI64, n, nil, nil)
        case .f64(let f):
            return (TugbankValue.kindF64, nil, f, nil)
        case .string(let s):
            return (TugbankValue.kindString, nil, nil, s)
        case .json(let obj):
            if let data = try? JSONSerialization.data(withJSONObject: obj),
               let text = String(data: data, encoding: .utf8) {
                return (TugbankValue.kindJson, nil, nil, text)
            }
            return (TugbankValue.kindNull, nil, nil, nil)
        }
    }

    private func decodeRow(_ stmt: OpaquePointer?) -> TugbankValue? {
        let kind = sqlite3_column_int(stmt, 0)
        switch kind {
        case TugbankValue.kindNull:
            return .null
        case TugbankValue.kindBool:
            return .bool(sqlite3_column_int64(stmt, 1) != 0)
        case TugbankValue.kindI64:
            return .i64(sqlite3_column_int64(stmt, 1))
        case TugbankValue.kindF64:
            return .f64(sqlite3_column_double(stmt, 2))
        case TugbankValue.kindString:
            if let cstr = sqlite3_column_text(stmt, 3) {
                return .string(String(cString: cstr))
            }
            return .string("")
        case TugbankValue.kindJson:
            if let cstr = sqlite3_column_text(stmt, 3) {
                let text = String(cString: cstr)
                if let data = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) {
                    return .json(obj)
                }
            }
            return .null
        default:
            return nil
        }
    }

    // MARK: Private — SQL helpers

    private func execBind(_ sql: String, bindings: (OpaquePointer?) -> Void) -> Bool {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        bindings(stmt)
        return sqlite3_step(stmt) == SQLITE_DONE
    }

    // MARK: Private — notification

    private func broadcastDomainChanged(_ domain: String) {
        let socketPath = InstanceConfig.notifySocketPath.path

        let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { return }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return }
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { sunPath in
            pathBytes.withUnsafeBufferPointer { buf in
                memcpy(sunPath, buf.baseAddress!, buf.count)
            }
        }

        let domainBytes = Array(domain.utf8)
        withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                _ = sendto(fd, domainBytes, domainBytes.count, 0, sockaddrPtr,
                          socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }
}
