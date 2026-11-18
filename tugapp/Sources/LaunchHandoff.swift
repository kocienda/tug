import Darwin
import Foundation

/// Whether this launch should hand off to a copy of Tug already running
/// under the same instance identity, decided before `AppDelegate` exists.
///
/// Two copies of Tug on disk with one identity — a local Release build and
/// an installed one — are the same app to macOS, so anything it routes by
/// bundle ID (a notification click, the Dock, Spotlight, a file open) can
/// launch the copy that is not running. Without this check that copy opens
/// tugbank, starts the updater, purges the web cache and spawns a tugcast
/// that is refused as a duplicate, and the user gets an alert instead of
/// the card or file they asked for.
///
/// The decision reads `$TMPDIR/tug-instances.json`, the registry each
/// tugcast writes once it is up, and looks up this process's instance by ID
/// rather than bundle ID, because app-test launches share one bundle ID
/// across many instances. It hands off only when the entry's `host_pid` is
/// alive, is not this process, and is running from the entry's
/// `bundle_path`; anything less proceeds with a normal launch, which still
/// reaches tugcast's duplicate guard and the takeover alert as a fallback.
/// A same-path second launch (`open -n`) is treated the same as a
/// different-path one.
///
/// An `apptest-*` instance always proceeds unless its launch sets
/// `envOptIn`, so the one app-test that exercises the hand-off is the only
/// harness launch it can touch.
///
/// Foundation-only, and free of `InstanceConfig`, so the `TugTests` bundle
/// compiles it: the decision itself is a pure function over its inputs,
/// and `decideForThisLaunch` in `LaunchHandoffDelegate.swift` supplies the
/// real identity, registry, liveness and executable-path readings.
enum LaunchHandoff {
    /// Environment variable an app-test sets to turn the hand-off on for an
    /// `apptest-*` instance. Kept in sync with the app-test that sets it.
    static let envOptIn = "TUGAPP_LAUNCH_HANDOFF"

    /// The running copy's registry entry, as much of it as a hand-off needs.
    struct Entry: Equatable {
        let instanceId: String
        let bundlePath: String
        let hostPid: Int32
        let tugcastPort: Int
    }

    enum Decision: Equatable {
        /// Launch normally.
        case proceed
        /// Pass this launch's intent to the running copy and quit.
        case handOff(Entry)
    }

    /// The decision, over its inputs.
    ///
    /// - `entry`: the registry entry for this process's instance ID, if any.
    /// - `ownPid`: this process.
    /// - `isAppTest` / `optedIn`: an `apptest-*` instance proceeds unless
    ///   opted in.
    /// - `isAlive`: whether a pid names a live process.
    /// - `executablePath`: a live pid's executable path.
    /// - `canonical`: resolves a path to the form `executablePath` reports
    ///   (symlinks resolved), so a bundle recorded through a symlinked
    ///   directory still matches the process running from it.
    static func decide(
        entry: Entry?,
        ownPid: Int32,
        isAppTest: Bool,
        optedIn: Bool,
        isAlive: (Int32) -> Bool,
        executablePath: (Int32) -> String?,
        canonical: (String) -> String = { $0 }
    ) -> Decision {
        if isAppTest && !optedIn { return .proceed }
        guard let entry, entry.hostPid > 0, entry.hostPid != ownPid,
              !entry.bundlePath.isEmpty,
              isAlive(entry.hostPid),
              let exe = executablePath(entry.hostPid) else {
            return .proceed
        }
        var bundle = canonical(entry.bundlePath)
        while bundle.count > 1 && bundle.hasSuffix("/") { bundle.removeLast() }
        guard canonical(exe).hasPrefix(bundle + "/") else { return .proceed }
        return .handOff(entry)
    }

    /// The entry for `instanceId` in a registry document, or nil when the
    /// document does not parse or holds no such entry. An entry written
    /// before `host_pid` existed reads as `hostPid == 0`, which never hands
    /// off.
    static func entry(in registry: Data, instanceId: String) -> Entry? {
        guard let json = try? JSONSerialization.jsonObject(with: registry) as? [String: Any],
              let instances = json["instances"] as? [[String: Any]] else {
            return nil
        }
        for item in instances where (item["instance_id"] as? String) == instanceId {
            return Entry(
                instanceId: instanceId,
                bundlePath: item["bundle_path"] as? String ?? "",
                hostPid: Int32(truncatingIfNeeded: item["host_pid"] as? Int ?? 0),
                tugcastPort: item["tugcast_port"] as? Int ?? 0
            )
        }
        return nil
    }

    /// The registry tugcast writes, `$TMPDIR/tug-instances.json`. Mirrors
    /// `tugcore::registry::registry_path`.
    static var registryURL: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("tug-instances.json")
    }

    /// True when `pid` names a live process, including one this process
    /// may not signal.
    static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// The executable path of a live process, or nil.
    static func executablePath(of pid: Int32) -> String? {
        // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN; the macro does not
        // import into Swift.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(cString: buffer)
    }
}
