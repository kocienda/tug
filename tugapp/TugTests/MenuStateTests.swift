import XCTest

// `MenuState(payload:)` is the host's half of the wire contract with
// `tugdeck/src/lib/host-menu-state.ts`, and every claim here is one the menu
// rests on: a payload that is missing or mistyped reads as its inert value
// rather than trapping, so validation degrades to "disabled"; the cache
// before any push is cold start; a gate's chord has three states that only
// the key's presence tells apart; and a gate's mark has three readings that
// arrive as two JSON types.
final class MenuStateTests: XCTestCase {
    func testTheEmptyStateIsColdStart() {
        let state = MenuState.empty
        check("no panes", state.panes.isEmpty)
        check("no workspaces", state.spaces.isEmpty)
        check("no session", state.session == nil)
        check("no document claims zoom", state.document == nil)
        check("no gates, which the validator reads as cold start", state.commands.isEmpty)
        check("no recent documents", state.recentDocuments.isEmpty)
        check("no theme", state.activeTheme == "")
        check("no capture armed", !state.captureArmed)
        check("no app-modal wizard", !state.appModalOpen)
        check("nothing handles edits", !state.edit.undo && !state.edit.redo && state.edit.nativeUndoToken == 0)
    }

    func testAMalformedPayloadReadsAsInert() {
        let state = MenuState(payload: [
            "captureArmed": "yes",
            "panes": "not a list",
            "spaces": [["name": "no id"]],
            "session": ["sessionBound": true],
            "document": [:] as [String: Any],
            "edit": 7,
            "commands": ["view.zoomIn": "not a gate"],
            "recentDocuments": [1, 2],
            "activeTheme": 3,
        ])
        check("a mistyped flag is false", !state.captureArmed)
        check("a mistyped list is empty", state.panes.isEmpty)
        check("an entry with no id is dropped", state.spaces.isEmpty)
        check("a session with no card is no session", state.session == nil)
        check("a document with no card is no claim", state.document == nil)
        check("a mistyped edit block is disabled", !state.edit.undo && state.edit.undoLabel == "")
        check("an unreadable gate is dropped, not defaulted", state.commands["view.zoomIn"] == nil)
        check("a mistyped recents list is empty", state.recentDocuments.isEmpty)
        check("a mistyped theme is empty", state.activeTheme == "")
    }

    func testPanesSpacesAndFlagsDecode() {
        let state = MenuState(payload: [
            "captureArmed": true,
            "appModalOpen": true,
            "panes": [
                ["id": "p1", "title": "Session", "focused": true],
                ["id": "p2"],
            ],
            "spaces": [["id": "s1", "name": "Main", "active": true]],
            "recentDocuments": ["/a.md", "/b.md"],
            "activeTheme": "ironclad",
        ])
        check("capture armed reads", state.captureArmed)
        check("app-modal reads", state.appModalOpen)
        check("panes keep their order", state.panes.map(\.id) == ["p1", "p2"], "got \(state.panes.map(\.id))")
        check("a pane carries its title and focus", state.panes.first?.title == "Session" && state.panes.first?.focused == true)
        check("a pane with no title is Untitled", state.panes.last?.title == "Untitled")
        check("a pane with no focus is unfocused", state.panes.last?.focused == false)
        check("a workspace decodes", state.spaces.first?.name == "Main" && state.spaces.first?.active == true)
        check("recents keep their order", state.recentDocuments == ["/a.md", "/b.md"])
        check("the theme reads", state.activeTheme == "ironclad")
    }

    func testSessionDocumentAndEditDecode() {
        let state = MenuState(payload: [
            "session": ["cardId": "c1", "sessionBound": true],
            "document": ["cardId": "c2"],
            "edit": ["undo": true, "redo": false, "undoLabel": "Typing", "nativeUndoToken": 4],
        ])
        check("the session's card reads", state.session?.cardId == "c1")
        check("the session's binding reads", state.session?.sessionBound == true)
        check("a missing settings flag fails open", state.session?.canChangeSettings == true)
        check("the document's card reads", state.document?.cardId == "c2")
        check("undo reads", state.edit.undo)
        check("redo reads", !state.edit.redo)
        check("the undo label reads", state.edit.undoLabel == "Typing")
        check("a missing redo label is empty", state.edit.redoLabel == "")
        check("the native undo token reads", state.edit.nativeUndoToken == 4)
    }

    // The three chord states, read apart by the key's presence: a missing key
    // leaves the item alone, an explicit null releases the chord, and a spec
    // writes one. A malformed spec detaches rather than leaving a stale chord.
    func testAGatesChordHasThreeStates() {
        let state = MenuState(payload: [
            "commands": [
                "a": ["enabled": true],
                "b": ["chord": NSNull()],
                "c": ["chord": ["keyEquivalent": "k", "command": true, "shift": true]],
                "d": ["chord": ["command": true]],
            ],
        ])
        func chord(_ id: String) -> MenuState.CommandGate.ChordField? { state.commands[id]?.chord }

        if case .absent = chord("a") { check("a missing chord is absent", true) } else { check("a missing chord is absent", false) }
        if case .detach = chord("b") { check("a null chord detaches", true) } else { check("a null chord detaches", false) }
        if case .apply(let spec) = chord("c") {
            check("a spec applies its key", spec.keyEquivalent == "k")
            check("and its modifiers", spec.command && spec.shift && !spec.option && !spec.control)
        } else {
            check("a spec applies", false)
        }
        if case .detach = chord("d") {
            check("a spec with no key detaches", true)
        } else {
            check("a spec with no key detaches", false)
        }
    }

    // The mark's three readings arrive as two JSON types — booleans and the
    // string "mixed" — and anything else states no opinion.
    func testAGatesMarkHasThreeReadings() {
        let state = MenuState(payload: [
            "commands": [
                "on": ["state": true, "enabled": false, "title": "Hide Jots"],
                "off": ["state": false],
                "mixed": ["state": "mixed"],
                "none": ["state": "sideways"],
            ],
        ])
        check("true is on", state.commands["on"]?.state == .on)
        check("false is off", state.commands["off"]?.state == .off)
        check("\"mixed\" is mixed", state.commands["mixed"]?.state == .mixed)
        check("anything else states no opinion", state.commands["none"]?.state == nil)
        check("a gate keeps its enablement", state.commands["on"]?.enabled == false)
        check("a gate keeps its title", state.commands["on"]?.title == "Hide Jots")
        check("a gate with no enablement states no opinion", state.commands["off"]?.enabled == nil)
        check("a gate with no title keeps the built one", state.commands["off"]?.title == nil)
    }

    // The key card's body publishes the card-scoped blocks; the deck's stay
    // the shell's; the two `commands` sets are unioned with the body's gate
    // winning an identifier both report.
    func testTheKeyCardsBodyMergesIntoTheShell() {
        let shell: [String: Any] = [
            "activeCard": ["component": "session", "closable": true, "cardId": "c1"],
            "panes": [["id": "p1", "title": "Dev", "focused": true]],
            "spaces": [["id": "s1", "name": "Main", "active": true]],
            "session": ["cardId": "c1", "sessionBound": false],
            "commands": ["shared": ["enabled": false], "deckOnly": ["enabled": true]],
        ]
        let body: [String: Any] = [
            "session": ["cardId": "c1", "sessionBound": true, "canChangeSettings": false],
            "edit": ["undo": true, "redo": false, "undoLabel": "Typing"],
            "document": ["cardId": "c1"],
            "panes": [["id": "ignored", "title": "Body", "focused": true]],
            "commands": ["shared": ["enabled": true], "bodyOnly": ["enabled": true]],
        ]
        let state = MenuState(payload: MenuState.merged(shell: shell, bodies: ["c1": body]))
        check("the body's session block", state.session?.sessionBound == true && state.session?.canChangeSettings == false)
        check("the body's edit block", state.edit.undo && state.edit.undoLabel == "Typing")
        check("the body's document block", state.document?.cardId == "c1")
        check("the shell's panes", state.panes.map(\.id) == ["p1"])
        check("the shell's workspaces", state.spaces.map(\.id) == ["s1"])
        check("the body's gate wins a shared identifier", state.commands["shared"]?.enabled == true)
        check("a deck-only gate stands", state.commands["deckOnly"]?.enabled == true)
        check("a body-only gate joins", state.commands["bodyOnly"]?.enabled == true)
    }

    // A body whose card is not the key card changes nothing, and a block the
    // key card's body leaves out is absent rather than the shell's.
    func testOnlyTheKeyCardsBodyIsMerged() {
        let shell: [String: Any] = [
            "activeCard": ["component": "session", "closable": true, "cardId": "c1"],
            "session": ["cardId": "c1", "sessionBound": true],
            "commands": ["shared": ["enabled": false]],
        ]
        let other = MenuState(payload: MenuState.merged(
            shell: shell,
            bodies: ["c2": ["session": ["cardId": "c2", "sessionBound": false],
                            "commands": ["shared": ["enabled": true]]]]
        ))
        check("another card's body leaves the session block", other.session?.cardId == "c1")
        check("another card's body leaves the gates", other.commands["shared"]?.enabled == false)

        let noCardId = MenuState(payload: MenuState.merged(
            shell: ["activeCard": ["component": "session"], "commands": [:] as [String: Any]],
            bodies: ["c1": ["commands": ["x": ["enabled": true]]]]
        ))
        check("a shell that names no card merges nothing", noCardId.commands["x"] == nil)

        let silent = MenuState(payload: MenuState.merged(shell: shell, bodies: ["c1": [:]]))
        check("a block the key body leaves out is absent", silent.session == nil)
    }
}
