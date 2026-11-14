#if DEBUG
import Carbon.HIToolbox
import AppKit

// MARK: - LabInputSource
//
// The harness's keyboard-layout verbs: list the installed keyboard input
// sources, and select one by its `kTISPropertyInputSourceID`
// (`com.apple.keylayout.French`, `com.apple.keylayout.DVORAK-QWERTYCMD`, …).
//
// The input source belongs to the whole login session, not to this app.
// Selecting one changes the keyboard of every app the user is running, and it
// stays changed until something selects another. So `select` acts only in a
// lab guest — an app launched with `TUG_LAB=1`, which `scripts/lab/guest-app-test`
// sets and a host run never does — and refuses everywhere else with an error
// naming the flag. A refusal is a red the test author sees; ignoring the call
// would let a layout test pass while measuring US.
//
// Listing is read-only and allowed anywhere: it is how a test finds the exact
// ID spelling a guest offers, and it changes nothing.
//
// TIS is main-thread API; every function here expects the main thread.

enum LabInputSource {

    /// The environment variable that marks a lab run.
    static let flag = "TUG_LAB"

    /// Whether this app was launched by a lab run.
    static var isLab: Bool {
        ProcessInfo.processInfo.environment[flag] == "1"
    }

    /// The current keyboard input source's ID.
    static func current() -> String? {
        TugApplication.inputSourceNow()
    }

    /// Every installed keyboard input source that can be selected: its ID,
    /// its localized name, and whether it is enabled and selected now.
    static func installed() -> [[String: Any]] {
        let filter: [String: Any] = [
            kTISPropertyInputSourceCategory as String: kTISCategoryKeyboardInputSource as String,
            kTISPropertyInputSourceIsSelectCapable as String: true,
        ]
        let sources = sourceList(filter: filter)
        return sources.compactMap { source -> [String: Any]? in
            guard let id: String = property(source, kTISPropertyInputSourceID) else { return nil }
            return [
                "id": id,
                "name": (property(source, kTISPropertyLocalizedName) as String?) ?? id,
                "enabled": (property(source, kTISPropertyInputSourceIsEnabled) as Bool?) ?? false,
                "selected": (property(source, kTISPropertyInputSourceIsSelected) as Bool?) ?? false,
            ]
        }
    }

    /// Select the input source `id`, enabling it first if the guest has not,
    /// and return the ID of the one it replaced.
    ///
    /// Throws `labOnly` outside a lab run, before anything is touched.
    static func select(_ id: String) throws -> String {
        guard isLab else { throw NativeEventError.labOnly("selectInputSource") }
        guard let previous = current() else {
            throw NativeEventError.inputSource("cannot read the current input source")
        }
        let matches = sourceList(filter: [kTISPropertyInputSourceID as String: id])
        guard let source = matches.first else {
            throw NativeEventError.inputSource(
                "no installed input source has ID \"\(id)\" (list them with inputSources)"
            )
        }
        if !((property(source, kTISPropertyInputSourceIsEnabled) as Bool?) ?? false) {
            let status = TISEnableInputSource(source)
            guard status == noErr else {
                throw NativeEventError.inputSource("TISEnableInputSource(\(id)) failed: \(status)")
            }
        }
        let status = TISSelectInputSource(source)
        guard status == noErr else {
            throw NativeEventError.inputSource("TISSelectInputSource(\(id)) failed: \(status)")
        }
        // The selection is normally visible at once; give the text input
        // system a moment of the run loop if it is not, and say so if it never is.
        let deadline = Date().addingTimeInterval(2)
        while current() != id && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        guard current() == id else {
            throw NativeEventError.inputSource(
                "selected \"\(id)\" but the current input source is still \"\(current() ?? "?")\""
            )
        }
        return previous
    }

    /// Select `id` again at teardown, with no lab check: it is only ever
    /// called with an ID `select` replaced, which proves this is a lab run.
    static func restore(_ id: String) {
        let matches = sourceList(filter: [kTISPropertyInputSourceID as String: id])
        guard let source = matches.first else {
            NSLog("tughost.inputSource.restore: no input source \"%@\"", id)
            return
        }
        let status = TISSelectInputSource(source)
        if status != noErr {
            NSLog("tughost.inputSource.restore: TISSelectInputSource(%@) failed: %d", id, status)
        }
    }

    // MARK: - TIS helpers

    private static func sourceList(filter: [String: Any]) -> [TISInputSource] {
        guard let list = TISCreateInputSourceList(filter as CFDictionary, true)?.takeRetainedValue() else {
            return []
        }
        return (list as? [TISInputSource]) ?? []
    }

    private static func property<T>(_ source: TISInputSource, _ key: CFString) -> T? {
        guard let raw = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<AnyObject>.fromOpaque(raw).takeUnretainedValue() as? T
    }
}

// MARK: - MenuKeyProbe
//
// Which menu item a key equivalent reaches, without performing it. A layout
// recording has to learn what AppKit's localized key-equivalent matching does
// with ⌘ + every key, and that includes keys that resolve to Quit, Close and
// Hide; performing those would end the run it is measuring.
//
// While armed, `TugApplication.sendAction(_:to:from:)` hands every action sent
// from an `NSMenuItem` here and reports it handled, so the item is matched as
// AppKit matches it and its action never runs. Arming also turns menu
// validation off and enables every item, restoring both at disarm: the
// question is which item a key reaches, and an item disabled because no card
// has focus would otherwise answer "none" for a reason that has nothing to do
// with the key. Disarmed — the
// state every launch starts in, and the one `close()` returns to — it is not
// consulted at all. It is app-local, so unlike the input source it needs no
// lab flag.
//
// Main thread only: `sendAction` is called there, and so are the verbs.

enum MenuKeyProbe {

    private(set) static var armed = false
    private static var fired: [[String: Any]] = []
    /// Each menu's `autoenablesItems` and each item's `isEnabled` as arming found them.
    private static var savedMenus: [(NSMenu, Bool)] = []
    private static var savedItems: [(NSMenuItem, Bool)] = []

    /// Start swallowing menu actions, with an empty record and every item enabled.
    static func arm() {
        fired = []
        if !armed, let menu = NSApp.mainMenu { enableAll(menu) }
        armed = true
    }

    /// Stop swallowing and put validation back; menu actions perform again.
    static func disarm() {
        for (menu, autoenables) in savedMenus { menu.autoenablesItems = autoenables }
        for (item, enabled) in savedItems { item.isEnabled = enabled }
        savedMenus = []
        savedItems = []
        armed = false
        fired = []
    }

    private static func enableAll(_ menu: NSMenu) {
        savedMenus.append((menu, menu.autoenablesItems))
        menu.autoenablesItems = false
        for item in menu.items {
            savedItems.append((item, item.isEnabled))
            item.isEnabled = true
            if let submenu = item.submenu { enableAll(submenu) }
        }
    }

    /// The items fired since the last `take`, oldest first, and an empty record.
    static func take() -> [[String: Any]] {
        defer { fired = [] }
        return fired
    }

    /// Note one swallowed menu action.
    static func record(_ item: NSMenuItem, action: Selector) {
        fired.append([
            "identifier": item.identifier?.rawValue ?? NSNull(),
            "title": item.title,
            "keyEquivalent": item.keyEquivalent,
            "modifiers": modifierNames(item.keyEquivalentModifierMask),
            "action": NSStringFromSelector(action),
        ])
    }

    private static func modifierNames(_ mask: NSEvent.ModifierFlags) -> [String] {
        var names: [String] = []
        if mask.contains(.control) { names.append("ctrl") }
        if mask.contains(.option) { names.append("alt") }
        if mask.contains(.shift) { names.append("shift") }
        if mask.contains(.command) { names.append("cmd") }
        return names
    }
}
#endif
