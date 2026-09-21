import Foundation
import Network

/// The host's view of whether this machine has a network path, published to
/// the deck as a **hint**.
///
/// ## The asymmetry, which is the whole design
///
/// `NWPathMonitor` answers a question about *this machine's interfaces*, not
/// about whether anything on the far side answers. Those are different
/// questions, and only one of the two answers is worth believing:
///
/// - **`unsatisfied` is believed.** No route at all means nothing is getting
///   through, and that is a fact the deck may act on.
/// - **`satisfied` is only a nudge to try.** Captive wifi — the hotel portal,
///   the plane's paid tier — hands out a route, a DHCP lease and a gateway,
///   and answers every request with its own login page. The path monitor
///   calls that satisfied, and it is worthless as an assurance. Every
///   affordance on the deck side must therefore stay live on a satisfied
///   path, because "satisfied" does not mean the user can reach Anthropic.
///
/// The deck enforces the same asymmetry in its API shape — `network-path-store.ts`
/// exposes no `isOnline()`-shaped predicate at all, only the raw state — so
/// the rule is structural on both sides rather than a comment somebody has to
/// remember.
///
/// ## Why it starts late
///
/// `start(publishingTo:)` is called from `bridgeFrontendReady`, after the deck
/// has mounted, and never before. Nothing at launch may wait on this monitor:
/// the previous steps of this arc spent their effort removing launch
/// dependencies, and adding a framework that has to answer before the splash
/// clears would be one more — for a signal no launch path reads.
///
/// ## Why it is not a poll
///
/// `NWPathMonitor` is an event source: it calls `pathUpdateHandler` when the
/// path changes and stays silent otherwise ([P11]). Nothing here asks at an
/// interval, and the monitor's own queue is private so its callbacks never
/// contend with the main thread's work.
///
/// ## Threading
///
/// Every mutable field is touched on the main thread and nowhere else.
/// `start` is called from `bridgeFrontendReady`, which is already inside a
/// `DispatchQueue.main.async`; the `pathUpdateHandler` runs on this monitor's
/// private queue, builds its report there, and hops to main before comparing
/// against `lastReport`, logging, or publishing. The class carries no actor
/// annotation because `AppDelegate` constructs it as a stored property in a
/// nonisolated context, and an annotation it cannot honour at its one
/// construction site would be a claim rather than a constraint.
final class NetworkPathMonitor {
    /// The one published shape, matching the deck's `NetworkPathSnapshot`.
    struct Report: Equatable {
        /// `"satisfied" | "unsatisfied" | "requiresConnection"`, or
        /// `"unknown"` for a status this build does not know — see
        /// `statusName`, which is the only writer.
        let status: String
        let isExpensive: Bool
        let isConstrained: Bool
    }

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "app.tug.network-path", qos: .utility)
    private var started = false
    /// The last report published, so an `NWPathMonitor` callback that repeats
    /// itself — which it does, on interface churn that changes nothing the
    /// deck reads — produces neither a bridge call nor a log line.
    private var lastReport: Report?

    /// Begin watching, and publish every change through `publish`.
    ///
    /// Idempotent: `bridgeFrontendReady` fires again on every deck reconnect,
    /// and a second `start` would otherwise stack a monitor per reconnect. The
    /// second call instead re-publishes the current report, which is what a
    /// freshly reloaded deck needs — its store starts empty and no path
    /// *change* is coming to fill it.
    func start(publishingTo publish: @escaping (Report) -> Void) {
        if started {
            if let last = lastReport { publish(last) }
            return
        }
        started = true

        monitor.pathUpdateHandler = { [weak self] path in
            let report = Report(
                status: NetworkPathMonitor.statusName(path.status),
                isExpensive: path.isExpensive,
                isConstrained: path.isConstrained
            )
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard report != self.lastReport else { return }
                self.lastReport = report
                TugLog.info("path", "network path changed", [
                    TugLog.field("status", report.status),
                    TugLog.field("expensive", report.isExpensive ? "yes" : "no"),
                    TugLog.field("constrained", report.isConstrained ? "yes" : "no"),
                ])
                publish(report)
            }
        }
        monitor.start(queue: queue)
    }

    /// The last report, or `nil` before the first callback lands.
    var current: Report? { lastReport }

    /// Called from `pathUpdateHandler`, on the monitor's private queue: a
    /// pure mapping over an enum, so it needs no thread of its own.
    ///
    /// A future `NWPath.Status` case maps to a spelling the deck does not
    /// recognize, and `networkPathFromPayload` reads an unrecognized status
    /// as `null` — no evidence. Mapping it to `unsatisfied` instead would
    /// hand the deck a *believed negative* it never earned, and the one
    /// thing the deck does with that reading is act on it: every submission
    /// held, the setup wizard's claim on the app dropped. Only the negative
    /// is believed, so only a real negative may be spelled as one.
    private static func statusName(_ status: NWPath.Status) -> String {
        switch status {
        case .satisfied: return "satisfied"
        case .unsatisfied: return "unsatisfied"
        case .requiresConnection: return "requiresConnection"
        @unknown default: return "unknown"
        }
    }
}
