import Cocoa

/// The menus that are rebuilt on open: View, Theme, File ▸ Open Recent, and
/// the Workspaces and pane slices of Window.
///
/// The `NSMenuDelegate` of those four menus. It consumes the handles
/// `MenuBarBuilder` returned, and reads the facts it rebuilds from — the
/// menu-state push, the source tree, the chord sweep — through a weak
/// reference to the app delegate, which owns them. The items it builds send
/// their actions up the responder chain to the app delegate, exactly as the
/// bar's static items do.
final class MenuStateSync: NSObject, NSMenuDelegate {
    let menus: MenuHandles
    private weak var delegate: AppDelegate?

    /// The theme the Theme menu checkmarks, refreshed from the push on every
    /// open.
    var activeThemeName: String?

    /// The name of the base theme — must match BASE_THEME_NAME in tugdeck/src/theme-constants.ts.
    private let baseThemeName = "ironclad"

    init(menus: MenuHandles, delegate: AppDelegate) {
        self.menus = menus
        self.delegate = delegate
        super.init()
        for menu in menus.rebuiltOnOpen {
            menu.delegate = self
        }
    }

    private var menuState: MenuState { delegate?.menuState ?? .empty }
    private var sourceTreePath: String? { delegate?.sourceTreePath }
    private func applyCommandChords(in menu: NSMenu) { delegate?.applyCommandChords(in: menu) }

    /// The glyph AppKit draws for `.mixed`, shared by every row that can
    /// reach that state — the five sidebar parents and the five toggles inside
    /// them.
    ///
    /// AppKit's own mixed mark is a dash, which reads as "some of these" and
    /// says nothing here. An empty square does: it is a mark in the same
    /// column as the plain check it alternates with, at the same footprint,
    /// without competing with it for ink. Not `checkmark.square`, whose
    /// inset check draws SMALLER than the plain check — the top rung is the
    /// emphatic one, so a mark that shrinks there points attention the wrong
    /// way.
    ///
    /// **A square is a stroke, so both halves of the configuration matter.**
    /// The point size is the menu font's own, which is the box footprint
    /// `checkmark.square` already sat at; the weight is `.regular`, because a
    /// heavier stroke — or a filled shape — reads as a blob beside a check
    /// rather than a mark in the same column. Both are look-at-it numbers,
    /// not derived ones.
    ///
    /// The Window menu's tail still uses AppKit's diamond for a minimized
    /// window. A square is adjacent to it in weight and distinct in shape,
    /// which is the reading the diamond was rejected for not having.
    private static let mixedStateGlyph: NSImage? = {
        let configuration = NSImage.SymbolConfiguration(
            pointSize: NSFont.menuFont(ofSize: 0).pointSize,
            weight: .regular
        )
        let glyph = NSImage(
            systemSymbolName: "square",
            accessibilityDescription: "Showing and holding the keyboard"
        )?.withSymbolConfiguration(configuration)
        glyph?.isTemplate = true
        return glyph
    }()

    /// Menu rebuilds are the sweep's second writer.
    ///
    /// Every rebuild below reconstructs its items from construction-time
    /// `keyEquivalent` literals, and `updateMenuState` only fires when the
    /// frontend's serialized projection changes — so a rebuild that happens
    /// after a rebind would restore the literal and keep it until some
    /// unrelated state change came along. Each rebuild therefore re-sweeps
    /// the menu it just rebuilt, which is why `applyCommandChords` is not
    /// single-site.
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === menus.viewMenu {
            rebuildViewMenu(menu)
            // After the rebuild, never before: `rebuildViewMenu` constructs a
            // fresh parent item per sidebar card on every open, so a mark
            // copied first would land on the previous open's discarded
            // objects.
            refreshSidebarParentMarks(menu)
            return
        }
        if menu === menus.windowMenu {
            rebuildWindowSpaceList(menu)
            rebuildWindowPaneList(menu)
            return
        }
        if menu === menus.openRecentMenu {
            rebuildOpenRecentMenu(menu)
            return
        }
        guard menu === menus.themeMenu else { return }
        menu.removeAllItems()

        // Which theme is current comes from the push. The web layer changes
        // the theme by paths this side never sees (keyboard Next Theme, the
        // Settings pane), so a value cached at selection time would go stale
        // — which is why this used to re-read tugbank on every open, a
        // subprocess read on the path that must finish before the menu can
        // draw. The frontend now republishes on every change instead.
        // Empty means no push has landed yet; the base theme is what the
        // frontend boots into, so the checkmark starts there rather than
        // nowhere.
        activeThemeName =
            menuState.activeTheme.isEmpty ? baseThemeName : menuState.activeTheme

        // Read theme names directly from shipped CSS files on disk, plus each
        // theme's mode from its header comment. sourceTreePath is the tugtool
        // repo root; themes are at tugdeck/styles/themes/*.css, base is "ironclad".
        // The header's first line carries "— dark theme" / "— light theme",
        // so the menu can group them without a separate manifest.
        var themeNames = Set<String>([baseThemeName])
        var darkThemes = Set<String>()
        if let root = sourceTreePath {
            let themesDir = (root as NSString).appendingPathComponent("tugdeck/styles/themes")
            if let files = try? FileManager.default.contentsOfDirectory(atPath: themesDir) {
                for file in files where file.hasSuffix(".css") {
                    let name = (file as NSString).deletingPathExtension
                    themeNames.insert(name)
                    let path = (themesDir as NSString).appendingPathComponent(file)
                    // Light themes are the exception; default to dark when the
                    // header is unreadable or unmarked.
                    let header = (try? String(contentsOfFile: path, encoding: .utf8))?.prefix(200) ?? ""
                    if !header.localizedCaseInsensitiveContains("light theme") {
                        darkThemes.insert(name)
                    }
                }
            }
        }

        // Group: dark themes first, then light themes. Within each group the
        // base theme sorts first, then alphabetical.
        func sortGroup(_ names: [String]) -> [String] {
            names.sorted { a, b in
                if a.lowercased() == baseThemeName { return true }
                if b.lowercased() == baseThemeName { return false }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }
        }
        let dark = sortGroup(themeNames.filter { darkThemes.contains($0) })
        let light = sortGroup(themeNames.filter { !darkThemes.contains($0) })

        func addThemeItem(_ name: String) {
            let item = NSMenuItem(title: name.capitalized, action: #selector(AppDelegate.selectTheme(_:)), keyEquivalent: "").identified("view.theme.\(name)")
            item.representedObject = name
            item.state = (name == activeThemeName) ? .on : .off
            menu.addItem(item)
        }
        for name in dark { addThemeItem(name) }
        if !dark.isEmpty && !light.isEmpty {
            menu.addItem(NSMenuItem.separator())
        }
        for name in light { addThemeItem(name) }

        // If no themes found, show a placeholder
        if menu.items.isEmpty {
            let placeholder = NSMenuItem(title: "No themes found", action: nil, keyEquivalent: "")
            placeholder.isEnabled = false
            menu.addItem(placeholder)
        }

        // Separator + Next Theme
        menu.addItem(NSMenuItem.separator())
        // ⇧⌘T — a pre-first-push default only, but this constructor re-runs on
        // every View menu open, so a stale literal here would put an old chord
        // back on the item until the next sweep.
        let nextItem = NSMenuItem(title: "Next Theme", action: #selector(AppDelegate.nextTheme(_:)), keyEquivalent: "t", modifierMask: [.command, .shift]).identified("view.nextTheme")
        menu.addItem(nextItem)

        // Separator + Apply To All Workspaces. Enabled only while some
        // workspace wears a theme other than the current one; the gate rides
        // the menu-state push under this item's identifier.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Apply To All Workspaces", action: #selector(AppDelegate.applyThemeToAllWorkspaces(_:)), keyEquivalent: "").identified("view.applyThemeToAllWorkspaces"))

        applyCommandChords(in: menu)
    }

    /// Rebuild the View menu: every verb about how the content is shown —
    /// the theme submenu, page zoom, card width, Bullseye, the sidebar pair
    /// and the five sidebar cards, the keyboard-focus trio, and Enter Full
    /// Screen.
    ///
    /// Zoom enablement is not computed here — `autoenablesItems` is on, so a
    /// stored `isEnabled` is overridden by the validator's permissive
    /// default. The zoom predicates live in `validateMenuItem`, which reads
    /// `window.currentPageZoom` synchronously the same way this did.
    private func rebuildViewMenu(_ menu: NSMenu) {
        menu.removeAllItems()

        // Theme submenu — the persistent themeMenu NSMenu (its own
        // NSMenuDelegate repopulates it on open), wrapped in a fresh
        // parent item per rebuild.
        let themeMenuItem = NSMenuItem(title: "Theme", action: nil, keyEquivalent: "").identified("view.theme")
        themeMenuItem.submenu = menus.themeMenu
        menu.addItem(themeMenuItem)

        // Zoom commands — Safari-style. Drive `MainWindow.setPageZoom`, which
        // the deck applies as a scale of its whole root. `Actual Size` (⌘0)
        // returns to 100%; `Zoom In` (⌘+) / `Zoom Out` (⌘-) step along
        // `MainWindow.pageZoomLevels`, 50%–200%. `Toggle Actual Size` (⌥⌘0)
        // goes to 100% and back to the last other level chosen. The hidden
        // ⌘= alias mirrors Safari's ergonomic shortcut so users don't have
        // to hold Shift to zoom in.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Actual Size", action: #selector(AppDelegate.actualSize(_:)), keyEquivalent: "0").identified("view.actualSize"))
        let toggleActualSizeItem = NSMenuItem(title: "Toggle Actual Size", action: #selector(AppDelegate.toggleActualSize(_:)), keyEquivalent: "0").identified("view.toggleActualSize")
        toggleActualSizeItem.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(toggleActualSizeItem)
        menu.addItem(NSMenuItem(title: "Zoom In", action: #selector(AppDelegate.zoomIn(_:)), keyEquivalent: "+").identified("view.zoomIn"))
        // ⌘= alias for Zoom In — visible item displays ⌘+, this hidden
        // sibling accepts ⌘= (no-shift) for ergonomic parity with
        // Safari. `allowsKeyEquivalentWhenHidden` keeps the shortcut
        // live even though the item is suppressed from the visible
        // menu. Both fire the same action.
        let zoomInAliasItem = NSMenuItem(title: "Zoom In", action: #selector(AppDelegate.zoomIn(_:)), keyEquivalent: "=").identified("view.zoomInAlias")
        zoomInAliasItem.isHidden = true
        zoomInAliasItem.allowsKeyEquivalentWhenHidden = true
        menu.addItem(zoomInAliasItem)
        menu.addItem(NSMenuItem(title: "Zoom Out", action: #selector(AppDelegate.zoomOut(_:)), keyEquivalent: "-").identified("view.zoomOut"))

        // Card width — the focused card's own width, as one of the three
        // named presets, check-marked like the title bar's width popup it
        // duplicates. Directly under the page-zoom rows because both answer
        // "how big is this", one for the page and one for the card. No key
        // equivalents: the ⌃⌘ digits these held went to Go to Slot, a verb of
        // the reading hour, where a width is set once and read at.
        // Construction still leaves them EMPTY rather than absent, because
        // `applyCommandChords` writes whatever the frontend's keymap says —
        // so a user who binds them in the keymap pane gets the rows marked
        // without a change here.
        menu.addItem(NSMenuItem.separator())
        for (title, preset) in [("Slim", "slim"), ("Comfy", "comfy"), ("Wide", "wide")] {
            let item = NSMenuItem(title: title, action: #selector(AppDelegate.setCardWidthFromMenu(_:)), keyEquivalent: "").identified("view.cardWidth.\(preset)")
            item.representedObject = preset
            menu.addItem(item)
        }
        // Bullseye — the focused card's POSTURE rather than its size: a
        // temporary reading stance, centred in the band at comfy with every
        // other surface receded, reversible by pressing again. It follows the
        // width rows because those set a number that persists and this sets a
        // stance that does not. ⌃⌘B, same Tug tier as the width row, and the
        // key equivalent is left EMPTY for the same reason theirs are —
        // `applyCommandChords` writes it from the frontend's keymap, so it
        // stays rebindable end to end.
        menu.addItem(NSMenuItem(title: "Bullseye", action: #selector(AppDelegate.toggleBullseye(_:)), keyEquivalent: "").identified("view.bullseye"))
        // Fold Card — the focused pane's fold, on ⌃⌘Y: its masthead and a
        // slit of its content at the shared folded tier. A posture of the
        // pane, so it sits beside Bullseye; every content card folds, so it
        // is View's rather than Session's. Window ▸ Minimize keeps ⌘M and
        // ⌃⌘M stays the commit message. The verb rides the registry gate's
        // dynamic title ("Unfold Card" once the pane is folded), and the key
        // equivalent is left EMPTY like the rows above — `applyCommandChords`
        // writes ⌃⌘Y from the frontend's keymap.
        menu.addItem(NSMenuItem(title: "Fold Card", action: #selector(AppDelegate.toggleCardFold(_:)), keyEquivalent: "").identified("view.foldCard"))

        // The two verbs about a column's DIVISION: one equalizes the column
        // the layout selection stands in, the other every split column on the
        // deck. Between the card postures above and the rail verbs below,
        // because a column is neither one card nor a sidebar. ⌃⌘E and ⌥⇧⌘E —
        // the same key twice, the shape the sidebar pair below makes on S.
        //
        // Key equivalents left EMPTY as everywhere in this file:
        // `applyCommandChords` writes both from the frontend's keymap. Each is
        // dark when it has no division to write, by its registry gate.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Equalize Heights", action: #selector(AppDelegate.equalizeHeights(_:)), keyEquivalent: "").identified("view.equalizeHeights"))
        menu.addItem(NSMenuItem(title: "Equalize All Heights", action: #selector(AppDelegate.equalizeAllHeights(_:)), keyEquivalent: "").identified("view.equalizeAllHeights"))

        // The two verbs about the rails AS RAILS, above the card rows they
        // act on: one takes both sides away and brings them back, the other
        // stands the cards left on them at their content heights. They read as
        // a pair on the keyboard too — ⌃⌘S and ⌥⇧⌘S, the same key twice.
        //
        // "Hide Sidebars" is the BOOT title only: the registry gate rewrites
        // it to "Show Sidebars" whenever no rail is standing, so the row never
        // names a verb it cannot perform.
        //
        // Key equivalents left EMPTY as everywhere in this file:
        // `applyCommandChords` writes both from the frontend's keymap, so the
        // chords stay rebindable.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Hide Sidebars", action: #selector(AppDelegate.toggleSidebars(_:)), keyEquivalent: "").identified("view.toggleSidebars"))
        menu.addItem(NSMenuItem(title: "Resize Sidebars to Fit", action: #selector(AppDelegate.resizeSidebarsToFit(_:)), keyEquivalent: "").identified("view.resizeSidebarsToFit"))
        // The sidebar cards — one parent row each, in the panel-list manner
        // every drawing app uses: the row stands for the card, its mark says
        // where the card stands, and its submenu holds the verbs. This is the
        // HIG's Show Sidebar family and Xcode's Navigators, which is why it
        // reads in View rather than in Window.
        //
        // Three marks rather than two, because the toggle is a three-rung
        // ladder: empty for a card with no instance, a check for one that
        // shows without holding the keyboard, and the mixed mark for the one
        // that shows and has it. The toggle cannot be the parent's own click
        // — an item that owns a submenu opens it — so the toggle is the
        // submenu's first row and the parent only carries the mark, copied
        // across in `refreshSidebarParentMarks` because AppKit never asks the
        // validator about a submenu's parent. This menu is rebuilt whole on
        // every open, so that copy has to run AFTER this loop has made the
        // parents it writes to — see `menuNeedsUpdate`.
        //
        // Key equivalents left EMPTY, as everywhere in this file:
        // `applyCommandChords` recurses into submenus and writes whatever the
        // frontend's keymap says — the table gives each toggle a ⌃⌘⟨letter⟩
        // and every one of them stays rebindable. The Arcs card's component
        // id is `dashes` — the persistence key [D141], not a stale name,
        // which is also why this list is ordered by the NOUN it displays:
        // sorting by id would put Cards before Arcs and look alphabetical.
        for (noun, componentId, toggleAction) in [
            ("Arcs", "dashes", #selector(AppDelegate.showArcs(_:))),
            ("Jots", "jots", #selector(AppDelegate.showJots(_:))),
            ("Layout", "layout", #selector(AppDelegate.showLayout(_:))),
            ("Overview", "overview", #selector(AppDelegate.showOverview(_:))),
            ("Workspaces", "cards", #selector(AppDelegate.showCards(_:))),
        ] as [(String, String, Selector)] {
            let parent = NSMenuItem(title: noun, action: nil, keyEquivalent: "")
                .identified("view.sidebar.\(componentId)")
            parent.mixedStateImage = Self.mixedStateGlyph
            let cardMenu = NSMenu(title: noun)
            // The toggle's title is dynamic — Show / Activate / Hide — and
            // arrives with the gate, so the construction literal is only what
            // the row reads before the first push.
            let toggle = NSMenuItem(title: "Show \(noun)", action: toggleAction, keyEquivalent: "")
                .identified("view.sidebar.\(componentId).show")
            toggle.mixedStateImage = Self.mixedStateGlyph
            cardMenu.addItem(toggle)
            cardMenu.addItem(NSMenuItem.separator())
            // Left / Right — a radio pair, dark while the card is hidden.
            // Both halves of the address ride `representedObject` together,
            // the shape the column-move rows use with one value instead of
            // two.
            for (label, side) in [("Left", "left"), ("Right", "right")] {
                let item = NSMenuItem(title: label, action: #selector(AppDelegate.setSidebarSideFromMenu(_:)), keyEquivalent: "")
                    .identified("view.sidebar.\(componentId).\(side)")
                item.representedObject = ["componentId": componentId, "side": side]
                cardMenu.addItem(item)
            }
            parent.submenu = cardMenu
            menu.addItem(parent)
        }

        // Keyboard focus — the ring's two directions. Built WITHOUT key
        // equivalents and left that way: ⇥ / ⇧⇥ are what perform these, but
        // AppKit scans key equivalents before the web view sees a keydown, so a
        // literal "\t" here would confiscate Tab app-wide — above the frontend's
        // focus-walk precedence ladder, above an editor accepting a completion
        // with Tab, above every native fallback. The items are the discoverable
        // face of a chord that has to keep resolving in JS, the same bargain
        // Session ▸ Stop takes with Escape.
        menu.addItem(NSMenuItem.separator())
        // Keyboard Focus mode — the same bargain one step further. ⌥⇥ toggles
        // it, and the glyph rides the TITLE rather than `keyEquivalent`: a real
        // key equivalent would confiscate ⌥⇥ app-wide, above the frontend's
        // ladder and above the Settings ▸ Keyboard chord capture, which has to
        // be able to record ⌥⇥ itself. So the item is discoverable and the
        // chord keeps resolving in JS ([P11]).
        menu.addItem(NSMenuItem(title: "Keyboard Focus\t⌥⇥", action: #selector(AppDelegate.keyboardFocus(_:)), keyEquivalent: "").identified("view.keyboardFocus"))
        menu.addItem(NSMenuItem(title: "Previous Keyboard Focus", action: #selector(AppDelegate.previousKeyboardFocus(_:)), keyEquivalent: "").identified("view.previousKeyboardFocus"))
        menu.addItem(NSMenuItem(title: "Next Keyboard Focus", action: #selector(AppDelegate.nextKeyboardFocus(_:)), keyEquivalent: "").identified("view.nextKeyboardFocus"))

        // Enter Full Screen, last, where the HIG places it. AppKit performs
        // it; the dynamic title is AppKit's too.
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f", modifierMask: [.command, .control]).identified("view.enterFullScreen"))

        // The sweep writes `keyEquivalent` and the modifier mask only, so the
        // alias item's `allowsKeyEquivalentWhenHidden` survives it.
        applyCommandChords(in: menu)
    }

    /// Rebuild File ▸ Open Recent from the MRU, filtered to files that
    /// still exist and capped at 10. Each item carries its absolute path
    /// in `representedObject`; a trailing Clear Menu empties the list.
    /// Existence is checked here, at open time, so a since-deleted file
    /// simply doesn't appear.
    func rebuildOpenRecentMenu(_ menu: NSMenu) {
        // On every exit path, so "each rebuild tail sweeps" holds as an
        // invariant rather than an incident of which path ran.
        defer { applyCommandChords(in: menu) }
        menu.removeAllItems()
        let fm = FileManager.default
        var shown = 0
        for path in menuState.recentDocuments {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else { continue }
            let item = NSMenuItem(
                title: (path as NSString).lastPathComponent,
                action: #selector(AppDelegate.openRecentDocument(_:)),
                keyEquivalent: ""
            ).identified("file.openRecent.\(shown)")
            item.representedObject = path
            item.toolTip = path
            menu.addItem(item)
            shown += 1
            if shown >= 10 { break }
        }
        if shown == 0 {
            let empty = NSMenuItem(title: "No Recent Documents", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Clear Menu", action: #selector(AppDelegate.clearRecentDocuments(_:)), keyEquivalent: "").identified("file.openRecent.clear"))
    }

    /// Copy each sidebar toggle's mark onto the row that owns its submenu.
    ///
    /// AppKit never asks the validator about an item that owns a submenu —
    /// it has no action to validate — so the parent would draw an empty mark
    /// forever while the toggle one level down drew the right one. The gate is
    /// already published per item, so there is nothing to derive here: read
    /// the `.show` row's state and put it on the parent. An item with no gate
    /// yet (before the first push) reads as off, which is what a deck with no
    /// cards showing looks like anyway.
    private func refreshSidebarParentMarks(_ menu: NSMenu) {
        for item in menu.items {
            guard item.submenu != nil,
                  let id = item.identifier?.rawValue,
                  id.hasPrefix("view.sidebar.") else { continue }
            item.state = menuState.commands["\(id).show"]?.state?.stateValue ?? .off
        }
    }

    /// Refresh the Window menu's dynamic pane-list slice in place: remove
    /// exactly the `window.pane.*` items, then re-insert the current panes
    /// (checkmark on the focused one) directly after the anchor separator.
    /// Sectioned management — never a wholesale rebuild — because this menu
    /// is NSApp.windowsMenu and AppKit owns auto-added window entries in it.
    private func rebuildWindowPaneList(_ menu: NSMenu) {
        defer { applyCommandChords(in: menu) }
        for item in menu.items where item.identifier?.rawValue.hasPrefix("window.pane.") == true {
            menu.removeItem(item)
        }
        guard !menuState.panes.isEmpty else { return }
        let anchor = menus.windowPaneListAnchor
        var index = menu.index(of: anchor) + 1
        for (n, pane) in menuState.panes.enumerated() {
            // Positional identifiers: the harness addresses slots, not pane
            // ids (which are session-random).
            let item = NSMenuItem(title: pane.title, action: #selector(AppDelegate.focusPaneFromMenu(_:)), keyEquivalent: "").identified("window.pane.\(n)")
            item.representedObject = pane.id
            item.state = pane.focused ? .on : .off
            menu.insertItem(item, at: index)
            index += 1
        }
    }

    /// The Window menu's Workspaces slice, managed in place exactly as the
    /// pane slice above ([P12], [B10]): remove every `window.space.*` item,
    /// then re-insert one row per workspace after the anchor, checkmarked on
    /// the one on screen. Selecting a row sends `activate-space`, which the
    /// deck canvas answers — the same shape `focus-pane` takes, and the reason
    /// the menu can fire it while any card holds focus.
    private func rebuildWindowSpaceList(_ menu: NSMenu) {
        defer { applyCommandChords(in: menu) }
        for item in menu.items where item.identifier?.rawValue.hasPrefix("window.space.") == true {
            menu.removeItem(item)
        }
        guard !menuState.spaces.isEmpty else { return }
        let anchor = menus.windowSpaceListAnchor
        var index = menu.index(of: anchor) + 1
        for (n, space) in menuState.spaces.enumerated() {
            // Positional identifiers, for the pane list's reason: a workspace
            // id is a fresh UUID, and the harness addresses slots.
            let item = NSMenuItem(title: space.name, action: #selector(AppDelegate.activateSpaceFromMenu(_:)), keyEquivalent: "").identified("window.space.\(n)")
            item.representedObject = space.id
            item.state = space.active ? .on : .off
            menu.insertItem(item, at: index)
            index += 1
        }
    }
}
