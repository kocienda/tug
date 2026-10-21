#if DEBUG
import AppKit
import Foundation

// MARK: - BeepTripwire
//
// The test-mode beep tripwire. A spike disproved the premise that `NSBeep`
// reaches the alert sound through a rebindable AudioToolbox stub (brief
// [F08]): a `DYLD_INTERPOSE` of the AudioToolbox
// alert/system-sound family catches nothing when AppKit beeps, and the
// `NSBeep` disassembly branches into internal framework stubs that are not
// AudioToolbox's alert API. There is no sound-layer symbol to rebind.
//
// So the harness catches the beep where AppKit *raises* it instead. The one
// origin the corpus produces is the no-responder beep — a bare key with no
// first responder, a key posted before the window is ready, or a chord that
// matches no enabled item and falls through — and AppKit raises every one of
// those through `-[NSResponder noResponderFor:]` for a `keyDown:`.
// `MainWindow.noResponderFor(_:)` consults this tripwire: when armed, it
// records the beep and swallows it, so the run stays silent; when not armed
// (a real user), it lets AppKit beep.
//
// The count is read over the `beepReport` RPC at teardown and a non-zero count
// fails the file (`_harness/beep-report.ts`). The disabled-menu-chord beep
// ([F07]'s other candidate) is AppKit-internal to the menu dispatch, does not
// pass through `noResponderFor:`, and is not counted here. None was heard when
// the tripwire first ran over the corpus ([F10]); one that appears would be
// audible rather than red, and its fix belongs at the cause — a dark item
// releasing its chord to the web view rather than eating it ([B04]).
//
// Compiled only in DEBUG; zero bytes ship to Release.

/// One beep the tripwire caught, with what provoked it.
struct BeepRecord {
    /// The AppKit origin, e.g. `noResponderFor(keyDown:)`.
    let origin: String
    /// The last harness verb dispatched before the beep, when one is known.
    let verb: String?
    /// The top of the call stack at the beep, trimmed.
    let stack: [String]
}

/// Counts the beeps AppKit raises during a test-mode run, and — while armed —
/// swallows them so the run is silent.
final class BeepTripwire {
    static let shared = BeepTripwire()

    private let lock = NSLock()
    private var records: [BeepRecord] = []
    private var lastVerb: String?

    /// Armed only in the app-test harness, where silence is the contract.
    /// Outside it, `record(origin:)` returns `false` and the caller beeps.
    private var armedFlag = false

    private init() {}

    /// Arm the tripwire. Called once, where the harness bridge starts.
    func arm() {
        lock.lock(); defer { lock.unlock() }
        armedFlag = true
    }

    /// Remember the most recent harness verb so a beep can name what provoked it.
    func noteVerb(_ method: String) {
        lock.lock(); defer { lock.unlock() }
        lastVerb = method
    }

    /// Record one beep caught at its origin. Returns whether the caller should
    /// swallow it — `true` only when armed, so the app still beeps for a real
    /// user.
    @discardableResult
    func record(origin: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard armedFlag else { return false }
        // Deep enough to reach past AppKit's responder forwarding to the view
        // that let the key go — a WKWebView handing an unhandled key back, or
        // a view with no key handling at all — which is what names the cause.
        let stack = Thread.callStackSymbols.prefix(16).map { String($0) }
        records.append(BeepRecord(origin: origin, verb: lastVerb, stack: stack))
        return true
    }

    /// The caught beeps as the `beepReport` RPC payload, clearing the buffer so
    /// a later read after more driving sees only new beeps.
    func drain() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let beeps: [[String: Any]] = records.map { r in
            var obj: [String: Any] = ["origin": r.origin, "stack": r.stack]
            if let verb = r.verb { obj["verb"] = verb }
            return obj
        }
        let payload: [String: Any] = ["count": records.count, "beeps": beeps]
        records.removeAll()
        return payload
    }
}
#endif
