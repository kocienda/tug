import Foundation

/// The rules every path-taking script message handler applies before it
/// touches the file system.
///
/// The page is not trusted to name paths. The deck's own requests are always
/// legitimate, but the handlers are reachable by anything that runs in the
/// web view, so each one gets the narrowest root its job needs. The common
/// rules mirror tugcast's `guard_absolute_path`: expand `~` once, require an
/// absolute path, refuse any `.` or `..` component, and resolve symlinks
/// before the root check, so a link inside home cannot carry a write outside it.
///
/// Root membership is decided by file identity (device and inode) rather
/// than by string prefix. A project opened through `/u` resolves to
/// `/System/Volumes/Data/Users/…`, which is home by firmlink and not by
/// spelling; a prefix check would refuse it.
///
/// "The user's own space" is home and the per-user temporary directory
/// (`NSTemporaryDirectory()`, mode 700 under `/var/folders`). Scratch
/// projects live in the second, and an attachment in one must still trash
/// and restore; neither root reaches a file another user or the system owns.
///
/// Pure Foundation, so `tests/bridge-path-guard/` runs it under `swift -`
/// against the same source the app builds.
struct BridgePathGuard {
    /// Why a path was refused, in words the deck can show.
    struct Refusal: Error, Equatable {
        let reason: String
    }

    let home: URL
    let temporary: URL
    let trash: URL

    /// The guard for the user the app runs as.
    static let user: BridgePathGuard = {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let trash = fm.urls(for: .trashDirectory, in: .userDomainMask).first
            ?? home.appendingPathComponent(".Trash")
        let temporary = URL(fileURLWithPath: NSTemporaryDirectory())
        return BridgePathGuard(home: home, temporary: temporary, trash: trash)
    }()

    init(home: URL, temporary: URL, trash: URL) {
        self.home = home
        self.temporary = temporary
        self.trash = trash
    }

    private var userSpace: [URL] { [home, temporary] }
    private static let userSpaceName = "your home or temporary folder"

    /// The common rules. The result has every symlink in its existing
    /// ancestors resolved; components that do not exist yet are appended as
    /// given (none of them can be `..`).
    ///
    /// `followLeaf: false` resolves the parent and keeps the last component
    /// as named, so a handler acting on a symlink acts on the link — trashing
    /// one must not trash what it points at. Creating follows the leaf: a
    /// dangling link would otherwise carry the new file wherever it points.
    func resolve(_ raw: String, followLeaf: Bool = true) -> Result<URL, Refusal> {
        if raw.isEmpty {
            return .failure(Refusal(reason: "empty path"))
        }
        let expanded = (raw as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/") else {
            return .failure(Refusal(reason: "not an absolute path: \(raw)"))
        }
        let components = (expanded as NSString).pathComponents
        if components.contains("..") || components.contains(".") {
            return .failure(Refusal(reason: "path has a '.' or '..' component: \(raw)"))
        }
        if !followLeaf && components.count > 1 {
            let parent = NSString.path(withComponents: Array(components.dropLast()))
            return resolve(parent).map { $0.appendingPathComponent(components[components.count - 1]) }
        }

        // Walk up to the deepest ancestor that exists, without following a
        // final symlink: a dangling link must be resolved, not stepped over,
        // or creating "through" it would land wherever it points.
        var existing = components
        var missing: [String] = []
        while existing.count > 1 && !Self.lexists(NSString.path(withComponents: existing)) {
            missing.insert(existing.removeLast(), at: 0)
        }
        guard let real = Self.realpath(NSString.path(withComponents: existing)) else {
            return .failure(Refusal(reason: "path does not resolve: \(raw)"))
        }
        var url = URL(fileURLWithPath: real)
        for component in missing {
            url.appendPathComponent(component)
        }
        return .success(url)
    }

    /// `openPath` opening a path that exists: any path that passes the
    /// common rules. The user clicked it.
    func forOpening(_ raw: String) -> Result<URL, Refusal> {
        resolve(raw, followLeaf: false)
    }

    /// `openPath` creating a file that does not exist: in the user's own
    /// space only.
    func forCreating(_ raw: String) -> Result<URL, Refusal> {
        resolve(raw).flatMap { require($0, under: userSpace, named: Self.userSpaceName, raw: raw) }
    }

    /// `trashPath`: recycles only in the user's own space.
    func forTrashing(_ raw: String) -> Result<URL, Refusal> {
        resolve(raw, followLeaf: false).flatMap {
            require($0, under: userSpace, named: Self.userSpaceName, raw: raw)
        }
    }

    /// `restorePath`: the source must be in the user's Trash (the host minted
    /// that URL, so nothing else is legitimate) and the destination in the
    /// user's own space.
    func forRestoring(trashed: String, destination: String) -> Result<(from: URL, to: URL), Refusal> {
        resolve(trashed, followLeaf: false)
            .flatMap { require($0, under: [trash], named: "the Trash", raw: trashed) }
            .flatMap { from in
                resolve(destination, followLeaf: false)
                    .flatMap { require($0, under: userSpace, named: Self.userSpaceName, raw: destination) }
                    .map { (from: from, to: $0) }
            }
    }

    /// Whether `url` lies strictly inside one of `roots`: some proper
    /// ancestor of it is the same file as a root.
    func require(_ url: URL, under roots: [URL], named name: String, raw: String) -> Result<URL, Refusal> {
        let rootIDs = roots.compactMap { Self.identity($0.path) }
        if rootIDs.isEmpty {
            return .failure(Refusal(reason: "\(name) is not available"))
        }
        var ancestor = url.deletingLastPathComponent()
        while true {
            if let id = Self.identity(ancestor.path), rootIDs.contains(id) {
                return .success(url)
            }
            let parent = ancestor.deletingLastPathComponent()
            if parent.path == ancestor.path { break }
            ancestor = parent
        }
        return .failure(Refusal(reason: "path is outside \(name): \(raw)"))
    }

    private struct FileID: Equatable {
        let device: dev_t
        let inode: ino_t
    }

    private static func identity(_ path: String) -> FileID? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return FileID(device: info.st_dev, inode: info.st_ino)
    }

    private static func lexists(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0
    }

    private static func realpath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
