import Foundation

/// Brings the data a stranded instance wrote into the instance the released
/// app runs as, once, before anything of this launch opens either.
///
/// A released Tug is the instance `release-main`, and its data dir is
/// `instances/release-main/`. v0.9.5 was built on a detached HEAD, so it ran
/// as `release-detached-3937df43` under the bundle identifier
/// `dev.tugapp.app.release-detached-3937df43`: an empty data dir and empty
/// preferences for everyone who installed it. Every release after it is
/// `release-main` again (`tugrust/scripts/stamp-distribution-identity.sh`),
/// which on its own would hand a v0.9.5 user their pre-0.9.5 state, or none,
/// and strand what they have now.
///
/// What they have now is what they keep. On the first launch that finds the
/// stranded dir, the dir becomes `instances/release-main/` whole, databases
/// with their WAL files beside them, and the stranded preferences are laid
/// over this bundle's. A `release-main` dir already there is from before
/// v0.9.5; it is retired by rename under `retired/`, never deleted ([D218]).
/// A symlink is left at the stranded path, because card state and prompt
/// history hold absolute paths into `draft-attachments/` there, and it is
/// also what says the adoption is done: a stranded path that is a symlink,
/// or absent, is left alone.
///
/// The machine-wide session index files each session under the instance
/// that recorded it; tugcast rewrites those rows at its next open
/// (`tugcore::session_index::SessionIndex::adopt_instance`).
///
/// Foundation-only, and free of `InstanceConfig`, so the `TugTests` bundle
/// compiles it; `main.swift` supplies the real paths and liveness.
enum InstanceAdoption {
    /// The instance every released build runs as.
    static let releaseInstanceId = "release-main"
    /// The bundle identifier every released build carries.
    static let releaseBundleId = "dev.tugapp.app"
    /// The instance v0.9.5 ran as. Kept in sync with
    /// `tugcore::instance::STRANDED_RELEASE_INSTANCE`.
    static let strandedInstanceId = "release-detached-3937df43"
    /// The bundle identifier v0.9.5 carried.
    static let strandedBundleId = "dev.tugapp.app.release-detached-3937df43"

    enum Outcome: Equatable {
        /// This launch is not `release-main`, or there is no stranded dir.
        case nothingToAdopt
        /// A process still holds one of the two dirs; try the next launch.
        case deferredWhileLive
        /// The stranded dir is now this instance's. `retired` is where a
        /// `release-main` dir that was already there went, if there was one.
        case adopted(retired: URL?)
        /// A rename failed; both dirs are as they were found.
        case failed(String)
    }

    /// Adopt `strandedInstanceId`'s data dir as `instanceId`'s.
    ///
    /// - `dataRoot`: the `Tug/` directory holding `instances/` and `retired/`.
    /// - `instanceId`: this process's instance. Anything but
    ///   `releaseInstanceId` adopts nothing.
    /// - `isLive`: whether a running Tug other than this process holds the
    ///   named instance.
    /// - `now`: stamps the retired dir's name.
    static func adopt(
        dataRoot: URL,
        instanceId: String,
        isLive: (String) -> Bool,
        now: Date = Date(),
        fileManager fm: FileManager = .default
    ) -> Outcome {
        guard instanceId == releaseInstanceId else { return .nothingToAdopt }
        let instances = dataRoot.appendingPathComponent("instances", isDirectory: true)
        let stranded = instances.appendingPathComponent(strandedInstanceId, isDirectory: true)
        let home = instances.appendingPathComponent(releaseInstanceId, isDirectory: true)

        guard isRealDirectory(stranded, fm) else { return .nothingToAdopt }
        if isLive(strandedInstanceId) || isLive(releaseInstanceId) {
            return .deferredWhileLive
        }

        var retired: URL?
        if fm.fileExists(atPath: home.path) {
            let retiredRoot = dataRoot.appendingPathComponent("retired", isDirectory: true)
            do {
                try fm.createDirectory(at: retiredRoot, withIntermediateDirectories: true)
                let dest = freeName(in: retiredRoot, base: "\(releaseInstanceId)-\(Int(now.timeIntervalSince1970))", fm)
                try fm.moveItem(at: home, to: dest)
                retired = dest
            } catch {
                return .failed("retire \(home.path): \(error.localizedDescription)")
            }
        }

        do {
            try fm.moveItem(at: stranded, to: home)
        } catch {
            // Put the earlier dir back, so a failure leaves what was found.
            if let retired { try? fm.moveItem(at: retired, to: home) }
            return .failed("adopt \(stranded.path): \(error.localizedDescription)")
        }

        // Paths recorded under the stranded name still resolve. Relative, so
        // it survives the data root being moved.
        try? fm.createSymbolicLink(atPath: stranded.path, withDestinationPath: releaseInstanceId)
        return .adopted(retired: retired)
    }

    /// The preferences this bundle should hold after an adoption: its own,
    /// with every key v0.9.5 wrote laid over them.
    static func mergedDefaults(own: [String: Any], stranded: [String: Any]) -> [String: Any] {
        own.merging(stranded) { _, theirs in theirs }
    }

    /// Lay the stranded bundle's preferences over this bundle's. Only the
    /// released bundle identifier takes them; a nightly or a developer's
    /// build shares the data dir and keeps its own preferences.
    static func adoptDefaults(bundleId: String, defaults: UserDefaults = .standard) {
        guard bundleId == releaseBundleId,
              let stranded = defaults.persistentDomain(forName: strandedBundleId),
              !stranded.isEmpty else { return }
        let own = defaults.persistentDomain(forName: bundleId) ?? [:]
        defaults.setPersistentDomain(mergedDefaults(own: own, stranded: stranded), forName: bundleId)
    }

    /// True for a directory that is there in its own right; false for a
    /// symlink, a file, or nothing.
    private static func isRealDirectory(_ url: URL, _ fm: FileManager) -> Bool {
        guard let type = (try? fm.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType else {
            return false
        }
        return type == .typeDirectory
    }

    private static func freeName(in dir: URL, base: String, _ fm: FileManager) -> URL {
        var dest = dir.appendingPathComponent(base, isDirectory: true)
        var n = 1
        while fm.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent("\(base)-\(n)", isDirectory: true)
            n += 1
        }
        return dest
    }
}
