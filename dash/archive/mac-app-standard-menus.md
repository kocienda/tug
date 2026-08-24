# Proposal: Standard Mac App Menus, Settings, and About Box

## Problem

Tug.app's menu bar is incomplete. The current implementation has three menus:

- **App menu:** Just "Quit Tug" — no About, no Settings, no Hide/Show, no Services
- **Edit menu:** Cut, Copy, Paste, Select All — no Undo/Redo, no Find, no separators
- **Developer menu:** Hidden when dev mode is off, creating a catch-22 where the
  only way to enable dev mode is `defaults write dev.tugtool.app DevModeEnabled
  -bool true`

There is no File menu, no Window menu, no Help menu, no Settings window, and no
About box. Standard keyboard shortcuts like Cmd+W (close), Cmd+M (minimize),
Cmd+H (hide), Cmd+, (settings), and Cmd+Z (undo) do nothing.

This makes the app feel unfinished. A properly designed Mac app provides these
standard behaviors so users can rely on the muscle memory they've built across
every other app on their system.

## Current State

```
Tug  Edit  [Developer — hidden unless dev mode already on]
 │    │
 │    ├─ Cut            ⌘X
 │    ├─ Copy           ⌘C
 │    ├─ Paste          ⌘V
 │    └─ Select All     ⌘A
 │
 └─ Quit Tug            ⌘Q
```

Six source files in `tugapp/Sources/`:
- `main.swift` — 5 lines, creates NSApplication and runs
- `AppDelegate.swift` — 206 lines, lifecycle + menus + actions
- `MainWindow.swift` — 64 lines, WKWebView setup
- `ProcessManager.swift` — 192 lines, tugcast child process
- `TugConfig.swift` — 37 lines, constants

Bundle ID: `dev.tugtool.app`. Deployment target: macOS 13.0 (Ventura).

## Proposed Menu Bar

```
Tug  File  Edit  Developer  Window  Help
```

Developer sits between Edit and Window — the standard position for
app-specific menus per Apple HIG. Help is always rightmost.

---

### Tug Menu (App Menu)

```
About Tug
─────────────────
Settings...                         ⌘,
─────────────────
Services                           ▶ (system submenu)
─────────────────
Hide Tug                            ⌘H
Hide Others                         ⌥⌘H
Show All
─────────────────
Quit Tug                            ⌘Q
```

**About Tug** opens the standard About panel via
`NSApp.orderFrontStandardAboutPanel(options:)`. It shows the app icon,
"Tug", version (from `CFBundleShortVersionString`), build number (from
`CFBundleVersion`), and a copyright line. A `Credits.rtf` in the app bundle
can optionally add attribution text below the version.

**Settings...** opens a Settings window (see below).

**Services** is a system-managed submenu. We create an empty `NSMenu`, assign
it to `NSApp.servicesMenu`, and the system populates it.

**Hide/Show/Quit** use standard NSApp selectors: `hide:`,
`hideOtherApplications:`, `unhideAllApplications:`, `terminate:`.

---

### File Menu

```
Close Window                        ⌘W
```

Tug is not a document-based app, so the File menu is minimal. The one essential
item is Close Window, which calls `performClose:` on the key window. Without
this, Cmd+W does nothing, which feels broken to every Mac user.

---

### Edit Menu

```
Undo                                ⌘Z
Redo                                ⇧⌘Z
─────────────────
Cut                                 ⌘X
Copy                                ⌘C
Paste                               ⌘V
Delete
Select All                          ⌘A
─────────────────
Find ▶
    Find...                         ⌘F
    Find Next                       ⌘G
    Find Previous                   ⇧⌘G
    Use Selection for Find          ⌘E
```

Undo/Redo and the Find submenu are added. These work automatically through
the responder chain — WKWebView handles them internally for its text fields,
and AppKit routes them correctly without us writing any handler code. The
selectors are `undo:`, `redo:`, `performFindPanelAction:` (with appropriate
tags for each Find variant).

Spelling/Grammar, Substitutions, and Transformations submenus are omitted.
These are conventions for native text editing views (NSTextView), not web
views.

---

### Developer Menu

```
Reload Frontend                     ⌘R
Restart Server                      ⇧⌘R
Reset Everything                    ⌥⌘R
─────────────────
Open Web Inspector
─────────────────
Source Tree: /u/src/tugtool         (disabled, display only)
Choose Source Tree...
```

Key change: **the "Enable Dev Mode" toggle moves to the Settings window.**
The Developer menu itself is shown/hidden based on the setting. This breaks
the catch-22: users can always reach Settings via ⌘, to toggle dev mode,
which then reveals the Developer menu.

The Developer menu no longer needs a toggle item at the top. It becomes a
pure set of dev-mode actions.

---

### Window Menu

```
Minimize                            ⌘M
Zoom
─────────────────
Enter Full Screen                   ⌃⌘F
─────────────────
Bring All to Front
─────────────────
[open window list — system-managed]
```

The menu is registered via `NSApp.windowsMenu = windowMenu` so AppKit
automatically appends the list of open windows at the bottom.

Selectors: `performMiniaturize:`, `performZoom:`, `toggleFullScreen:`,
`arrangeInFront:`.

---

### Help Menu

```
[search field — system-provided]
─────────────────
Tug Help
```

Registered via `NSApp.helpMenu = helpMenu`. The system automatically inserts
a search field at the top that searches all menu items across the entire menu
bar — a feature users rely on. "Tug Help" can open documentation in the
browser or show an in-app help panel. Initially it can be a no-op or open a
URL.

---

## Settings Window

A proper macOS Settings window, opened by ⌘, or "Settings..." in the Tug
menu.

### Design

A single-pane window (no toolbar pane-switcher needed yet — there's only one
category of settings). Title: "Settings". Non-resizable, standard width
(~450pt), auto-height.

### Contents

```
┌─ Settings ──────────────────────────────────┐
│                                             │
│  General                                    │
│                                             │
│  ☐ Enable Developer Mode                   │
│                                             │
│  Source Tree                                │
│  ┌────────────────────────────┐  ┌────────┐│
│  │ /u/src/tugtool             │  │Choose...││
│  └────────────────────────────┘  └────────┘│
│  (Shown only when Developer Mode is on)     │
│                                             │
└─────────────────────────────────────────────┘
```

- **Enable Developer Mode** checkbox. Toggling it on reveals the Source Tree
  picker below and shows the Developer menu in the menu bar. Toggling it off
  hides both. The preference is saved to UserDefaults immediately (no
  Apply/Save button — standard macOS convention).

- **Source Tree** path field (read-only) + "Choose..." button that opens the
  existing `NSOpenPanel` folder picker with source tree validation. Only
  visible when Developer Mode is enabled. If the user enables dev mode
  without having previously selected a source tree, the folder picker opens
  automatically.

- Changes take effect immediately. Toggling dev mode restarts tugcast (same
  as today).

### Implementation

New file: `tugapp/Sources/SettingsWindow.swift` (~80-100 lines). An
`NSWindowController` subclass that creates a fixed-size window with the
controls laid out programmatically using Auto Layout. The window is a
singleton — calling "Settings..." when it's already open just brings it to
front.

The AppDelegate holds a reference to the `SettingsWindowController` and
creates it lazily on first open.

---

## About Box

Uses the standard `NSApp.orderFrontStandardAboutPanel(options:)` with:

- **App icon:** from the asset catalog (already configured)
- **App name:** "Tug" (from `CFBundleName`)
- **Version:** from `CFBundleShortVersionString` (currently "0.5.19")
- **Build:** from `CFBundleVersion` (currently "1")
- **Copyright:** from `NSHumanReadableCopyright` (needs to be added to
  Info.plist)

### Info.plist addition

```xml
<key>NSHumanReadableCopyright</key>
<string>Copyright © 2025 Ken Kocienda. All rights reserved.</string>
```

No custom About window code needed — the standard panel handles everything
correctly.

---

## File Changes

### Modified files

| File | Changes |
|------|---------|
| `AppDelegate.swift` | Rewrite `buildMenuBar()` with all six menus. Add Settings action. Add About action. Remove dev mode toggle from Developer menu. Add lazy SettingsWindowController property. Wire Services, Window, Help menus to NSApp. |
| `Info.plist` | Add `NSHumanReadableCopyright` key |

### New files

| File | Size | Purpose |
|------|------|---------|
| `SettingsWindow.swift` | ~80-100 lines | Settings window with dev mode toggle and source tree picker |

### No changes needed

| File | Reason |
|------|--------|
| `main.swift` | No changes |
| `MainWindow.swift` | No changes |
| `ProcessManager.swift` | No changes |
| `TugConfig.swift` | No changes (may add a UserDefaults key for window frame if we want Settings to remember position, but `setFrameAutosaveName` handles that) |

---

## What This Does Not Cover

- **Touch Bar support** — Touch Bar is discontinued on new Macs
- **Toolbar** — Tug's single WKWebView doesn't need a toolbar
- **Tab bar** — Single-window app, no tabs
- **Dock menu** — Could be a follow-on (right-click the dock icon for quick
  actions)
- **Help Book** — The Help menu item can initially open a URL or be a no-op;
  a proper Apple Help Book is a follow-on
- **Multiple settings panes** — Single pane for now; the architecture
  supports adding a toolbar pane-switcher later if more settings are needed
