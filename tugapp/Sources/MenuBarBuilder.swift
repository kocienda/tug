import AppKit

/// Every action the menu bar targets on the app delegate, by selector.
///
/// The builder names its selectors through this protocol rather than through
/// `AppDelegate`, so it compiles without the delegate — the `TugTests` bundle
/// builds the bar host-less — while `AppDelegate`'s conformance keeps the
/// compile-time check `#selector` gave: an action renamed or removed on the
/// delegate breaks the build rather than leaving a dead item.
@objc protocol MenuBarActions: AnyObject {
    func addCardToActivePane(_ sender: Any)
    func captureFramesDiagnostic(_ sender: Any?)
    func checkForUpdates(_ sender: Any?)
    func closeActiveCard(_ sender: Any)
    func closeAllCardTabs(_ sender: Any)
    func cyclePermissionModeFromMenu(_ sender: Any?)
    func deleteWorkspaceFromMenu(_ sender: Any?)
    func duplicateWorkspaceFromMenu(_ sender: Any?)
    func firstTurn(_ sender: Any?)
    func focusCardFromMenu(_ sender: NSMenuItem)
    func focusPrompt(_ sender: Any?)
    func goToSlotFromMenu(_ sender: NSMenuItem)
    func insertFile(_ sender: Any?)
    func lastTurn(_ sender: Any?)
    func logOut(_ sender: Any?)
    func moveInColumnFromMenu(_ sender: NSMenuItem)
    func newComponentGalleryCard(_ sender: Any?)
    func newHelloWorldCard(_ sender: Any)
    func newJot(_ sender: Any)
    func newSessionCard(_ sender: Any)
    func newSpikesCard(_ sender: Any)
    func newTextCard(_ sender: Any)
    func newWorkspaceFromMenu(_ sender: Any?)
    func nextCard(_ sender: Any?)
    func nextCardInStack(_ sender: Any?)
    func nextTurn(_ sender: Any?)
    func openCommandPicker(_ sender: Any?)
    func openFileInEditor(_ sender: Any)
    func openGitHub(_ sender: Any?)
    func openProjectHome(_ sender: Any?)
    func openQuickly(_ sender: Any)
    func performCopy(_ sender: Any?)
    func performCopyAsPlainText(_ sender: Any?)
    func performCut(_ sender: Any?)
    func performDelete(_ sender: Any?)
    func performFind(_ sender: Any?)
    func performFindNext(_ sender: Any?)
    func performFindPrevious(_ sender: Any?)
    func performFindSelection(_ sender: Any?)
    func performMakeLowercase(_ sender: Any?)
    func performMakeUppercase(_ sender: Any?)
    func performPaste(_ sender: Any?)
    func performPasteAsPlainText(_ sender: Any?)
    func performPasteAsQuote(_ sender: Any?)
    func performQuoteLines(_ sender: Any?)
    func performRedo(_ sender: Any?)
    func performSelectAll(_ sender: Any?)
    func performUndo(_ sender: Any?)
    func performUnquoteLines(_ sender: Any?)
    func previousCard(_ sender: Any?)
    func previousCardInStack(_ sender: Any?)
    func previousTurn(_ sender: Any?)
    func reload(_ sender: Any)
    func reloadActiveEditor(_ sender: Any)
    func renameWorkspaceFromMenu(_ sender: Any?)
    func revealStack(_ sender: Any)
    func revertActiveEditor(_ sender: Any)
    func runCardCommand(_ sender: NSMenuItem)
    func saveACopyActiveEditor(_ sender: Any)
    func saveActiveEditor(_ sender: Any)
    func saveAsActiveEditor(_ sender: Any)
    func showAbout(_ sender: Any?)
    func showConfigureTug(_ sender: Any?)
    func showDevTools(_ sender: Any?)
    func showKeyboardShortcuts(_ sender: Any?)
    func showSettings(_ sender: Any?)
    func sourceTree(_ sender: Any)
    func stopDictationAndSend(_ sender: Any?)
    func stopSession(_ sender: Any?)
    func toggleColumnSplit(_ sender: Any?)
    func toggleDictation(_ sender: Any?)
    func toggleRailFromMenu(_ sender: NSMenuItem)
    func toggleShadeView(_ sender: NSMenuItem)
}

/// The menus and anchors the app keeps after the bar is built: the ones it
/// installs on `NSApp`, and the ones its menu delegate rebuilds on open.
struct MenuHandles {
    let mainMenu: NSMenu
    let servicesMenu: NSMenu
    let helpMenu: NSMenu
    /// Rebuilt whole on every open.
    let viewMenu: NSMenu
    /// `NSApp.windowsMenu`. Never rebuilt whole — only the two slices after
    /// `windowSpaceListAnchor` and `windowPaneListAnchor` churn, so AppKit's
    /// automatic window entries at the tail survive every open.
    let windowMenu: NSMenu
    let windowSpaceListAnchor: NSMenuItem
    let windowPaneListAnchor: NSMenuItem
    /// Persists across View-menu rebuilds; each rebuild wraps it in a fresh
    /// parent item.
    let themeMenu: NSMenu
    /// File ▸ Open Recent, rebuilt on open from `menuState.recentDocuments`.
    let openRecentMenu: NSMenu

    /// The four menus a menu delegate rebuilds on open. The builder leaves
    /// them without a delegate; `MenuStateSync` takes them.
    var rebuiltOnOpen: [NSMenu] { [viewMenu, themeMenu, windowMenu, openRecentMenu] }
}

/// Builds the menu bar and touches nothing else.
///
/// It reads no app state and writes nothing to `NSApp`: everything that
/// varies by launch arrives as a field, and installing the result is the
/// caller's act. That is what lets the `TugTests` bundle build the whole bar
/// with no `NSApplication` running and walk it as a table.
struct MenuBarBuilder {
    /// The running variant's display name, which titles About, Hide, and Quit.
    let appName: String
    /// Check for Updates…'s starting title; the validator rewrites it on open.
    let checkForUpdatesTitle: String
    /// False hides Check for Updates… rather than disabling it.
    let updaterActive: Bool
    /// False hides the Maker menu.
    let makerMode: Bool
    /// True adds the debug-only card creators to the Maker menu.
    let debugProfile: Bool
    /// Maker ▸ Reload's explicit target.
    weak var reloadTarget: AnyObject?

    /// Build the menu tree: structure, identifiers, selectors, and the
    /// key-equivalent literals below.
    ///
    /// Those literals are **defaults**, not the last word. The frontend's
    /// command registry is where a chord is decided, and `applyCommandChords`
    /// writes what it decides over anything spelled here — so a literal is
    /// what the menu bar shows between launch and the first menu-state push,
    /// and what stands for any item whose chord the registry does not state.
    /// Items whose chord is conditional (Save As…, the two slot-stack items)
    /// are built without one for exactly that reason.
    func build() -> MenuHandles {
        let mainMenu = NSMenu()

        // Tug (App) Menu - position 0
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        let aboutItem = NSMenuItem(title: "About \(appName)", action: #selector(MenuBarActions.showAbout(_:)), keyEquivalent: "")
        aboutItem.identifier = NSUserInterfaceItemIdentifier("app.about")
        appMenu.addItem(aboutItem)
        // Hidden rather than disabled when the updater is inactive — a
        // bundle that cannot replace itself should not advertise the
        // command at all (the Maker-menu pattern).
        //
        // The title is a starting value only: it tracks the update flow, and
        // `validateMenuItem` rewrites it on every menu open from the
        // driver's snapshot [B07]. Same pattern as Undo / Redo.
        let checkForUpdatesItem = NSMenuItem(
            title: checkForUpdatesTitle,
            action: #selector(MenuBarActions.checkForUpdates(_:)),
            keyEquivalent: ""
        )
        checkForUpdatesItem.identifier = NSUserInterfaceItemIdentifier("app.checkForUpdates")
        checkForUpdatesItem.isHidden = !updaterActive
        appMenu.addItem(checkForUpdatesItem)
        appMenu.addItem(NSMenuItem.separator())
        // Configure Tug… — reopens the wizard on an app that is already set up,
        // so install / log-in / on-device-AI stay reachable instead of being a
        // first-launch-only surface. Sends the app-level `configure-tug` control
        // frame; tugdeck's ConfigureTugRequest stops any in-flight turns (with a
        // confirm) before the app-modal wizard opens. Ordered above Log Out
        // because it is the everyday one of the three.
        let configureTugItem = NSMenuItem(title: "Configure Tug...", action: #selector(MenuBarActions.showConfigureTug(_:)), keyEquivalent: "")
        configureTugItem.identifier = NSUserInterfaceItemIdentifier("app.configureTug")
        appMenu.addItem(configureTugItem)
        // Log Out… — app-level account action. Sends the app-level `logout`
        // control frame (not a per-card command), so it works even with no card
        // open; tugdeck's TugLogout runs the confirm → logout flow. Enabled
        // always (validateMenuItem default); a no-op when already logged out
        // (TugLogout guards on the auth state).
        let logoutItem = NSMenuItem(title: "Log Out...", action: #selector(MenuBarActions.logOut(_:)), keyEquivalent: "")
        logoutItem.identifier = NSUserInterfaceItemIdentifier("app.logout")
        appMenu.addItem(logoutItem)
        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(MenuBarActions.showSettings(_:)), keyEquivalent: ",")
        settingsItem.identifier = NSUserInterfaceItemIdentifier("app.settings")
        appMenu.addItem(settingsItem)
        // Keyboard Shortcuts… — the keymap configurator, a card of its own
        // rather than a pane of Settings. No key equivalent: ⌘, belongs to
        // Settings, and this card is also reachable from a control inside
        // Settings and from the Cards card.
        let keyboardItem = NSMenuItem(title: "Keyboard Shortcuts...", action: #selector(MenuBarActions.showKeyboardShortcuts(_:)), keyEquivalent: "")
        keyboardItem.identifier = NSUserInterfaceItemIdentifier("app.keyboardShortcuts")
        appMenu.addItem(keyboardItem)
        appMenu.addItem(NSMenuItem.separator())

        // Services submenu
        let servicesMenuItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesMenuItem.identifier = NSUserInterfaceItemIdentifier("app.services")
        let servicesMenu = NSMenu(title: "Services")
        servicesMenuItem.submenu = servicesMenu
        appMenu.addItem(servicesMenuItem)

        appMenu.addItem(NSMenuItem.separator())
        let hideItem = NSMenuItem(title: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hideItem.identifier = NSUserInterfaceItemIdentifier("app.hide")
        appMenu.addItem(hideItem)
        let hideOthersItem = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h", modifierMask: [.command, .option])
        hideOthersItem.identifier = NSUserInterfaceItemIdentifier("app.hideOthers")
        appMenu.addItem(hideOthersItem)
        let showAllItem = NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        showAllItem.identifier = NSUserInterfaceItemIdentifier("app.showAll")
        appMenu.addItem(showAllItem)
        appMenu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.identifier = NSUserInterfaceItemIdentifier("app.quit")
        appMenu.addItem(quitItem)

        // File Menu - position 1
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu

        // Card creation, flattened — two production card types don't need
        // a submenu. The debug-only gallery / hello-world / active-pane
        // creators live in the app-maker menu, gated at compile time on
        // BuildInfo.profile.
        fileMenu.addItem(NSMenuItem(title: "New Session", action: #selector(MenuBarActions.newSessionCard(_:)), keyEquivalent: "n").identified("file.newSessionCard"))

        // New Text File (⌥⌘N): a new untitled manual buffer — no file
        // exists until the first Save.
        fileMenu.addItem(NSMenuItem(title: "New Text File", action: #selector(MenuBarActions.newTextCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option]).identified("file.newTextCard"))

        // New Jot (⌘J): capture a thought into the Jots rail, revealing it if
        // hidden. Built with no key equivalent so `applyCommandChords` writes
        // the registry's chord onto the item — a Swift literal here would make
        // the chord unrebindable, which is the anomaly the sweep exists to
        // avoid.
        fileMenu.addItem(NSMenuItem(title: "New Jot", action: #selector(MenuBarActions.newJot(_:)), keyEquivalent: "").identified("file.newJot"))

        // Open File… (⌘O): NSOpenPanel → `open-file` Control frame. The
        // web layer reuses an existing Text card bound to the chosen
        // path or opens a new one (action-dispatch.ts `open-file`).
        fileMenu.addItem(NSMenuItem(title: "Open File…", action: #selector(MenuBarActions.openFileInEditor(_:)), keyEquivalent: "o").identified("file.openFile"))

        // Open Quickly (⇧⌘O): the deck-global fuzzy file-search popup
        // (action-dispatch.ts `open-quickly` → OpenQuicklyOverlay).
        fileMenu.addItem(NSMenuItem(title: "Open Quickly…", action: #selector(MenuBarActions.openQuickly(_:)), keyEquivalent: "o", modifierMask: [.command, .shift]).identified("file.openQuickly"))

        // Open Recent ▸ — a dynamic submenu rebuilt on open from the
        // menuState MRU, filtered to files that still exist (NSMenuDelegate
        // `menuNeedsUpdate`).
        //
        // The parent dims when the list is empty, and it dims by itself: the
        // item carries a submenu and no action, so AppKit never asks
        // `validateMenuItem` about it and instead enables it only when the
        // submenu holds an enabled item. An empty MRU builds a lone disabled
        // "No Recent Documents" placeholder, which is what makes the parent
        // dark. Keeping the submenu's contents current is therefore the whole
        // gate — an imperative `isEnabled` write here would be overwritten by
        // AppKit's own update pass. The app builds it once when it installs the
        // bar, so the rule has something to read before the first push, and
        // rebuilds it from `updateMenuState` whenever the MRU changes.
        let openRecentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "").identified("file.openRecent")
        let openRecentSubmenu = NSMenu(title: "Open Recent")
        openRecentItem.submenu = openRecentSubmenu
        fileMenu.addItem(openRecentItem)

        // Save (⌘S): flush the focused editor's pending edits to disk
        // now. Under the Text card's live autosave there is no dirty
        // state — this is "write immediately + checkpoint", routed as a
        // `save` Control frame → responder-chain SAVE dispatch. AppKit
        // swallows ⌘S at the menubar, so the menu item must carry the
        // chord; the web keybinding-map entry covers browser-only dev.
        fileMenu.addItem(NSMenuItem(title: "Save…", action: #selector(MenuBarActions.saveActiveEditor(_:)), keyEquivalent: "s").identified("file.save"))
        // Save As… — built without ⇧⌘S. The command claims the chord only
        // while a Text card is frontmost and releases it otherwise, which the
        // frontend states in its gate and `applyCommandChords` writes: a
        // chord left on a dimmed item is eaten at the menu bar with a beep
        // instead of falling through, so a static ⇧⌘S would be dead
        // everywhere else rather than merely inapplicable.
        fileMenu.addItem(NSMenuItem(title: "Save As…", action: #selector(MenuBarActions.saveAsActiveEditor(_:)), keyEquivalent: "").identified("file.saveAs"))
        // Save a Copy… — no chord; the revert/reload verbs collide with
        // nothing either, so they stay unbound.
        fileMenu.addItem(NSMenuItem(title: "Save a Copy…", action: #selector(MenuBarActions.saveACopyActiveEditor(_:)), keyEquivalent: "").identified("file.saveACopy"))
        fileMenu.addItem(NSMenuItem(title: "Revert to Saved", action: #selector(MenuBarActions.revertActiveEditor(_:)), keyEquivalent: "").identified("file.revertToSaved"))
        fileMenu.addItem(NSMenuItem(title: "Reload from Disk", action: #selector(MenuBarActions.reloadActiveEditor(_:)), keyEquivalent: "").identified("file.reloadFromDisk"))

        fileMenu.addItem(NSMenuItem.separator())

        // Close (⌘W): routes through the web view's responder chain
        // rather than NSWindow.performClose. The custom selector sends a
        // Control frame that action-dispatch.ts turns into a `close` chain
        // dispatch, which lands on TugPane's registered handler. Without the
        // round-trip, AppKit would swallow ⌘W at the menubar and the WKWebView
        // would never see the keystroke. The web layer decides whether ⌘W
        // closes the active card or the whole pane (single-card case); the
        // label stays "Close" regardless.
        let closeMenuItem = NSMenuItem(title: "Close", action: #selector(MenuBarActions.closeActiveCard(_:)), keyEquivalent: "w")
        // Stable identifier for native-menu introspection (test harness
        // `menuItemState` / `menuSnapshot`).
        closeMenuItem.identifier = NSUserInterfaceItemIdentifier("file.closeCard")
        fileMenu.addItem(closeMenuItem)

        // Close All Tabs (⌥⌘W): closes every tab in the focused pane via
        // the same `close-all` responder-chain round-trip `close` uses. Enabled
        // only when the focused pane holds more than one card — its registry
        // gate on the menuState push. The web layer pops the "Close N Tabs?"
        // confirm when any hosted card opts into confirmClose.
        let closeAllCardTabsMenuItem = NSMenuItem(title: "Close All Tabs", action: #selector(MenuBarActions.closeAllCardTabs(_:)), keyEquivalent: "w", modifierMask: [.command, .option])
        closeAllCardTabsMenuItem.identifier = NSUserInterfaceItemIdentifier("file.closeAllCardTabs")
        fileMenu.addItem(closeAllCardTabsMenuItem)

        fileMenu.addItem(NSMenuItem.separator())

        // Export Session… — the session card's `/export` surface, reached
        // through the generic run-card-command round-trip. Gated by its
        // registry gate on the menuState push.
        let exportItem = NSMenuItem(title: "Export Session…", action: #selector(MenuBarActions.runCardCommand(_:)), keyEquivalent: "").identified("file.exportTranscript")
        exportItem.representedObject = "export"
        fileMenu.addItem(exportItem)

        // Edit Menu - position 2
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        // Undo / Redo target performUndo/performRedo wrappers, NOT the
        // bare `undo:` selectors AppKit would auto-validate against an
        // NSUndoManager — the web view's undoManager is per-web-view and
        // knows nothing about card activation, so unconditional
        // auto-validation kept showing a deactivated card's undo state.
        // Validation and execution are two-path, discriminated by
        // MenuState.edit.nativeUndoToken (see validateMenuItem and the
        // wrappers): chain caps + control-frame round-trip for the CM6
        // editors (card-scoped history depth + "Undo Typing" nouns), and
        // the web view's NSUndoManager — live canUndo + native selector —
        // for browser-native text controls, scoped by the token-change
        // clear. A chord on a DISABLED item is eaten at the menu bar with
        // a beep (it does NOT fall through to the web view), which is why
        // the native path must light the item rather than stay dark.
        editMenu.addItem(NSMenuItem(title: "Undo", action: #selector(MenuBarActions.performUndo(_:)), keyEquivalent: "z").identified("edit.undo"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: #selector(MenuBarActions.performRedo(_:)), keyEquivalent: "z", modifierMask: [.command, .shift]).identified("edit.redo"))
        editMenu.addItem(NSMenuItem.separator())
        // The remaining edit actions target AppDelegate wrappers
        // (performCopy / …) rather than the bare NSText selectors so that
        // `validateMenuItem(_:)` is consulted — the wrappers resolve to
        // this delegate, the native selectors would resolve to the
        // WKWebView and be validated by WebKit, which over-enables Copy /
        // Select All because a web page is always "selectable" regardless
        // of our focus state. Each wrapper re-dispatches its native AppKit
        // selector to the first responder synchronously (`NSApp.sendAction`),
        // so the system pasteboard and the in-gesture clipboard path are
        // preserved untouched — enablement is the only thing we take over,
        // pulled from each item's registry gate on the menuState push.
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(MenuBarActions.performCut(_:)), keyEquivalent: "x").identified("edit.cut"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(MenuBarActions.performCopy(_:)), keyEquivalent: "c").identified("edit.copy"))
        // Copy as Plain Text — a chain-action round-trip (NOT the native
        // NSText.copy selector). The web responder chain strips Markdown
        // from the selection and writes the plain text to the clipboard;
        // enablement rides its registry gate, which needs a selection the
        // same way Copy's does.
        // ⌥⇧⌘C — the "…as Plain Text" composed set (tuglaws/chord-tiers.md):
        // ⌥ the variant of Copy, ⇧ its counterpart, both twists at once. Its
        // twin is ⌥⇧⌘V on Paste as Plain Text below.
        editMenu.addItem(NSMenuItem(title: "Copy as Plain Text", action: #selector(MenuBarActions.performCopyAsPlainText(_:)), keyEquivalent: "c", modifierMask: [.command, .shift, .option]).identified("edit.copyAsPlainText"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(MenuBarActions.performPaste(_:)), keyEquivalent: "v").identified("edit.paste"))
        // Paste variants — chain-action round-trips (NOT the native
        // NSText.paste selector). The web responder chain reads the
        // clipboard via the native bridge, rewrites it (blockquote wrap /
        // Markdown strip), and inserts; enablement rides each item's registry
        // gate, which needs an editable surface the same way Paste's does.
        editMenu.addItem(NSMenuItem(title: "Paste as Quote", action: #selector(MenuBarActions.performPasteAsQuote(_:)), keyEquivalent: "v", modifierMask: [.command, .option]).identified("edit.pasteAsQuote"))
        // ⌥⇧⌘V — moved off ⇧⌘V to pair with the ⌥⇧⌘C copy variant.
        editMenu.addItem(NSMenuItem(title: "Paste as Plain Text", action: #selector(MenuBarActions.performPasteAsPlainText(_:)), keyEquivalent: "v", modifierMask: [.command, .shift, .option]).identified("edit.pasteAsPlainText"))
        editMenu.addItem(NSMenuItem(title: "Delete", action: #selector(MenuBarActions.performDelete(_:)), keyEquivalent: "").identified("edit.delete"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(MenuBarActions.performSelectAll(_:)), keyEquivalent: "a").identified("edit.selectAll"))
        editMenu.addItem(NSMenuItem.separator())

        // The case pair — chain-action round-trips like the paste variants:
        // the transform lives in the web responder chain, which rewrites the
        // selection in one editor transaction so undo reverts it whole. Built
        // with EMPTY key equivalents on purpose: their chords (⌥⌘U / ⌥⌘L) are
        // the command registry's, published per item in the menu-state gate,
        // and `applyCommandChords` writes them from there — a construction
        // literal here would put a second author on the same keys and would
        // survive a rebind.
        editMenu.addItem(NSMenuItem(title: "Make Uppercase", action: #selector(MenuBarActions.performMakeUppercase(_:)), keyEquivalent: "").identified("edit.makeUppercase"))
        editMenu.addItem(NSMenuItem(title: "Make Lowercase", action: #selector(MenuBarActions.performMakeLowercase(_:)), keyEquivalent: "").identified("edit.makeLowercase"))
        editMenu.addItem(NSMenuItem.separator())

        // The quote pair — chain-action round-trips like the case pair: the
        // CM6 editors add or remove one Markdown quote level on every line
        // the selection touches, in one transaction. Empty key equivalents
        // for the case pair's reason: ⌘' / ⇧⌘' are the registry's, and
        // `applyCommandChords` writes them.
        editMenu.addItem(NSMenuItem(title: "Quote", action: #selector(MenuBarActions.performQuoteLines(_:)), keyEquivalent: "").identified("edit.quoteLines"))
        editMenu.addItem(NSMenuItem(title: "Unquote", action: #selector(MenuBarActions.performUnquoteLines(_:)), keyEquivalent: "").identified("edit.unquoteLines"))
        editMenu.addItem(NSMenuItem.separator())

        // Copy Last Response — the session card's `/copy` surface. Enablement
        // rides the command's registry gate on the menuState push.
        let copyLastItem = NSMenuItem(title: "Copy Last Response", action: #selector(MenuBarActions.runCardCommand(_:)), keyEquivalent: "").identified("edit.copyLastResponse")
        copyLastItem.representedObject = "copy"
        editMenu.addItem(copyLastItem)
        editMenu.addItem(NSMenuItem.separator())

        // Find submenu — chain-action round-trips. The previous
        // NSTextView.performFindPanelAction items never reached WKWebView
        // content (dead UI); these dispatch the web responder chain's
        // find / find-next / find-previous, handled by the focused card's
        // find session. Enablement rides each item's registry gate on the
        // menuState push: disabled until a find-capable surface is
        // focused, so the items aren't live shortcuts to a no-op while no
        // card implements find.
        let findMenuItem = NSMenuItem(title: "Find", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "Find")
        findMenuItem.submenu = findMenu
        findMenu.addItem(NSMenuItem(title: "Find...", action: #selector(MenuBarActions.performFind(_:)), keyEquivalent: "f").identified("edit.find"))
        findMenu.addItem(NSMenuItem(title: "Find Next", action: #selector(MenuBarActions.performFindNext(_:)), keyEquivalent: "g").identified("edit.findNext"))
        findMenu.addItem(NSMenuItem(title: "Find Previous", action: #selector(MenuBarActions.performFindPrevious(_:)), keyEquivalent: "g", modifierMask: [.command, .shift]).identified("edit.findPrevious"))
        // ⌘E — the selection becomes the query and the search runs. Its gate
        // is stricter than its siblings': a find-capable surface with nothing
        // selected validates it disabled.
        findMenu.addItem(NSMenuItem(title: "Use Selection for Find", action: #selector(MenuBarActions.performFindSelection(_:)), keyEquivalent: "e").identified("edit.useSelectionForFind"))
        editMenu.addItem(findMenuItem)

        // Session Menu - position 3. The session card's command surfaces,
        // first-class in the menu bar. The menu is always present and its
        // items validate to disabled without a frontmost session card
        // (stable bars with disabled items beat vanishing menus for
        // discoverability); most items are run-card-command round-trips
        // into the card's slash-command surface map.
        let sessionMenuItem = NSMenuItem()
        mainMenu.addItem(sessionMenuItem)
        let sessionMenu = NSMenu(title: "Session")
        sessionMenuItem.submenu = sessionMenu

        sessionMenu.addItem(NSMenuItem(title: "Focus Prompt", action: #selector(MenuBarActions.focusPrompt(_:)), keyEquivalent: "k").identified("session.focusPrompt"))
        // Stop has no key equivalent by design: Escape already routes
        // interrupt through the chain with dismiss-first priority
        // (popover > drag-cancel > interrupt); this item is the
        // discoverable, always-means-interrupt face of that path,
        // gated by its registry gate on the menuState push.
        sessionMenu.addItem(NSMenuItem(title: "Stop", action: #selector(MenuBarActions.stopSession(_:)), keyEquivalent: "").identified("session.stop"))
        sessionMenu.addItem(NSMenuItem.separator())

        // The composer's two affordances. These were chord-only until now —
        // working commands with no discoverable door — so the menu is what
        // makes them findable.
        //
        // They are built WITHOUT key equivalents on purpose. Their chords
        // belong to the command registry, which publishes them per item in
        // the menu-state gate along with the item's enablement, and the
        // chord sweep applies them from there. Stamping a construction-time
        // literal here would put a second author on the same key equivalent
        // and would attach the chord to an item that can validate disabled —
        // where AppKit eats it with a beep instead of letting the web view
        // have it. Until the sweep runs, the frontend's own key pipeline
        // serves these chords exactly as it did before the items existed.
        sessionMenu.addItem(NSMenuItem(title: "Insert File…", action: #selector(MenuBarActions.insertFile(_:)), keyEquivalent: "").identified("session.insertFile"))
        sessionMenu.addItem(NSMenuItem(title: "Open Command Picker", action: #selector(MenuBarActions.openCommandPicker(_:)), keyEquivalent: "").identified("session.commandPicker"))
        // Dictation's two doors, built the same way and for the same reason:
        // ⌘D and ⇧⌘D come from the registry with each item's gate. Both gates
        // are the deck's first-responder walk — Start Dictation is lit where a
        // composer with a mic holds the keyboard (and reads Stop Dictation
        // while that composer is dictating); Stop Dictation and Send is lit
        // only while the focused composer owns the mic. Dark, each releases
        // its chord to the web view rather than beeping.
        sessionMenu.addItem(NSMenuItem(title: "Start Dictation", action: #selector(MenuBarActions.toggleDictation(_:)), keyEquivalent: "").identified("session.dictate"))
        sessionMenu.addItem(NSMenuItem(title: "Stop Dictation and Send", action: #selector(MenuBarActions.stopDictationAndSend(_:)), keyEquivalent: "").identified("session.dictateAndSend"))

        sessionMenu.addItem(NSMenuItem.separator())

        func sessionCommandItem(_ title: String, _ command: String, _ id: String) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: #selector(MenuBarActions.runCardCommand(_:)), keyEquivalent: "").identified(id)
            item.representedObject = command
            return item
        }

        // The changes group: glance, land, inspect, look back. Show/Hide the
        // Changes / History Shades ([P05], Spec S04) bracket it — the title's
        // verb rides the registry gate's title field on the menuState push, the
        // represented view name rides `representedObject`, and the toggle
        // round-trips a `toggle-{changes,history}-view` control frame.
        //
        // Commit Changes carries no chord. It is the LAND verb, not the enter
        // verb (`/commit` and ⌃⌘C-on-an-empty-composer are the doors into
        // commit mode), and it validates on the frontend's `commitReady` — mode
        // active, session idle, changeset non-empty, message written. In exactly
        // that state the composer's own submit key already lands it, and a
        // literal ⏎ here would be eaten at the menu bar instead of inserting a
        // newline for anyone whose submit key is ⇧⏎.
        let toggleChangesItem = NSMenuItem(title: "Show Session Changes", action: #selector(MenuBarActions.toggleShadeView(_:)), keyEquivalent: "c", modifierMask: [.command, .control]).identified("session.toggleChanges")
        toggleChangesItem.representedObject = "changes"
        sessionMenu.addItem(toggleChangesItem)
        sessionMenu.addItem(sessionCommandItem("Commit Changes", "commit", "session.commit"))
        sessionMenu.addItem(sessionCommandItem("Show Project Diff", "diff", "session.diff"))
        let toggleHistoryItem = NSMenuItem(title: "Show Commit History", action: #selector(MenuBarActions.toggleShadeView(_:)), keyEquivalent: "h", modifierMask: [.command, .control]).identified("session.toggleHistory")
        toggleHistoryItem.representedObject = "history"
        sessionMenu.addItem(toggleHistoryItem)
        sessionMenu.addItem(NSMenuItem.separator())

        // The lifecycle group: what a session is, from resuming one to
        // clearing it. Folding the card moved to View ▸ Fold Card, because
        // every content card folds and the fold is the pane's.
        sessionMenu.addItem(sessionCommandItem("Resume Session…", "resume", "session.resume"))
        sessionMenu.addItem(sessionCommandItem("Rename Session…", "rename", "session.rename"))
        sessionMenu.addItem(sessionCommandItem("Unname Session", "unname", "session.unname"))
        sessionMenu.addItem(sessionCommandItem("Clear Session", "clear", "session.new"))
        sessionMenu.addItem(NSMenuItem.separator())

        // One door for model, reasoning effort, and permission mode — and a
        // state display: the registry gate pushes a live title, so this item
        // reads `AI: Fable 5 · High · Auto…` and the menu says what the AI is
        // set to. The static title here is the pre-push fallback.
        sessionMenu.addItem(sessionCommandItem("AI Settings…", "ai", "session.ai"))
        // ⌃⌥⌘P — the advanced form of a Tug-tier command
        // (tuglaws/chord-tiers.md); the composer's Prompt route holds ⌃⌘P.
        // This menu item has to carry the same chord as the tugdeck binding
        // or it keeps swallowing it at the menu bar before the web view ever
        // sees it. It keeps a visible home now that the submenu is gone: a
        // chord without a menu item is not discoverable.
        sessionMenu.addItem(NSMenuItem(title: "Cycle Permission Mode", action: #selector(MenuBarActions.cyclePermissionModeFromMenu(_:)), keyEquivalent: "p", modifierMask: [.command, .control, .option]).identified("session.permissionMode.cycle"))
        // The tool-permission RULES editor — a different surface from the AI
        // mixer, so it keeps its own row.
        sessionMenu.addItem(sessionCommandItem("Permission Rules…", "permissions", "session.permissionRules"))
        sessionMenu.addItem(sessionCommandItem("Add Working Directory…", "add-dir", "session.addDir"))
        sessionMenu.addItem(NSMenuItem.separator())
        sessionMenu.addItem(sessionCommandItem("Rewind…", "rewind", "session.rewind"))
        sessionMenu.addItem(sessionCommandItem("Compact Conversation", "compact", "session.compact"))
        sessionMenu.addItem(NSMenuItem.separator())
        sessionMenu.addItem(sessionCommandItem("Show Context", "context", "session.context"))
        sessionMenu.addItem(sessionCommandItem("Show Usage", "usage", "session.usage"))

        // Inspect ▸ — the four project/session surfaces, each a viewer over
        // what this session is working with rather than a configurator.
        let configureItem = NSMenuItem(title: "Inspect", action: nil, keyEquivalent: "").identified("session.configure")
        let configureMenu = NSMenu(title: "Inspect")
        configureItem.submenu = configureMenu
        configureMenu.addItem(sessionCommandItem("Skills…", "skills", "session.skills"))
        configureMenu.addItem(sessionCommandItem("Agents…", "agents", "session.agents"))
        configureMenu.addItem(sessionCommandItem("Hooks…", "hooks", "session.hooks"))
        configureMenu.addItem(sessionCommandItem("Memory…", "memory", "session.memory"))
        sessionMenu.addItem(configureItem)

        // Go Menu - position 4. Every verb that takes the reader somewhere,
        // in one place and on four axes: which card, which direction, which
        // slot, which turn. The rows were spread across Window and a Session
        // submenu before, which made a reader look in two menus for one kind
        // of act; Xcode's Navigate and VS Code's Go are the precedent, and Go
        // is the shorter word and Finder's. Everything here is built exactly
        // as it was built where it came from — same selectors, same
        // `representedObject` payloads, same key equivalents, same registry
        // gates — with only the identifier namespace changed to `go.`.
        let goMenuItem = NSMenuItem()
        mainMenu.addItem(goMenuItem)
        let gMenu = NSMenu(title: "Go")
        goMenuItem.submenu = gMenu

        // Card navigation — one relationship, two axes. Previous/Next Card
        // walk the deck's visible cards side to side (every tab of every
        // front pane, one ring); Previous/Next Card in Stack rotate the
        // focused pane's slot stack front to back. The chords say the same
        // thing: ⇧⌘[/] for the lateral pair (macOS tab convention), ⌥⌘[/]
        // for the depth pair — ⌥ as the variant operator, same keys, other
        // axis. All four are chain round-trips for chords AppKit swallows
        // at the menu bar.
        gMenu.addItem(NSMenuItem(title: "Previous Card", action: #selector(MenuBarActions.previousCard(_:)), keyEquivalent: "[", modifierMask: [.command, .shift]).identified("go.previousCard"))
        gMenu.addItem(NSMenuItem(title: "Next Card", action: #selector(MenuBarActions.nextCard(_:)), keyEquivalent: "]", modifierMask: [.command, .shift]).identified("go.nextCard"))
        gMenu.addItem(NSMenuItem(title: "Previous Card in Stack", action: #selector(MenuBarActions.previousCardInStack(_:)), keyEquivalent: "[", modifierMask: [.command, .option]).identified("go.previousCardInStack"))
        gMenu.addItem(NSMenuItem(title: "Next Card in Stack", action: #selector(MenuBarActions.nextCardInStack(_:)), keyEquivalent: "]", modifierMask: [.command, .option]).identified("go.nextCardInStack"))
        // Reveal Stack is the depth pair's readable counterpart: it opens
        // the focused pane's picker to be read before choosing, where the
        // pair switches without looking. ⌘R rides the JS keymap sweep, and
        // detaches when the stack has nowhere to go.
        gMenu.addItem(NSMenuItem(title: "Reveal Stack", action: #selector(MenuBarActions.revealStack(_:)), keyEquivalent: "").identified("go.revealStack"))
        gMenu.addItem(NSMenuItem.separator())
        // Focus Card Left / Right / Above / Below — move the KEYBOARD to the
        // card that is spatially in that direction, which is the other half of
        // the pair Window's column rows are one of: those move the card, these
        // move the reader through the arrangement the card stands in. Its own
        // group for that reason, and because it is the one family here that is
        // not selection-relative — the frontend reads the first responder, since
        // the gesture moves the keyboard and where the keyboard is IS the
        // source.
        //
        // ⌥⌘←/→/↑/↓, all four with EMPTY key equivalents like everything else in
        // this menu: `applyCommandChords` writes them from the frontend's
        // keymap, so the family stays rebindable. Each row is gated per
        // direction by its registry entry on the menuState push, so an item is
        // live exactly when its chord would act — and the gates hold the chord
        // while dark (`disabledChord: "keep"`), because nothing else in the JS
        // funnel wants ⌥⌘ arrows and there is nothing for a release to hand
        // them to. A dark row does not eat the press: AppKit declines to fire a
        // disabled item and leaves the keydown alone, so it reaches the web
        // view, where the same command's own binding still stands and answers
        // the refusal with a border flash on the pane that is not moving.
        for (title, direction, id) in [
            ("Focus Card Left", "left", "go.focusCardLeft"),
            ("Focus Card Right", "right", "go.focusCardRight"),
            ("Focus Card Above", "above", "go.focusCardAbove"),
            ("Focus Card Below", "below", "go.focusCardBelow"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(MenuBarActions.focusCardFromMenu(_:)), keyEquivalent: "").identified(id)
            item.representedObject = direction
            gMenu.addItem(item)
        }
        gMenu.addItem(NSMenuItem.separator())
        // Go to Slot 1…6 — take the reader to that slot: the band travels to
        // put it as near the middle as the strip allows, which at either end
        // is flush against it. The digit row's other reading: ⌘n sends the
        // card to a place,
        // ⌃⌘n sends the reader to one, and nothing in the arrangement moves.
        // Six rows because six-up is the largest arrangement; each is dark
        // under fit and dark past the current kind's slot count, both gated by
        // its registry entry on the menuState push.
        for n in 1...6 {
            let item = NSMenuItem(title: "Go to Slot \(n)", action: #selector(MenuBarActions.goToSlotFromMenu(_:)), keyEquivalent: "").identified("go.goToSlot.\(n)")
            item.representedObject = n
            gMenu.addItem(item)
        }
        gMenu.addItem(NSMenuItem.separator())
        // The four turn-navigation verbs, flat rather than submenued: in a
        // menu that is entirely about movement they are one axis among four
        // and read as a group, where under Session they had to be folded away
        // so they would not compete with the session's own verbs. They keep
        // their empty key equivalents — `applyCommandChords` writes the ⌃⌘
        // bracket family from the frontend's keymap — and they still validate
        // to disabled without a frontmost session card, which is the registry
        // gate's doing and not the menu's.
        gMenu.addItem(NSMenuItem(title: "Previous Turn", action: #selector(MenuBarActions.previousTurn(_:)), keyEquivalent: "").identified("go.previousTurn"))
        gMenu.addItem(NSMenuItem(title: "Next Turn", action: #selector(MenuBarActions.nextTurn(_:)), keyEquivalent: "").identified("go.nextTurn"))
        gMenu.addItem(NSMenuItem(title: "First Turn", action: #selector(MenuBarActions.firstTurn(_:)), keyEquivalent: "").identified("go.firstTurn"))
        gMenu.addItem(NSMenuItem(title: "Last Turn", action: #selector(MenuBarActions.lastTurn(_:)), keyEquivalent: "").identified("go.lastTurn"))

        // View Menu - position 5.
        // How the content is shown: appearance, page zoom, card width and
        // posture, the sidebars, keyboard focus, and full screen. Rebuilt
        // WHOLE on every open in menuNeedsUpdate — this menu is not
        // NSApp.windowsMenu, so AppKit adds nothing to it and there is
        // nothing to manage by section.
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let vMenu = NSMenu(title: "View")
        viewMenuItem.submenu = vMenu

        // Theme submenu — populated dynamically via NSMenuDelegate. The
        // NSMenu instance persists across View-menu rebuilds; each rebuild
        // wraps it in a fresh parent item.
        let dynamicThemeMenu = NSMenu(title: "Theme")

        // Window Menu - position 6. Static items are built once here and
        // never touched by the delegate; only the dynamic `window.pane.*`
        // slice (between paneListAnchor and the following separator) churns
        // in menuNeedsUpdate. NSApp.windowsMenu keeps AppKit's automatic
        // window entries at the menu tail — never removeAllItems() here.
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let wMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = wMenu
        wMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m").identified("window.minimize"))
        wMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "").identified("window.zoom"))
        wMenu.addItem(NSMenuItem.separator())
        // The column family — how the panes standing in one slot arrange
        // themselves, and where this card stands among them. Its own group
        // because moving a card among the panes of a place is arrangement —
        // Window's business — where choosing which card to look at is
        // movement, and lives in Go.
        //
        // ⌃⌘/ and the ⌃⌘ arrows, all with EMPTY key equivalents for the same
        // reason the width rows have them — `applyCommandChords` writes them
        // from the frontend's keymap, so the whole family stays rebindable.
        // Their gates hold the chord while the item is dark
        // (`disabledChord: "keep"`): nothing in the JS funnel wants these
        // chords, so there is nothing for a release to hand them back to, and
        // the beep is honest feedback that the column had no move to make.
        //
        // Every one of them is selection-relative — the frontend resolves the
        // layout selection, else the Cards list's cursor, else the first
        // responder — so the move target is all the payload there is.
        //
        // "Split or Stack Column" is the BOOT title only. The registry gate
        // rewrites it on every menuState push to name the one verb the next
        // press performs — "Split Column" over a stacked place, "Stack
        // Column" over a split one — so the row is never a coin toss. It
        // falls back to the pair when no column resolves, which is also when
        // the row is dark.
        wMenu.addItem(NSMenuItem(title: "Split or Stack Column", action: #selector(MenuBarActions.toggleColumnSplit(_:)), keyEquivalent: "").identified("window.columnSplit"))
        for (title, where_, id) in [
            ("Move Card Up in Column", "up", "window.columnMoveUp"),
            ("Move Card Down in Column", "down", "window.columnMoveDown"),
            ("Move Card to Top of Column", "top", "window.columnMoveTop"),
            ("Move Card to Bottom of Column", "bottom", "window.columnMoveBottom"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(MenuBarActions.moveInColumnFromMenu(_:)), keyEquivalent: "").identified(id)
            item.representedObject = where_
            wMenu.addItem(item)
        }
        wMenu.addItem(NSMenuItem.separator())
        // Anchor separator for the dynamic pane-list slice: pane items are
        // inserted directly after it (and removed by identifier prefix) on
        // every menu open. macOS hides the redundant separator pair when
        // the slice is empty.
        //
        // The Workspaces slice takes its own anchor ahead of it, for the same
        // sectioned reason and in the order the levels nest: workspaces, then
        // the panes of the one on screen.
        //
        // The four verbs stand immediately above that anchor, and take NO
        // separator of their own: `windowSpaceListAnchor` IS a separator, and
        // `rebuildWindowSpaceList` inserts the workspace rows after it — so
        // one of our own here would put two rules side by side every time the
        // list is non-empty.
        //
        // None of these four identifiers begins `window.space.`, which is
        // load-bearing rather than incidental: `rebuildWindowSpaceList`
        // removes every item carrying that prefix on each menu open, and a
        // static item caught by that sweep would disappear the first time
        // anybody used the Window menu.
        wMenu.addItem(NSMenuItem(title: "New Workspace", action: #selector(MenuBarActions.newWorkspaceFromMenu(_:)), keyEquivalent: "").identified("window.newWorkspace"))
        wMenu.addItem(NSMenuItem(title: "Rename Workspace…", action: #selector(MenuBarActions.renameWorkspaceFromMenu(_:)), keyEquivalent: "").identified("window.renameWorkspace"))
        wMenu.addItem(NSMenuItem(title: "Duplicate Workspace", action: #selector(MenuBarActions.duplicateWorkspaceFromMenu(_:)), keyEquivalent: "").identified("window.duplicateWorkspace"))
        wMenu.addItem(NSMenuItem(title: "Delete Workspace", action: #selector(MenuBarActions.deleteWorkspaceFromMenu(_:)), keyEquivalent: "").identified("window.deleteWorkspace"))
        let spaceAnchor = NSMenuItem.separator()
        wMenu.addItem(spaceAnchor)
        let paneAnchor = NSMenuItem.separator()
        wMenu.addItem(paneAnchor)
        wMenu.addItem(NSMenuItem.separator())
        wMenu.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "").identified("window.bringAllToFront"))

        // Maker Menu - position 7. Tooling for makers *of* the app —
        // "session" stays free to mean the Session card's domain. Hidden (not
        // disabled) behind the maker-mode gate: a *mode*, not a focus
        // state, so hide-on-gate is the right shape here.
        let makerMenu = NSMenuItem()
        mainMenu.addItem(makerMenu)
        let mMenu = NSMenu(title: "Maker")
        makerMenu.submenu = mMenu
        let reloadItem = NSMenuItem(title: "Reload", action: #selector(MenuBarActions.reload(_:)), keyEquivalent: "r", modifierMask: [.command, .shift]).identified("maker.reload")
        reloadItem.target = reloadTarget
        mMenu.addItem(reloadItem)
        mMenu.addItem(NSMenuItem.separator())
        // Show DevTools (⌥⌘/) — the frontend's own inspector card. Chord left
        // to the registry's sweep, like the Session items. Placing it in the
        // Maker menu is also what keeps the chord working outside maker mode:
        // the menu is hidden then, and a hidden menu's key equivalents fall
        // through to the web view.
        mMenu.addItem(NSMenuItem(title: "Show DevTools", action: #selector(MenuBarActions.showDevTools(_:)), keyEquivalent: "").identified("maker.devTools"))
        // The per-card sidebar rows live under View ▸ ⟨Card⟩, not here: a
        // release build hides this menu, and the only menu route to a sidebar
        // card must not be one most users never see. The rail pair below
        // belongs here — it addresses the deck's SIDES rather than its cards,
        // which is a maker's reading of the same geometry.
        // Show Left Rail (⌃⌘←) and Show Right Rail (⌃⌘→) — the deck's two
        // sides as keyboard entities, three-state like the card rows in the
        // View menu:
        // show and focus, focus, hide. The side rides `representedObject`, the
        // shape the column-move rows use. Key equivalents left EMPTY for the
        // reason every row here leaves them empty — `applyCommandChords` writes
        // them from the frontend's keymap, so the pair stays rebindable.
        for (title, side, id) in [
            ("Show Left Rail", "left", "maker.leftRail"),
            ("Show Right Rail", "right", "maker.rightRail"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(MenuBarActions.toggleRailFromMenu(_:)), keyEquivalent: "").identified(id)
            item.representedObject = side
            mMenu.addItem(item)
        }
        if debugProfile {
            // Debug-only card creators, relocated from the flattened
            // File ▸ New submenu. Compile-time gated so release bundles
            // never expose the gallery + hello-world creation surfaces.
            mMenu.addItem(NSMenuItem.separator())
            mMenu.addItem(NSMenuItem(title: "New Component Gallery Card", action: #selector(MenuBarActions.newComponentGalleryCard(_:)), keyEquivalent: "g", modifierMask: [.command, .option]).identified("maker.galleryCard"))
            mMenu.addItem(NSMenuItem(title: "New Hello World Card", action: #selector(MenuBarActions.newHelloWorldCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option, .shift]).identified("maker.helloCard"))
            // The Spikes index. No key equivalent: ⌥⌘G and ⌥⌘⇧N are taken,
            // and a chord for the design sandbox is not worth a tier.
            mMenu.addItem(NSMenuItem(title: "New Spikes Card", action: #selector(MenuBarActions.newSpikesCard(_:)), keyEquivalent: "").identified("maker.spikesCard"))
            // New Card in Active Pane (⌘T): the tab-creation chord.
            // Validated against deck state (needs a pane to add to).
            mMenu.addItem(NSMenuItem(title: "New Card in Active Pane", action: #selector(MenuBarActions.addCardToActivePane(_:)), keyEquivalent: "t").identified("maker.newCardInPane"))
        }
        mMenu.addItem(NSMenuItem.separator())
        mMenu.addItem(NSMenuItem(title: "Source Tree...", action: #selector(MenuBarActions.sourceTree(_:)), keyEquivalent: "").identified("maker.sourceTree"))
        makerMenu.isHidden = !makerMode

        // Help Menu - position 8
        let helpMenuItem = NSMenuItem()
        mainMenu.addItem(helpMenuItem)
        let helpMenu = NSMenu(title: "Help")
        helpMenuItem.submenu = helpMenu
        // Keyboard Shortcuts & Commands — the session card's `/help` sheet via
        // run-card-command. Gated by its registry gate on the menuState push.
        let shortcutsItem = NSMenuItem(title: "Keyboard Shortcuts & Commands", action: #selector(MenuBarActions.runCardCommand(_:)), keyEquivalent: "").identified("help.shortcuts")
        shortcutsItem.representedObject = "help"
        helpMenu.addItem(shortcutsItem)
        helpMenu.addItem(NSMenuItem.separator())
        helpMenu.addItem(NSMenuItem(title: "Project Home", action: #selector(MenuBarActions.openProjectHome(_:)), keyEquivalent: "").identified("help.projectHome"))
        helpMenu.addItem(NSMenuItem(title: "GitHub", action: #selector(MenuBarActions.openGitHub(_:)), keyEquivalent: "").identified("help.github"))
        helpMenu.addItem(NSMenuItem.separator())
        // A diagnostic, in the one menu a release build shows: a burst of
        // composited frames of this window to /tmp, for reading an animation
        // as the window server actually painted it. See `captureFrameBurst`.
        helpMenu.addItem(NSMenuItem(title: "Capture Frames (Diagnostic)", action: #selector(MenuBarActions.captureFramesDiagnostic(_:)), keyEquivalent: "").identified("help.captureFrames"))

        return MenuHandles(
            mainMenu: mainMenu,
            servicesMenu: servicesMenu,
            helpMenu: helpMenu,
            viewMenu: vMenu,
            windowMenu: wMenu,
            windowSpaceListAnchor: spaceAnchor,
            windowPaneListAnchor: paneAnchor,
            themeMenu: dynamicThemeMenu,
            openRecentMenu: openRecentSubmenu
        )
    }
}

// Helper extension for menu items with modifier masks
extension NSMenuItem {
    convenience init(title: String, action: Selector?, keyEquivalent: String, modifierMask: NSEvent.ModifierFlags) {
        self.init(title: title, action: action, keyEquivalent: keyEquivalent)
        self.keyEquivalentModifierMask = modifierMask
    }

    /// Tag the item with its stable, namespaced introspection identifier.
    /// The test harness (`menuSnapshot` / `menuItemState`) addresses items
    /// by identifier, and `validateMenuItem(_:)` switches on it — identity
    /// never rides the (flippable, localizable) title. Returns self so
    /// build sites can tag inline.
    @discardableResult
    func identified(_ id: String) -> NSMenuItem {
        identifier = NSUserInterfaceItemIdentifier(id)
        return self
    }
}

