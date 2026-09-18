# A Go menu, and the view verbs back in View

**Purpose:** Tug.app's Window menu carries about forty static rows spanning six unrelated ideas, while View holds seven rows and no other "how the content is shown" verb in the app lives there. Relocate commands between menus — and add a Go menu for movement — without changing a single shortcut or command.

---

## Purpose {#purpose}

The user asked for "a full audit of the Swift Session, View, and Window menus. I don't want any of the shortcuts or commands to change. I just want a pass over *where these commands should be located*. The Window menu seems overloaded to me, whereas the View and Session menus are under-utilized. Study the conventions of other Mac *pro* apps as a guide, but don't feel too constrained by them."

The audit found the Window complaint exactly right, the View complaint right, and the Session complaint wrong in an instructive way: Session is a correctly scoped domain menu with one misfiled row. The fix is a relocation across four menus, one of them new.

---

## Evidence {#evidence}

**[F01] The Window menu holds about forty static rows in nine groups spanning six ideas.** `tugapp/Sources/AppDelegate.swift:1245`–`:1481`: window chrome (Minimize, Zoom, Enter Full Screen, Bring All to Front), card navigation (Previous/Next Card, the stack pair, Reveal Stack), card arrangement (Split or Stack Column, four Move-in-Column rows), card display (Slim/Comfy/Wide, Bullseye), sidebars (Hide Sidebars, Resize Sidebars to Fit, five card rows with submenus), workspaces (four verbs plus the dynamic list), and the dynamic pane list. Only chrome and the lists are what the word Window promises. **(verified)**

**[F02] The View menu holds seven visible rows.** `rebuildViewMenu` (`AppDelegate.swift:2795`) builds Theme ▸, Actual Size, Zoom In, Zoom Out (plus a hidden ⌘= alias), Keyboard Focus, Previous Keyboard Focus, Next Keyboard Focus. Nothing about sidebars, card size, reading posture, or full screen is here. **(verified)**

**[F03] Session is not under-utilized; it is scoped like Terminal's Shell or Xcode's Editor.** `AppDelegate.swift:1101`–`:1226`: twenty rows in seven groups — prompt (Focus Prompt, Stop), composer (Insert File…, Open Command Picker, Go in Transcript ▸), changes (Show Session Changes, Commit Changes, Show Project Diff, Show Commit History, Fold Session), lifecycle (Resume…, Rename…, Unname, Clear), AI and permissions (AI Settings…, Cycle Permission Mode, Permission Rules…, Add Working Directory…), conversation shaping (Rewind…, Compact Conversation), and inspection (Show Context, Show Usage, Inspect ▸). Nothing in Window or View belongs to the session card. **(verified)**

**[F04] Fold Session is misfiled inside the changes group.** `AppDelegate.swift:1185` adds it after Show Commit History and before the separator that opens the lifecycle group, so it reads as a changes verb. Its own comment calls it "the CARD's fold" — a posture of the card, kin to Resume/Rename/Clear rather than to Commit Changes. **(verified)**

**[F05] Seventeen rows are pure movement and Tug has no menu of that kind.** Previous/Next Card, Previous/Next Card in Stack, Reveal Stack (`:1267`–`:1277`), Focus Card Left/Right/Above/Below (`:1333`–`:1340`), Go to Slot 1–6 (`:1362`), and Previous/Next/First/Last Turn under Session ▸ Go in Transcript (`:1140`–`:1147`). Xcode gathers this class under Navigate; VS Code and Finder under Go; Final Cut under Window ▸ Go To. **(verified — rows read from code; the app conventions are from the author's knowledge of those apps, not measured here)**

**[F06] Apple's own split puts panels, zoom, and full screen in View, and windows, tabs, and arrangement in Window.** The HIG lists Show Sidebar, Show Toolbar, zoom, and Enter Full Screen under View; Minimize, Zoom, the tab-navigation and tab-arrangement rows (Show Previous/Next Tab, Move Tab to New Window, Merge All Windows), and the window list under Window. Xcode's Navigators/Inspectors, Logic's Show Inspector/Show Mixer, and Safari's Show Sidebar are View items; Final Cut's Workspaces submenu is a Window item. Enter Full Screen ⌃⌘F currently sits in Tug's Window menu (`:1479`). **(convention, not measured; stated from the HIG and the shipping apps)**

**[F07] Menu placement does not alter chord resolution.** `tuglaws/commands.md:85` and `keymap-registry.ts` state the four layers: the native menu bar is one layer, outermost, regardless of which menu the item sits in. The single exception is a hidden menu, whose key equivalents fall through to the web view — which is why Show DevTools lives in Maker (`AppDelegate.swift:1483` comment). Nothing in this work moves to or from Maker. **(verified)**

**[F08] Identifiers are namespaced by menu, and the Keyboard pane groups by that prefix.** `settings-keymap-rows.ts:64`–`:84`: `GROUP_TITLES` maps `session`/`view`/`window`/… to the menu names and `groupForEntry` takes `menuItemId.split(".")[0]`. Renaming `window.cardWidth.slim` to `view.cardWidth.slim` regroups the pane for free; a new `go` namespace needs one new entry in that table and in `GROUP_ORDER`. `tuglaws/menus.md` §"The identifier namespace" states the convention. **(verified)**

**[F09] The moving identifiers are referenced in about ten files.** Beyond `AppDelegate.swift` and `command-registry.ts`: `command-registry.test.ts`, `keymap-registry.test.ts`, `command-capabilities.test.ts`, and the app-tests `at0172-session-menu-live-state`, `at0181-keymap-chord-sweep`, `at0372-bullseye`, `at0466-go-to-slot`, `at0511-window-sidebar-rows`, `at0547-directional-card-focus`. The catalog and chord tables in `tuglaws/menus.md` are generated regions regenerated by `menus-doc.test.ts` from the registry, so they follow the rename rather than needing a hand edit. **(verified by grep)**

**[F10] Window is `NSApp.windowsMenu` and is managed by section; View is rebuilt whole on every open.** `menuNeedsUpdate` (`:2694`) runs `refreshSidebarParentMarks` and the two list rebuilds for Window, and `rebuildViewMenu` for View. `refreshSidebarParentMarks` (`:2894`) scans `menu.items` for the `window.sidebar.` prefix; the sidebar parents can move to View only if that pass moves with them and reads the new prefix. The two anchor separators and AppKit's window tail stay where they are. **(verified)**

**[F11] The Workspaces card row and the workspace verbs share one menu under one word today.** `window.sidebar.cards` (titled "Workspaces", `:1424`) and `window.newWorkspace`…`window.deleteWorkspace` (`:1468`–`:1471`) sit a few rows apart in Window. **(verified)**

---

## Decisions {#decisions}

**[B01] Shortcuts and command semantics do not change. This work moves rows and renames identifiers, nothing else.** The user's constraint, and [F07] confirms it is free: an item's chord resolves at the menu-bar layer whichever menu carries it. Every `menuEligible`, `mirrored`, `disabledChord`, gate, dynamic title, and check-mark behavior rides the registry entry and moves with it untouched. What would revisit this: a move onto or off the hidden Maker menu, which none of these is.

**[B02] Tug gains a Go menu, between Session and View.** Seventeen movement rows [F05] are the bulk of what overloads Window, and no existing menu is about movement. Xcode's Navigate and VS Code's Go are the precedent; the name Go is the shorter and the one Finder uses. Tug's order becomes Tug, File, Edit, Session, Go, View, Window, Maker, Help. Go sits after Session so the domain menu keeps its place next to Edit, and before View so View and Window stay adjacent, as they do in Finder's File, Edit, View, Go, Window and in every Apple app where the two are neighbours. Its identifier namespace is `go.*`, with `go: "Go"` added to `GROUP_TITLES` [F08].

**[B03] Go holds all four movement axes, flat: which card, which direction, which slot, which turn.**

```
Previous Card                ⌘{        go.previousCard
Next Card                    ⌘}        go.nextCard
Previous Card in Stack       ⌥⌘[       go.previousCardInStack
Next Card in Stack           ⌥⌘]       go.nextCardInStack
Reveal Stack                 ⌘R        go.revealStack
──────
Focus Card Left / Right / Above / Below   ⌥⌘←→↑↓   go.focusCard{Left,Right,Above,Below}
──────
Go to Slot 1 … 6             ⌃⌘1–6     go.goToSlot.n
──────
Previous Turn                ⌃⌘[       go.previousTurn
Next Turn                    ⌃⌘]       go.nextTurn
First Turn                   ⌃⌘{       go.firstTurn
Last Turn                    ⌃⌘}       go.lastTurn
```

The transcript rows leave Session ▸ Go in Transcript and flatten; the `session.go` submenu parent is removed. The user settled this: a Go menu that lacked the transcript axis would make the reader look in two places for one kind of act, and Xcode's Navigate holds both file-level and in-editor jumps. The turn rows still validate to disabled without a frontmost session card, exactly as they do now — enablement is the gate's, not the menu's [B01].

**[B04] View takes every "how the content is shown" verb: card width, Bullseye, the sidebar pair, the five sidebar card rows, and Enter Full Screen.**

```
Theme ▸                                    (Next Theme ⇧⌘T stays inside)
──────
Actual Size / Zoom In / Zoom Out           ⌘0 ⌘+ ⌘-
──────
Slim / Comfy / Wide                        view.cardWidth.{slim,comfy,wide}
Bullseye                     ⌃⌘B          view.bullseye
──────
Hide Sidebars                ⌃⌘S          view.toggleSidebars
Resize Sidebars to Fit       ⌥⇧⌘S         view.resizeSidebarsToFit
Arcs ▸ Jots ▸ Layout ▸ Overview ▸ Workspaces ▸   view.sidebar.<componentId>{,.show,.left,.right}
──────
Keyboard Focus               ⌥⇥           view.keyboardFocus
Previous Keyboard Focus                    view.previousKeyboardFocus
Next Keyboard Focus                        view.nextKeyboardFocus
──────
Enter Full Screen            ⌃⌘F          view.enterFullScreen
```

Width sits under Zoom because both answer "how big is this", one for the page and one for the card; Bullseye follows as the stance rather than the size. The sidebar family is the HIG's Show Sidebar and Xcode's Navigators/Inspectors [F06]. Enter Full Screen goes last, where the HIG places it. Moving the Workspaces card row here also pulls it apart from the workspace verbs [F11]: the card is a view of workspaces, the verbs make and unmake them.

**[B05] The keyboard-focus trio stays together, in View.** The user settled this against the sketch's alternative of sending the Previous/Next pair to Go. Keyboard Focus is a mode and a view setting; splitting the pair from its mode would leave the family in two menus for a small gain in Go's completeness. All three keep their deliberately empty key equivalents ([P11], the Tab bargain), unchanged by the move.

**[B06] Window keeps what a Mac user expects behind the word: windows, workspaces, and how cards are arranged among panes.**

```
Minimize                     ⌘M
Zoom
──────
Split or Stack Column        ⌃⌘/          window.columnSplit
Move Card Up / Down / to Top / to Bottom in Column   ⌃⌘↑↓ ⌃⇧⌘↑↓   window.columnMove*
──────
New / Rename… / Duplicate / Delete Workspace           window.*Workspace
[workspace list]                                        window.space.n
──────
[pane list]                                             window.pane.n
──────
Bring All to Front
[AppKit window list]
```

Fourteen static rows. The column family stays because arranging cards among panes is the same class of act as Safari's Move Tab to New Window and Merge All Windows [F06]; workspaces stay on Final Cut's precedent. `NSApp.windowsMenu` assignment, the two anchor separators, and the sectioned-management rule ([P12], [B10] of `briefs/window-sidebar-brief.md`) are untouched.

**[B07] Session keeps every verb it has except the transcript submenu, and Fold Session moves to the lifecycle group.** After the change: prompt (Focus Prompt, Stop); composer (Insert File…, Open Command Picker); changes (Show Session Changes, Commit Changes, Show Project Diff, Show Commit History); lifecycle (Resume…, Rename…, Unname, Clear, Fold Session); AI and permissions; Rewind and Compact; Context, Usage, Inspect ▸. Fold Session's row, identifier, chord, and dynamic title are unchanged; only its position moves, to correct [F04]. Nothing else in Session moves: the audit found its remaining seams right, and "under-utilized" is not a defect a domain menu has.

**[B08] Identifiers follow the menu.** Every moved item is renamed into its new namespace (`window.bullseye` → `view.bullseye`, `session.previousTurn` → `go.previousTurn`, and so on), in the Swift construction, the registry's `menuItemId`, and every test that addresses the item [F09]. The alternative — keeping old identifiers under new menus — would break the convention `tuglaws/menus.md` states and would mis-group the Keyboard pane [F08]. The generated regions of `menus.md` regenerate; the hand-written prose there that names Window ▸ rows for sidebars or Session ▸ Go in Transcript is updated by hand.

**[B09] The sidebar parent-mark refresh moves with the parents.** `refreshSidebarParentMarks` [F10] runs in the View branch of `menuNeedsUpdate`, before or after `rebuildViewMenu` as the rebuild order requires (the rebuild constructs fresh parents each open, so the mark copy must run after it), and matches the `view.sidebar.` prefix. The `mixedStateImage` glyph and the three-rung ladder from `briefs/window-sidebar-brief.md` are unchanged.

---

## Non-goals {#non-goals}

- **Changing any chord, title, gate, or dispatch.** Out of scope by the user's constraint [B01]. A row that today validates disabled in some state validates disabled in exactly that state afterward.
- **Navigation stays in Window (no Go menu).** Considered as the fallback: the HIG permits it since Show Previous/Next Tab live in Window in every Apple app, and it would still cut Window to about twenty-six rows. Rejected because movement and arrangement would still share a roof, and the seventeen movement rows are most of what would remain. The user chose the Go menu.
- **Transcript navigation stays in Session.** Considered because the session card is the centerpiece and its navigation is discoverable there. Rejected by the user: one movement menu, all axes.
- **Splitting the keyboard-focus trio.** Considered: the pair is movement, the mode is a setting. Rejected by the user: the family stays together in View [B05].
- **Moving Fold Session to View beside Bullseye.** It is a card posture like Bullseye, but it is the session card's alone and titled as such; it stays in Session [B07].
- **Touching the Maker menu.** Show Left/Right Rail, Show DevTools, and the debug creators stay where they are. Maker's hidden-menu chord fall-through [F07] is load-bearing and nothing here should go near it.
- **Reordering or regrouping the File, Edit, Tug, or Help menus.** Not audited; not asked.
- **Adding, removing, or re-nesting Session's own groups beyond Fold Session.** The audit found them right [B07].

---

## Exit {#exit}

**An arc.** The work is one relocation with a rename riding on it, and it lands naturally in this order:

1. Register the `go` namespace: `GROUP_TITLES` and `GROUP_ORDER` in `settings-keymap-rows.ts`, and the identifier-namespace prose in `tuglaws/menus.md`.
2. Build the Go menu in `buildMenuBar` between Session and View; move the seventeen rows into it under `go.*` identifiers, removing `session.go` and its submenu, and rename their registry `menuItemId`s.
3. Move the View-bound rows [B04] into `rebuildViewMenu` under `view.*` identifiers, and move `refreshSidebarParentMarks` to the View branch of `menuNeedsUpdate` [B09]. Rename their registry `menuItemId`s.
4. Reposition Fold Session within Session [B07].
5. Update every test that addresses a moved identifier [F09]; regenerate the `menus.md` tables via `menus-doc.test.ts`; update the hand-written prose in `menus.md` and any tuglaw or brief that names a moved row's old home.
6. Run `just app-test-changed`, cross-checked against the six app-tests named in [F09] (a hand-named checkpoint has missed a test before), plus the `command-registry`, `keymap-registry`, `menus-doc`, and `command-capabilities` unit tests.

Steps 2 and 3 are independent of each other but both depend on 1; step 5 follows all of them.
