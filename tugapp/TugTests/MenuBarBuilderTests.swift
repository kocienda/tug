import AppKit
import XCTest

// The menu bar, built host-less and read back as a table: every menu's
// title, every item's title, its default key equivalent with modifiers, and
// the selector it sends. A chord moved by accident, an item dropped or
// reordered, or an action renamed on one side shows up here as one row.
//
// The builder is driven with every gate open — maker mode and the debug
// profile on, the updater active — so the table holds every item the bar
// can carry; the gates themselves are checked separately below.
final class MenuBarBuilderTests: XCTestCase {
    private func build(makerMode: Bool = true, debugProfile: Bool = true, updaterActive: Bool = true) -> MenuHandles {
        MenuBarBuilder(
            appName: "Tug",
            checkForUpdatesTitle: "Check for Updates…",
            updaterActive: updaterActive,
            makerMode: makerMode,
            debugProfile: debugProfile,
            reloadTarget: nil
        ).build()
    }

    /// One row per item, depth-first, in menu order: the menu path, the
    /// title, the chord, the selector, and the identifier.
    ///
    /// A parent is named by its submenu's title — AppKit gives an untitled
    /// item carrying a submenu its own placeholder title and an internal
    /// `submenuAction:`, neither of which the builder wrote — and the app
    /// menu, whose submenu is untitled, reads as "App".
    private func rows(_ menu: NSMenu, path: String) -> [String] {
        var out: [String] = []
        let here = path.isEmpty ? "Bar" : path
        for item in menu.items {
            if item.isSeparatorItem {
                out.append("\(here) | ---")
                continue
            }
            let id = item.identifier?.rawValue ?? "-"
            if let submenu = item.submenu {
                let title = submenu.title.isEmpty ? "App" : submenu.title
                out.append("\(here) | \(title) ▸ | \(chord(item)) | - | \(id)")
                out += rows(submenu, path: path.isEmpty ? title : "\(path) ▸ \(title)")
                continue
            }
            let action = item.action.map { NSStringFromSelector($0) } ?? "-"
            out.append("\(here) | \(item.title) | \(chord(item)) | \(action) | \(id)")
        }
        return out
    }

    private func chord(_ item: NSMenuItem) -> String {
        if item.keyEquivalent.isEmpty { return "-" }
        let mask = item.keyEquivalentModifierMask
        var glyphs = ""
        if mask.contains(.control) { glyphs += "⌃" }
        if mask.contains(.option) { glyphs += "⌥" }
        if mask.contains(.shift) { glyphs += "⇧" }
        if mask.contains(.command) { glyphs += "⌘" }
        return glyphs + item.keyEquivalent
    }

    func testTheBarIsTheTable() {
        let actual = rows(build().mainMenu, path: "")
        let expected = MenuBarBuilderTests.table
        for (n, (seen, wanted)) in zip(actual, expected).enumerated() where seen != wanted {
            check("row \(n) is unchanged", false, "expected \(wanted), saw \(seen)")
        }
        check("the bar has as many rows as the table", actual.count == expected.count, "expected \(expected.count), saw \(actual.count)")
    }

    /// Each gate hides or drops exactly its own items: maker mode hides the
    /// Maker menu rather than removing it, the debug profile drops the four
    /// card creators, and an inactive updater hides Check for Updates….
    func testTheGatesHideOnlyTheirOwnItems() {
        func item(_ menu: NSMenu, _ id: String) -> NSMenuItem? {
            for each in menu.items {
                if each.identifier?.rawValue == id { return each }
                if let submenu = each.submenu, let found = item(submenu, id) { return found }
            }
            return nil
        }
        func makerMenu(_ handles: MenuHandles) -> NSMenuItem? {
            handles.mainMenu.items.first { $0.submenu?.title == "Maker" }
        }

        let open = build()
        check("maker mode shows the Maker menu", makerMenu(open)?.isHidden == false)
        check("an active updater shows Check for Updates…", item(open.mainMenu, "app.checkForUpdates")?.isHidden == false)

        let released = build(makerMode: false, debugProfile: false, updaterActive: false)
        check("no maker mode hides the Maker menu", makerMenu(released)?.isHidden == true)
        check("an inactive updater hides Check for Updates…", item(released.mainMenu, "app.checkForUpdates")?.isHidden == true)
        for id in ["maker.galleryCard", "maker.helloCard", "maker.spikesCard", "maker.newCardInPane"] {
            check("a release profile builds no \(id)", item(released.mainMenu, id) == nil)
        }
        check("a release profile keeps the rest of the Maker menu", item(released.mainMenu, "maker.sourceTree") != nil)
        let openRows = rows(open.mainMenu, path: "").count
        let releasedRows = rows(released.mainMenu, path: "").count
        check("only the four creators and their separator leave", openRows - releasedRows == 5, "saw \(openRows - releasedRows)")
    }

    static let table: [String] = [
        "Bar | App ▸ | - | - | -",
        "App | About Tug | - | showAbout: | app.about",
        "App | Check for Updates… | - | checkForUpdates: | app.checkForUpdates",
        "App | ---",
        "App | Configure Tug... | - | showConfigureTug: | app.configureTug",
        "App | Log Out... | - | logOut: | app.logout",
        "App | Settings... | ⌘, | showSettings: | app.settings",
        "App | Keyboard Shortcuts... | - | showKeyboardShortcuts: | app.keyboardShortcuts",
        "App | ---",
        "App | Services ▸ | - | - | app.services",
        "App | ---",
        "App | Hide Tug | ⌘h | hide: | app.hide",
        "App | Hide Others | ⌥⌘h | hideOtherApplications: | app.hideOthers",
        "App | Show All | - | unhideAllApplications: | app.showAll",
        "App | ---",
        "App | Quit Tug | ⌘q | terminate: | app.quit",
        "Bar | File ▸ | - | - | -",
        "File | New Session | ⌘n | newSessionCard: | file.newSessionCard",
        "File | New Text File | ⌥⌘n | newTextCard: | file.newTextCard",
        "File | New Jot | - | newJot: | file.newJot",
        "File | Open File… | ⌘o | openFileInEditor: | file.openFile",
        "File | Open Quickly… | ⇧⌘o | openQuickly: | file.openQuickly",
        "File | Open Recent ▸ | - | - | file.openRecent",
        "File | Save… | ⌘s | saveActiveEditor: | file.save",
        "File | Save As… | - | saveAsActiveEditor: | file.saveAs",
        "File | Save a Copy… | - | saveACopyActiveEditor: | file.saveACopy",
        "File | Revert to Saved | - | revertActiveEditor: | file.revertToSaved",
        "File | Reload from Disk | - | reloadActiveEditor: | file.reloadFromDisk",
        "File | ---",
        "File | Close | ⌘w | closeActiveCard: | file.closeCard",
        "File | Close All Tabs | ⌥⌘w | closeAllCardTabs: | file.closeAllCardTabs",
        "File | ---",
        "File | Export Session… | - | runCardCommand: | file.exportTranscript",
        "Bar | Edit ▸ | - | - | -",
        "Edit | Undo | ⌘z | performUndo: | edit.undo",
        "Edit | Redo | ⇧⌘z | performRedo: | edit.redo",
        "Edit | ---",
        "Edit | Cut | ⌘x | performCut: | edit.cut",
        "Edit | Copy | ⌘c | performCopy: | edit.copy",
        "Edit | Copy as Plain Text | ⌥⇧⌘c | performCopyAsPlainText: | edit.copyAsPlainText",
        "Edit | Paste | ⌘v | performPaste: | edit.paste",
        "Edit | Paste as Quote | ⌥⌘v | performPasteAsQuote: | edit.pasteAsQuote",
        "Edit | Paste as Plain Text | ⌥⇧⌘v | performPasteAsPlainText: | edit.pasteAsPlainText",
        "Edit | Delete | - | performDelete: | edit.delete",
        "Edit | Select All | ⌘a | performSelectAll: | edit.selectAll",
        "Edit | ---",
        "Edit | Make Uppercase | - | performMakeUppercase: | edit.makeUppercase",
        "Edit | Make Lowercase | - | performMakeLowercase: | edit.makeLowercase",
        "Edit | ---",
        "Edit | Copy Last Response | - | runCardCommand: | edit.copyLastResponse",
        "Edit | ---",
        "Edit | Find ▸ | - | - | -",
        "Edit ▸ Find | Find... | ⌘f | performFind: | edit.find",
        "Edit ▸ Find | Find Next | ⌘g | performFindNext: | edit.findNext",
        "Edit ▸ Find | Find Previous | ⇧⌘g | performFindPrevious: | edit.findPrevious",
        "Edit ▸ Find | Use Selection for Find | ⌘e | performFindSelection: | edit.useSelectionForFind",
        "Bar | Session ▸ | - | - | -",
        "Session | Focus Prompt | ⌘k | focusPrompt: | session.focusPrompt",
        "Session | Stop | - | stopSession: | session.stop",
        "Session | ---",
        "Session | Insert File… | - | insertFile: | session.insertFile",
        "Session | Open Command Picker | - | openCommandPicker: | session.commandPicker",
        "Session | Start Dictation | - | toggleDictation: | session.dictate",
        "Session | Stop Dictation and Send | - | stopDictationAndSend: | session.dictateAndSend",
        "Session | ---",
        "Session | Show Session Changes | ⌃⌘c | toggleShadeView: | session.toggleChanges",
        "Session | Commit Changes | - | runCardCommand: | session.commit",
        "Session | Show Project Diff | - | runCardCommand: | session.diff",
        "Session | Show Commit History | ⌃⌘h | toggleShadeView: | session.toggleHistory",
        "Session | ---",
        "Session | Resume Session… | - | runCardCommand: | session.resume",
        "Session | Rename Session… | - | runCardCommand: | session.rename",
        "Session | Unname Session | - | runCardCommand: | session.unname",
        "Session | Clear Session | - | runCardCommand: | session.new",
        "Session | ---",
        "Session | AI Settings… | - | runCardCommand: | session.ai",
        "Session | Cycle Permission Mode | ⌃⌥⌘p | cyclePermissionModeFromMenu: | session.permissionMode.cycle",
        "Session | Permission Rules… | - | runCardCommand: | session.permissionRules",
        "Session | Add Working Directory… | - | runCardCommand: | session.addDir",
        "Session | ---",
        "Session | Rewind… | - | runCardCommand: | session.rewind",
        "Session | Compact Conversation | - | runCardCommand: | session.compact",
        "Session | ---",
        "Session | Show Context | - | runCardCommand: | session.context",
        "Session | Show Usage | - | runCardCommand: | session.usage",
        "Session | Inspect ▸ | - | - | session.configure",
        "Session ▸ Inspect | Skills… | - | runCardCommand: | session.skills",
        "Session ▸ Inspect | Agents… | - | runCardCommand: | session.agents",
        "Session ▸ Inspect | Hooks… | - | runCardCommand: | session.hooks",
        "Session ▸ Inspect | Memory… | - | runCardCommand: | session.memory",
        "Bar | Go ▸ | - | - | -",
        "Go | Previous Card | ⇧⌘[ | previousCard: | go.previousCard",
        "Go | Next Card | ⇧⌘] | nextCard: | go.nextCard",
        "Go | Previous Card in Stack | ⌥⌘[ | previousCardInStack: | go.previousCardInStack",
        "Go | Next Card in Stack | ⌥⌘] | nextCardInStack: | go.nextCardInStack",
        "Go | Reveal Stack | - | revealStack: | go.revealStack",
        "Go | ---",
        "Go | Focus Card Left | - | focusCardFromMenu: | go.focusCardLeft",
        "Go | Focus Card Right | - | focusCardFromMenu: | go.focusCardRight",
        "Go | Focus Card Above | - | focusCardFromMenu: | go.focusCardAbove",
        "Go | Focus Card Below | - | focusCardFromMenu: | go.focusCardBelow",
        "Go | ---",
        "Go | Go to Slot 1 | - | goToSlotFromMenu: | go.goToSlot.1",
        "Go | Go to Slot 2 | - | goToSlotFromMenu: | go.goToSlot.2",
        "Go | Go to Slot 3 | - | goToSlotFromMenu: | go.goToSlot.3",
        "Go | Go to Slot 4 | - | goToSlotFromMenu: | go.goToSlot.4",
        "Go | Go to Slot 5 | - | goToSlotFromMenu: | go.goToSlot.5",
        "Go | Go to Slot 6 | - | goToSlotFromMenu: | go.goToSlot.6",
        "Go | ---",
        "Go | Previous Turn | - | previousTurn: | go.previousTurn",
        "Go | Next Turn | - | nextTurn: | go.nextTurn",
        "Go | First Turn | - | firstTurn: | go.firstTurn",
        "Go | Last Turn | - | lastTurn: | go.lastTurn",
        "Bar | View ▸ | - | - | -",
        "Bar | Window ▸ | - | - | -",
        "Window | Minimize | ⌘m | performMiniaturize: | window.minimize",
        "Window | Zoom | - | performZoom: | window.zoom",
        "Window | ---",
        "Window | Split or Stack Column | - | toggleColumnSplit: | window.columnSplit",
        "Window | Move Card Up in Column | - | moveInColumnFromMenu: | window.columnMoveUp",
        "Window | Move Card Down in Column | - | moveInColumnFromMenu: | window.columnMoveDown",
        "Window | Move Card to Top of Column | - | moveInColumnFromMenu: | window.columnMoveTop",
        "Window | Move Card to Bottom of Column | - | moveInColumnFromMenu: | window.columnMoveBottom",
        "Window | ---",
        "Window | New Workspace | - | newWorkspaceFromMenu: | window.newWorkspace",
        "Window | Rename Workspace… | - | renameWorkspaceFromMenu: | window.renameWorkspace",
        "Window | Duplicate Workspace | - | duplicateWorkspaceFromMenu: | window.duplicateWorkspace",
        "Window | Delete Workspace | - | deleteWorkspaceFromMenu: | window.deleteWorkspace",
        "Window | ---",
        "Window | ---",
        "Window | ---",
        "Window | Bring All to Front | - | arrangeInFront: | window.bringAllToFront",
        "Bar | Maker ▸ | - | - | -",
        "Maker | Reload | ⇧⌘r | reload: | maker.reload",
        "Maker | ---",
        "Maker | Show DevTools | - | showDevTools: | maker.devTools",
        "Maker | Show Left Rail | - | toggleRailFromMenu: | maker.leftRail",
        "Maker | Show Right Rail | - | toggleRailFromMenu: | maker.rightRail",
        "Maker | ---",
        "Maker | New Component Gallery Card | ⌥⌘g | newComponentGalleryCard: | maker.galleryCard",
        "Maker | New Hello World Card | ⌥⇧⌘n | newHelloWorldCard: | maker.helloCard",
        "Maker | New Spikes Card | - | newSpikesCard: | maker.spikesCard",
        "Maker | New Card in Active Pane | ⌘t | addCardToActivePane: | maker.newCardInPane",
        "Maker | ---",
        "Maker | Source Tree... | - | sourceTree: | maker.sourceTree",
        "Bar | Help ▸ | - | - | -",
        "Help | Keyboard Shortcuts & Commands | - | runCardCommand: | help.shortcuts",
        "Help | ---",
        "Help | Project Home | - | openProjectHome: | help.projectHome",
        "Help | GitHub | - | openGitHub: | help.github",
        "Help | ---",
        "Help | Capture Frames (Diagnostic) | - | captureFramesDiagnostic: | help.captureFrames",
    ]
}
