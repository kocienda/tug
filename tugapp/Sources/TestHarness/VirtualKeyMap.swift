#if DEBUG
import CoreGraphics
import Foundation

// MARK: - VirtualKeyMap
//
// ASCII-name → `CGKeyCode` + shift-required lookup table for
// US-English keyboards. Fuels `NativeEventHandlers.nativeKey(key:modifiers:)`
// and `nativeType(text:)`.
//
// Coverage per the 2026-04-24 user call ("US-English ASCII is
// enough for Phase C"):
//
//   - 26 lowercase letters and 26 uppercase letters (shift-required).
//   - 10 digits and 10 shifted-symbol overlays (`!@#$%^&*()`).
//   - Unshifted punctuation: space, comma, period, slash, semicolon,
//     single-quote, brackets, backslash, minus, equal, backtick.
//   - Shifted punctuation: `_ + { } | : " < > ? ~`.
//   - Named keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`,
//     `Home`, `End`, `PageUp`, `PageDown`, `ArrowLeft`, `ArrowRight`,
//     `ArrowUp`, `ArrowDown`.
//
// Non-ASCII input is rejected at the `nativeType` layer (returns
// `NativeTypeAsciiOnlyError`); lookups for unknown names return nil
// and callers translate to `UnknownKeyError` at the RPC boundary.
//
// The table is hand-maintained. Mac virtual keycodes for a US layout
// are a fixed table defined in `<Carbon/HIToolbox/Events.h>`
// (`kVK_ANSI_*`). The NAMES here are US characters; a test that means a
// physical key under another layout names it by `KeyboardEvent.code`
// through `lookupCode` instead.
//
// Modifier keycodes (`0x37`=Command, `0x38`=Shift, `0x3A`=Option,
// `0x3B`=Control) are NOT in this table — they're handled by the
// `ModifierKey` enum in `NativeEventHandlers.swift`. This table is
// for character / named-key input only.

struct KeyMapping: Equatable {
    let keyCode: CGKeyCode
    let needsShift: Bool
}

enum VirtualKeyMap {

    /// Lookup by symbol / key name. Returns nil for unknown entries.
    /// Case-sensitive: `"a"` and `"A"` map to the same keycode but
    /// different `needsShift` values.
    static func lookup(_ name: String) -> KeyMapping? {
        return table[name]
    }

    /// Lookup by physical position, named the way the DOM names it: a
    /// `KeyboardEvent.code` such as `"KeyQ"`, `"Digit1"`, `"Semicolon"`.
    /// Returns nil for an unknown code.
    ///
    /// A code names a key, not a character, so it carries no Shift: the key
    /// at `"KeyQ"` types "q" on US, "a" on AZERTY and "й" on Russian, and
    /// which one is the keyboard layout's business. This is what a layout
    /// test addresses keys by, because `lookup`'s names are US characters.
    /// The macOS virtual keycodes ARE positions (`kVK_ANSI_Q` is the key in
    /// the US Q slot on every layout), so the table is a fixed one.
    static func lookupCode(_ code: String) -> CGKeyCode? {
        return codeTable[code]
    }

    /// `KeyboardEvent.code` → virtual keycode, per `<Carbon/HIToolbox/Events.h>`
    /// (`kVK_ANSI_*`, `kVK_ISO_Section`, and the layout-independent named keys).
    private static let codeTable: [String: CGKeyCode] = {
        var t: [String: CGKeyCode] = [:]
        let letters: [(String, CGKeyCode)] = [
            ("A", 0x00), ("B", 0x0B), ("C", 0x08), ("D", 0x02), ("E", 0x0E),
            ("F", 0x03), ("G", 0x05), ("H", 0x04), ("I", 0x22), ("J", 0x26),
            ("K", 0x28), ("L", 0x25), ("M", 0x2E), ("N", 0x2D), ("O", 0x1F),
            ("P", 0x23), ("Q", 0x0C), ("R", 0x0F), ("S", 0x01), ("T", 0x11),
            ("U", 0x20), ("V", 0x09), ("W", 0x0D), ("X", 0x07), ("Y", 0x10),
            ("Z", 0x06),
        ]
        for (letter, code) in letters { t["Key\(letter)"] = code }
        let digits: [CGKeyCode] = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19]
        for (i, code) in digits.enumerated() { t["Digit\(i)"] = code }
        let named: [(String, CGKeyCode)] = [
            ("Minus", 0x1B),
            ("Equal", 0x18),
            ("BracketLeft", 0x21),
            ("BracketRight", 0x1E),
            ("Backslash", 0x2A),
            ("Semicolon", 0x29),
            ("Quote", 0x27),
            ("Backquote", 0x32),
            ("Comma", 0x2B),
            ("Period", 0x2F),
            ("Slash", 0x2C),
            // The extra key an ISO board has beside left Shift
            // (`kVK_ISO_Section`). WebKit reports it as `IntlBackslash`.
            ("IntlBackslash", 0x0A),
            ("Space", 0x31),
            ("Enter", 0x24),
            ("Tab", 0x30),
            ("Escape", 0x35),
            ("Backspace", 0x33),
            ("Delete", 0x75),
            ("Home", 0x73),
            ("End", 0x77),
            ("PageUp", 0x74),
            ("PageDown", 0x79),
            ("ArrowLeft", 0x7B),
            ("ArrowRight", 0x7C),
            ("ArrowUp", 0x7E),
            ("ArrowDown", 0x7D),
        ]
        for (name, code) in named { t[name] = code }
        return t
    }()

    // MARK: - Table
    //
    // Declared as a computed static so the builder can share helper
    // functions without leaking them to module scope. `static let`
    // would force the whole table into one giant literal; the
    // builder style stays readable even as the table grows.

    private static let table: [String: KeyMapping] = {
        var t: [String: KeyMapping] = [:]

        // ------- Letters (US-English, ANSI keycodes) -------

        let letters: [(String, CGKeyCode)] = [
            ("a", 0x00),
            ("b", 0x0B),
            ("c", 0x08),
            ("d", 0x02),
            ("e", 0x0E),
            ("f", 0x03),
            ("g", 0x05),
            ("h", 0x04),
            ("i", 0x22),
            ("j", 0x26),
            ("k", 0x28),
            ("l", 0x25),
            ("m", 0x2E),
            ("n", 0x2D),
            ("o", 0x1F),
            ("p", 0x23),
            ("q", 0x0C),
            ("r", 0x0F),
            ("s", 0x01),
            ("t", 0x11),
            ("u", 0x20),
            ("v", 0x09),
            ("w", 0x0D),
            ("x", 0x07),
            ("y", 0x10),
            ("z", 0x06),
        ]
        for (lower, code) in letters {
            t[lower] = KeyMapping(keyCode: code, needsShift: false)
            t[lower.uppercased()] = KeyMapping(keyCode: code, needsShift: true)
        }

        // ------- Digits and their shifted overlays -------

        let digits: [(String, CGKeyCode, String)] = [
            ("0", 0x1D, ")"),
            ("1", 0x12, "!"),
            ("2", 0x13, "@"),
            ("3", 0x14, "#"),
            ("4", 0x15, "$"),
            ("5", 0x17, "%"),
            ("6", 0x16, "^"),
            ("7", 0x1A, "&"),
            ("8", 0x1C, "*"),
            ("9", 0x19, "("),
        ]
        for (digit, code, shifted) in digits {
            t[digit] = KeyMapping(keyCode: code, needsShift: false)
            t[shifted] = KeyMapping(keyCode: code, needsShift: true)
        }

        // ------- Unshifted + shifted punctuation on the
        //          letter/digit rows' neighbor keys -------

        let punctuation: [(unshifted: String, shifted: String, keyCode: CGKeyCode)] = [
            (" ", " ", 0x31),       // Space — no shift overlay.
            (",", "<", 0x2B),
            (".", ">", 0x2F),
            ("/", "?", 0x2C),
            (";", ":", 0x29),
            ("'", "\"", 0x27),
            ("[", "{", 0x21),
            ("]", "}", 0x1E),
            ("\\", "|", 0x2A),
            ("-", "_", 0x1B),
            ("=", "+", 0x18),
            ("`", "~", 0x32),
        ]
        for (unshifted, shifted, code) in punctuation {
            t[unshifted] = KeyMapping(keyCode: code, needsShift: false)
            if shifted != unshifted {
                t[shifted] = KeyMapping(keyCode: code, needsShift: true)
            }
        }

        // ------- Named non-printable keys -------
        //
        // Names match DOM `KeyboardEvent.key` values where they
        // overlap (e.g. `"ArrowLeft"`, `"Enter"`, `"Escape"`) so TS
        // callers can pass `event.key` strings through unchanged.

        let named: [(String, CGKeyCode)] = [
            ("Enter", 0x24),
            ("Return", 0x24),        // alias
            ("Tab", 0x30),
            ("Escape", 0x35),
            ("Backspace", 0x33),     // Mac calls this "Delete" in kVK_*
            ("Delete", 0x75),        // forward delete
            ("Home", 0x73),
            ("End", 0x77),
            ("PageUp", 0x74),
            ("PageDown", 0x79),
            ("ArrowLeft", 0x7B),
            ("ArrowRight", 0x7C),
            ("ArrowUp", 0x7E),
            ("ArrowDown", 0x7D),
        ]
        for (name, code) in named {
            t[name] = KeyMapping(keyCode: code, needsShift: false)
        }

        return t
    }()

    // MARK: - Self-test cases
    //
    // Hand-rolled regression cases (no XCTest target yet — upgrade
    // to XCTestCase when `NativeEventHandlers` acquires a
    // test target). Each case is a (name → expected mapping) pair;
    // runUnitTests() iterates and returns failures.

    static func runUnitTests() -> [(String, Bool)] {
        let cases: [(String, KeyMapping)] = [
            // Letters: lowercase unshifted, uppercase shifted.
            ("a", KeyMapping(keyCode: 0x00, needsShift: false)),
            ("A", KeyMapping(keyCode: 0x00, needsShift: true)),
            ("z", KeyMapping(keyCode: 0x06, needsShift: false)),
            ("Z", KeyMapping(keyCode: 0x06, needsShift: true)),
            // Digits and shifted overlays.
            ("0", KeyMapping(keyCode: 0x1D, needsShift: false)),
            (")", KeyMapping(keyCode: 0x1D, needsShift: true)),
            ("1", KeyMapping(keyCode: 0x12, needsShift: false)),
            ("!", KeyMapping(keyCode: 0x12, needsShift: true)),
            // Punctuation.
            (" ", KeyMapping(keyCode: 0x31, needsShift: false)),
            (",", KeyMapping(keyCode: 0x2B, needsShift: false)),
            ("<", KeyMapping(keyCode: 0x2B, needsShift: true)),
            ("/", KeyMapping(keyCode: 0x2C, needsShift: false)),
            ("?", KeyMapping(keyCode: 0x2C, needsShift: true)),
            ("`", KeyMapping(keyCode: 0x32, needsShift: false)),
            ("~", KeyMapping(keyCode: 0x32, needsShift: true)),
            // Named.
            ("Enter", KeyMapping(keyCode: 0x24, needsShift: false)),
            ("Return", KeyMapping(keyCode: 0x24, needsShift: false)),
            ("Tab", KeyMapping(keyCode: 0x30, needsShift: false)),
            ("Escape", KeyMapping(keyCode: 0x35, needsShift: false)),
            ("Backspace", KeyMapping(keyCode: 0x33, needsShift: false)),
            ("Delete", KeyMapping(keyCode: 0x75, needsShift: false)),
            ("ArrowLeft", KeyMapping(keyCode: 0x7B, needsShift: false)),
            ("ArrowRight", KeyMapping(keyCode: 0x7C, needsShift: false)),
            ("ArrowUp", KeyMapping(keyCode: 0x7E, needsShift: false)),
            ("ArrowDown", KeyMapping(keyCode: 0x7D, needsShift: false)),
        ]

        var failures: [(String, Bool)] = []
        for (name, expected) in cases {
            let got = VirtualKeyMap.lookup(name)
            let ok = got == expected
            if !ok {
                failures.append((
                    "VirtualKeyMap.lookup(\"\(name)\") = \(String(describing: got)) ; expected \(expected)",
                    false,
                ))
            }
        }

        // Negative: unknown name returns nil.
        if VirtualKeyMap.lookup("NotARealKey") != nil {
            failures.append(("VirtualKeyMap.lookup(\"NotARealKey\") unexpectedly returned non-nil", false))
        }

        return failures
    }
}
#endif
