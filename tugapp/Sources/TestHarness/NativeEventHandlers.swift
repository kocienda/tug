#if DEBUG
import AppKit
import CoreGraphics
import Foundation
import WebKit

// MARK: - NativeEventHandlers
//
// Phase A native-gesture + keyboard handler set. Every verb in this
// file posts trusted Quartz events through the `post(_:)` router —
// `CGEvent.post(tap: .cgSessionEventTap)` ([D02]), or
// `CGEvent.postToPid` when `TUGAPP_NATIVE_EVENT_MODE=pid` — using a
// per-instance `CGEventSource(stateID: .privateState)` ([Q05]). Gestures run on the main thread; callers (the dispatch
// table in `TestHarnessConnection`) bounce through `DispatchQueue.main.async`.
//
// ## Why this shape
//
// - Single `CGEventSource` per handler instance: the source's state
//   table tracks modifier-key state across events posted through it.
//   Reusing one source across the events of a `holdModifier` scope
//   is what makes the modifier flags register coherently on inner
//   events. Per [Q05] and the Apple docs for `CGEventCreateKeyboardEvent`.
// - `NSApp.activate(ignoringOtherApps: true)` at gesture start:
//   CGEvent mouse events route via windowserver based on which
//   window is at the target screen coord AND is frontmost in
//   z-order. `open -n -W` (the [D13] launcher) leaves Tug.app
//   active-but-not-frontmost in some contexts; activating here
//   makes click delivery deterministic.
// - `viewportPoint` (CSS, Y-down) in / `CGPoint` screen-CG out via
//   `CoordMapping.viewportToScreen`: callers never pass screen coords
//   directly. Out-of-bounds → `NativeEventError.coordinateOutOfBounds`
//   → `CoordinateOutOfBoundsError` at the RPC boundary.
// - Interpolated drag (8-step default, configurable via
//   `interpolationSteps`; 0 falls back to endpoint-only). The
//   2026-04-24 plan authoring assumed endpoint-only would suffice;
//   the Phase A smoke proved otherwise — a single `mouseDragged`
//   on a WebKit `contenteditable` anchors but never extends the
//   selection. See `nativeDrag(...)`'s docstring for the full
//   rationale.

// MARK: - Constants

/// Pinned inter-click interval for `nativeDoubleClick`. Deliberately
/// shorter than macOS's default double-click threshold (which is
/// user-configurable via `NSEvent.doubleClickInterval`, defaulting
/// to ~500ms) so WebKit never interprets the two clicks as slow
/// single-clicks. 80ms is within WebKit's default-click-accumulation
/// window on all tested macOS versions.
let NATIVE_DOUBLE_CLICK_INTERVAL_MS: Int = 80

/// Delay inserted between modifier-key posts and the inner events
/// they wrap. windowserver's modifier-state table is updated on
/// each `CGEvent.post`, but WebKit's key-event handler reads the
/// modifier bits from the arriving `NSEvent`'s `.modifierFlags`,
/// which requires windowserver to have produced a `flagsChanged`
/// event AND routed it to the application thread before the next
/// keystroke arrives. Back-to-back posts with no delay at all can
/// race — the `a` keyDown sometimes lands at the app before the
/// Cmd flag has propagated, and Cmd+A silently degrades to a plain
/// "a" insertion.
///
/// 10ms is empirically enough on Apple Silicon + M1 Max Intel
/// macOS 13-15; values under 5ms start to flake, values over 25ms
/// are wasteful but harmless.
let NATIVE_MODIFIER_SETTLE_MS: Int = 10

/// Gap between consecutive character keystrokes inside `nativeType`.
/// Each character posts up to four events (shift-down, char-down,
/// char-up, shift-up). With no spacing between iterations, the OS
/// event queue saturates on long strings — windowserver drops
/// trailing events and the doc lands missing characters (observed
/// at0042 long-line typing dropping "final."). Spacing also gives
/// WebKit's contentEditable input pipeline time to produce one
/// `input` event per char, which CM6's input observer needs to
/// dispatch one transaction per char rather than batching multiple
/// chars into a single dispatch (which can lose intermediate
/// reconciliation).
///
/// 6ms is chosen so 100-char strings finish in ~600ms — fast
/// enough to feel responsive in tests but slow enough to keep the
/// queue drained.
let NATIVE_TYPE_INTER_CHAR_MS: Int = 6

/// Settle delay after a `nativeKey` or `nativeType` sequence
/// completes, before the function returns. Ensures the trailing
/// modifier-release events have been processed by windowserver
/// before the NEXT call's modifier press lands. Without this, two
/// back-to-back `nativeKey("?", ["cmd"])` calls can have call N's
/// Cmd-up race with call N+1's Cmd-down — the OS sees a Cmd that
/// never released, and inadvertent global hotkeys (Cmd-Ctrl-Space
/// emoji picker, Fn-Fn dictation) can trigger when adjacent
/// modifier streams overlap.
///
/// 15ms covers windowserver dispatch latency on Apple Silicon +
/// M1 Max Intel under macOS 13-15, with margin for queue load.
let NATIVE_KEY_POST_SEQUENCE_SETTLE_MS: Int = 15

// MARK: - Enums

enum MouseButton: String {
    case left
    case right

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        }
    }

    var draggedType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        }
    }

    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        }
    }
}

enum ModifierKey: String {
    case cmd
    case shift
    case alt
    case ctrl

    /// Mac `kVK_*` virtual keycode for the modifier's physical key.
    /// Values from `<Carbon/HIToolbox/Events.h>`:
    /// `kVK_Command=0x37`, `kVK_Shift=0x38`, `kVK_Option=0x3A`,
    /// `kVK_Control=0x3B`.
    var keyCode: CGKeyCode {
        switch self {
        case .cmd: return 0x37
        case .shift: return 0x38
        case .alt: return 0x3A
        case .ctrl: return 0x3B
        }
    }

    /// The `CGEventFlags` bit the modifier sets on every event posted while
    /// it is held.
    var eventFlag: CGEventFlags {
        switch self {
        case .cmd: return .maskCommand
        case .shift: return .maskShift
        case .alt: return .maskAlternate
        case .ctrl: return .maskControl
        }
    }
}

// MARK: - Errors

enum NativeEventError: Error, CustomStringConvertible {
    case coordinateOutOfBounds(CGPoint)
    case unknownKey(String)
    case asciiOnly(String)
    case eventCreationFailed(String)
    case webViewUnavailable
    case protocolError(String)
    case activationClickObstructed(point: CGPoint, ownerName: String, ownerPid: pid_t)

    var description: String {
        switch self {
        case .coordinateOutOfBounds(let p):
            return "viewport coordinate (\(p.x), \(p.y)) is outside the WKWebView's visible frame"
        case .unknownKey(let name):
            return "unknown key name: \"\(name)\" (no entry in VirtualKeyMap)"
        case .asciiOnly(let excerpt):
            return "nativeType accepts US-ASCII only; first non-ASCII code unit: \"\(excerpt)\""
        case .eventCreationFailed(let what):
            return "CGEvent constructor returned nil for \(what)"
        case .webViewUnavailable:
            return "WKWebView unavailable (the harness connection has been torn down)"
        case .protocolError(let message):
            return "protocol error: \(message)"
        case .activationClickObstructed(let p, let owner, let pid):
            return """
                activation click at (\(p.x), \(p.y)) cannot reach this app's window — \
                "\(owner)" (pid \(pid)) is in front of it there. A click into a \
                BACKGROUNDED app is routed by WindowServer to whatever window is \
                actually frontmost at the cursor, so this click would have gone to \
                that window and the app would never have come forward. Usually a \
                leftover Tug from a killed run: `just reap` reports them, and \
                unregistered app-test instances have to be killed by hand.
                """
        }
    }

    /// The error `name` reported over the RPC wire. Matched client-
    /// side in `tests/app-test/_harness/rpc.ts`'s `translateError`.
    var wireName: String {
        switch self {
        case .coordinateOutOfBounds: return "CoordinateOutOfBoundsError"
        case .unknownKey: return "UnknownKeyError"
        case .asciiOnly: return "NativeTypeAsciiOnlyError"
        case .eventCreationFailed: return "NativeEventError"
        case .webViewUnavailable: return "AppCrashedError"
        case .protocolError: return "ProtocolError"
        case .activationClickObstructed: return "ActivationClickObstructedError"
        }
    }
}

// MARK: - Handler

final class NativeEventHandlers {

    // Weak so teardown of the connection doesn't keep the WKWebView
    // alive; handlers are short-lived anyway (one per request) so the
    // window of use is tiny.
    private weak var webView: WKWebView?
    private let source: CGEventSource?

    /// `TUGAPP_NATIVE_EVENT_MODE=pid` addresses every event to this process
    /// via `CGEvent.postToPid` instead of the session event tap. Delivery
    /// bypasses WindowServer's frontmost-window-at-coordinate routing, so
    /// gestures also skip self-activation — the app receives its events
    /// while another app keeps the user's focus, cursor, and key window.
    private let postToOwnPid: Bool =
        ProcessInfo.processInfo.environment["TUGAPP_NATIVE_EVENT_MODE"] == "pid"
    private let ownPid = pid_t(ProcessInfo.processInfo.processIdentifier)

    /// Route an event through the mode's channel. Session-tap mode posts
    /// everything to WindowServer (frontmost routing). Pid mode splits by
    /// kind: keyboard events reach an inactive app via `postToPid`, but
    /// AppKit refuses to route mouse events to an inactive app at the
    /// application level — those are rebuilt as `NSEvent`s and dispatched
    /// straight into the window, below the activation-gated routing.
    private func post(_ event: CGEvent) {
        if mouseNSEventType(event.type) != nil {
            // Stamp the held set onto mouse events, for the same reason
            // `postKeyEvent` stamps it onto key events: a `CGEvent(mouseEvent
            // Source:)` derives its flags from the source's own modifier
            // bookkeeping, which does not see a modifier pressed by
            // `pressHeldModifiers`. Left alone, a ⌘-drag reaches WebKit with
            // `metaKey` false — so a gesture whose whole meaning is the
            // modifier (⌘ frees an imposed card from its slot) would be
            // untestable, and worse, would LOOK tested.
            //
            // Empty unless a test is holding something, so this is a no-op for
            // every ordinary click and drag.
            event.flags = heldFlags
        }
        if postToOwnPid {
            if let nsType = mouseNSEventType(event.type) {
                sendMouseEventToWindow(event, as: nsType)
            } else {
                event.postToPid(ownPid)
            }
        } else {
            event.post(tap: .cgSessionEventTap)
        }
    }

    /// Who owns the frontmost ORDINARY window covering `screenPoint`, or nil
    /// when nothing does.
    ///
    /// Only normal-level windows count. The desktop sits below them and the
    /// menu bar above, and neither takes a click meant for a window — counting
    /// them would report an obstruction on every click.
    /// `CGWindowListCopyWindowInfo` returns on-screen windows front to back,
    /// so the first hit IS the one WindowServer would route to.
    private func frontmostWindowOwner(
        at screenPoint: CGPoint
    ) -> (name: String, pid: pid_t)? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID,
        ) as? [[String: Any]] else {
            return nil
        }
        for window in windows {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.contains(screenPoint) else { continue }
            let pid = pid_t(window[kCGWindowOwnerPID as String] as? Int ?? 0)
            let name = window[kCGWindowOwnerName as String] as? String ?? "unknown"
            return (name: name, pid: pid)
        }
        return nil
    }

    /// The NSEvent type for a mouse CGEvent, or nil for non-mouse events.
    private func mouseNSEventType(_ type: CGEventType) -> NSEvent.EventType? {
        switch type {
        case .leftMouseDown: return .leftMouseDown
        case .leftMouseUp: return .leftMouseUp
        case .rightMouseDown: return .rightMouseDown
        case .rightMouseUp: return .rightMouseUp
        case .leftMouseDragged: return .leftMouseDragged
        case .rightMouseDragged: return .rightMouseDragged
        default: return nil
        }
    }

    /// Event number for synthesized mouse NSEvents. A mouse-down mints a
    /// new number and the gesture's dragged/up events reuse it — the
    /// pairing real gestures carry.
    private var syntheticEventNumber: Int = 41_000

    /// Rebuild a mouse CGEvent as an NSEvent located in the window and
    /// deliver it via `window.sendEvent` on the main thread. The CG
    /// screen coord (Y-down, primary-screen origin) is flipped back to
    /// AppKit screen space and converted into window coords — the same
    /// chain `CoordMapping.viewportToScreen` runs, reversed from step 5
    /// to step 3.
    private func sendMouseEventToWindow(_ event: CGEvent, as nsType: NSEvent.EventType) {
        let work = { [self] in
            guard let webView = self.webView, let window = webView.window else { return }
            let cgPoint = event.location
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let appKitScreen = CGPoint(x: cgPoint.x, y: primaryHeight - cgPoint.y)
            let windowPoint = window.convertPoint(fromScreen: appKitScreen)
            let isDown = nsType == .leftMouseDown || nsType == .rightMouseDown
            if isDown { syntheticEventNumber += 1 }
            let clickState = Int(event.getIntegerValueField(.mouseEventClickState))
            guard let ns = NSEvent.mouseEvent(
                with: nsType,
                location: windowPoint,
                modifierFlags: nsModifierFlags(from: event.flags),
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: syntheticEventNumber,
                clickCount: max(1, clickState),
                pressure: nsType == .leftMouseUp || nsType == .rightMouseUp ? 0 : 1,
            ) else {
                NSLog("tughost.native.sendMouseEventToWindow.failed type=%d", nsType.rawValue)
                return
            }
            window.sendEvent(ns)
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
    }

    /// Map CGEvent modifier flags onto NSEvent modifier flags.
    private func nsModifierFlags(from flags: CGEventFlags) -> NSEvent.ModifierFlags {
        var out: NSEvent.ModifierFlags = []
        if flags.contains(.maskCommand) { out.insert(.command) }
        if flags.contains(.maskShift) { out.insert(.shift) }
        if flags.contains(.maskAlternate) { out.insert(.option) }
        if flags.contains(.maskControl) { out.insert(.control) }
        return out
    }

    init(webView: WKWebView) {
        self.webView = webView
        // Private event-state source. It keeps its OWN modifier-state table —
        // so a Cmd/Shift posted through it is still auto-stamped onto the inner
        // keystrokes of a `holdModifier` scope (Cmd+A, Cmd+Return keep working)
        // — but, unlike `.combinedSessionState`/`.hidSystemState`, it does NOT
        // merge in the system's live hardware/global modifier state. That
        // ambient bleed was the flake: a stray Fn/Globe bit stamped onto a
        // character event pops the Character Viewer (emoji picker) mid-type,
        // and a not-yet-released Cmd turns plain keystrokes into shortcuts —
        // both seen dropping chars from `/permissions` (→ `/prissions`, picker
        // open). Apple's CGEventSourceStateID docs recommend `.privateState`
        // for exactly this: deterministic, reproducible synthetic input.
        self.source = CGEventSource(stateID: .privateState)
    }

    // MARK: - Click

    /// Post a click at `viewportPoint` via the chosen variant. A
    /// `clickCount > 1` sets `.mouseEventClickState` on both the down
    /// and up events — lets WebKit recognize the event as part of a
    /// multi-click sequence without requiring the caller to post
    /// multiple pairs (double-click paths use `nativeDoubleClick` for that).
    ///
    /// `mouseDownDelayMs` sleeps the main thread between the down
    /// and up events; `mouseUpDelayMs` sleeps after the up. Both
    /// default to 20ms — enough for WebKit to process the events
    /// in order without racing the test's next RPC.
    ///
    /// `activateFirst` is the default because the app under test is normally
    /// already frontmost. A test that models a click into the backgrounded app
    /// passes false: the click that brings an app forward is a different event
    /// from an ordinary one, and activating first erases the case under test.
    func nativeClick(
        viewportPoint: CGPoint,
        button: MouseButton = .left,
        clickCount: Int = 1,
        mouseDownDelayMs: Int = 20,
        mouseUpDelayMs: Int = 20,
        activateFirst: Bool = true,
    ) throws {
        if activateFirst { activateSelf() }
        let screenPoint = try resolveScreenPoint(viewportPoint)
        if !activateFirst {
            // An activation click has to arrive the way a user's does, with the
            // cursor already at the point. A posted button event carries its
            // own position, but WindowServer routes a click into a background
            // application by where the cursor actually is — post without
            // warping and the click reaches no window at all, so the app never
            // comes forward. The activating path is the only one that needs
            // this; the ordinary path already owns the frontmost window.
            CGWarpMouseCursorPosition(screenPoint)
            sleepMs(20)
            // Verify the click can actually reach us before posting it. With
            // the app backgrounded, WindowServer routes by what is frontmost
            // at the cursor — so a stray window over that point silently
            // swallows the gesture, the app never comes forward, and the
            // failure surfaces much later as an unrelated timeout on whatever
            // the test expected the click to cause. Naming it here costs one
            // window-list read and turns that into a sentence ([L31]).
            // Session-tap mode only. In pid mode the click never travels
            // through WindowServer at all — it is rebuilt as an NSEvent and
            // handed straight to our own window — so no other window can be
            // in front of anything, and a background test whose deck happens
            // to overlap a developer's own Tug would fail on a gesture that
            // works perfectly.
            if !postToOwnPid,
               let blocker = frontmostWindowOwner(at: screenPoint),
               blocker.pid != ownPid {
                throw NativeEventError.activationClickObstructed(
                    point: screenPoint,
                    ownerName: blocker.name,
                    ownerPid: blocker.pid,
                )
            }
        }

        guard let down = CGEvent(
            mouseEventSource: source,
            mouseType: button.downType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseDown")
        }
        guard let up = CGEvent(
            mouseEventSource: source,
            mouseType: button.upType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseUp")
        }
        if clickCount > 1 {
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        }

        post(down)
        sleepMs(mouseDownDelayMs)
        post(up)
        sleepMs(mouseUpDelayMs)
    }

    /// Two click pairs separated by the pinned interval, with
    /// `mouseEventClickState` progressing 1 → 2 (WebKit's accumulator).
    ///
    /// Does NOT delegate to `nativeClick`: the redundant
    /// `activateSelf()` between the two pairs can disturb WebKit's
    /// click-accumulator, producing two single-clicks instead of one
    /// double-click. Activating once up-front and posting all four
    /// events through the same source keeps the accumulator
    /// coherent.
    func nativeDoubleClick(
        viewportPoint: CGPoint,
        button: MouseButton = .left,
    ) throws {
        activateSelf()
        let screenPoint = try resolveScreenPoint(viewportPoint)

        try postClickPair(at: screenPoint, button: button, clickCount: 1)
        sleepMs(NATIVE_DOUBLE_CLICK_INTERVAL_MS)
        try postClickPair(at: screenPoint, button: button, clickCount: 2)
    }

    /// Post a single mouseDown/mouseUp pair at an already-resolved
    /// screen point. Helper for `nativeDoubleClick` so the double-
    /// click path can share one activation + one coord resolution
    /// across both pairs. Inter-pair spacing is the caller's
    /// responsibility.
    private func postClickPair(
        at screenPoint: CGPoint,
        button: MouseButton,
        clickCount: Int,
    ) throws {
        guard let down = CGEvent(
            mouseEventSource: source,
            mouseType: button.downType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseDown")
        }
        guard let up = CGEvent(
            mouseEventSource: source,
            mouseType: button.upType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseUp")
        }
        if clickCount > 1 {
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        }
        post(down)
        sleepMs(20)
        post(up)
    }

    /// Convenience: right-button click for context-menu paths.
    func nativeRightClick(viewportPoint: CGPoint) throws {
        try nativeClick(
            viewportPoint: viewportPoint,
            button: .right,
            clickCount: 1,
            mouseDownDelayMs: 20,
            mouseUpDelayMs: 20,
        )
    }

    // MARK: - Drag (interpolated)

    /// Post a drag: `mouseDown` at `from`, a series of interpolated
    /// `mouseDragged` events along the path from `from` → `to`,
    /// `mouseUp` at `to`.
    ///
    /// **Why interpolation, not endpoint-only:** The plan's 2026-04-24
    /// authoring hoped endpoint-only drag (one `mouseDragged` at the
    /// destination) would suffice for every Phase C scenario. The
    /// Phase A smoke-native drag test proved that hope wrong — a
    /// single `mouseDragged` event on a WebKit contentEditable
    /// anchors the selection at `from` but never extends it: WebKit
    /// dispatches `selectstart`, then sees the `mouseUp` and commits
    /// a zero-length selection. A sequence of events along the path
    /// makes WebKit's drag-selection extend as the pointer moves.
    ///
    /// `interpolationSteps` controls how many intermediate dragged
    /// events are posted. Default 8 is empirically enough for a
    /// 40-100px horizontal drag in a `contenteditable` on
    /// Apple Silicon macOS 13-15; longer drags scale linearly if you
    /// pass more. 0 falls back to the old endpoint-only behavior
    /// (one `mouseDragged` at `to`) for tests that want to test
    /// exactly that.
    ///
    /// Both `from` and `to` must lie inside the WKWebView's
    /// viewport; either being out-of-bounds fails fast with
    /// `coordinateOutOfBounds` before any events are posted.
    func nativeDrag(
        from: CGPoint,
        to: CGPoint,
        button: MouseButton = .left,
        mouseDownDelayMs: Int = 20,
        mouseUpDelayMs: Int = 20,
        interpolationSteps: Int = 8,
    ) throws {
        try dispatchDragGesture(
            from: from,
            to: to,
            button: button,
            mouseDownDelayMs: mouseDownDelayMs,
            mouseUpDelayMs: mouseUpDelayMs,
            interpolationSteps: interpolationSteps,
            releaseAtEnd: true,
        )
    }

    /// Trail-only drag — same `mouseDown` + interpolated `mouseDragged`
    /// sequence as `nativeDrag`, but does NOT post a final `mouseUp`.
    /// The pointer remains "pressed" from WebKit / WindowServer's
    /// perspective until a subsequent `nativeMouseUp` fires.
    ///
    /// Pairs with `nativeMouseUp` to compose gestures that need to
    /// hold the drag open for an interleaved verb — the canonical
    /// case being mid-drag Escape:
    ///
    ///     nativeDragWithoutRelease(tab, somewhereFar)
    ///     nativeKey("Escape")
    ///     nativeMouseUp(somewhereFar)
    ///
    /// The drag coordinator's document-level keydown listener
    /// installs at `startDrag` (which
    /// fires once the trail crosses the 5px threshold) and is
    /// removed at `cleanup` (which the Escape branch invokes).
    /// Without this primitive the atomic `nativeDrag` always
    /// commits a drop via `mouseUp` before any subsequent
    /// `nativeKey("Escape")` arrives.
    ///
    /// `mouseUpDelayMs` is accepted for shape symmetry with
    /// `nativeDrag` but is unused (no `mouseUp` is posted).
    func nativeDragWithoutRelease(
        from: CGPoint,
        to: CGPoint,
        button: MouseButton = .left,
        mouseDownDelayMs: Int = 20,
        mouseUpDelayMs: Int = 20,
        interpolationSteps: Int = 8,
    ) throws {
        try dispatchDragGesture(
            from: from,
            to: to,
            button: button,
            mouseDownDelayMs: mouseDownDelayMs,
            mouseUpDelayMs: mouseUpDelayMs,
            interpolationSteps: interpolationSteps,
            releaseAtEnd: false,
        )
    }

    /// Shared trail dispatch for `nativeDrag` and
    /// `nativeDragWithoutRelease`. Posts `mouseDown` at `from`, the
    /// interpolated `mouseDragged` trail along `from → to`, and
    /// optionally `mouseUp` at `to`. See `nativeDrag` for the
    /// rationale on interpolation step count and inter-step delay.
    private func dispatchDragGesture(
        from: CGPoint,
        to: CGPoint,
        button: MouseButton,
        mouseDownDelayMs: Int,
        mouseUpDelayMs: Int,
        interpolationSteps: Int,
        releaseAtEnd: Bool,
    ) throws {
        activateSelf()
        let fromScreen = try resolveScreenPoint(from)
        let toScreen = try resolveScreenPoint(to)

        guard let down = CGEvent(
            mouseEventSource: source,
            mouseType: button.downType,
            mouseCursorPosition: fromScreen,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("drag mouseDown")
        }

        post(down)
        sleepMs(mouseDownDelayMs)

        // Interpolated dragged events. We ALWAYS post at least one
        // event at `to` (the final step), so even with
        // `interpolationSteps == 0` the drag has one mouseDragged
        // at the destination.
        let steps = max(1, interpolationSteps)
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let stepScreen = CGPoint(
                x: fromScreen.x + (toScreen.x - fromScreen.x) * t,
                y: fromScreen.y + (toScreen.y - fromScreen.y) * t,
            )
            guard let dragged = CGEvent(
                mouseEventSource: source,
                mouseType: button.draggedType,
                mouseCursorPosition: stepScreen,
                mouseButton: button.cgButton,
            ) else {
                throw NativeEventError.eventCreationFailed("drag mouseDragged step \(i)")
            }
            post(dragged)
            // 20ms/step gives WebKit enough gap between events that
            // windowserver doesn't coalesce them in its event queue.
            // Lower values (8ms) cause all 8 drag events to merge
            // into a single mousemove at the destination, which
            // defeats the interpolation and regresses to the
            // endpoint-only behavior that fails to paint selection.
            sleepMs(20)
        }

        // Final settle: give the last mouseDragged time to be
        // processed so any pre-mouseUp work (selection extension,
        // drag-coordinator threshold detection / startDrag) commits
        // before we release. For `releaseAtEnd: false` callers the
        // settle is what guarantees the drag is "in flight" at the
        // RPC return point — without it, the next verb might race
        // ahead of WebKit's event queue draining the trail.
        sleepMs(mouseDownDelayMs)

        if releaseAtEnd {
            guard let up = CGEvent(
                mouseEventSource: source,
                mouseType: button.upType,
                mouseCursorPosition: toScreen,
                mouseButton: button.cgButton,
            ) else {
                throw NativeEventError.eventCreationFailed("drag mouseUp")
            }
            post(up)
            sleepMs(mouseUpDelayMs)
        }
    }

    // MARK: - Mouse primitives

    /// Individual mouse-down half. Only needed for niche scenarios
    /// (hover-while-modifier-held, modal-dismiss patterns) where
    /// `holdModifier` + click is not enough. Tests should prefer
    /// `nativeClick` / `nativeDrag`.
    ///
    /// The click state is set explicitly to 1. A CGEvent left alone
    /// carries click state 0, which WebKit reports as `detail: 0` —
    /// a press that is not the first click of anything. No press a
    /// person can make looks like that, and code that keys off
    /// `detail` (CM6's own pointer selection does) takes a different
    /// branch for it, so a test driving this primitive would exercise
    /// a path the app never sees in the field.
    func nativeMouseDown(
        viewportPoint: CGPoint,
        button: MouseButton = .left,
    ) throws {
        activateSelf()
        let screenPoint = try resolveScreenPoint(viewportPoint)
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: button.downType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseDown")
        }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        post(event)
    }

    /// Individual mouse-up half. See `nativeMouseDown` caveats.
    func nativeMouseUp(
        viewportPoint: CGPoint,
        button: MouseButton = .left,
    ) throws {
        activateSelf()
        let screenPoint = try resolveScreenPoint(viewportPoint)
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: button.upType,
            mouseCursorPosition: screenPoint,
            mouseButton: button.cgButton,
        ) else {
            throw NativeEventError.eventCreationFailed("mouseUp")
        }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        post(event)
    }

    // MARK: - Keyboard

    /// Post a single keystroke with optional modifiers. `key` is an
    /// entry in `VirtualKeyMap` (ASCII char or named key like
    /// `"ArrowLeft"`). Modifiers are posted via `holdModifier`, so
    /// the single `CGEventSource` instance tracks their state during
    /// the keystroke.
    ///
    /// If the key itself requires Shift (e.g. `"A"`, `"!"`) AND
    /// Shift is not already in `modifiers`, we press it transparently
    /// around the keystroke. Call sites that want explicit control
    /// over Shift can pass `.shift` in `modifiers`.
    ///
    /// A post-sequence settle (`NATIVE_KEY_POST_SEQUENCE_SETTLE_MS`)
    /// fires after `holdModifier` returns so the modifier-release
    /// events fully drain before the function returns. Back-to-back
    /// `nativeKey` calls without this settle can race the previous
    /// call's modifier release with the next call's modifier press,
    /// leaving windowserver's modifier table in an inconsistent
    /// state — observed symptom: inadvertent global hotkey triggers
    /// (Cmd-Ctrl-Space emoji picker, Fn-Fn dictation).
    /// Modifiers currently held down by `holdModifier` or by a transparent
    /// Shift, in press order. Read by `postKeyEvent` — see the note there.
    private var heldModifiers: [ModifierKey] = []

    /// Modifiers held down by `pressModifier(persistent:)` and not yet
    /// released — the ONE piece of native-event state that outlives a single
    /// verb, and therefore the one piece that is static.
    ///
    /// `holdModifier`'s scope cannot answer "what does the UI look like while
    /// this modifier is down": its inner verbs are buffered and shipped as one
    /// RPC, so `evalJS` and `waitForCondition` are rejected inside it. A test
    /// that needs to READ the held state — the chord ring's whole subject, a
    /// default button that paints dashed until Shift goes down — needs the
    /// press and the release to be separate round trips with arbitrary
    /// introspection between them. That means the held set has to survive the
    /// per-verb handler instance, and `NativeEventHandlers` is created fresh
    /// per verb by design (see `dispatchNativeVerb`).
    ///
    /// Static rather than connection-scoped so an ordinary `nativeKey` /
    /// `nativeClick` issued mid-hold still stamps the flag: the modifier is
    /// physically down at the windowserver, and an event that failed to carry
    /// it would be a lie the test could not see.
    private static var persistentlyHeldModifiers: [ModifierKey] = []

    /// The `CGEventFlags` union of everything currently down — this verb's own
    /// `holdModifier` / transparent-Shift set plus any persistent hold.
    private var heldFlags: CGEventFlags {
        var flags: CGEventFlags = []
        for mod in heldModifiers {
            flags.insert(mod.eventFlag)
        }
        for mod in Self.persistentlyHeldModifiers {
            flags.insert(mod.eventFlag)
        }
        return flags
    }

    /// Press `modifiers` and LEAVE them down across RPCs, so the caller can
    /// `evalJS` against the UI while they are held. Every press must be paired
    /// with {@link releaseHeldModifiers}; the harness client's `withModifierHeld`
    /// pairs them in a `finally`, and `releaseAllHeldModifiers` is the backstop
    /// at teardown. A modifier left down is not a cosmetic leak — the file's
    /// own warning applies: a stale flag turns the next keystroke into a system
    /// chord (emoji picker, dictation).
    ///
    /// Already-held modifiers are skipped rather than double-pressed, so a
    /// repeated press is idempotent and its release still lands.
    func pressHeldModifiers(_ modifiers: [ModifierKey]) {
        activateSelf()
        for mod in modifiers {
            if Self.persistentlyHeldModifiers.contains(mod) { continue }
            // Appended BEFORE the post so the modifier's own keyDown already
            // carries its flag — what a real `flagsChanged` looks like.
            Self.persistentlyHeldModifiers.append(mod)
            postKeyEvent(keyCode: mod.keyCode, keyDown: true)
        }
        sleepMs(NATIVE_KEY_POST_SEQUENCE_SETTLE_MS)
    }

    /// Release `modifiers` from the persistent hold, in reverse press order.
    func releaseHeldModifiers(_ modifiers: [ModifierKey]) {
        for mod in modifiers.reversed() {
            guard let index = Self.persistentlyHeldModifiers.lastIndex(of: mod) else {
                continue
            }
            // Dropped BEFORE the post so the release itself no longer carries
            // the flag.
            Self.persistentlyHeldModifiers.remove(at: index)
            postKeyEvent(keyCode: mod.keyCode, keyDown: false)
        }
        sleepMs(NATIVE_KEY_POST_SEQUENCE_SETTLE_MS)
    }

    /// Release every persistently-held modifier. Called at connection teardown
    /// so a test that threw mid-hold cannot leave Shift down for whatever runs
    /// next on this machine.
    func releaseAllHeldModifiers() {
        releaseHeldModifiers(Self.persistentlyHeldModifiers)
    }

    func nativeKey(key: String, modifiers: [ModifierKey] = []) throws {
        activateSelf()
        guard let mapping = VirtualKeyMap.lookup(key) else {
            throw NativeEventError.unknownKey(key)
        }
        // Inner closure does not throw (postKeyEvent returns void),
        // so the `rethrows` on `holdModifier` doesn't fire — no `try`
        // on this call.
        holdModifier(modifiers: modifiers) { [self] in
            let shiftOverride = mapping.needsShift && !modifiers.contains(.shift)
            if shiftOverride {
                pressModifier(.shift)
            }
            postKeyEvent(keyCode: mapping.keyCode, keyDown: true)
            postKeyEvent(keyCode: mapping.keyCode, keyDown: false)
            if shiftOverride {
                releaseModifier(.shift)
            }
        }
        sleepMs(NATIVE_KEY_POST_SEQUENCE_SETTLE_MS)
    }

    /// Type an ASCII string via a sequence of keystrokes. Non-ASCII
    /// input is rejected up-front (before any events are posted) so
    /// the caller sees a typed error instead of a partial typing.
    ///
    /// Two robustness measures:
    ///
    /// 1. **Sticky shift**: when a run of shift-needing characters
    ///    appears (e.g., "ABC", "!@#"), Shift is pressed once at
    ///    the start of the run and released once at the end —
    ///    *not* toggled between every char. Toggling between
    ///    consecutive shift-needing chars produces a brief
    ///    Shift-up/Shift-down pair that can be misinterpreted by
    ///    windowserver under load and dropped from the event
    ///    stream.
    ///
    /// 2. **Inter-char gap** (`NATIVE_TYPE_INTER_CHAR_MS`): a small
    ///    sleep between consecutive characters keeps the OS event
    ///    queue drained. Posting all events at full speed on long
    ///    strings (the at0042 long-line case) saturates the queue
    ///    and windowserver silently drops trailing events —
    ///    observed symptom: the last few characters of a typed
    ///    string don't land in the doc.
    ///
    /// 3. **Post-sequence settle** (same as `nativeKey`): trailing
    ///    Shift-release fully drains before the function returns.
    func nativeType(text: String) throws {
        activateSelf()
        // Reject non-ASCII before posting anything. Inspect the
        // first offending scalar so the error message is actionable.
        for scalar in text.unicodeScalars {
            if !scalar.isASCII {
                let excerpt = String(scalar)
                throw NativeEventError.asciiOnly(excerpt)
            }
        }
        // Each grapheme-cluster is a single printable character here
        // (we already rejected non-ASCII), so iterating `text` (not
        // `text.unicodeScalars`) is safe. Named keys like "Enter"
        // cannot be expressed as single chars; callers use
        // `nativeKey("Enter")` for those.
        var shiftHeld = false
        // `defer` guarantees Shift is released even if a later
        // `VirtualKeyMap.lookup` throws an unknown-key error
        // mid-string — no danger of a stuck modifier bleeding into
        // the next test.
        defer {
            if shiftHeld {
                releaseModifier(.shift)
            }
            sleepMs(NATIVE_KEY_POST_SEQUENCE_SETTLE_MS)
        }
        var first = true
        for char in text {
            let name = String(char)
            guard let mapping = VirtualKeyMap.lookup(name) else {
                throw NativeEventError.unknownKey(name)
            }
            if !first {
                sleepMs(NATIVE_TYPE_INTER_CHAR_MS)
            }
            first = false
            // Sticky shift: only toggle when the requirement
            // changes. Avoids the double-toggle hazard of
            // Shift-up immediately followed by Shift-down on
            // consecutive shift-needing chars.
            if mapping.needsShift && !shiftHeld {
                pressModifier(.shift)
                sleepMs(NATIVE_MODIFIER_SETTLE_MS)
                shiftHeld = true
            } else if !mapping.needsShift && shiftHeld {
                releaseModifier(.shift)
                sleepMs(NATIVE_MODIFIER_SETTLE_MS)
                shiftHeld = false
            }
            postKeyEvent(keyCode: mapping.keyCode, keyDown: true)
            postKeyEvent(keyCode: mapping.keyCode, keyDown: false)
        }
    }

    /// Press the given modifiers in order, run `inner`, release them
    /// in reverse order. `defer` ensures modifiers are released even
    /// if `inner` throws — no danger of a stuck modifier bleeding
    /// into the next test. Uses the same `CGEventSource` for press
    /// and release so the source's modifier state stays coherent.
    func holdModifier(
        modifiers: [ModifierKey],
        inner: () throws -> Void,
    ) rethrows {
        if !modifiers.isEmpty {
            activateSelf()
        }
        for mod in modifiers {
            pressModifier(mod)
        }
        // Let the modifier bits propagate to the app's main thread
        // before the inner keystroke arrives. See
        // `NATIVE_MODIFIER_SETTLE_MS` for the rationale.
        if !modifiers.isEmpty {
            sleepMs(NATIVE_MODIFIER_SETTLE_MS)
        }
        defer {
            if !modifiers.isEmpty {
                // Same reasoning in reverse: give the inner events
                // time to land before the modifier release arrives
                // so WebKit's handler sees the flag on the inner
                // event. Without this, a fast release can clobber
                // the flag on the already-queued 'a' keyUp.
                sleepMs(NATIVE_MODIFIER_SETTLE_MS)
            }
            for mod in modifiers.reversed() {
                releaseModifier(mod)
            }
        }
        try inner()
    }

    // MARK: - Helpers

    /// Raise Tug.app to frontmost. CGEvent mouse events route via
    /// windowserver → frontmost window at the target screen coord,
    /// so Tug.app must be on top for clicks to land on its WKWebView.
    ///
    /// Safe to call from any queue. `NSApp.activate` is main-thread-
    /// only, so we marshal via a synchronous hop.
    ///
    /// A no-op in pid mode: `postToPid` delivery never consults
    /// WindowServer's z-order, and activating would steal the user's
    /// focus — the thing the mode exists to avoid.
    private func activateSelf() {
        if postToOwnPid { return }
        if Thread.isMainThread {
            NSApp.activate(ignoringOtherApps: true)
        } else {
            DispatchQueue.main.sync {
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    /// Resolve a viewport (CSS) coord to screen CG, or throw
    /// `coordinateOutOfBounds`.
    ///
    /// `CoordMapping.viewportToScreen` reaches into AppKit
    /// (`webView.convert`, `window.convertToScreen`, `NSScreen`) —
    /// those are main-thread-only. Callers from a background queue
    /// get a synchronous main-thread hop; callers already on main
    /// execute inline.
    private func resolveScreenPoint(_ viewport: CGPoint) throws -> CGPoint {
        if Thread.isMainThread {
            return try resolveScreenPointOnMain(viewport)
        }
        var result: Result<CGPoint, Error>!
        DispatchQueue.main.sync {
            do {
                result = .success(try self.resolveScreenPointOnMain(viewport))
            } catch {
                result = .failure(error)
            }
        }
        switch result {
        case .success(let p): return p
        case .failure(let e): throw e
        case .none: throw NativeEventError.webViewUnavailable
        }
    }

    private func resolveScreenPointOnMain(_ viewport: CGPoint) throws -> CGPoint {
        guard let webView = self.webView else {
            throw NativeEventError.webViewUnavailable
        }
        guard let screenPoint = CoordMapping.viewportToScreen(viewport, in: webView) else {
            throw NativeEventError.coordinateOutOfBounds(viewport)
        }
        return screenPoint
    }

    /// Post a plain keyDown or keyUp for `keyCode` via the handler's
    /// shared `CGEventSource`. Per [Q05], NO manual `.flags` setter
    /// and NO `type = .flagsChanged` override — the source's state
    /// table auto-stamps flags on events posted after a modifier
    /// keyDown.
    /// Press `mod` and record it as held, so every event posted while it is
    /// down carries its flag.
    private func pressModifier(_ mod: ModifierKey) {
        heldModifiers.append(mod)
        postKeyEvent(keyCode: mod.keyCode, keyDown: true)
    }

    /// Release `mod`. Dropped from the held set BEFORE the post, so the
    /// release event itself no longer carries the flag — what a real
    /// `flagsChanged` looks like.
    private func releaseModifier(_ mod: ModifierKey) {
        if let index = heldModifiers.lastIndex(of: mod) {
            heldModifiers.remove(at: index)
        }
        postKeyEvent(keyCode: mod.keyCode, keyDown: false)
    }

    private func postKeyEvent(keyCode: CGKeyCode, keyDown: Bool) {
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: keyDown,
        ) else {
            // Non-fatal: log and continue. The caller's inner verb
            // may still succeed if this event was ancillary (e.g. a
            // Shift release that failed to build).
            NSLog("tughost.native.postKeyEvent.failed keyCode=0x%02X keyDown=%@",
                  keyCode, keyDown ? "true" : "false")
            return
        }
        // Stamp the flags rather than inheriting them. `CGEvent(keyboardEvent
        // Source:)` derives its flags from the source's own modifier
        // bookkeeping, and that bookkeeping does not survive two modifier
        // presses in a row: a ⌥⌘ chord reaches WebKit with `metaKey` true and
        // `altKey` false, so a two-modifier binding never matches. Stamping the
        // held set makes the flags a function of what the harness asked for.
        event.flags = heldFlags
        post(event)
    }

    /// Sleep the main thread. Used between event posts to give WebKit
    /// time to dispatch the prior event before the next one arrives.
    /// No-op for `ms <= 0`.
    private func sleepMs(_ ms: Int) {
        guard ms > 0 else { return }
        Thread.sleep(forTimeInterval: Double(ms) / 1000.0)
    }
}
#endif
