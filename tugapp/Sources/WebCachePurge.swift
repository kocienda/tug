import Foundation
import WebKit

/// Removes what WebKit's cache remembers of the deck, so a page never loads
/// a prior build's answer.
///
/// WebKit keys its disk cache by URL alone, and every build of Tug that has
/// run on an instance spoke at the same loopback origin, so the cache holds
/// one record per URL across all of them. A current build keeps its own
/// answers apart — hashed asset names, `no-cache` on every page, `no-store`
/// on a missing asset (`dist_cache_policy` in tugcast) — but an older build
/// knows none of those rules, and a record it leaves is served without a
/// request, so no header the current server sends can correct it. On
/// 2026-11-04 an older Tug.app ran for half a minute on `release-main`,
/// answered the newer build's entry-script URL with its own `index.html`,
/// and WebKit kept that page under the script's URL: every launch of the
/// newer build after it failed to boot until the cache was moved aside by
/// hand.
///
/// So the host empties the cache itself: once at every launch, during the
/// second tugcast takes to start, and once more if the shell's entry script
/// fails to load all the same (`MainWindow.reloadShellIfEntryScriptFailed`).
/// Nothing of the user's is in it — cookies, storage and the session token
/// are other data types and are left alone — and what a purge costs is the
/// first load's reads from disk, a few milliseconds over loopback for the
/// deck's ~5 MB.
final class WebCachePurge {
    /// The disk and memory caches: every answer WebKit might serve without
    /// asking, and nothing else.
    static let dataTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]

    /// How long a purge may hold the load that waits on it. A network process
    /// that does not answer must not keep the deck off the screen; the load
    /// goes ahead and the log says the purge did not finish.
    static let horizon: TimeInterval = 2.0

    private var done = false
    private var waiters: [() -> Void] = []
    private let reason: String
    private let startedAt = CFAbsoluteTimeGetCurrent()

    /// Begin removing the cache. `reason` is what the log line carries.
    init(reason: String) {
        self.reason = reason
        WKWebsiteDataStore.default().removeData(ofTypes: Self.dataTypes, modifiedSince: .distantPast) { [weak self] in
            self?.finish(outcome: "removed")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.horizon) { [weak self] in
            self?.finish(outcome: "horizon")
        }
    }

    /// Run `body` on the main thread once the cache is gone — at once if it
    /// already is.
    func whenDone(_ body: @escaping () -> Void) {
        if done {
            body()
        } else {
            waiters.append(body)
        }
    }

    private func finish(outcome: String) {
        guard !done else { return }
        done = true
        let ms = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000
        let fields = [
            TugLog.field("reason", reason),
            TugLog.field("ms", String(format: "%.1f", ms)),
        ]
        if outcome == "removed" {
            TugLog.info("webview", "cache purged", fields)
        } else {
            TugLog.warn("webview", "cache purge ran past its horizon; loading anyway", fields)
        }
        let pending = waiters
        waiters = []
        for body in pending { body() }
    }
}
