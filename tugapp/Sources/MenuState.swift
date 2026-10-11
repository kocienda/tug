import Foundation

/// Menu-relevant frontend state, pushed by tugdeck's host-menu-state
/// aggregator on every menu-relevant change. Wire contract with
/// `tugdeck/src/lib/host-menu-state.ts` — keep both sides in sync.
///
/// Decoding is defensive throughout: a missing or mistyped field reads
/// as its inert value (empty list, nil block, false flag), so menu
/// validation degrades to "disabled" rather than crashing on a
/// malformed payload. Before the first push arrives (app boot,
/// pre-frontendReady) the cache is `.empty`, and `validateMenuItem`'s
/// default branch reads the empty `commands` block as cold start —
/// every identified item without an explicit case validates disabled
/// until the frontend has answered once. Migrating an item's tier out
/// of the validator therefore cannot flip its splash-screen posture
/// from disabled to enabled.
struct MenuState {
    /// One pane entry, z-order topmost first.
    struct Pane {
        let id: String
        let title: String
        let focused: Bool
    }

    /// One workspace row for the Window menu's Workspaces section, in the
    /// user's order, `active` on the one rendered ([P12]).
    struct Space {
        let id: String
        let name: String
        let active: Bool
    }

    /// Session-card session state; nil unless the active card is a session card.
    struct Session {
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
    struct Document {
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
    struct Edit {
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
    struct ChordSpec {
        let keyEquivalent: String
        let command: Bool
        let shift: Bool
        let option: Bool
        let control: Bool
    }

    struct CommandGate {
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
    }

    var panes: [Pane] = []
    /// Every workspace, in the user's order, for the Window menu's
    /// Workspaces section.
    var spaces: [Space] = []
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

    init(payload: [String: Any]) {
        captureArmed = payload["captureArmed"] as? Bool ?? false
        appModalOpen = payload["appModalOpen"] as? Bool ?? false
        if let rawPanes = payload["panes"] as? [[String: Any]] {
            panes = rawPanes.compactMap { entry in
                guard let id = entry["id"] as? String else { return nil }
                return Pane(
                    id: id,
                    title: entry["title"] as? String ?? "Untitled",
                    focused: entry["focused"] as? Bool ?? false
                )
            }
        }
        if let rawSpaces = payload["spaces"] as? [[String: Any]] {
            spaces = rawSpaces.compactMap { entry in
                guard let id = entry["id"] as? String else { return nil }
                return Space(
                    id: id,
                    name: entry["name"] as? String ?? "Untitled",
                    active: entry["active"] as? Bool ?? false
                )
            }
        }
        if let rawSession = payload["session"] as? [String: Any],
           let cardId = rawSession["cardId"] as? String {
            session = Session(
                cardId: cardId,
                sessionBound: rawSession["sessionBound"] as? Bool ?? false,
                // Fail open: a parse miss keeps the settings items enabled
                // rather than stranding a dead AI door.
                canChangeSettings: rawSession["canChangeSettings"] as? Bool ?? true
            )
        }
        if let rawDocument = payload["document"] as? [String: Any],
           let cardId = rawDocument["cardId"] as? String {
            document = Document(cardId: cardId)
        }
        if let rawRecents = payload["recentDocuments"] as? [String] {
            recentDocuments = rawRecents
        }
        activeTheme = payload["activeTheme"] as? String ?? ""
        if let rawEdit = payload["edit"] as? [String: Any] {
            edit = Edit(
                undo: rawEdit["undo"] as? Bool ?? false,
                redo: rawEdit["redo"] as? Bool ?? false,
                undoLabel: rawEdit["undoLabel"] as? String ?? "",
                redoLabel: rawEdit["redoLabel"] as? String ?? "",
                nativeUndoToken: rawEdit["nativeUndoToken"] as? Int ?? 0
            )
        }
        if let rawCommands = payload["commands"] as? [String: Any] {
            for (itemId, rawGate) in rawCommands {
                // A gate that cannot be read at all is dropped rather than
                // defaulted: an unreadable gate is not a claim of "enabled",
                // and dropping it leaves the item on whichever tier still
                // owns it.
                guard let gate = rawGate as? [String: Any] else { continue }
                // The three chord states have to be read apart, and only the
                // key's *presence* separates the first two: a missing key is
                // "leave the item alone", while an explicit JSON null (which
                // arrives as NSNull) is "release the chord". Reading it with
                // `as? [String: Any]` alone would collapse them and turn every
                // detach into a no-op.
                let chordField: CommandGate.ChordField
                if let rawChord = gate["chord"] {
                    if let spec = rawChord as? [String: Any],
                       let keyEquivalent = spec["keyEquivalent"] as? String {
                        chordField = .apply(ChordSpec(
                            keyEquivalent: keyEquivalent,
                            command: spec["command"] as? Bool ?? false,
                            shift: spec["shift"] as? Bool ?? false,
                            option: spec["option"] as? Bool ?? false,
                            control: spec["control"] as? Bool ?? false
                        ))
                    } else {
                        // Null, or a spec too malformed to apply. Detaching is
                        // the safe reading of both: an unreadable chord must
                        // not leave a stale one standing.
                        chordField = .detach
                    }
                } else {
                    chordField = .absent
                }
                // The mark's three readings arrive as two JSON types — the
                // booleans as numbers, `"mixed"` as a string — so they are
                // read apart. Anything else states no opinion and leaves the
                // item's constructed state standing.
                let stateField: CommandGate.Mark?
                if let on = gate["state"] as? Bool {
                    stateField = on ? .on : .off
                } else if gate["state"] as? String == "mixed" {
                    stateField = .mixed
                } else {
                    stateField = nil
                }
                commands[itemId] = CommandGate(
                    enabled: gate["enabled"] as? Bool,
                    state: stateField,
                    title: gate["title"] as? String,
                    chord: chordField
                )
            }
        }
    }
}
