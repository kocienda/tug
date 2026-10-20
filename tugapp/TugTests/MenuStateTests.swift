import XCTest

// `MenuState`'s decode is the host's half of the wire contract with
// `tugdeck/src/lib/host-menu-state.ts` (`menuStateToHost`), and every claim
// here is one the menu rests on: a payload that is missing a field or
// mistypes one is refused whole, so the menus keep the last state that did
// decode; the cache before any push is cold start; a gate's chord has three
// states that only the key's presence tells apart; a gate's mark has three
// readings that arrive as two JSON types; and a body's card blocks merge over
// the shell's only while its card is the key card.
final class MenuStateTests: XCTestCase {
    private let editIdle: [String: Any] = [
        "cut": false, "copy": false, "paste": false, "delete": false, "selectAll": false,
        "undo": false, "redo": false, "undoLabel": "", "redoLabel": "", "nativeUndoToken": 0,
        "find": false, "findNext": false, "findPrevious": false,
    ]

    private func session(_ cardId: String, bound: Bool, canChangeSettings: Bool = true) -> [String: Any] {
        [
            "cardId": cardId, "sessionBound": bound, "canInterrupt": false,
            "canChangeSettings": canChangeSettings, "permissionMode": "default", "aiSummary": "",
            "hasAssistantMessage": false, "hasTurns": false, "changesVisible": false,
            "historyVisible": false, "commitReady": false, "hasCustomName": false,
        ]
    }

    /// The shell's whole payload, every field as the page writes it, with
    /// `overrides` laid over it.
    private func shell(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var payload: [String: Any] = [
            "panes": [] as [Any], "spaces": [] as [Any], "activeCard": NSNull(),
            "selectionActive": false, "stackDepth": 0,
            "session": NSNull(), "file": NSNull(), "document": NSNull(), "edit": editIdle,
            "commands": [:] as [String: Any], "recentDocuments": [] as [Any], "activeTheme": "",
            "openQuickly": true, "captureArmed": false, "appModalOpen": false,
        ]
        payload.merge(overrides) { _, new in new }
        return payload
    }

    /// A body's card blocks, with `overrides` laid over them.
    private func blocks(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var payload: [String: Any] = [
            "session": NSNull(), "file": NSNull(), "document": NSNull(), "edit": editIdle,
            "commands": [:] as [String: Any],
        ]
        payload.merge(overrides) { _, new in new }
        return payload
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
        try JSONDecoder().decode(type, from: try JSONSerialization.data(withJSONObject: object))
    }

    private func refuses<T: Decodable>(_ type: T.Type, _ object: [String: Any]) -> Bool {
        (try? decode(type, object)) == nil
    }

    func testTheEmptyStateIsColdStart() {
        let state = MenuState.empty
        check("no panes", state.panes.isEmpty)
        check("no workspaces", state.spaces.isEmpty)
        check("no key card", state.activeCard == nil)
        check("no session", state.session == nil)
        check("no document claims zoom", state.document == nil)
        check("no gates, which the validator reads as cold start", state.commands.isEmpty)
        check("no recent documents", state.recentDocuments.isEmpty)
        check("no theme", state.activeTheme == "")
        check("no capture armed", !state.captureArmed)
        check("no app-modal wizard", !state.appModalOpen)
        check("nothing handles edits", !state.edit.undo && !state.edit.redo && state.edit.nativeUndoToken == 0)
    }

    func testAMalformedPayloadIsRefusedWhole() throws {
        check("the whole payload decodes", (try? decode(MenuState.self, shell())) != nil)
        check("a mistyped flag", refuses(MenuState.self, shell(["captureArmed": "yes"])))
        check("a mistyped list", refuses(MenuState.self, shell(["panes": "not a list"])))
        check("an entry with no id", refuses(MenuState.self, shell(["spaces": [["name": "no id", "active": true]]])))
        check("a session with no card", refuses(MenuState.self, shell(["session": ["sessionBound": true]])))
        check("an absent session, which is not a null one", refuses(MenuState.self, shell().filter { $0.key != "session" }))
        check("a mistyped edit block", refuses(MenuState.self, shell(["edit": 7])))
        check("an unreadable gate", refuses(MenuState.self, shell(["commands": ["view.zoomIn": "not a gate"]])))
        check("a mistyped recents list", refuses(MenuState.self, shell(["recentDocuments": [1, 2]])))
        check("a mistyped theme", refuses(MenuState.self, shell(["activeTheme": 3])))
    }

    func testPanesSpacesAndFlagsDecode() throws {
        let state = try decode(MenuState.self, shell([
            "captureArmed": true,
            "appModalOpen": true,
            "panes": [
                ["id": "p1", "title": "Session", "focused": true, "cardCount": 1, "closable": true],
                ["id": "p2", "title": "Jots", "focused": false, "cardCount": 2, "closable": false],
            ],
            "spaces": [["id": "s1", "name": "Main", "active": true]],
            "activeCard": ["cardId": "c1", "component": "session", "closable": true],
            "recentDocuments": ["/a.md", "/b.md"],
            "activeTheme": "ironclad",
        ]))
        check("capture armed reads", state.captureArmed)
        check("app-modal reads", state.appModalOpen)
        check("panes keep their order", state.panes.map(\.id) == ["p1", "p2"], "got \(state.panes.map(\.id))")
        check("a pane carries its title and focus", state.panes.first?.title == "Session" && state.panes.first?.focused == true)
        check("a workspace decodes", state.spaces.first?.name == "Main" && state.spaces.first?.active == true)
        check("the key card reads", state.activeCard?.cardId == "c1")
        check("recents keep their order", state.recentDocuments == ["/a.md", "/b.md"])
        check("the theme reads", state.activeTheme == "ironclad")
    }

    func testSessionDocumentAndEditDecode() throws {
        var edit = editIdle
        edit["undo"] = true
        edit["undoLabel"] = "Typing"
        edit["nativeUndoToken"] = 4
        let state = try decode(MenuState.self, shell([
            "session": session("c1", bound: true, canChangeSettings: false),
            "document": ["cardId": "c2"],
            "edit": edit,
        ]))
        check("the session's card reads", state.session?.cardId == "c1")
        check("the session's binding reads", state.session?.sessionBound == true)
        check("the settings flag reads", state.session?.canChangeSettings == false)
        check("the document's card reads", state.document?.cardId == "c2")
        check("undo reads", state.edit.undo)
        check("redo reads", !state.edit.redo)
        check("the undo label reads", state.edit.undoLabel == "Typing")
        check("an empty redo label is empty", state.edit.redoLabel == "")
        check("the native undo token reads", state.edit.nativeUndoToken == 4)
    }

    // The three chord states, read apart by the key's presence: a missing key
    // leaves the item alone, an explicit null releases the chord, and a spec
    // writes one. A spec with no key is refused rather than guessed at.
    func testAGatesChordHasThreeStates() throws {
        let state = try decode(MenuState.self, shell([
            "commands": [
                "a": ["enabled": true],
                "b": ["chord": NSNull()],
                "c": ["chord": ["keyEquivalent": "k", "command": true, "shift": true]],
            ],
        ]))
        func chord(_ id: String) -> MenuState.CommandGate.ChordField? { state.commands[id]?.chord }

        if case .absent = chord("a") { check("a missing chord is absent", true) } else { check("a missing chord is absent", false) }
        if case .detach = chord("b") { check("a null chord detaches", true) } else { check("a null chord detaches", false) }
        if case .apply(let spec) = chord("c") {
            check("a spec applies its key", spec.keyEquivalent == "k")
            check("and its modifiers, an absent one up", spec.command && spec.shift && !spec.option && !spec.control)
        } else {
            check("a spec applies", false)
        }
        check("a spec with no key is refused", refuses(MenuState.self, shell(["commands": ["d": ["chord": ["command": true]]]])))
        check("a null modifier is refused", refuses(MenuState.self, shell(["commands": ["e": ["chord": ["keyEquivalent": "k", "shift": NSNull()]]]])))
    }

    // The mark's three readings arrive as two JSON types — booleans and the
    // string "mixed" — and anything else is refused.
    func testAGatesMarkHasThreeReadings() throws {
        let state = try decode(MenuState.self, shell([
            "commands": [
                "on": ["state": true, "enabled": false, "title": "Hide Jots"],
                "off": ["state": false],
                "mixed": ["state": "mixed"],
                "none": [:] as [String: Any],
            ],
        ]))
        check("true is on", state.commands["on"]?.state == .on)
        check("false is off", state.commands["off"]?.state == .off)
        check("\"mixed\" is mixed", state.commands["mixed"]?.state == .mixed)
        check("an absent mark states no opinion", state.commands["none"]?.state == nil)
        check("a gate keeps its enablement", state.commands["on"]?.enabled == false)
        check("a gate keeps its title", state.commands["on"]?.title == "Hide Jots")
        check("a gate with no enablement states no opinion", state.commands["off"]?.enabled == nil)
        check("a gate with no title keeps the built one", state.commands["off"]?.title == nil)
        check("any other mark is refused", refuses(MenuState.self, shell(["commands": ["x": ["state": "sideways"]]])))
    }

    // A post is the shell's whole state or a body's blocks, told apart by
    // `panes`: a malformed whole is refused as the whole it is, never read as
    // its blocks alone.
    func testAPostIsTheShellsStateOrABodysBlocks() throws {
        if case .shell = try decode(MenuStatePost.self, shell()) { check("a whole payload is the shell's", true) } else { check("a whole payload is the shell's", false) }
        if case .body = try decode(MenuStatePost.self, blocks()) { check("the blocks alone are a body's", true) } else { check("the blocks alone are a body's", false) }
        check("blocks missing one are refused", refuses(MenuStatePost.self, blocks().filter { $0.key != "session" }))
        check("a whole missing one is refused, not read as blocks", refuses(MenuStatePost.self, shell().filter { $0.key != "spaces" }))
    }

    // The key card's body publishes the card-scoped blocks; the deck's stay
    // the shell's; the two `commands` sets are unioned with the body's gate
    // winning an identifier both report.
    func testTheKeyCardsBodyMergesIntoTheShell() throws {
        var edit = editIdle
        edit["undo"] = true
        edit["undoLabel"] = "Typing"
        let shellState = try decode(MenuState.self, shell([
            "activeCard": ["component": "session", "closable": true, "cardId": "c1"],
            "panes": [["id": "p1", "title": "Dev", "focused": true, "cardCount": 1, "closable": true]],
            "spaces": [["id": "s1", "name": "Main", "active": true]],
            "session": session("c1", bound: false),
            "commands": ["shared": ["enabled": false], "deckOnly": ["enabled": true]],
        ]))
        let body = try decode(MenuState.CardBlocks.self, blocks([
            "session": session("c1", bound: true, canChangeSettings: false),
            "edit": edit,
            "document": ["cardId": "c1"],
            "commands": ["shared": ["enabled": true], "bodyOnly": ["enabled": true]],
        ]))
        let state = MenuState.merged(shell: shellState, bodies: ["c1": body])
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
    // key card's body says is null is absent rather than the shell's.
    func testOnlyTheKeyCardsBodyIsMerged() throws {
        let shellState = try decode(MenuState.self, shell([
            "activeCard": ["component": "session", "closable": true, "cardId": "c1"],
            "session": session("c1", bound: true),
            "commands": ["shared": ["enabled": false]],
        ]))
        let other = MenuState.merged(shell: shellState, bodies: [
            "c2": try decode(MenuState.CardBlocks.self, blocks([
                "session": session("c2", bound: false),
                "commands": ["shared": ["enabled": true]],
            ])),
        ])
        check("another card's body leaves the session block", other.session?.cardId == "c1")
        check("another card's body leaves the gates", other.commands["shared"]?.enabled == false)

        let noKeyCard = MenuState.merged(
            shell: try decode(MenuState.self, shell()),
            bodies: ["c1": try decode(MenuState.CardBlocks.self, blocks(["commands": ["x": ["enabled": true]]]))]
        )
        check("a shell with no key card merges nothing", noKeyCard.commands["x"] == nil)

        let silent = MenuState.merged(shell: shellState, bodies: ["c1": try decode(MenuState.CardBlocks.self, blocks())])
        check("a block the key body says is null is absent", silent.session == nil)
    }
}
