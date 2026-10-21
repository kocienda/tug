import AppKit
import CoreServices
import os

/// What the main thread is doing, readable from any thread.
///
/// A quit Apple Event that arrives and is not dispatched on a running main
/// thread means the main run loop is in a mode, or a nested event loop, that
/// does not service Apple Events — and until this existed nothing recorded
/// which. This watches two things and logs both to `tugapp.log`:
///
/// - **Every Apple Event, at the moment of dispatch.** A pre-dispatch hook
///   (`AEInstallSpecialHandler(keyPreDispatch)`) logs the event's class, id
///   and sender pid, then answers `errAEEventNotHandled` so AppKit dispatches
///   the event exactly as it would have. It observes; it replaces nothing.
///   AppKit's own quit handler, and the `applicationShouldTerminate` path it
///   runs, are untouched.
/// - **Every long stretch outside the default run-loop mode.** Observers on
///   the main run loop log any stretch of `stretchThreshold` or more spent in
///   another mode — event tracking, a modal panel, or a custom mode —
///   naming the mode and `NSApp.modalWindow`. A gap between default-mode
///   passes with no other mode seen (the thread held in a handler, or in a
///   mode not yet watched) is logged too, and the watch adopts every mode the
///   run loop has gained since, so a custom mode is named the next time.
///
/// It runs in release and logs only on transitions: between them each
/// observer callback is a timestamp and a comparison.
///
/// The current state is kept in a locked snapshot, because the host state
/// probe has to answer while the main thread is stuck — which is exactly when
/// asking the main thread would not return.
final class HostRunLoopWatch {
    static let shared = HostRunLoopWatch()

    /// The shortest stretch outside the default mode, or gap between
    /// default-mode passes, worth a log line.
    static let stretchThreshold: CFTimeInterval = 0.25

    /// How many recent Apple Event dispatches the snapshot keeps.
    private static let dispatchMemory = 64

    /// One Apple Event, as the pre-dispatch hook saw it.
    struct Dispatch {
        let at: CFAbsoluteTime
        let eventClass: String
        let eventID: String
        let senderPID: Int32?
    }

    /// A stretch the main run loop is spending outside the default mode.
    struct Stretch {
        let mode: String
        let since: CFAbsoluteTime
        var modalWindow: String?
    }

    /// The state the probe reads. Every field but `currentMode` is written on
    /// the main thread by the observers and the hook; `currentMode` is read
    /// live from the run loop, which locks itself.
    struct Snapshot {
        let currentMode: String?
        let lastDefaultPass: CFAbsoluteTime?
        let outside: Stretch?
        let recentDispatches: [Dispatch]
        let bodyCount: Int

        /// The probe's answer, as the control socket carries it. Times are
        /// ages in milliseconds, so the reader needs no clock of ours.
        func json(now: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> [String: Any] {
            func ms(_ since: CFAbsoluteTime) -> Int { Int(((now - since) * 1000).rounded()) }
            let lastMinute = recentDispatches.filter { now - $0.at <= 60 }
            return [
                // nil when the main thread is outside any run loop — busy
                // handling an event AppKit already took off the queue.
                "mode": currentMode ?? NSNull(),
                "outside_default": outside.map { stretch -> [String: Any] in
                    [
                        "mode": stretch.mode,
                        "ms": ms(stretch.since),
                        "modal_window": stretch.modalWindow ?? NSNull(),
                    ]
                } ?? NSNull(),
                "modal_window": outside?.modalWindow ?? NSNull(),
                "since_default_pass_ms": lastDefaultPass.map(ms) ?? NSNull(),
                "apple_events_last_minute": lastMinute.count,
                "apple_events": lastMinute.suffix(16).map { dispatch -> [String: Any] in
                    [
                        "class": dispatch.eventClass,
                        "id": dispatch.eventID,
                        "sender_pid": dispatch.senderPID.map { Int($0) as Any } ?? NSNull(),
                        "ago_ms": ms(dispatch.at),
                    ]
                },
                "body_count": bodyCount,
            ]
        }
    }

    private struct Shared {
        var lastDefaultPass: CFAbsoluteTime?
        var outside: Stretch?
        var dispatches: [Dispatch] = []
        var bodyCount = 0
    }

    private let lock = OSAllocatedUnfairLock(initialState: Shared())
    private let mainLoop: CFRunLoop = CFRunLoopGetMain()
    private var installed = false

    // Main-thread state, touched only by the observers.
    private var defaultObserver: CFRunLoopObserver?
    private var otherObserver: CFRunLoopObserver?
    private var watchedModes: Set<String> = []
    /// The last default-mode callback that was not a wake from sleep.
    private var lastDefault: CFAbsoluteTime?
    /// The default mode is asleep in `mach_msg`, waiting — time that is idle,
    /// not held.
    private var sleeping = false
    /// Whether another mode was seen since the last default-mode callback, so
    /// a gap it explains is not logged a second time as an unexplained one.
    private var sawOtherMode = false

    private static let defaultMode = CFRunLoopMode.defaultMode.rawValue as String
    /// The pseudo-mode that stands for every common mode, the default among
    /// them; an observer added under it would fire in the default mode too.
    private static let commonModes = CFRunLoopMode.commonModes.rawValue as String

    /// A mode the other-mode observer may be added to.
    private static func isOther(_ mode: String) -> Bool {
        mode != defaultMode && mode != commonModes
    }

    /// Install the hook and the observers. Call once, on the main thread, before
    /// the app finishes launching, so the open-application event is the first
    /// dispatch the log records.
    func install() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !installed else { return }
        installed = true

        let status = AEInstallSpecialHandler(AEKeyword(keyPreDispatch), hostPreDispatchHandler, false)
        if status != noErr {
            TugLog.error("appleevent", "pre-dispatch hook not installed", [TugLog.field("status", status)])
        }

        let activities = CFRunLoopActivity.allActivities.rawValue
        defaultObserver = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, activities, true, 0) { [weak self] _, activity in
            self?.inDefaultMode(activity)
        }
        otherObserver = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, activities, true, 0) { [weak self] _, activity in
            self?.inOtherMode(activity)
        }
        if let defaultObserver {
            CFRunLoopAddObserver(mainLoop, defaultObserver, .defaultMode)
        }
        // The two AppKit nests by name, before either exists, then whatever
        // the run loop already has.
        watch(mode: RunLoop.Mode.eventTracking.rawValue)
        watch(mode: RunLoop.Mode.modalPanel.rawValue)
        _ = adoptNewModes()
    }

    /// The probe's read. Safe from any thread, and never waits on the main one.
    func snapshot() -> Snapshot {
        let mode = CFRunLoopCopyCurrentMode(mainLoop).map { $0.rawValue as String }
        return lock.withLock { shared in
            Snapshot(
                currentMode: mode,
                lastDefaultPass: shared.lastDefaultPass,
                outside: shared.outside,
                recentDispatches: shared.dispatches,
                bodyCount: shared.bodyCount
            )
        }
    }

    /// Record how many card bodies the window holds, for the probe.
    func noteBodyCount(_ count: Int) {
        lock.withLock { $0.bodyCount = count }
    }

    // MARK: - Apple Events

    /// Called from the pre-dispatch hook, on the main thread.
    fileprivate func willDispatch(_ event: UnsafePointer<AppleEvent>) {
        let eventClass = Self.fourCC(attribute: AEKeyword(keyEventClassAttr), of: event)
        let eventID = Self.fourCC(attribute: AEKeyword(keyEventIDAttr), of: event)
        let sender = Self.senderPID(of: event)
        let dispatch = Dispatch(
            at: CFAbsoluteTimeGetCurrent(),
            eventClass: eventClass,
            eventID: eventID,
            senderPID: sender
        )
        lock.withLock { shared in
            shared.dispatches.append(dispatch)
            if shared.dispatches.count > Self.dispatchMemory {
                shared.dispatches.removeFirst(shared.dispatches.count - Self.dispatchMemory)
            }
        }
        TugLog.info("appleevent", "dispatch", [
            TugLog.field("class", eventClass),
            TugLog.field("id", eventID),
            TugLog.field("sender_pid", sender.map(String.init) ?? "unknown"),
        ])
    }

    private static func fourCC(attribute: AEKeyword, of event: UnsafePointer<AppleEvent>) -> String {
        var code: OSType = 0
        var actualType: DescType = 0
        var actualSize = 0
        let status = AEGetAttributePtr(
            event, attribute, DescType(typeType), &actualType,
            &code, MemoryLayout<OSType>.size, &actualSize
        )
        guard status == noErr else { return "????" }
        return fourCCString(code)
    }

    private static func senderPID(of event: UnsafePointer<AppleEvent>) -> Int32? {
        var pid: Int32 = 0
        var actualType: DescType = 0
        var actualSize = 0
        let status = AEGetAttributePtr(
            event, AEKeyword(keySenderPIDAttr), DescType(typeSInt32), &actualType,
            &pid, MemoryLayout<Int32>.size, &actualSize
        )
        return status == noErr ? pid : nil
    }

    /// `'aevt'` rather than `1634039412`, printable or escaped.
    static func fourCCString(_ code: OSType) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }
        if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
            return String(decoding: bytes, as: UTF8.self)
        }
        return String(format: "0x%08X", code)
    }

    // MARK: - Run-loop observers

    private func watch(mode: String) {
        guard let otherObserver, Self.isOther(mode), !watchedModes.contains(mode) else { return }
        watchedModes.insert(mode)
        CFRunLoopAddObserver(mainLoop, otherObserver, CFRunLoopMode(mode as CFString))
    }

    /// Watch every mode the main run loop has that is not watched yet, and say
    /// which were new.
    private func adoptNewModes() -> [String] {
        guard let all = CFRunLoopCopyAllModes(mainLoop) as? [String] else { return [] }
        let fresh = all.filter { Self.isOther($0) && !watchedModes.contains($0) }.sorted()
        for mode in fresh { watch(mode: mode) }
        return fresh
    }

    private func inDefaultMode(_ activity: CFRunLoopActivity) {
        let now = CFAbsoluteTimeGetCurrent()

        if let open = lock.withLock({ $0.outside }) {
            let ms = (now - open.since) * 1000
            if now - open.since >= Self.stretchThreshold {
                TugLog.info("runloop", "left the default mode", [
                    TugLog.field("mode", open.mode),
                    TugLog.field("ms", Int(ms)),
                    TugLog.field("modal_window", open.modalWindow ?? Self.describeModalWindow() ?? "none"),
                ])
            }
        } else if !sleeping, !sawOtherMode, let last = lastDefault, now - last >= Self.stretchThreshold {
            // Held away from the default mode with no other mode seen: busy in
            // a handler, or nested in a mode the watch has not met. Adopt
            // whatever the run loop has gained so the next one is named.
            let adopted = adoptNewModes()
            TugLog.info("runloop", "default mode not serviced", [
                TugLog.field("ms", Int((now - last) * 1000)),
                TugLog.field("adopted_modes", adopted.isEmpty ? "none" : adopted.joined(separator: ",")),
            ])
        }

        sawOtherMode = false
        switch activity {
        case .beforeWaiting: sleeping = true
        case .afterWaiting: sleeping = false
        default: break
        }
        lastDefault = now
        lock.withLock { shared in
            shared.outside = nil
            shared.lastDefaultPass = now
        }
    }

    private func inOtherMode(_ activity: CFRunLoopActivity) {
        let now = CFAbsoluteTimeGetCurrent()
        let mode = CFRunLoopCopyCurrentMode(mainLoop).map { $0.rawValue as String } ?? "unknown"
        guard mode != Self.defaultMode else { return }
        sawOtherMode = true
        // An open stretch is kept, under the mode it opened in; the only thing
        // left to learn about it is a modal window that appeared after it
        // began, and that is checked once per run-loop entry.
        if let current = lock.withLock({ $0.outside }) {
            guard current.modalWindow == nil, activity == .entry else { return }
        }
        // Read `NSApp.modalWindow` here, on the main thread, so the probe
        // never has to.
        let modal = Self.describeModalWindow()
        lock.withLock { shared in
            if var open = shared.outside {
                if open.modalWindow == nil { open.modalWindow = modal }
                shared.outside = open
            } else {
                shared.outside = Stretch(mode: mode, since: now, modalWindow: modal)
            }
        }
    }

    private static func describeModalWindow() -> String? {
        guard let window = NSApp?.modalWindow else { return nil }
        let title = window.title.isEmpty ? "untitled" : window.title
        return "\(type(of: window))(\(title))"
    }
}

/// The pre-dispatch hook. A C function pointer cannot capture, so it reaches
/// the watch through the singleton, and always answers "not handled" so the
/// Apple Event Manager dispatches the event normally.
private func hostPreDispatchHandler(
    _ event: UnsafePointer<AppleEvent>?,
    _ reply: UnsafeMutablePointer<AppleEvent>?,
    _ refcon: UnsafeMutableRawPointer?
) -> OSErr {
    if let event {
        HostRunLoopWatch.shared.willDispatch(event)
    }
    return OSErr(errAEEventNotHandled)
}
