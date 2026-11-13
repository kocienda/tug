import Foundation

/// Where a share render's files live: `NSTemporaryDirectory()/tug-share/`,
/// in a directory of this process's own, so an artifact is still there for
/// Save… and Share… after its preview and is gone with the app run that made
/// it.
///
/// The per-process directory is what lets that sweep be safe. Several Tug
/// processes can run at once under one user — the user's app beside an
/// app-test's — and they share one temporary directory; a launch that cleared
/// all of `tug-share/` would take a file out from under a preview standing in
/// the other app. So a launch removes only the directories whose process is
/// gone.
///
/// Pure paths and file operations, no window: compiled into the tests too.
enum ShareRenderOutput {
    /// The tallest document rendered as an image, in CSS pixels: about ten
    /// phone screens, still scrollable in a message thread, and 16,000 device
    /// pixels at 2×, inside WebKit's snapshot limits. A taller image answers
    /// `tooTall` and the share offers PDF instead.
    static let maxImageHeight: Double = 8000

    /// Whether a document `height` CSS pixels tall is too tall for an image.
    static func isTooTallForImage(height: Double) -> Bool {
        height > maxImageHeight
    }

    /// `NSTemporaryDirectory()/tug-share/`.
    static var root: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("tug-share", isDirectory: true)
    }

    /// This process's directory under `root`.
    static func directory(pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> URL {
        root.appendingPathComponent(String(pid), isDirectory: true)
    }

    /// The file a render of `id` writes, as `<id>.<ext>`.
    static func outputURL(id: String, format: ShareRenderFormat, pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> URL {
        let ext: String
        switch format {
        case .pdf: ext = "pdf"
        case .png: ext = "png"
        }
        return directory(pid: pid).appendingPathComponent("\(id).\(ext)", isDirectory: false)
    }

    /// Whether `path` names a file a render of this process wrote: a `.pdf` or
    /// `.png` directly in its own directory, after `..` is resolved. Save…,
    /// Copy and Share… are handed the path back by the page, and send only a
    /// rendered artifact — never any other file a page could name.
    static func isRenderedArtifact(path: String, pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> Bool {
        guard path.hasPrefix("/") else { return false }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard ["pdf", "png"].contains(url.pathExtension) else { return false }
        return url.deletingLastPathComponent().path == directory(pid: pid).standardizedFileURL.path
    }

    /// Whether `id` may name a render: it becomes a file name and a query
    /// value, so it is held to letters, digits, `-` and `_`.
    static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 128 else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            (scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)) || scalar == "-" || scalar == "_"
        }
    }

    /// Remove every process directory under `root` whose process is no
    /// longer running, and anything there that is not a process directory.
    /// `isAlive` is the test's seam.
    static func sweepStale(isAlive: (Int32) -> Bool = ShareRenderOutput.processIsAlive) {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for entry in entries {
            if let pid = Int32(entry.lastPathComponent), isAlive(pid) { continue }
            try? manager.removeItem(at: entry)
        }
    }

    /// Whether a process with `pid` exists (signal 0 delivers nothing; it only
    /// checks). A process owned by another user still exists.
    static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
