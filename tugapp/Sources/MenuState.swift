import Foundation

/// Menu-relevant frontend state, pushed by tugdeck's host-menu-state
/// aggregator on every menu-relevant change. Wire contract with
/// `tugdeck/src/lib/host-menu-state.ts`, declared as `menuStateToHost`
/// and held to it by the parity fixture.
///
/// The decode is the declaration's: a payload with a missing or mistyped
/// field is refused whole, and the menus keep the last state that did
/// decode. Only the fields the host reads are decoded; the page's others
/// are its own. Before the first push arrives (app boot,
/// pre-frontendReady) the cache is `.empty`, and `validateMenuItem`'s
/// default branch reads the empty `commands` block as cold start —
/// every identified item without an explicit case validates disabled
/// until the frontend has answered once. Migrating an item's tier out
/// of the validator therefore cannot flip its splash-screen posture
/// from disabled to enabled.
struct MenuState: Decodable {
    /// One pane entry, z-order topmost first.
    struct Pane: Decodable {
        let id: String
        let title: String
        let focused: Bool
    }

    /// One workspace row for the Window menu's Workspaces section, in the
    /// user's order, `active` on the one rendered ([P12]).
    struct Space: Decodable {
        let id: String
        let name: String
        let active: Bool
    }

    /// The focused pane's active card: the key card, whose body's blocks
    /// win while it has a body.
    struct ActiveCard: Decodable {
        let cardId: String
    }

    /// Session-card session state; nil unless the active card is a session card.
    struct Session: Decodable {
        let cardId: String
        let sessionBound: Bool
        /// The model / effort / permission-mode settings may be changed
        /// (session idle — `canSubmit`). Gates the AI item and the Cycle
        /// Permission Mode item so a change can never race a running turn,
        /// matching the disabled Z4B chip.
        ///
        /// The AI item's live TITLE does not come through here: it is composed
        /// frontend-side and arrives as the registry gate's `title`, which
        /// `validateMenuItem` already applies generically to any item.
        let canChangeSettings: Bool
    }

    /// A document surface's claim on the zoom commands; nil unless the
    /// frontmost card hosts one. The claim exists because AppKit resolves a
    /// menu key equivalent before the WKWebView sees a keydown: ⌘+ / ⌘- / ⌘0
    /// can never be handled web-side, so a surface that wants them says so
    /// here and the delegate forwards the command instead of scaling the page.
    struct Document: Decodable {
        let cardId: String
    }

    /// Undo / Redo capabilities of the current first responder, projected
    /// from the web responder chain's `validateAction` (the suite's
    /// single source of truth for whether the focused surface handles an
    /// edit action). All false when nothing focused handles edits (e.g.
    /// only the Settings card up).
    ///
    /// Undo / Redo ride this block — NOT AppKit's automatic NSUndoManager
    /// validation — because the web view's undoManager is per-web-view: it
    /// accumulates the whole view's edit history and knows nothing about
    /// card activation, so a deactivated card's undo state would keep
    /// showing in the menu. The chain is card-scoped by construction;
    /// editors report their own history depth through `validateAction`,
    /// plus a menu-title noun (`undoLabel` / `redoLabel` → "Undo Typing").
    ///
    /// Native text controls take a third path: when `nativeUndoToken` is
    /// non-zero (a browser-native input/textarea is focused) the delegate
    /// validates Undo/Redo LIVE from the web view's NSUndoManager and
    /// executes the native selectors. The token changes per focused
    /// control; the delegate clears the stack on every change
    /// (`updateMenuState`), which is what keeps the per-web-view native
    /// stack card-safe.
    struct Edit: Decodable {
        let undo: Bool
        let redo: Bool
        let undoLabel: String
        let redoLabel: String
        let nativeUndoToken: Int

        /// Nothing focused handles any edit action.
        static let disabled = Edit(
            undo: false, redo: false,
            undoLabel: "", redoLabel: "", nativeUndoToken: 0
        )
    }

    /// One menu item's gate, projected from the web command registry and
    /// keyed on the wire by the item's `NSUserInterfaceItemIdentifier`.
    ///
    /// The registry is the frontend's table of user-invocable commands, and
    /// every fact this struct carries is one the frontend already had to
    /// know to dispatch the command. Sending them together is what lets the
    /// validator's first tier be four lines and lets a hand-rolled case be
    /// deleted the moment its command starts publishing a gate — never both
    /// at once, so there is one definition of an item's enablement.
    /// A chord in the host's alphabet: the key-equivalent character plus the
    /// four modifier flags. The frontend performs the whole
    /// `KeyboardEvent.code` → key-equivalent conversion, so this side spells
    /// neither alphabet and only assembles the mask — which happens on the
    /// AppKit side, in `AppDelegate.swift`, so this file stays Foundation-only.
    struct ChordSpec: Decodable {
        let keyEquivalent: String
        let command: Bool
        let shift: Bool
        let option: Bool
        let control: Bool

        private enum CodingKeys: String, CodingKey { case keyEquivalent, command, shift, option, control }

        init(keyEquivalent: String, command: Bool, shift: Bool, option: Bool, control: Bool) {
            self.keyEquivalent = keyEquivalent
            self.command = command
            self.shift = shift
            self.option = option
            self.control = control
        }

        /// A modifier is absent or a boolean; absent reads as up, and `null`
        /// is refused, as the page's `optional(bool)` refuses it.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            func flag(_ key: CodingKeys) throws -> Bool {
                container.contains(key) ? try container.decode(Bool.self, forKey: key) : false
            }
            keyEquivalent = try container.decode(String.self, forKey: .keyEquivalent)
            command = try flag(.command)
            shift = try flag(.shift)
            option = try flag(.option)
            control = try flag(.control)
        }
    }

    struct CommandGate: Decodable {
        /// nil means the command states no opinion on enablement and the
        /// hand-rolled tier below still owns the item. A gate can carry a
        /// chord and nothing else: View ▸ Zoom In takes its chord from the
        /// registry while its predicate stays here, because it reads
        /// `window.currentPageZoom` — host state the frontend cannot see.
        let enabled: Bool?
        /// Checkmark; nil means the item does not participate in the check
        /// column, and its state is left as constructed.
        ///
        /// Three marks rather than two: the wire's `false` and `true` are the
        /// empty box and the plain check, and its `"mixed"` is the
        /// intermediate mark a row draws for a card that is showing AND
        /// holding the keyboard.
        let state: Mark?

        /// The check column's three marks, spelled without AppKit so this
        /// file stays Foundation-only; `AppDelegate.swift` maps each to its
        /// `NSControl.StateValue` where the item is drawn.
        enum Mark {
            case off
            case on
            case mixed
        }
        /// Dynamic title; nil means keep the title the menu was built with.
        let title: String?

        /// What the sweep does with this item's key equivalent. Three states,
        /// all load-bearing: `absent` is the answer for every item whose
        /// chord the frontend's table does not state (its constructed literal
        /// stands), `detach` releases the chord so it falls through to the
        /// web view, and `apply` writes one.
        enum ChordField {
            case absent
            case detach
            case apply(ChordSpec)
        }
        let chord: ChordField

        private enum CodingKeys: String, CodingKey { case enabled, state, title, chord }

        init(enabled: Bool?, state: Mark?, title: String?, chord: ChordField) {
            self.enabled = enabled
            self.state = state
            self.title = title
            self.chord = chord
        }

        /// Every field is absent or a value, and absence is a reading of its
        /// own. The chord's three states are read apart by the key's presence:
        /// a missing key is "leave the item alone" and an explicit null is
        /// "release the chord". The mark's three readings arrive as two JSON
        /// types, the booleans and the string `"mixed"`; any other value is
        /// refused.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            enabled = container.contains(.enabled) ? try container.decode(Bool.self, forKey: .enabled) : nil
            title = container.contains(.title) ? try container.decode(String.self, forKey: .title) : nil
            if !container.contains(.state) {
                state = nil
            } else if let on = try? container.decode(Bool.self, forKey: .state) {
                state = on ? .on : .off
            } else if try container.decode(String.self, forKey: .state) == "mixed" {
                state = .mixed
            } else {
                throw DecodingError.dataCorruptedError(
                    forKey: .state, in: container, debugDescription: "a mark is true, false or \"mixed\"")
            }
            if !container.contains(.chord) {
                chord = .absent
            } else if try container.decodeNil(forKey: .chord) {
                chord = .detach
            } else {
                chord = .apply(try container.decode(ChordSpec.self, forKey: .chord))
            }
        }
    }

    /// The blocks that belong to the key card rather than to the deck: all a
    /// body page posts. Each block is a value or null.
    struct CardBlocks: Decodable {
        var session: Session?
        var document: Document?
        var edit: Edit
        var commands: [String: CommandGate]

        private enum CodingKeys: String, CodingKey { case session, document, edit, commands }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            session = try container.decodeValueOrNull(Session.self, forKey: .session)
            document = try container.decodeValueOrNull(Document.self, forKey: .document)
            edit = try container.decode(Edit.self, forKey: .edit)
            commands = try container.decode([String: CommandGate].self, forKey: .commands)
        }
    }

    var panes: [Pane] = []
    /// Every workspace, in the user's order, for the Window menu's
    /// Workspaces section.
    var spaces: [Space] = []
    /// The key card, or nil when the deck has no panes.
    var activeCard: ActiveCard?
    var session: Session?
    /// A frontmost surface that owns zoom for itself (the viewer card's PDF
    /// branch). Present means View ▸ Zoom In / Zoom Out / Actual Size scale
    /// that document instead of the whole web view.
    var document: Document?
    var edit: Edit = .disabled
    /// Per-item gates from the command registry, keyed by item identifier.
    /// Empty before the first push and for every item that has not moved
    /// yet — an absent gate means "ask the hand-rolled tier below".
    var commands: [String: CommandGate] = [:]
    /// Recent-document paths (newest first) for File ▸ Open Recent. The
    /// submenu delegate filters these to files that still exist.
    var recentDocuments: [String] = []
    /// The active theme's name — the Theme submenu's checkmark. The
    /// submenu's membership is still a filesystem scan (genuinely dynamic);
    /// only which one is current rides the push.
    var activeTheme: String = ""
    /// The frontend's Keyboard pane is recording a chord; the host parks
    /// every key equivalent for the span so bound chords fall through to
    /// the web view to be captured instead of firing.
    var captureArmed: Bool = false

    /// An app-modal wizard (ConfigureTug, UpdateTug, TugVersionGate) is on
    /// screen. Radix traps the web view's focus and pointer; the menu bar is
    /// ours and is not trapped, so every item that would change the number of
    /// cards on the deck goes dark for the span [B01].
    ///
    /// This field answers for the items the host still validates by hand —
    /// New Session, New Jot, About, Settings, Keyboard Shortcuts, and the
    /// Open Recent entries. Every item whose gate the command registry
    /// publishes has the same fact folded in on the frontend side, and is
    /// answered by the registry tier above [B02].
    var appModalOpen: Bool = false

    static let empty = MenuState()

    init() {}

    private enum CodingKeys: String, CodingKey {
        case panes, spaces, activeCard, session, document, edit, commands
        case recentDocuments, activeTheme, captureArmed, appModalOpen
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        panes = try container.decode([Pane].self, forKey: .panes)
        spaces = try container.decode([Space].self, forKey: .spaces)
        activeCard = try container.decodeValueOrNull(ActiveCard.self, forKey: .activeCard)
        let blocks = try CardBlocks(from: decoder)
        session = blocks.session
        document = blocks.document
        edit = blocks.edit
        commands = blocks.commands
        recentDocuments = try container.decode([String].self, forKey: .recentDocuments)
        activeTheme = try container.decode(String.self, forKey: .activeTheme)
        captureArmed = try container.decode(Bool.self, forKey: .captureArmed)
        appModalOpen = try container.decode(Bool.self, forKey: .appModalOpen)
    }
}

extension MenuState {
    /// The shell's state with the key card's body merged over it.
    ///
    /// The shell names its key card in `activeCard`. When that card is a body
    /// that has posted blocks of its own, the card-scoped blocks come from the
    /// body — present or null as the body says — and `commands` is the union
    /// of both, the body's gate winning an identifier both report. The deck's
    /// facts — panes, workspaces, recents, theme, the capture and modal flags
    /// — stay the shell's. Blocks from a body whose card is not the key card
    /// change nothing, so a background body can never light the menu for a
    /// card the user is not in.
    static func merged(shell: MenuState, bodies: [String: CardBlocks]) -> MenuState {
        guard let cardId = shell.activeCard?.cardId, let body = bodies[cardId] else { return shell }
        var merged = shell
        merged.session = body.session
        merged.document = body.document
        merged.edit = body.edit
        merged.commands.merge(body.commands) { _, bodys in bodys }
        return merged
    }
}

/// A `menuState` post: the shell's whole state, or a body page's card-scoped
/// blocks, told apart by `panes`, which only the whole carries. A payload
/// carrying it is read as the whole or refused for what is wrong with it,
/// never read as its blocks alone.
enum MenuStatePost: Decodable {
    case shell(MenuState)
    case body(MenuState.CardBlocks)

    private enum Probe: String, CodingKey { case panes }

    init(from decoder: Decoder) throws {
        if try decoder.container(keyedBy: Probe.self).contains(.panes) {
            self = .shell(try MenuState(from: decoder))
        } else {
            self = .body(try MenuState.CardBlocks(from: decoder))
        }
    }
}
