import Cocoa

#if DEBUG
import Carbon.HIToolbox

/// The application object, with one harness-only difference.
///
/// In pid mode (`TUGAPP_NATIVE_EVENT_MODE=pid`) the app-test harness drives
/// the app without activating it, so the user keeps their keyboard. AppKit
/// refuses key status to an inactive app's window, and everything that makes
/// a background launch unlike a foreground one follows from that refusal:
/// `-[NSApplication sendEvent:]` offers a ⌘ chord to the menu before the
/// views, a nil-target Edit action resolves against nothing, and WebKit never
/// reads the window active. Measured 2026-10-21 in a throwaway accessory app:
/// with only `isActive` overridden to true, the real `makeKey()` succeeds —
/// `isKeyWindow` and `isMainWindow` set, the window delegate told, a ⌘A sent
/// through `sendEvent` reaching the page view-first — while
/// `NSWorkspace.frontmostApplication` stays the user's app and a key posted
/// to the session tap never arrives here. So in pid mode the app believes it
/// is active, and its window is really key.
///
/// `keyWindow` and `mainWindow` are overridden too, because AppKit's own
/// accessors keep answering nil while the app is inactive, and a nil-target
/// action send consults the accessor. They return the window that really is
/// key or main, never a window that is not, so they only report AppKit's own
/// state.
///
/// Outside pid mode every override defers to AppKit, and the class does not
/// exist in Release at all. `NSPrincipalClass` in `Info.plist` stays
/// `NSApplication`: the app has its own `main.swift` and never runs
/// `NSApplicationMain`, which is the one reader of that key, so the class is
/// chosen here and the plist would be declaring a class a Release build does
/// not carry.
final class TugApplication: NSApplication {
    /// Readings taken before `run()`, so a test can pin that a launch moved
    /// neither the user's frontmost app nor their keyboard input source.
    private(set) static var frontmostAtLaunch: String?
    private(set) static var inputSourceAtLaunch: String?

    /// The user's frontmost app, by bundle identifier.
    static func frontmostNow() -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    /// The current keyboard input source, by its `kTISPropertyInputSourceID`.
    static func inputSourceNow() -> String? {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
        return Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
    }

    static func recordLaunchReadings() {
        frontmostAtLaunch = frontmostNow()
        inputSourceAtLaunch = inputSourceNow()
    }

    /// A menu item's action while the harness's `MenuKeyProbe` is armed is
    /// recorded and reported handled instead of performed, so a layout
    /// recording can learn which item a key reaches without quitting on ⌘Q.
    override func sendAction(_ action: Selector, to target: Any?, from sender: Any?) -> Bool {
        if MenuKeyProbe.armed, let item = sender as? NSMenuItem {
            MenuKeyProbe.record(item, action: action)
            return true
        }
        return super.sendAction(action, to: target, from: sender)
    }

    override var isActive: Bool {
        AppDelegate.harnessPidMode ? AppDelegate.harnessAppActive : super.isActive
    }

    override var keyWindow: NSWindow? {
        guard AppDelegate.harnessPidMode else { return super.keyWindow }
        guard AppDelegate.harnessAppActive else { return nil }
        return super.keyWindow ?? windows.first { $0.isKeyWindow }
    }

    override var mainWindow: NSWindow? {
        guard AppDelegate.harnessPidMode else { return super.mainWindow }
        guard AppDelegate.harnessAppActive else { return nil }
        return super.mainWindow ?? windows.first { $0.isMainWindow }
    }
}

let app = TugApplication.shared
TugApplication.recordLaunchReadings()
#else
let app = NSApplication.shared
#endif

// A copy that finds its instance already running, live at the registry's
// bundle path, hands its launch to that copy and quits; it never constructs
// `AppDelegate`, so it touches none of the running instance's state. Any
// other launch proceeds, and a duplicate that slipped past this check still
// meets tugcast's guard and the takeover alert.
switch LaunchHandoff.decideForThisLaunch() {
case .handOff(let entry):
    let handoff = LaunchHandoffDelegate(entry: entry)
    app.delegate = handoff
    app.run()
case .proceed:
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
