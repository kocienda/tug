import Foundation

/// Build-time identity baked into the app bundle's Info.plist by
/// `tugrust/scripts/capture-build-info.sh` (Xcode Run Script build
/// phase). Read-once on first access; freezes for the process lifetime.
///
/// References: the multi-instance design record, [D01]-[D03].
enum BuildInfo {
    /// Build profile, derived from xcodebuild's `$CONFIGURATION`:
    /// "debug" (Debug) or "release" (Release), per [D19].
    static let profile: String = requireString("BuildProfile")

    /// Branch the bundle was built from. For builds made from a
    /// detached HEAD, the value is `detached-<sha8>` per [D02].
    static let branch: String = requireString("BuildBranch")

    /// Absolute path to the repo root the bundle was built from.
    /// Debug builds only — release builds intentionally omit this
    /// key per [D03].
    static let sourceTree: String? = Bundle.main
        .object(forInfoDictionaryKey: "BuildSourceTree") as? String

    /// Full SHA-1 of HEAD at build time. Diagnostic only.
    static let commit: String = requireString("BuildCommit")

    /// `CFBundleIdentifier` from Info.plist. Assigned per
    /// (profile, branch) by the assign-bundle-id build phase from
    /// Step 2; until that lands, this is the static `dev.tugapp.app`.
    static let bundleId: String = Bundle.main.bundleIdentifier ?? ""

    /// `branch` normalized via `BranchSlug.compute`. Suitable for use
    /// as a filesystem path component, tmux session suffix, or
    /// bundle-ID segment.
    static let branchSlug: String = BranchSlug.compute(branch)

    /// Canonical per-instance identifier, `<profile>-<branchSlug>`.
    /// Used as the per-instance data-dir name, tmux session suffix,
    /// registry key, and the value carried by `TUG_INSTANCE_ID`.
    static let instanceId: String = "\(profile)-\(branchSlug)"

    // MARK: - Internals

    private static func requireString(_ key: String) -> String {
        guard
            let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
            !value.isEmpty,
            value != "UNSET-AT-BUILD-TIME"
        else {
            fatalError(
                "BuildInfo: Info.plist key '\(key)' was not populated. " +
                "This bundle was built without the capture-build-info build phase. " +
                "Rebuild via `just app` (or rerun xcodebuild after the build phase is registered)."
            )
        }
        return value
    }
}
