import XCTest

// `VirtualKeyMap.lookupCode` maps a `KeyboardEvent.code` to the macOS virtual
// keycode for that physical key. A layout test presses keys by position, so a
// wrong row here sends a test's ⌘ to the wrong key under every layout at once.
//
// The cross-check is against `lookup`, the US-character table the harness has
// driven every keyboard test through: on a US board the key at `KeyQ` types
// "q", so the two tables have to agree wherever a US character names the key.
final class VirtualKeyMapTests: XCTestCase {

    func testLetterCodesAreTheUSLetterKeys() {
        for letter in "abcdefghijklmnopqrstuvwxyz" {
            let code = "Key\(letter.uppercased())"
            XCTAssertEqual(
                VirtualKeyMap.lookupCode(code),
                VirtualKeyMap.lookup(String(letter))?.keyCode,
                code
            )
        }
    }

    func testDigitCodesAreTheUSDigitKeys() {
        for digit in 0...9 {
            XCTAssertEqual(
                VirtualKeyMap.lookupCode("Digit\(digit)"),
                VirtualKeyMap.lookup(String(digit))?.keyCode,
                "Digit\(digit)"
            )
        }
    }

    func testPunctuationCodesAreTheUSPunctuationKeys() {
        let pairs: [(code: String, usCharacter: String)] = [
            ("Minus", "-"), ("Equal", "="), ("BracketLeft", "["), ("BracketRight", "]"),
            ("Backslash", "\\"), ("Semicolon", ";"), ("Quote", "'"), ("Backquote", "`"),
            ("Comma", ","), ("Period", "."), ("Slash", "/"), ("Space", " "),
        ]
        for (code, character) in pairs {
            XCTAssertEqual(VirtualKeyMap.lookupCode(code), VirtualKeyMap.lookup(character)?.keyCode, code)
        }
    }

    func testNamedCodesAreTheNamedKeys() {
        for name in ["Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End",
                     "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] {
            XCTAssertEqual(VirtualKeyMap.lookupCode(name), VirtualKeyMap.lookup(name)?.keyCode, name)
        }
    }

    // The ISO key beside left Shift has no US character, so it is pinned to
    // `kVK_ISO_Section` directly.
    func testIntlBackslashIsTheISOSectionKey() {
        XCTAssertEqual(VirtualKeyMap.lookupCode("IntlBackslash"), 0x0A)
    }

    // A position is one key: no two codes may press the same one.
    func testNoTwoCodesShareAKey() {
        let codes = (65...90).map { "Key\(Character(UnicodeScalar($0)!))" }
            + (0...9).map { "Digit\($0)" }
            + ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
               "Quote", "Backquote", "Comma", "Period", "Slash", "IntlBackslash", "Space",
               "Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp",
               "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
        var seen: [CGKeyCode: String] = [:]
        for code in codes {
            guard let keyCode = VirtualKeyMap.lookupCode(code) else {
                XCTFail("\(code) has no keycode")
                continue
            }
            if let other = seen[keyCode] {
                XCTFail("\(code) and \(other) both press 0x\(String(keyCode, radix: 16))")
            }
            seen[keyCode] = code
        }
    }

    // Codes are DOM names and case-sensitive; a character is not a code.
    func testUnknownCodesAreNil() {
        XCTAssertNil(VirtualKeyMap.lookupCode("keyq"))
        XCTAssertNil(VirtualKeyMap.lookupCode("q"))
        XCTAssertNil(VirtualKeyMap.lookupCode("NotAKey"))
    }
}
